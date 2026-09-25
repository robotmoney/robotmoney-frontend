-- Snapshot, part 3 of 3: ROLES AND GRANTS (smoke-production-spec.md §8.1).
--
-- Idempotent grant reconciliation for the objects rm_owner owns. Unlike part 1 it
-- runs on EVERY migrate run -- "always, even with nothing pending" (§8.3) -- because
-- the failure it exists to catch is a grant fixed by hand and then lost, which no
-- migration list can see.
--
-- ROLE CREATION IS NOT PART OF IT. Creating a role needs CREATEROLE and §3 says
-- "rm_owner never holds CREATEROLE"; the four roles are created by doadmin as cluster
-- provisioning (§9.1). This file only moves privileges.
--
-- IT SWEEPS EVERY RELATION IN public RATHER THAN A WRITTEN LIST, for the same reason
-- the registry is derived rather than written down: a list is wrong the week a table
-- is added. A relation in public that rm_owner does not own makes this file FAIL, and
-- that is the correct outcome -- ownership of an application object by a runtime role
-- is itself a check-2 denylist violation (§7 check 2), so reconciliation must not
-- quietly succeed around it.
--
-- THE APPEND-ONLY REVOCATION IS §9.1 STEP 2, and it is MIGRATION 0065. Migration
-- 0053 granted rm_app `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`
-- -- append-only tables included -- and preflight check 2 fails until that is undone.
-- §9.1 calls the transition "a migration" and 0065 is it: reconciliation only runs
-- inside a migrate run, and §8.5 keeps a production migrate run out of the boot, so a
-- transition carried by reconciliation alone would leave production unable to pass
-- check 2 until an operator happened to migrate. The REVOKE below RE-ASSERTS 0065 on
-- every run rather than replacing it, because a hand-run GRANT that re-widens rm_app
-- is drift a one-shot migration cannot catch. Absent privilege is one half of the
-- protection; migration 0032's triggers are the other (src/db/append-only-guard.ts).

