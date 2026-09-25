-- compat: breaking
-- metadata_version: 1
--
-- THE OLD SCHEDULER'S ROWS, AND THE NEW ONE'S LOGS — issue #1026 W4, part 3.
--
-- AUTHORITY: docs/technical/system-scheduler-spec.md §2.2, §2.4, §6.3, §9 and
-- §12, and docs/technical/smoke-production-spec.md §6.3.
--
-- Two unrelated things, in one migration because each is three statements and
-- both are the same act: finishing the replacement of the cron scheduler with
-- the epoch scheduler.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 — DELETE THE FIVE `swarm.*` SCHEDULE ROWS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- §12 records the supersession: smoke §6.3 used to say `worker-swarm` "schedules
-- sessions from `job_schedules` rows"; it now says "There is nothing to enable.
-- A subject's epoch duration is the whole schedule … There are no schedule rows,
-- no cron strings, no `next_run_at`, and no enable command."
--
-- The seeding code is gone from `backend/src/db/seed.ts` and the five rows are
-- gone from `backend/schema/bootstrap-data.sql`, so a blank database never gets
-- them again. This migration is for the databases that already have them —
-- production among them, where `SWARM_SCHEDULES_ENABLED` defaulted to `1` in the
-- compose file and the rows are therefore ENABLED and firing.
--
-- DELETE, NOT DISABLE. An `enabled = false` row is a row an operator can turn
-- back on, and §2.4 says "There is no on/off state for scheduling." Leaving the
-- rows would leave a second scheduler one UPDATE away from running beside the
-- first, which is exactly the failure this workstream exists to end.
--
-- `job_schedules` is deliberately NOT append-only (see the "NOT protected" list
-- in src/db/append-only-guard.ts: "queue and coordination churn, and the queue
-- is periodically pruned by design"), so this DELETE is permitted and fires no
-- guard.
--
-- BREAKING (relabelled from `additive` by D55 (7), 2026-09-25). §8.4 defines
-- additive as old code's supported behaviour preserved, and says no bootstrap
-- row old code relies on is removed. This file removes exactly such rows: code
-- built at 0070 seeded these `job_schedules` rows and read them through
-- `resolveSwarmSchedules`, `seedSwarmSchedules`, the `swarm` worker lane and
-- the six `swarm.*` handlers. That code is deleted in the same change, but an
-- old binary rolled back onto this database would boot, find no rows and
-- schedule nothing, with no refusal to say why. `breaking` makes check 3b
-- refuse that rollback instead.
--
-- A ledger that already recorded this file keeps `additive`: the runner writes
-- a ledger row once, at apply, and never rewrites it. 0079, 0080 and 0081 are
-- `breaking` and later, so once they are applied they close rollback past this
-- file by themselves and the stale label decides nothing.

DELETE FROM jobs
 WHERE kind IN ('swarm.open_session', 'swarm.publish_brief', 'swarm.close_window',
                'swarm.aggregate', 'swarm.judge', 'swarm.publish')
   AND status = 'pending';

DELETE FROM job_schedules
 WHERE kind IN ('swarm.open_session', 'swarm.publish_brief', 'swarm.close_window',
                'swarm.aggregate', 'swarm.judge', 'swarm.publish');

-- `swarm.judge` is in both lists although it was never a SCHEDULE row: it was
-- enqueued out of band by the session driver. Its handler is gone with the rest
-- (nothing judges inline any more — the judge is a participant, smoke §6.2), so
-- a pending row would sit in the queue for ever with no handler to claim it.
--
-- Only `pending` jobs are removed. A `succeeded`, `failed` or `dead` row is
-- history of what the system did and is left exactly where it is.

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 — THE NEW SCHEDULER'S TWO LOGS ARE APPEND-ONLY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `swarm_stream_events` (migration 0068) is the event log §6.3's whole contract
-- rests on: "A gap — a sequence number that is not the last applied plus one —
-- means the copy is no longer provably current." A deleted row IS a gap, and it
-- is a gap the scheduler cannot tell from a lost frame: it would stop, rebuild,
-- find the same hole and stop again. The sequence's gaplessness is a guarantee,
-- and a guarantee anything can punch a hole in is not one.
--
-- `swarm_scheduler_jobs` (migration 0070) holds the idempotency keys §6.3
-- requires for pushed work. 0070 already grants no DELETE; its own header says
-- why the row outlives the ack. What 0070 did NOT do is install the triggers or
-- revoke TRUNCATE, and TRUNCATE is the one that matters most here: the triggers
-- installed below are row-level and statement-level, and the grant is the only
-- protection a TRUNCATE ever meets.
--
-- Both are added to `APPEND_ONLY_TABLES` in src/db/append-only-guard.ts, to the
-- array in backend/schema/grants.sql, and to `APPEND_ONLY_MIGRATIONS` naming
-- this file — all three, because a table in one list and not another is a table
-- nobody protects, and the boot check pins the union.

DO $$
DECLARE
  newly_protected text[] := ARRAY['swarm_stream_events', 'swarm_scheduler_jobs'];
  t text;
BEGIN
  FOREACH t IN ARRAY newly_protected LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relkind IN ('r', 'p')
    ) THEN
      CONTINUE;
    END IF;

    -- Statement level: refuses the statement before any scan, and is the ONLY
    -- level TRUNCATE fires at.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON public.%I '
      || 'FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only', t);
    -- A separate ALTER: CREATE TRIGGER has no ENABLE ALWAYS clause, and without
    -- ALWAYS the trigger is skipped for a logical-replication apply.
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only');

    -- Row level: the only level that exists for a removal with NO STATEMENT
    -- behind it. TRUNCATE is not a valid row-level event and is deliberately
    -- absent; the statement trigger above has it.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only_row', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only_row', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only_row');

    -- The privilege half. Absent privilege and the triggers are two mechanisms,
    -- not one: a privilege refusal (42501) survives a dropped trigger, and a
    -- trigger survives a re-widened grant.
    EXECUTE format('REVOKE DELETE, TRUNCATE ON public.%I FROM rm_app, rm_worker', t);
  END LOOP;
END
$$;
