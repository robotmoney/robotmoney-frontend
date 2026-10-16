// The regime a session refreshes at its start is TODAY's, not the day its row was created (issue 1058).
// A session that waits for its brief keeps its creation date: on 2026-09-28 four rows were created at 00:11 to 00:40
// UTC and briefed on 09-29 and 09-30, and each refreshed the 09-28 regime, so those briefs carried a stale one.
import { expect, test } from "bun:test";
import { regimeRefreshDay } from "../../lib/swarm/session.ts";

const at = (iso: string) => new Date(iso);

test("with no override, the refresh is for the current UTC day, whatever day the session's row was created", () => {
  // The adopted 09-28 sessions, briefed on 09-30: the refresh is for 09-30.
  expect(regimeRefreshDay(undefined, at("2026-09-30T04:29:06Z"))).toBe("2026-09-30");
  expect(regimeRefreshDay(undefined, at("2026-09-29T22:27:32Z"))).toBe("2026-09-29");
});

test("a session opened on the day its row was created refreshes that day", () => {
  expect(regimeRefreshDay(undefined, at("2026-09-27T11:45:00Z"))).toBe("2026-09-27");
});

test("the UTC day is used, not the local one: 23:30 UTC is still the same day", () => {
  expect(regimeRefreshDay(undefined, at("2026-09-30T23:30:00-05:00"))).toBe("2026-10-01");
  expect(regimeRefreshDay(undefined, at("2026-09-30T23:59:59Z"))).toBe("2026-09-30");
});

test("an explicit regimeAsof still wins (pin a classification to another day)", () => {
  expect(regimeRefreshDay("2026-09-01", at("2026-09-30T04:29:06Z"))).toBe("2026-09-01");
});
