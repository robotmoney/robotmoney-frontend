# Architecture

Robot Money frontend + analytics backend. A clean rewrite of robotmoney.net that
drops React/Next.js in favor of a **buildless, browser-native** stack, with a
small HTTP API and a Postgres-backed task queue, self-hosted on DigitalOcean — a
single `docker-compose` box for CI/demo, and a tiered topology (DO compute+storage,
Cloudflare for DNS+observability) in production (see [topology.md](./topology.md)).

For the *why* behind each choice, see [decisions.md](./decisions.md).

---

## 1. Goals & scope

- **Preserve the marketing UI** of robotmoney.net (reproduce the look exactly).
- **Cherry-pick two feature areas**: the **regime/research** data views (the
  regime classifier + its regime-family research signals) and the **Investment
  Committee**. Allocation / vault / wallet dashboards are out of scope, **except**
  the `/allocation` page's vault-economics slice (TVL, share price, adapters,
  7-day APY), brought into scope by a live Base RPC pipeline — see
  [decisions.md §D15](./decisions.md#d15--live-vault-economics-pipeline-from-base-rpc-supersedes-d1s-vault-dashboard-exclusion)
  and §10 below — **and** the prop-wallet valuation feed (live holdings +
  history behind `GET /api/dashboards/wallet-balances`), brought into scope the
  same way — see
  [decisions.md §D16](./decisions.md#d16--live-wallet-balances-pipeline-from-base-rpc-supersedes-d1s-wallet-dashboard-exclusion)
  and §10 below. Buybacks — the last static remnant of that line — were brought
  into scope by
  [decisions.md §D17](./decisions.md#d17--remove-the-last-baked-frontend-data-live-buybacks-token-metrics-sleeves-supersedes-d1s-remaining-exclusions):
  `GET /api/dashboards/buybacks` is served live from ROBOTMONEY Transfer logs
  (`backend/src/chain/buyback-logs.ts`, refreshed by the `buybacks.refresh`
  worker job). Nothing of the original out-of-scope line remains a static port.
- **No build step.** No bundler, transpiler, or compiler — the browser does all
  the work at runtime; only evergreen browsers are supported.
- **Consolidate backends onto one Postgres** (Docker for CI/demo; a DO Managed
  Postgres HA cluster in production — see [topology.md](./topology.md)).
- **Rebuild the data pipeline** as a custom Postgres-backed task queue (replacing
  the old GitHub Actions cron + Node scripts).
- **Clean frontend/backend separation** — one repo now, designed to split into
  two later with zero source edits.

Out of scope for v1: the allocation / vault / wallet dashboards, the generative-art
visualizations, blog/media editorial, and other secondary pages — **except** the
live vault-economics slice of `/allocation` (§D15), the live prop-wallet
valuation feed (§D16), and the live buyback / token-metrics / wallet-sleeves
feeds that retired the last baked literals (§D17).

---

## 2. The buildless principle

The defining constraint: **no ahead-of-time transpile, compile, or bundle.**

Allowed (browser-native or runtime-only): `<script type="module">`, import maps,
prebuilt library files from a CDN, and Bun's native TypeScript execution on the
backend (Bun runs `.ts` directly at startup, no build artifact).

Forbidden: webpack/vite/rollup, JSX, framework SFC compilation, a TypeScript build
step, and a Tailwind compile step.

Consequences that shape everything below: the frontend is plain HTML + CSS + JS;
styling is hand-written CSS (no Tailwind); the component layer is Alpine.js loaded
as a global script; the backend runs `.ts` files directly via Bun. **All
server-side components run on Bun.**

---

## 3. Repository layout (split-ready)

Three top-level directories. They live together now for convenience but are
designed so each becomes its own repo via `git filter-repo`, with no code changes.

```
robotmoney-frontend/
  contract/    # the ONLY thing shared across the boundary: route paths + DTO types
  frontend/    # buildless SPA (static files): shell, views, Alpine, CSS, assets
  backend/     # Bun API (Bun.serve) + Postgres task queue/workers + SQL migrations (owns the DB)
  mcp/         # (IC, Phase 5) RM-hosted member-facing MCP server — Bun; see §9.5
  docs/        # this documentation
```

### The boundary

- **Nothing in `frontend/` imports from `backend/` or vice versa.** Both depend
  only on `contract`.
- The frontend reaches the backend **only over HTTP**, through
  `frontend/public/assets/js/app/lib/api.js`, using the API origin from
  `window.RM_CONFIG.API_BASE_URL` (set by `frontend/public/config.js`). `""` means
  same origin — the default, since the `api` co-serves this surface's SPA assets at
  its subdomain root (in production, `committee.robotmoney.net`; see
  [topology.md](./topology.md)).
- The database schema and migrations live in `backend/`; the frontend knows only
  the DTOs in `contract`.

### `contract/`

- `src/routes.js` — endpoint paths + a `path()` helper. Runtime values, the single
  source of truth for URLs. Imported by both sides.
- `src/*.d.ts` — request/response DTOs as pure TypeScript declarations (no runtime
  form). The backend uses them via `import type`; the frontend's editor tooling via
  JSDoc `import('@robotmoney/contract').Foo`.
- The frontend **vendors** `routes.js` (copied to
  `frontend/public/assets/js/app/contract/` by `bun run sync-contract`) so static
  serving needs no symlinks. The copy is a file copy, not a build; CI runs
  `bun run check-contract` to prevent drift.

On the eventual split, `contract/` is published (private npm registry / GitHub
Packages) or vendored via git submodule; both repos pin a version. Bumping the
contract is the explicit, reviewable coupling point.

---

## 4. Frontend

A **client-side SPA**: one shell, client-side routing, views fetched and swapped
into `<main>`. All browser-native, no build.

```
frontend/public/
  index.html                 # the app shell: nav + <main id="view"> + footer
  config.js                  # window.RM_CONFIG = { API_BASE_URL } (per-env, no secrets)
  views/*.html               # one HTML partial per route (home, allocation, regime, committee/*)
  assets/
    css/{tokens,design-system,components}.css
    js/app/
      router.js              # tiny history-API router (zero deps)
      pages/                 # per-view entry: registers the view's Alpine.data factories
      alpine/                # Alpine.data factories (e.g. substrate — p5 lifecycle)
      lib/{api,format,transforms,charts}.js
      contract/              # vendored routes.js from /contract
    p5.min.js  logo.svg  ...
```

### Composition model

- **HTML-first.** Markup is authored as HTML (in the shell and in `views/*.html`),
  not generated by JavaScript.
- **Alpine.js** provides all reactivity/binding (`x-data`, `x-show`, `x-for`,
  `@click`) on light-DOM markup. Loaded as one classic CDN `<script>`.
- **No Web Components.** Lifecycle (e.g. tearing down the hero's p5 sketch when the
  view changes) is handled by Alpine's `init()` / `destroy()` on the element's
  `x-data` factory. The SPA shell renders nav/footer once as plain HTML, so nothing
  needs a component for reuse either.
- **Everything is light DOM** — markup the browser and Alpine see directly, so the
  global hand-written CSS applies and Alpine's directives work without any shadow
  boundary.

### Routing

`router.js` is a small history-API router: it intercepts clicks on internal links,
`pushState`s, fetches the route's `views/*.html` partial, injects it into
`#view`, restores scroll, and marks the active nav link; `popstate` handles
back/forward. The backend serves `index.html` for any unknown (non-asset, non-API)
path so deep links and refreshes work.

### CSS

Hand-written, no Tailwind, in three files:
- `tokens.css` — design tokens (colors, fonts, easing) ported verbatim from the
  original `globals.css`; the Google-Fonts import.
- `design-system.css` — base/reset, scrollbar, keyframes, and reusable utilities
  (`text-gradient`, `glow-green`, `grid-pattern`, `prose-rm`, …), ported verbatim.
- `components.css` — semantic component classes that replace the original Tailwind
  utility classes, written during the markup port.

### Dependencies (all plain CDN files, no transpiling service)

- **Alpine.js** — reactivity (global `<script>`).
- **chart.js** (+ datalabels) — dashboard charts (UMD global, dashboard views only).
- **p5.js** — hero/visual canvases (global `<script>`).

### Preview mode (goldens-backed, no backend)

Lightweight hosting for **agentic development of the marketing surface** (the
buildless SPA *is* the marketing site). A contributor — human or agent — working
from a git checkout can view and iterate on the site with **no backend, database,
or workers**. Full design in
[`docs/preview-server-spec.md`](./preview-server-spec.md); contributor workflow in
[`CONTRIBUTING.md`](../CONTRIBUTING.md). The mechanism:

**The preview server (`scripts/serve-preview.ts`, `bun run preview`).** A ~40-line
`Bun.serve` that (a) serves the **live** `frontend/public` tree so source edits
show on refresh, and (b) **mocks every `/api/*` route from the committed goldens**
(`goldens/api-goldens.json`). The SPA is **unmodified** — it still requests
same-origin `/api/*`; the server answers from the goldens (query dropped — a
golden is one point in time), and writes (POST/PUT/DELETE) are accepted no-ops.
It binds a **random free port** (printed on start) so concurrent previews never
collide, with an index.html SPA fallback for client routes. There is **no build
step and no `file://`** — it's the real static SPA served over HTTP.

**Goldens (`goldens/api-goldens.json`).** One committed JSON keyed by request
pathname → response body, covering every route the frontend calls. It is a *mock*:
**field shapes are real, values are point-in-time.** Goldens are **captured from a
real running system** (a deployed test cluster or a local `bun run demo` stack)
via `bun run goldens:update` — never hand-authored and never derived from other
fixtures, so the shapes stay faithful to what the backend actually returns.

**Correctness is the change author's responsibility.** There is no nightly
regeneration. An agent (or human) that changes the system such that an API's
shape changes must recapture the goldens in the same PR — the same discipline as
updating tests or the contract. A CI **drift gate** (see the spec) blocks a PR
whose goldens no longer match the code; the fix is `bun run goldens:update`.

**Data fidelity caveat.** Because values are mock/point-in-time, preview is for
**layout, copy, components, and navigation** — not for trusting numbers or charts.
For realistic, evolving data (real analytics + simulations) run the full stack
with `bun run demo` (see [`demo-spec.md`](./demo-spec.md)).

---

## 5. Backend

A small server on **Bun** using `Bun.serve` — no framework, no build (Bun runs the
TypeScript sources directly).

- `src/api/index.ts` — the `Bun.serve` entry: a `/health` check and the API routes
  (`comments`, `dashboards`, `committee`, `projects`, `admin`), using `postgres`
  (postgres.js) with raw SQL.
- **Serves the static frontend too.** When `STATIC_DIR` is set, the same process
  serves `frontend/public` via `Bun.file`, with an `index.html` fallback for SPA
  deep links — so the SPA and its API are **same-origin** (no CORS) with no
  reverse proxy. In production this surface is its own subdomain
  (`committee.robotmoney.net`), Cloudflare-proxied for TLS (see
  [topology.md](./topology.md)); CORS headers remain for an optional split-origin
  setup.
- `src/worker/` — the always-on task-queue worker (see §7).
- `src/db/` — connection pool (`client.ts`) and the migration runner (`migrate.ts`).
- `src/lib/` — small helpers (e.g. `keys.ts`, sha256 access-key hashing).
- `migrations/` — forward-only numbered `*.sql`, applied once each, tracked in
  `schema_migrations`. Safe to run on every boot.

### Authentication & authorization

Four distinctions, kept deliberately separate:

- **Transport/identity vs authorship.** *Identity* answers "who is calling";
  *authorship* answers "whose data this is." They are independent checks — an
  authenticated caller still must prove a write is genuinely theirs.
- **Two identity mechanisms by surface.** The member-facing **hosted MCP server**
  uses **OAuth 2.1** (Streamable HTTP). The **REST API** (browser/dashboards, plus
  the sibling submit/onboarding endpoints) uses the sha256 **access-key** hash
  (`keys.ts`). Public reads need neither.
- **Authorship = member signature.** Recommendations carry a signature the member
  produces **on their own side**; the backend only **verifies** it against the
  member's registered public key. RM never holds member private keys. (This is the
  on-chain seam: later only the signature is anchored.)
- **Credential exchange and membership are separate.** Active members exchange
  their member ID and bearer credential through OAuth `client_credentials`.
  Committee membership starts with `apply` (metadata + public key), followed by
  an administrator-controlled `applied → active` transition.
- **Scoped roles.** Every write is authorized to a role: members write only their
  own recommendations, the analytics provider only regime data, the host only
  session lifecycle, the public reads only — currently enforced in the API layer.
  Migration `0007_committee_rls_stub.sql` documents deferred Postgres RLS; it is
  intentionally not active until requests use transaction-scoped database roles.

---

## 6. Data model

One Postgres database consolidates everything previously split across committed
CSV/JSON, Upstash Redis (comments), and GitHub-as-DB (committee). Full schema in
`backend/migrations/`; the groups:

- **Backends** (`0001_backends.sql`): `comments`; the committee tables
  (`committee_members`, `committee_subjects`, `committee_sessions`,
  `committee_takes`, `committee_briefs`, `committee_subject_snapshots`,
  `committee_applications`, `committee_submissions`); and the single-row
  `allocation_framework` (shared by the allocation dashboard and the IC). The IC
  tables are detailed in §9.4 and get reconciled toward an append-only
  `committee_recommendations` store in Phase 5.
- **Dashboard time-series** (`0002_dashboards.sql`): `vault_tvl`,
  `wallet_balances`, `prices`, `vault_apy`, `regime_snapshots`,
  `regime_indicators`, `research_signals`. The worker upserts on natural unique
  keys (e.g. `(ts, …)`, `(date)`) so reruns overwrite rather than duplicate; the
  API reads these.
- **Task queue** (`0003_task_queue.sql`): `jobs`, `job_schedules`, `job_runs`.

---

## 7. Task queue & workers

A Postgres-backed queue replaces the old GitHub Actions cron + `scripts/`. The
worker (`backend/src/worker/`) runs three loops:

- **Claim loop** (`loop.ts`): claims one due job with `FOR UPDATE SKIP LOCKED`
  (safe across N workers), runs its handler by `kind`, and records the outcome in
  `job_runs`. On failure it retries with exponential backoff via `run_after` up to
  `max_attempts`, then marks the job `dead`.
- **Scheduler** (`scheduler.ts`): for each due `job_schedules` row it enqueues a
  job with a `dedupe_key` of `kind + slot` (`ON CONFLICT DO NOTHING` → exactly-once
  per slot) and advances `next_run_at` via a cron parser.
- **Reaper** (`reaper.ts`): requeues jobs stuck in `running` past a visibility
  timeout (crashed worker), bounded by `max_attempts`.

**Idempotency** comes from upserting on natural keys; **exactly-once scheduling**
from the dedupe key; **concurrency safety** from `SKIP LOCKED`. Handlers
(`worker/handlers/`) are registered per `kind`; the `analytics.run` handler drives
the analytics suite (§7.1).

### Admin dashboard (task-queue observability)

A read-only operator surface over the queue tables — `backend/src/api/routes/admin.ts`
serving `/api/admin/*`, and the buildless `/admin` frontend view
(`frontend/public/views/admin.html` + the `adminJobsView` factory in
`alpine/views.js`). It SELECTs only; there is no new table:

- `GET /api/admin/jobs` — recent `jobs` (all kinds) + all `job_schedules` + a
  `{ byStatus, byKind }` count summary.
- `GET /api/admin/jobs/:id` — one job plus its recent `job_runs` (400 on a
  non-numeric id, 404 when unknown). A run's `output` (jsonb) and `error` (text)
  ARE the per-run logs the view pretty-prints.
- `GET /api/admin/runs?kind=&status=&limit=` — the recent `job_runs` feed across
  all jobs (the log feed), with optional filters.
- `POST /api/admin/auth` — validates the password for the login form.

All four are PRIVILEGED with the same guard the committee/projects admin routes
use: `ADMIN_TOKEN` presented as `X-Admin-Token` (constant-time compared), or —
only outside prod — the `config.allowInsecure` convenience path. Fail-closed: the
403 check runs before any DB work. The `/admin` view is intentionally NOT in the
public nav; the token is kept in `sessionStorage` for the tab. The `bun run demo`
launcher generates a fresh random password each run and prints it to the
interactive TUI ONLY (never logged, never written to `demo-state.json`).

### 7.1 Analytics suite (six-stage pipeline)

All analytics — the regime classifier and the research signals — are instances of
one abstraction in `backend/src/analytics/`, so they share data-sourcing,
normalization, scheduling, persistence, and API exposure. The directory is split
into six independently testable stages — **access → extract → transform → analyze
→ store → report** — each a leaf that can be exercised in isolation:

- **`types.ts`** — the leaf shapes (`Point`, `SeriesSpec`) that flow through every
  stage.
- **`access/`** — the data seam for the orchestrator. `data-source.ts` defines the
  `AnalyticsDataSource` interface (`fetchIndicators` / `fetchResearchInputs` /
  `fetchBacktestExtras`) and the production default **`liveDataSource`** — pure REAL
  keyless fetchers, NO synthetic substitution: a failed/empty fetch returns `[]` and
  the orchestrator degrades to the persisted-real floor via `mergeSeries` (never to
  seeded data). `hermetic-source.ts` is the deterministic, offline
  **`hermeticDataSource`** (seeded walks from `provider.ts`'s `seededProvider`) used by
  CI and the demo default. **`ANALYTICS_SOURCE`**, resolved by
  **`resolveAnalyticsSource()`** in `backend/src/analytics/index.ts`, is the SINGLE
  authoritative selector: unset/`live` → `liveDataSource`, `hermetic` →
  `hermeticDataSource`, any other value refused loudly (fail-closed). The legacy
  `PROVIDER` env knob, the `config.analyticsProvider` field it fed, and the
  `fetcher-provider.ts` test scaffolding it drove were **removed** (2026-07-14
  maintainability review, finding 011 — they had zero production consumers);
  `ANALYTICS_SOURCE` is the only source selector, and a backend guard test
  (`tests/no-dead-provider-chain.test.ts`) greps `backend/src` to keep the dead
  chain from reappearing.
- **`extract/`** — pull raw series from KEYLESS public sources. `http.ts`
  (timeout/abort fetch, plus an opt-in on-disk TTL cache in `fetch-cache.ts`), one
  pure parser per source — **`fred.ts`, `yahoo.ts`, `defillama.ts`,
  `blockchain-com.ts`, `coinmetrics.ts`, `geckoterminal.ts`, `shiller.ts`,
  `edgar.ts`** (JSON/CSV in → `Point[]` out, throw on garbage) — and `sources.ts`,
  the indicator-id → fetch+parse wiring that `liveDataSource.fetchIndicators` drives
  (each source isolated; one failure drops only its own series, which then falls back
  to the persisted floor).
- **`transform/`** — normalize/clean. `math.ts` is the shared pure math
  (percentile-in-window, sign, rolling beta, ratios, `isoDay`, …) so normalization
  is identical suite-wide; `grid.ts` reshapes gappy real series onto the dense
  daily grid (`shapeDaily` forward-fill, `ratioByDate`).
- **`analyze/`** — the computations (pure, DB-free). `tool.ts` is the
  `AnalyticTool` interface (`id, kind, inputs, dependsOn, compute, persist`) + a
  `Registry` that topologically orders `dependsOn` and runs/persists tools — a tool
  may **compose** another's output (e.g. a future "regime tempered by
  channel-divergence") with no special-casing. `research.ts` holds the research
  payload shape; `regime.ts`, `channel-divergence.ts`, `late-cycle.ts` are the
  tools (their `compute()` is pure; `persist()` is a one-line delegate to `store/`).
  `backtest.ts` (`computeBacktest`) and `correlations.ts` (`computeCorrelations`)
  add the asof-only regime **backtest** + predictive **correlations** payloads
  (ported from the original `regime-snapshot.json`).
- **`store/`** — the only SQL writes. `regime-store.ts` (`saveRegimeSnapshots`),
  `research-store.ts` (`persistResearchSignal`), and `raw-history-store.ts` (the
  append-only persisted raw floor) all upsert on natural keys; `floor-seed.ts`
  performs the opt-in cold-DB floor seed (`ANALYTICS_FLOOR_SEED=1`).
  `saveRegimeSnapshots` also bakes the asof-only **`backtest`** + **`correlations`**
  jsonb payloads onto the latest `regime_snapshots` row (columns added by migration
  `0010_backtest_correlations.sql`; NULL on historical rows), sourced via
  `AnalyticsDataSource.fetchBacktestExtras` (SPX/ETH price levels + the DTB3 3-month
  T-bill yield).
- **`report/`** — `projections.ts` owns all SQL reads + the row→DTO map
  (`fetchRegimeSnapshots(range)` → `{ latest, history }`, carrying the asof-only
  `backtest`/`correlations` on `latest`; `fetchLatestResearchSignal(key)`). The
  contract DTOs **`BacktestPayload`** / **`CorrelationsPayload`**
  (`contract/src/dashboards.d.ts`) type those payloads. The HTTP route
  `api/routes/dashboards.ts` stays a thin adapter — for this slice it only
  parses/clamps `range` and calls these (the same file now fronts ~8 dashboard
  endpoints, incl. the live chain feeds of §10). MCP and the frontend stay
  consumers across the HTTP boundary.

Three pipelines run through these stages:

- **`regime`** — 26 registry indicators (`backend/src/analytics/analyze/indicators.ts`)
  across three panels: **macro** (`T10Y2Y`, `DFII10`, `T5YIE`, `HY_OAS`, `DXY`,
  `ICSA`, `VIX`, `COPPER_GOLD`) and **on-chain** (`DEFI_TVL`, `STABLES`,
  `BTC_ACTIVE`, `ETH_ACTIVE`, `BTC_MVRV`, `BTC_ETH`, `ETH_TREND`, `NEW_TOKENS`,
  `DEFI_GROWTH`, `STABLES_GROWTH`) drive the 2-panel composite (0.5×macro +
  0.5×on-chain); a third **factor** panel (`SPX_TREND`, `IWM_SPY`, `SPHB_SPLV`,
  `MTUM_SPY`, `IWF_IWD`, `XLU_SPY`, `XLP_XLY`, `SHILLER_CAPE`) is fetched,
  persisted, and served as a **display-only** third index card on `/regime` — it
  is not part of the composite. Per-indicator sign-adjusted percentile → panel +
  overall composite + regime label history → **`regime_snapshots`** (`panels`
  column lists which panels are populated on the asof row).
- **`channel-divergence`** — `BTC`, `QQQ`, `SPY` → BTC beta vs the risk-appetite
  factor + BTC/QQQ relative strength gauges → **`research_signals`**.
- **`late-cycle-signals`** — `SPY`, `RSP`, `MNA`, `MARGIN`, `CONF` → index
  concentration / M&A / margin debt / confidence gauges → **`research_signals`**.

The worker runs the whole suite daily at **22:30 UTC** (`analytics.run`, cron
`30 22 * * *` — after US market close, so the fetched raw is settled end-of-day
data); the API exposes regime at `/api/dashboards/regime-snapshots?range=`
and each research signal at `/api/dashboards/research-signals/:key`; the frontend
renders `/regime` (including the backtest + predictive-correlations panels) and the
`/research/*` views (mirroring the original site's surfaces). The regime DTO also
carries an explicit **staleness block** — `{ asof, serverDate, ageDays, stale,
thresholdDays }`, computed in `backend/src/analytics/report/regime-projection.ts`
(zero snapshots counts as stale, #124) — which `/regime` surfaces as a loud
staleness banner (`frontend/public/views/regime.html`); the demo boot self-heals
with loud logging if the boot classify leaves a frozen snapshot
(`scripts/lib/demo-main.ts`). Adding an analytic =
write a tool + register it + add a job schedule + a route; nothing else changes.

---

## 8. Deployment

Two shapes, one codebase. The canonical map of DNS, origins, tiers, and vendors is
[topology.md](./topology.md) (decision D13); the GitOps pipeline and the Cloudflare
/ DO credentials CI needs are in [deployment.md](./deployment.md). This section
covers what *this repo* ships.

**CI & demo — single box**, `docker-compose.yml`:

- `postgres` + `api` + `worker`. The `api` process **also serves the static
  frontend** (`STATIC_DIR=/srv/frontend`) — one origin, no app-level proxy.
- **DB modes** are driven by `DATABASE_URL` + the postgres volume:
  - *ephemeral* (CI): throwaway, `docker compose down -v`.
  - *demo*: named `pgdata` volume persists across restarts.

**Production — tiered on DigitalOcean, Cloudflare for DNS+observability** (D13;
credentials in [deployment.md](./deployment.md)):

- **API tier** — `api` + `worker` on a DO droplet at its own subdomain
  (`committee.robotmoney.net`); the `api` co-serves this surface's SPA assets at the
  subdomain root. Cloudflare-proxied; a DO Cloud Firewall limits ingress to
  Cloudflare IPs.
- **Data tier** — `DATABASE_URL` points at a **DO Managed Postgres HA cluster**
  (no `postgres` container).
- **Static tier** — marketing is served separately from a **DO Spaces CDN** on the
  apex/`www`, not by this `api`.
- **Config**: the only required env var is `DATABASE_URL`. The frontend's only
  input is `API_BASE_URL` in `config.js` (`""` = same origin on its subdomain).
  Secrets (Anthropic/FRED/RPC) live in the droplet env, not in the frontend.
- **TLS** is provided by Cloudflare's proxy (the droplet serves a Cloudflare Origin
  CA cert).

**Preview mode — no-backend hosting for development.** Independent of both hosted
shapes, `bun run preview` serves the live SPA with every `/api/*` route mocked
from committed goldens (`goldens/api-goldens.json`) on a random free port — for
developing the marketing surface without a backend. Mechanism in §4 "Preview mode
(goldens-backed, no backend)"; workflow + fidelity caveats in
[`CONTRIBUTING.md`](../CONTRIBUTING.md) and
[`docs/preview-server-spec.md`](./preview-server-spec.md).

---

## 9. Investment Committee (feature architecture)

> Status: design reference for the IC feature (built in Phase 5). It reuses the
> shared infrastructure above — the boundary (§3), the buildless frontend (§4), the
> Bun server (§5), Postgres (§6), and the task queue (§7) — and adds a member-facing
> MCP surface and a signed-submission protocol.

The IC's value is the **structured, signed, attributable recommendation record** —
not the reasoning. Committee members are **autonomous third parties** who run their
own data/agent/model and publish their own memos; their only obligation is to POST
a schema-valid, **signed** recommendation before a session's window closes. Robot
Money is the **protocol host + optional data utility**, never a committee
participant. **RM generates no member content**: a member who does not submit is
recorded as **absent**, never fabricated. No blockchain in v0 (signature anchoring
is a stubbed seam, §9.3).

**Concept model — one committee, many of everything else.** There is exactly
**one** Investment Committee. It has many **members** (the autonomous third parties
above, each with an analytical lens — macro risk, on-chain flows, momentum,
contrarian); it reviews many **subjects** (the portfolios/wallets under review,
e.g. `woon`/Woon Treasury, `mav`/Mav Holdings); and it runs many **sessions** —
one per `(date, subject)` pair — each advancing through the lifecycle
`scheduled → brief_published → collecting → window_closed → aggregated → published`
(§9.4). Each member posts at most one signed **recommendation** (a "take") per
session; a non-submitting member is recorded **absent**, never fabricated. The
plurals (members / subjects / sessions / takes) are the moving parts — they are
**not** multiple committees.

### 9.1 Where the IC lives

It spans the layers but only through the contract (§3). One addition to the repo
layout: an **`mcp/`** service — RM's hosted, member-facing MCP server (§9.5).

| Layer | IC responsibility |
|---|---|
| `contract/` | `ROUTES.committee` + `committee.d.ts` DTOs — the only thing crossing boundaries. |
| `backend/` | API routes (`src/api/routes/committee.ts`), committee Postgres tables, and the worker handlers that own the session lifecycle (§9.4). Owns the DB. |
| `frontend/` | Read-only committee views (members/subjects/sessions/apply) reaching the API via `app/lib/api.js`. |
| `mcp/` | The **member transport** (§9.5): an RM-hosted, tool-agnostic MCP server (Streamable HTTP + OAuth 2.1). Members participate from any MCP-capable agent — nothing to install. |

All four depend only on `contract`; `frontend/` and `mcp/` reach `backend/` solely
over HTTP. Like `api`/`worker`, the MCP server is a Bun service.

### 9.2 Actors & trust model

| Actor | Identity | Scoped writes | Reads |
|---|---|---|---|
| **Committee member** | OAuth 2.1 (MCP surface) or access-key hash (REST sibling) for identity; **signing key** for authorship | their **own signed recommendations** (scoped to `member_id`) | briefs, regime, published sessions |
| **RM analytics provider** | service credential / role | **regime snapshots** (+ RM-run subject snapshots) | — |
| **Protocol host** (the worker) | the worker process | sessions, briefs, lifecycle state, aggregation | all |
| **Public reader** | anonymous | nothing | published sessions, regime, memo links |

**Core invariant:** every write is an authenticated, authorized, *scoped* action —
a member cannot write regime data; the analytics provider cannot post a
recommendation; neither can mutate sessions. Member and analytics-provider are
*roles*; either can later be a genuine third party with no architectural change.

### 9.3 The protocol = two contracts

**Submission** (`CommitteeSubmission` in `committee.d.ts`, POST
`ROUTES.committee.submit`): `{ memberId, date, subjectId, nonce, stance,
confidence, body | memoUrl, signature }`. The structured stance/confidence (+ typed
recommendation shape) is the canonical machine-readable commitment; long-form prose
can live at a member-hosted `memoUrl` the report links out to.

**Signature envelope** — two independent checks on every submission:
- **Transport/identity** (*who is calling*): OAuth 2.1 on the MCP surface, or the
  access-key hash (`backend/src/lib/keys.ts`, sha256, never plaintext) on the REST
  sibling.
- **Authorship** (*whose take this is*): the `signature` over the canonical payload,
  produced member-side and verified against the member's registered public key. **RM
  never holds the private key.**

v0 stores payload **and** signature in Postgres. Activating chain settlement later =
add an anchor step writing *only the signature* (or a commitment) to a contract —
nothing else changes.

### 9.4 Data model & session lifecycle

A committee migration extends §6 with append-only, audit-flavored tables:
`committee_members`, `committee_member_keys` (public-key + access-key-hash
registry), `committee_subjects`, `committee_sessions`, `committee_briefs`,
**`committee_recommendations`** (append-only — payload + signature + nonce +
`verified`; the canonical store behind a take/submission),
`committee_subject_snapshots`, and `audit_log` (actor, action, scope, ts). Regime
data is written by the analytics provider (§9.6).

The **task queue (§7) is the orchestrator** — there is no GitHub-Actions cron. The
session lifecycle is a chain of idempotent job kinds:

```
scheduled → brief_published → collecting → window_closed → aggregated → published
```

- `committee.open_session` (cron) — pick the rotation subject, create the session.
- `committee.publish_brief` — assemble the brief (regime + subject snapshot + recent
  sessions); open the submission window.
- *window:* members submit via the MCP `submit_recommendation` tool or the REST
  `submit` sibling — both calling the same **domain handler**, not the worker.
- `committee.close_window` (cron at deadline) — stop accepting submissions.
- `committee.aggregate` — deterministic rollup + optional editorial synthesis **over
  the takes actually posted**; absences recorded as absent. **No host-authored takes.**
- `committee.publish` — mark the session visible via API + frontend.

### 9.5 Surfaces — one core, two transports

The backend is a **domain/service layer** (plain Bun/TS functions over Postgres:
`getRegime()`, `getBrief()`, `getSession()`, `verifyAndStoreSubmission()`,
`aggregateSession()`, …) where window enforcement, signature verification, and
authz live **once**. Two thin transports share it:

- **REST/JSON** (`Bun.serve`, paths in `ROUTES.committee`) — the website transport
  and the fallback for non-MCP clients/tests. Reads public
  (`members`, `subjects/:id`, `sessions`, `brief`); writes scoped (`apply` +
  `apply/unlock`, `submit`, and a role-gated analytics `regime` write).
- **MCP** (§9.5.1) — the member-first transport; its tools wrap the same domain
  functions (over the REST API).

#### 9.5.1 Member surface — MCP-first

A member's default surface is RM's **hosted MCP server** (`mcp/`) over **Streamable
HTTP** with **OAuth 2.1** — no local/stdio package, members connect by URL (listed
in the MCP Registry). Because RM hosts it, **signing stays member-side**: OAuth
proves *which member*; the member signs the canonical payload in their own
environment and passes the `signature` in, which the server only **verifies**.
`get_signing_payload` returns the exact canonical bytes to sign.

Tools: **read** (`get_open_session`, `list_sessions`, `get_session`, `get_brief`,
`get_regime`, `get_subject_snapshot`); **analysis** (optional RM helpers —
`classify_regime`, `actual_vs_target_weights`, `concentration_metrics` — usage
recorded as provenance; members may bring their own); **write**
(`get_signing_payload`, `submit_recommendation` with the member signature,
`post_memo`). Participation is tool-agnostic and RM imposes no model/framework/data
source.

> Decision flag: member-side signing preserves the on-chain seam (§9.3) under a
> hosted-only server, at the cost of a member signing step. A simpler v0 could rely
> on OAuth identity alone and defer per-payload signatures, but that weakens the
> "signature anchors on-chain later" property. Default: keep member signing.

### 9.6 RM analytics provider (the data utility)

The regime classifier runs on the provider's own infrastructure and **writes regime
snapshots to Postgres under a scoped credential** — same pattern as a member posting
a take, different scope. Members consume it **optionally** via the regime read
(`ROUTES.dashboards.regimeSnapshots`) and may record which RM tools vs. their own
data they used. Producer (privileged write) and consumers (read) are cleanly
separated; this actor can later be a third party with no change.

### 9.7 Testing & demo

**No mocks of the submit path; no host-authored takes.** E2E runs the real
single-box stack (Postgres + API + worker + the hosted MCP server + the
analytics-provider client + N member agents, each OAuth'd as a distinct member and
signing with its own key) and asserts: regime write lands and reads back; member
signatures verify; a no-show renders **absent**, not fabricated; out-of-window POSTs
are rejected; cross-role writes are denied; a published session renders the *real*
takes. The demo is the same harness at scale. Hermetic: a missing dependency fails
the run rather than silently skipping. Real-LLM member takes are a separate
opt-in: `COMMITTEE_REAL_INFERENCE=1` (exercised by the nightly
`.github/workflows/committee-opencode-nightly.yml`, never per-PR) swaps the
templated take for a keyless opencode-zen call that is **time-bounded**
(`OPENCODE_TIMEOUT_MS`, default 120s — a hung inference kills the subprocess
instead of freezing the session), and member runs are settled rather than
`Promise.all`'d, so a per-member inference/session failure renders that member
**absent** instead of failing the whole session (#122, `mcp/src/e2e.ts`).

### 9.8 Phase-5 build order & reconciliation

Build order: (1) committee migration (§9.4 tables + key registry); (2) finalize the
`CommitteeSubmission`/`CommitteeTake` DTOs; (3) API `committee.ts` (reads, `apply`,
`submit` with access-key + signature verification + window enforcement);
(4) orchestration handlers + `job_schedules` rows; (5) role-gated analytics regime
write; (6) hosted MCP server + E2E harness; (7) frontend pages; (8) stubbed
on-chain anchor adapter. Steps 1–6 are the irreducible core.

Reconciliation with the current scaffolding (the migration written in §6 reflects an
earlier prototype): the canonical store becomes append-only
`committee_recommendations` (reconcile `committee_takes`/`committee_submissions`
into it); `CommitteeTake.model`/`generatedAt` become **optional member-declared
provenance** (a take is member-submitted and signed, not host/LLM-generated);
add **signature verification + a member public-key registry** (today `keys.ts`
covers access-key hashing only); add the **role/authz layer** (member /
analytics-provider / host), ideally with Postgres row-level security as
defense-in-depth; and add the **role-gated regime write** endpoint. The worker's
committee handlers are **orchestration** (open/brief/close/aggregate/publish), never
generation of member takes.

---

## 10. Vault economics & wallet balances (live chain data)

Decision [D15](./decisions.md#d15--live-vault-economics-pipeline-from-base-rpc-supersedes-d1s-vault-dashboard-exclusion)
brought the `/allocation` page's vault-economics slice into scope, backed by a
real Base (chainId `8453`) JSON-RPC read pipeline — the first exception to the
allocation/vault/wallet out-of-scope line (§1). Decision
[D16](./decisions.md#d16--live-wallet-balances-pipeline-from-base-rpc-supersedes-d1s-wallet-dashboard-exclusion)
brought the prop-wallet valuation feed into scope the same way (§10.1). Decision
[D17](./decisions.md#d17--remove-the-last-baked-frontend-data-live-buybacks-token-metrics-sleeves-supersedes-d1s-remaining-exclusions)
(issue #111) then retired the last baked frontend literals entirely: buybacks
(`GET /api/dashboards/buybacks` — ROBOTMONEY Transfer-log reads in
`backend/src/chain/buyback-logs.ts`, refreshed by the `buybacks.refresh` job,
cron `15 */6 * * *`, persisted via migration `0015_buyback_swaps.sql`), token
metrics (`/token-metrics`), per-wallet sleeves (`/wallet-sleeves`), and the
`allocation_framework` read are all live endpoints now — nothing of the
original out-of-scope line remains static. The shared endpoint contract (DTOs,
provenance fields, degrade rules) those feeds were built against is
[contract-live-data.md](./contract-live-data.md).

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
- **`backend/src/chain/vault-economics.ts`** — reads the vault's
  `totalAssets()`/`totalSupply()` (→ `sharePrice = totalAssets / totalSupply`,
  `null` iff `totalSupply = 0`), the vault's idle USDC balance
  (`USDC.balanceOf(vault)`), and every **configured** adapter's `totalAssets()`
  (an unconfigured/placeholder adapter is never `eth_call`'d — see below),
  behind a 30s in-process cache. On any RPC failure it returns
  `stale: true` with the **last-persisted share-price sample** (or `null`) —
  never a fabricated number, never a 5xx.
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
  `resolveVaultAdapters()` (per-adapter `configured: Boolean(ADAPTER_*_ADDRESS)`),
  both resolved **at call time** by `vault-economics.ts` (not module load) so the
  hermetic demo/CI stub (`BASE_RPC_SOURCE=stub`, set alongside `BASE_RPC_URL` by
  the `DEMO_HERMETIC=1` compose layer) and env-overridden adapters are always
  reflected. An adapter still at its placeholder address is `configured: false`
  and its `totalAssets()` is **never called** — its `balanceUsd` is always
  `null`, never a live-looking `$0`.
- **`vault_share_price_history`** (migration `0012_vault_share_price_history.sql`)
  — one row per `(vault_address, sample_hour)`, upserted by the hourly
  `vault.sample_share_price` job (`backend/src/worker/handlers/vault.ts`,
  seeded in `db/seed.ts`, cron `0 * * * *`). 7-day APY
  (`(1 + growth)^(365/daysElapsed) - 1`) is computed from these samples in
  `computeApy7d`; fewer than two samples in the lookback yields `null`.
- **`GET /api/dashboards/vault-economics`** (`ROUTES.dashboards.vaultEconomics`,
  `backend/src/api/routes/dashboards.ts`) returns
  `{ asOf, stale, source, tvlUsd, sharePrice, totalShares, idleUsdc, apy7d, adapters }`
  where `source` is `'live'` or `'stub'` (RPC provenance — never presented as
  live when the backend is running against the hermetic stub) and `adapters` is
  the three `{name, address, configured, balanceUsd}` entries.
  `allocationView()` (`frontend/public/assets/js/app/alpine/views.js`)
  fetches this on init and binds it into `views/allocation.html`, showing a
  `stale` badge, a non-live badge when `source === 'stub'`, an explicit
  "Not configured" cell for a placeholder adapter, and last-known/null text
  instead of the retired static 2026-06-26 literals.
- **Preview/demo fidelity (D14)** — `goldens/api-goldens.json` carries a real
  captured `/api/dashboards/vault-economics` entry so `bun run preview` and the
  e2e Playwright spec (`frontend/test/browser/allocation-view.spec.ts`) render
  this section offline.

### 10.1 Wallet balances (prop-wallet valuation)

Decision [D16](./decisions.md#d16--live-wallet-balances-pipeline-from-base-rpc-supersedes-d1s-wallet-dashboard-exclusion)
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
  trailing-30d revenue and wallet balances, builds a 30d primary-coin price
  sparkline, and applies the same `MIN_SCORE` coverage floor and sort order
  (sticky-pin → max market cap → coverage score) as the original page.
  `backend/src/api/routes/projects.ts` is a thin adapter exposing
  `GET /api/projects` (`ROUTES.projects.list`); `frontend/public/views/
  projects.html` renders it via the boot-registered `projectsView()` factory.
- **Ingestion pipeline status — partially ported, not the full legacy suite.**
  `backend/src/worker/handlers/projects.ts` ports six of the ~25 legacy
  bot-analytics edge functions onto the task queue's kind→handler pattern
  (`projects.discover`, `.refresh_coins`, `.refresh_wallets`, `.sync_revenue`,
  `.snapshot_daily`, `.fetch_vaults`, `.recompute_coverage`), scheduled via
  `job_schedules` (`backend/src/db/seed.ts`) at the same cadence as the legacy
  crons. Within that ported set, coverage is uneven by design:
  - **Live and wired**: coin market data (CoinGecko `/coins/markets` +
    DexScreener best-pair fallback), Virtuals/x402 revenue sync, ERC-4626
    vault TVL reads (Base RPC), and coverage-score recomputation
    (`backend/src/projects/access/live-source.ts`).
  - **Not yet live**: project *discovery* returns a curated static roster
    (`backend/src/projects/fixtures/dataset.ts`), not the legacy 1963-line
    autonomous multi-source crawler — a tracked follow-up. Live wallet-balance
    refresh (the legacy Alchemy-backed port) is unimplemented; the handler
    throws loudly and degrades to the last-persisted balance rather than
    fabricating one.
  - A fresh deploy with no `PROJECTS_SOURCE=live` opt-in serves an empty
    directory (`{ projects: [] }`), not synthetic data — `selectProjectsDataSource()`
    (`backend/src/projects/access/select.ts`) is fail-safe toward the hermetic
    fixture source, and fails closed (refuses to boot the pipeline) if `prod`
    lacks the explicit live opt-in.
- **Degrade/honesty contract (issue #98).** Every pipeline handler extracts
  from its provider(s) *before* writing anything; on any failure it logs
  loudly, writes nothing (last-persisted rows are left intact), and returns
  `{ ok: false, status: "degraded" }` rather than a partial or fabricated
  write — the same discipline as the vault-economics (§10) and wallet-balances
  (§10.1) chain reads. Live provider fetches carry a hard timeout
  (`liveFetchTimeoutMs`, default 8s) so a stalled socket fails fast instead of
  pinning a worker slot.
- **Admin-managed overviews, no AI enrichment (issue #93/#96).** `overview_short`/
  `overview_long`/`description` are free text written *only* through the
  privileged `POST /api/projects/admin/:slug` route
  (`updateProjectOverview()`, admin-token gated the same way committee routes
  are). There is no LLM/AI call anywhere on the projects read or write path.
  The scheduled `projects.discover` upsert deliberately excludes
  `overview_short`/`overview_long` from its `ON CONFLICT DO UPDATE` set, so a
  re-run never clobbers admin-authored text.
