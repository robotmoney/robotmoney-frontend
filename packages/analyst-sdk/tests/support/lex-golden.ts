// The committed fixture of the v5 golden reproduction (issue 1753) and the
// layout of the workbench golden it must equal byte for byte.
//
// tests/fixtures/lex-equity-golden/ holds:
//   runs.json.gz     the regime runs of csv-backups backup 2026-11-17T000000Z and
//                    the 29 input series of each serving run (the first run's
//                    history, then each later run's changed points); written by
//                    scripts/lex-golden-fixture.ts.
//   supplementary/   the twelve supplementary files the golden's manifest names,
//                    byte for byte: the raw inputs of the four derived series.
//   outputs.json     the golden: robotmoney/research-workbench
//   manifest.json    src/models/experiment-lex-equity/goldens/, byte for byte.
//
// The model is computed only with the SDK functions the backend calls
// (computeKeptRegime, keptRegimeRows, computeBacktest, selectPublications).
// What is local to this file is the fixture reader and the golden writer's
// layout (a port of the workbench's src/regime/golden.ts: it computes nothing).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readSupplementary } from "../../bin/supplementary-dir.ts";
import { computeBacktest, stripDailyFromSnapshot, REGIME_BACKTEST_RULES, type ReferenceBacktestOptions } from "../../src/analyze/backtest.ts";
import { panelMean } from "../../src/analyze/compute.ts";
import { PANELS, V5_INPUT_IDS } from "../../src/analyze/indicators.ts";
import { computeKeptRegime, keptRegimeRows, type KeptDay, type KeptRegimeRun } from "../../src/analyze/kept-regime.ts";
import { REGIME_MISSING_PANEL } from "../../src/analyze/regime-versions.ts";
import { cutAtAsof } from "../../src/prepare.ts";
import { canonicalStringify } from "../../src/report/canonical.ts";
import { selectPublications } from "../../src/report/publication.ts";
import { BACKFILL_START, EXTRA_IDS } from "../../src/run.ts";
import type { Point, RawIndicatorHistory } from "../../src/types.ts";

export const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "lex-equity-golden");
/** The model name the golden is stamped with: the downstream name of methodology v5. */
export const GOLDEN_MODEL = "experiment-lex-equity";
export const GOLDEN_SHA256 = "03b9633d2127b0eb1daad39d8d33a850a8c9f4b32ae10b6a4fbdb0faa2a25fae";

/** A finished regime run that froze a vintage. */
export interface LexRun {
  id: string;
  asof: string;
  /** The UTC day it finished: the day its artifact was written. */
  finishedOn: string;
  source: string;
}

/** One series of one serving run against the serving run before it (the first: its whole history in `set`). */
export interface LexSeries {
  set: [date: string, value: number][];
  drop: string[];
}

export interface LexFixture {
  format: 1;
  backup: string;
  commit: string;
  /** The 29 input series, by the id the computation reads. */
  series: string[];
  runs: LexRun[];
  /** Serving run id -> series id -> its points against the serving run before it. */
  inputs: Record<string, Record<string, LexSeries>>;
}

export function readFixture(): LexFixture {
  const f = JSON.parse(gunzipSync(readFileSync(join(FIXTURE_DIR, "runs.json.gz"))).toString("utf8")) as LexFixture;
  if (f.format !== 1) throw new Error(`runs.json.gz: unknown format ${JSON.stringify(f.format)}`);
  return f;
}

export interface Serving {
  /** The first run: it serves every day before its as-of day. */
  first: LexRun;
  /** From the ledger start, the run serving each as-of day (decision D83, selectPublications). */
  byDay: Map<string, LexRun>;
  /** The first run and every by-day run, once each, in id order. */
  serving: LexRun[];
}

/** Which run serves each day: the SDK's publication rule over the runs, each run's artifact numbered by its run. */
export function servingRuns(runs: readonly LexRun[]): Serving {
  const chosen = selectPublications(runs.map((r) => ({ key: r.asof, date: r.asof, runId: Number(r.id), artifactId: Number(r.id), writtenOn: r.finishedOn, run: r })));
  const byDay = new Map([...chosen].map(([day, c]) => [day, c.run]));
  const first = runs[0]!;
  const serving = [...new Map([first, ...byDay.values()].map((r) => [r.id, r])).values()].sort((a, b) => Number(a.id) - Number(b.id));
  return { first, byDay, serving };
}

