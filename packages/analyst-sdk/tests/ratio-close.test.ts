// Issue 1644: each ratio declares two methodology parameters in the registry,
// ratioInput ("stored" | "legs") and ratioClose ("adjusted" | "raw"). The
// values shipped before issue 1733 ("stored", "adjusted", which v3 keeps:
// ratioDeclarationsFor("v3")) reproduce main; a malformed
// declaration is refused when the registry loads; and changing either value
// changes the output (non-vacuity). The choices themselves are research issue
// 1673.
import { afterEach, expect, test } from "bun:test";
import { INDICATORS, InvalidRatioCloseError, validateRatioDeclarations, type Indicator } from "../src/analyze/indicators.ts";
import { configureHttp } from "../src/extract/http.ts";
import { createFetchMemo, fetchAll, registryYahooPlan } from "../src/extract/sources.ts";
import { fetchYahoo } from "../src/extract/yahoo.ts";
import { MissingRatioLegError, RATIO_IDS, RATIO_LEG_KEYS, StoredRatioOnlyError, resolveInputHistory } from "../src/series-ids.ts";
import { mergeRatioSeries } from "../src/transform/grid.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "../src/transform/ratios.ts";
import { buildReport, requireComplete, runRegime } from "../src/run.ts";
import type { RawIndicatorHistory } from "../src/types.ts";
import { fixture } from "./support/ratio-legs.ts";

afterEach(() => { configureHttp({}); });

// The declarations v3 reads: every ratio "stored" and "adjusted" (issue 1733).
const V3 = ratioDeclarationsFor("v3");
const RATIOS = V3.filter((i) => RATIO_IDS.has(i.id));
const copyWith = (id: string, patch: Partial<Indicator> | ((i: Indicator) => Indicator)): Indicator[] =>
  V3.map((i) => (i.id !== id ? i : typeof patch === "function" ? patch(i) : { ...i, ...patch }));
const resolve = (h: RawIndicatorHistory, inds: readonly Indicator[] = V3) => ratiosFromLegs(h, resolveInputHistory(h), inds);
const EQUITY = ["IWF_IWD", "IWM_SPY", "MTUM_SPY", "SPHB_SPLV", "XLP_XLY", "XLU_SPY"];

test("the six equity ratios declare legs and raw closes, COPPER_GOLD and BTC_ETH stored and adjusted, v3 reads all eight stored and adjusted, and no other indicator declares either", () => {
  expect(RATIOS.map((i) => i.id).sort()).toEqual(["BTC_ETH", "COPPER_GOLD", "IWF_IWD", "IWM_SPY", "MTUM_SPY", "SPHB_SPLV", "XLP_XLY", "XLU_SPY"]);
  for (const r of RATIOS) expect({ id: r.id, input: r.ratioInput, close: r.ratioClose }).toEqual({ id: r.id, input: "stored", close: "adjusted" });
  for (const r of INDICATORS.filter((x) => RATIO_IDS.has(x.id))) {
    const want = EQUITY.includes(r.id) ? { input: "legs" as const, close: "raw" as const } : { input: "stored" as const, close: "adjusted" as const };
    expect({ id: r.id, input: r.ratioInput, close: r.ratioClose }).toEqual({ id: r.id, ...want });
  }
  expect(ratioDeclarationsFor("v4")).toBe(INDICATORS);
  for (const i of INDICATORS.filter((x) => !RATIO_IDS.has(x.id))) expect({ id: i.id, input: i.ratioInput, close: i.ratioClose }).toEqual({ id: i.id, input: undefined, close: undefined });
  expect(validateRatioDeclarations(INDICATORS)).toBe(INDICATORS);
});

