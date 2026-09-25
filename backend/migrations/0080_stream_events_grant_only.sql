-- compat: breaking
-- metadata_version: 1
--
-- `swarm_stream_events` is protected by grant alone, and only rm_owner may
-- prune it — issue #1026 W4, criterion 104, decision D53 (2), and
-- docs/technical/system-scheduler-spec.md §6.3 Retention as amended by D52.
--
-- §6.3 Retention: "The event log is append-only and is retained at least as far
-- back as the oldest cursor the API may still be asked to serve. Pruning above
-- that point is permitted; pruning below it is forbidden." Migration 0072 put
-- 0032's `rm_append_only_guard()` triggers on this table, which refuse every
-- DELETE and TRUNCATE from every role — rm_owner included — so the permitted
-- prune could not run at all. D53 (2) settles the conflict for the retention
-- rule: the triggers go, and the table stays closed to the runtime roles by
-- privilege.
--
-- WHAT STAYS. DELETE and TRUNCATE remain revoked from rm_app and rm_worker. A
-- privilege refusal (42501) is the mechanism that survives here, and it is
-- asserted three times over: this file re-issues the REVOKE; grant
-- reconciliation (backend/schema/grants.sql) re-asserts it on every migrate run
-- from its own `runtime_delete_revoked` list, not from the append-only list the
-- table has left; and preflight check 2 refuses either grant on it
-- (RUNTIME_DELETE_REVOKED_TABLES in src/db/preflight.ts).
--
-- WHY PRUNING CANNOT RENUMBER. Event numbers come from the one-row counter
-- `swarm_stream_head` (the next migration), never from MAX(seq), so removing
-- old rows cannot hand an issued number out again. A subscriber whose cursor
-- falls below the pruned floor is answered with a resync, never a skip (§6.3).
--
-- WHY `breaking`. §8.4: additive means old code's supported behaviour is
-- preserved. Code built for 0072-0079 lists this table in APPEND_ONLY_TABLES,
-- and its boot guard (`assertAppendOnlyGuardArmed`, src/db/append-only-guard.ts)
-- expects both triggers on every listed table once 0072 is recorded. That code
-- booted against this database reports the guard disarmed and refuses to
-- serve. A code-only rollback past this file is therefore closed, explicitly.

DROP TRIGGER IF EXISTS swarm_stream_events_append_only ON swarm_stream_events;
DROP TRIGGER IF EXISTS swarm_stream_events_append_only_row ON swarm_stream_events;

REVOKE DELETE, TRUNCATE ON swarm_stream_events FROM rm_app, rm_worker;

COMMENT ON TABLE swarm_stream_events IS
  'The scheduler event stream (spec §6). One row per change to what the clock waits on, written in the same transaction as that change, numbered gaplessly in commit order from swarm_stream_head. Only rm_owner may delete, and only rows below the oldest servable cursor (D52, D53 (2)).';
