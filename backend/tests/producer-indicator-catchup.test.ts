// The independent analytics producer's Class A (raw_indicator_history)
// catch-up mechanism (issue #646, closing #614 AC4's Class A bullet: "a
// detected gap triggers a re-fetch that fills only missing keys"). Must fail
// against pre-#646 main, where catchUpMissedIndicatorDays does not exist at
// all — worker/handlers/repair.ts's `unhandled.classA` was the only trace of
// this gap, reported rather than closed.
import { expect, test } from "bun:test";
import type { AnalyticsPersistence, FloorSeedResult } from "../src/analytics/persistence.ts";
import type { AnalyticsDataSource, Logger } from "../src/analytics/access/data-source.ts";
import type { Indicator } from "../src/analytics/analyze/indicators.ts";
import type { Point, RawIndicatorHistory } from "../src/analytics/types.ts";
import { catchUpMissedIndicatorDays, startProducerSchedules } from "../src/producer/index.ts";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-20T12:00:00Z");
const iso = (offsetDays: number) => new Date(NOW.getTime() - offsetDays * DAY_MS).toISOString().slice(0, 10);

function fakePersistence(overrides: Partial<AnalyticsPersistence> = {}): AnalyticsPersistence {
  return {
    loadRawHistory: async () => ({}),
    saveRawHistory: async () => {},
    seedRawHistory: async () => ({ seededPoints: 0, existingPoints: 0, indicators: 0 }),
    saveRegimeSnapshots: async () => {},
    saveResearchSignal: async () => {},
    loadResearchSignalDates: async () => [],
    loadRawHistoryGapDates: async () => [],
    ...overrides,
  };
}

// A minimal registry-shaped fetch source. Only fetchIndicators is ever called
// by catchUpMissedIndicatorDays; the other two members exist only to satisfy
// the AnalyticsDataSource type and throw if this test's assumption is wrong.
function fakeSource(byIndicator: Record<string, Point[]>): AnalyticsDataSource {
  return {
    async fetchIndicators(_indicators: Indicator[], _logger?: Logger) {
      return byIndicator;
    },
    async fetchResearchInputs() {
      throw new Error("catchUpMissedIndicatorDays must never call fetchResearchInputs");
    },
    async fetchBacktestExtras() {
      throw new Error("catchUpMissedIndicatorDays must never call fetchBacktestExtras");
    },
  };
}

test("catchUpMissedIndicatorDays: seedRawHistory receives ONLY points whose date is in the missing set, never the full fetched series", async () => {
  const missing = [iso(5), iso(3)];
  const fetched: Record<string, Point[]> = {
    T10Y2Y: [
      { date: iso(10), value: 1.1 }, // present already — must NOT be written again
      { date: iso(5), value: 1.2 }, // the gap — must be written
      { date: iso(1), value: 1.3 }, // today's ordinary run range — must NOT be written
    ],
    VIX: [
      { date: iso(3), value: 18.4 }, // the other gap — must be written
      { date: iso(0), value: 19.1 },
    ],
  };
  const seededCalls: RawIndicatorHistory[] = [];
  const persistence = fakePersistence({
    loadRawHistoryGapDates: async (since) => {
      expect(since).toBe(iso(14));
      return missing;
    },
    seedRawHistory: async (byIndicator) => {
      seededCalls.push(byIndicator);
      return { seededPoints: 2, existingPoints: 0, indicators: 2 };
    },
  });

  const result = await catchUpMissedIndicatorDays({ persistence, source: fakeSource(fetched), now: () => NOW });

  expect(result).toEqual(missing);
  expect(seededCalls.length).toBe(1); // exactly one gap-fill write, not one per indicator
  expect(seededCalls[0]).toEqual({
    T10Y2Y: [{ date: iso(5), value: 1.2 }],
    VIX: [{ date: iso(3), value: 18.4 }],
  });
});

test("catchUpMissedIndicatorDays: an empty gap list calls neither the fetcher nor seedRawHistory", async () => {
  let fetchCalled = false;
  let seedCalled = false;
  const source: AnalyticsDataSource = {
    async fetchIndicators() { fetchCalled = true; return {}; },
    async fetchResearchInputs() { throw new Error("unused"); },
    async fetchBacktestExtras() { throw new Error("unused"); },
  };
  const persistence = fakePersistence({
    loadRawHistoryGapDates: async () => [],
    seedRawHistory: async (byIndicator) => { seedCalled = true; return { seededPoints: 0, existingPoints: 0, indicators: Object.keys(byIndicator).length }; },
  });

  const result = await catchUpMissedIndicatorDays({ persistence, source, now: () => NOW });

  expect(result).toEqual([]);
  expect(fetchCalled).toBe(false); // avoids double-fetching the registry against the daily regime cron
  expect(seedCalled).toBe(false);
});

