# UI-surface audit: robotmoney-frontend vs. deprecated robotmoney-bot-analytics

All paths relative to the worktree root
`/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260731-014516-bot-analytics-ui-port-plan`
(identical layout in the principal checkout). Audit date 2026-07-31, branch off `main` @ 5b9245d.

---

## 1. Frontend architecture

**Verdict: buildless, HTML-fragment SPA — one shell + a 115-line hand-rolled history-API
router + Alpine.js factories registered at boot + Chart.js CDN global. No React, no
web components, no htmx, no bundler, no npm deps in the frontend at all.**
Canonical description: `docs/architecture.md` §4 (lines 257–314) and §2 "The buildless
principle".

- **Shell** — `frontend/public/index.html`. Renders nav + `<main id="view"></main>` +
  footer once (lines 114–270). Loads, in order: shared CSS (lines 83–98), `config.js`
  (`window.RM_CONFIG.API_BASE_URL`, line 101), then `main.js` as a module and three CDN
  globals (lines 108–111): **p5 1.11.2** (hero canvases), **Chart.js 4.5.1 UMD**,
  **Alpine.js 3.14.9**.
- **Router** — `frontend/public/assets/js/app/router.js:40-79`: `render()` fetches the
  route's `views/*.html` fragment and injects it via `host.innerHTML`; Alpine's
  MutationObserver initializes any `x-data` in the injected markup. Emits
  `rm:before-view-change` / `rm:view-changed` events (lines 57, 78) that specs and canvas
  teardown rely on. Critically, **`<script>` tags inside fragments are dead** (innerHTML
  never executes them) — every view's behavior must be a `Alpine.data()` factory
  registered at boot (noted in `frontend/public/views/projects.html:6-7`).
- **Route table** — `frontend/public/assets/js/app/routes.js`. Explicit map for a handful
  of paths (lines 10–34), then **param routes are hand-written regexes** (lines 41–78:
  `/admin/committee/{subjects,members,sessions}/:id`, `/committee/members/:id`,
  `/committee/subjects/:id`, `/committee/takes/:id`, `/committee/apply/:id`,
  `/committee/:date/:subject`), then a catch-all `pathname → /views/<path>.html`
  (lines 79–80). So *any* file dropped in `views/` is instantly a route; dynamic `:id`
  routes each need a new regex line.
- **Alpine factories** — barrel `frontend/public/assets/js/app/alpine/views.js`
  (one-module-per-factory after maintainability finding 025) imports 16 register
  functions from `alpine/views/*.js` (+ `alpine/views/admin/*.js`); `main.js` registers
  them all before `Alpine.start()`. Heroes/canvas sketches in `alpine/heroes.js`,
  `p5-lifecycle.js`, `substrate.js`.
- **Chart library** — **Chart.js 4.5.1** (CDN UMD global), themed centrally by
  `frontend/public/assets/js/app/lib/chart-theme.js` (mirrors `tokens.css`;
  `applyChartDefaults()` at line 84). Consumers: `alpine/views/regime.js`,
  `allocation.js`, `wallet-perf.js` (performance page), `fee-chart.js`, `research.js`,
  plus `views.js`. The projects table's 30d sparkline is **hand-built inline SVG**, not
  Chart.js (`alpine/views/projects.js:117-131`). p5.js powers hero visuals only.
- **CSS system** — hand-rolled, **no Tailwind** (`docs/architecture.md:300-308`):
  `assets/css/tokens.css` (design tokens ported verbatim from the old `globals.css`),
  `design-system.css` (reset/utilities), `components.css` (semantic classes),
  `views.css`, `docs-shell.css`, plus per-marketing-section files under `css/sections/`.
  Data pages share an "**a2**" token look (hero/table classes) but each fragment
  **carries its own inline `<style>` copy** — e.g. `views/projects.html:206-449`
  duplicates the a2 base so the router-injected fragment styles itself. `brand-assets/`
  holds logo/OG sources; brand *decisions* live upstream in `robotmoney-context`
  (`CONTRIBUTING.md` "What belongs in this repo").
- **Server side** — Bun. `backend/src/api/index.ts` dispatches `/api/*` (lines 61–141)
  and falls through to `backend/src/api/static.ts` — `serveStatic()` (lines 34–52)
  serves files, and any extension-less unknown path gets the SPA shell (deep links
  work); `/docs/*` paths get the shell with the matching fragment pre-inlined into
  `<main>` for no-JS clients (`docsShell()`, lines 16–29). Shell = `Cache-Control:
  no-cache`, assets = `max-age=300` (lines 4–5).
- **SEO layer** — `frontend/public/assets/js/app/seo.js`: per-route `META` map (title/
  description/robots) rewritten client-side on navigation; every new route needs an
  entry or it inherits home's tags (comment at lines 100–104 records exactly that bug).
  `sitemap.xml` lists 31 URLs and is maintained by hand.
