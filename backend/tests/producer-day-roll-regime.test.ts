// Issue 1108: the brief reads the latest SAVED regime, so an epoch opened just
// after 00:00 UTC briefed yesterday until the first :30 run. The producer fires
// one regime run a few seconds after each UTC midnight and writes nothing at boot.
import { expect, test } from "bun:test";
import { fireDayRollRegime, msUntilDayRoll, startProducerSchedules } from "../src/producer/index.ts";
import { writeTokenFile } from "./support/automation-auth.ts";

test("the day-roll fire is due before an epoch opened at 00:05 UTC", () => {
  const justBeforeMidnight = new Date("2026-10-03T23:59:50Z");
  const fireAt = justBeforeMidnight.getTime() + msUntilDayRoll(justBeforeMidnight);
  expect(new Date(fireAt).toISOString()).toBe("2026-10-04T00:00:05.000Z");
  expect(fireAt).toBeLessThan(Date.parse("2026-10-04T00:05:00Z"));
});

test("the fire at 00:00:05 UTC saves that day's regime, not yesterday's", async () => {
  const calls: string[] = [];
  const asof = await fireDayRollRegime(new Date("2026-10-04T00:00:05Z"), {
    run: async (kind, day) => { calls.push(`${kind}:${day}`); },
  });
  expect(asof).toBe("2026-10-04");
  expect(calls).toEqual(["regime:2026-10-04"]);
});

test("a failed fire does not throw", async () => {
  await fireDayRollRegime(new Date("2026-10-04T00:00:05Z"), { run: async () => { throw new Error("x"); } });
});

test("boot arms the day-roll and runs no regime write", async () => {
  const order: string[] = [];
  await startProducerSchedules({
    env: { ANALYTICS_API_URL: "http://unused:1", ANALYTICS_TOKEN_FILE: writeTokenFile("t") },
    beat: async () => {},
    waitUntilReady: async () => {},
    catchUp: async () => {},
    catchUpIndicators: async () => {},
    scheduleKind: (kind) => { order.push(`armed:${kind}`); },
    scheduleDayRoll: () => { order.push("armed:day-roll"); },
  });
  expect(order).toEqual(["armed:regime", "armed:research", "armed:day-roll"]);
});
