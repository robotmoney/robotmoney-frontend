# Vault economics and wallet balances

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 10. Vault economics & wallet balances (live chain data)

Decision [D15](../decisions.md#d15--live-vault-economics-pipeline-from-base-rpc-supersedes-d1s-vault-dashboard-exclusion)
brought the `/allocation` page's vault-economics slice into scope, backed by a
real Base (chainId `8453`) JSON-RPC read pipeline — the first exception to the
allocation/vault/wallet out-of-scope line (§1). Decision
[D16](../decisions.md#d16--live-wallet-balances-pipeline-from-base-rpc-supersedes-d1s-wallet-dashboard-exclusion)
brought the prop-wallet valuation feed into scope the same way (§10.1). Decision
[D17](../decisions.md#d17--remove-the-last-baked-frontend-data-live-buybacks-token-metrics-sleeves-supersedes-d1s-remaining-exclusions)
(issue #111) then retired the last baked frontend literals entirely: buybacks
(`GET /api/dashboards/buybacks` — ROBOTMONEY Transfer-log reads in
`backend/src/chain/buyback-logs.ts`, refreshed by the `buybacks.refresh` job,
cron `15 */6 * * *`, persisted via migration `0015_buyback_swaps.sql`), token
metrics (`/token-metrics`), per-wallet sleeves (`/wallet-sleeves`), and the
`allocation_framework` read are all live endpoints now — nothing of the
original out-of-scope line remains static. Decision
[D24](../decisions.md#d24--postgres-as-the-indexer-of-record-for-vault-adapter-and-wallet-sleeve-samples-refines-d15d17)
(issue #294) then finished the "worker schedule, never the request path" rule
(established for wallet-balances below) for the two remaining request-time
`eth_call` feeds: vault-economics' per-adapter balances and wallet-sleeves'
per-wallet holdings now read exclusively from Postgres (`vault_adapter_samples`,
`wallet_sleeve_samples`) — **zero Base RPC and zero third-party price requests**
on either request path. The shared endpoint contract (DTOs, provenance fields,
degrade rules) those feeds were built against is the
[live-data contract section](dashboards-live-data.md#live-data-contract--4-new-dashboard-endpoints).

- **`backend/src/chain/base-rpc-client.ts`** — a minimal JSON-RPC client and,
  since D17, the **single RPC transport** for every chain read in the repo: no
  external chain SDK (ethers/viem), just `fetch` + hand-rolled 4-byte selector
  encoding and uint256 decoding for the read-only calls the dashboards need
  (`totalAssets()`, `totalSupply()`, `balanceOf(address)`, …). Two hardening
  layers (#119): `multicall3Aggregate3()` batches many sub-calls into one
  `eth_call` via Multicall3, and transient upstream statuses (429/502/503/504)
  get a bounded retry-with-backoff (honoring `Retry-After`) — a genuine failure
  still degrades honestly, never masked. Consumers include
  `vault-economics.ts`, `wallet-balances.ts`, `buyback-logs.ts`,
  `token-metrics.ts`, and `wallet-sleeves.ts`. Keeps the buildless-backend
  dependency footprint (§2) unchanged.
- **`backend/src/chain/vault-economics.ts`** (issue #294: rewritten to make
  Postgres the sole request-path source) — `fetchVaultEconomics()` makes
  **ZERO Base RPC calls**. Core totals (`tvlUsd`, `sharePrice`, `totalShares`)
  read the latest `vault_share_price_history` row; every **configured**
  adapter's `balanceUsd` (an unconfigured/placeholder adapter is never
  `eth_call`'d, at sample time or request time — see below) reads the latest
  `vault_adapter_samples` row for that `(vault_address, adapter_address)`;
  `idleUsdc` is derived as `tvlUsd - Σ adapter balanceUsd` (never its own
  chain read) once every configured adapter has a value. `stale` is true when
  the core row or any configured adapter's row is missing, itself marked
  non-`'live'` provenance, or older than
  `VAULT_ECONOMICS_FRESHNESS_BUDGET_MS` (1 hour) — never a fabricated number,
  never a 5xx. The **sampling** side (`vault.sample_share_price`,
  `vault.sample_adapters` worker jobs, `backend/src/worker/handlers/vault.ts`)
  is the only code that still performs the `totalAssets()`/`totalSupply()`/
  per-adapter `eth_call`s. `vault.sample_adapters` reads EVERY configured
  adapter in **one** `eth_call` via Multicall3 `aggregate3` (the same batching
  `wallet-valuation.ts` uses), not one read each: three separate reads per tick
  against the free public Base RPC is the per-IP burst that 429s on the shared
  CI runner (#285/#287) and leaves the adapters unsampled. Each sub-call still
  carries `allowFailure`, so one adapter's reverted read never erases another's
  persisted value, and an unreadable read persists no row rather than a
  fabricated zero. A tick that could not read every configured adapter returns
  a DEGRADED result (`{ ok: false }`, §worker loop) rather than a success, so
  the worker's exponential-backoff retry re-reads within the same slot instead
  of leaving the hour unsampled until the next cron tick.
  Both jobs get a
  boot-time one-shot enqueue mirroring `wallet.sample_balances`'s cold start.
  A 30s in-process cache still sits in front of the request-path reads.
- **Config, not on-chain discovery** — `config.vault` (`backend/src/config.ts`)
  holds the vault + USDC addresses (already documented publicly at
  `frontend/public/views/docs/skill/installation.html` and `skills.html`) and
  the three adapter entries, all overridable via env (`VAULT_ADDRESS`,
  `USDC_ADDRESS`, `ADAPTER_MORPHO_ADDRESS`, `ADAPTER_AAVE_ADDRESS`,
  `ADAPTER_COMPOUND_ADDRESS`). Since #112 the three adapter entries ship with
  **real Base mainnet defaults** (`config.ts`), so a stock deploy is
  `configured: true` out of the box; overriding one with a reserved
  placeholder-form address (`PLACEHOLDER_ADDRESS_RE`) flips it back to
  `configured: false`.
- **RPC provenance + per-adapter `configured` (issue #50).** `config.ts` exports
  `resolveBaseRpcSource()` (env `BASE_RPC_SOURCE`, fail-closed on an
  unrecognized value; unset/`live` → `"live"`, `"stub"` → `"stub"`) and
  `resolveVaultAdapters()` (per-adapter `configured: Boolean(ADAPTER_*_ADDRESS)`).
  As of #294, `resolveVaultAdapters()` is still resolved **at call time** by
  `vault-economics.ts` (not module load — env-overridden adapters are always
  reflected), but it now only decides which persisted `vault_adapter_samples`
  row to look up and whether an unconfigured adapter is presented as `null`; the
  actual `eth_call` gating (an adapter still at its placeholder address is
  `configured: false` and its `totalAssets()` is **never called**, at sample
  time — its `balanceUsd` is always `null`, never a live-looking `$0`) moved to
  the `vault.sample_adapters` worker job alongside it.
- **`vault_share_price_history`** (migration `0012_vault_share_price_history.sql`)
  — one row per `(vault_address, sample_hour)`, upserted by the hourly
  `vault.sample_share_price` job (`backend/src/worker/handlers/vault.ts`,
  seeded in `db/seed.ts`, cron `0 * * * *`). 7-day APY
  (`(1 + growth)^(365/daysElapsed) - 1`) is computed from these samples in
  `computeApy7d`; fewer than two samples in the lookback yields `null`.
- **`vault_adapter_samples`** (issue #294, migration
  `0021_chain_indexer_samples.sql`) — one row per
  `(vault_address, adapter_address, sample_hour)`, upserted by the hourly
  `vault.sample_adapters` job (`backend/src/worker/handlers/vault.ts`, seeded
  in `db/seed.ts`). Each row carries `balance_usd`, `configured`, and
  `provenance` (`'live' | 'stub' | 'stale' | 'seed'`); an adapter whose batched
  `totalAssets()` sub-call reverted, returned empty, or could not be read at all
  persists no row, leaving the previous sample intact.
- **`GET /api/dashboards/vault-economics`** (`ROUTES.dashboards.vaultEconomics`,
  `backend/src/api/routes/dashboards.ts`) returns
  `{ asOf, stale, source, tvlUsd, sharePrice, totalShares, idleUsdc, apy7d, adapters }`
  where `source` is `'live'` or `'stub'` (RPC provenance — never presented as
  live when the backend is running against the hermetic stub) and `adapters` is
  the three `{name, address, configured, balanceUsd, balanceObservedAt,
  provenance}` entries (`balanceObservedAt`/`provenance` added in #294, echoing
  the backing `vault_adapter_samples` row's `sampled_at`/`provenance` exactly).
  `allocationView()` (`frontend/public/assets/js/app/alpine/views.js`)
  fetches this on init and binds it into `views/allocation.html`, showing a
  `stale` badge, a non-live badge when `source === 'stub'`, an explicit
  "Not configured" cell for a placeholder adapter, and last-known/null text
  instead of the retired static 2026-06-26 literals.
- **Preview/smoke fidelity (D14)** — `goldens/api-goldens.json` carries a real
  captured `/api/dashboards/vault-economics` entry so `bun run preview` and the
  e2e Playwright spec (`frontend/test/browser/vault-view.spec.ts`) render
  this section offline.

### 10.1 Wallet balances (prop-wallet valuation)

Decision [D16](../decisions.md#d16--live-wallet-balances-pipeline-from-base-rpc-supersedes-d1s-wallet-dashboard-exclusion)
brought a live prop-wallet valuation feed into scope (issues #84/#90),
replacing the baked `WALLET_SNAPSHOT_TOTAL_USD` scalar (the `/allocation` hero)
and the static 99-day `walletPerfView` series (`/performance`) that used to be
hardcoded in `alpine/views.js`.

- **`backend/src/chain/wallet-balances.ts`** — values every configured prop
  wallet's tracked assets **on the worker schedule, never on the request path**
  (#119): the per-minute `wallet.sample_balances` job
  (`backend/src/worker/handlers/wallet.ts`, cron `* * * * *` in `db/seed.ts`)
  drives `sampleWalletBalances()`, which reads ERC-20 balances and native ETH
  via `base-rpc-client.ts`, ERC-4626 strategy shares via `convertToAssets()`,
  and an off-chain SP500 config size, each priced through the existing keyless
  `token-prices.ts` (pinned $1 for USDC, GeckoTerminal/Yahoo otherwise) — no new
  chain SDK, same buildless-dependency discipline as §10's vault-economics
  client. A 30s in-process cache on the **sampler** keeps back-to-back worker
  runs cheap; it plays no part in serving requests.
- **Per-holding degrade, batched reads.** All on-chain amounts of a sample are
  fetched in at most **two `multicall3Aggregate3()` batches** (one
  `balanceOf`/`getEthBalance` sub-call per asset × wallet, then one
  `convertToAssets()` round for strategy NAVs), so a full sample costs ≤2 RPC
  calls instead of the old ~23-call fan-out the public Base node 429'd (#119).
  Failure isolation is layered: a reverted sub-call inside a successful batch,
  or a failed price fetch, degrades only *that* holding to its last-persisted
  Postgres sample (`provenance: "stale"`); a whole-batch RPC failure degrades
  **all chain-read legs** of that sample together to their last-persisted
  values (the config-sized SP500 holding is never a chain read and is
  unaffected). `provenance` is one of `live` (real chain + price read), `stub`
  (hermetic `BASE_RPC_SOURCE`/`PRICE_SOURCE=stub` fixtures), `stale` (a failed
  live leg), or `seed` (a pre-launch history row backfilled from the ported
  baked constants — never presented as a live sample; see
  `backend/src/chain/wallet-history-seed.ts` and migration `0014`'s honesty
  invariant). A value is never fabricated and never silently frozen.
- **`valueLeg`'s default price reader is `providerWalletPriceReader`, not the
  persisted-fallback reader (issue #294 guardrail).** `sampleWalletBalances`
  (this sampler, feeding the out-of-scope `/api/dashboards/wallet-balances`
  request path) calls the shared `chain/wallet-valuation.ts::valueLeg` with
  **no explicit reader argument**, so it always inherits this default: a
  live-price-fetch failure with a successful chain read is `{ok: false}` and
  the WHOLE holding falls through to `lastPersistedHolding()`'s fully-stale
  snapshot (amount, price, and value all from the same persisted row) — never
  a blend of a fresh on-chain amount with a stale persisted price. The
  wallet-sleeves sampler (`sampleWalletSleeves`, §3) needs the opposite
  behavior for its own feed and gets it by passing
  `persistedFallbackWalletPriceReader` **explicitly** at its own call site
  (`backend/src/worker/handlers/wallet.ts`) — `valueLeg`'s default must never
  be changed to accommodate that, since every caller that omits the argument
  (this one included) would silently inherit the different failure mode.
- **`wallet_balance_samples`** persists the last-known amount/price/value per
  symbol (the degrade floor above); the continuous `history` series read by
  `fetchWalletBalances()` is sparse per day (some tracked assets are
  intermittent) and seeded once from the legacy baked series, then accumulated
  forward.
- **`GET /api/dashboards/wallet-balances`** (`ROUTES.dashboards.walletBalances`,
  `backend/src/api/routes/dashboards.ts`) returns
  `{ asOf, totalUsd, source, priceSource, holdings, history }`, served **purely
  from the last persisted per-symbol samples** via
  `fetchPersistedWalletBalances()` — zero RPC on the request path, so a client
  request can never hit the rate-limited public node; per-holding
  value/provenance reflects the last scheduled sample exactly, and a symbol
  with no sample yet is `stale` with null values, never a 5xx. The frontend
  (`frontend/public/assets/js/app/alpine/views.js`) fetches it for both the
  `/allocation` hero total and the `/performance` wallet-performance chart,
  replacing the retired static figures.

---
