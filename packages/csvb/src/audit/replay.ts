// Replay a published regime run from its FROZEN inputs and compare it with what was published.
//
// Every regime run freezes the exact source values it used as a data vintage: `analytics_data_vintages` names the
// run's knowledge-time cutoff, and `analytics_vintage_members` lists the source value versions it contains as runs of
// consecutive ids. The replay rebuilds the run's raw indicator history and its backtest price series from them
// exactly, computes every day the run publishes, and compares every published day with the computed row of that day.
//
// The replay is not reimplemented here: it is the analyst SDK's replay module (`src/replay`, issue 1765) in
// `robotmoney-frontend` (`packages/analyst-sdk`), given as `--sdk`, so the audit checks the code that is actually
// deployed. The backups are opened with that SDK's own archive reader (`bin/backups-dir.ts`) as of the audit's
// backup, and its replayRun reads the run's vintage, its methodology label (the version it replays under and the
// panels that version's published runs average) and the rows the run published under its line's artifact kind,
// each payload checked against its payload_sha256. An SDK commit without `src/replay` predates issue 1765 and is
// refused by name. Optionally the original JavaScript reference (`backend/scripts/vendor/regime-reference-js`,
// `--reference-js`) is run as an independent check.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Archive } from "@robotmoney/analyst-sdk/src/archive/reader.ts";
import type { PublishedRunCandidate, ReplayOptions, ReplayResult as SdkReplayResult } from "@robotmoney/analyst-sdk/src/replay/index.ts";
import { loadRuns } from "./runs.ts";
import { loadTable, type Ctx } from "./data.ts";

type Point = { date: string; value: number };

/** The refusal of an --sdk commit older than the SDK's replay module. */
export const SDK_TOO_OLD = "this SDK predates its replay module (issue 1765); audit replay needs an SDK commit that has src/replay";

export interface MetricStat {
  metric: string;
  compared: number;
  exact: number;
  /** Largest absolute difference among numeric pairs. */
  maxAbsDiff: number;
  /** Published and replay disagree on whether there is a value. */
  presenceMismatch: number;
  /** Labels only: how many differ. */
  labelMismatch: number;
}

export interface DayDiff {
  date: string;
  metric: string;
  published: string;
  replay: string;
}

export interface ReplayResult {
  run: { id: number; asof: string; createdAt: string };
  /** The run's methodology label, and the version, line and panels the SDK replayed it under. */
  methodology: { label: string | null; version: string | null; line: string | null; panels: string[] };
  vintage: { id: string; knowledgeCutoff: string; marketCutoff: string; memberCount: number; manifestDigest: string };
  inputs: { memberRows: number; sourceValueVersions: number; indicators: number; extras: Record<string, number> };
  sdk: { dir: string; commit: string | null };
  daysCompared: number;
  metrics: MetricStat[];
  diffs: DayDiff[];
  /** The SDK's comparison of the as-of rows (compareRows, every compared field exactly). */
  asofDiff: { match: boolean; differing: string[]; beyondRounding: string[] } | null;
  backtestCorrelations: { leaves: number; exact: number; different: number; examples: string[] } | null;
  reference: { dir: string; metrics: MetricStat[]; vsSdkMaxAbsDiff: number } | null;
  notes: string[];
}

const NUMERIC = ["composite", "compositePercentile", "macroIndex", "macroPercentile", "onchainIndex", "onchainPercentile", "factorIndex", "factorPercentile"] as const;
const LABELS = ["regime", "macroRegime", "onchainRegime", "factorRegime"] as const;
/** The backtest price series a run reads besides its indicators. */
const EXTRAS = ["SPX", "ETH", "TBILL3M"] as const;

const isMissing = (v: unknown): boolean => v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v));

