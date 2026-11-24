// Knowledge time (issue 1733, docs/technical/regime-engine.md section 8.1.2):
// every series declares when its source publishes a period's value; a run for
// day t reads each value from the day it was known, at the version known then.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INDICATORS,
  PublicationRuleError,
  isProvisional,
  knowledgeTimeSeries,
  parseRawHistory,
  prepareRegimeInputs,
  publicationRuleOf,
  publishedOn,
  requireComplete,
  runRegime,
  toHistory,
  type Indicator,
  type RawIndicatorHistory,
} from "../src/index.ts";
import { LATE_CYCLE_PUBLICATION, computeLateCycle, knownResearchInputs } from "../src/analyze/research-signals.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "../src/transform/ratios.ts";
import { resolveInputHistory } from "../src/series-ids.ts";
import { parseCoinmetricsPage } from "../src/extract/coinmetrics.ts";
import { parseLlamaStables, parseLlamaTvl } from "../src/extract/defillama.ts";
import { parseLlamaYieldChart } from "../src/extract/defillama-yields.ts";
import { parseBlockchainChart } from "../src/extract/blockchain-com.ts";
import { parseYahoo, parseYahooClose } from "../src/extract/yahoo.ts";
import { parseFredCsv } from "../src/extract/fred.ts";
import { parseMultplHtml } from "../src/extract/shiller.ts";
import { enumerateMonths } from "../src/extract/edgar.ts";

setDefaultTimeout(120_000);

const ind = (id: string): Indicator => INDICATORS.find((i) => i.id === id)!;
const rule = (id: string) => publicationRuleOf(ind(id));

describe("publication rules are required", () => {
  test("every registry indicator declares one", () => {
    for (const i of INDICATORS) expect(() => publicationRuleOf(i), i.id).not.toThrow();
  });

  test("the loader throws PublicationRuleError naming a registry indicator with no rule", () => {
    const bare = { ...ind("VIX"), id: "NO_RULE" } as Partial<Indicator>;
    delete bare.publication;
    const raw: RawIndicatorHistory = { NO_RULE: [{ date: "2024-01-02", value: 1 }] };
    expect(() => prepareRegimeInputs(raw, { start: "2024-01-01", asof: "2024-01-05", indicators: [bare as Indicator] })).toThrow(PublicationRuleError);
    expect(() => prepareRegimeInputs(raw, { start: "2024-01-01", asof: "2024-01-05", indicators: [bare as Indicator] })).toThrow(/NO_RULE/);
  });

  test("the loader throws PublicationRuleError naming a research input with no rule", () => {
    const inputs = { a: [{ date: "2024-01-02", value: 1 }], b: [{ date: "2024-01-02", value: 2 }] };
    expect(() => knownResearchInputs(inputs, ["a", "b"], { a: { kind: "same-day" } }, "2024-01-05")).toThrow(PublicationRuleError);
    expect(() => knownResearchInputs(inputs, ["a", "b"], { a: { kind: "same-day" } }, "2024-01-05")).toThrow(/research input b/);
  });

  test("a malformed rule is refused", () => {
    expect(() => publicationRuleOf({ id: "X", publication: { kind: "business-days", days: 0 } })).toThrow(PublicationRuleError);
    expect(() => publicationRuleOf({ id: "X", publication: { kind: "next-weekday", weekday: 7 } })).toThrow(PublicationRuleError);
    expect(() => publicationRuleOf({ id: "X", publication: { kind: "later" } })).toThrow(PublicationRuleError);
  });
});

