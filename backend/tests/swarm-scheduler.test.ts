// Swarm session-cron configurability (issue #208; resolved design scout
// #214). Three things proven here:
//   1. resolveSwarmSchedules() resolves enabled/cron/window from the
//      environment and DEFAULTS TO DISABLED when unset, so a plain CI/e2e/smoke
//      boot (no SWARM_* env set) never auto-enqueues real swarm
//      lifecycle jobs.
//   2. seedSwarmSchedules() is an explicit conflict-update BY KIND (not the
//      general (kind, cron) natural key) — a changed SWARM_*_CRON /
//      SWARM_SCHEDULES_ENABLED is actually applied to an EXISTING row, not
//      left stale alongside a new duplicate.
//   3. tickScheduler is at-most-once per cron slot for a swarm.* kind, the
//      same guarantee queue.test.ts already proves generically — pinned here
//      against a swarm kind specifically per issue #208's AC.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { resolveSwarmSchedules } from "../src/config.ts";
import { seedSwarmSchedules, seedJobSchedules } from "../src/db/seed.ts";
import { tickScheduler } from "../src/worker/scheduler.ts";

const SWARM_KINDS = [
  "swarm.open_session",
  "swarm.publish_brief",
  "swarm.close_window",
  "swarm.aggregate",
  "swarm.publish",
];

// Isolate each test's swarm.* rows from the shared ephemeral Postgres, and
// restore the production baseline (disabled, default cadence) afterwards so
// later test files (e.g. tests/api/admin-surface.test.ts, which reads a
// disabled swarm.* row) see the expected shape.
beforeEach(async () => {
  await sql`DELETE FROM jobs WHERE kind = ANY(${SWARM_KINDS})`;
  await sql`DELETE FROM job_schedules WHERE kind = ANY(${SWARM_KINDS})`;
});
afterAll(async () => {
  delete process.env.SWARM_SCHEDULES_ENABLED;
  delete process.env.SWARM_OPEN_SESSION_CRON;
  delete process.env.SWARM_PUBLISH_BRIEF_CRON;
  delete process.env.SWARM_CLOSE_WINDOW_CRON;
  delete process.env.SWARM_AGGREGATE_CRON;
  delete process.env.SWARM_PUBLISH_CRON;
  delete process.env.SWARM_WINDOW_MINUTES;
  await sql`DELETE FROM job_schedules WHERE kind = ANY(${SWARM_KINDS})`;
  await seedJobSchedules();
});

test("resolveSwarmSchedules: defaults to disabled with the documented cron/window defaults when every env var is unset", () => {
  const schedules = resolveSwarmSchedules({});
  expect(schedules).toHaveLength(5);
  expect(schedules.every((s) => s.enabled === false)).toBe(true);
  const byKind = Object.fromEntries(schedules.map((s) => [s.kind, s]));
  expect(byKind["swarm.open_session"].cron).toBe("0 6 * * *");
  expect(byKind["swarm.publish_brief"].cron).toBe("0 7 * * *");
  expect(byKind["swarm.close_window"].cron).toBe("0 8 * * *");
  expect(byKind["swarm.aggregate"].cron).toBe("0 9 * * *");
  expect(byKind["swarm.publish"].cron).toBe("0 10 * * *");
  expect(byKind["swarm.publish_brief"].payload).toEqual({ windowMinutes: 60 });
});

test("resolveSwarmSchedules: SWARM_SCHEDULES_ENABLED + per-kind cron + window overrides all apply", () => {
  const schedules = resolveSwarmSchedules({
    SWARM_SCHEDULES_ENABLED: "1",
    SWARM_OPEN_SESSION_CRON: "*/2 * * * *",
    SWARM_PUBLISH_BRIEF_CRON: "1-59/2 * * * *",
    SWARM_WINDOW_MINUTES: "5",
  });
  expect(schedules.every((s) => s.enabled === true)).toBe(true);
  const byKind = Object.fromEntries(schedules.map((s) => [s.kind, s]));
  expect(byKind["swarm.open_session"].cron).toBe("*/2 * * * *");
  expect(byKind["swarm.publish_brief"].cron).toBe("1-59/2 * * * *");
  expect(byKind["swarm.publish_brief"].payload).toEqual({ windowMinutes: 5 });
  // Untouched knobs keep the documented production default.
  expect(byKind["swarm.close_window"].cron).toBe("0 8 * * *");
});