function stat(metric: string, pairs: [unknown, unknown][], label: boolean): MetricStat {
  let exact = 0;
  let maxAbs = 0;
  let presence = 0;
  let labelMismatch = 0;
  for (const [pub, rep] of pairs) {
    if (isMissing(pub) || isMissing(rep)) {
      if (isMissing(pub) !== isMissing(rep)) presence += 1;
      else exact += 1;
      continue;
    }
    if (label) {
      if (pub === rep) exact += 1;
      else labelMismatch += 1;
    } else {
      const d = Math.abs((pub as number) - (rep as number));
      if (d === 0) exact += 1;
      if (d > maxAbs) maxAbs = d;
    }
  }
  return { metric, compared: pairs.length, exact, maxAbsDiff: maxAbs, presenceMismatch: presence, labelMismatch };
}

function leaves(a: unknown, b: unknown, path: string, out: { n: number; exact: number; examples: string[] }): void {
  if (a !== null && typeof a === "object" && b !== null && typeof b === "object") {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) leaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    return;
  }
  out.n += 1;
  const same = a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));
  if (same) out.exact += 1;
  else if (out.examples.length < 10) out.examples.push(`${path}: published ${JSON.stringify(a)} vs replay ${JSON.stringify(b)}`);
}

/** What the audit uses of the SDK at --sdk: its archive reader and its replay module. */
interface ReplaySdk {
  openBackupsDir(root: string, asOf?: string): Archive;
  replayRun(archive: Archive, runKey: string, opts?: ReplayOptions): SdkReplayResult;
  publicationCandidates(archive: Archive, toolId: string, opts?: { line?: "main" | "beside"; methodology?: string }): PublishedRunCandidate[];
}

/** The SDK at `sdkDir`; an SDK commit without src/replay (before issue 1765) is refused by name. */
async function loadReplaySdk(sdkDir: string): Promise<ReplaySdk> {
  if (!existsSync(join(sdkDir, "src", "replay", "index.ts"))) throw new Error(`${SDK_TOO_OLD} (--sdk ${sdkDir})`);
  const [replay, local] = await Promise.all([import(join(sdkDir, "src/replay/index.ts")), import(join(sdkDir, "bin/backups-dir.ts"))]);
  if (typeof replay.replayRun !== "function" || typeof replay.publicationCandidates !== "function") throw new Error(`${sdkDir}/src/replay/index.ts does not export replayRun and publicationCandidates; is --sdk the analyst-sdk package directory?`);
  if (typeof local.openBackupsDir !== "function") throw new Error(`${sdkDir}/bin/backups-dir.ts does not export openBackupsDir; is --sdk the analyst-sdk package directory?`);
  return { openBackupsDir: local.openBackupsDir, replayRun: replay.replayRun, publicationCandidates: replay.publicationCandidates };
}

/**
 * Replay one regime run of the backups through the SDK and compare every day it published. With `runId`, that run
 * (a succeeded regime run with a vintage). Without, the newest succeeded run with a vintage that published on the
 * main line: the line of its methodology label (the served one), and every run of a copy with no methodology table.
 */
