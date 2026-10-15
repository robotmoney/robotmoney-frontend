-- compat: additive
-- metadata_version: 1
--
-- The analytics parity sweep compares in Postgres, once a day (issue 1375).
--
-- WHY. The sweep (analytics/cutover/parity.ts) proves each compatibility
-- current-view table equals its ledger reconstruction. It used to load both
-- sides of all four domains into the api's memory: stage QA on 2026-10-15,
-- with that day's production dump, saw one sweep take the api from 71 MiB to
-- 5.9 GiB in 30 s. It now runs one set-based statement per domain. Two of
-- those statements would still have to parse every immutable ledger payload
-- on every run (784 MB of regime artifacts and 92 MB of brief revisions on
-- production that day, growing daily), so this file stores what the
-- comparison needs from each payload ONCE, when the row is written, and
-- indexes it.
--
-- WHAT IT DOES.
--   1. analytics_output_snapshots.natural_keys: the natural keys a regime or
--      research artifact carries, in element order. A regime element gives its
--      `date`; a research element gives `date`, `key` and a hash of its
--      `payload`, joined by U+001F. NULL for the other artifact kinds.
--   2. swarm_brief_revisions.body_hash: a hash of the revision's body as
--      jsonb, so a brief is compared without parsing its body.
--   3. Two supporting indexes: a GIN index on natural_keys (the newest
--      artifact that carries a settled as-of day), and a covering index on
--      swarm_brief_revisions for each session's newest revision hash.
--   4. analytics.parity_sweep moves from hourly to once a day at 04:47 UTC, a
--      time no producer run, projects job or buyback refresh is due
--      (scripts/tests/unit/parity-sweep-schedule.test.ts).
--
-- THE HASH. jsonb_hash_extended(value, 0): equal jsonb values hash equal, so
-- 1.0 and 1 match as they do for jsonb `=`. It is the hash partitioning relies
-- on, so it is stable across Postgres major versions. A 64-bit collision
-- between two different bodies is the one way a real difference could read as
-- a match.
--
-- NEVER FAILS A WRITE. A payload Postgres cannot read as jsonb (a \u0000
-- escape) yields NULL instead of an error, so a producer run or a brief publish
-- can never fail on this column. The sweep reports a NULL as a mismatch, never
-- as a match.
--
-- COST. Adding a stored generated column rewrites the table under an ACCESS
-- EXCLUSIVE lock. On the 2026-10-15 production dump, restored into a local
-- Postgres 18, that took 15.3 s for analytics_output_snapshots (1,179 rows,
-- 1 GB of payload) and 1.2 s for swarm_brief_revisions; the GIN index 0.7 s. Readers of either table
-- wait for it; nothing on the public site reads analytics_output_snapshots
-- while analytics_read_mode is 'compatibility'.
--
-- Idempotent: IF NOT EXISTS on every object, and the schedule update matches
-- only the old cron.

CREATE OR REPLACE FUNCTION rm_analytics_output_natural_keys(artifact_kind text, payload_bytes bytea)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  doc jsonb;
BEGIN
  IF artifact_kind NOT IN ('regime_snapshots', 'research_signals') THEN
    RETURN NULL;
  END IF;
  doc := convert_from(payload_bytes, 'UTF8')::jsonb;
  IF jsonb_typeof(doc) <> 'array' THEN
    RETURN '{}'::text[];
  END IF;
  IF artifact_kind = 'regime_snapshots' THEN
    RETURN ARRAY(
      SELECT coalesce(e.elem ->> 'date', '')
        FROM jsonb_array_elements(doc) WITH ORDINALITY AS e(elem, ord)
       ORDER BY e.ord);
  END IF;
  RETURN ARRAY(
    SELECT coalesce(e.elem ->> 'date', '') || chr(31) || coalesce(e.elem ->> 'key', '') || chr(31)
           || coalesce(jsonb_hash_extended(e.elem -> 'payload', 0)::text, '')
      FROM jsonb_array_elements(doc) WITH ORDINALITY AS e(elem, ord)
     ORDER BY e.ord);
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION rm_json_bytes_hash(body_bytes bytea)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN jsonb_hash_extended(convert_from(body_bytes, 'UTF8')::jsonb, 0);
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

ALTER TABLE analytics_output_snapshots
  ADD COLUMN IF NOT EXISTS natural_keys text[]
  GENERATED ALWAYS AS (rm_analytics_output_natural_keys(artifact_kind, payload_bytes)) STORED;

ALTER TABLE swarm_brief_revisions
  ADD COLUMN IF NOT EXISTS body_hash bigint
  GENERATED ALWAYS AS (rm_json_bytes_hash(body_bytes)) STORED;

CREATE INDEX IF NOT EXISTS analytics_output_snapshots_natural_keys_idx
  ON analytics_output_snapshots USING gin (natural_keys);

CREATE INDEX IF NOT EXISTS swarm_brief_revisions_session_newest_idx
  ON swarm_brief_revisions (session_id, revision DESC) INCLUDE (body_hash);

-- next_run_at NULL: the scheduler seeds the next 04:47 without firing a slot
-- of the old hourly cron (worker/scheduler.ts tickScheduler).
UPDATE job_schedules
   SET cron = '47 4 * * *', next_run_at = NULL
 WHERE kind = 'analytics.parity_sweep' AND cron = '20 * * * *'
   AND NOT EXISTS (SELECT 1 FROM job_schedules WHERE kind = 'analytics.parity_sweep' AND cron = '47 4 * * *');
DELETE FROM job_schedules WHERE kind = 'analytics.parity_sweep' AND cron = '20 * * * *';