test("a malformed declaration throws InvalidRatioCloseError naming the indicator", () => {
  const refuse = (inds: Indicator[], id: string, field: "ratioInput" | "ratioClose") => {
    let err: unknown;
    try {
      validateRatioDeclarations(inds);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidRatioCloseError);
    expect({ id: (err as InvalidRatioCloseError).indicatorId, field: (err as InvalidRatioCloseError).field }).toEqual({ id, field });
    expect((err as Error).message).toContain(id);
  };
  refuse(copyWith("IWM_SPY", ({ ratioInput: _drop, ...rest }) => rest as Indicator), "IWM_SPY", "ratioInput");
  refuse(copyWith("COPPER_GOLD", ({ ratioClose: _drop, ...rest }) => rest as Indicator), "COPPER_GOLD", "ratioClose");
  refuse(copyWith("BTC_ETH", { ratioClose: "mid" as never }), "BTC_ETH", "ratioClose");
  refuse(copyWith("XLU_SPY", { ratioInput: "both" as never }), "XLU_SPY", "ratioInput");
  refuse(copyWith("VIX", { ratioInput: "stored" }), "VIX", "ratioInput");
  refuse(copyWith("SPX_TREND", { ratioClose: "raw" }), "SPX_TREND", "ratioClose");
});

test("for each ratio, on mocked charts whose close and adjclose differ, the ratio of the .adjclose legs equals mergeRatioSeries of the two fetchYahoo series", async () => {
  const days = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08"].map((d) => Date.parse(`${d}T00:00:00Z`) / 1000);
  const chart = (url: string) => {
    const sym = decodeURIComponent(url.match(/\/chart\/([^?]+)\?/)![1]!);
    const base = [...sym].reduce((a, c) => a + c.charCodeAt(0), 0);
    return Response.json({ chart: { result: [{ timestamp: days, indicators: {
      adjclose: [{ adjclose: days.map((_, i) => base + i * 1.25) }],
      quote: [{ close: days.map((_, i) => base * 1.5 + i) }],
    } }] } });
  };
  configureHttp({ fetch: (async (u: string) => chart(String(u))) as unknown as typeof fetch });
  const out = await fetchAll({ indicators: RATIOS, logger: {}, memo: createFetchMemo(registryYahooPlan(RATIOS)) });
  const adjusted: RawIndicatorHistory = Object.fromEntries(Object.entries(out).filter(([k]) => k.endsWith(".adjclose")));
  const fromLegs = resolve(adjusted);
  for (const r of RATIOS) {
    const [n, d] = r.series as [string, string];
    const expected = mergeRatioSeries(await fetchYahoo(n), await fetchYahoo(d));
    expect(expected.length, r.id).toBe(days.length);
    expect({ id: r.id, ratio: fromLegs[r.id] }).toEqual({ id: r.id, ratio: expected });
    // The raw closes give a different ratio, so the comparison is not vacuous.
    expect(mergeRatioSeries(out[`yahoo:${n}.close`]!, out[`yahoo:${d}.close`]!)).not.toEqual(expected);
  }
});

test("non-vacuity: ratioInput legs and ratioClose raw each change the output against the shipped values", () => {
  const legs = copyWith("IWM_SPY", { ratioInput: "legs", ratioClose: "adjusted" });
  const legsRaw = copyWith("IWM_SPY", { ratioInput: "legs", ratioClose: "raw" });
  const shipped = resolve(fixture).IWM_SPY!;
  expect(shipped).toBe(fixture.IWM_SPY!);
  const fromAdjusted = resolve(fixture, legs).IWM_SPY!;
  expect(fromAdjusted).toEqual(mergeRatioSeries(fixture["yahoo:IWM.adjclose"]!, fixture["yahoo:SPY.adjclose"]!));
  expect(fromAdjusted).not.toEqual(shipped);
  const fromRaw = resolve(fixture, legsRaw).IWM_SPY!;
  expect(fromRaw).toEqual(mergeRatioSeries(fixture["yahoo:IWM.close"]!, fixture["yahoo:SPY.close"]!));
  expect(fromRaw).not.toEqual(fromAdjusted);

  // With "raw" and only the .close legs the ratio is computed; with "adjusted"
  // and only the .close legs it is a missing input.
  const closeOnly: RawIndicatorHistory = {};
  for (const sym of ["IWM", "SPY", "MTUM", "XLU"]) closeOnly[`yahoo:${sym}.close`] = fixture[`yahoo:${sym}.close`]!;
  const rawOnly = V3.map((i) => (["IWM_SPY", "MTUM_SPY", "XLU_SPY"].includes(i.id) ? { ...i, ratioClose: "raw" as const } : i));
  expect(resolve(closeOnly, rawOnly).IWM_SPY).toEqual(fromRaw);
  expect(() => resolve(closeOnly)).toThrow(MissingRatioLegError);
});

