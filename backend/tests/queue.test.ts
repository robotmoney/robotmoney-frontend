import { test, expect, beforeAll, beforeEach } from "bun:test";
import { sql } from "../src/db/client.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { reapStuckJobs } from "../src/worker/reaper.ts";
import { tickScheduler } from "../src/worker/scheduler.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

beforeAll(() => {
  handlers["test.ok"] = async () => ({ ok: true });
  handlers["test.fail"] = async () => { throw new Error("boom"); };
});
// Isolate each test: clear the queue + schedules so processOneJob claims only
// our job. Ordered DELETEs, not `TRUNCATE ... CASCADE`: jobs/job_runs/
// job_schedules are deliberately unprotected churn, but three tables reference
// jobs(id) — audit_log, swarm_session_events and analytics_runs — and CASCADE
// truncates a referencing table WHOLE regardless of its ON DELETE clause. The
// queue fixture was destroying the audit trail. A DELETE honours the declared
// `ON DELETE SET NULL` and merely detaches it.
beforeEach(async () => {
  await sql`DELETE FROM job_runs`;
  await sql`DELETE FROM jobs`;
  await sql`DELETE FROM job_schedules`;
});

test("processOneJob: success → succeeded + a job_runs row", async () => {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('test.ok','{}') RETURNING id`;
  expect(await processOneJob()).toBe(true);
  const [job] = await sql`SELECT status, attempts FROM jobs WHERE id=${id}`;
  expect(job.status).toBe("succeeded");
  expect(job.attempts).toBe(1);
  const runs = await sql`SELECT status FROM job_runs WHERE job_id=${id}`;
  expect(runs.length).toBe(1);
  expect(runs[0].status).toBe("succeeded");
});

test("processOneJob: failure with attempts left → pending with backoff", async () => {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload, max_attempts) VALUES ('test.fail','{}',5) RETURNING id`;
  await processOneJob();
  const [job] = await sql`SELECT status, attempts, run_after FROM jobs WHERE id=${id}`;
  expect(job.status).toBe("pending");
  expect(job.attempts).toBe(1);
  expect(new Date(job.run_after).getTime()).toBeGreaterThan(Date.now()); // exponential backoff
  const [{ c }] = await sql`SELECT count(*)::int c FROM job_runs WHERE job_id=${id} AND status='failed'`;
  expect(c).toBe(1);
});

test("processOneJob: failure on the last attempt → dead", async () => {
  const [{ id }] = await sql`INSERT INTO jobs (kind, payload, max_attempts) VALUES ('test.fail','{}',1) RETURNING id`;
  await processOneJob();
  const [job] = await sql`SELECT status FROM jobs WHERE id=${id}`;
  expect(job.status).toBe("dead");
});

test("scheduler: new schedule seeds next_run_at without firing; a due one catches up; idempotent", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, enabled) VALUES ('test.ok','*/5 * * * *', true)`;
  expect(await tickScheduler()).toBe(0); // NULL next_run_at → seed only, no stale fire
  const [seeded] = await sql`SELECT next_run_at FROM job_schedules WHERE kind='test.ok'`;
  expect(seeded.next_run_at).not.toBeNull();

  await sql`UPDATE job_schedules SET next_run_at = now() - interval '20 minutes' WHERE kind='test.ok'`;
  expect(await tickScheduler()).toBeGreaterThan(0); // catch up missed slots
  const [{ c }] = await sql`SELECT count(*)::int c FROM jobs WHERE kind='test.ok'`;
  expect(c).toBeGreaterThan(0);
  expect(await tickScheduler()).toBe(0); // next_run_at now future → nothing new
});

// issue #614 AC1: a schedule left more than 1000 slots behind must never be
// left pinned on a single stale next_run_at. Against pre-#614 main,
// scheduler.ts's guard loop only updated `nextRun` on the `slotDate > now`
// break, so overflowing the guard left `nextRun` equal to the ORIGINAL
// next_run_at and wrote that same past value back — every later tick re-ran
// the identical first 1000 (dedupe-suppressed) slots forever and net-enqueued
// zero new jobs. This must fail against that code: after enough ticks to
// drain the backlog, next_run_at must be in the future and the schedule must
// still be capable of enqueuing fresh (non-suppressed) work each tick.
test("scheduler: a per-minute cron >1000 slots (16h40m) behind is never left pinned in the past", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, enabled) VALUES ('test.ok','* * * * *', true)`;
  const staleAt = new Date(Date.now() - 20 * 60 * 60 * 1000); // 20h behind = 1200 minute-slots
  await sql`UPDATE job_schedules SET next_run_at = ${staleAt} WHERE kind='test.ok'`;

  const firstTickEnqueued = await tickScheduler();
  expect(firstTickEnqueued).toBeGreaterThan(0);
  const [afterFirst] = await sql`SELECT next_run_at FROM job_schedules WHERE kind='test.ok'`;
  // The core regression: next_run_at must have MOVED from the original stale
  // value, not been written back unchanged.
  expect(new Date(afterFirst.next_run_at).getTime()).toBeGreaterThan(staleAt.getTime());

  // A second tick must enqueue MORE new (non-suppressed) work rather than
  // reprocessing the same dead batch — proof the cursor genuinely advanced.
  const secondTickEnqueued = await tickScheduler();
  expect(secondTickEnqueued).toBeGreaterThan(0);

  const [afterSecond] = await sql`SELECT next_run_at FROM job_schedules WHERE kind='test.ok'`;
  expect(new Date(afterSecond.next_run_at).getTime()).toBeGreaterThan(new Date(afterFirst.next_run_at).getTime());
  // 1200 slots / 1000-per-tick cap drains fully within two ticks. We don't
  // assert afterSecond.next_run_at > Date.now() here: next_run_at lands on an
  // exact minute boundary, and a Date.now() read taken this much later (after
  // the tick's own work) can itself have crossed that same boundary, racing a
  // pass on ~1 run in 1000 (issue #764). "Reached the future" is instead
  // proven properly below: tickScheduler() selects WHERE next_run_at <= now(),
  // so a third tick returning 0 means the DB itself — read at selection time,
  // not after the fact from JS — considers this schedule no longer due.
  //
  // Fully caught up now: a third tick finds nothing newly due for this slot
  // cursor (dedupe still suppresses any residual overlap, and next_run_at is
  // future so nothing is even selected).
  expect(await tickScheduler()).toBe(0);

  const [{ c }] = await sql`SELECT count(*)::int c FROM jobs WHERE kind='test.ok'`;
  expect(c).toBeGreaterThan(1000); // more than one guard-batch worth actually landed
});

