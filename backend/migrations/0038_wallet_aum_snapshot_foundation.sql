-- P1 AUM foundation: immutable snapshot identity and auditable observation time.
--
-- This migration deliberately does not certify existing rows. Legacy samples
-- keep NULL snapshot/observation identity until a future live or historical
-- publisher creates a complete run and writes its constituent rows together.

CREATE FUNCTION rm_text_array_is_canonical_set(input_values text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT NOT EXISTS (
           SELECT 1 FROM unnest(input_values) AS value
            WHERE value IS NULL OR btrim(value) = ''
         )
     AND cardinality(input_values) = (
           SELECT count(DISTINCT value COLLATE "C") FROM unnest(input_values) AS value
         )
     AND input_values = COALESCE(
           (SELECT array_agg(value ORDER BY value COLLATE "C")
              FROM unnest(input_values) AS value),
           '{}'::text[]
         );
$$;

CREATE TABLE wallet_aum_snapshot_runs (
  run_id                       bigserial PRIMARY KEY,
  sample_date                  date NOT NULL,
  time_basis                   text NOT NULL
    CHECK (time_basis IN ('live', 'utc-daily-close')),
  state                        text NOT NULL
    CHECK (state IN ('complete', 'degraded', 'unavailable', 'failed-retryable')),

  manifest_version             text NOT NULL CHECK (btrim(manifest_version) <> ''),
  manifest_json                jsonb NOT NULL CHECK (jsonb_typeof(manifest_json) = 'object'),
  manifest_hash                text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  config_identity              text NOT NULL CHECK (btrim(config_identity) <> ''),

  -- Present only for a published (complete/degraded) immutable snapshot. It is
  -- a SHA-256 identity over the manifest, proof, evidence, and constituent rows.
  snapshot_id                  text UNIQUE CHECK (snapshot_id IS NULL OR snapshot_id ~ '^[0-9a-f]{64}$'),

  expected_balance_keys        text[] NOT NULL DEFAULT '{}',
  present_balance_keys         text[] NOT NULL DEFAULT '{}',
  missing_balance_keys         text[] NOT NULL DEFAULT '{}',
  unexpected_balance_keys      text[] NOT NULL DEFAULT '{}',
  expected_sleeve_keys         text[] NOT NULL DEFAULT '{}',
  present_sleeve_keys          text[] NOT NULL DEFAULT '{}',
  missing_sleeve_keys          text[] NOT NULL DEFAULT '{}',
  unexpected_sleeve_keys       text[] NOT NULL DEFAULT '{}',

  observed_at                  timestamptz,
  published_at                 timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),

  chain_id                     bigint,
  block_number                 bigint,
  block_hash                   text,
  block_timestamp              timestamptz,
  boundary_next_block_number   bigint,
  boundary_next_block_hash     text,
  boundary_next_block_timestamp timestamptz,

  source_evidence              jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_evidence) = 'object'),
  price_evidence               jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(price_evidence) = 'object'),

  producer_revision_status     text NOT NULL
    CHECK (producer_revision_status IN ('available', 'unavailable')),
  producer_revision            text,
  producer_revision_unavailable_reason text,

  failure_code                 text,
  failure_detail               text,

  CHECK (rm_text_array_is_canonical_set(expected_balance_keys)),
  CHECK (rm_text_array_is_canonical_set(present_balance_keys)),
  CHECK (rm_text_array_is_canonical_set(missing_balance_keys)),
  CHECK (rm_text_array_is_canonical_set(unexpected_balance_keys)),
  CHECK (rm_text_array_is_canonical_set(expected_sleeve_keys)),
  CHECK (rm_text_array_is_canonical_set(present_sleeve_keys)),
  CHECK (rm_text_array_is_canonical_set(missing_sleeve_keys)),
  CHECK (rm_text_array_is_canonical_set(unexpected_sleeve_keys)),

  CHECK (
    (producer_revision_status = 'available'
      AND producer_revision IS NOT NULL AND btrim(producer_revision) <> ''
      AND producer_revision_unavailable_reason IS NULL)
    OR
    (producer_revision_status = 'unavailable'
      AND producer_revision IS NULL
      AND producer_revision_unavailable_reason IS NOT NULL
      AND btrim(producer_revision_unavailable_reason) <> '')
  ),
  CHECK (
    (state IN ('complete', 'degraded')
      AND snapshot_id IS NOT NULL
      AND observed_at IS NOT NULL
      AND published_at IS NOT NULL
      AND producer_revision_status = 'available'
      AND chain_id IS NOT NULL
      AND block_number IS NOT NULL
      AND block_hash IS NOT NULL
      AND block_timestamp IS NOT NULL
      AND cardinality(expected_balance_keys) > 0
      AND cardinality(missing_balance_keys) = 0
      AND cardinality(unexpected_balance_keys) = 0
      AND cardinality(missing_sleeve_keys) = 0
      AND cardinality(unexpected_sleeve_keys) = 0
      AND expected_balance_keys = present_balance_keys
      AND expected_sleeve_keys = present_sleeve_keys)
    OR
    (state IN ('unavailable', 'failed-retryable')
      AND snapshot_id IS NULL
      AND published_at IS NULL)
  ),
  CHECK (
    (block_number IS NULL AND block_hash IS NULL AND block_timestamp IS NULL)
    OR
    (block_number IS NOT NULL AND block_hash IS NOT NULL
      AND block_number >= 0
      AND block_hash ~ '^0x[0-9a-f]{64}$' AND block_timestamp IS NOT NULL)
  ),
  CHECK (
    (boundary_next_block_number IS NULL AND boundary_next_block_hash IS NULL
      AND boundary_next_block_timestamp IS NULL)
    OR
    (boundary_next_block_number IS NOT NULL AND boundary_next_block_hash IS NOT NULL
      AND boundary_next_block_hash ~ '^0x[0-9a-f]{64}$'
      AND boundary_next_block_timestamp IS NOT NULL
      AND block_number IS NOT NULL
      AND boundary_next_block_number = block_number + 1
      AND block_timestamp < boundary_next_block_timestamp)
  ),
  CHECK (
    time_basis <> 'utc-daily-close'
    OR state NOT IN ('complete', 'degraded')
    OR (
      boundary_next_block_number IS NOT NULL
      AND block_timestamp < ((sample_date + 1)::timestamp AT TIME ZONE 'UTC')
      AND boundary_next_block_timestamp >= ((sample_date + 1)::timestamp AT TIME ZONE 'UTC')
    )
  )
);

