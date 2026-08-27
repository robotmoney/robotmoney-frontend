-- `swarm_session_judgements` joins the append-only set (issue #757 review).
--
-- Migration 0039 introduced the table and its own header called it "the
-- append-only record of every judge run" — but nothing enforced that. The
-- repo's mechanism is 0032's `rm_append_only_guard()` plus a statement- AND a
-- row-level `ENABLE ALWAYS` trigger per table, and a table absent from that set
-- is a table where DELETE and TRUNCATE simply succeed. 0032's own header is
-- explicit that this is the difference between a claim and an invariant.
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT TO 0032. An applied migration is a
-- frozen artefact: every database that already ran 0032 records it in
-- `schema_migrations` and will never run it again, so an edit there protects
-- nothing anywhere. This file re-runs the same DO block over just the new
-- table. `to_regclass` makes it safe on a database that predates 0039 (it
-- cannot exist there — 0039 runs first — but the guard costs nothing and
-- matches 0032's own shape).
--
-- The claim this makes true: a judgement row, once written, is history. It
-- carries `prompt_hash` and `inputs_digest`, which are attribution — "this
-- opinion was formed under these instructions over exactly these takes" — and
-- attribution that can be deleted is attribution nobody has to stand behind.
--
-- `swarm_judge_config` is deliberately NOT protected: it is a one-row operator
-- switch, i.e. mutable configuration, not history. Same call 0032 made for the
-- config-shaped tables it left out.

DO $$
DECLARE
  t text;
  protected text[] := ARRAY[
    'swarm_session_judgements'
  ];
BEGIN
  FOREACH t IN ARRAY protected LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'append-only guard: table % does not exist, skipping', t;
      CONTINUE;
    END IF;

    -- Statement level: refuses the OPERATION, including one that matches no
    -- rows, and it is the only level TRUNCATE can be caught at.
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only');

    -- Row level: catches a removal with NO STATEMENT behind it — a
    -- logical-replication apply, and a DELETE aimed at an inheritance parent.
    -- ENABLE ALWAYS on both, because `session_replication_role = 'replica'`
    -- (what a restore and an apply worker set) skips origin-only triggers.
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only_row', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION rm_append_only_guard()',
      t || '_append_only_row', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only_row');
  END LOOP;
END;
$$;

COMMENT ON TABLE swarm_session_judgements IS
  'Append-only record of every judge run (migrations 0039, 0040). Protected by rm_append_only_guard().';

-- Least privilege for the restricted worker role. 0016 grants
-- SELECT/INSERT/UPDATE/DELETE on every future table by default, and the judge
-- never runs under that role: `swarm.judge` executes in worker-swarm, but every
-- statement it issues goes through src/db/client.ts, which is the DATABASE_URL
-- pool, not src/db/worker-client.ts's WORKER_DATABASE_URL one. So the worker
-- role needs READ access here (admin projections) and nothing else — and the
-- config row is an operator switch it has no business setting either.
REVOKE INSERT, UPDATE, DELETE ON swarm_session_judgements, swarm_judge_config FROM rm_worker;
