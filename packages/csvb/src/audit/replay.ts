// Replay a published regime run from its FROZEN inputs and compare it with what was published.
//
// Every regime run freezes the exact source values it used as a data vintage: `analytics_data_vintages` names the
// run's knowledge-time cutoff, and `analytics_vintage_members` lists the source value versions it contains as runs of
// consecutive ids. From those ids this rebuilds the run's raw indicator history and its backtest price series
// exactly, replays the regime computation over them, and compares every published day with the replay.
//
// The computation is not reimplemented here: it is the analyst SDK in `robotmoney-frontend` (`packages/analyst-sdk`),
// given as `--sdk`, so the audit checks the code that is actually deployed. Optionally the original JavaScript
// reference (`backend/scripts/vendor/regime-reference-js`, `--reference-js`) is run as an independent check.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { loadRuns } from "./runs.ts";
import { loadTable, num, scanTable, type Ctx } from "./data.ts";

type Point = { date: string; value: number };

/** The backtest ledger keys and the SDK input ids they feed (see LEDGER_EXTRA_KEYS in the SDK). */
const EXTRA_KEYS: Record<string, string> = { "backtest:^GSPC": "SPX", "backtest:ETH-USD": "ETH", "backtest:DTB3": "TBILL3M" };

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
  vintage: { id: string; knowledgeCutoff: string; marketCutoff: string; memberCount: number; manifestDigest: string };
  inputs: { memberRows: number; sourceValueVersions: number; indicators: number; extras: Record<string, number> };
  sdk: { dir: string; commit: string | null };
  daysCompared: number;
  metrics: MetricStat[];
  diffs: DayDiff[];
  backtestCorrelations: { leaves: number; exact: number; different: number; examples: string[] } | null;
  reference: { dir: string; metrics: MetricStat[]; vsSdkMaxAbsDiff: number } | null;
  notes: string[];
}

const NUMERIC = ["composite", "compositePercentile", "macroIndex", "macroPercentile", "onchainIndex", "onchainPercentile", "factorIndex", "factorPercentile"] as const;
const LABELS = ["regime", "macroRegime", "onchainRegime", "factorRegime"] as const;

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

