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
    DexScreener best-pair fallback), Virtuals/x402 revenue sync, ERC-4626
    vault TVL reads (Base RPC), coverage-score recomputation, and (issue #346)
    per-wallet native-ETH balance on chain `"base"` — reusing the SAME
    batched-Multicall3 + GeckoTerminal-priced + persisted-fallback valuation
    machinery the prop-wallet feeds share (`chain/wallet-valuation.ts`), not a
    bespoke port (`backend/src/projects/access/live-source.ts`).
  - **Not yet live**: project *discovery* returns a curated static roster
    (`backend/src/projects/fixtures/dataset.ts`), not the legacy 1963-line
    autonomous multi-source crawler — a tracked follow-up. Wallet balance is
    live ONLY for `chain === "base"`; the discovery roster's handful of
    Ethereum/Solana treasuries have no RPC/pricing path in this codebase yet,
    so that ONE wallet's read throws (never a fabricated number) while every
    other wallet in the same `projects.refresh_wallets` run still updates
    (issue #346 also fixed a bug where one bad wallet used to abort the whole
    run instead of degrading alone).
  - A fresh deploy with no `PROJECTS_SOURCE=live` opt-in serves an empty
    directory (`{ projects: [] }`), not synthetic data — `selectProjectsDataSource()`
    (`backend/src/projects/access/select.ts`) is fail-safe toward the hermetic
    fixture source, and fails closed (refuses to boot the pipeline) if `prod`
    lacks the explicit live opt-in.
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
