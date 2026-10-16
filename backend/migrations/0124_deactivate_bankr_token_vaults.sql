-- compat: additive
-- metadata_version: 1
--
-- Deactivate the two Bankr "lp-fees" vault rows, which are tokens and not
-- vaults (issue 1382).
--
-- WHY. The v0 roster carries two Bankr agent_vaults rows with strategy_type
-- 'lp-fees'. Neither address is a vault or a pool (read-only eth_call on Base,
-- 2026-10-16):
--   * 0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b ('Bankr BNKR LP Pool') is the
--     BankrCoin (BNKR) ERC-20 itself, already listed as the BNKR coin.
--   * 0x7689006F6C3A3473449E42b628544E60D0bCCb07 ('Bankr Agent Token LP') is a
--     plain ERC-20 named 'Bankr' with no Base pair.
-- On both, totalAssets(), asset(), token0(), token1(), getReserves(), slot0(),
-- liquidity(), factory() and fee() revert. Since issue 1291 each row logs one
-- '[projects.fetch_vaults] vault <id> live read failed' line on every
-- fetch_vaults run. The owner decided on 2026-10-16 to deactivate both rows and
-- do no LP valuation. Production data changes only through a migration (D66).
--
-- WHAT IT CHANGES. Only is_active, set to false, on rows whose
-- lower(vault_address) is one of the two addresses and whose strategy_type is
-- 'lp-fees'. tvl_usd, refreshed_at, last_refresh_status and every
-- daily_tvl_snapshots row stay as they are. No row is deleted.
-- projects.fetch_vaults reads only active live rows, so it stops reading both.
-- The roster seed no longer lists either vault, and the discover upsert never
-- sets is_active, so neither row comes back.
--
-- IDEMPOTENT. A second run, or a database that never held the rows (every CI
-- and clean database), matches nothing and updates nothing.
UPDATE agent_vaults
   SET is_active = false
 WHERE is_active = true
   AND strategy_type = 'lp-fees'
   AND lower(vault_address) IN (
     '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b',
     '0x7689006f6c3a3473449e42b628544e60d0bccb07'
   );
