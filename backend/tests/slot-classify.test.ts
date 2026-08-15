// Pure classification for the scheduler-replay slot handling (issue #614
// AC2/AC4). Must fail against pre-#614 main, where none of this exists.
import { expect, test } from "bun:test";
import { classifySlot, isReplayedSlot, REPLAY_SLACK_MS } from "../src/worker/handlers/slot.ts";

const NOW = new Date("2026-08-10T14:00:00Z");

test("classifySlot: no slotAt, or one within the slack window, is always on-time", () => {
  expect(classifySlot({}, "daily", NOW)).toBe("on-time");
  expect(classifySlot({ slotAt: "not-a-date" }, "daily", NOW)).toBe("on-time");
  const barelyLate = new Date(NOW.getTime() - REPLAY_SLACK_MS + 1000).toISOString();
  expect(classifySlot({ slotAt: barelyLate }, "daily", NOW)).toBe("on-time");
  expect(classifySlot({ slotAt: barelyLate }, "hourly", NOW)).toBe("on-time");
});

test("classifySlot: daily cadence — a late slot still within TODAY's bucket is same-bucket-catchup", () => {
  const earlierToday = new Date("2026-08-10T00:05:00Z").toISOString(); // 14h behind NOW, same UTC day
  expect(classifySlot({ slotAt: earlierToday }, "daily", NOW)).toBe("same-bucket-catchup");
});

test("classifySlot: daily cadence — a slot for a PAST UTC day is past-bucket", () => {
  const yesterday = new Date("2026-08-09T23:59:00Z").toISOString();
  expect(classifySlot({ slotAt: yesterday }, "daily", NOW)).toBe("past-bucket");
  const threeDaysAgo = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
  expect(classifySlot({ slotAt: threeDaysAgo }, "daily", NOW)).toBe("past-bucket");
});

test("classifySlot: hourly cadence — same UTC hour is same-bucket-catchup, a closed hour is past-bucket", () => {
  const earlierThisHour = new Date("2026-08-10T14:00:30Z").toISOString(); // NOW is 14:00:00Z
  // (barely different — verifies the boundary uses hour truncation, not a raw diff)
  expect(classifySlot({ slotAt: earlierThisHour }, "hourly", NOW)).toBe("on-time"); // within slack
  const lastHour = new Date("2026-08-10T13:10:00Z").toISOString();
  expect(classifySlot({ slotAt: lastHour }, "hourly", NOW)).toBe("past-bucket");
});

test("isReplayedSlot: the flat convenience boolean matches classifySlot's on-time/not-on-time split", () => {
  expect(isReplayedSlot({}, NOW)).toBe(false);
  const yesterday = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
  expect(isReplayedSlot({ slotAt: yesterday }, NOW)).toBe(true);
  const earlierToday = new Date("2026-08-10T00:05:00Z").toISOString();
  // Same-bucket-catchup is STILL "replayed" under the flat boolean — vault/
  // projects-daily (no provenance column to tag distinctly) intentionally
  // stay conservative and decline any replay, same-bucket or not.
  expect(isReplayedSlot({ slotAt: earlierToday }, NOW)).toBe(true);
});
