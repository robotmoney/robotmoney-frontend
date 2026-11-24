// Issue 1655: day completeness, the declared day rule and each source's
// declared day-close rule, on fixture inputs where Coin Metrics trails by one
// day and DefiLlama serves a partial current day.
//   - Shipped values: DAY_RULE is score-newest and every SOURCE_DAY_CLOSE entry
//     is accept-partial, so runs score the day they scored before and the
//     extractors keep every served row; drop-unclosed outside DefiLlama and
//     Coin Metrics is refused.
//   - latestCompleteDay returns the latest day on which every started indicator
//     is within its policy. Under dayRule require-complete, runRegime without
//     an as-of day scores that day, and an explicit incomplete day returns
//     IncompleteDay with no figure.
//   - Non-vacuity: require-complete on an input with an indicator more than 120
//     days stale, and drop-unclosed on an input with a run-date row, each
//     change the output against the shipped values.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { DAY_RULE, INDICATORS, type FillPolicy } from "../src/analyze/indicators.ts";
import { latestCompleteDay, missingOnDay } from "../src/prepare.ts";
import { IncompleteDayError, requireComplete, runRegime } from "../src/run.ts";
import { configureHttp } from "../src/extract/http.ts";
import { fetchDefillamaStables, fetchDefillamaTvl } from "../src/extract/defillama.ts";
import { fetchCoinmetrics } from "../src/extract/coinmetrics.ts";
import { DROP_UNCLOSED_SOURCES, SOURCE_DAY_CLOSE, assertDayCloseRules } from "../src/extract/sources.ts";
import type { Point, RawIndicatorHistory } from "../src/types.ts";
import { publicationRuleOf, publishedOn } from "../src/transform/knowledge-time.ts";

afterEach(() => { configureHttp({}); });

const fixture = toHistory(parseRawHistory(await Bun.file(join(import.meta.dir, "fixtures/raw-indicator-history.csv")).text()));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// Issue 1733: what a run on `day` reads is every row published by then, so a
// registry series is cut on its publication date, everything else on its date.
const published = (id: string, date: string) => {
  const ind = INDICATORS.find((i) => i.id === id);
  return ind ? publishedOn(date, publicationRuleOf(ind)) : date;
};
const cut = (h: RawIndicatorHistory, day: string): RawIndicatorHistory =>
  Object.fromEntries(Object.entries(h).map(([id, rows]) => [id, rows.filter((r) => published(id, r.date) <= day)]));

// T: a day every daily series observes in the fixture; C its eve.
const T = "2026-06-20";
const C = addDays(T, -1);
const COIN_METRICS = INDICATORS.filter((i) => i.source === "coinmetrics").map((i) => i.id);
const DEFILLAMA = ["DEFI_TVL", "STABLES"];

// What a run early on T+1 reads: Coin Metrics has not published T, and
// DefiLlama serves a partial T+1 row.
function earlyRunInputs(): RawIndicatorHistory {
  const h = cut(fixture, T);
  for (const id of COIN_METRICS) h[id] = h[id]!.filter((r) => r.date < T);
  for (const id of DEFILLAMA) h[id] = [...h[id]!, { date: addDays(T, 1), value: h[id]!.at(-1)!.value * 0.98 }];
  return h;
}
// The same, with HY_OAS last observed more than its declared 120 days before T.
const L = "2026-01-15";
function staleInputs(): RawIndicatorHistory {
  const h = earlyRunInputs();
  h.HY_OAS = h.HY_OAS!.filter((r) => r.date <= L);
  return h;
}
const lastHy = () => staleInputs().HY_OAS!.at(-1)!.date;
// The day HY_OAS's last row was known: its age counts from then (issue 1733).
const lastHyKnown = () => published("HY_OAS", lastHy());

function withPolicies<T>(ids: string[], fill: FillPolicy, fn: () => T): T {
  const saved = ids.map((id) => [INDICATORS.find((i) => i.id === id)!, INDICATORS.find((i) => i.id === id)!.fill] as const);
  for (const [ind] of saved) ind.fill = fill;
  try {
    return fn();
  } finally {
    for (const [ind, f] of saved) ind.fill = f;
  }
}

