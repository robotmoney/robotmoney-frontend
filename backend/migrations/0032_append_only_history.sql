-- Append-only enforcement for the historical record.
--
-- WHY. The swarm record is a chain of facts: a signed take, the memo it cites,
-- the session that produced it, the member who authored it. None of that is
-- editable by deletion, and none of it can be reconstructed once gone — the
-- signatures were made by keys the server never held. Until this migration
-- that was CONVENTION ONLY. `resetSessions()` had been a dev-only
-- `TRUNCATE swarm_recommendations, swarm_briefs, swarm_sessions RESTART
-- IDENTITY CASCADE`; it was removed by hand and swarm/domain.ts records why
-- ("Nothing wipes rows any more"). Nothing stopped the next caller from
-- re-adding it, and nothing stopped a hand-run `psql` at 3am either.
--
-- A comment is not an invariant. This is the invariant.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS ACTUALLY GUARANTEED, AND WHAT IS NOT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The claim is exactly this and no more: *ROWS IN THE TABLES BELOW ARE NOT
-- REMOVED*. It is NOT "history is immutable" and it is NOT tamper-evidence.
-- Every sentence below was executed against real PostgreSQL 17.10 and 18.6,
-- each result control-run by dropping rm_append_only_guard() and re-issuing the
-- identical statement, so none of it is reasoning about what Postgres ought to
-- do.
--
-- REFUSED (covered):
--   * DELETE, and DELETE ... WHERE false — the OPERATION is refused, not the
--     match, so it cannot be probed for with a WHERE clause that finds nothing.
--   * DELETE FROM ONLY t.
--   * TRUNCATE, TRUNCATE ... CASCADE, and the verbatim
--     `TRUNCATE swarm_recommendations, swarm_briefs, swarm_sessions
--      RESTART IDENTITY CASCADE` this issue exists to prevent.
--   * MERGE ... WHEN MATCHED THEN DELETE — fires on the PRESENCE of the DELETE
--     action, not on whether a row matched.
--   * A DELETE reached indirectly: through a view, a rule, a SECURITY DEFINER
--     function, another table's trigger, or a data-modifying CTE.
--   * An FK `ON DELETE CASCADE` from an unprotected parent — the RI cascade
--     issues a real `DELETE FROM ONLY "public"."child"`, so this holds if the
--     schema later grows such an edge, not merely because it has none today.
--   * `session_replication_role` set to 'replica', 'local' or 'origin'.
--   * A LOGICAL-REPLICATION APPLY of a row DELETE (see property 1 below) and of
--     a TRUNCATE.
--   * A DELETE issued against an INHERITANCE PARENT of a protected table.
--
-- NOT REFUSED (and each is deliberate or unavoidable):
--   * UPDATE. Permitted BY DESIGN — see WHAT THIS DOES NOT DO. An UPDATE can
--     blank every column of every row, so a protected table can be emptied of
--     MEANING while keeping its row count. "History rows are not removed" is
--     the guarantee; "the recorded facts cannot be altered" is NOT, and nothing
--     here detects that it happened.
--   * PROVENANCE BLANKED INDIRECTLY. `jobs` is deliberately unprotected, and
--     `DELETE FROM jobs` is permitted. Its `ON DELETE SET NULL` edges then null
--     provenance columns ON protected rows — demonstrated on this schema for
--     `audit_log.job_id`, and the same shape applies to
--     `swarm_session_events.job_id` and `agent_activity_log.agent_id`. The
--     guard preserves rows; it does not preserve every fact recorded in them.
--   * DROP TABLE. Not a DELETE and not a TRUNCATE; no trigger of either kind
--     fires for it.
--   * EVERY DDL BYPASS, because the role in DATABASE_URL OWNS these tables and
--     this function. src/db/migrate.ts imports the same pool that serves
--     requests, so the application owns everything it protects. All of these
--     were executed and all of them work for that role:
--       - `ALTER TABLE ... DISABLE TRIGGER USER` (an ENABLE ALWAYS trigger is
--         still a USER trigger, so this catches it);
--       - `ALTER TABLE ... ENABLE REPLICA TRIGGER` (deletes then succeed in
--         normal operation, and the catalog still shows a trigger — tgenabled
--         reads 'R' rather than 'A');
--       - `DROP TRIGGER`, `DROP TABLE`, rename-swap, `SET SCHEMA`,
--         `DETACH PARTITION` + `DROP`;
--       - `DROP FUNCTION rm_append_only_guard() CASCADE`, which removes every
--         trigger below in ONE statement;
--       - `CREATE OR REPLACE FUNCTION rm_append_only_guard() ...` with a body
--         that returns instead of raising, which needs only FUNCTION ownership
--         and disarms every table at once while each trigger still exists,
--         still attaches to the right table, still names the right function and
--         still reports tgenabled = 'A'. This is why the runtime check in
--         src/db/append-only-guard.ts ATTEMPTS A DELETE instead of counting
--         triggers: an inventory passes against a fully disarmed database.
--         (Executed footnote: the naive `BEGIN RETURN NULL; END` body is NOT a
--         full disarm now that a row-level trigger exists — a BEFORE ROW
--         trigger returning NULL CANCELS the row's deletion, so that body turns
--         DELETE into a SILENT no-op that reports `DELETE 1` and removes
--         nothing. A working disarm has to branch on TG_LEVEL. Pinned in
--         backend/tests/append-only-guard-check.test.ts.)
--     A non-owner grantee (the `rm_worker` role) is refused all of them with
--     42501, so the guard genuinely is the only thing between such a role and
--     the data. Splitting ownership so the application is not the owner is
--     tracked separately in issue #692 and is NOT attempted here.
--   * MIGRATION ROLLBACK. `schema_migrations` is protected, so the usual
--     `DELETE FROM schema_migrations WHERE name = '…'` lever for forcing a
--     re-run now raises 0A000. That is intended — the migration ledger is
--     history too — but it means a rollback requires dropping the trigger
--     first. Say so out loud rather than let an operator discover it mid-incident.
--
-- Making the UPDATE and DDL cases DETECTABLE is a different mechanism (event
-- triggers, a non-owner role, an append-only replica, per-row hashing). Do not
-- let this header be read as a claim that they are already covered.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────────────────────
--
-- TWO triggers on each protected table, both BEFORE, both ENABLE ALWAYS:
--
--   <table>_append_only      BEFORE DELETE OR TRUNCATE  FOR EACH STATEMENT
--   <table>_append_only_row  BEFORE DELETE              FOR EACH ROW
--
-- Both are needed. Neither is redundant, and the pair is the correction of a
-- mistake this file made in its first version:
--
--   1. FOR EACH ROW catches what a STATEMENT trigger structurally cannot.
--      A logical-replication apply worker removes rows through
--      `ExecSimpleRelationDelete` — there is NO statement, so a statement-level
--      trigger is never fired, and `ENABLE ALWAYS` is irrelevant because the
--      trigger is never even considered. Verified publisher → subscriber on
--      real containers (17.10 and 18.6): the apply worker fired a row-level
--      probe trigger twice and neither statement-level trigger once, and the
--      rows were silently removed from protected tables with nothing logged.
--      DigitalOcean's "migrate database" and DMS-style cutovers ARE logical
--      replication applies, so this is an operational path, not a curiosity.
--      (`pg_dump`/`pg_restore` is a different mechanism and was never affected;
--      replicated TRUNCATE was always caught.)
--      The same absent-statement shape covers a DELETE issued against an
--      INHERITANCE PARENT: the parent-targeted delete produces no statement for
--      the child, so `DELETE 2` used to succeed against a protected child with
--      the guard silent. Latent today (`pg_inherits` is empty after all
--      migrations) and closed by the same trigger.
--      This is pinned by backend/tests/append-only-replication.test.ts, which
--      builds a real publisher/subscriber pair and carries its own CONTROL: a
--      second subscriber with ONLY the statement-level trigger, asserted to
--      LOSE the row. If the row-level trigger below is deleted, the first test
--      goes red; if it is the only thing keeping the control green, the control
--      goes red. Neither can pass by accident.
--
--   2. FOR EACH STATEMENT catches what a ROW trigger structurally cannot.
--      A row-level trigger never fires for `DELETE ... WHERE false`, so the
--      guard would be absent for exactly the probe that tests it and present
--      only once damage was under way — and it cannot fire for TRUNCATE at all,
--      which has no rows and is the faster way to lose everything. The
--      statement-level trigger refuses the OPERATION regardless of what it
--      matched, which is also what makes a live, side-effect-free runtime probe
--      possible (src/db/append-only-guard.ts issues `DELETE ... WHERE false`).
--
--   3. ENABLE ALWAYS on BOTH, not plain ENABLE.
--      `session_replication_role = 'replica'` — what a restore and a
--      logical-replication apply run as — silently SKIPS ordinary triggers.
--      Migration 0031 learned this for the handle namespace and used
--      `FOR EACH ROW` (0031:184), which is why its claim held; this file copied
--      the ENABLE ALWAYS clause, changed the trigger level to STATEMENT, and
--      kept citing 0031 as the precedent. The rationale stopped being true and
--      nothing noticed. Hence the executed test above rather than a third
--      restatement of the lesson.
--
-- WHAT THIS DOES NOT DO. It does not freeze the tables. INSERT and UPDATE are
-- untouched: the invariant is "history rows are not removed", not "the table is
-- read-only". An `UPDATE` that corrects a member's handle is normal operation.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The protected list is in the DO block below and is mirrored, with the full
-- per-table reasoning, in backend/tests/append-only-enforcement.test.ts. Both
-- are the spec; moving the boundary is one edit in each.
--
-- The EXCLUSIONS are stated there too, table by table, including the sibling
-- history tables that are excluded on purpose rather than by omission
-- (swarm_agent_health_events, swarm_waitlist, the analytics_* and research_*
-- pipeline tables, buyback_swaps). The one-line version: protect a fact that
-- CANNOT be reconstructed; do not protect state that is churn, ephemeral, or
-- re-derivable from a source that still exists.
--
-- A COUNT OF TRIGGERS IS NOT A VERIFICATION, for the CREATE OR REPLACE reason
-- above — and it is not even a stable count. Applying this file through raw
-- `psql` installs one table's PAIR of triggers FEWER than a `bun run migrate`
-- does, because `schema_migrations` is created in TypeScript
-- (src/db/migrate.ts:30-35), not by any .sql file, so the `to_regclass` skip
-- branch below fires for it. Any verification that counts anything must state
-- which path it exercised — which is a second reason src/db/append-only-guard.ts
-- probes the tables THIS database actually has rather than asserting a number.

CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 0A000 = feature_not_supported: the operation is refused categorically, not
  -- because of this caller's privileges or this row's contents.
  --
  -- THE MESSAGE IS THE ASSERTION SURFACE, so it is stable and it is specific.
  -- SQLSTATE alone is NOT sufficient evidence that this function ran:
  -- PostgreSQL's own heap_truncate_check_FKs() raises
  -- `cannot truncate a table referenced in a foreign key constraint` with the
  -- SAME 0A000, and fires BEFORE the trigger stage — so on any table with an
  -- inbound FK (most of these) a SQLSTATE-only check is green against a
  -- database where this migration was never applied. Every caller that verifies
  -- the guard matches this text, table name and TG_OP included.
  --
  -- Which of the two triggers refused it goes in DETAIL, so the primary message
  -- stays byte-stable for those assertions.
  RAISE EXCEPTION
    'table "%" is append-only: row deletion is not permitted (%). History rows are not removed; correct a row with an UPDATE or an offsetting row.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000',
          DETAIL = format('refused by trigger %s, %s level (migration 0032)', TG_NAME, TG_LEVEL);
END;
$$;

COMMENT ON FUNCTION rm_append_only_guard() IS
  'Refuses DELETE/TRUNCATE on the append-only historical tables. Both a statement-level and a row-level trigger call it; see migration 0032, src/db/append-only-guard.ts and backend/tests/append-only-enforcement.test.ts.';

DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'swarm_members',
    'swarm_recommendations',
    'swarm_memos',
    'swarm_sessions',
    'swarm_briefs',
    'swarm_subjects',
    'swarm_session_events',
    -- Added in review: the ATTENDANCE ROSTER of a session. swarm_session_events
    -- (the session's state trail) was protected while the record of WHO was
    -- seated for it was not, and the two are the same historical fact about the
    -- same session. A roster cannot be reconstructed after the fact — the
    -- membership it snapshots moves.
    'swarm_session_members',
    -- Added in review: the portfolio state a session's takes were made ABOUT,
    -- as of that day. It is what a memo's numbers are checked against, and it
    -- is a point-in-time observation of an external system — re-reading that
    -- system today answers a different question.
    'swarm_subject_snapshots',
    'swarm_applications',
    'audit_log',
    'agent_activity_log',
    'regime_snapshots',
    'schema_migrations'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    -- Skip a table this deployment has not created yet rather than aborting the
    -- migration: the protected set spans features added across many releases,
    -- and a fresh database applies them in order. (This is also the branch that
    -- makes a raw-`psql` apply install one trigger pair fewer — see the header.)
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'append-only guard: table % does not exist, skipping', t;
      CONTINUE;
    END IF;

    -- Statement level: refuses the OPERATION, including one that matches no
    -- rows, and it is the only level TRUNCATE can be caught at.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only', t);
    -- Must be a separate ALTER: CREATE TRIGGER has no ENABLE ALWAYS clause.
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only');

    -- Row level: the only level that exists for a removal with NO STATEMENT
    -- behind it — a logical-replication apply, and a delete aimed at an
    -- inheritance parent. TRUNCATE is deliberately absent here; it is not a
    -- valid event for a row-level trigger and the statement trigger has it.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only_row', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only_row', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only_row');
  END LOOP;
END;
$$;