CREATE INDEX wallet_aum_snapshot_runs_date_basis_created_idx
  ON wallet_aum_snapshot_runs (sample_date, time_basis, created_at DESC);
CREATE INDEX wallet_aum_snapshot_runs_state_date_idx
  ON wallet_aum_snapshot_runs (state, sample_date);

CREATE FUNCTION rm_wallet_aum_snapshot_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'table "%" is append-only AUM snapshot evidence: % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$$;

CREATE TRIGGER wallet_aum_snapshot_runs_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_aum_snapshot_runs
  FOR EACH STATEMENT EXECUTE FUNCTION rm_wallet_aum_snapshot_run_guard();
ALTER TABLE wallet_aum_snapshot_runs
  ENABLE ALWAYS TRIGGER wallet_aum_snapshot_runs_immutable;
CREATE TRIGGER wallet_aum_snapshot_runs_immutable_row
  BEFORE UPDATE OR DELETE ON wallet_aum_snapshot_runs
  FOR EACH ROW EXECUTE FUNCTION rm_wallet_aum_snapshot_run_guard();
ALTER TABLE wallet_aum_snapshot_runs
  ENABLE ALWAYS TRIGGER wallet_aum_snapshot_runs_immutable_row;

ALTER TABLE wallet_balance_samples
  ADD COLUMN snapshot_run_id bigint REFERENCES wallet_aum_snapshot_runs(run_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN amount_observed_at timestamptz,
  ADD COLUMN price_observed_at timestamptz,
  ADD COLUMN recorded_at timestamptz;

ALTER TABLE wallet_sleeve_samples
  ADD COLUMN snapshot_run_id bigint REFERENCES wallet_aum_snapshot_runs(run_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN amount_observed_at timestamptz,
  ADD COLUMN price_observed_at timestamptz,
  ADD COLUMN recorded_at timestamptz;

ALTER TABLE wallet_balance_sample_evidence
  ADD COLUMN snapshot_run_id bigint REFERENCES wallet_aum_snapshot_runs(run_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN amount_observed_at timestamptz,
  ADD COLUMN price_observed_at timestamptz,
  ADD COLUMN recorded_at timestamptz;

ALTER TABLE wallet_sleeve_sample_evidence
  ADD COLUMN snapshot_run_id bigint REFERENCES wallet_aum_snapshot_runs(run_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN amount_observed_at timestamptz,
  ADD COLUMN price_observed_at timestamptz,
  ADD COLUMN recorded_at timestamptz;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'wallet_balance_samples',
    'wallet_sleeve_samples',
    'wallet_balance_sample_evidence',
    'wallet_sleeve_sample_evidence'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (
         (snapshot_run_id IS NULL AND amount_observed_at IS NULL
           AND price_observed_at IS NULL AND recorded_at IS NULL)
         OR
         (snapshot_run_id IS NOT NULL AND amount_observed_at IS NOT NULL
           AND price_observed_at IS NOT NULL AND recorded_at IS NOT NULL
           AND recorded_at >= amount_observed_at
           AND recorded_at >= price_observed_at)
       )',
      t, t || '_snapshot_identity_shape');
  END LOOP;
END;
$$;

-- A publishable run is inserted only after all constituent rows have been
-- staged under a reserved run_id in the same transaction. Deferred FKs permit
-- that ordering. Once the complete/degraded header exists, no row may join,
-- leave, or mutate the published snapshot.
CREATE FUNCTION rm_wallet_aum_snapshot_constituent_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.snapshot_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM wallet_aum_snapshot_runs
     WHERE run_id = OLD.snapshot_run_id AND state IN ('complete', 'degraded')
  ) THEN
    RAISE EXCEPTION
      'published AUM snapshot run % is immutable: % on % is not permitted',
      OLD.snapshot_run_id, TG_OP, TG_TABLE_NAME
      USING ERRCODE = '0A000';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.snapshot_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM wallet_aum_snapshot_runs
     WHERE run_id = NEW.snapshot_run_id AND state IN ('complete', 'degraded')
  ) THEN
    RAISE EXCEPTION
      'published AUM snapshot run % is immutable: % on % is not permitted',
      NEW.snapshot_run_id, TG_OP, TG_TABLE_NAME
      USING ERRCODE = '0A000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'wallet_balance_samples',
    'wallet_sleeve_samples',
    'wallet_balance_sample_evidence',
    'wallet_sleeve_sample_evidence'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION rm_wallet_aum_snapshot_constituent_guard()',
      t || '_snapshot_final_guard', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_snapshot_final_guard');
  END LOOP;
END;
$$;

CREATE FUNCTION rm_wallet_aum_snapshot_finalize_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actual_balance_keys text[];
  actual_sleeve_keys text[];
BEGIN
  IF NEW.state NOT IN ('complete', 'degraded') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(symbol ORDER BY symbol COLLATE "C"), '{}'::text[])
    INTO actual_balance_keys
    FROM wallet_balance_samples
   WHERE snapshot_run_id = NEW.run_id AND sample_date = NEW.sample_date;

  SELECT COALESCE(
           array_agg(
             concat('[', to_jsonb(lower(wallet_address))::text, ',', to_jsonb(symbol)::text, ']')
             ORDER BY concat('[', to_jsonb(lower(wallet_address))::text, ',', to_jsonb(symbol)::text, ']') COLLATE "C"
           ),
           '{}'::text[]
         )
    INTO actual_sleeve_keys
    FROM wallet_sleeve_samples
   WHERE snapshot_run_id = NEW.run_id AND sample_date = NEW.sample_date;

  IF actual_balance_keys <> NEW.present_balance_keys
     OR actual_sleeve_keys <> NEW.present_sleeve_keys THEN
    RAISE EXCEPTION
      'publishable AUM snapshot run % constituent keys do not match its declared present sets',
      NEW.run_id
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM wallet_balance_samples
     WHERE snapshot_run_id = NEW.run_id AND sample_date <> NEW.sample_date
    UNION ALL
    SELECT 1 FROM wallet_sleeve_samples
     WHERE snapshot_run_id = NEW.run_id AND sample_date <> NEW.sample_date
  ) THEN
    RAISE EXCEPTION
      'publishable AUM snapshot run % contains rows for another sample_date',
      NEW.run_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_aum_snapshot_runs_finalize
  BEFORE INSERT ON wallet_aum_snapshot_runs
  FOR EACH ROW EXECUTE FUNCTION rm_wallet_aum_snapshot_finalize_guard();
