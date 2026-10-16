# Projects directory

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 11. Projects directory (agentic-economy analytics)

A first-class read surface, ported off the deprecated `robotmoney-bot-analytics`
Supabase stack (`src/pages/Projects.tsx`) onto this repo's Postgres backend
across issues #70, #87, #91, #93, #96, #98. It lists onchain AI agents/coins/
wallets/vaults ("Zero Human Companies") the way the legacy site did, but reads
from this repo's own tables and pipelines instead of Supabase.

- **Data model** (`backend/migrations/0013_projects.sql`,
  `0014_projects_pipelines.sql`) — one identity row per project (`projects`:
  slug, display name, description, admin-managed `overview_short`/
  `overview_long`, coverage score, `has_*` facet flags) joined to four facet
  tables (`openclaw_agents`, `lobster_coins`, `agent_vaults`, `tracked_wallets`)
  and their daily-snapshot tables (`daily_agent_snapshots`,
  `daily_coin_snapshots`, `daily_tvl_snapshots`, `daily_wallet_snapshots`,
  `agent_revenue_daily`) — the append-only history each metric's sparkline/
  coverage scoring reads.
- **Read path** — `backend/src/projects/projections.ts` (`fetchProjects()`) is
  the single aggregation layer: joins the facets onto each project, sums
  wallet balances, builds a 30d primary-coin price sparkline (falling back to
  trailing agent activity/revenue for tokenless projects, #338), and applies
  the same `MIN_SCORE` coverage floor and sort order (sticky-pin → max market
  cap → coverage score) as the original page. `backend/src/api/routes/
  projects.ts` is a thin adapter exposing `GET /api/projects`
  (`ROUTES.projects.list`); `frontend/public/views/projects.html` renders it
  via the boot-registered `projectsView()` factory. There is no directory-wide
  revenue total on the DTO (issue #346 dropped it — see below).
- **Ingestion pipeline status — partially ported, not the full legacy suite.**
  `backend/src/worker/handlers/projects.ts` ports six of the ~25 legacy
  bot-analytics edge functions onto the task queue's kind→handler pattern
  (`projects.discover`, `.refresh_coins`, `.refresh_wallets`, `.sync_revenue`,
  `.snapshot_daily`, `.fetch_vaults`, `.recompute_coverage`), scheduled via
  `job_schedules` (`backend/src/db/seed.ts`) at the same cadence as the legacy
  crons. Within that ported set, coverage is uneven by design:
  - **Live and wired**: coin market data (CoinGecko `/coins/markets` +
    DexScreener best-pair fallback; with `COINGECKO_API_KEY` set in the worker
    lanes the call uses the paid Pro host `pro-api.coingecko.com` with the
    `x-cg-pro-api-key` header, and unset or blank keeps the keyless public
    host — the worker logs the tier and host, never the key, issue #1047), Virtuals/x402 revenue sync, ERC-4626
    vault TVL reads (Base RPC), coverage-score recomputation, and (issue #346)
    per-wallet native-ETH balance on chain `"base"` — reusing the SAME
    batched-Multicall3 + GeckoTerminal-priced + persisted-fallback valuation
    machinery the prop-wallet feeds share (`chain/wallet-valuation.ts`), not a
    bespoke port (`backend/src/projects/access/live-source.ts`).
  - **Not yet live**: project *discovery* returns a curated static roster
    (`backend/src/projects/fixtures/dataset.ts`), not the legacy 1963-line
    autonomous multi-source crawler — a tracked follow-up. Wallet balance is
    live ONLY for `chain === "base"`; the discovery roster's handful of
    Ethereum/Solana treasuries have no RPC/pricing path in this codebase yet.
    `refreshWallets` asks the source's `supportsWallet(address, chain)` before
    each read (issue 1275): a wallet on another chain, or whose address is not
    `0x` plus 40 hex, is skipped with no read and no error line, keeps its
    last-persisted `balance_usd`, and is counted in the run's `unsupported`
    total with one info-level summary line per run. A supported Base wallet
    whose read throws still logs an error and degrades the run (never a
    fabricated number), while every other wallet in the same
    `projects.refresh_wallets` run still updates (issue #346 also fixed a bug
    where one bad wallet used to abort the whole run instead of degrading
    alone).
  - **Refresh cost per run** (issue 1373): `refreshWallets` reads every
    supported wallet through ONE batched source call,
    `walletBalancesUsd(addresses, chain)`. The live source builds one
    Multicall3 `getEthBalance` sub-call per wallet through
    `readChainAmountsBatched`, and `multicall3Aggregate3` sends them in POSTs
    of at most `MULTICALL3_MAX_SUBCALLS_PER_POST` (100) sub-calls
    (`backend/src/chain/base-rpc-client.ts`). The ETH USD price is read once
    per run. So the 785 production Base wallets cost 8 Base RPC POSTs and one
    price read: at most 32 s against the shared 0.25 calls/s budget even from
    an empty bucket (about 12 s from a full burst of 5),
    where one POST per wallet took 52 min per attempt (production capture
    2026-10-14). A reverted sub-call fails only its wallet. A chunk whose POST
    throws fails only that chunk's wallets. Each failed wallet keeps its
    last-persisted `balance_usd` and degrades the run as above.
  - **Per-vault isolation** (issue 1291): `fetchVaults` reads each active
    live vault on its own. A vault whose read throws logs one error line,
    keeps its last-persisted `tvl_usd`, and gets `last_refresh_status =
    'failed'`; the other vaults still update and the run returns `ok: true`
    with a `failed` count. Only a run in which every vault failed returns
    `{ ok: false, status: "degraded" }`. A failure no retry can change
    (`PermanentVaultReadError`: `totalAssets()` or `asset()` reverts, or the
    address is not `0x` plus 40 hex) does not enter the loop's 2 s, 4 s
    retry: when every failure is permanent the result carries
    `terminal: true`. Production's two Bankr LP rows (strategy_type
    `lp-fees`) are not ERC-4626 and revert `totalAssets()` on Base, which
    used to abort every run with `updated: 0` (production capture
    2026-10-14).
  - **Bankr token rows deactivated** (issue 1382): neither Bankr `lp-fees`
    address is a vault or a pool. `0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b`
    is the BankrCoin (BNKR) ERC-20, already the project's BNKR coin;
    `0x7689006F6C3A3473449E42b628544E60D0bCCb07` is a plain ERC-20 named
    'Bankr' with no Base pair (eth_call on Base, 2026-10-16). Owner decision
    2026-10-16: deactivate both rows, no LP valuation. Migration 0124 sets
    `is_active = false` on exactly those two rows (D66) and keeps their
    `tvl_usd`, `last_refresh_status` and `daily_tvl_snapshots` history.
    `fetchVaults` reads only active rows, so it no longer reads either
    address. The roster seed no longer lists either vault, and the discover
    upsert never sets `is_active`, so no discovery run brings them back. The
    Bankr project keeps its BNKR coin and its wallet.
  - A fresh deploy with no `PROJECTS_SOURCE=live` opt-in serves an empty
    directory (`{ projects: [] }`), not synthetic data — `selectProjectsDataSource()`
    (`backend/src/projects/access/select.ts`) serves the hermetic fixture
    source only when the test harness injected it through the armed test seam
    (`backend/src/test-seam.ts`, issue #973), and fails closed (every projects
    pipeline throws) in every deployed process without the explicit live
    opt-in; no environment value selects the fixture. Issue #1208: production v0.5.4 ran `smoke` without the opt-in,
    when the refusal covered `prod` only, and persisted the fixture's 4
    projects, 4 tracked wallets and 2 agent vaults. Those rows stay until the
    purge part of issue #1208 ships (owner decision 2026-10-08: guard only, no
    purge in v0.6.0); the gates report their live-refresh failures as known
    issue 1208.
- **Degrade/honesty contract (issue #98, extended by #346).** Every pipeline
  handler extracts from its provider(s) *before* writing anything; on any
  failure it logs loudly, writes nothing (last-persisted rows are left
  intact), and returns `{ ok: false, status: "degraded" }` rather than a
  partial or fabricated write — the same discipline as the vault-economics
  (§10) and wallet-balances (§10.1) chain reads. Live provider fetches carry a
  hard timeout (`liveFetchTimeoutMs`, default 8s) so a stalled socket fails
  fast instead of pinning a worker slot. Issue #346 applies the D24
  "sample on a worker schedule, serve persisted rows on the request path,
  never fabricate on failure" pattern to the coin and wallet facets
  explicitly: every `ProjectCoin`/`ProjectWallet` row carries its own
  `refreshedAt` (ISO timestamp of the last successful sample, or `null` if
  never refreshed) and `stale` (true when missing or older than a small
  multiple of that facet's own refresh cadence — `COIN_REFRESH_FRESHNESS_
  BUDGET_MS`/`WALLET_REFRESH_FRESHNESS_BUDGET_MS`, `projects/projections.ts`)
  so a consumer can always see how old a served value is, never just a
  boolean. Revenue has no such treatment (and no DTO field at all) because no
  persisted, non-fabricated revenue source covers the directory as a whole —
  only a subset of Virtuals-protocol agents (`syncRevenue`'s DexScreener-
  derived fee estimate); the honest move was to drop the column rather than
  serve a partly-real, partly-empty figure as if it were uniform.
- **Admin-managed overviews, no AI enrichment (issue #93/#96).** `overview_short`/
  `overview_long`/`description` are free text written *only* through the
  privileged `POST /api/projects/admin/:slug` route
  (`updateProjectOverview()`, admin-token gated the same way swarm routes
  are). There is no LLM/AI call anywhere on the projects read or write path.
  The scheduled `projects.discover` upsert deliberately excludes
  `overview_short`/`overview_long` from its `ON CONFLICT DO UPDATE` set, so a
  re-run never clobbers admin-authored text.

---
