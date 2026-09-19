// The window countdown, one definition for /swarm's live strip and the
// session page, so the reader who follows "See full session" reads the same
// time left on both.
import { test, expect } from "bun:test";
import { timeLeft } from "../../../frontend/public/assets/js/app/lib/relative-time.js";

const NOW = Date.parse("2026-09-19T12:00:00Z");
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString();

test("counts down coarsely, in minutes then hours", () => {
  expect(timeLeft(at(0.5), NOW)).toBe("under a minute");
  expect(timeLeft(at(45), NOW)).toBe("45 min");
  expect(timeLeft(at(120), NOW)).toBe("2h");
  expect(timeLeft(at(200), NOW)).toBe("3h 20m");
});

test("says nothing once the window has passed, or when there is no deadline", () => {
  for (const v of [at(0), at(-5), null, undefined, "", "not a date"]) expect(timeLeft(v, NOW)).toBe("");
});