ALTER TABLE wallet_aum_snapshot_runs
  ENABLE ALWAYS TRIGGER wallet_aum_snapshot_runs_finalize;

CREATE INDEX wallet_balance_samples_snapshot_run_idx
  ON wallet_balance_samples (snapshot_run_id) WHERE snapshot_run_id IS NOT NULL;
CREATE INDEX wallet_sleeve_samples_snapshot_run_idx
  ON wallet_sleeve_samples (snapshot_run_id) WHERE snapshot_run_id IS NOT NULL;
CREATE INDEX wallet_balance_sample_evidence_snapshot_run_idx
  ON wallet_balance_sample_evidence (snapshot_run_id) WHERE snapshot_run_id IS NOT NULL;
CREATE INDEX wallet_sleeve_sample_evidence_snapshot_run_idx
  ON wallet_sleeve_sample_evidence (snapshot_run_id) WHERE snapshot_run_id IS NOT NULL;

-- A complete daily-close proof is the closing block AND the first block on or
-- after next UTC midnight. Existing 0033 cache rows remain nullable and are
-- intentionally treated as misses by the resolver until re-proved.
ALTER TABLE chain_day_blocks
  ADD COLUMN block_hash text,
  ADD COLUMN boundary_next_block_number bigint,
  ADD COLUMN boundary_next_block_hash text,
  ADD COLUMN boundary_next_block_timestamp timestamptz;

