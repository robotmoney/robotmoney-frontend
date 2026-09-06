-- D41 phase 1: the price series is separate from the holdings series
-- (docs/decisions.md D41; docs/technical/markets-asset-pricing-ingest.md §5.6).
--
-- WHAT THIS TABLE IS. A dense per-day quote record, keyed (price_date, symbol,
-- time_basis), independent of what `wallet_balance_samples` /
-- `wallet_sleeve_samples` fused it with. Amount and price are different kinds
-- of fact on different clocks (chain state at a block vs. a vendor time series
-- that exists whether or not the fund held anything); this table lets the
-- second kind be reconciled and gap-checked on its own terms.
--
-- `time_basis` is CHECKed to the single value this table ever holds. A `live`
-- spot belongs on the fused sample row (today's point keeps it, per §1.1) —
-- adding a second basis here later is a schema change, never an invisible one.
--
-- `source` IS THE PROVIDER ('geckoterminal' | 'pinned'), NEVER the provenance
-- vocabulary ('live' / 'stale' / 'seed' / 'backfilled') that describes how a
-- HOLDING was read. 'stale' in particular is meaningless for a settled daily
-- close — staleness is a live-path concept about serving an old value now.
CREATE TABLE asset_prices (
  price_date      date        NOT NULL,
  symbol          text        NOT NULL,
  time_basis      text        NOT NULL CHECK (time_basis = 'utc-daily-close'),
  price_usd       numeric     NOT NULL CHECK (price_usd > 0),
  currency        text        NOT NULL CHECK (currency = 'USD'),
  source          text        NOT NULL,   -- 'geckoterminal' | 'pinned'
  pool_key        text,                   -- which pool answered; NULL when pinned or unresolved
  token_address   text,                   -- what `token=` named; NULL when pinned
  observed_at     timestamptz NOT NULL,   -- the candle's own UTC close
  fetched_at      timestamptz NOT NULL,   -- when we asked
  response_hash   text,                   -- replayable source identity (not yet populated)
  config_identity text        NOT NULL,   -- which pin/config produced it
  PRIMARY KEY (price_date, symbol, time_basis)
);
CREATE INDEX asset_prices_symbol_date_idx ON asset_prices (symbol, price_date);

-- Per-symbol first-priceable day (markets §5.6 point 2; D41 "why 'dense' needs
-- a per-symbol floor"). ROBOTMONEY and BNKR have inception dates and their
-- pools carry no candles before them; without a floor, dense gap detection
-- would manufacture permanent unfillable gaps. `proven = true` means the
-- vendor's own paging proved nothing older exists (fetchDailyCloses's
-- `floorProven`) — the same distinction chain_address_floors draws for a CHAIN
-- fact, applied here to a VENDOR fact. A pinned (`usdc`-priced) asset has no
-- pool floor to discover at all: it is priceable from the day it was tracked.
CREATE TABLE asset_price_floors (
  symbol                text        PRIMARY KEY,
  first_priceable_date  date        NOT NULL,
  proven                boolean     NOT NULL,
  resolved_at           timestamptz NOT NULL DEFAULT now()
);

-- ── Seed: live/seed provenance rows only (D41 cutover phase 1) ──────────────
--
-- Quarantined rows (provenance = 'backfilled-quarantined', migration 0036) are
-- EXCLUDED by construction: they are exactly the rows whose price describes a
-- different asset, and re-admitting them here would restore the defect the
-- quarantine exists to contain. 'backfilled' and 'stale' rows are excluded
-- too — D41 seeds from 'live'/'seed' ONLY, leaving genuinely backfilled days to
-- reach this table only through the dual-write path (phase 2), which is
-- independently verified rather than trusted from the old column.
--
-- SP500 is excluded: it is not priced at all in this series (config-valued,
-- no chain/vendor read — markets §3.2, §5.6).
--
-- STILL-OPEN DAY IS EXCLUDED. The wallet balance sampler runs hourly and
-- continuously upserts a `live` row for the still-open UTC day this migration
-- runs on. That row is an intraday spot, not a settled close — seeding it here
-- under time_basis = 'utc-daily-close' would be exactly the live-spot/close
-- substitution D41 forbids (docs/decisions.md D41), just reached through this
-- migration's seed rather than the path D41 names directly. `sample_date <
-- (now() AT TIME ZONE 'UTC')::date` leaves today to be captured later, once it
-- has actually closed, via the dual-write path (phase 2) or ordinary repair —
-- never fabricated here from a mid-day sample.
--
-- CONFLICT RULE. wallet_balance_samples carries at most one row per
-- (sample_date, symbol) (its own UNIQUE constraint), but wallet_sleeve_samples
-- can carry several (one per wallet), and the two tables can disagree with
-- each other. Candidates are the UNION of both tables' live/seed rows; the
-- winner per (date, symbol) is chosen by:
--   1. most agreeing rows (majority price wins),
--   2. ties broken toward the aggregate wallet_balance_samples value
--      (the fund-level number, not a sleeve breakdown),
--   3. remaining ties broken by the smaller price (deterministic, not random).
-- This is an explicit, deterministic rule rather than a `SELECT DISTINCT` that
-- would otherwise hand the primary key two candidate rows and refuse the insert.
WITH candidates AS (
  SELECT sample_date, symbol, price_usd, sampled_at, TRUE AS from_balance
    FROM wallet_balance_samples
   WHERE provenance IN ('live', 'seed')
     AND price_usd IS NOT NULL AND price_usd > 0
     AND symbol <> 'SP500'
     AND sample_date < (now() AT TIME ZONE 'UTC')::date
  UNION ALL
  SELECT sample_date, symbol, price_usd, sampled_at, FALSE AS from_balance
    FROM wallet_sleeve_samples
   WHERE provenance IN ('live', 'seed')
     AND price_usd IS NOT NULL AND price_usd > 0
     AND symbol <> 'SP500'
     AND sample_date < (now() AT TIME ZONE 'UTC')::date
),
grouped AS (
  SELECT sample_date, symbol, price_usd,
         count(*) AS agreement_count,
         bool_or(from_balance) AS any_from_balance,
         min(sampled_at) AS observed_at
    FROM candidates
   GROUP BY sample_date, symbol, price_usd
),
winners AS (
  SELECT DISTINCT ON (sample_date, symbol)
         sample_date, symbol, price_usd, observed_at
    FROM grouped
   ORDER BY sample_date, symbol, agreement_count DESC, any_from_balance DESC, price_usd ASC
)
INSERT INTO asset_prices
  (price_date, symbol, time_basis, price_usd, currency, source, observed_at, fetched_at, config_identity)
SELECT sample_date, symbol, 'utc-daily-close', price_usd, 'USD',
       CASE WHEN symbol IN ('USDC', 'ZYFAI-SS1', 'GIZA-SS1') THEN 'pinned' ELSE 'geckoterminal' END,
       observed_at, observed_at,
       'seed:migration-0046-from-live-seed-provenance'
  FROM winners
ON CONFLICT (price_date, symbol, time_basis) DO NOTHING;

-- Seed the pinned assets' floor: priceable from the day each was tracked
-- (backend/src/config.ts TrackedAsset.deployedAt, baked here since a migration
-- has no runtime access to that module). USDC / ZYFAI-SS1 / GIZA-SS1 all carry
-- '2026-03-18' today; if a future re-point changes that, it is a config change
-- unrelated to this one-time seed and does not need to chase it. Gecko-priced
-- assets (WETH, ETH, ROBOTMONEY, BNKR) are deliberately left unresolved here —
-- their floor is a VENDOR fact (chain/asset-price-floor.ts), not derivable from
-- this table's rows, and is discovered lazily during ordinary repair.
INSERT INTO asset_price_floors (symbol, first_priceable_date, proven)
VALUES
  ('USDC', '2026-03-18', true),
  ('ZYFAI-SS1', '2026-03-18', true),
  ('GIZA-SS1', '2026-03-18', true)
ON CONFLICT (symbol) DO NOTHING;
