#!/usr/bin/env bun
// scripts/release/replay-row.ts — Q36/C24's comparison (issue 1476): replay a
// published run with the analyst SDK and compare the SDK's as-of row, field by
// field, with the as-of row the run published.
//
//   bun scripts/release/replay-row.ts --sdk <packages/analyst-sdk> --archive <local copy> --run <run key> [--inputs <inputs.csv>] [--print-row]
//
// The comparison is the one PR 1448 established
// (backend/tests/support/published-replay.ts, backend/tests/regime-replay-archive.test.ts):
// the SDK replays the run's frozen inputs with factor figures on, and every
// compared field of its as-of row is compared exactly, in a fixed order, with
// the same fields of the as-of row in the run's published `regime_snapshots`
// artifact (analytics_output_snapshots, read from the local copy the SDK's
// reader verified). It also hashes the canonical JSON of both rows. The
// published report (`/reports?run=`) is the envelope
// {asof, toolId, results} and `bun run regime` prints the regime report, so the
// two are never byte-equal and are not compared.
//
// The SDK modules are imported from --sdk (the release commit's sparse clone),
// so this file needs nothing from backend/. It reads only. Exit 0: the rows are
// equal. Exit 1: they differ or a side is missing. Exit 2: usage.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The fields a replay recomputes, in the order they are compared (the label first). */
export const COMPARED_FIELDS = [
  "regime", "composite", "compositePercentile", "macroRegime", "onchainRegime", "factorRegime",
  "macroIndex", "onchainIndex", "factorIndex", "macroPercentile", "onchainPercentile", "factorPercentile",
  "percentiles", "correlations", "backtest",
] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];
export type AsofRow = Partial<Record<ComparedField, unknown>> & { date?: string };

/** Key-sorted JSON, as backend/src/analytics/run-ledger.ts canonicalStringify writes it. */
export function canonicalStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v instanceof Date) return v.toISOString();
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** PURE. The compared fields of a row, in order, absent ones as null. */
export function projectRow(row: AsofRow): Record<ComparedField, unknown> {
  return Object.fromEntries(COMPARED_FIELDS.map((f) => [f, row[f] ?? null])) as Record<ComparedField, unknown>;
}

export interface RowComparison {
  readonly match: boolean;
  /** Every differing field, in compared order. */
  readonly differing: string[];
  readonly firstDiff: { field: string; published: string; replay: string } | null;
  /** sha256 of the canonical JSON of each side's compared fields. */
  readonly publishedSha256: string | null;
  readonly replaySha256: string;
}

/** PURE. The replayed as-of row against the published one. A missing published row is a mismatch, never a pass. */
export function compareRows(published: AsofRow | null, replay: AsofRow): RowComparison {
  const r = projectRow(replay);
  const replaySha256 = sha256(canonicalStringify(r));
  if (published === null) return { match: false, differing: ["as-of row"], firstDiff: { field: "as-of row", published: "absent", replay: canonicalStringify(r.regime) }, publishedSha256: null, replaySha256 };
  const p = projectRow(published);
  const differing: string[] = [];
  let firstDiff: RowComparison["firstDiff"] = null;
  for (const f of COMPARED_FIELDS) {
    const [a, b] = [canonicalStringify(p[f]), canonicalStringify(r[f])];
    if (a === b) continue;
    differing.push(f);
    firstDiff ??= { field: f, published: a, replay: b };
  }
  const publishedSha256 = sha256(canonicalStringify(p));
  return { match: differing.length === 0 && publishedSha256 === replaySha256, differing, firstDiff, publishedSha256, replaySha256 };
}

/** PURE. The as-of row of a published regime_snapshots payload (text), or null when it has none for the day. */
export function publishedAsofRow(payloadText: string, asof: string): AsofRow | null {
  const rows = JSON.parse(payloadText) as AsofRow[];
  return rows.find((r) => r.date === asof) ?? null;
}

/** PURE. Why a comparison is a problem, in one line per fact; empty when the rows are equal. */
export function comparisonProblems(c: RowComparison, run: string, asof: string): string[] {
  if (c.match) return [];
  if (c.publishedSha256 === null) return [`run ${run}: the published regime_snapshots artifact has no as-of row for ${asof}`];
  const d = c.firstDiff!;
  return [`run ${run} as of ${asof}: the SDK's as-of row differs from the published one in ${c.differing.join(", ")}; first ${d.field}: published ${d.published.slice(0, 80)}, SDK ${d.replay.slice(0, 80)}; sha256 published ${c.publishedSha256}, SDK ${c.replaySha256}`];
}

