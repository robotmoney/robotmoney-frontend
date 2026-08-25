-- Track when each asset was first deployed so the gap detector can check
-- per-slot completeness: a March day that predates SP500's May addition is
-- complete with 7 assets, not stuck in an infinite retry loop (#709 stale
-- completeness).
--
-- Backfilled from config.ts resolveTrackedAssets()'s deployedAt values.

ALTER TABLE wallet_balance_samples
  ADD COLUMN IF NOT EXISTS deployed_at date;

-- Populate from the committed config. The join uses lowercased address to
-- tolerate case differences between the seed data and the config defaults.
UPDATE wallet_balance_samples wbs
   SET deployed_at = v.deployed_at
  FROM (VALUES
    ('USDC',        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '2026-03-18'::date),
    ('ZYFAI-SS1',   '0xc125200a1a5710af0d8711085f4407863158976d', '2026-03-18'::date),
    ('GIZA-SS1',    '0x8e5c5ab532a2d3cb6b1dd159707b2a8588cf8795', '2026-03-18'::date),
    ('WETH',        '0x4200000000000000000000000000000000000006', '2026-03-18'::date),
    ('ETH',         '0x4200000000000000000000000000000000000006', '2026-03-18'::date),
    ('ROBOTMONEY',  '0x65021a79aeef22b17cdc1b768f5e79a8618beba3', '2026-03-18'::date),
    ('BNKR',        '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', '2026-03-18'::date),
    ('SP500',       null,                                        '2026-05-01'::date)
  ) AS v(symbol, address, deployed_at)
 WHERE wbs.symbol = v.symbol
   AND (
     (v.address IS NULL AND wbs.address IS NULL)
     OR lower(wbs.address) = v.address
   )
   AND wbs.deployed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_balance_samples_deployed_at
  ON wallet_balance_samples (deployed_at)
  WHERE deployed_at IS NOT NULL;

-- Mirror for the sleeve table so per-slot filtering works there too.
ALTER TABLE wallet_sleeve_samples
  ADD COLUMN IF NOT EXISTS deployed_at date;

UPDATE wallet_sleeve_samples wss
   SET deployed_at = v.deployed_at
  FROM (VALUES
    ('USDC',        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '2026-03-18'::date),
    ('ZYFAI-SS1',   '0xc125200a1a5710af0d8711085f4407863158976d', '2026-03-18'::date),
    ('GIZA-SS1',    '0x8e5c5ab532a2d3cb6b1dd159707b2a8588cf8795', '2026-03-18'::date),
    ('WETH',        '0x4200000000000000000000000000000000000006', '2026-03-18'::date),
    ('ETH',         '0x4200000000000000000000000000000000000006', '2026-03-18'::date),
    ('ROBOTMONEY',  '0x65021a79aeef22b17cdc1b768f5e79a8618beba3', '2026-03-18'::date),
    ('BNKR',        '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', '2026-03-18'::date),
    ('SP500',       null,                                        '2026-05-01'::date)
  ) AS v(symbol, address, deployed_at)
 WHERE wss.symbol = v.symbol
   AND (
     (v.address IS NULL AND wss.address IS NULL)
     OR lower(wss.address) = v.address
   )
   AND wss.deployed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_sleeve_samples_deployed_at
  ON wallet_sleeve_samples (deployed_at)
  WHERE deployed_at IS NOT NULL;
