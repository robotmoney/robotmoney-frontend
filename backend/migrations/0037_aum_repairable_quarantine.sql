-- P0 AUM repairability: quarantine is evidence, not active-series occupancy.
--
-- Migration 0036 correctly made suspect backfill rows unservable, but retained
-- them inside the active sample tables. Their natural keys therefore blocked
-- the repair writer from inserting verified replacements. These typed evidence
-- tables preserve every original field and original row id while allowing the
-- active keys to be freed. Runtime repair uses the same tables when replacing
-- any incomplete day, so a pre-existing partial observation is never erased.

CREATE TABLE wallet_balance_sample_evidence (
  evidence_id                 bigserial PRIMARY KEY,
  original_id                 bigint NOT NULL UNIQUE,
  sample_date                 date NOT NULL,
  symbol                      text NOT NULL,
  amount                      numeric,
  price_usd                   numeric,
  value_usd                   numeric NOT NULL,
  provenance                  text NOT NULL,
  sampled_at                  timestamptz NOT NULL,
  strategy_nav_idle_only      boolean,
  evidence_reason             text NOT NULL,
  replacement_block_number    bigint,
  archived_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_balance_sample_evidence_date_symbol_idx
  ON wallet_balance_sample_evidence (sample_date, symbol);

CREATE TABLE wallet_sleeve_sample_evidence (
  evidence_id                 bigserial PRIMARY KEY,
  original_id                 bigint NOT NULL UNIQUE,
  sample_date                 date NOT NULL,
  wallet_address              text NOT NULL,
  symbol                      text NOT NULL,
  amount                      numeric,
  price_usd                   numeric,
  value_usd                   numeric,
  provenance                  text NOT NULL,
  sampled_at                  timestamptz NOT NULL,
  evidence_reason             text NOT NULL,
  replacement_block_number    bigint,
  archived_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_sleeve_sample_evidence_date_key_idx
  ON wallet_sleeve_sample_evidence (sample_date, wallet_address, symbol);

-- This migration may run while an older application instance is still
-- draining. Those writers do not know the runtime advisory-lock protocol yet,
-- so take table-level writer locks before identifying the cohort. Reads remain
-- available; INSERT/UPDATE/DELETE waits until archive+delete commits.
LOCK TABLE wallet_balance_samples, wallet_sleeve_samples
  IN SHARE ROW EXCLUSIVE MODE;

-- A quarantine makes the WHOLE date unpublishable. Archive both active tables
-- for every affected date before freeing any key: deleting only the rows whose
-- provenance is quarantined would remove the marker that makes serving readers
-- suppress a mixed day, exposing the trustworthy-looking remainder as a false
-- partial AUM point until repair happened to run.
CREATE TEMP TABLE aum_quarantine_dates ON COMMIT DROP AS
SELECT sample_date
  FROM wallet_balance_samples
 WHERE provenance = 'backfilled-quarantined'
UNION
SELECT sample_date
  FROM wallet_sleeve_samples
 WHERE provenance = 'backfilled-quarantined';

INSERT INTO wallet_balance_sample_evidence
  (original_id, sample_date, symbol, amount, price_usd, value_usd,
   provenance, sampled_at, strategy_nav_idle_only, evidence_reason)
SELECT id, sample_date, symbol, amount, price_usd, value_usd,
       provenance, sampled_at, strategy_nav_idle_only,
       CASE WHEN provenance = 'backfilled-quarantined'
            THEN 'quarantined-by-0036'
            ELSE 'quarantine-cohort-partial' END
  FROM wallet_balance_samples b
 WHERE EXISTS (
   SELECT 1 FROM aum_quarantine_dates q WHERE q.sample_date = b.sample_date
 );

INSERT INTO wallet_sleeve_sample_evidence
  (original_id, sample_date, wallet_address, symbol, amount, price_usd,
   value_usd, provenance, sampled_at, evidence_reason)
SELECT id, sample_date, wallet_address, symbol, amount, price_usd,
       value_usd, provenance, sampled_at,
       CASE WHEN provenance = 'backfilled-quarantined'
            THEN 'quarantined-by-0036'
            ELSE 'quarantine-cohort-partial' END
  FROM wallet_sleeve_samples s
 WHERE EXISTS (
   SELECT 1 FROM aum_quarantine_dates q WHERE q.sample_date = s.sample_date
 );

DELETE FROM wallet_balance_samples b
 WHERE EXISTS (
   SELECT 1 FROM aum_quarantine_dates q WHERE q.sample_date = b.sample_date
 );

DELETE FROM wallet_sleeve_samples s
 WHERE EXISTS (
   SELECT 1 FROM aum_quarantine_dates q WHERE q.sample_date = s.sample_date
 );

-- Evidence rows are immutable. Statement triggers refuse even zero-row probes
-- and TRUNCATE; row triggers also cover row-level replication/inheritance paths.
CREATE FUNCTION rm_aum_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'table "%" is immutable AUM evidence: % is not permitted',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'wallet_balance_sample_evidence',
    'wallet_sleeve_sample_evidence'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION rm_aum_evidence_guard()',
      t || '_immutable', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable');
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION rm_aum_evidence_guard()',
      t || '_immutable_row', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_immutable_row');
  END LOOP;
END;
$$;

COMMENT ON TABLE wallet_balance_sample_evidence IS
  'Immutable original balance rows displaced by quarantine repair or incomplete-snapshot replacement.';
COMMENT ON TABLE wallet_sleeve_sample_evidence IS
  'Immutable original sleeve rows displaced by quarantine repair or incomplete-snapshot replacement.';