/** Each serving run's input history, in the fixture's order, rebuilt from the first run's history and the changes. */
export function* servingInputs(f: LexFixture, serving: readonly LexRun[]): Generator<{ run: LexRun; history: RawIndicatorHistory }> {
  const state = new Map<string, Map<string, number>>(f.series.map((id) => [id, new Map()]));
  for (const run of serving) {
    const entry = f.inputs[run.id];
    if (!entry) throw new Error(`runs.json.gz holds no inputs for serving run ${run.id}`);
    const history: RawIndicatorHistory = {};
    for (const id of f.series) {
      const points = state.get(id)!;
      const change = entry[id];
      if (change) {
        for (const d of change.drop) points.delete(d);
        for (const [d, v] of change.set) points.set(d, v);
      }
      history[id] = [...points].map(([date, value]) => ({ date, value })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    yield { run, history };
  }
}

/** The golden's manifest: the supplementary files it names with their hashes, and what the build served. */
export interface GoldenManifest {
  model: string;
  csv_backups: { commit: string; backup: string };
  supplementary: { path: string; sha256: string }[];
  build: { ledger_start: string; serving_runs: number; newest_run: string; server_date: string };
  outputs: { file: string; sha256: string; days: number; first_day: string; last_day: string };
}

export const readManifest = (): GoldenManifest => JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")) as GoldenManifest;

/** The source id of each raw input of the derived series in the golden's supplementary files, by v5 input id. */
export const SUPPLEMENTARY_SOURCE: Readonly<Record<string, string>> = {
  [V5_INPUT_IDS.deficit]: "fred:MTSDS133FMS",
  [V5_INPUT_IDS.gdp]: "fred:GDP",
  [V5_INPUT_IDS.vix3m]: "yahoo:^VIX3M",
  // The golden divided by its own Yahoo ^VIX file. On the platform the denominator is the stored yahoo:^VIX stream.
  [V5_INPUT_IDS.vix]: "yahoo:^VIX",
  [V5_INPUT_IDS.skew]: "yahoo:^SKEW",
  [V5_INPUT_IDS.volume]: "yahoo-volume:^GSPC",
};

/** The raw inputs of the derived series, by v5 input id, each file checked against its own manifest by the SDK's reader. */
export function readSupplementaryInputs(): Record<string, Point[]> {
  const dir = join(FIXTURE_DIR, "supplementary");
  const out: Record<string, Point[]> = {};
  for (const [id, source] of Object.entries(SUPPLEMENTARY_SOURCE)) out[id] = readSupplementary(dir, source).points;
  return out;
}

type Row = Record<string, unknown> & { date: string };

/** A row as it is stored and read back: canonical JSON, every object's keys sorted. */
const stored = (rows: readonly unknown[]): Row[] => JSON.parse(canonicalStringify(rows)) as Row[];

/** The eleven figures the golden publishes for one backtest line. */
export const BACKTEST_FIELDS = ["final_value", "cagr", "cagr_in_sample", "cagr_out_sample", "sharpe", "max_drawdown", "transitions", "n_days", "start_date", "end_date", "equity_curve"] as const;

/** A backtest payload cut to the golden's eleven fields per line. */
export function publishedBacktest(backtest: Record<string, Record<string, Record<string, unknown>>>): Record<string, Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [market, lines] of Object.entries(backtest)) {
    out[market] = {};
    for (const [name, line] of Object.entries(lines)) out[market]![name] = Object.fromEntries(BACKTEST_FIELDS.map((k) => [k, line[k]]));
  }
  return out;
}

/** One serving run, computed. */
export interface ComputedRun {
  run: LexRun;
  result: KeptRegimeRun;
  extras: { spx: Point[]; eth: Point[]; tbill3m: Point[] };
}

/** One run of the model on a serving run's inputs: the SDK's computeKeptRegime, the function a platform v5 run calls. */
export function computeRun(run: LexRun, history: RawIndicatorHistory, supplementary: Readonly<Record<string, Point[]>>, kept: readonly KeptDay[]): ComputedRun {
  const result = computeKeptRegime({ ...history, ...supplementary }, { asof: run.asof, start: BACKFILL_START, version: "v5", kept });
  const cut = (id: string) => cutAtAsof(history[id] ?? [], run.asof);
  return { run, result, extras: { spx: cut(EXTRA_IDS.spx), eth: cut(EXTRA_IDS.eth), tbill3m: cut(EXTRA_IDS.tbill3m) } };
}

/** The reference backtest of a run's kept record under one rule row (default REGIME_BACKTEST_RULES.v5), without its daily series. */
export function backtestOf(c: ComputedRun, rules: ReferenceBacktestOptions = REGIME_BACKTEST_RULES.v5) {
  const { record } = c.result;
  return stripDailyFromSnapshot(computeBacktest(record.dateAxis, { regime: record.regime, panelRegimes: record.panelRegimes, panels: PANELS }, c.extras, rules));
}

export interface Reproduction {
  serving: Serving;
  /** The published line: one stored row per served day, in date order. */
  rows: Row[];
  /** The newest serving run, computed: its row carries the backtest. */
  newest: ComputedRun;
  /** The kept days before the newest run's as-of day. */
  keptBeforeNewest: KeptDay[];
  /** The run that computed each served day, and whether it read the copy saved that day. */
  runOf: (date: string) => { run: string; copy: "on_day" | "first_run" };
}

/**
 * The model over the fixture, as the platform publishes it: the first run walks
 * forward from its own inputs, then every serving run computes its own day from
 * the kept days before it. The published line follows decision D83: the days
 * before the first run's as-of day come from that run, each later day from the
 * run serving it.
 */