describe("each slow-release series carries its publication date, not its period date", () => {
  test.each([
    // FRED dailies: the next business day (Friday -> Monday).
    ["T10Y2Y", "2024-03-08", "2024-03-11"],
    ["DFII10", "2024-03-08", "2024-03-11"],
    ["T5YIE", "2024-03-07", "2024-03-08"],
    ["HY_OAS", "2024-03-08", "2024-03-11"],
    // DTWEXBGS (H.10): the Monday after.
    ["DXY", "2024-03-06", "2024-03-11"],
    ["DXY", "2024-03-11", "2024-03-18"],
    // ICSA: the Thursday after its week-ending Saturday.
    ["ICSA", "2024-03-02", "2024-03-07"],
    // CAPE averages the whole month: the 1st of the next month.
    ["SHILLER_CAPE", "2024-03-01", "2024-04-01"],
    // Market closes: the same day.
    ["VIX", "2024-03-08", "2024-03-08"],
  ])("%s dated %s is known on %s", (id, period, known) => {
    expect(publishedOn(period, rule(id))).toBe(known);
  });

  test.each([
    // Z.1 quarterly margin debt (BOGZ1FL663067003Q), dated the quarter's first day.
    ["margin", "2024-01-01", "2024-07-01"],
    // UMCSENT, dated the month's first day.
    ["conf", "2024-03-01", "2024-04-01"],
  ] as const)("research input %s dated %s is known on %s", (name, period, known) => {
    expect(publishedOn(period, LATE_CYCLE_PUBLICATION[name])).toBe(known);
  });

  test("before forward-fill: ICSA's week is not on the axis before Thursday, CAPE's month not before the 1st of the next", () => {
    const raw: RawIndicatorHistory = {
      ICSA: [{ date: "2024-02-24", value: 200_000 }, { date: "2024-03-02", value: 300_000 }],
      SHILLER_CAPE: [{ date: "2024-02-01", value: 30 }, { date: "2024-03-01", value: 33 }],
    };
    const p = prepareRegimeInputs(raw, { start: "2024-02-01", asof: "2024-04-02", indicators: [ind("ICSA"), ind("SHILLER_CAPE")] });
    const at = (id: string, day: string) => p.transformed[id]![p.dateAxis.indexOf(day)];
    expect(at("ICSA", "2024-03-06")).toBe(200_000);
    expect(at("ICSA", "2024-03-07")).toBe(300_000);
    expect(at("SHILLER_CAPE", "2024-03-31")).toBe(30);
    expect(at("SHILLER_CAPE", "2024-04-01")).toBe(33);
    // Nothing for CAPE before the February value was published (2024-03-01).
    expect(Number.isNaN(at("SHILLER_CAPE", "2024-02-29")!)).toBe(true);
  });

  test("the late-cycle margin and confidence gauges read only what was published by the as-of day", () => {
    const daily = (from: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), value: 100 + i }));
    const base = { spy: daily("2023-01-01", 500), rsp: daily("2023-01-01", 500), top7: [], mna: [] };
    const margin = [{ date: "2023-01-01", value: 10 }, { date: "2023-04-01", value: 11 }, { date: "2024-01-01", value: 99 }];
    const conf = [{ date: "2024-03-01", value: 70 }, { date: "2024-04-01", value: 50 }];
    const r = computeLateCycle({ ...base, margin, conf }, "2024-04-15") as unknown as {
      indicators: { margin_debt_level: { date: string }[]; consumer_conf_level: { date: string }[] };
      summary: { consumer_conf: { value: number } };
    };
    // Q1 2024 (dated Jan 1) is known Jul 1; UMCSENT April (dated Apr 1) is known May 1.
    expect(r.indicators.margin_debt_level.map((p) => p.date)).toEqual(["2023-01-01", "2023-04-01"]);
    expect(r.indicators.consumer_conf_level.map((p) => p.date)).toEqual(["2024-03-01"]);
    expect(r.summary.consumer_conf.value).toBe(70);
  });
});

describe("equity ratios read raw closes", () => {
  test("the six equity ratios declare legs and raw closes", () => {
    for (const id of ["IWM_SPY", "SPHB_SPLV", "MTUM_SPY", "IWF_IWD", "XLU_SPY", "XLP_XLY"]) {
      expect({ id, input: ind(id).ratioInput, close: ind(id).ratioClose }).toEqual({ id, input: "legs", close: "raw" });
    }
  });

  test("a later dividend leaves every earlier ratio value unchanged", () => {
    const days = ["2024-03-04", "2024-03-05", "2024-03-06", "2024-03-07"];
    const close = (v: number[]) => days.map((date, i) => ({ date, value: v[i]! }));
    const legs = (iwmAdj: number[]) => ({
      "yahoo:IWM.close": close([200, 202, 201, 203]),
      "yahoo:SPY.close": close([500, 505, 503, 507]),
      "yahoo:IWM.adjclose": close(iwmAdj),
      "yahoo:SPY.adjclose": close([500, 505, 503, 507]),
    });
    const ratio = (input: RawIndicatorHistory) => ratiosFromLegs(input, resolveInputHistory(input), ratioDeclarationsFor("v4", [ind("IWM_SPY")])).IWM_SPY!;
    const before = ratio(legs([200, 202, 201, 203]));
    // A dividend paid after 2024-03-07 back-adjusts every earlier adjusted close.
    const after = ratio(legs([198, 200, 199, 201]));
    expect(after).toEqual(before);
    // Control: the adjusted legs (v3's declaration) do move.
    const adj = (input: RawIndicatorHistory) => ratiosFromLegs(input, resolveInputHistory(input), ratioDeclarationsFor("v3", [ind("IWM_SPY")])).IWM_SPY!;
    expect(adj(legs([198, 200, 199, 201]))).not.toEqual(adj(legs([200, 202, 201, 203])));
  });
});

