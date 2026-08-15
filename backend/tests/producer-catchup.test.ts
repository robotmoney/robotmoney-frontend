// The independent analytics producer's catch-up mechanism (issue #614 AC4).
// Must fail against pre-#614 main, where none of these exports exist at all:
// "The producer has no catch-up at all — producer/index.ts:132-148 computes
// `next` from `new Date()`, fires, re-arms. Miss 22:30 and that day never
// runs."
import { expect, test } from "bun:test";
import type { AnalyticsPersistence } from "../src/analytics/persistence.ts";
import { RESEARCH_SIGNAL_TELEMETRY_KEYS } from "../src/analytics/index.ts";
import {
  computeMissingResearchDays,
  catchUpMissedResearchDays,
  startProducerSchedules,
} from "../src/producer/index.ts";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-10T12:00:00Z");
const iso = (offsetDays: number) => new Date(NOW.getTime() - offsetDays * DAY_MS).toISOString().slice(0, 10);

test("computeMissingResearchDays: a fully-populated window reports nothing missing", () => {
  const present: { signalKey: string; date: string }[] = [];
  for (let i = 1; i <= 14; i++) {
    for (const key of RESEARCH_SIGNAL_TELEMETRY_KEYS) present.push({ signalKey: key, date: iso(i) });
  }
  expect(computeMissingResearchDays(present, NOW)).toEqual([]);
});

test("computeMissingResearchDays: a day with ZERO signals is missing", () => {
  const present: { signalKey: string; date: string }[] = [];
  for (let i = 1; i <= 14; i++) {
    if (i === 5) continue; // the hole — a producer restart missed this day entirely
    for (const key of RESEARCH_SIGNAL_TELEMETRY_KEYS) present.push({ signalKey: key, date: iso(i) });
  }
  expect(computeMissingResearchDays(present, NOW)).toEqual([iso(5)]);
});

// This is the case that makes "a degraded EDGAR refresh is retry-later, not
// success" real: a degraded day writes channel-divergence but SKIPS
// late-cycle-signals (analytics/index.ts's deliberate skip). The date-level
// row for that day is therefore INCOMPLETE, not absent — the detector must
// still flag it.
test("computeMissingResearchDays: a day with only ONE of the two signals (a degraded EDGAR day) is still missing", () => {
  const present: { signalKey: string; date: string }[] = [];
  for (let i = 1; i <= 14; i++) {
    present.push({ signalKey: "channel-divergence", date: iso(i) });
    if (i !== 3) present.push({ signalKey: "late-cycle-signals", date: iso(i) }); // day 3 degraded
  }
  expect(computeMissingResearchDays(present, NOW)).toEqual([iso(3)]);
});

test("computeMissingResearchDays: today is never included — the normal cron owns today", () => {
  const present = RESEARCH_SIGNAL_TELEMETRY_KEYS.map((key) => ({ signalKey: key, date: iso(0) }));
  // Nothing else present at all — every day in the window except today is missing.
  const missing = computeMissingResearchDays(present, NOW);
  expect(missing).not.toContain(iso(0));
  expect(missing.length).toBe(14);
});

test("catchUpMissedResearchDays: repairs exactly the missing days via the injected runner, oldest first", () => {
  const present = [
    { signalKey: "channel-divergence", date: iso(2) },
    { signalKey: "late-cycle-signals", date: iso(2) },
  ];
  const persistence: AnalyticsPersistence = {
    loadRawHistory: async () => ({}),
    saveRawHistory: async () => {},
    seedRawHistory: async () => ({ seededPoints: 0, existingPoints: 0, indicators: 0 }),
    saveRegimeSnapshots: async () => {},
    saveResearchSignal: async () => {},
    loadResearchSignalDates: async (since) => {
      expect(since).toBe(iso(14));
      return present;
    },
  };
  const repaired: string[] = [];
  const runner = async (asof: string) => {
    repaired.push(asof);
    return { "channel-divergence": true, "late-cycle-signals": true };
  };

  return catchUpMissedResearchDays({ persistence, runner, now: () => NOW }).then((missing) => {
    expect(missing.length).toBe(13); // 14 days back, day 2 is the only one fully present
    expect(missing).not.toContain(iso(2));
    expect(repaired).toEqual(missing); // every reported gap was actually attempted
    // Oldest-first: the window is walked from windowDays down to 1.
    expect(repaired[0]).toBe(iso(14));
    expect(repaired[repaired.length - 1]).toBe(iso(1));
  });
});