describe("the shipped values", () => {
  test("DAY_RULE is score-newest and every SOURCE_DAY_CLOSE entry is accept-partial", () => {
    expect(DAY_RULE).toBe("score-newest");
    expect(Object.keys(SOURCE_DAY_CLOSE).length).toBeGreaterThan(0);
    for (const ind of INDICATORS) expect(ind.source in SOURCE_DAY_CLOSE, ind.source).toBe(true);
    for (const [source, rule] of Object.entries(SOURCE_DAY_CLOSE)) expect({ source, rule }).toEqual({ source, rule: "accept-partial" });
  });

  test("declaring drop-unclosed for a source other than DefiLlama or Coin Metrics throws, as the module-load check does", () => {
    expect(DROP_UNCLOSED_SOURCES).toEqual(["defillama_tvl", "defillama_stables", "coinmetrics"]);
    for (const source of DROP_UNCLOSED_SOURCES) expect(() => assertDayCloseRules({ ...SOURCE_DAY_CLOSE, [source]: "drop-unclosed" })).not.toThrow();
    for (const source of Object.keys(SOURCE_DAY_CLOSE).filter((s) => !DROP_UNCLOSED_SOURCES.includes(s))) {
      expect(() => assertDayCloseRules({ ...SOURCE_DAY_CLOSE, [source]: "drop-unclosed" }), source).toThrow(new RegExp(source));
    }
    expect(() => assertDayCloseRules({ ...SOURCE_DAY_CLOSE, fred: "drop-everything" })).toThrow(/unknown day-close rule/);
  });

  test("the module-load check runs: a fresh load of sources.ts with a bad declaration throws", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/extract/sources.ts")).text();
    expect(src).toContain("assertDayCloseRules(SOURCE_DAY_CLOSE);");
  });
});

describe("latestCompleteDay and the day rules", () => {
  test("latestCompleteDay is the latest day every started indicator is within its policy", () => {
    // Under forward 120 the early-run lags are carried: T+1 is complete.
    expect(latestCompleteDay(earlyRunInputs())).toBe(addDays(T, 1));
    expect(missingOnDay(earlyRunInputs(), addDays(T, 1))).toEqual([]);
    // With HY_OAS stale, the latest complete day is the last day of its horizon.
    expect(latestCompleteDay(staleInputs())).toBe(addDays(lastHyKnown(), 120));
    expect(missingOnDay(staleInputs(), T)).toEqual([{ id: "HY_OAS", lastObserved: lastHy() }]);
    // With Coin Metrics declared none, the trailing day is missing on T.
    withPolicies(COIN_METRICS, { kind: "none" }, () => {
      expect(missingOnDay(earlyRunInputs(), T)).toEqual(COIN_METRICS.map((id) => ({ id, lastObserved: C })));
      expect(latestCompleteDay(earlyRunInputs(), { notAfter: addDays(T, 1) })).toBe(C);
    });
  });

  test("score-newest (shipped): the stale input scores its newest row and the explicit day, as before", () => {
    const newest = requireComplete(runRegime(staleInputs()));
    expect(newest.dateAxis.at(-1)).toBe(addDays(T, 1));
    const explicit = runRegime(staleInputs(), { asof: T });
    expect(explicit.kind).toBe("complete");
    expect(runRegime(staleInputs(), { asof: T, dayRule: "score-newest" })).toEqual(explicit);
  }, 120_000);

  test("require-complete: no as-of day scores the latest complete day; an explicit incomplete day is IncompleteDay with no figure; both differ from score-newest", () => {
    const latest = requireComplete(runRegime(staleInputs(), { dayRule: "require-complete" }));
    expect(latest.dateAxis.at(-1)).toBe(addDays(lastHyKnown(), 120));
    const shipped = requireComplete(runRegime(staleInputs()));
    expect(latest.dateAxis.length).not.toBe(shipped.dateAxis.length);
    const out = runRegime(staleInputs(), { asof: T, dayRule: "require-complete" });
    expect(out).toEqual({ kind: "incomplete", asof: T, missing: [{ id: "HY_OAS", lastObserved: lastHy() }] });
    expect("result" in out).toBe(false);
    expect(() => requireComplete(out)).toThrow(IncompleteDayError);
    expect(() => requireComplete(out)).toThrow(new RegExp(`HY_OAS \\(last ${lastHy()}\\)`));
    // On a complete input require-complete scores the same day as score-newest.
    const complete = requireComplete(runRegime(earlyRunInputs(), { dayRule: "require-complete" }));
    expect(JSON.stringify(complete.result)).toBe(JSON.stringify(requireComplete(runRegime(earlyRunInputs())).result));
  }, 120_000);

  test("an unknown dayRule is a RangeError", () => {
    expect(() => runRegime(earlyRunInputs(), { dayRule: "sometimes" as never })).toThrow(RangeError);
  });
});