DO $$
DECLARE
  -- Kept in step with APPEND_ONLY_TABLES in src/db/append-only-guard.ts, which is
  -- what preflight check 2's `append_only_write` rule tests against.
  append_only text[] := ARRAY[
    'swarm_members', 'swarm_recommendations', 'swarm_memos', 'swarm_sessions',
    'swarm_briefs', 'swarm_subjects', 'swarm_session_events', 'swarm_session_members',
    'swarm_subject_snapshots', 'swarm_session_judgements', 'swarm_consensus_receipts',
    'swarm_member_keys', 'swarm_applications', 'audit_log', 'agent_activity_log',
    'regime_snapshots', 'schema_migrations', 'analytics_overwrite_events'
    -- The epoch scheduler's two logs left this list (APPEND_ONLY_RELEASED in
    -- src/db/append-only-guard.ts): the pushed-job ledger is dropped with the
    -- job pushes (migration 0079), and the event log is protected by grant
    -- alone (0080, D53 (2)) — see `runtime_delete_revoked` below.
  ];
  -- Tables that are NOT append-only, whose DELETE and TRUNCATE nonetheless stay
  -- revoked from the runtime roles, re-asserted on every run from THIS list so
  -- that leaving `append_only` never quietly hands the privilege back.
  -- `swarm_stream_events`: D53 (2) dropped its guard triggers so rm_owner can
  -- prune rows below the oldest servable cursor (scheduler spec §6.3
  -- Retention, D52), and "DELETE and TRUNCATE stay revoked from rm_app and
  -- rm_worker"; preflight check 2 refuses either grant on it
  -- (RUNTIME_DELETE_REVOKED_TABLES in src/db/preflight.ts). `swarm_stream_head`
  -- is its counter row (0081): a runtime role that could remove it could stop
  -- every transition that writes an event.
  runtime_delete_revoked text[] := ARRAY['swarm_stream_events', 'swarm_stream_head'];
  -- rm_worker's grants, as the migrations give them (0016's default, narrowed
  -- by 0054's explicit allowlist, then 0061 and 0062). Declared here because
  -- the snapshot carries no grants: before this list a `--local blank`
  -- bootstrap left rm_worker holding nothing, so the pipeline worker could not
  -- even claim a job. Everything else rm_worker holds is SELECT (0062: "GRANT
  -- SELECT ON ALL TABLES/SEQUENCES ... TO rm_app, rm_worker" and its default
  -- for later tables), and the loop below re-asserts exactly that.
  worker_dml text[] := ARRAY[
    'agent_revenue_daily', 'agent_vaults', 'chain_address_floors', 'chain_day_blocks', 'daily_agent_snapshots',
    'daily_coin_snapshots', 'daily_tvl_snapshots', 'daily_wallet_snapshots', 'job_runs', 'job_schedules', 'jobs',
    'lobster_coins', 'openclaw_agents', 'projects', 'tracked_wallets', 'vault_adapter_samples',
    'vault_share_price_history', 'wallet_backfill_state', 'wallet_balance_samples', 'wallet_sleeve_samples'
  ];
  -- Written by the price workers but never pruned (0054).
  worker_insert_update text[] := ARRAY['asset_price_floors', 'asset_prices'];
  -- The serial sequences behind rm_worker's inserts (0054, 0061); every other
  -- sequence is SELECT only for it (0062).
  worker_sequence_usage text[] := ARRAY[
    'analytics_artifacts_id_seq', 'analytics_stage_runs_id_seq', 'audit_log_id_seq', 'buyback_swaps_id_seq',
    'committee_agent_health_events_id_seq', 'committee_member_keys_id_seq', 'committee_memos_id_seq',
    'committee_session_events_id_seq', 'job_runs_id_seq', 'job_schedules_id_seq', 'jobs_id_seq', 'prices_id_seq',
    'regime_indicators_id_seq', 'research_pipeline_artifacts_id_seq', 'research_pipeline_runs_id_seq',
    'research_pipeline_stages_id_seq', 'research_pipeline_warnings_id_seq', 'research_signals_id_seq',
    'swarm_session_judgements_id_seq', 'vault_adapter_samples_id_seq', 'vault_share_price_history_id_seq',
    'vault_tvl_id_seq', 'wallet_aum_snapshot_runs_run_id_seq', 'wallet_balance_sample_evidence_evidence_id_seq',
    'wallet_balance_samples_id_seq', 'wallet_balances_id_seq', 'wallet_sleeve_sample_evidence_evidence_id_seq',
    'wallet_sleeve_samples_id_seq'
  ];
  -- The trigger functions 0056/0057/0058/0059/0060 created with PUBLIC EXECUTE
  -- revoked. The snapshot declares no function ACLs, so a blank bootstrap left
  -- PUBLIC holding EXECUTE on each; reconciliation re-asserts the revoke.
  ledger_guard_functions text[] := ARRAY[
    'rm_analytics_cutover_immutable()', 'rm_analytics_output_ledger_immutable()',
    'rm_analytics_overwrite_event_immutable()', 'rm_analytics_run_ledger_immutable()',
    'rm_capture_analytics_overwrite()', 'rm_source_ledger_immutable()'
  ];
  fn text;
  -- Tables a later migration narrowed on purpose; the sweep below must not hand them
  -- back. 0056 revoked ALL on `analytics_overwrite_events` from rm_app/rm_worker;
  -- 0063 left the runtime roles SELECT only on `deployment_identity`, which §4.2
  -- makes "writable only by rm_owner".
  -- 0064 added `schema_manifest`, which §8.3 makes "a trusted input to boot
  -- decisions" writable only by rm_owner. It is listed here rather than left to the
  -- ordinary sweep because the sweep would hand rm_app INSERT and UPDATE on it on
  -- every single run -- that is, it would grant the application the ability to forge
  -- the answer preflight check 3a trusts. SELECT is restored below, because §7.2
  -- has every database-holding container run check 3a under its own credential.
  -- 0069 added `automation_tokens`, the API automation-credential store (smoke
  -- spec §3). Same reasoning as `schema_manifest`: the ordinary sweep would hand
  -- rm_app INSERT and UPDATE on the very rows that decide whether a presented
  -- bearer is authorized, so the application could mint itself a credential. It is
  -- provisioned by rm_owner and only ever READ at runtime. The rows hold a sha256
  -- hash and a rights list, never a secret, so SELECT is no wider a capability than
  -- the reader roles already hold over `admin_credential`.
  -- 0076 narrowed `schema_migrations`, the ledger, for `schema_manifest`'s reason:
  -- §8.3 says "Only `rm_owner` may write it or the ledger's `compat`/
  -- `metadata_version` columns; they are trusted inputs to boot decisions". The
  -- sweep used to hand rm_app INSERT and UPDATE on it every run, so a runtime role
  -- could have recorded a migration that never ran or relabelled a breaking one
  -- additive. Every ledger writer is the migrate step, as rm_owner.
  read_only_for_runtime text[] := ARRAY[
    'analytics_overwrite_events', 'deployment_identity', 'schema_manifest', 'automation_tokens',
    'schema_migrations'
  ];
  -- The subset of `read_only_for_runtime` whose SELECT is restored to rm_app and
  -- rm_worker after the REVOKE ALL below. Not optional for `schema_migrations`: the
  -- api's append-only guard reads the ledger at boot (src/db/append-only-guard.ts),
  -- and §7.2 has every database-holding container run preflight check 3, which
  -- reads the ledger and the manifest (src/db/schema-manifest.ts), under its own
  -- credential. Dropping a name from this list stops those boots.
  select_for_runtime text[] := ARRAY['deployment_identity', 'schema_manifest', 'automation_tokens', 'schema_migrations'];
  -- The immutable analytics ledgers (LEDGER_FAMILIES in
  -- src/db/analytics-ledger-guard.ts). Their migrations granted rm_app exactly
  -- `SELECT, INSERT` (0057:108, 0058:137, 0059:113, 0060:76), and each family's
  -- trigger refuses UPDATE, DELETE and TRUNCATE. The ordinary sweep handed rm_app
  -- UPDATE on every one of them on every run, which left the trigger as the only
  -- protection; 0077 took that back. Listed here so reconciliation re-asserts the
  -- migrations' grant instead of undoing it. DELETE and TRUNCATE are revoked too:
  -- D53 decision 6 counts these ledgers as append-only for preflight check 2.
  insert_only_for_runtime text[] := ARRAY[
    'source_acquisitions', 'source_acquisition_events', 'source_payloads', 'source_fetches',
    'source_value_versions',
    'analytics_ledger_methodology_versions', 'analytics_ledger_runs', 'analytics_ledger_run_events',
    'analytics_data_vintages', 'analytics_vintage_members',
    'analytics_output_snapshots', 'analytics_report_snapshots', 'swarm_brief_revisions',
    'analytics_parity_observations'
  ];
  rel record;
  usurped text;