export function reproduce(f: LexFixture, supplementary: Readonly<Record<string, Point[]>>): Reproduction {
  const serving = servingRuns(f.runs);
  const kept: KeptDay[] = [];
  const rows: Row[] = [];
  let newest: ComputedRun | null = null;
  let keptBeforeNewest: KeptDay[] = [];
  let prevAsof = "";
  for (const { run, history } of servingInputs(f, serving.serving)) {
    const isFirst = run.id === serving.first.id;
    const serves = serving.byDay.get(run.asof)?.id === run.id;
    if (!isFirst && !(run.asof > prevAsof)) throw new Error(`serving run ${run.id} is as of ${run.asof}, not after ${prevAsof}: the fixture's serving runs must ascend by as-of day`);
    const before = kept.slice();
    const c = computeRun(run, history, supplementary, kept);
    const isNewest = serves && [...serving.byDay.keys()].every((d) => d <= run.asof);
    const published = stored(keptRegimeRows(c.result, { source: run.source, backtest: isNewest ? backtestOf(c) : null }));
    // The first run's own day is published only when it is also the run serving that day.
    for (const d of c.result.computed) if (d.date < run.asof || serves) kept.push(d);
    for (const r of published) if (r.date < run.asof || serves) rows.push(r);
    if (isNewest) {
      newest = c;
      keptBeforeNewest = before;
    }
    if (serves) prevAsof = run.asof;
  }
  if (newest === null) throw new Error("no run serves the newest day");
  const runOf = (date: string) => {
    const r = serving.byDay.get(date);
    return r ? { run: r.id, copy: "on_day" as const } : { run: serving.first.id, copy: "first_run" as const };
  };
  return { serving, rows, newest, keptBeforeNewest, runOf };
}

type Num = number | null;
const num = (v: unknown): Num => (typeof v === "number" && Number.isFinite(v) ? v : null);
const label = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `v` as JSON with every list of plain values on one line, and every object's keys on their own lines. */
function lines(v: unknown, indent: string): string {
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== "object")) return JSON.stringify(v);
    return `[\n${v.map((x) => `${indent}  ${lines(x, indent + "  ")}`).join(",\n")}\n${indent}]`;
  }
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return "{}";
    if (entries.every(([, x]) => x === null || typeof x !== "object")) return JSON.stringify(Object.fromEntries(entries));
    return `{\n${entries.map(([k, x]) => `${indent}  ${JSON.stringify(k)}: ${lines(x, indent + "  ")}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(v);
}

/**
 * The golden file's text for a published line: one series per line. Only rows
 * that have a label are served. `backtest` is the newest row's, cut to the
 * eleven published fields of each line.
 */
export function goldenText(allRows: readonly Row[], runOf: Reproduction["runOf"], backtest?: unknown): string {
  const rows = allRows.filter((r) => typeof r["regime"] === "string").sort((a, b) => (a.date < b.date ? -1 : 1));
  const ids = new Set<string>();
  for (const r of rows) for (const id of Object.keys((r["percentiles"] ?? {}) as Record<string, unknown>)) ids.add(id);
  const indicators: Record<string, Num[]> = {};
  for (const id of [...ids].sort()) indicators[id] = rows.map((r) => num(((r["percentiles"] ?? {}) as Record<string, unknown>)[id]));
  const panel = (p: string) => ({ index: rows.map((r) => num(r[`${p}Index`])), percentile: rows.map((r) => num(r[`${p}Percentile`])), regime: rows.map((r) => label(r[`${p}Regime`])) });
  const included = [...PANELS];
  const daily = { run: [] as string[], data_copy: [] as string[], included, n: [] as number[], mean_1n: [] as Num[] };
  for (const r of rows) {
    const idx = included.map((p) => (typeof r[`${p}Index`] === "number" ? (r[`${p}Index`] as number) : NaN));
    const who = runOf(r.date);
    daily.run.push(who.run);
    daily.data_copy.push(who.copy);
    daily.n.push(idx.filter(Number.isFinite).length);
    daily.mean_1n.push(num(panelMean(idx, REGIME_MISSING_PANEL.v5)));
  }
  const newestBacktest = backtest ?? rows.at(-1)?.["backtest"] ?? null;
  const out = {
    model: GOLDEN_MODEL,
    dates: rows.map((r) => r.date),
    composite: { value: rows.map((r) => num(r["composite"])), percentile: rows.map((r) => num(r["compositePercentile"])), regime: rows.map((r) => label(r["regime"])) },
    panels: { macro: panel("macro"), onchain: panel("onchain"), factor: panel("factor") },
    indicators,
    backtest: newestBacktest === null ? null : (JSON.parse(canonicalStringify(publishedBacktest(newestBacktest as Record<string, Record<string, Record<string, unknown>>>))) as unknown),
    daily_record: daily,
  };
  return lines(out, "") + "\n";
}

export const sha256 = (body: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(body).digest("hex");