- **Preview mode** — `frontend/preview/` wrapper runs the SPA with `/api/*` intercepted
  client-side and answered from `goldens/api-goldens.json` (no backend);
  `docs/architecture.md:316+`, `CONTRIBUTING.md:11-30`.

## 2. Existing route inventory

From `views/` (catch-all makes every fragment a route) + `routes.js` + `sitemap.xml`
(31 canonical URLs). Public marketing/data surface:

| Route | Fragment | Renders |
|---|---|---|
| `/` (alias `/research`) | `views/home.html` | Marketing home: hero (p5 substrate), product/tokenomics sections |
| `/skills` | `views/skills.html` | MCP/agent skill install + usage docs page |
| `/tokenomics` | `views/tokenomics.html` | $ROBOTMONEY token/governance page (fee-chart + buyback-summary factories) |
| `/allocation` | `views/allocation.html` (849 ln) | Live vault/strategy allocation, per-adapter TVL, wallet holdings — Chart.js via `allocation.js` over `/api/dashboards/{vault-economics,wallet-balances,wallet-sleeves,allocation,token-metrics,buybacks}` |
| `/performance` (alias `/allocation2`) | `views/performance.html` | AUM/allocation history charts — `wallet-perf.js` |
| `/regime` | `views/regime.html` | Daily regime classifier dashboard — `regime.js` over `/api/dashboards/regime-snapshots` |
| `/regime/indicators` | `views/regime/indicators.html` | The 26 indicators explained (research prose) |
| `/regime-detection`, `/regime_2panel`, `/flow-field` | top-level fragments | Research survey / experimental visual pages |
| `/projects` | `views/projects.html` | Agentic-economy directory table (see §3) — **noindex**, dev-seed provenance notice |
| `/committee` | `views/committee.html` | IC hub: roster, sessions, takes — `committee.js` |
| `/committee/members/:id`, `/subjects/:id`, `/takes/:id`, `/:date/:subject`, `/apply`, `/apply/:id` | `views/committee/*.html` | Member profile, subject profile, signed-take receipt, session detail, application form/status |
| `/media` (+ `/media/articles`, `/media/videos`) | `views/media*.html` | Press/coverage lists |
| `/changelog` | `views/changelog.html` | Build log + roadmap |
| `/docs`, `/docs/skill/*`, `/docs/investment-committee/*` | `views/docs/**` | Docs shell (server pre-inlines fragment) |
| `/faq`, `/disclaimer`, `/smart-contract-risks`, `/tokenomics`, `/tech-proposal-march-16` | top-level fragments | Static prose |
| `/blog` + 7 posts | `views/blog/*.html` | Long-form posts (incl. legacy `/articles/treasury-allocation` alias, routes.js:22) |
| `/research/late-cycle-signals`, `/research/channel-divergence` | `views/research/*.html` | Research pages — `research.js` charts over `/api/dashboards/research-signals/:key` |
| `/visualizations` | `views/visualizations.html` (144 ln) | **Stub hub** — three cards linking to /regime, /allocation, /committee; "gallery still being assembled" |
| `/admin`, `/admin/committee{,/subjects/:id,/members/:id,/sessions/:id}` | `views/admin*.html` | Password-gated operator surface (task queue, research runs, committee ops) — `admin-surface.js`, `admin/committee-*.js` over `/api/admin/*` |
| anything else | `views/not-found.html` | 404 fragment (router fallback, router.js:52) |

~26 distinct user-facing routes (+7 blog, +9 docs children, + dynamic committee/admin
ids). **None of them is a bot-analytics dashboard page.**

## 3. Ported-surface audit — Projects

- **Frontend**: `views/projects.html` + `alpine/views/projects.js`. A single 13-column
  table: Project, Market Cap (per coin), FDV (per coin), MC/FDV, 24h % (per coin),
  30d sparkline (inline SVG), Data Quality score, Description, Website, Social, Facet
  pills (AGT/X402/COIN/WLT/VLT), Revenue 30d, Wallet Balance. Client-side **sorting on
  8 keys** with sticky-pin release (`projects.js:46-83`). **No filters, no search, no
  pagination, no row click-through** — rows are not links; there is **no
  `/projects/:slug` profile page** (no fragment, no routes.js entry, no API).