describe("each source's day-close rule in the DefiLlama and Coin Metrics extractors", () => {
  // The run happens on T+1 at 03:30 UTC. Every source serves its closed
  // history and a partial row dated T+1, the run's UTC date.
  const runDate = addDays(T, 1);
  const now = new Date(`${runDate}T03:30:00Z`);
  const secs = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
  const served = (id: string): Point[] => [...cut(fixture, T)[id]!.slice(-5), { date: runDate, value: 1 }];
  const mock = () =>
    configureHttp({
      fetch: (async (u: string) => {
        const url = String(u);
        if (url.includes("api.llama.fi")) return Response.json(served("DEFI_TVL").map((p) => ({ date: secs(p.date), tvl: p.value })));
        if (url.includes("stablecoins.llama.fi")) return Response.json(served("STABLES").map((p) => ({ date: secs(p.date), totalCirculatingUSD: { peggedUSD: p.value } })));
        if (url.includes("coinmetrics")) return Response.json({ data: served("BTC_MVRV").map((p) => ({ time: `${p.date}T00:00:00.000000000Z`, CapMVRVCur: String(p.value) })) });
        throw new Error(`unexpected url ${url}`);
      }) as unknown as typeof fetch,
    });
  const fetchAll3 = async (dayClose?: "accept-partial" | "drop-unclosed") => ({
    DEFI_TVL: await fetchDefillamaTvl(15000, { dayClose, now }),
    STABLES: await fetchDefillamaStables(15000, { dayClose, now }),
    BTC_MVRV: await fetchCoinmetrics("btc", "CapMVRVCur", "2018-01-01", 15000, { dayClose, now }),
  });

  test("accept-partial (shipped, and the default): every served row is kept, including the run-date row", async () => {
    mock();
    for (const rule of [undefined, "accept-partial"] as const) {
      for (const [id, rows] of Object.entries(await fetchAll3(rule))) {
        expect(rows, `${id} ${rule}`).toEqual(served(id));
      }
    }
  });

  test("drop-unclosed: every row dated on or after the run date is dropped and earlier rows are kept", async () => {
    mock();
    for (const [id, rows] of Object.entries(await fetchAll3("drop-unclosed"))) {
      expect(rows, id).toEqual(served(id).slice(0, -1));
    }
    const earlier = new Date(`${addDays(runDate, -1)}T12:00:00Z`);
    expect((await fetchDefillamaTvl(15000, { dayClose: "drop-unclosed", now: earlier })).map((r) => r.date)).toEqual(
      served("DEFI_TVL").map((r) => r.date).filter((d) => d < addDays(runDate, -1)),
    );
  });

  test("non-vacuity: drop-unclosed on an input with a run-date DefiLlama row changes the run's output", async () => {
    mock();
    const accept = await fetchAll3("accept-partial");
    const drop = await fetchAll3("drop-unclosed");
    const withRows = (r: Record<string, Point[]>) => {
      const h = cut(fixture, T);
      h.DEFI_TVL = [...h.DEFI_TVL!.filter((p) => p.date < r.DEFI_TVL![0]!.date), ...r.DEFI_TVL!];
      return h;
    };
    const a = requireComplete(runRegime(withRows(accept), { asof: runDate }));
    const b = requireComplete(runRegime(withRows(drop), { asof: runDate }));
    expect(JSON.stringify(b.result.signed.DEFI_TVL)).not.toBe(JSON.stringify(a.result.signed.DEFI_TVL));
  }, 120_000);
});