// ── the SDK side: imported from the clone, never from this checkout ──
interface Sdk {
  openLocalCopy(root: string): { tables: Record<string, Record<string, string | null>[]>; files(t: string): unknown[]; readRows(f: unknown): Record<string, string | null>[] };
  parseInput(text: string, o: { replay: boolean }): { history: unknown };
  runRegime(history: unknown, o: { asof: string; factor: boolean }): {
    dateAxis: string[];
    result: Record<string, any>;
    factor?: Record<string, any>;
    correlations?: unknown;
    backtest?: unknown;
  };
  INDICATORS: { id: string }[];
}

async function loadSdk(dir: string): Promise<Sdk> {
  const [local, load, run, ind] = await Promise.all([
    import(join(dir, "bin/local-copy.ts")), import(join(dir, "src/input/load.ts")), import(join(dir, "src/run.ts")), import(join(dir, "src/analyze/indicators.ts")),
  ]);
  return { openLocalCopy: local.openLocalCopy, parseInput: load.parseInput, runRegime: run.runRegime, INDICATORS: ind.INDICATORS };
}

const nn = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The SDK's as-of row for `inputText` (replay contract), the way published-replay.ts builds it. */
export function replayRow(sdk: Sdk, inputText: string, asof: string): AsofRow {
  const { history } = sdk.parseInput(inputText, { replay: true });
  const run = sdk.runRegime(history, { asof, factor: true });
  const last = run.dateAxis.length - 1;
  if (run.dateAxis[last] !== asof) throw new Error(`replay date axis ends ${run.dateAxis[last]}, not the run's as-of day ${asof}`);
  const r2 = run.result;
  const r3 = run.factor!;
  const percentiles: Record<string, number> = {};
  for (const ind of sdk.INDICATORS) {
    const s = r2.signed?.[ind.id]?.[last];
    if (typeof s === "number" && Number.isFinite(s)) percentiles[ind.id] = Number(s.toFixed(6));
  }
  return {
    date: asof,
    regime: r2.regime[last] ?? null,
    composite: nn(r2.composite[last]),
    compositePercentile: nn(r2.compositePercentile[last]),
    macroRegime: r2.macroRegime?.[last] ?? null,
    onchainRegime: r2.onchainRegime?.[last] ?? null,
    factorRegime: r3.factorRegime?.[last] ?? null,
    macroIndex: nn(r2.macroIndex?.[last]),
    onchainIndex: nn(r2.onchainIndex?.[last]),
    factorIndex: nn(r3.factorIndex?.[last]),
    macroPercentile: nn(r2.macroPercentile?.[last]),
    onchainPercentile: nn(r2.onchainPercentile?.[last]),
    factorPercentile: nn(r3.factorPercentile?.[last]),
    percentiles,
    correlations: run.correlations ?? null,
    backtest: run.backtest ?? null,
  };
}

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  const [sdkDir, archive, run, inputs] = [flag("--sdk"), flag("--archive"), flag("--run"), flag("--inputs")];
  if (!sdkDir || !archive || !run || !inputs) {
    console.error("usage: bun scripts/release/replay-row.ts --sdk <sdk dir> --archive <local copy> --run <run key> --inputs <inputs.csv> [--print-row]");
    return 2;
  }
  const sdk = await loadSdk(sdkDir);
  const copy = sdk.openLocalCopy(archive);
  const runRow = (copy.tables.analytics_ledger_runs ?? []).find((r) => r.run_key === run);
  if (!runRow) {
    console.log(JSON.stringify({ problems: [`run ${run} is not in the local copy's run ledger`] }));
    return 1;
  }
  const asof = runRow.asof!;
  const replay = replayRow(sdk, readFileSync(inputs, "utf8"), asof);
  if (process.argv.includes("--print-row")) {
    console.log(JSON.stringify(replay));
    return 0;
  }
  let published: AsofRow | null = null;
  let found = false;
  for (const f of copy.files("analytics_output_snapshots")) {
    for (const o of copy.readRows(f)) {
      if (o.run_id !== runRow.id || o.artifact_kind !== "regime_snapshots") continue;
      if (sha256(o.payload_json!) !== o.payload_sha256) {
        console.log(JSON.stringify({ problems: [`run ${run}: the published payload does not match its stored sha256`] }));
        return 1;
      }
      found = true;
      published = publishedAsofRow(o.payload_json!, asof);
    }
  }
  if (!found) {
    console.log(JSON.stringify({ problems: [`run ${run} has no regime_snapshots artifact in the local copy: the published record of the run is not in the archive`] }));
    return 1;
  }
  const c = compareRows(published, replay);
  const problems = comparisonProblems(c, run, asof);
  console.log(JSON.stringify({ run, asof, match: c.match, differing: c.differing, publishedSha256: c.publishedSha256, replaySha256: c.replaySha256, problems }));
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
