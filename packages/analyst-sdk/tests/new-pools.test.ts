// Issue 1654: NEW_TOKENS from stored pool records. newPoolDailyCounts counts
// unique pools per gap-free UTC day, resolveIndicatorSources reads each
// indicator from its declared value source, and the corrected input reaches
// the score exactly as the rank and weight rules say.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  INDICATORS,
  assertValueSources,
  newPoolCoverage,
  newPoolDailyCounts,
  parseRawHistory,
  requireComplete,
  resolveIndicatorSources,
  runRegime as runRegimeOutcome,
  toHistory,
  type Indicator,
  type NewPoolDayTally,
  type NewPoolPoll,
  type NewPoolRecord,
  type RawIndicatorHistory,
} from "../src/index.ts";
import { NEW_POOL_RECORDS_STORAGE_KEY, inputHistoryFromStorage } from "../src/series-ids.ts";

setDefaultTimeout(180_000);
const runRegime = (...a: Parameters<typeof runRegimeOutcome>) => requireComplete(runRegimeOutcome(...a));

const pool = (id: string, createdAt: string, knowledgeTime?: string): NewPoolRecord => ({ id, network: id.split("_")[0]!, createdAt, ...(knowledgeTime ? { knowledgeTime } : {}) });
const poll = (oldestCreatedAt: string, newestCreatedAt: string, knowledgeTime?: string): NewPoolPoll => ({ oldestCreatedAt, newestCreatedAt, ...(knowledgeTime ? { knowledgeTime } : {}) });

// Overlapping polls from 2026-11-01 23:50 to 2026-11-04 00:10, one gap on
// 2026-11-03 (12:00 to 12:30): only 2026-11-02 is gap-free and closed.
const POLLS: NewPoolPoll[] = [
  poll("2026-11-01T23:50:00Z", "2026-11-02T06:00:00Z"),
  poll("2026-11-02T05:59:00Z", "2026-11-02T18:00:00Z"),
  poll("2026-11-02T18:00:00Z", "2026-11-03T12:00:00Z"), // touches the previous newest: overlap
  poll("2026-11-03T12:30:00Z", "2026-11-04T00:10:00Z"), // after the previous newest: a gap
];
const POOLS: NewPoolRecord[] = [
  pool("solana_a", "2026-11-01T23:55:00Z"),
  pool("solana_b", "2026-11-02T00:00:00Z"),
  pool("base_c", "2026-11-02T05:59:30Z"),
  pool("base_c", "2026-11-02T05:59:30Z"), // seen by two polls
  pool("eth_d", "2026-11-02T23:59:59Z"),
  pool("eth_e", "2026-11-03T00:00:00Z"),
  pool("eth_f", "2026-11-03T13:00:00Z"),
];

describe("newPoolDailyCounts", () => {
  test("for each gap-free UTC day, the number of unique pool ids created that day; a pool seen by two polls counts once", () => {
    expect(newPoolDailyCounts({ pools: POOLS, polls: POLLS })).toEqual([{ date: "2026-11-02", value: 3 }]);
    // A longer gap-free run: every covered day counts, an empty covered day is a real 0.
    const polls = [poll("2026-11-01T00:00:00Z", "2026-11-02T12:00:00Z"), poll("2026-11-02T11:00:00Z", "2026-11-04T00:00:00Z")];
    const pools = [pool("x_1", "2026-11-01T01:00:00Z"), pool("x_2", "2026-11-01T02:00:00Z"), pool("x_2", "2026-11-01T02:00:00Z"), pool("x_3", "2026-11-03T09:00:00Z")];
    expect(newPoolDailyCounts({ pools, polls })).toEqual([
      { date: "2026-11-01", value: 2 },
      { date: "2026-11-02", value: 0 },
      { date: "2026-11-03", value: 1 },
    ]);
  });

  test("no point for a day a gap touches, for the day before coverage starts, or for a day whose end is not yet covered; never a 0 for such a day", () => {
    const days = newPoolDailyCounts({ pools: POOLS, polls: POLLS }).map((p) => p.date);
    expect(days).not.toContain("2026-11-01"); // coverage starts 23:50, after its 00:00
    expect(days).not.toContain("2026-11-03"); // the 12:00 to 12:30 gap
    expect(days).not.toContain("2026-11-04"); // not closed: coverage ends 00:10
    // The open last day: coverage up to 23:59 does not close the day.
    const open = newPoolDailyCounts({ pools: [pool("x_1", "2026-11-01T05:00:00Z")], polls: [poll("2026-10-31T23:00:00Z", "2026-11-01T23:59:59Z")] });
    expect(open).toEqual([]);
    // No polls, no readings, whatever the pools.
    expect(newPoolDailyCounts({ pools: POOLS, polls: [] })).toEqual([]);
  });

  test("day tallies from the store give the same counts as the records", () => {
    const tallies: NewPoolDayTally[] = [{ date: "2026-11-01", pools: 1 }, { date: "2026-11-02", pools: 3 }, { date: "2026-11-03", pools: 2 }];
    expect(newPoolDailyCounts({ dayTallies: tallies, polls: POLLS })).toEqual(newPoolDailyCounts({ pools: POOLS, polls: POLLS }));
  });

  test("the coverage gaps are the spans between polls that do not overlap", () => {
    const { spans, gaps } = newPoolCoverage(POLLS);
    expect(gaps).toEqual([{ from: "2026-11-03T12:00:00.000Z", to: "2026-11-03T12:30:00.000Z" }]);
    expect(spans).toEqual([
      { from: "2026-11-01T23:50:00.000Z", to: "2026-11-03T12:00:00.000Z" },
      { from: "2026-11-03T12:30:00.000Z", to: "2026-11-04T00:10:00.000Z" },
    ]);
  });
});