export async function replayRun(ctx: Ctx, o: { sdkDir: string; referenceJsDir?: string; runId?: number }): Promise<ReplayResult> {
  const notes: string[] = [];
  // 1. The run, its vintage and its published payload.
  const runs = (await loadRuns(ctx)).filter((r) => r.tool === "regime" && r.status === "succeeded");
  const vintages = await loadTable(ctx, "analytics_data_vintages", (v) => v.tool_id === "regime");
  const hasVintage = new Set(vintages.map((v) => Number(v.run_id)));
  const run = o.runId ? runs.find((r) => r.id === o.runId) : [...runs].reverse().find((r) => hasVintage.has(r.id));
  if (!run) throw new Error(o.runId ? `run ${o.runId} is not a succeeded regime run with a vintage` : "no succeeded regime run with a vintage");
  const vin = vintages.find((v) => Number(v.run_id) === run.id);
  if (!vin) throw new Error(`run ${run.id} has no frozen vintage`);

  let payload: { date: string; [k: string]: unknown }[] | null = null;
  await scanTable(ctx, "analytics_output_snapshots", (s) => {
    if (Number(s.run_id) === run.id && s.artifact_kind === "regime_snapshots") payload = JSON.parse(s.payload_json!);
  });
  if (!payload || !(payload as unknown[]).length) throw new Error(`run ${run.id} has no published regime payload`);
  const published = new Map((payload as { date: string }[]).map((r) => [r.date, r as Record<string, unknown>]));

  const { raw, extras, found, expected, members } = await frozenInputs(ctx, vin);
  if (found !== expected) notes.push(`the vintage says ${expected} members; ${found} source value versions were found in the backups for its ranges`);
  const tooRecent = Object.values(raw).some((pts) => pts.some((p) => p.date > run.asof));
  if (tooRecent) notes.push(`some inputs are dated after the run's as-of day ${run.asof}; the SDK ignores them for the regime`);

  // 4. Replay through the SDK.
  const sdkDir = resolve(o.sdkDir);
  const sdk = (await import(join(sdkDir, "src/index.ts"))) as Record<string, any>;
  if (typeof sdk.runRegime !== "function") throw new Error(`${sdkDir}/src/index.ts does not export runRegime; is --sdk the analyst-sdk package directory?`);
  let sdkRun: any;
  try {
    sdkRun = sdk.runRegime(raw, { asof: run.asof, factor: true });
  } catch (e) {
    throw new Error(`the SDK refused the replay (${(e as Error).message}). It needs the version with the asof and factor options (robotmoney-frontend feat/1095 branch, 78efcc3d or later)`);
  }
  const axis: string[] = sdkRun.dateAxis;
  const res = sdkRun.result;
  const fac = sdkRun.factor;
  const idx = new Map(axis.map((d, i) => [d, i]));
  const rep = (date: string): Record<string, unknown> | null => {
    const i = idx.get(date);
    if (i === undefined) return null;
    const m = res.panelRegimes;
    return {
      composite: res.composite[i],
      compositePercentile: res.compositePercentile[i],
      regime: res.regime[i] ?? null,
      macroIndex: res.panelIndices.macro[i],
      macroPercentile: res.panelPercentiles.macro[i],
      macroRegime: m.macro?.[i] ?? null,
      onchainIndex: res.panelIndices.onchain[i],
      onchainPercentile: res.panelPercentiles.onchain[i],
      onchainRegime: m.onchain?.[i] ?? null,
      factorIndex: fac?.panelIndices.factor[i],
      factorPercentile: fac?.panelPercentiles.factor[i],
      factorRegime: fac?.panelRegimes.factor?.[i] ?? null,
    };
  };

  const pairs: Record<string, [unknown, unknown][]> = {};
  const diffs: DayDiff[] = [];
  let days = 0;
  for (const [date, pub] of published) {
    const r = rep(date);
    if (!r) {
      notes.push(`published day ${date} is not on the replay's date axis`);
      continue;
    }
    days += 1;
    for (const k of [...NUMERIC, ...LABELS]) {
      (pairs[k] ??= []).push([pub[k], r[k]]);
      const same = pub[k] === r[k] || (isMissing(pub[k]) && isMissing(r[k]));
      if (!same && diffs.length < 5000) diffs.push({ date, metric: k, published: String(pub[k] ?? ""), replay: String(r[k] ?? "") });
    }
  }
  const metrics = [...NUMERIC.map((k) => stat(k, pairs[k] ?? [], false)), ...LABELS.map((k) => stat(k, pairs[k] ?? [], true))];

  // 5. Correlations and backtest, published on the run's own as-of row.
  let backtestCorrelations: ReplayResult["backtestCorrelations"] = null;
  const own = published.get(run.asof) as { correlations?: unknown; backtest?: unknown } | undefined;
  if (own && (own.correlations || own.backtest) && (sdkRun.correlations || sdkRun.backtest)) {
    const out = { n: 0, exact: 0, examples: [] as string[] };
    // Round-trip through JSON so NaN and undefined are compared the way they were stored.
    const norm = (x: unknown) => JSON.parse(JSON.stringify(x ?? null));
    leaves(norm(own.correlations), norm(sdkRun.correlations), "correlations", out);
    leaves(norm(own.backtest), norm(sdkRun.backtest), "backtest", out);
    backtestCorrelations = { leaves: out.n, exact: out.exact, different: out.n - out.exact, examples: out.examples };
  } else notes.push("correlations and backtest were not compared (not on the published as-of row, or no price series in the vintage)");

  // 6. Independent reference (the original JavaScript), if given.
  let reference: ReplayResult["reference"] = null;
  if (o.referenceJsDir) reference = referenceReplay(resolve(o.referenceJsDir), raw, run.asof, published, rep);

  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["-C", sdkDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    commit = null;
  }
  return {
    run: { id: run.id, asof: run.asof, createdAt: run.createdAt },
    vintage: { id: vin.id!, knowledgeCutoff: vin.knowledge_time_cutoff!, marketCutoff: vin.market_time_cutoff!, memberCount: expected, manifestDigest: vin.manifest_digest ?? "" },
    inputs: { memberRows: members, sourceValueVersions: found, indicators: Object.keys(raw).filter((k) => !(k in { SPX: 1, ETH: 1, TBILL3M: 1 })).length, extras },
    sdk: { dir: sdkDir, commit },
    daysCompared: days,
    metrics,
    diffs,
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

/**
 * A run's exact inputs, rebuilt from its data vintage: the member id ranges of `analytics_vintage_members` select
 * rows of `source_value_versions`. Returns the raw history keyed by SDK input id (indicators, and SPX/ETH/TBILL3M for
 * the backtest), as the SDK takes it.
 */
export async function frozenInputs(ctx: Ctx, vin: Record<string, string | null>): Promise<{ raw: Record<string, Point[]>; extras: Record<string, number>; found: number; expected: number; members: number }> {
  // The vintage's member ranges, as a bitmap over source value version ids.
  const members = await loadTable(ctx, "analytics_vintage_members", (m) => m.vintage_id === vin.id);
  const ranges = members.map((m) => [Number(m.source_value_version_id), Number(m.last_source_value_version_id ?? m.source_value_version_id)] as const);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of ranges) {
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  const inVintage = new Uint8Array(hi - lo + 1);
  for (const [a, b] of ranges) inVintage.fill(1, a - lo, b - lo + 1);

  // The source value versions in those ranges: the run's exact inputs.
  const raw: Record<string, Point[]> = {};
  const extras: Record<string, number> = {};
  let found = 0;
  await scanTable(ctx, "source_value_versions", (r) => {
    const id = Number(r.id);
    if (id < lo || id > hi || !inVintage[id - lo]) return;
    found += 1;
    const key = r.source_key!;
    const value = num(r.value);
    if (!r.market_date || !Number.isFinite(value)) return;
    let sdkId: string | undefined;
    if (key.startsWith("raw_indicator_history:")) sdkId = key.slice("raw_indicator_history:".length);
    else if (EXTRA_KEYS[key]) {
      sdkId = EXTRA_KEYS[key];
      extras[sdkId!] = (extras[sdkId!] ?? 0) + 1;
    }
    if (!sdkId) return;
    (raw[sdkId] ??= []).push({ date: r.market_date, value });
  });
  for (const id in raw) raw[id]!.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { raw, extras, found, expected: Number(vin.member_count), members: members.length };
}