BEGIN
  -- Ownership first, because a relation owned by a RUNTIME role is check 2's
  -- `object_ownership` denylist rule (§7 check 2) and reconciliation must not
  -- quietly succeed around it: the grants it would then reconcile are not the
  -- privileges that relation is actually governed by, since its owner can
  -- re-grant at will. Relations owned by the cluster's provisioning login are a
  -- different thing -- that is the pre-0053 state 0053's own sweep moves, not a
  -- runtime role holding authority it should never have -- so they are left to
  -- that migration rather than failed on here.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO usurped
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'S')
    AND c.relowner IN ('rm_app'::regrole, 'rm_worker'::regrole, 'rm_readonly'::regrole);
  IF usurped IS NOT NULL THEN
    RAISE EXCEPTION 'grant reconciliation refuses: % is owned by a runtime role, not rm_owner', usurped;
  END IF;

  FOR rel IN
    SELECT c.oid::regclass AS ident, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relowner = 'rm_owner'::regrole  -- §8.1: "for objects `rm_owner` owns"
      AND d.objid IS NULL  -- provider-managed: extension-owned relations are not ours
    ORDER BY c.relname
  LOOP
    IF rel.name = ANY(read_only_for_runtime) THEN
      -- A later migration deliberately narrowed these to SELECT (0063 on
      -- `deployment_identity`, 0064 on `schema_manifest`) or to nothing at all for
      -- the writing roles (0056 on `analytics_overwrite_events`). Reconciliation
      -- must RE-ASSERT that narrowing, not undo it: a sweep that hands every table
      -- back to rm_app would quietly widen the tables whose whole point is that the
      -- application cannot write them, and it would do so on every run.
      EXECUTE format('REVOKE ALL ON %s FROM rm_app, rm_worker', rel.ident);
      IF rel.name = ANY(select_for_runtime) THEN
        EXECUTE format('GRANT SELECT ON %s TO rm_app, rm_worker', rel.ident);
      END IF;
      EXECUTE format('GRANT SELECT ON %s TO rm_readonly', rel.ident);
    ELSIF rel.name = ANY(insert_only_for_runtime) THEN
      -- rm_worker's SELECT on these (0062) is its allowlist's business and is
      -- left alone; only the write privileges no migration granted are taken.
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM rm_app, rm_worker', rel.ident);
      EXECUTE format('GRANT SELECT, INSERT ON %s TO rm_app', rel.ident);
      EXECUTE format('GRANT SELECT ON %s TO rm_readonly', rel.ident);
    ELSIF rel.name = 'swarm_recommendations' THEN
      -- D51 (migration 0075): a take's content is never UPDATEd, and the final
      -- flag is the one column the accepting transaction sets and unsets. The
      -- table-level REVOKE also drops column grants, so it runs first and the
      -- column GRANT second — every run, so a hand-widened UPDATE does not survive.
      EXECUTE format('REVOKE UPDATE ON %s FROM rm_app, rm_worker', rel.ident);
      EXECUTE format('GRANT SELECT, INSERT ON %s TO rm_app', rel.ident);
      EXECUTE format('GRANT UPDATE (final) ON %s TO rm_app', rel.ident);
      EXECUTE format('GRANT SELECT ON %s TO rm_readonly', rel.ident);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO rm_app', rel.ident);
      EXECUTE format('GRANT SELECT ON %s TO rm_readonly', rel.ident);
    END IF;
    -- rm_worker, exactly as the migrations leave it: DML on its allowlist,
    -- SELECT everywhere else. The read-only-for-runtime tables were settled in
    -- their own branch above (SELECT on the select list, nothing otherwise) and
    -- are not touched again here. TRUNCATE is never the worker's.
    IF NOT rel.name = ANY(read_only_for_runtime) THEN
      IF rel.name = ANY(worker_dml) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO rm_worker', rel.ident);
        EXECUTE format('REVOKE TRUNCATE ON %s FROM rm_worker', rel.ident);
      ELSIF rel.name = ANY(worker_insert_update) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO rm_worker', rel.ident);
        EXECUTE format('REVOKE DELETE, TRUNCATE ON %s FROM rm_worker', rel.ident);
      ELSE
        EXECUTE format('GRANT SELECT ON %s TO rm_worker', rel.ident);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %s FROM rm_worker', rel.ident);
      END IF;
    END IF;
    IF rel.name = ANY(append_only) OR rel.name = ANY(runtime_delete_revoked) THEN
      EXECUTE format('REVOKE DELETE, TRUNCATE ON %s FROM rm_app, rm_worker', rel.ident);
    END IF;
  END LOOP;

  -- Sequences: rm_app writes, so it needs the serial columns' sequences; rm_readonly
  -- reads `last_value` (migration 0062); rm_worker reads every one and uses the
  -- ones behind its own inserts (`worker_sequence_usage`), nothing more.
  FOR rel IN
    SELECT c.oid::regclass AS ident, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND d.objid IS NULL
      AND c.relowner = 'rm_owner'::regrole
    ORDER BY c.relname
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO rm_app', rel.ident);
    EXECUTE format('GRANT SELECT ON SEQUENCE %s TO rm_readonly', rel.ident);
    IF rel.name = ANY(worker_sequence_usage) THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO rm_worker', rel.ident);
    ELSE
      EXECUTE format('GRANT SELECT ON SEQUENCE %s TO rm_worker', rel.ident);
      EXECUTE format('REVOKE USAGE, UPDATE ON SEQUENCE %s FROM rm_worker', rel.ident);
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ledger_guard_functions LOOP
    IF to_regprocedure('public.' || fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', fn);
    END IF;
  END LOOP;
END
$$;

-- Schema usage, and nothing that grants DDL: 0053 revoked ALL on `public` from PUBLIC
-- and granted only USAGE, which is what the `ddl` denylist rule tests.
GRANT USAGE ON SCHEMA public TO rm_app, rm_worker, rm_readonly;

-- Future objects created by rm_owner: READ ONLY, for every runtime role. 0053 says
-- "There are no default write grants. A later migration must name every new runtime
-- capability explicitly, making a missing grant fail closed", and 0062 set exactly
-- SELECT for rm_app and rm_worker. This file used to add a default
-- `GRANT SELECT, INSERT, UPDATE ON TABLES TO rm_app`, which contradicted that rule on
-- every run; the REVOKE takes it back from every database that reconciled under it.
-- Existing tables are unaffected: the sweep above grants each one's runtime
-- privileges explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT ON TABLES TO rm_readonly, rm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public REVOKE INSERT, UPDATE ON TABLES FROM rm_app;
