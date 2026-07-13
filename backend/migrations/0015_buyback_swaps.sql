-- Durable store for the token-buyback dashboard (GET /api/dashboards/buybacks).
-- Replaces the baked buyback table that used to live in the frontend
-- (frontend/public/views/allocation.html:383-403). A buyback is a WETH ->
-- ROBOTMONEY swap: a ROBOTMONEY Transfer event INTO the primary prop wallet
-- (source of truth: robotmoney-site wallet.ts::fetchBuybackTransactions).
--
-- The chain/buyback-logs.ts indexer (worker/handlers/buybacks.ts) refreshes this
-- table from Base via eth_getLogs and UPSERTS keyed on tx_hash — the natural key
-- below — so a re-run or catch-up scan never duplicates a swap, matching the
-- upsert-on-natural-key convention used throughout this schema (0012 / 0014).
--
-- Provenance mirrors chain/vault-economics.ts + wallet_balance_samples (#50):
--   'live'  = a real Base eth_getLogs read;
--   'stub'  = the hermetic BASE_RPC_SOURCE=stub fixture (never used to persist);
--   'stale' = a degraded read serving the last-persisted rows;
--   'seed'  = the pre-launch historical set backfilled below (the 10 real
--             2026-03-23 buyback txs), NOT a live read.
-- A value is NEVER fabricated or falsely labelled 'live'. The indexer only
-- persists a 'live' row when it can determine the full picture (WETH spent, USD
-- value, ROBOTMONEY received, and the block date); an unpaired transfer is not
-- recorded rather than back-filled with an invented number.
CREATE TABLE buyback_swaps (
  id                  bigserial PRIMARY KEY,
  block_number        bigint,                 -- nullable: the seeded historical rows carry no block (only the tx hash + amounts survive)
  tx_hash             text NOT NULL UNIQUE,   -- natural upsert key (Base tx hash)
  log_index           int,                    -- ERC-20 Transfer log index within the tx (nullable for seeds)
  occurred_on         date,                   -- calendar day of the swap (block timestamp for live rows)
  weth_spent          numeric,                -- WETH input leg, 18dp normalized
  value_usd           numeric,                -- USD value of the WETH spent
  robotmoney_received numeric,                -- ROBOTMONEY received, 18dp normalized (token count)
  provenance          text NOT NULL DEFAULT 'live', -- 'live' | 'stub' | 'stale' | 'seed'
  ingested_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX buyback_swaps_occurred_on_idx ON buyback_swaps (occurred_on DESC);

-- Persisted scan cursor for the eth_getLogs indexer. Progress must survive across
-- runs INDEPENDENTLY of whether a buyback was found in a window: deriving the
-- resume point from MAX(buyback_swaps.block_number) alone means an empty window
-- (or the NULL-block seed rows) never advances the cursor, so a bounded per-run
-- scan would restart from the same floor forever and never crawl forward to the
-- live buyback era. A single row holds the highest block already scanned.
CREATE TABLE buyback_scan_state (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_scanned_block bigint NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Real historical buyback set: 10 txs, all 2026-03-23, total 1.149114 WETH /
-- $2,504.31 / 178.84M ROBOTMONEY. Real BaseScan tx hashes. ON CONFLICT DO
-- NOTHING so a later live index of the same tx never clobbers this authoritative
-- seed (which carries the settled historical USD value the live path can't
-- re-derive), and a re-run of the migration is a no-op.
INSERT INTO buyback_swaps
  (block_number, tx_hash, log_index, occurred_on, weth_spent, value_usd, robotmoney_received, provenance)
VALUES
  (NULL, '0xa19a086682db8ff57a94e8f594bb542c8e4ba1d8f79bf7ad48717be0587ffa37', NULL, '2026-03-23', 0.116534, 253.97, 18450000, 'seed'),
  (NULL, '0x9ce840624ce3742bca40f6b672587dfa1ad85ac40476ecb7cb71938a170319bc', NULL, '2026-03-23', 0.11591,  252.61, 17810000, 'seed'),
  (NULL, '0x8dc090ca0ec59882d541dffd52adbe64adbdba4166dd63a230722d2ea0b29266', NULL, '2026-03-23', 0.11591,  252.61, 17770000, 'seed'),
  (NULL, '0x1e09868aa284f8a969f7a85a11758e896b786f5f78daf8b503274b2828209361', NULL, '2026-03-23', 0.114375, 249.26, 18170000, 'seed'),
  (NULL, '0x79594aaa2a4b39bdcbc19ba9f39834963d0f00599b4437e17a517503f996450f', NULL, '2026-03-23', 0.114375, 249.26, 18140000, 'seed'),
  (NULL, '0x9364ec11ec2543438b2c1efaee79aad6ecc2ef42606ca9efa9f8378ac4837eac', NULL, '2026-03-23', 0.115006, 250.64, 18200000, 'seed'),
  (NULL, '0xd63e11167880ef5ca9d7dfeb2e361b355e93aa01317ccb9ab5bdf5918168eb74', NULL, '2026-03-23', 0.114251, 248.99, 18040000, 'seed'),
  (NULL, '0xe6d8138395fb5815157cf1197570dd26c10f4fd3c3792e08fa9f38956811ec33', NULL, '2026-03-23', 0.114251, 248.99, 17460000, 'seed'),
  (NULL, '0x81cf52a3f723c48a65c67999b5b4417a67b67687125aec29ba255246a6eba39f', NULL, '2026-03-23', 0.114251, 248.99, 17430000, 'seed'),
  (NULL, '0x3c9718e37624c0de8b5e295b3e8a9cf5dc98dcd0d08cbad395551c2ce6f8eab9', NULL, '2026-03-23', 0.114251, 248.99, 17370000, 'seed')
ON CONFLICT (tx_hash) DO NOTHING;
