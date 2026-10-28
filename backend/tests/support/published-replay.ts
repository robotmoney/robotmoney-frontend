// Issue 1431: replay one published production regime run from its frozen
// inputs and compare it with the row the run published for its as-of day.
//
// The inputs are the run's vintage exactly as the analyst SDK's format 1
// reader writes them (`bun run inputs`, src/archive/format1.ts): stored value
// text, ratios as kind `calculated`. They are parsed with the replay contract
// and run through the SDK's runRegime (the one calculation the backend also
// runs) with factor figures on. No tolerance: every field is compared exactly,
// in a fixed order, and the first field that differs is the run's result.
// Decision D78 (compensated arithmetic) moves numbers in their last
// bits, so a run published before it differs from its replay in those bits;
// `beyondRounding` names the fields that differ by more than that
// (packages/analyst-sdk/tests/support/numeric-diff.ts).
import { INDICATORS } from "../../src/analytics/analyze/indicators.ts";
import { canonicalStringify } from "../../src/analytics/run-ledger.ts";
import { parseInput } from "../../../packages/analyst-sdk/src/input/load.ts";
import { runRegime } from "../../../packages/analyst-sdk/src/run.ts";
import { numericDiff } from "../../../packages/analyst-sdk/tests/support/numeric-diff.ts";

// The as-of row of a published regime_snapshots artifact (backend
// buildSnapshotRows), the fields a replay recomputes.
export interface PublishedAsofRow {
  date: string;
  regime: string | null;
  composite: number | null;
  compositePercentile: number | null;
  macroRegime: string | null;
  onchainRegime: string | null;
  factorRegime: string | null;
  macroIndex: number | null;
  onchainIndex: number | null;
  factorIndex: number | null;
  macroPercentile: number | null;
  onchainPercentile: number | null;
  factorPercentile: number | null;
  percentiles: Record<string, number>;
  correlations: unknown;
  backtest: unknown;
}

// Compared in this order; the label first, since issue 1431 is about labels.
export const COMPARED_FIELDS = [
  "regime",
  "composite",
  "compositePercentile",
  "macroRegime",
  "onchainRegime",
  "factorRegime",
  "macroIndex",
  "onchainIndex",
  "factorIndex",
  "macroPercentile",
  "onchainPercentile",
  "factorPercentile",
  "percentiles",
  "correlations",
  "backtest",
] as const;

export interface ReplayOutcome {
  asof: string;
  match: boolean;
  // The first field in COMPARED_FIELDS that differs, with both values (canonical JSON).
  firstDiff: { field: string; published: string; replay: string } | null;
  // The as-of label on each side.
  publishedLabel: string | null;
  replayLabel: string | null;
  // Every differing field, for the report.
  differing: string[];
  // The differing fields whose difference is more than rounding (D78): a
  // changed label, null, key or integer, or a number moved by more than 1e-9
  // of its size. A field missing here but in `differing` moved only by rounding.
  beyondRounding: string[];
  // SHA-256 of the canonical JSON of every compared replay field: pins the
  // whole replayed row, so a recorded outcome can be asserted exactly.
  replaySha256: string;
  // Each compared field of the replayed row, as canonical JSON.
  fields: Record<string, string>;
}

const nn = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The as-of row the published artifact holds, from its payload text. Null when the run published no row for its as-of day. */
export function publishedAsofRow(payloadText: string, asof: string): PublishedAsofRow | null {
  const rows = JSON.parse(payloadText) as PublishedAsofRow[];
  return rows.find((r) => r.date === asof) ?? null;
}

/** Replay a run's input file (replay contract text) as of `asof` and compare with its published as-of row. */
export function replayPublishedRun(inputText: string, asof: string, published: PublishedAsofRow | null): ReplayOutcome {
  const { history } = parseInput(inputText, { replay: true });
  const run = runRegime(history, { asof, factor: true });
  const last = run.dateAxis.length - 1;
  if (run.dateAxis[last] !== asof) throw new Error(`replay date axis ends ${run.dateAxis[last]}, not the run's as-of day ${asof}`);
  const r2 = run.result;
  const r3 = run.factor!;
  const percentiles: Record<string, number> = {};
  for (const ind of INDICATORS) {
    const s = r2.signed[ind.id]?.[last];
    if (typeof s === "number" && Number.isFinite(s)) percentiles[ind.id] = Number(s.toFixed(6));
  }
  const replay: Record<(typeof COMPARED_FIELDS)[number], unknown> = {
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
  const differing: string[] = [];
  const beyondRounding: string[] = [];
  let firstDiff: ReplayOutcome["firstDiff"] = null;
  if (published === null) {
    // A published run always has a row for its as-of day; a missing one is a mismatch, never a pass.
    differing.push("as-of row");
    beyondRounding.push("as-of row");
    firstDiff = { field: "as-of row", published: "absent", replay: canonicalStringify(replay.regime) };
  } else {
    for (const f of COMPARED_FIELDS) {
      const a = canonicalStringify(published[f] ?? null);
      const b = canonicalStringify(replay[f]);
      if (a === b) continue;
      differing.push(f);
      if (numericDiff(a, b).differences.length > 0) beyondRounding.push(f);
      firstDiff ??= { field: f, published: a, replay: b };
    }
  }
  return {
    asof,
    match: differing.length === 0,
    firstDiff,
    publishedLabel: published?.regime ?? null,
    replayLabel: replay.regime as string | null,
    differing,
    beyondRounding,
    replaySha256: new Bun.CryptoHasher("sha256").update(canonicalStringify(replay)).digest("hex"),
    fields: Object.fromEntries(COMPARED_FIELDS.map((f) => [f, canonicalStringify(replay[f])])),
  };
}