ALTER TABLE chain_day_blocks
  ADD CONSTRAINT chain_day_blocks_proof_shape CHECK (
    (block_hash IS NULL AND boundary_next_block_number IS NULL
      AND boundary_next_block_hash IS NULL AND boundary_next_block_timestamp IS NULL)
    OR
    (block_number >= 0
      AND block_hash ~ '^0x[0-9a-f]{64}$'
      AND boundary_next_block_number = block_number + 1
      AND boundary_next_block_hash ~ '^0x[0-9a-f]{64}$'
      AND block_timestamp < ((sample_date + 1)::timestamp AT TIME ZONE 'UTC')
      AND boundary_next_block_timestamp >= ((sample_date + 1)::timestamp AT TIME ZONE 'UTC'))
  );

COMMENT ON TABLE wallet_aum_snapshot_runs IS
  'Immutable final-state AUM publication attempts. Only complete/degraded runs have snapshot_id and are publishable.';
COMMENT ON COLUMN wallet_aum_snapshot_runs.producer_revision IS
  'Explicit build/runtime revision. NULL is permitted only with status=unavailable and a reason; never inferred.';
COMMENT ON COLUMN wallet_balance_samples.snapshot_run_id IS
  'NULL means legacy-unverified; future publishers attach all rows in one immutable wallet_aum_snapshot_runs run.';
COMMENT ON COLUMN wallet_sleeve_samples.snapshot_run_id IS
  'NULL means legacy-unverified; future publishers attach all rows in one immutable wallet_aum_snapshot_runs run.';