// IWM_SPY is a factor-panel indicator, so its change shows in the 3-panel
// (macro, onchain, factor) composite of the factor run. The adjusted legs
// fetched after 2026-08-15 differ from the stored ratio by one constant factor
// (every later dividend rescales all earlier adjusted closes alike), and the
// percentile ranks are scale-free, so "legs" with "adjusted" moves the series
// and not the ranks. "legs" with "raw" moves the composite.
test("non-vacuity: the factor run's composite series with IWM_SPY from its raw legs differs from the shipped one", () => {
  const fromRaw = resolve(fixture, copyWith("IWM_SPY", { ratioInput: "legs", ratioClose: "raw" })).IWM_SPY!;
  const composite = (h: RawIndicatorHistory) => requireComplete(runRegime(h, { factor: true, version: "v3" })).factor!.composite;
  const shipped = composite(fixture);
  expect(shipped.filter(Number.isFinite).length).toBeGreaterThan(100);
  expect(composite({ ...fixture, IWM_SPY: fromRaw })).not.toEqual(shipped);
}, 120_000);

// Issue 1751, gap 10: under v4 the six equity ratios are calculated from their
// raw-close legs. An input that stores only the finished ratios (an archive run
// before 2026-11-17) loses all six; the run now says so in droppedRatios, and
// throws only when asked to.
test("v4 over stored-only equity ratios lists exactly the six in droppedRatios and reports as 0.8.0; storedOnlyRatio error throws naming the first; an input with legs drops none", () => {
  const storedOnly: RawIndicatorHistory = Object.fromEntries(Object.entries(fixture).filter(([k]) => !RATIO_LEG_KEYS.has(k)));
  for (const id of EQUITY) expect(storedOnly[id]!.length).toBeGreaterThan(100);
  expect(Object.keys(storedOnly).some((k) => k.startsWith("yahoo:"))).toBe(false);

  const run = requireComplete(runRegime(storedOnly, { factor: true }));
  expect([...run.droppedRatios].sort()).toEqual(EQUITY);
  // 0.8.0 dropped the six in silence: the report is the one of an input without them.
  const without: RawIndicatorHistory = Object.fromEntries(Object.entries(storedOnly).filter(([k]) => !EQUITY.includes(k)));
  const silent = requireComplete(runRegime(without, { factor: true }));
  expect(silent.droppedRatios).toEqual([]);
  expect(JSON.stringify(buildReport(run, { full: true }))).toBe(JSON.stringify(buildReport(silent, { full: true })));
  for (const id of EQUITY) expect(run.factor!.weightsByPanel.factor![id]).toBe(0);
  expect("droppedRatios" in buildReport(run)).toBe(false);
  // "drop" spelled out is the default, and the default never throws for this input.
  expect(requireComplete(runRegime(storedOnly, { factor: true, storedOnlyRatio: "drop" }))).toEqual(run);

  const call = () => runRegime(storedOnly, { storedOnlyRatio: "error" });
  expect(call).toThrow(StoredRatioOnlyError);
  const first = INDICATORS.find((i) => EQUITY.includes(i.id))!.id;
  let err: unknown;
  try {
    call();
  } catch (e) {
    err = e;
  }
  expect((err as StoredRatioOnlyError).ratio).toBe(first);
  expect((err as Error).message).toContain(first);

  // The fixture carries the raw-close legs: nothing is dropped, under either setting.
  const withLegs = requireComplete(runRegime(fixture, { factor: true }));
  expect(withLegs.droppedRatios).toEqual([]);
  expect(requireComplete(runRegime(fixture, { factor: true, storedOnlyRatio: "error" }))).toEqual(withLegs);
  for (const id of EQUITY) expect(withLegs.factor!.weightsByPanel.factor![id]).toBeGreaterThan(0);
  // v3 reads every ratio stored, so it drops none from the stored-only input.
  expect(requireComplete(runRegime(storedOnly, { version: "v3", storedOnlyRatio: "error" })).droppedRatios).toEqual([]);
}, 120_000);