test("catchUpMissedIndicatorDays: a missing date the fetch still doesn't cover is simply omitted, never throws", async () => {
  const missing = [iso(7), iso(2)]; // iso(7) has no source coverage this pass
  const fetched: Record<string, Point[]> = {
    T10Y2Y: [{ date: iso(2), value: 1.0 }], // only the second gap is covered
  };
  const seededCalls: RawIndicatorHistory[] = [];
  const persistence = fakePersistence({
    loadRawHistoryGapDates: async () => missing,
    seedRawHistory: async (byIndicator) => {
      seededCalls.push(byIndicator);
      return { seededPoints: 1, existingPoints: 0, indicators: 1 };
    },
  });

  const result = await catchUpMissedIndicatorDays({ persistence, source: fakeSource(fetched), now: () => NOW });

  expect(result).toEqual(missing); // still reports both as attempted — iso(7) is retried next pass
  expect(seededCalls[0]).toEqual({ T10Y2Y: [{ date: iso(2), value: 1.0 }] }); // iso(7) never appears anywhere in the write
});

test("catchUpMissedIndicatorDays: a fetch that covers NONE of the missing dates writes nothing and does not throw", async () => {
  const missing = [iso(6)];
  let seedCalled = false;
  const persistence = fakePersistence({
    loadRawHistoryGapDates: async () => missing,
    seedRawHistory: async () => { seedCalled = true; return { seededPoints: 0, existingPoints: 0, indicators: 0 }; },
  });

  const result = await catchUpMissedIndicatorDays({
    persistence,
    source: fakeSource({ T10Y2Y: [{ date: iso(1), value: 1.0 }] }),
    now: () => NOW,
  });

  expect(result).toEqual(missing);
  expect(seedCalled).toBe(false);
});

test("catchUpMissedIndicatorDays: a gap-read failure is swallowed — never throws, returns no missing days", async () => {
  const persistence = fakePersistence({
    loadRawHistoryGapDates: async () => { throw new Error("network unreachable"); },
  });
  const result = await catchUpMissedIndicatorDays({ persistence, source: fakeSource({}), now: () => NOW });
  expect(result).toEqual([]);
});

test("catchUpMissedIndicatorDays: a registry fetch failure is swallowed — reports the days as still missing, never throws", async () => {
  const missing = [iso(4)];
  const persistence = fakePersistence({ loadRawHistoryGapDates: async () => missing });
  const source: AnalyticsDataSource = {
    async fetchIndicators() { throw new Error("FRED unreachable"); },
    async fetchResearchInputs() { throw new Error("unused"); },
    async fetchBacktestExtras() { throw new Error("unused"); },
  };
  const result = await catchUpMissedIndicatorDays({ persistence, source, now: () => NOW });
  expect(result).toEqual(missing);
});

test("catchUpMissedIndicatorDays: a seed-write failure is swallowed — still reports the attempted days, never throws", async () => {
  const missing = [iso(9)];
  const fetched: Record<string, Point[]> = { T10Y2Y: [{ date: iso(9), value: 1.0 }] };
  const persistence = fakePersistence({
    loadRawHistoryGapDates: async () => missing,
    seedRawHistory: async (): Promise<FloorSeedResult> => { throw new Error("analytics API rejected the seed batch"); },
  });
  const result = await catchUpMissedIndicatorDays({ persistence, source: fakeSource(fetched), now: () => NOW });
  expect(result).toEqual(missing);
});

// Boot-time wiring: startProducerSchedules calls the indicator catch-up hook
// BEFORE arming today's crons, the same "on boot" shape as the research
// catch-up (issue #614 AC4, extended to Class A by #646).
test("startProducerSchedules: runs the indicator catch-up before arming the daily crons", async () => {
  const order: string[] = [];
  await startProducerSchedules({
    env: { ANALYTICS_API_URL: "http://unused:1", ANALYTICS_TOKEN: "t" },
    waitUntilReady: async () => { order.push("ready"); },
    catchUp: async () => { order.push("catchup:research"); },
    catchUpIndicators: async () => { order.push("catchup:indicators"); },
    scheduleKind: (kind) => { order.push(`armed:${kind}`); },
  });
  expect(order).toEqual(["ready", "catchup:research", "catchup:indicators", "armed:regime", "armed:research"]);
});
