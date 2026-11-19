// Issue 1654: the producer arms the new-pools collector, a separate collection
// job on a fixed 60 s timer, only when the analytics source is live. The
// regime and research crons and the day-roll fire are unchanged, and a tick
// during a running poll starts no second poll.
import { afterEach, expect, test } from "bun:test";
import { armNewPoolsCollector, resetProducerSchedules, startProducerSchedules } from "../src/producer/index.ts";
import { NEW_POOLS_INTERVAL_MS, newPoolsTicker } from "../src/analytics/new-pools-collector.ts";
import { writeTokenFile } from "./support/automation-auth.ts";

const realSource = process.env.ANALYTICS_SOURCE;
afterEach(() => {
  resetProducerSchedules();
  if (realSource === undefined) delete process.env.ANALYTICS_SOURCE;
  else process.env.ANALYTICS_SOURCE = realSource;
});

async function boot(env: Record<string, string | undefined>) {
  const order: string[] = [];
  await startProducerSchedules({
    env: { ANALYTICS_API_URL: "http://unused:1", ANALYTICS_TOKEN_FILE: writeTokenFile("t"), PRODUCER_REGIME_CRON: "30 22 * * *", PRODUCER_RESEARCH_CRON: "0 23 * * *", ...env },
    beat: async () => {},
    waitUntilReady: async () => {},
    catchUp: async () => {},
    catchUpIndicators: async () => {},
    scheduleKind: (kind, cron) => { order.push(`armed:${kind}:${cron}`); },
    scheduleDayRoll: () => { order.push("armed:day-roll"); },
    scheduleNewPools: (ms) => { order.push(`armed:new-pools:${ms}`); },
  });
  return order;
}

test("with ANALYTICS_SOURCE unset the collector is armed at a 60 s interval, and the regime and research crons are unchanged", async () => {
  delete process.env.ANALYTICS_SOURCE;
  expect(NEW_POOLS_INTERVAL_MS).toBe(60_000);
  expect(await boot({})).toEqual(["armed:regime:30 22 * * *", "armed:research:0 23 * * *", "armed:day-roll", "armed:new-pools:60000"]);
  // "live" is the same as unset.
  expect(await boot({ ANALYTICS_SOURCE: "live" })).toContain("armed:new-pools:60000");
});

test("with ANALYTICS_SOURCE=hermetic the collector is not armed", async () => {
  expect(await boot({ ANALYTICS_SOURCE: "hermetic" })).toEqual(["armed:regime:30 22 * * *", "armed:research:0 23 * * *", "armed:day-roll"]);
  process.env.ANALYTICS_SOURCE = "hermetic";
  expect(await boot({})).not.toContain("armed:new-pools:60000");
});

test("the armed timer ticks every 60 s from the start of the previous tick, and a tick during a running poll starts no second poll", async () => {
  let intervalMs = 0;
  let fire!: () => void;
  let polls = 0;
  let release!: () => void;
  const ticker = newPoolsTicker(async () => {
    polls++;
    await new Promise<void>((r) => { release = r; });
  }, {
    logger: { warn: () => {} },
    setInterval: ((fn: () => void, ms: number) => { fire = fn; intervalMs = ms; return 1; }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
  });
  expect(intervalMs).toBe(60_000);
  fire();
  fire(); // the next tick comes while the first poll still runs
  expect(polls).toBe(1);
  release();
  await ticker.idle();
  fire();
  expect(polls).toBe(2);
  release();
  await ticker.idle();
  ticker.stop();
  // The production arm wires the same ticker, and resetProducerSchedules stops it.
  armNewPoolsCollector({ baseUrl: "http://unused:1", token: "t" });
});