export async function replayRun(ctx: Ctx, o: { sdkDir: string; referenceJsDir?: string; runId?: number }): Promise<ReplayResult> {
  const sdkDir = resolve(o.sdkDir);
  const sdk = await loadReplaySdk(sdkDir);
  const archive = sdk.openBackupsDir(ctx.layout.root, ctx.asOf.backup);
  const notes: string[] = [];

  // 1. The run and its vintage.
  const runs = (await loadRuns(ctx)).filter((r) => r.tool === "regime" && r.status === "succeeded");
  const vintages = await loadTable(ctx, "analytics_data_vintages", (v) => v.tool_id === "regime");
  const hasVintage = new Set(vintages.map((v) => Number(v.run_id)));
  let run: (typeof runs)[number] | undefined;
  if (o.runId) run = runs.find((r) => r.id === o.runId);
  else {
    const mainLine = new Set(sdk.publicationCandidates(archive, "regime", { line: "main" }).map((c) => Number(c.runId)));
    run = [...runs].reverse().find((r) => hasVintage.has(r.id) && mainLine.has(r.id));
  }
  if (!run) throw new Error(o.runId ? `run ${o.runId} is not a succeeded regime run with a vintage` : "no succeeded regime run with a vintage that published on the main line");
  const vin = vintages.find((v) => Number(v.run_id) === run.id);
  if (!vin) throw new Error(`run ${run.id} has no frozen vintage`);
  const runKey = archive.table("analytics_ledger_runs").find((r) => Number(r.id) === run.id)?.run_key;
  if (!runKey) throw new Error(`run ${run.id} is not in the SDK reader's run ledger as of backup ${ctx.asOf.backup}`);

  // 2. The SDK's replay: the run's vintage, its published rows (payload verified) and every day it computes.
  const r = sdk.replayRun(archive, runKey);
  if (r.problems.length > 0) throw new Error(`the SDK could not replay run ${run.id}: ${r.problems.join("; ")}`);
  if (!r.published.rows?.length) throw new Error(`run ${run.id} has no published regime payload`);
  if (r.inputs === null) throw new Error(`the SDK replayed run ${run.id} without its inputs`);
  notes.push(...r.notes);
  const raw = r.inputs.history as Record<string, Point[]>;
  const tooRecent = Object.values(raw).some((pts) => pts.some((p) => p.date > run.asof));
  if (tooRecent) notes.push(`some inputs are dated after the run's as-of day ${run.asof}; the SDK ignores them for the regime`);

  // 3. Every published day against the computed row of that day.
  const computed = new Map(r.computed.rows.map((x) => [x.date, x as unknown as Record<string, unknown>]));
  const rep = (date: string): Record<string, unknown> | null => computed.get(date) ?? null;
  const published = new Map(r.published.rows.map((x) => [x.date, x as unknown as Record<string, unknown>]));
  const pairs: Record<string, [unknown, unknown][]> = {};
  const diffs: DayDiff[] = [];
  let days = 0;
  for (const [date, pub] of published) {
    const row = rep(date);
    if (!row) {
      notes.push(`published day ${date} has no computed row (not on the replay's date axis, or not labelled)`);
      continue;
    }
    days += 1;
    for (const k of [...NUMERIC, ...LABELS]) {
      (pairs[k] ??= []).push([pub[k], row[k]]);
      const same = pub[k] === row[k] || (isMissing(pub[k]) && isMissing(row[k]));
      if (!same && diffs.length < 5000) diffs.push({ date, metric: k, published: String(pub[k] ?? ""), replay: String(row[k] ?? "") });
    }
  }
  const metrics = [...NUMERIC.map((k) => stat(k, pairs[k] ?? [], false)), ...LABELS.map((k) => stat(k, pairs[k] ?? [], true))];
  const asofDiff = r.diff === null ? null : { match: r.diff.match, differing: r.diff.differing, beyondRounding: r.diff.beyondRounding };
  if (asofDiff) notes.push(asofDiff.match ? "as-of row: every compared field equal (the SDK's compareRows)" : `as-of row: differs in ${asofDiff.differing.join(", ")} (the SDK's compareRows)`);

  // 4. Correlations and backtest, published on the run's own as-of row.
  let backtestCorrelations: ReplayResult["backtestCorrelations"] = null;
  const own = r.published.asof as { correlations?: unknown; backtest?: unknown } | null;
  const mine = r.computed.asof as { correlations?: unknown; backtest?: unknown } | null;
  if (own && (own.correlations || own.backtest) && mine && (mine.correlations || mine.backtest)) {
    const out = { n: 0, exact: 0, examples: [] as string[] };
    // Round-trip through JSON so NaN and undefined are compared the way they were stored.
    const norm = (x: unknown) => JSON.parse(JSON.stringify(x ?? null));
    leaves(norm(own.correlations), norm(mine.correlations), "correlations", out);
    leaves(norm(own.backtest), norm(mine.backtest), "backtest", out);
    backtestCorrelations = { leaves: out.n, exact: out.exact, different: out.n - out.exact, examples: out.examples };
  } else notes.push("correlations and backtest were not compared (not on the published as-of row, or no price series in the vintage)");

  // 5. Independent reference (the original JavaScript), if given.
  let reference: ReplayResult["reference"] = null;
  if (o.referenceJsDir) reference = referenceReplay(resolve(o.referenceJsDir), raw, run.asof, published, rep);

  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["-C", sdkDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    commit = null;
  }
  const members = await loadTable(ctx, "analytics_vintage_members", (m) => m.vintage_id === vin.id);
  const extras: Record<string, number> = {};
  for (const id of EXTRAS) if (raw[id]?.length) extras[id] = raw[id]!.length;
  return {
    run: { id: run.id, asof: run.asof, createdAt: run.createdAt },
    methodology: { label: r.run.methodology.label, version: r.version, line: r.line, panels: [...r.panels] },
    vintage: { id: vin.id!, knowledgeCutoff: vin.knowledge_time_cutoff!, marketCutoff: vin.market_time_cutoff!, memberCount: Number(vin.member_count), manifestDigest: vin.manifest_digest ?? "" },
    // The SDK's reader generates the input only when every member of the vintage is in the backups.
    inputs: { memberRows: members.length, sourceValueVersions: r.inputs.identity?.memberCount ?? 0, indicators: Object.keys(raw).filter((k) => !(EXTRAS as readonly string[]).includes(k)).length, extras },
    sdk: { dir: sdkDir, commit },
    daysCompared: days,
    metrics,
    diffs,
    asofDiff,
    backtestCorrelations,
    reference,
    notes,
  };
}