// Same clamp, asserted for a COARSE (hourly) cron: proves the fix is
// cadence-independent, not a per-minute special case. ~41 days behind
// overflows the 1000-slot guard exactly the same way.
test("scheduler: an hourly cron >1000 slots (~41 days) behind is never left pinned in the past", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, enabled) VALUES ('test.ok','0 * * * *', true)`;
  const staleAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000); // 45 days ≈ 1080 hourly slots
  await sql`UPDATE job_schedules SET next_run_at = ${staleAt} WHERE kind='test.ok'`;

  const firstTickEnqueued = await tickScheduler();
  expect(firstTickEnqueued).toBeGreaterThan(0);
  const [afterFirst] = await sql`SELECT next_run_at FROM job_schedules WHERE kind='test.ok'`;
  expect(new Date(afterFirst.next_run_at).getTime()).toBeGreaterThan(staleAt.getTime());

  const secondTickEnqueued = await tickScheduler();
  expect(secondTickEnqueued).toBeGreaterThanOrEqual(0); // remaining ~80 slots, may finish on tick 2
  // See the per-minute test above (issue #764): next_run_at lands on an exact
  // hour boundary, so comparing it to a Date.now() read taken after the tick
  // races that boundary the same way. tickScheduler() returning 0 proves
  // "reached the future" against the DB's own now() at selection time instead.
  expect(await tickScheduler()).toBe(0);
});

// issue #614 AC2: the enqueued job payload carries the SLOT'S OWN timestamp,
// not just the schedule's static payload — a handler replaying a missed slot
// needs to know which date it is filling in for instead of always writing
// `new Date()`. Must fail against pre-#614 main, where every enqueued job's
// payload is exactly the schedule's static `payload` column with no slot
// timestamp at all (seed.ts's samplers all seed `{}`).
test("scheduler: enqueued jobs carry the slot's own timestamp in the payload", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, payload, enabled) VALUES ('test.ok','* * * * *', '{"a":1}', true)`;
  await sql`UPDATE job_schedules SET next_run_at = now() - interval '3 minutes' WHERE kind='test.ok'`;
  expect(await tickScheduler()).toBeGreaterThan(0);
  const rows = await sql`SELECT payload FROM jobs WHERE kind='test.ok' ORDER BY id ASC`;
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.payload.a).toBe(1); // static payload preserved
    expect(typeof row.payload.slotAt).toBe("string");
    expect(Number.isNaN(Date.parse(row.payload.slotAt))).toBe(false);
  }
  // Slots are distinct and strictly increasing — each replayed slot really
  // does carry ITS OWN timestamp, not one shared value.
  const slots = rows.map((r) => Date.parse(r.payload.slotAt));
  for (let i = 1; i < slots.length; i++) expect(slots[i]).toBeGreaterThan(slots[i - 1]);
});

