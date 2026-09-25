-- Issues #1035 and #1050: return the analytics ledger to the state the fixed
-- writers would have left it in, as if the re-observation / float-noise bug had
-- never shipped, and give vintage membership a representation that does not copy
-- itself on every freeze.
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
-- analytics/source-tolerance.ts, decision D56).
--
-- THE OWNER'S RULE (issue #1050, 2026-09-25): the database must end in the
-- state it would have been in if the bug had never been introduced, with no
-- mapping table, old-digest column or other trace of the repair left behind.
-- So this migration REPLAYS the fixed writers' rules over what the old writers
-- recorded, oldest first:
--
--   1. source_value_versions keeps exactly the rows the fixed writer would have
--      written — each with its original id, acquisition, knowledge_time and
--      provenance — re-linked by prior_version_id to the previous kept row, with
--      the revision_kind (and, for a relabel within tolerance, the head value)
--      the fixed writer would have assigned. Every other row is deleted,
--      INCLUDING rows a vintage referenced and a series head that was only a
--      re-observation.
--   2. Every vintage is re-pointed, coordinate by coordinate, from the row it
--      froze to the row the fixed writer's head was at that moment: the last
--      kept row at or before it in the coordinate's (knowledge_time, id) order.
--      That keeps the frozen membership's exact shape (one member per
--      coordinate, same count) without re-running a cutoff selection, which D56
--      rejects because an insert in flight at freeze time can commit later with
--      an earlier knowledge_time.
--   3. raw_indicator_history and its overwrite evidence are replayed the same
--      way, so the evidence holds only the rewrites the fixed raw writer would
--      have made, and each row holds the value and label it would have left.
--   4. Every vintage's manifest, series fingerprints, member_count and
--      manifest_digest are then recomputed from its re-pointed members. That
--      step is TypeScript, not SQL (a canonical-JSON SHA-256 in plpgsql would
--      have to reproduce JavaScript's number formatting byte for byte), and runs
--      in THIS transaction, straight after this file, from the migration runner
--      (IN_TRANSACTION_AFTER_MIGRATION in src/db/migrate.ts →
--      rebuildVintageManifests in src/analytics/store/run-ledger-store.ts).
--      The old digests are overwritten, not kept anywhere.
--
-- Every scratch table below is TEMP ... ON COMMIT DROP: it lives for this
-- transaction only and leaves nothing in the schema.
--
-- The whole file runs in the migration runner's single transaction
-- (src/db/migrate.ts). ALTER TABLE takes a lock on each table whose guard it
-- disarms, so no other session can write to any of them while a guard is off;
-- if anything below raises, the transaction rolls back and the guards were
-- never off at all.
--
-- A coordinate whose stored chain does not follow its own (knowledge_time, id)
-- order is left exactly as it is: no writer order can be recovered for it, so
-- no replay of it is safe (decision D56, amendment for #1050).
--
-- Space: this file only DELETEs and UPDATEs, which leaves dead tuples and
-- returns no disk. The migration runner reclaims it right after this
-- transaction commits with VACUUM FULL of the three compacted tables
-- (reclaimAfterMigrations in src/db/migrate.ts), which cannot run inside a
-- transaction.
--
-- No GRANT or REVOKE is issued: the new column is covered by the table-level
-- grants 0058 and 0062 already made, and the grants on source_payloads go with
-- the table when step 7 drops it.
--
-- EXTENDED IN PLACE for #1050, not a new migration: 0080 had not been recorded
-- by any persistent database when #1050 extended it (production's ledger ends
-- at 0062; the stage hosts run branches without 0080; only ephemeral test
-- databases had applied it).
--
-- NUMBERED 0080, not 0063: 0063 is taken on the v0.5.1 release branch
-- (0063_swarm_judge_model_default) and 0063-0079 on the deployment-refactor
-- branch (issue #1026). A filename no other branch uses keeps this file's
-- schema_migrations key unique whichever of them lands first.

-- ── 1. Vintage membership as runs of consecutive version ids ────────────────
-- A member row now covers [source_value_version_id, last_source_value_version_id]
-- — every id in that range, all under the row's source_key (see memberRanges in
-- store/run-ledger-store.ts). NULL is the single-id row.
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
ALTER TABLE analytics_overwrite_events DISABLE TRIGGER analytics_overwrite_events_immutable;
ALTER TABLE analytics_overwrite_events DISABLE TRIGGER analytics_overwrite_events_immutable_row;
-- The repair's own raw_indicator_history rewrite is not an overwrite the fixed
-- writer made, so it must not record evidence of one.
ALTER TABLE raw_indicator_history DISABLE TRIGGER raw_indicator_history_capture_overwrite;

-- ── 3. Scratch state for this transaction only ─────────────────────────────
-- Every version the fixed writer would not have written, and the kept version
-- its coordinate's head was when it was recorded.
CREATE TEMP TABLE ledger_repair_dropped (
  id bigint PRIMARY KEY,
  kept_id bigint NOT NULL
) ON COMMIT DROP;
-- Every kept version whose prior_version_id, revision_kind or value changes.
CREATE TEMP TABLE ledger_repair_relinked (
  id bigint PRIMARY KEY,
  prior_version_id bigint NOT NULL,
  revision_kind text NOT NULL,
  value double precision NOT NULL
) ON COMMIT DROP;
-- The re-pointed membership, as runs.
CREATE TEMP TABLE ledger_repair_members (
  vintage_id bigint NOT NULL,
  source_key text NOT NULL,
  first_id bigint NOT NULL,
  last_id bigint NOT NULL
) ON COMMIT DROP;
-- What must NOT change, taken before anything moves.
CREATE TEMP TABLE ledger_repair_member_counts (
  vintage_id bigint PRIMARY KEY,
  members bigint NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE ledger_repair_heads (
  heads bigint NOT NULL,
  fingerprint numeric NOT NULL
) ON COMMIT DROP;

-- Each vintage's resolved member count (the resolution loadFrozenVintage
-- performs). Re-pointing maps each member to one row of the SAME coordinate, so
-- this count cannot change.
--
-- Runs are expanded with generate_series and joined on the id ALONE. Any
-- source_key term in the join lets the planner reach source_value_versions
-- through its source_key index instead — every version of a member's key,
-- once per member — which a scale rehearsal measured as quadratic, about a day
-- on the production ledger. `svv.id BETWEEN first AND last` has the same
-- effect. So the key check is an aggregate FILTER, never a join condition. The
-- version is fetched by a LATERAL subquery with LIMIT 1, which the planner
-- cannot flatten into a join: it stays one primary-key probe per member id.
INSERT INTO ledger_repair_member_counts (vintage_id, members)
SELECT vm.vintage_id, count(*) FILTER (WHERE svv.source_key = vm.source_key)
FROM analytics_vintage_members vm
CROSS JOIN LATERAL generate_series(
  vm.source_value_version_id,
  COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) AS g(id)
CROSS JOIN LATERAL (
  SELECT v.id, v.source_key FROM source_value_versions v WHERE v.id = g.id LIMIT 1
) svv
GROUP BY vm.vintage_id;

-- Every coordinate keeps exactly one head, under the same provenance label: a
-- dropped row always carries its kept head's label, and its value is within
-- tolerance of it.
INSERT INTO ledger_repair_heads (heads, fingerprint)
SELECT count(*),
       COALESCE(sum(hashtextextended(s.source_key || '|' || COALESCE(s.market_date::text, '') || '|' ||
                                     COALESCE(s.market_instant::text, '') || '|' || COALESCE(s.provenance, ''), 0)), 0)
FROM source_value_versions s
WHERE NOT EXISTS (SELECT 1 FROM source_value_versions n WHERE n.prior_version_id = s.id);

-- ── 4. Replay the fixed writers over what the old writers recorded ─────────
DO $replay$
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
  -- Scratch rows are flushed to their TEMP table in batches, so memory stays
  -- bounded however many versions the old writer left.
  batch constant integer := 50000;

  r record;
  in_group boolean := false;
  cur_key text;
  cur_date date;
  cur_instant timestamptz;
  kept_id bigint;
  kept_value double precision;
  kept_provenance text;
  same boolean;
  next_kind text;
  next_value double precision;
  drop_ids bigint[] := '{}';
  drop_to bigint[] := '{}';
  fix_ids bigint[] := '{}';
  fix_prior bigint[] := '{}';
  fix_kind text[] := '{}';
  fix_value double precision[] := '{}';

  e record;
  ev_indicator text;
  ev_date text;
  state jsonb;
  recorded jsonb;
  next_state jsonb;
  relative double precision;
  sv double precision;
  rv double precision;
  ev_drop bigint[] := '{}';
  ev_fix_ids bigint[] := '{}';
  ev_fix_previous jsonb[] := '{}';
  ev_fix_replacement jsonb[] := '{}';
  raw_indicator text[] := '{}';
  raw_date date[] := '{}';
  raw_value double precision[] := '{}';
  raw_source text[] := '{}';
BEGIN
  -- 4a. source_value_versions. Walk each (source_key, market coordinate) oldest
  -- first, holding the head the FIXED writer would have had (the last kept
  -- version). Each later version is classified exactly as
  -- store/source-ledger-store.ts classify() does against that head:
  --   * within tolerance, same provenance label  → not written: dropped;
  --   * within tolerance, a new label            → 'unchanged', head's value;
  --   * outside tolerance                        → 'revision', its own value;
  -- and chained to that head. The first version of a coordinate is written by
  -- any writer, so it is always kept as it is.
  FOR r IN
    WITH chained AS (
      SELECT s.id, s.source_key, s.market_date, s.market_instant, s.value, s.provenance,
             s.prior_version_id, s.revision_kind, s.knowledge_time,
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
    SELECT f.id, f.source_key, f.market_date, f.market_instant, f.value, f.provenance,
           f.prior_version_id, f.revision_kind,
           COALESCE((tol ->> f.source_key)::double precision, 0) AS relative
    FROM flagged f
    WHERE NOT f.irregular
    ORDER BY f.source_key, f.market_date, f.market_instant, f.knowledge_time, f.id
  LOOP
    IF NOT in_group
       OR r.source_key <> cur_key
       OR r.market_date IS DISTINCT FROM cur_date
       OR r.market_instant IS DISTINCT FROM cur_instant THEN
      in_group := true;
      cur_key := r.source_key;
      cur_date := r.market_date;
      cur_instant := r.market_instant;
      kept_id := r.id;
      kept_value := r.value;
      kept_provenance := r.provenance;
      CONTINUE;
    END IF;

    same := r.value = kept_value
            OR abs(r.value - kept_value) <= r.relative * greatest(abs(r.value), abs(kept_value));
    IF same AND r.provenance IS NOT DISTINCT FROM kept_provenance THEN
      drop_ids := array_append(drop_ids, r.id);
      drop_to := array_append(drop_to, kept_id);
      IF cardinality(drop_ids) >= batch THEN
        INSERT INTO ledger_repair_dropped (id, kept_id) SELECT * FROM unnest(drop_ids, drop_to);
        drop_ids := '{}';
        drop_to := '{}';
      END IF;
      CONTINUE;
    END IF;

    next_kind := CASE WHEN same THEN 'unchanged' ELSE 'revision' END;
    next_value := CASE WHEN same THEN kept_value ELSE r.value END;
    IF r.prior_version_id IS DISTINCT FROM kept_id OR r.revision_kind <> next_kind OR r.value <> next_value THEN
      fix_ids := array_append(fix_ids, r.id);
      fix_prior := array_append(fix_prior, kept_id);
      fix_kind := array_append(fix_kind, next_kind);
      fix_value := array_append(fix_value, next_value);
      IF cardinality(fix_ids) >= batch THEN
        INSERT INTO ledger_repair_relinked (id, prior_version_id, revision_kind, value)
        SELECT * FROM unnest(fix_ids, fix_prior, fix_kind, fix_value);
        fix_ids := '{}';
        fix_prior := '{}';
        fix_kind := '{}';
        fix_value := '{}';
      END IF;
    END IF;
    kept_id := r.id;
    kept_value := next_value;
    kept_provenance := r.provenance;
  END LOOP;
  INSERT INTO ledger_repair_dropped (id, kept_id) SELECT * FROM unnest(drop_ids, drop_to);
  INSERT INTO ledger_repair_relinked (id, prior_version_id, revision_kind, value)
  SELECT * FROM unnest(fix_ids, fix_prior, fix_kind, fix_value);

  -- 4b. raw_indicator_history and its overwrite evidence. Every rewrite of a
  -- row is on record since 0056 (the capture trigger is ENABLE ALWAYS), so its
  -- evidence, oldest first, is the sequence of values the old raw writer was
  -- handed. Replay store/raw-history-store.ts's fixed rule over it, holding the
  -- row as the fixed writer would have stored it (`state`):
  --   * within tolerance, same label → no rewrite, so no evidence: dropped;
  --   * within tolerance, a new label → only the label moves;
  --   * outside tolerance            → value and label move;
  -- and every kept event records the rewrite the fixed writer made, from the
  -- state it held. A delete ends the row: the next event starts from its own
  -- previous_row.
  FOR e IN
    SELECT id, operation, natural_key ->> 'indicator' AS indicator, natural_key ->> 'date' AS date,
           previous_row, replacement_row
    FROM analytics_overwrite_events
    WHERE table_name = 'raw_indicator_history'
    ORDER BY natural_key ->> 'indicator', natural_key ->> 'date', id
  LOOP
    IF ev_indicator IS DISTINCT FROM e.indicator OR ev_date IS DISTINCT FROM e.date THEN
      IF state IS NOT NULL AND state IS DISTINCT FROM recorded THEN
        raw_indicator := array_append(raw_indicator, ev_indicator);
        raw_date := array_append(raw_date, ev_date::date);
        raw_value := array_append(raw_value, (state ->> 'value')::double precision);
        raw_source := array_append(raw_source, state ->> 'source');
      END IF;
      ev_indicator := e.indicator;
      ev_date := e.date;
      state := NULL;
      recorded := NULL;
    END IF;

    IF e.operation = 'delete' THEN
      IF state IS NOT NULL AND e.previous_row IS DISTINCT FROM state THEN
        ev_fix_ids := array_append(ev_fix_ids, e.id);
        ev_fix_previous := array_append(ev_fix_previous, state);
        ev_fix_replacement := array_append(ev_fix_replacement, NULL::jsonb);
      END IF;
      state := NULL;
      recorded := NULL;
      CONTINUE;
    END IF;

    IF state IS NULL THEN
      state := e.previous_row;
    END IF;
    recorded := e.replacement_row;
    relative := COALESCE((tol ->> ('raw_indicator_history:' || e.indicator))::double precision, 0);
    sv := (state ->> 'value')::double precision;
    rv := (e.replacement_row ->> 'value')::double precision;
    same := rv = sv OR abs(rv - sv) <= relative * greatest(abs(rv), abs(sv));
    IF same AND (e.replacement_row -> 'source') IS NOT DISTINCT FROM (state -> 'source') THEN
      ev_drop := array_append(ev_drop, e.id);
      CONTINUE;
    END IF;
    next_state := jsonb_set(state, '{source}', e.replacement_row -> 'source');
    IF NOT same THEN
      next_state := jsonb_set(next_state, '{value}', e.replacement_row -> 'value');
    END IF;
    IF e.previous_row IS DISTINCT FROM state OR e.replacement_row IS DISTINCT FROM next_state THEN
      ev_fix_ids := array_append(ev_fix_ids, e.id);
      ev_fix_previous := array_append(ev_fix_previous, state);
      ev_fix_replacement := array_append(ev_fix_replacement, next_state);
    END IF;
    state := next_state;
  END LOOP;
  IF state IS NOT NULL AND state IS DISTINCT FROM recorded THEN
    raw_indicator := array_append(raw_indicator, ev_indicator);
    raw_date := array_append(raw_date, ev_date::date);
    raw_value := array_append(raw_value, (state ->> 'value')::double precision);
    raw_source := array_append(raw_source, state ->> 'source');
  END IF;

  DELETE FROM analytics_overwrite_events oe
  USING unnest(ev_drop) AS d(id)
  WHERE oe.id = d.id;
  UPDATE analytics_overwrite_events oe
  SET previous_row = f.previous_row, replacement_row = f.replacement_row
  FROM unnest(ev_fix_ids, ev_fix_previous, ev_fix_replacement) AS f(id, previous_row, replacement_row)
  WHERE oe.id = f.id;
  UPDATE raw_indicator_history h
  SET value = f.value, source = f.source
  FROM unnest(raw_indicator, raw_date, raw_value, raw_source) AS f(indicator, date, value, source)
  WHERE h.indicator = f.indicator AND h.date = f.date;
END;
$replay$;

ANALYZE ledger_repair_dropped;
ANALYZE ledger_repair_relinked;

-- ── 5. Re-point every vintage to the fixed writer's heads ──────────────────
-- Each member id maps to itself if it is kept, or to the kept version its
-- coordinate's head was when it was recorded. The mapped ids are then gathered
-- back into runs of consecutive ids per (vintage, source_key), exactly as
-- memberRanges (store/run-ledger-store.ts) stores a new freeze.
--
-- The lookup is a LATERAL probe with LIMIT 1 on the scratch table's primary
-- key, one per member id: never a range, and never a hash rebuilt per member.
-- source_value_versions is not read at all.
INSERT INTO ledger_repair_members (vintage_id, source_key, first_id, last_id)
SELECT o.vintage_id, o.source_key, min(o.version_id), max(o.version_id)
FROM (
  SELECT m.vintage_id, m.source_key, m.version_id,
         m.version_id - row_number() OVER (PARTITION BY m.vintage_id, m.source_key ORDER BY m.version_id) AS run_key
  FROM (
    SELECT vm.vintage_id, vm.source_key, COALESCE(d.kept_id, g.id) AS version_id
    FROM analytics_vintage_members vm
    CROSS JOIN LATERAL generate_series(
      vm.source_value_version_id,
      COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) AS g(id)
    LEFT JOIN LATERAL (
      SELECT x.kept_id FROM ledger_repair_dropped x WHERE x.id = g.id LIMIT 1
    ) d ON true
  ) m
) o
GROUP BY o.vintage_id, o.source_key, o.run_key;

DELETE FROM analytics_vintage_members;
INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, last_source_value_version_id, source_key)
SELECT vintage_id, first_id, NULLIF(last_id, first_id), source_key
FROM ledger_repair_members
ORDER BY vintage_id, first_id;

-- ── 6. Delete what the fixed writer would not have written, and re-link ────
-- Detach, delete, re-attach — in that order. prior_version_id is both a
-- foreign key (a kept row may not point at a deleted one) and unique (a
-- version has one successor), so re-linking before the delete would give a
-- kept version two successors for the length of one statement.
UPDATE source_value_versions s SET prior_version_id = NULL
FROM ledger_repair_relinked k
WHERE s.id = k.id AND s.prior_version_id IS DISTINCT FROM k.prior_version_id;
DELETE FROM source_value_versions s
USING ledger_repair_dropped d
WHERE s.id = d.id;
UPDATE source_value_versions s
SET prior_version_id = k.prior_version_id, revision_kind = k.revision_kind, value = k.value
FROM ledger_repair_relinked k
WHERE s.id = k.id;

-- ── Proof, inside the transaction: refuse to commit a changed shape ────────
DO $proof$
DECLARE
  changed bigint;
  heads_after record;
BEGIN
  SELECT count(*) INTO changed
  FROM ledger_repair_member_counts b
  FULL JOIN (
    SELECT vm.vintage_id, count(*) FILTER (WHERE svv.source_key = vm.source_key) AS members
    FROM analytics_vintage_members vm
    CROSS JOIN LATERAL generate_series(
      vm.source_value_version_id,
      COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) AS g(id)
    CROSS JOIN LATERAL (
      SELECT v.id, v.source_key FROM source_value_versions v WHERE v.id = g.id LIMIT 1
    ) svv
    GROUP BY vm.vintage_id
  ) a ON a.vintage_id = b.vintage_id
  WHERE a.members IS DISTINCT FROM b.members;
  IF changed > 0 THEN
    RAISE EXCEPTION 'issue #1050 repair would change the member count of % vintage(s)', changed;
  END IF;

  SELECT count(*) AS heads,
         COALESCE(sum(hashtextextended(s.source_key || '|' || COALESCE(s.market_date::text, '') || '|' ||
                                       COALESCE(s.market_instant::text, '') || '|' || COALESCE(s.provenance, ''), 0)), 0) AS fingerprint
    INTO heads_after
  FROM source_value_versions s
  WHERE NOT EXISTS (SELECT 1 FROM source_value_versions n WHERE n.prior_version_id = s.id);
  IF NOT EXISTS (SELECT 1 FROM ledger_repair_heads h
                 WHERE h.heads = heads_after.heads AND h.fingerprint = heads_after.fingerprint) THEN
    RAISE EXCEPTION 'issue #1050 repair would change the set of series heads or their labels';
  END IF;
END;
$proof$;

-- ── 7. Stop keeping raw response bodies: drop source_payloads ───────────────
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

-- ── 8. Re-arm every guard disarmed above, as ENABLE ALWAYS ──────────────────
-- (analytics_data_vintages is disarmed and re-armed by rebuildVintageManifests
-- itself, in this same transaction, for the length of its own UPDATEs.)
ALTER TABLE analytics_vintage_members ENABLE ALWAYS TRIGGER analytics_vintage_members_immutable;
ALTER TABLE analytics_vintage_members ENABLE ALWAYS TRIGGER analytics_vintage_members_immutable_row;
ALTER TABLE source_value_versions ENABLE ALWAYS TRIGGER source_value_versions_immutable;
ALTER TABLE source_value_versions ENABLE ALWAYS TRIGGER source_value_versions_immutable_row;
ALTER TABLE analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_append_only;
ALTER TABLE analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_append_only_row;
ALTER TABLE analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_immutable;
ALTER TABLE analytics_overwrite_events ENABLE ALWAYS TRIGGER analytics_overwrite_events_immutable_row;
ALTER TABLE raw_indicator_history ENABLE ALWAYS TRIGGER raw_indicator_history_capture_overwrite;
