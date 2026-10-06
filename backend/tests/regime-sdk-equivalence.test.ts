// SDK <-> backend equivalence (issue #1095 audit). The end-user path
// (packages/analyst-sdk runRegime with factor:true) and the production path
// (runAnalytics over the fixture source analytics-suite.test.ts uses) must give
// IDENTICAL regime output for the same raw history: every day's composite,
// composite_percentile, macro/onchain/factor index + percentile + regime, the
// latest row's panel weights, and the correlations + backtest payloads.
//
// How: runAnalytics runs against a fixture AnalyticsDataSource, with a persistence
// wrapper that CAPTURES the regime snapshot rows handed to
// submitTerminalRunPackage (full precision, before Postgres) and then delegates to
// the real writer. The same raw history goes to runRegime, with the fixture
// extras (regime-extras.json.gz spx/eth/tbill3m) mapped in as the SPX / ETH /
// TBILL3M pseudo-indicators. Equality is exact (toBe on numbers, JSON
// round-trip for the payloads), not a tolerance.
//
// WHAT THIS DOES AND DOES NOT PROVE. Both paths call the same
// prepareRegimeInputs, so this test catches WIRING differences (asof handling,
// ages passed or dropped, the two computeRegime calls, extras mapping, rich-row
// provenance), not a bug inside the seam itself. Seam semantics are pinned by
// packages/analyst-sdk/tests/prepare.test.ts (zero_fill, lastRaw, empty series)
// and by analyst-sdk-golden-reference.test.ts, which checks the SDK output
// against an independent re-implementation of the original JS.
//
// Scenarios: BASE (the committed fixture at its ground-truth asof), STALE (HY_OAS
// last observation 200 days before asof, so the 120-day forward-fill age cap
// bites), FUTURE (month-end rows dated AFTER asof on indicators and extras, so
// the date axis must stop at asof). FUTURE_EXTRAS adds future rows to the
// spx/eth/tbill3m extras too. Until issue #1162 Part 0 landed (in PR #1109) it was
// test.failing: runAnalytics handed fetchBacktestExtras() output to
// computeCorrelations/computeBacktest unfiltered, so extras rows dated after asof
// fed the forward-return correlations (look-ahead; n=2923 vs the SDK's 2915 at
// 90d), while runRegime cut every input at asof. Both now cut extras with
// `cutAtAsof` from the seam, and the case is an ordinary passing test.
//
// RED CONTROLS (recorded 2026-10-05). Pointed at the previous runRegime (git show
// a7dbae26:packages/analyst-sdk/src/run.ts: no ages, no asof; the copy got only a
// factor pass added, so the failure is isolated to ages/asof), this file FAILS on
// STALE and FUTURE while BASE passes: STALE because the uncapped copy keeps
// forward-filling HY_OAS past 120 days, FUTURE because its axis runs to the
// month-end row after asof. Before the extras cut in runAnalytics, FUTURE_EXTRAS
// failed on `correlations` (the 90d sample counts differed, 2923 vs 2915). To
// repeat either: copy the old run.ts beside this file with its imports made
// absolute, point the import below at it, and run this file alone.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import type { AnalyticsPersistence } from "../src/analytics/persistence.ts";
import type { Point } from "../src/analytics/types.ts";
import type { Indicator } from "../src/analytics/analyze/indicators.ts";
import type { AnalyticsDataSource, ResearchInputs } from "../src/analytics/access/data-source.ts";
import { TOP7 } from "../src/analytics/analyze/research-signals.ts";
import { MAX_FORWARD_FILL_DAYS } from "../src/analytics/transform/math.ts";
import { computeCorrelations } from "../src/analytics/analyze/correlations.ts";
import { runRegime } from "../../packages/analyst-sdk/src/run.ts";
import { loadRawIndicatorHistory, loadJsonGz } from "./fixtures/regime/load.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