- **Provenance caveat (issue #346)**: the table renders the development seed
  (`backend/src/projects/smoke-seed.ts`, behind `DEMO_SEED_PROJECTS`); the page carries a
  visible "Development data" notice (`projects.html:31-35`), is `noindex` (`seo.js`
  /projects entry), out of sitemap, and the nav's ANALYTICS link points at the *old*
  `analytics.robotmoney.net/projects` (`index.html:127-130`).
- **API**: `GET /api/projects` (`contract/src/routes.js` `ROUTES.projects.list`) →
  `backend/src/api/routes/projects.ts:15-17` → `fetchProjects()` in
  `backend/src/projects/projections.ts`. Plus privileged
  `POST /api/projects/admin/:slug` (admin-token) writing `overview_short/long/
  description` only (`projects.ts:38-69`). No per-slug read endpoint.
- **Projection** (`projections.ts:30-198`): filters `status='active' AND
  data_coverage_score >= 55` (MIN_SCORE, line 13), joins four facet tables
  (`lobster_coins`, `tracked_wallets`, `openclaw_agents`, `agent_vaults`), sums
  trailing-30d `agent_revenue_daily`, builds 30d sparkline from
  `daily_coin_snapshots`, computes x402 flag, facet booleans, `maxMarketCap/maxFdv/
  walletTotalUsd/tvlUsd`, default sort sticky → max mcap → coverage score.
- **Transforms** (`backend/src/projects/transforms.ts`, 281 ln): pure normalization for
  pipeline handlers; `backend/src/worker/handlers/projects.ts` schedules the six ported
  jobs (`projects.discover/.refresh_coins/.refresh_wallets/.sync_revenue/
  .snapshot_daily/.fetch_vaults/.recompute_coverage`). Per `docs/architecture.md`
  §11 (lines 1273–1338): coin market data, revenue sync, vault TVL, coverage scoring
  are live-wired; **discovery is a static curated roster** (not the legacy 1963-line
  crawler) and **live wallet-balance refresh is unimplemented (handler throws)**; a
  fresh deploy without `PROJECTS_SOURCE=live` serves `{ projects: [] }`.

**Grade: the projects *table* is a faithful port of Projects.tsx's list view (columns +
sorting parity was an explicit goal), but the surface stops there — no profile pages,
no filters, and production data source not yet cut over.**

## 4. Gap list vs. original robotmoney-bot-analytics routes