describe("partial-day capture (finding E4)", () => {
  const rows = [
    { date: "2024-03-05", value: 100, known: "2024-03-05T23:00:00Z" },
    { date: "2024-03-06", value: 10, known: "2024-03-06T15:00:00Z" },
    { date: "2024-03-06", value: 12, known: "2024-03-07T00:05:00Z" },
  ];

  test("a value acquired before its UTC day ends is provisional; the full-day fetch is a revision known the next day", () => {
    expect(isProvisional(rows[1]!)).toBe(true);
    expect(isProvisional(rows[2]!)).toBe(false);
    expect(knowledgeTimeSeries(rows, { kind: "same-day" }, "2024-03-06").at(-1)).toEqual({ date: "2024-03-06", value: 10, period: "2024-03-06" });
    expect(knowledgeTimeSeries(rows, { kind: "same-day" }, "2024-03-07").at(-1)).toEqual({ date: "2024-03-07", value: 12, period: "2024-03-06" });
  });

  test("a replay as of that day does not see the later full-day value", () => {
    const raw: RawIndicatorHistory = { DEFI_TVL: rows };
    const p = prepareRegimeInputs(raw, { start: "2024-03-05", asof: "2024-03-06", indicators: [ind("DEFI_TVL")] });
    expect(p.transformed.DEFI_TVL!.at(-1)).toBe(10);
    expect(p.lastRaw.DEFI_TVL).toEqual({ date: "2024-03-06", value: 10 });
    const later = prepareRegimeInputs(raw, { start: "2024-03-05", asof: "2024-03-07", indicators: [ind("DEFI_TVL")] });
    expect(later.transformed.DEFI_TVL!.slice(0, 2)).toEqual(p.transformed.DEFI_TVL!);
    expect(later.transformed.DEFI_TVL!.at(-1)).toBe(12);
  });

  test("a revision of an older period never reaches back, nor replaces a newer period", () => {
    const s = knowledgeTimeSeries(
      [
        { date: "2024-03-01", value: 1 },
        { date: "2024-03-02", value: 2 },
        { date: "2024-03-01", value: 9, known: "2024-03-04T10:00:00Z" },
      ],
      { kind: "same-day" },
    );
    expect(s).toEqual([
      { date: "2024-03-01", value: 1, period: "2024-03-01" },
      { date: "2024-03-02", value: 2, period: "2024-03-02" },
      { date: "2024-03-04", value: 2, period: "2024-03-02" },
    ]);
  });
});

