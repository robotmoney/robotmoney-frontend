-- compat: additive
-- metadata_version: 1
--
-- The artifact kind `regime_beside_snapshots` (issue 1753, decision D96).
--
-- WHY. Regime methodology v5 is computed and published beside the served line
-- (REGIME_LINE in packages/analyst-sdk/src/analyze/regime-versions.ts). Its rows
-- must be frozen where no reader of the main line looks. A v5 run's terminal
-- package therefore freezes its regime rows under a kind of their own,
-- `regime_beside_snapshots`, and its `regime_snapshots` artifact is the empty
-- list. The API picks the kind from the run's methodology label
-- (analytics/store/output-snapshot-store.ts), never the client.
--
-- WHAT IT DOES.
--   1. analytics_output_snapshots.artifact_kind accepts the new kind. Every
--      kind it accepted before is still accepted, and any other is still
--      refused.
--   2. rm_analytics_output_natural_keys (migration 0123) gives a
--      `regime_beside_snapshots` artifact the same natural keys as a
--      `regime_snapshots` one: each element's `date`, in element order. The
--      publication selection (analytics/cutover/ledger-current.ts, decision
--      D83) reads them to select each day's published row without parsing a
--      payload. Every other kind gets exactly the keys it got before.
--
-- NO ROW IS REWRITTEN. natural_keys is a stored generated column: replacing the
-- function it calls does not recompute a stored row, and for every existing
-- kind the new body returns what the old one did, so stored and newly written
-- rows agree. No `regime_beside_snapshots` row exists before this file, so none
-- carries a stale NULL.
--
-- LOCKS. The CHECK is replaced NOT VALID and then validated: the validation
-- reads artifact_kind of every row (about 2,400 on production, no payload is
-- read) under a SHARE UPDATE EXCLUSIVE lock. The constraint swap takes an
-- ACCESS EXCLUSIVE lock for the moment of the catalog change. lock_timeout 2s
-- bounds the wait for either, the same rule as 0130, 0134 and 0135.
--
-- ADDITIVE. An older image writes only the kinds it knew and reads only
-- `regime_snapshots` and `research_signals`; it never sees a row of the new
-- kind. IDEMPOTENT: the function is replaced, and the constraint is dropped IF
-- EXISTS before it is added.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION rm_analytics_output_natural_keys(artifact_kind text, payload_bytes bytea)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  doc jsonb;
BEGIN
  IF artifact_kind NOT IN ('regime_snapshots', 'regime_beside_snapshots', 'research_signals') THEN
    RETURN NULL;
  END IF;
  doc := convert_from(payload_bytes, 'UTF8')::jsonb;
  IF jsonb_typeof(doc) <> 'array' THEN
    RETURN '{}'::text[];
  END IF;
  IF artifact_kind IN ('regime_snapshots', 'regime_beside_snapshots') THEN
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

ALTER TABLE analytics_output_snapshots
  DROP CONSTRAINT IF EXISTS analytics_output_snapshots_artifact_kind_check;

ALTER TABLE analytics_output_snapshots
  ADD CONSTRAINT analytics_output_snapshots_artifact_kind_check
  CHECK (artifact_kind IN ('regime_snapshots', 'regime_beside_snapshots', 'research_signals', 'warnings', 'logs', 'exceptions')) NOT VALID;

ALTER TABLE analytics_output_snapshots
  VALIDATE CONSTRAINT analytics_output_snapshots_artifact_kind_check;
