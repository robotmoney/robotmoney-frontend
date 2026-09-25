-- Issue #1035: compact what the analytics ledger already wrote, and give vintage
-- membership a representation that does not copy itself on every freeze.
--
-- WHY. Between the v0.5.0 cutover (2026-09-21) and 2026-09-24 the production
-- database grew from ~40 MB to 6.1 GB. Nearly all of it was ledger duplication:
--   * source_value_versions — a row per point per fetch. 67% were
--     revision_kind='unchanged' (every fetch re-records a series' full history);
--     most of the rest were 'revision' rows a relative 1e-9..1e-6 off their
--     prior (Yahoo's float32 jitter compared with exact Number equality).
--   * analytics_vintage_members — ~172k member rows copied per vintage.
--   * analytics_overwrite_events — ~350k/day raw_indicator_history rewrites
--     that differed only by that same noise.
--   * source_payloads — every fetch's whole response body, ~200 MB/day.
-- The writers stop doing this in the same release (store/source-ledger-store.ts,
-- store/raw-history-store.ts, store/run-ledger-store.ts; tolerances in
-- analytics/source-tolerance.ts, decision D56). This migration removes what they
-- already wrote, under the SAME rule, without changing anything a reader can
-- observe:
--
--   1. every EXISTING vintage resolves to the identical set of
--      source_value_versions ids, so its manifest_digest replays bit for bit;
--   2. every series head (the version no later version supersedes) is kept, with
--      its value, provenance and knowledge_time;
--   3. every ledger immutability guard is re-armed before this transaction ends.
--
-- The whole file runs in the migration runner's single transaction
-- (src/db/migrate.ts). ALTER TABLE ... ADD COLUMN takes an ACCESS EXCLUSIVE
-- lock on analytics_vintage_members, and DISABLE TRIGGER a SHARE ROW EXCLUSIVE
-- lock on the other two tables, so no other session can write to any of them
-- while a guard is off; if anything below raises, the guards were never off at
-- all.
--
-- One reader-visible effect is deliberate: a NEW vintage frozen later with a
-- knowledge-time cutoff from before this migration selects the kept version
-- instead of a dropped re-observation — a different id and knowledge_time,
-- the same value within tolerance. Vintages that already exist are unchanged.
-- A version re-linked to an earlier prior keeps its original revision_kind.
--
-- Space: this file only DELETEs, which leaves dead tuples and returns no disk.
-- The migration runner reclaims it right after this transaction commits with
-- VACUUM FULL of the three compacted tables (reclaimAfterMigrations in
-- src/db/migrate.ts), which cannot run inside a transaction.
--
-- No GRANT or REVOKE is issued: the new column is covered by the table-level
-- grants 0058 and 0062 already made, and the grants on source_payloads go with
-- the table when step 6 drops it.
--
-- NUMBERED 0080, not 0063: 0063 is taken on the v0.5.1 release branch
-- (0063_swarm_judge_model_default) and 0063-0079 on the deployment-refactor
-- branch (issue #1026). A filename no other branch uses keeps this file's
-- schema_migrations key unique whichever of them lands first.

-- ── 1. Vintage membership as runs of consecutive version ids ────────────────
-- A member row now covers [source_value_version_id, last_source_value_version_id]
-- — every id in that range, all under the row's source_key (see memberRanges in
-- store/run-ledger-store.ts). NULL is the single-id row every vintage frozen
-- before this migration has, so an unconverted row still reads correctly.
ALTER TABLE analytics_vintage_members
  ADD COLUMN last_source_value_version_id bigint
    CONSTRAINT analytics_vintage_members_last_version_fkey REFERENCES source_value_versions(id),
  ADD CONSTRAINT analytics_vintage_members_range_check
    CHECK (last_source_value_version_id IS NULL OR last_source_value_version_id > source_value_version_id);

COMMENT ON COLUMN analytics_vintage_members.last_source_value_version_id IS
  'Issue #1035: when set, this row stands for EVERY source_value_versions id from source_value_version_id to this one inclusive (all consecutive, all under source_key). NULL means the single id source_value_version_id.';

-- Both foreign keys into source_value_versions need an index led by the
-- referencing column: the source_value_versions DELETE below checks each
-- removed id against them, and without one that is a scan of this table per
-- removed row.
CREATE INDEX analytics_vintage_members_version_idx
  ON analytics_vintage_members (source_value_version_id);
CREATE INDEX analytics_vintage_members_last_version_idx
  ON analytics_vintage_members (last_source_value_version_id)
  WHERE last_source_value_version_id IS NOT NULL;

-- ── 2. Disarm exactly the guards this migration needs, for this transaction ──
ALTER TABLE analytics_vintage_members DISABLE TRIGGER analytics_vintage_members_immutable;
ALTER TABLE analytics_vintage_members DISABLE TRIGGER analytics_vintage_members_immutable_row;
ALTER TABLE source_value_versions DISABLE TRIGGER source_value_versions_immutable;
ALTER TABLE source_value_versions DISABLE TRIGGER source_value_versions_immutable_row;
ALTER TABLE analytics_overwrite_events DISABLE TRIGGER analytics_overwrite_events_append_only;
ALTER TABLE analytics_overwrite_events DISABLE TRIGGER analytics_overwrite_events_append_only_row;

DO $compact$
DECLARE
  -- D56's non-zero tolerances, as of this migration. Every other source_key is
  -- compared exactly — the same default analytics/source-tolerance.ts applies —
  -- so a key missing here can only KEEP a row, never lose one.
  tol constant jsonb := '{
    "raw_indicator_history:VIX": 1e-6,
    "raw_indicator_history:COPPER_GOLD": 1e-6,
    "raw_indicator_history:SPX_TREND": 1e-6,
    "raw_indicator_history:IWM_SPY": 1e-6,
    "raw_indicator_history:BTC_ETH": 1e-6,
    "raw_indicator_history:ETH_TREND": 1e-6,
    "raw_indicator_history:SPHB_SPLV": 1e-6,
    "raw_indicator_history:MTUM_SPY": 1e-6,
    "raw_indicator_history:IWF_IWD": 1e-6,
    "raw_indicator_history:XLU_SPY": 1e-6,
    "raw_indicator_history:XLP_XLY": 1e-6,
    "research:BTC-USD": 1e-6,
    "research:QQQ": 1e-6,
    "research:SPY": 1e-6,
    "research:RSP": 1e-6,
    "research:NVDA": 1e-6,
    "research:MSFT": 1e-6,
    "research:AAPL": 1e-6,
    "research:GOOGL": 1e-6,
    "research:AMZN": 1e-6,
    "research:META": 1e-6,
    "research:AVGO": 1e-6,
    "backtest:^GSPC": 1e-6,
    "backtest:ETH-USD": 1e-6
  }'::jsonb;

  r record;
  in_group boolean := false;
  cur_key text;
  cur_date date;
  cur_instant timestamptz;
  kept_id bigint;
  kept_value double precision;
  kept_provenance text;
  pending_id bigint;
  pending_prior bigint;
  drop_ids bigint[] := '{}';
  relink_ids bigint[] := '{}';
  relink_to bigint[] := '{}';

  members_before jsonb;
  members_after jsonb;
  heads_before jsonb;
  heads_after jsonb;
BEGIN
  -- Fingerprints of what must NOT change, taken before anything moves: each
  -- vintage's resolved member-id count and sum (the same resolution
  -- loadFrozenVintage performs), and the full set of series heads.
  --
  -- Runs are expanded with generate_series and joined on the id ALONE. Any
  -- source_key term in the join lets the planner reach source_value_versions
  -- through its source_key index instead — every version of a member's key,
  -- once per member (~43 keys) — which a scale rehearsal measured as
  -- quadratic, about a day on the production ledger. `svv.id BETWEEN first
  -- AND last` has the same effect. So the key check is an aggregate FILTER,
  -- never a join condition: a row it rejects changes the count, and the
  -- comparison below refuses to commit. The version is fetched by a LATERAL
  -- subquery with LIMIT 1, which the planner cannot flatten into a join: it
  -- stays one primary-key probe per member id. (A plain `JOIN ... ON svv.id =
  -- g.id` is free to become a hash join rebuilt per member row once the hash
  -- no longer fits in work_mem — quadratic again at production size.)
  SELECT COALESCE(jsonb_object_agg(vintage_id, jsonb_build_array(n, s)), '{}'::jsonb) INTO members_before
  FROM (SELECT vm.vintage_id,
               count(*) FILTER (WHERE svv.source_key = vm.source_key) AS n,
               sum(svv.id) FILTER (WHERE svv.source_key = vm.source_key) AS s
        FROM analytics_vintage_members vm
        CROSS JOIN LATERAL generate_series(
          vm.source_value_version_id,
          COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) AS g(id)
        CROSS JOIN LATERAL (
          SELECT v.id, v.source_key FROM source_value_versions v WHERE v.id = g.id LIMIT 1
        ) svv
        GROUP BY vm.vintage_id) m;
  SELECT jsonb_build_array(count(*), COALESCE(sum(s.id), 0),
                           COALESCE(sum(hashtextextended(s.source_key || '|' || COALESCE(s.market_date::text, '') || '|' ||
                                                         COALESCE(s.market_instant::text, '') || '|' || s.value::text || '|' ||
                                                         COALESCE(s.provenance, '') || '|' || s.knowledge_time::text, 0)), 0))
    INTO heads_before
  FROM source_value_versions s
  WHERE NOT EXISTS (SELECT 1 FROM source_value_versions n WHERE n.prior_version_id = s.id);

  -- ── 3. Collapse each vintage's member rows into runs ──────────────────────
  -- Gaps-and-islands: within one (vintage, source_key), ids that are
  -- consecutive integers share (id - row_number). Only runs of two or more
  -- change: the first row is widened to cover the run, the rest are removed.
  -- One statement, so the DELETE reads the same pre-statement snapshot the
  -- run boundaries were computed from.
  WITH ordered AS (
    SELECT vintage_id, source_key, source_value_version_id AS version_id,
           source_value_version_id
             - row_number() OVER (PARTITION BY vintage_id, source_key ORDER BY source_value_version_id) AS run_key
    FROM analytics_vintage_members
    WHERE last_source_value_version_id IS NULL
  ), runs AS (
    SELECT vintage_id, source_key, min(version_id) AS first_id, max(version_id) AS last_id
    FROM ordered
    GROUP BY vintage_id, source_key, run_key
    HAVING count(*) > 1
  ), widened AS (
    UPDATE analytics_vintage_members vm
    SET last_source_value_version_id = rn.last_id
    FROM runs rn
    WHERE vm.vintage_id = rn.vintage_id AND vm.source_value_version_id = rn.first_id
    RETURNING vm.id
  )
  DELETE FROM analytics_vintage_members vm
  USING runs rn
  WHERE vm.vintage_id = rn.vintage_id
    AND vm.source_key = rn.source_key
    AND vm.source_value_version_id > rn.first_id
    AND vm.source_value_version_id <= rn.last_id;

  -- ── 4. Replay every version chain under the new writer's rule ─────────────
  -- Walk each (source_key, market coordinate) oldest first, holding the last
  -- KEPT version. A later version is dropped only when ALL of these hold:
  --   * no vintage references it (a vintage's digest hashes its exact id);
  --   * its value is within the source's tolerance of the kept version, and
  --     its provenance label is the same — i.e. the writer shipped with this
  --     migration would not have written it;
  --   * it is not the coordinate's head (heads are what current reads return).
  -- A kept version whose prior was dropped is re-linked to the kept version
  -- before it, so prior_version_id stays one unbroken chain.
  --
  -- A coordinate whose stored chain does not follow its own (knowledge_time,
  -- id) order is left exactly as it is: this replay's notion of "the version
  -- before" would not be the chain's, so it is not safe to touch.
  FOR r IN
    WITH referenced AS (
      SELECT DISTINCT generate_series(
               vm.source_value_version_id,
               COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) AS id
      FROM analytics_vintage_members vm
    ), chained AS (
      SELECT s.id, s.source_key, s.market_date, s.market_instant, s.value, s.provenance,
             s.prior_version_id, s.knowledge_time,
             lag(s.id) OVER coordinate AS previous_id
      FROM source_value_versions s
      WINDOW coordinate AS (PARTITION BY s.source_key, s.market_date, s.market_instant
                            ORDER BY s.knowledge_time, s.id)
    ), flagged AS (
      SELECT c.*,
             bool_or(c.prior_version_id IS DISTINCT FROM c.previous_id)
               OVER (PARTITION BY c.source_key, c.market_date, c.market_instant) AS irregular
      FROM chained c
    )
    SELECT f.id, f.source_key, f.market_date, f.market_instant, f.value, f.provenance, f.prior_version_id,
           COALESCE((tol ->> f.source_key)::double precision, 0) AS relative,
           (ref.id IS NOT NULL) AS referenced
    FROM flagged f
    LEFT JOIN referenced ref ON ref.id = f.id
    WHERE NOT f.irregular
    ORDER BY f.source_key, f.market_date, f.market_instant, f.knowledge_time, f.id
  LOOP
    IF NOT in_group
       OR r.source_key <> cur_key
       OR r.market_date IS DISTINCT FROM cur_date
       OR r.market_instant IS DISTINCT FROM cur_instant THEN
      -- The previous coordinate ended on a droppable version: that version is
      -- its head, so it stays, re-linked to the last kept version.
      IF pending_id IS NOT NULL THEN
        IF pending_prior IS DISTINCT FROM kept_id THEN
          relink_ids := array_append(relink_ids, pending_id);
          relink_to := array_append(relink_to, kept_id);
        END IF;
        pending_id := NULL;
      END IF;
      in_group := true;
      cur_key := r.source_key;
      cur_date := r.market_date;
      cur_instant := r.market_instant;
      kept_id := r.id;
      kept_value := r.value;
      kept_provenance := r.provenance;
      CONTINUE;
    END IF;

    -- A later version exists, so the pending one was not the head: it goes.
    IF pending_id IS NOT NULL THEN
      drop_ids := array_append(drop_ids, pending_id);
      pending_id := NULL;
    END IF;

    IF r.referenced
       OR r.provenance IS DISTINCT FROM kept_provenance
       OR NOT (r.value = kept_value
               OR abs(r.value - kept_value) <= r.relative * greatest(abs(r.value), abs(kept_value))) THEN
      IF r.prior_version_id IS DISTINCT FROM kept_id THEN
        relink_ids := array_append(relink_ids, r.id);
        relink_to := array_append(relink_to, kept_id);
      END IF;
      kept_id := r.id;
      kept_value := r.value;
      kept_provenance := r.provenance;
    ELSE
      pending_id := r.id;
      pending_prior := r.prior_version_id;
    END IF;
  END LOOP;
  IF pending_id IS NOT NULL AND pending_prior IS DISTINCT FROM kept_id THEN
    relink_ids := array_append(relink_ids, pending_id);
    relink_to := array_append(relink_to, kept_id);
  END IF;

  -- Detach, delete, re-attach — in that order. prior_version_id is both a
  -- foreign key (a kept row may not point at a deleted one) and unique (a
  -- version has one successor), so re-linking before the delete would give a
  -- kept version two successors for the length of one statement.
  UPDATE source_value_versions s SET prior_version_id = NULL
  FROM unnest(relink_ids) AS m(id)
  WHERE s.id = m.id;
  DELETE FROM source_value_versions s
  USING unnest(drop_ids) AS d(id)
  WHERE s.id = d.id;
  UPDATE source_value_versions s SET prior_version_id = m.prior_id
  FROM unnest(relink_ids, relink_to) AS m(id, prior_id)
  WHERE s.id = m.id;

  -- ── 5. Overwrite evidence that recorded only noise ────────────────────────
  -- A raw_indicator_history UPDATE whose old and new rows are identical except
  -- for a value within the indicator's tolerance: exactly the rewrite
  -- store/raw-history-store.ts no longer performs. A label change, or any
  -- change beyond tolerance, is material and stays.
  DELETE FROM analytics_overwrite_events e
  WHERE e.table_name = 'raw_indicator_history'
    AND e.operation = 'update'
    AND (e.previous_row - 'value') = (e.replacement_row - 'value')
    AND ((e.previous_row ->> 'value')::double precision = (e.replacement_row ->> 'value')::double precision
         OR abs((e.previous_row ->> 'value')::double precision - (e.replacement_row ->> 'value')::double precision)
            <= COALESCE((tol ->> ('raw_indicator_history:' || (e.previous_row ->> 'indicator')))::double precision, 0)
               * greatest(abs((e.previous_row ->> 'value')::double precision),
                          abs((e.replacement_row ->> 'value')::double precision)));

  -- ── Proof, inside the transaction: refuse to commit a changed reading ─────
  SELECT COALESCE(jsonb_object_agg(vintage_id, jsonb_build_array(n, s)), '{}'::jsonb) INTO members_after
  FROM (SELECT vm.vintage_id,
               count(*) FILTER (WHERE svv.source_key = vm.source_key) AS n,
               sum(svv.id) FILTER (WHERE svv.source_key = vm.source_key) AS s
        FROM analytics_vintage_members vm
        CROSS JOIN LATERAL generate_series(
          vm.source_value_version_id,
          COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) AS g(id)
        CROSS JOIN LATERAL (
          SELECT v.id, v.source_key FROM source_value_versions v WHERE v.id = g.id LIMIT 1
        ) svv
        GROUP BY vm.vintage_id) m;
  IF members_after IS DISTINCT FROM members_before THEN
    RAISE EXCEPTION 'issue #1035 compaction would change vintage membership (before %, after %)',
      left(members_before::text, 500), left(members_after::text, 500);
  END IF;

  SELECT jsonb_build_array(count(*), COALESCE(sum(s.id), 0),
                           COALESCE(sum(hashtextextended(s.source_key || '|' || COALESCE(s.market_date::text, '') || '|' ||
                                                         COALESCE(s.market_instant::text, '') || '|' || s.value::text || '|' ||
                                                         COALESCE(s.provenance, '') || '|' || s.knowledge_time::text, 0)), 0))
    INTO heads_after
  FROM source_value_versions s
  WHERE NOT EXISTS (SELECT 1 FROM source_value_versions n WHERE n.prior_version_id = s.id);
  IF heads_after IS DISTINCT FROM heads_before THEN
    RAISE EXCEPTION 'issue #1035 compaction would change series heads (before %, after %)', heads_before, heads_after;
  END IF;
END;
$compact$;

-- ── 6. Stop keeping raw response bodies: drop source_payloads ───────────────
-- Every fetch returns a series' WHOLE history, so every new day or jittered
-- point stored the full history again as a new content-addressed blob — about
-- 200 MB a day, never deleted, and read by nothing. The ledger's job is to
-- catch and tag revised source data, which source_value_versions does; the
-- bodies duplicated it (decision D56). source_fetches.response_checksum stays
-- as a plain fingerprint of what each response contained; only its foreign
-- key into the dropped table goes. DROP TABLE removes the table's own
-- immutability triggers with it; the guard inventories
-- (src/db/analytics-ledger-guard.ts, src/db/append-only-guard.ts) no longer
-- list it, so both still report armed.
ALTER TABLE source_fetches DROP CONSTRAINT source_fetches_response_checksum_fkey;
DROP TABLE source_payloads;

COMMENT ON COLUMN source_fetches.response_checksum IS
  'SHA-256 of the response body, a fingerprint only. The body itself is not stored (issue #1035, decision D56; source_payloads dropped by migration 0080).';

-- ── 7. Re-arm every guard disarmed above, as ENABLE ALWAYS ──────────────────
ALTER TABLE analytics_vintage_members ENABLE ALWAYS TRIGGER analytics_vintage_members_immutable;
ALTER TABLE analytics_vintage_members ENABLE ALWAYS TRIGGER analytics_vintage_members_immutable_row;
ALTER TABLE source_value_versions ENABLE ALWAYS TRIGGER source_value_versions_immutable;
ALTER TABLE source_value_versions ENABLE ALWAYS TRIGGER source_value_versions_immutable_row;
ALTER TABLE analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_append_only;
ALTER TABLE analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_append_only_row;