test("catchUpMissedResearchDays: a repair failure for one day does not stop the rest, and is reported as still missing", async () => {
  const persistence: AnalyticsPersistence = {
    loadRawHistory: async () => ({}),
    saveRawHistory: async () => {},
    seedRawHistory: async () => ({ seededPoints: 0, existingPoints: 0, indicators: 0 }),
    saveRegimeSnapshots: async () => {},
    saveResearchSignal: async () => {},
    loadResearchSignalDates: async () => [],
  };
  const attempted: string[] = [];
  const runner = async (asof: string) => {
    attempted.push(asof);
    if (asof === iso(7)) throw new Error("forced EDGAR failure");
    return {};
  };
  const missing = await catchUpMissedResearchDays({ persistence, runner, now: () => NOW });
  expect(missing.length).toBe(14); // still reports all 14 as the window's gaps
  expect(attempted.length).toBe(14); // every one was attempted despite day 7 throwing
});

test("catchUpMissedResearchDays: a read failure is swallowed — never throws, returns no missing days", async () => {
  const persistence: AnalyticsPersistence = {
    loadRawHistory: async () => ({}),
    saveRawHistory: async () => {},
    seedRawHistory: async () => ({ seededPoints: 0, existingPoints: 0, indicators: 0 }),
    saveRegimeSnapshots: async () => {},
    saveResearchSignal: async () => {},
    loadResearchSignalDates: async () => { throw new Error("network unreachable"); },
  };
  const missing = await catchUpMissedResearchDays({ persistence, now: () => NOW });
  expect(missing).toEqual([]);
});

// issue #614 AC4: "Repair is idempotent — running it twice changes nothing."
// A stateful in-memory persistence stands in for the real one: the runner
// writes the day it repaired back into the store (mirroring a real research
// run persisting through saveResearchSignal), so the SECOND catch-up pass can
// genuinely observe convergence rather than being told by a mock to find
// nothing.
test("catchUpMissedResearchDays: running it twice converges — the second pass repairs nothing new", async () => {
  const store = new Set<string>(); // "signalKey|date"
  const persistence: AnalyticsPersistence = {
    loadRawHistory: async () => ({}),
    saveRawHistory: async () => {},
    seedRawHistory: async () => ({ seededPoints: 0, existingPoints: 0, indicators: 0 }),
    saveRegimeSnapshots: async () => {},
    saveResearchSignal: async () => {},
    loadResearchSignalDates: async () => [...store].map((s) => {
      const [signalKey, date] = s.split("|") as [string, string];
      return { signalKey, date };
    }),
  };
  const runner = async (asof: string) => {
    for (const key of RESEARCH_SIGNAL_TELEMETRY_KEYS) store.add(`${key}|${asof}`);
    return {};
  };

  const first = await catchUpMissedResearchDays({ persistence, runner, now: () => NOW });
  expect(first.length).toBe(14); // nothing persisted yet — the whole window is missing

  const second = await catchUpMissedResearchDays({ persistence, runner, now: () => NOW });
  expect(second).toEqual([]); // every day the first pass repaired is now genuinely present
});

// Boot-time wiring: startProducerSchedules calls the catch-up hook BEFORE
// arming today's crons (issue #614 AC4 "on boot").
test("startProducerSchedules: runs catch-up before arming the daily crons", async () => {
  const order: string[] = [];
  await startProducerSchedules({
    env: { ANALYTICS_API_URL: "http://unused:1", ANALYTICS_TOKEN: "t" },
    waitUntilReady: async () => { order.push("ready"); },
    catchUp: async () => { order.push("catchup"); },
    scheduleKind: (kind) => { order.push(`armed:${kind}`); },
  });
  expect(order).toEqual(["ready", "catchup", "armed:regime", "armed:research"]);
});