type Rows = Record<string, Point[]>;
const nn = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clone = (r: Rows): Rows => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.map((p) => ({ ...p }))]));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type Scenario = "base" | "stale" | "future" | "future_extras";
const STALE_ID = "HY_OAS";
const FUTURE_IDS = ["T10Y2Y", "VIX", "SHILLER_CAPE", "BTC_ACTIVE"];

async function build(scenario: Scenario) {
  const snap: any = await loadJsonGz("regime-snapshot.json.gz");
  const asof: string = snap.asof;
  const raw: Rows = clone((await loadRawIndicatorHistory()) as Rows);
  const ex: any = await loadJsonGz("regime-extras.json.gz");
  const extras = { spx: clone({ x: ex.spx }).x, eth: clone({ x: ex.eth }).x, tbill3m: clone({ x: ex.tbill3m }).x };
  if (scenario === "stale") {
    const cut = addDays(asof, -200);
    raw[STALE_ID] = raw[STALE_ID]!.filter((p) => p.date <= cut);
  }
  if (scenario === "future" || scenario === "future_extras") {
    // Rows strictly after asof: the next day and the next month-end.
    const next = new Date(Date.parse(`${asof}T00:00:00Z`));
    const monthEnd = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 2, 0)).toISOString().slice(0, 10);
    const future = [addDays(asof, 1), monthEnd];
    expect(monthEnd > asof).toBe(true);
    for (const id of FUTURE_IDS) {
      const last = raw[id]![raw[id]!.length - 1]!;
      for (const d of future) raw[id]!.push({ date: d, value: last.value * 1.5 + 1 });
    }
    for (const k of scenario === "future_extras" ? (["spx", "eth", "tbill3m"] as const) : []) {
      const last = extras[k][extras[k].length - 1]!;
      for (const d of future) extras[k].push({ date: d, value: last.value * 1.5 + 1 });
    }
  }
  return { asof, raw, extras };
}

function source(raw: Rows, extras: { spx: Point[]; eth: Point[]; tbill3m: Point[] }): AnalyticsDataSource {
  const research: ResearchInputs = {
    btc: [], qqq: [], spy: [], rsp: [], top7: TOP7.map(() => [] as Point[]), mna: [], margin: [], conf: [],
  };
  return {
    async fetchIndicators(indicators: Indicator[]) {
      const out: Rows = {};
      for (const ind of indicators) out[ind.id] = (raw[ind.id] ?? []).map((p) => ({ date: p.date, value: p.value }));
      return out;
    },
    async fetchResearchInputs() {
      return research;
    },
    async fetchBacktestExtras() {
      return extras;
    },
  };
}

async function runBoth(scenario: Scenario) {
  const { asof, raw, extras } = await build(scenario);
  const sdkInput: Rows = { ...clone(raw), SPX: extras.spx, ETH: extras.eth, TBILL3M: extras.tbill3m };
  // The SDK is NOT told the asof beyond the option: the future-row scenario is
  // what makes it matter. runRegime resolves it from the option the same way
  // the backend gets it from its argument.
  const sdk = runRegime(sdkInput, { asof, factor: true });

  let captured: any[] | null = null;
  const persistence: AnalyticsPersistence = {
    ...directAnalyticsPersistence,
    async submitTerminalRunPackage(input) {
      captured = [...(input.regimeSnapshots ?? [])];
      return directAnalyticsPersistence.submitTerminalRunPackage(input);
    },
  };
  const results = await runAnalytics(asof, "regime", source(raw, extras), persistence);
  expect(captured).not.toBeNull();
  return { asof, raw, sdk, rows: captured! as any[], results: results as any };
}

