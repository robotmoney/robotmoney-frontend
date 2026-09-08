-- Per-address earliest-valid-block floor cache (issue #760;
-- docs/technical/markets-asset-pricing-ingest.md §6.1, §8.1).
--
-- Holds no measurement, exactly like chain_day_blocks (migration 0033): this
-- is a cache of an immutable CHAIN fact -- the first block at which an address
-- has on-chain code, i.e. its deployment block -- never repaired data.
--
-- WHY PERMANENT, NOT A TTL. A contract's deployment block never changes, so
-- the answer for one address is the same today, next month, and after the
-- next database rebuild. A second backfill pass over an address already
-- resolved costs zero eth_getCode probes.
--
-- HOW IT IS USED. wallet-backfill.ts consults this floor, per tracked address,
-- BEFORE issuing a block-addressed read for a day: a day whose resolved block
-- precedes an address's floor predates that contract's deployment -- not a
-- failure, a certainty -- so it is written to wallet_backfill_state as
-- 'skipped' rather than 'failed', with no attempt charged. GET /api/admin/gaps
-- is unaffected by this table -- it derives from the sample tables via
-- expectedKeys/deployedAt (migration 0044's note), never from
-- wallet_backfill_state -- so a genuinely uncovered day still shows as a gap.
CREATE TABLE IF NOT EXISTS chain_address_floors (
  address      text PRIMARY KEY,
  floor_block  bigint NOT NULL,
  resolved_at  timestamptz NOT NULL DEFAULT now()
);