| Original route | Status here | Evidence / notes |
|---|---|---|
| `/submit` | **MISSING** | No submission form/route anywhere; only admin-token `POST /api/projects/admin/:slug` (overview text, not project intake) |
| `/projects` | **PARTIAL** | Table with sorting exists (`views/projects.html`); no filters/search; dev-seed data, noindex, nav points at old subdomain (#346) |
| `/projects/:slug` | **MISSING** | No fragment, no routes.js regex, no `/api/projects/:slug`, no charts |
| `/` (List, gated) | **MISSING** | `/` here is the marketing home — entirely different content |
| `/market`, `/dashboard` | **MISSING** | No market dashboard. `/regime`+`/allocation`+`/performance` are treasury-product pages, different content; regime data could seed a partial rebuild |
| `/list`, `/list2`, `/list3` | **MISSING** | No trace (grep of routes.js/sitemap/views) |
| `/about` | **MISSING** | No about page (faq/disclaimer are different documents) |
| `/agents` | **MISSING** | No view/route; data exists (`openclaw_agents`, `daily_agent_snapshots`, `agent_revenue_daily`) |
| `/agents/:id` | **MISSING** | ditto |
| `/lobster` | **MISSING** | No view; `lobster_coins` + `daily_coin_snapshots` tables exist |
| `/lobster/:id` | **MISSING** | ditto |
| `/vaults` | **MISSING** | No view; `agent_vaults` + `daily_tvl_snapshots` exist (plus RM-own `vault_share_price_history`, `vault_adapter_samples`) |
| `/vaults/:id` | **MISSING** | ditto |
| `/wallets` | **MISSING** | No view; `tracked_wallets` + `daily_wallet_snapshots` exist; live refresh unimplemented |
| `/wallets/:id` | **MISSING** | ditto |
| `/methodology` | **MISSING** | `/regime/indicators` + `/regime-detection` are regime-classifier methodology, not the bot-analytics scoring methodology page |
| `/ask-mr-roboto` | **MISSING** | No chat surface; architecture explicitly bans LLM calls on the projects path (§11, issue #93/#96) — porting this collides with a documented invariant |
| `/gv-scratchpad` | **MISSING** | No trace |
| Password gate (DashboardLayout) | **PARTIAL analog** | `/admin` has password auth (`/api/admin/auth`, sessionStorage per US-A1) but it is an operator surface, not a gated analytics area; no gating exists for public data pages |
| NotFound | **EXISTS** | `views/not-found.html`, router fallback `router.js:50-52` |

Score: 1 EXISTS (NotFound), 1 PARTIAL (/projects), 1 partial-analog (password gate),
**17 of 20 routes entirely missing.**

## 5. Data-layer readiness

Backing that already exists (`backend/migrations/`):

- **Agents** — `openclaw_agents` (0013:40, protocol_standard + x402 score/txn/resource
  counters), `agent_revenue_daily` (0013:93), `daily_agent_snapshots` (0014_pipelines:82).
  Enough for an /agents list + per-agent revenue history chart.
- **Coins ("lobster")** — `lobster_coins` (0013:55 — mcap, fdv, pct24h, price, volume),
  `daily_coin_snapshots` (0013:106). Enough for /lobster list + price-history profile.
- **Vaults** — `agent_vaults` (0013:70, tvl_usd), `daily_tvl_snapshots`
  (0014_pipelines:106); RM's own vault additionally has `vault_share_price_history`
  (0012) and `vault_adapter_samples` (0021).
- **Wallets** — `tracked_wallets` (0013:81), `daily_wallet_snapshots`
  (0014_pipelines:95); RM prop wallets have `wallet_balance_samples` (0014) and
  `wallet_sleeve_samples` (0021) with live endpoints
  `/api/dashboards/{wallet-balances,wallet-sleeves}` already serving them
  (`backend/src/api/routes/dashboards.ts:33,61`).
- **Market/regime** — `regime_snapshots`, `raw_indicator_history` (0009),
  `research_signals`; served by `/api/dashboards/regime-snapshots` +
  `/api/dashboards/research-signals/:key` + admin raw-series reads.

**No backing at all**: /submit intake (no table/route/moderation), /ask-mr-roboto (no
chat/LLM backend; LLM use on this path is contractually excluded), /gv-scratchpad,
/list2-3 variants, and the original methodology content. **Big caveat**: all four facet
tables are populated by the dev seed or by a curated-fixture discovery roster unless
`PROJECTS_SOURCE=live` is set; live wallet refresh throws (§11). So "schema-ready" ≠
"data-ready" — the same #346 provenance problem that noindexed /projects would apply
to every new facet page.

New API endpoints will be needed for every list/detail page (only the aggregate
`GET /api/projects` exists today); contract routes are added in `contract/src/routes.js`
(vendored to the frontend via `bun run sync-contract` — never hand-edited,
`CONTRIBUTING.md` placement map).

## 6. Constraints a port must respect

1. **Buildless invariant** (`docs/architecture.md` §2, §4): no build step, no frontend
   npm deps, CDN globals only. New views = HTML fragments + boot-registered Alpine
   factories (fragment `<script>`s never execute). Every new dynamic route needs:
   regex in `routes.js`, factory in `alpine/views/` + barrel registration, `seo.js`
   META entry, sitemap decision, and a2 CSS carried inline or promoted to shared css.
2. **Goldens discipline** (`CONTRIBUTING.md:40-68`): every new/changed API call must be
   captured into `goldens/api-goldens.json` **from a real running backend** (`bun run
   smoke` + `goldens:update`); CI drift gate `scripts/tests/unit/goldens-drift.test.ts`
   blocks stale goldens; preview mode must keep working backend-free. ~15 new routes ⇒
   ~15+ new goldens entries and preview-intercept coverage.
3. **Test pyramid** (`playwright.config.ts`, `frontend/test/browser/`,
   `.github/workflows/`): each shipped view has a Playwright spec (18 specs today,
   e.g. `projects.spec.ts`, `allocation-view.spec.ts`); there is a **visual-snapshot
   golden** spec (`regime-visual.spec.ts` + `-snapshots/`, 1% maxDiffPixelRatio,
   animations disabled). `frontend.yml` alone runs only `preview-smoke.spec.ts`; the
   full browser suite runs inside `e2e.yml`'s **full-stack `bun run smoke` readiness
   gate** (single Blacksmith runner; cycles are hours-long per memory notes, and the
   user's global test-coverage invariants forbid silent skips / zero-test greens).
4. **Contract boundary**: endpoint paths live only in `contract/src/routes.js`,
   re-vendored by `bun run sync-contract`; frontend talks HTTP-only through
   `lib/api.js`.
5. **File-permissions gate**: `.github/file-permissions.json` is deny-by-default per
   GitHub login per operation, enforced by `scripts/check-contribution.ts` on every PR —
   new files under new paths may require dictionary changes.
6. **Honesty/provenance contract** (§11, issue #98/#346): no fabricated data; pages
   backed by seed data must carry provenance notices and stay noindexed; pipeline
   handlers degrade loudly, never partially write. A port that surfaces
   agents/coins/wallets/vaults pages inherits the "real source before indexing"
   burden that currently parks /projects behind a notice.
7. **Process**: one concern per PR; roadmap state lives in the GitHub Plan issue, not
   committed docs; decisions (brand/strategy) belong upstream in `robotmoney-context`;
   cross-repo needs become issues, never edits.