function assertEquivalent(asof: string, sdk: ReturnType<typeof runRegime>, rows: any[], raw: Rows) {
  const f = sdk.factor!;
  expect(f).toBeDefined();
  const r = sdk.result;
  const axis = sdk.dateAxis;
  // Axis ends exactly on asof for both paths (future rows never extend it).
  expect(axis[axis.length - 1]).toBe(asof);
  expect(rows[rows.length - 1].date).toBe(asof);

  // Non-vacuous: the expected set is the classifiable days, >2900 of them.
  const expectedIdx: number[] = [];
  for (let i = 0; i < axis.length; i++) if (r.regime[i]) expectedIdx.push(i);
  expect(expectedIdx.length).toBeGreaterThan(2900);
  expect(rows.length).toBe(expectedIdx.length);
  expect(rows.map((x) => x.date)).toEqual(expectedIdx.map((i) => axis[i]!));

  let finiteFactor = 0;
  let finiteComposite = 0;
  rows.forEach((row, k) => {
    const i = expectedIdx[k]!;
    expect(row.composite).toBe(nn(r.composite[i]));
    expect(row.compositePercentile).toBe(nn(r.compositePercentile[i]));
    expect(row.regime).toBe(r.regime[i] ?? null);
    expect(row.macroIndex).toBe(nn(r.panelIndices.macro?.[i]));
    expect(row.onchainIndex).toBe(nn(r.panelIndices.onchain?.[i]));
    expect(row.macroPercentile).toBe(nn(r.panelPercentiles.macro?.[i]));
    expect(row.onchainPercentile).toBe(nn(r.panelPercentiles.onchain?.[i]));
    expect(row.macroRegime).toBe(r.panelRegimes.macro?.[i] ?? null);
    expect(row.onchainRegime).toBe(r.panelRegimes.onchain?.[i] ?? null);
    expect(row.factorIndex).toBe(nn(f.panelIndices.factor?.[i]));
    expect(row.factorPercentile).toBe(nn(f.panelPercentiles.factor?.[i]));
    expect(row.factorRegime).toBe(f.panelRegimes.factor?.[i] ?? null);
    if (row.factorIndex !== null) finiteFactor++;
    if (row.composite !== null) finiteComposite++;
  });
  expect(finiteComposite).toBeGreaterThan(2900);
  expect(finiteFactor).toBeGreaterThan(1000);

  // Latest row: panel weights, backtest, correlations (JSON round-trip equality).
  const latest = rows[rows.length - 1];
  const weights = latest.panelWeights;
  expect(weights).not.toBeNull();
  expect(Object.keys(weights.macro).length).toBeGreaterThan(3);
  expect(Object.keys(weights.onchain).length).toBeGreaterThan(3);
  expect(Object.keys(weights.factor).length).toBeGreaterThan(3);
  expect(JSON.parse(JSON.stringify(weights.macro))).toEqual(JSON.parse(JSON.stringify(r.weightsByPanel.macro)));
  expect(JSON.parse(JSON.stringify(weights.onchain))).toEqual(JSON.parse(JSON.stringify(r.weightsByPanel.onchain)));
  expect(JSON.parse(JSON.stringify(weights.factor))).toEqual(JSON.parse(JSON.stringify(f.weightsByPanel.factor)));

  expect(sdk.correlations).toBeDefined();
  expect(sdk.backtest).toBeDefined();
  expect(latest.correlations).not.toBeNull();
  expect(latest.backtest).not.toBeNull();
  expect(Object.keys(latest.backtest).sort()).toEqual(["eth", "mixed", "sp500"]);
  expect(JSON.stringify(latest.correlations)).toBe(JSON.stringify(sdk.correlations));
  expect(JSON.stringify(latest.backtest)).toBe(JSON.stringify(sdk.backtest));
  // Rich indicator provenance: raw_value/raw_date are each input series' last
  // row as given (prepareRegimeInputs lastRaw; null when the series is empty).
  // Pinned here because no composite column depends on them.
  const inds = latest.indicators as any[];
  expect(inds.length).toBeGreaterThan(20);
  let withRaw = 0;
  for (const ind of inds) {
    const rs = raw[ind.id] ?? [];
    const last = rs.length ? rs[rs.length - 1]! : null;
    expect(ind.raw_value).toBe(last ? last.value : null);
    expect(ind.raw_date).toBe(last ? last.date : null);
    if (last) withRaw++;
  }
  expect(withRaw).toBeGreaterThan(20);
  // Historical rows carry no backtest/correlations/weights.
  expect(rows[0].backtest).toBeNull();
  expect(rows[0].panelWeights).toBeNull();
}