describe("value sources", () => {
  test("NEW_TOKENS declares new_pool_records; new_pool_records or legacy_count on another source throws", () => {
    expect(INDICATORS.find((i) => i.id === "NEW_TOKENS")!.valueSource).toBe("new_pool_records");
    expect(INDICATORS.filter((i) => i.valueSource !== undefined).map((i) => i.id)).toEqual(["NEW_TOKENS"]);
    const vix = INDICATORS.find((i) => i.id === "VIX")!;
    for (const vs of ["new_pool_records", "legacy_count"] as const) {
      expect(() => assertValueSources([{ ...vix, valueSource: vs }])).toThrow(/allowed only on an indicator whose source is geckoterminal_newpools/);
      expect(() => resolveIndicatorSources({}, { indicators: [{ ...vix, valueSource: vs }] })).toThrow(/VIX/);
    }
    expect(() => assertValueSources([{ ...vix, valueSource: "bogus" as never }])).toThrow(/unknown valueSource/);
    expect(() => assertValueSources(INDICATORS)).not.toThrow();
  });

  test("the module-load check runs: a fresh load of the registry with a bad declaration throws", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/analyze/indicators.ts")).text();
    const bad = src.replace('id: "VIX",', 'id: "VIX",\n    valueSource: "legacy_count",');
    expect(bad).not.toBe(src);
    // The registry imports only a type, so a copy loads from anywhere.
    const path = join(import.meta.dir, `.indicators-bad-${process.pid}.ts`);
    await Bun.write(path, bad);
    try {
      await expect(import(path)).rejects.toThrow(/VIX: valueSource legacy_count is allowed only/);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("resolveIndicatorSources replaces NEW_TOKENS with the count of the records known at the cutoff; without newPools it returns the input rows unchanged", () => {
    const legacy = [{ date: "2026-11-02", value: 200 }];
    const raw: RawIndicatorHistory = { NEW_TOKENS: legacy, VIX: [{ date: "2026-11-02", value: 20 }] };
    // Without newPools: the input as given (the replay contract).
    const asGiven = resolveIndicatorSources(raw);
    expect(asGiven).toBe(raw);
    expect(asGiven.NEW_TOKENS).toBe(legacy);
    // With newPools: the daily count, and nothing else changes.
    const known = POOLS.map((p) => ({ ...p, knowledgeTime: "2026-11-04T01:00:00Z" }));
    const late = [pool("late_1", "2026-11-02T10:00:00Z", "2026-11-04T03:00:00Z"), pool("late_2", "2026-11-02T11:00:00Z", "2026-11-04T03:00:00.000001Z")];
    const polls = POLLS.map((p) => ({ ...p, knowledgeTime: "2026-11-04T01:00:00Z" }));
    const out = resolveIndicatorSources(raw, { newPools: { pools: [...known, ...late], polls, knowledgeTimeCutoff: "2026-11-04T02:00:00Z" } });
    expect(out.NEW_TOKENS).toEqual([{ date: "2026-11-02", value: 3 }]);
    expect(out.VIX).toBe(raw.VIX);
    expect(raw.NEW_TOKENS).toBe(legacy); // never mutated
    // After the cutoff moves past the late records, they count.
    const later = resolveIndicatorSources(raw, { newPools: { pools: [...known, ...late], polls, knowledgeTimeCutoff: "2026-11-04T04:00:00Z" } });
    expect(later.NEW_TOKENS).toEqual([{ date: "2026-11-02", value: 5 }]);
    // legacy_count keeps the legacy rows even when newPools is given.
    const legacyRegistry = INDICATORS.map((i) => (i.id === "NEW_TOKENS" ? { ...i, valueSource: "legacy_count" as const } : i));
    expect(resolveIndicatorSources(raw, { indicators: legacyRegistry, newPools: { pools: known, polls } }).NEW_TOKENS).toBe(legacy);
  });

  test("a vintage's new_pool_records:NEW_TOKENS rows are the NEW_TOKENS input, and replace any raw_indicator_history:NEW_TOKENS row", () => {
    const counted = inputHistoryFromStorage([
      { sourceKey: NEW_POOL_RECORDS_STORAGE_KEY, marketDate: "2026-11-02", value: 70_000 },
      { sourceKey: "raw_indicator_history:NEW_TOKENS", marketDate: "2026-11-02", value: 200 },
      { sourceKey: "raw_indicator_history:NEW_TOKENS", marketDate: "2026-11-01", value: 200 },
    ]);
    expect(counted.NEW_TOKENS).toEqual([{ date: "2026-11-02", value: 70_000 }]);
    const legacy = inputHistoryFromStorage([{ sourceKey: "raw_indicator_history:NEW_TOKENS", marketDate: "2026-11-01", value: 200 }]);
    expect(legacy.NEW_TOKENS).toEqual([{ date: "2026-11-01", value: 200 }]);
  });
});

// ── The corrected input through the score ────────────────────────────────────
const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const csv = await Bun.file(join(import.meta.dir, "fixtures/raw-indicator-history.csv")).text();
const FIXTURE = toHistory(parseRawHistory(csv));
const ASOF = "2026-08-15";
// Pool records whose counts start on day K and run to ASOF - 1 (ASOF itself is
// not closed): a deterministic, varying daily count, as day tallies.
const K = addDays(ASOF, -150);
function newPoolsFrom(start: string, end: string) {
  const dayTallies: NewPoolDayTally[] = [];
  for (let d = start, i = 0; d <= end; d = addDays(d, 1), i++) dayTallies.push({ date: d, pools: 60_000 + ((i * 7919) % 13_000) });
  return { dayTallies, polls: [poll(`${start}T00:00:00Z`, `${addDays(end, 1)}T00:00:00Z`)] };
}
const NEW_POOLS = newPoolsFrom(K, addDays(ASOF, -1));

describe("the pool-record count through the score", () => {
  test("NEW_TOKENS has a NaN rank before its 30th day with a value, weight 0 at every refresh with fewer than 60 finite ranks, and the on-chain index is then the weighted mean of the other inputs", () => {
    // The fixture's capped rows are not read: newPools replaces them.
    expect(FIXTURE.NEW_TOKENS!.length).toBeGreaterThan(0);
    const checks = [29, 30, 45, 88, 89, 120];
    for (const n of checks) {
      // Run to the day with the n-th value (day K is the first, so K + n - 1).
      const asof = addDays(K, n - 1);
      const run = runRegime(FIXTURE, { asof, newPools: NEW_POOLS });
      const last = run.dateAxis.length - 1;
      const k = run.dateAxis.indexOf(K);
      expect(k).toBeGreaterThan(0);
      const rank = run.result.ranks.NEW_TOKENS!;
      // Before day K the count has no reading: no rank (the forward fill carries nothing).
      for (let i = 0; i < k; i++) expect(Number.isNaN(rank[i]!)).toBe(true);
      // A rank needs 30 finite values in the window: the 30th day with a value is K + 29.
      for (let i = k; i <= last; i++) expect({ i: i - k, finite: Number.isFinite(rank[i]!) }).toEqual({ i: i - k, finite: i - k >= 29 });
      const finiteRanks = rank.filter((v) => Number.isFinite(v)).length;
      const w = run.result.weightsByPanel.onchain!.NEW_TOKENS!;
      if (finiteRanks < 60) {
        expect({ n, finiteRanks, w }).toEqual({ n, finiteRanks, w: 0 });
        // The on-chain index is the weighted mean of the other inputs.
        const weights = run.result.weightsByPanel.onchain!;
        let num = 0;
        let den = 0;
        for (const ind of INDICATORS.filter((x) => x.panel === "onchain" && x.id !== "NEW_TOKENS")) {
          const v = run.result.signed[ind.id]![last]!;
          const wi = weights[ind.id]!;
          if (!Number.isFinite(v) || !Number.isFinite(wi)) continue;
          num += wi * v;
          den += wi;
        }
        expect(run.result.panelIndices.onchain![last]!).toBeCloseTo(num / den, 12);
      } else {
        expect({ n, finiteRanks, positive: w > 0 }).toEqual({ n, finiteRanks, positive: true });
      }
    }
  });

  test("non-vacuity: on the same input with newPools given, valueSource legacy_count gives another NEW_TOKENS series and another composite", () => {
    const declared = runRegime(FIXTURE, { asof: ASOF, newPools: NEW_POOLS });
    const legacyRegistry: Indicator[] = INDICATORS.map((i) => (i.id === "NEW_TOKENS" ? { ...i, valueSource: "legacy_count" as const } : i));
    const legacy = runRegime(FIXTURE, { asof: ASOF, newPools: NEW_POOLS, indicators: legacyRegistry });
    const last = declared.dateAxis.length - 1;
    expect(declared.result.ranks.NEW_TOKENS).not.toEqual(legacy.result.ranks.NEW_TOKENS);
    expect(declared.result.weightsByPanel.onchain!.NEW_TOKENS).toBeGreaterThan(0);
    expect(declared.result.composite[last]).not.toBe(legacy.result.composite[last]);
    // legacy_count is the input as given: the same run as one with no newPools.
    const asGiven = runRegime(FIXTURE, { asof: ASOF });
    expect(legacy.result.composite).toEqual(asGiven.result.composite);
  });
});
