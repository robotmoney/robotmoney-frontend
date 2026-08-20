-- Issue #642: record WHY a strategy leg's NAV is what it is, not just its value.
--
-- ZYFAI-SS1 / GIZA-SS1 are valued as smart-account NAV = idle USDC + Σ over the
-- account's ERC-4626 vault and underlying-denominated positions
-- (backend/src/config.ts). An account holding NONE of those positions values as
-- idle USDC alone. That is a real, non-reverting read, so it is NOT 'stale' and
-- must not be labelled as such — but it is also not an ordinary reading: an
-- empty strategy account and a working one produce the same shape of row, and
-- ZYFAI-SS1 is an empty one on-chain right now (0.000044 USDC, no position).
--
-- WHY A COLUMN AND NOT A DERIVATION. The request path serves PERSISTED samples
-- with zero RPC (issue #118, asserted in tests/api/wallet-balances.test.ts), so
-- /allocation and /performance cannot re-derive this at read time: `amount`
-- alone cannot distinguish "idle USDC only" from "idle USDC plus positions
-- worth the same". Only the sampler, holding the round-1/round-2 results, knows
-- — so it records what it knew.
--
-- WHY NOT A NEW `provenance` VALUE. provenance answers "where did this number
-- come from" and the answer is unchanged: a genuine live (or stub) chain read.
-- Completeness is a separate question, and folding it into the enum would
-- silently re-bucket the leg for every existing consumer of that column
-- (historyProvenance counts, the frontend's non-live badge). See D37.
--
-- NULLABLE ON PURPOSE, three-valued and honest:
--   true  — sampled, and the account held no position (idle-USDC-only NAV)
--   false — sampled, and at least one position contributed
--   NULL  — not applicable or not known: every non-strategy symbol, every row
--           written before this migration, and every seeded/backfilled row.
-- A NOT NULL DEFAULT false would have been a lie about all of those: it would
-- assert "positions contributed" for ~14k historical rows nobody measured.
ALTER TABLE wallet_balance_samples
  ADD COLUMN strategy_nav_idle_only boolean;

COMMENT ON COLUMN wallet_balance_samples.strategy_nav_idle_only IS
  'issue #642: for valuationKind=strategy legs, true when this sample''s NAV was idle USDC only (no vault/underlying position contributed). NULL for every other symbol and for rows predating the column.';