// issue #651: per-schedule catch-up policy. 'all' (the default) is a
// regression pin on the pre-existing behaviour above — every missed slot,
// same-day or not, still gets its own job.
test("scheduler: 'all' catch-up policy (default) still enqueues every missed same-day slot", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, enabled, catchup_policy) VALUES ('test.ok','* * * * *', true, 'all')`;
  expect(await tickScheduler()).toBe(0); // seed only, no stale fire
  // Backdated a handful of minutes — guaranteed same UTC day short of a run
  // starting in literally the first 8 minutes after midnight.
  await sql`UPDATE job_schedules SET next_run_at = now() - interval '8 minutes' WHERE kind='test.ok'`;
  const enqueued = await tickScheduler();
  expect(enqueued).toBeGreaterThan(1); // every missed slot got its own job, none collapsed
  const [{ c }] = await sql`SELECT count(*)::int c FROM jobs WHERE kind='test.ok'`;
  expect(c).toBe(enqueued);
});

// issue #651: 'collapse-per-bucket' folds every missed slot that falls in the
// SAME UTC-day bucket into exactly one job (the last one due), instead of one
// job per missed slot — the redundant-live-read case the wallet samplers hit.
test("scheduler: 'collapse-per-bucket' catch-up policy collapses N missed same-day slots into exactly 1", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, enabled, catchup_policy) VALUES ('test.ok','* * * * *', true, 'collapse-per-bucket')`;
  expect(await tickScheduler()).toBe(0); // seed only, no stale fire
  const before = new Date();
  // Clamped to the start of today: "now() - 8 minutes" alone can cross UTC
  // midnight (the very case this test exists to keep separate from same-day
  // collapsing — see the sibling cross-day test below), which would split
  // these slots across two buckets and produce 2 jobs instead of 1.
  await sql`UPDATE job_schedules SET next_run_at = GREATEST(now() - interval '8 minutes', date_trunc('day', now())) WHERE kind='test.ok'`;
  expect(await tickScheduler()).toBe(1); // same-day missed slots, exactly one job enqueued
  const rows = await sql`SELECT payload FROM jobs WHERE kind='test.ok' ORDER BY id ASC`;
  expect(rows.length).toBe(1);
  // The LAST due slot is the one that survives, not an earlier one.
  const slotAt = Date.parse(rows[0].payload.slotAt);
  expect(before.getTime() - slotAt).toBeLessThan(2 * 60_000);
  expect(await tickScheduler()).toBe(0); // fully caught up, idempotent
});

// issue #651: collapsing is per UTC-day bucket, not global — a backlog
// spanning several days still produces one (collapsed) job PER DAY, so
// cross-day catch-up is unaffected by same-day collapsing.
test("scheduler: 'collapse-per-bucket' still gives each missed UTC day its own collapsed job", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, enabled, catchup_policy) VALUES ('test.ok','0 * * * *', true, 'collapse-per-bucket')`;
  expect(await tickScheduler()).toBe(0); // seed only, no stale fire
  await sql`UPDATE job_schedules SET next_run_at = now() - interval '50 hours' WHERE kind='test.ok'`;
  expect(await tickScheduler()).toBeGreaterThan(0);
  const rows = await sql`SELECT payload FROM jobs WHERE kind='test.ok' ORDER BY id ASC`;
  const days = rows.map((r) => new Date(r.payload.slotAt).toISOString().slice(0, 10));
  const uniqueDays = new Set(days);
  expect(rows.length).toBe(uniqueDays.size); // exactly one job per distinct UTC day — no same-day duplicates
  expect(rows.length).toBeGreaterThan(1); // 50h of hourly backlog spans multiple days
});

test("reaper: stuck running job is requeued with backoff; exhausted → dead", async () => {
  const [{ id: a }] = await sql`INSERT INTO jobs (kind, payload, status, locked_at, locked_by, attempts, max_attempts)
                                VALUES ('test.ok','{}','running', now() - interval '10 minutes','dead-worker',1,5) RETURNING id`;
  const [{ id: b }] = await sql`INSERT INTO jobs (kind, payload, status, locked_at, locked_by, attempts, max_attempts)
                                VALUES ('test.fail','{}','running', now() - interval '10 minutes','dead-worker',5,5) RETURNING id`;
  expect(await reapStuckJobs()).toBeGreaterThanOrEqual(2);
  const [ja] = await sql`SELECT status, run_after FROM jobs WHERE id=${a}`;
  expect(ja.status).toBe("pending");
  expect(new Date(ja.run_after).getTime()).toBeGreaterThan(Date.now());
  const [jb] = await sql`SELECT status FROM jobs WHERE id=${b}`;
  expect(jb.status).toBe("dead");
});