describe("each extractor pins the UTC day of a value around midnight (finding E5)", () => {
  const MIDNIGHT = Date.parse("2024-03-01T00:00:00Z") / 1000;

  test("Coin Metrics: a row's time is the start of its UTC day", () => {
    const { points } = parseCoinmetricsPage(
      { data: [{ time: "2024-02-29T23:59:59.000000000Z", AdrActCnt: "1" }, { time: "2024-03-01T00:00:00.000000000Z", AdrActCnt: "2" }] },
      "AdrActCnt",
    );
    expect(points.map((p) => p.date)).toEqual(["2024-02-29", "2024-03-01"]);
  });

  test("DefiLlama TVL and stablecoins: unix seconds at 00:00:00Z name that UTC day", () => {
    expect(parseLlamaTvl([{ date: MIDNIGHT - 1, tvl: 1 }, { date: MIDNIGHT, tvl: 2 }]).map((p) => p.date)).toEqual(["2024-02-29", "2024-03-01"]);
    expect(
      parseLlamaStables([
        { date: String(MIDNIGHT - 1), totalCirculatingUSD: { peggedUSD: 1 } },
        { date: String(MIDNIGHT), totalCirculatingUSD: { peggedUSD: 2 } },
      ]).map((p) => p.date),
    ).toEqual(["2024-02-29", "2024-03-01"]);
  });

  test("DefiLlama yields: the UTC day of the timestamp", () => {
    const pts = parseLlamaYieldChart(
      { status: "success", data: [{ timestamp: "2024-02-29T23:59:59.000Z", apyBase: 1 }, { timestamp: "2024-03-01T00:00:00.000Z", apyBase: 2 }] },
      "pool",
    );
    expect(pts.map((p) => p.date)).toEqual(["2024-02-29", "2024-03-01"]);
  });

  test("blockchain.com: unix seconds at 00:00:00Z name that UTC day", () => {
    expect(parseBlockchainChart({ values: [{ x: MIDNIGHT - 1, y: 1 }, { x: MIDNIGHT, y: 2 }] }).map((p) => p.date)).toEqual(["2024-02-29", "2024-03-01"]);
  });

  test("Yahoo: the UTC day of the session timestamp, for both closes", () => {
    const chart = { chart: { result: [{ timestamp: [MIDNIGHT - 1, MIDNIGHT], indicators: { quote: [{ close: [1, 2] }], adjclose: [{ adjclose: [1, 2] }] } }] } };
    expect(parseYahoo(chart).map((p) => p.date)).toEqual(["2024-02-29", "2024-03-01"]);
    expect(parseYahooClose(chart).map((p) => p.date)).toEqual(["2024-02-29", "2024-03-01"]);
  });

  test("EDGAR: a month's count is stamped on its last UTC day, never the next month's first", () => {
    expect(enumerateMonths("2024-02-29", "2024-03-01")).toEqual([
      { monthStart: "2024-02-01", monthEnd: "2024-02-29" },
      { monthStart: "2024-03-01", monthEnd: "2024-03-31" },
    ]);
  });

  test("FRED and multpl: period dates are kept as served, with no time zone shift", () => {
    expect(parseFredCsv("observation_date,ICSA\n2024-02-29,1\n2024-03-01,2\n", "ICSA").map((p) => p.date)).toEqual(["2024-02-29", "2024-03-01"]);
    const html = `<table><tr><td>Mar 1, 2024</td><td>33.1</td></tr><tr><td>Feb 1, 2024</td><td>32.0</td></tr></table>`;
    expect(parseMultplHtml(html).map((p) => p.date)).toEqual(["2024-02-01", "2024-03-01"]);
  });
});

describe("prefix invariance", () => {
  const text = readFileSync(join(import.meta.dir, "fixtures/raw-indicator-history.csv"), "utf8");
  const base = toHistory(parseRawHistory(text));
  // Every ICSA week is revised a week after it was published, alternately up and down.
  const revise = (v: number, i: number) => v * (i % 2 ? 1.5 : 0.6);
  const revised: RawIndicatorHistory = { ...base };
  revised.ICSA = [
    ...base.ICSA!,
    ...base.ICSA!.map((p, i) => ({ date: p.date, value: revise(p.value, i), known: `${publishedOn(publishedOn(p.date, rule("ICSA")), { kind: "next-weekday", weekday: 4 })}T13:30:00Z` })),
  ];
  const END = base.VIX!.at(-1)!.date;
  const full = requireComplete(runRegime(revised, { asof: END }));

  const rowOf = (run: ReturnType<typeof requireComplete>, day: string) => {
    const i = run.dateAxis.indexOf(day);
    const n = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? null : v);
    const r = run.result;
    return {
      composite: n(r.composite[i]),
      compositePercentile: n(r.compositePercentile[i]),
      regime: r.regime[i] ?? null,
      panels: Object.fromEntries(r.panels.map((p) => [p, [n(r.panelIndices[p]![i]), r.panelRegimes[p]![i] ?? null]])),
      signed: Object.fromEntries(INDICATORS.map((x) => [x.id, n(r.signed[x.id]?.[i])])),
    };
  };

  test.each(["2023-06-14", "2024-02-08", "2024-09-30"])("runRegime as-of %s equals that row of a later full run, for every series", (t) => {
    const asof = requireComplete(runRegime(revised, { asof: t }));
    expect(rowOf(asof, t)).toEqual(rowOf(full, t));
  });

  test("non-vacuity: a run that reads the revisions by period date gives another ICSA row", () => {
    const leaked: RawIndicatorHistory = { ...base, ICSA: base.ICSA!.map((p, i) => ({ date: p.date, value: revise(p.value, i) })) };
    const t = "2024-02-08";
    const a = rowOf(requireComplete(runRegime(leaked, { asof: t })), t);
    expect(a.signed.ICSA).not.toEqual(rowOf(full, t).signed.ICSA);
  });
});