test("resolveSwarmSchedules: an invalid/non-positive SWARM_WINDOW_MINUTES falls back to 60", () => {
  expect(resolveSwarmSchedules({ SWARM_WINDOW_MINUTES: "0" })[1]!.payload).toEqual({ windowMinutes: 60 });
  expect(resolveSwarmSchedules({ SWARM_WINDOW_MINUTES: "not-a-number" })[1]!.payload).toEqual({ windowMinutes: 60 });
});

test("resolveSwarmSchedules: fails closed on a malformed SWARM_*_CRON instead of silently persisting it", () => {
  // tickScheduler evaluates every due job_schedules row inside ONE transaction
  // (worker/scheduler.ts) — an unparseable cron on any row throws mid-loop and
  // stalls EVERY schedule that tick (vault/wallet/buybacks/projects/analytics
  // too), not just swarm's. Catching a typo here, at config-resolution
  // (deploy) time, is what prevents that shared-scheduler-wide degradation.
  expect(() => resolveSwarmSchedules({ SWARM_OPEN_SESSION_CRON: "not a cron" })).toThrow(
    /invalid SWARM_OPEN_SESSION_CRON/,
  );
  expect(() => resolveSwarmSchedules({ SWARM_CLOSE_WINDOW_CRON: "99 99 * * *" })).toThrow(
    /invalid SWARM_CLOSE_WINDOW_CRON/,
  );
});

test("seedSwarmSchedules: applied to an EXISTING row — a changed cron/enabled is actually updated, not left as a stale duplicate", async () => {
  delete process.env.SWARM_SCHEDULES_ENABLED;
  await seedSwarmSchedules();
  const disabled = await sql<{ id: number; cron: string; enabled: boolean }[]>`
    SELECT id, cron, enabled FROM job_schedules WHERE kind = 'swarm.open_session'`;
  expect(disabled).toHaveLength(1);
  expect(disabled[0]!.enabled).toBe(false);
  expect(disabled[0]!.cron).toBe("0 6 * * *");
  const rowId = disabled[0]!.id;

  // Operator flips the switch and accelerates the cadence, then re-runs the
  // migrate/seed step (exactly what a redeploy does).
  process.env.SWARM_SCHEDULES_ENABLED = "1";
  process.env.SWARM_OPEN_SESSION_CRON = "*/2 * * * *";
  await seedSwarmSchedules();
  const updated = await sql<{ id: number; cron: string; enabled: boolean }[]>`
    SELECT id, cron, enabled FROM job_schedules WHERE kind = 'swarm.open_session'`;
  expect(updated).toHaveLength(1); // same row, not a second one
  expect(updated[0]!.id).toBe(rowId);
  expect(updated[0]!.enabled).toBe(true);
  expect(updated[0]!.cron).toBe("*/2 * * * *");

  delete process.env.SWARM_SCHEDULES_ENABLED;
  delete process.env.SWARM_OPEN_SESSION_CRON;
});

test("tickScheduler: an enabled swarm.* cron fires at most once per slot — ticking twice enqueues exactly one job", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, enabled) VALUES ('swarm.open_session', '*/5 * * * *', true)`;
  expect(await tickScheduler()).toBe(0); // brand-new row: seeds next_run_at, no stale fire

  // Anchor next_run_at at the most recent 5-minute-aligned slot (<= now), the
  // ONE due occurrence — not an open-ended lookback that could catch up
  // several missed slots at once (that's queue.test.ts's separate scenario).
  const now = new Date();
  const flooredMinute = Math.floor(now.getUTCMinutes() / 5) * 5;
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), flooredMinute, 0, 0));
  await sql`UPDATE job_schedules SET next_run_at = ${slot} WHERE kind = 'swarm.open_session'`;

  expect(await tickScheduler()).toBe(1); // exactly the one due slot
  expect(await tickScheduler()).toBe(0); // second tick, same slot: no double-enqueue

  const [{ c }] = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM jobs WHERE kind = 'swarm.open_session'`;
  expect(c).toBe(1);
});