function referenceReplay(dir: string, raw: Record<string, Point[]>, asof: string, published: Map<string, Record<string, unknown>>, sdkRep: (d: string) => Record<string, unknown> | null): ReplayResult["reference"] {
  const require = createRequire(import.meta.url);
  const { INDICATORS } = require(join(dir, "lib/indicators.js"));
  const { applyTransform } = require(join(dir, "lib/transforms.js"));
  const { buildDateAxis, alignDailyForwardFill, alignDailyZeroFill } = require(join(dir, "lib/utils.js"));
  const { computeRegime } = require(join(dir, "compute.js"));
  const axis: string[] = buildDateAxis("2018-01-01", asof);
  const transformed: Record<string, number[]> = {};
  for (const ind of INDICATORS) {
    const s = (raw[ind.id] ?? []).filter((p) => p.date <= asof);
    transformed[ind.id] = s.length ? applyTransform(ind.transform, (ind.align === "zero_fill" ? alignDailyZeroFill : alignDailyForwardFill)(s, axis)) : new Array(axis.length).fill(NaN);
  }
  const r = computeRegime(transformed, axis);
  const idx = new Map(axis.map((d, i) => [d, i]));
  const names: [string, string, boolean][] = [
    ["composite", "composite", false],
    ["compositePercentile", "compositePercentile", false],
    ["macroIndex", "macroIndex", false],
    ["macroPercentile", "macroPercentile", false],
    ["onchainIndex", "onchainIndex", false],
    ["onchainPercentile", "onchainPercentile", false],
    ["regime", "regime", true],
    ["macroRegime", "macroRegime", true],
    ["onchainRegime", "onchainRegime", true],
  ];
  const metrics: MetricStat[] = [];
  let vsSdk = 0;
  for (const [pubKey, refKey, isLabel] of names) {
    const pairs: [unknown, unknown][] = [];
    for (const [date, pub] of published) {
      const i = idx.get(date);
      if (i === undefined) continue;
      const refVal = r[refKey]?.[i];
      pairs.push([pub[pubKey], refVal === undefined ? null : refVal]);
      if (!isLabel) {
        const s = sdkRep(date)?.[pubKey];
        if (!isMissing(s) && !isMissing(refVal)) vsSdk = Math.max(vsSdk, Math.abs((s as number) - refVal));
      }
    }
    metrics.push(stat(pubKey, pairs, isLabel));
  }
  return { dir, metrics, vsSdkMaxAbsDiff: vsSdk };
}