const TIMEOUT = { timeout: 600_000 };
const composites: Record<string, number | null> = {};

test("BASE: fixture history at the ground-truth asof, SDK and backend agree on every day", async () => {
  const { asof, raw, sdk, rows, results } = await runBoth("base");
  assertEquivalent(asof, sdk, rows, raw);
  expect(results.regime.composite).toBe(nn(sdk.result.composite[sdk.dateAxis.length - 1]));
  expect(results.regime.rows).toBe(rows.length);
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM regime_snapshots`;
  expect(count).toBe(rows.length);
  composites.base = rows[rows.length - 1].composite;
}, TIMEOUT);

test("STALE: an indicator last observed 200 days before asof is age-capped identically", async () => {
  const { asof, raw } = await build("stale");
  const lastHy = raw[STALE_ID]![raw[STALE_ID]!.length - 1]!.date;
  expect(lastHy <= addDays(asof, -(MAX_FORWARD_FILL_DAYS + 1))).toBe(true);
  const { raw: rawStale, sdk, rows } = await runBoth("stale");
  assertEquivalent(asof, sdk, rows, rawStale);
  // The cap actually bites in the persisted rich indicator row (not vacuous).
  const hy = (rows[rows.length - 1].indicators as any[]).find((x) => x.id === STALE_ID);
  expect(hy.forward_fill_expired).toBe(true);
  expect(hy.forward_fill_age_days).toBeGreaterThan(MAX_FORWARD_FILL_DAYS);
  // And it changes the answer relative to the uncapped fixture.
  const base = await build("base");
  const baseSdk = runRegime({ ...clone(base.raw), SPX: base.extras.spx, ETH: base.extras.eth, TBILL3M: base.extras.tbill3m }, { asof: base.asof });
  const baseLast = baseSdk.result.composite[baseSdk.dateAxis.length - 1];
  expect(rows[rows.length - 1].composite).not.toBe(nn(baseLast));
}, TIMEOUT);

test("FUTURE: month-end rows dated after asof never extend the axis or move any figure", async () => {
  const { asof, raw, extras } = await build("future");
  expect(raw.T10Y2Y!.some((p) => p.date > asof)).toBe(true);
  const { raw: rawFuture, sdk, rows } = await runBoth("future");
  assertEquivalent(asof, sdk, rows, rawFuture);
  // Equal to the BASE scenario's latest figures: the future rows changed nothing.
  const base = await build("base");
  const baseSdk = runRegime({ ...clone(base.raw), SPX: base.extras.spx, ETH: base.extras.eth, TBILL3M: base.extras.tbill3m }, { asof: base.asof, factor: true });
  expect(sdk.dateAxis.length).toBe(baseSdk.dateAxis.length);
  expect(rows[rows.length - 1].composite).toBe(nn(baseSdk.result.composite[baseSdk.dateAxis.length - 1]));
}, TIMEOUT);

test("FUTURE_EXTRAS: extras rows after asof reach neither backend nor SDK correlations and backtest", async () => {
  const { asof, extras } = await build("future_extras");
  expect(extras.spx.some((p) => p.date > asof)).toBe(true);
  const { raw: rawFx, sdk, rows } = await runBoth("future_extras");
  assertEquivalent(asof, sdk, rows, rawFx);
  // Not vacuous: the future rows would have changed the answer. This is exactly
  // what the backend computed before the cut (uncut extras over the same axis).
  const uncut = computeCorrelations(sdk.dateAxis, sdk.result, { spx: extras.spx, eth: extras.eth });
  expect(JSON.stringify(uncut)).not.toBe(JSON.stringify(sdk.correlations));
}, TIMEOUT);
