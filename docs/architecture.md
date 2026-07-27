# Architecture

Robot Money frontend + analytics backend. A clean rewrite of robotmoney.net that
drops React/Next.js in favor of a **buildless, browser-native** stack, with a
small HTTP API and a Postgres-backed task queue, self-hosted on DigitalOcean — a
single `docker-compose` box for CI/demo, and a tiered topology (DO compute+storage,
Cloudflare for DNS+observability) in production (see the
[network topology section](#network-topology--dns-origins--vendors)).

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
  Postgres HA cluster in production — see the topology's
  [data tier section](#7-data-tier--postgres-ha-cluster-do)).
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
  docs/        # this documentation
```

### The boundary

- **Nothing in `frontend/` imports from `backend/` or vice versa.** Both depend
  only on `contract`.
- The frontend reaches the backend **only over HTTP**, through
  `frontend/public/assets/js/app/lib/api.js`, using the API origin from
  `window.RM_CONFIG.API_BASE_URL` (set by `frontend/public/config.js`). `""` means
  same origin — the default, since the `api` co-serves this surface's SPA assets at
  its subdomain root (in production, `committee.robotmoney.net`; see the
  topology's [subdomain map](#3-the-surfaces--subdomain-map)).
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

### Test, eval, and tooling layout

Status: target layout (D23). Two rules govern where things go.

**L1 — A directory is a selectable unit of CI cost.** CI selects by path
(`bun test <dir>`, `paths-ignore`, workflow globs), so any subset CI needs to run
*without* the rest must have its own directory. A test that needs Docker, a real
network, or a real model call never shares a directory with a pure unit test.

**L2 — Shared code is named for its domain, never for its consumer.** `stack/`,
`agent/`, `toolchain/` state what belongs in them; `lib/`, `utils/`, `helpers/`
invite anything. Code shared between the demo runtime and test/eval time lives in
a domain directory, not in a bucket named after who imports it.

Per-package test layout, by cost class:

| Path | Class | Needs | Runs |
|---|---|---|---|
| `<pkg>/tests/unit/` | unit | nothing | every PR (the default `bun test` target) |
| `<pkg>/tests/integration/` | integration | Docker, a local stack | PR ready-for-review |
| `<pkg>/tests/live/` | live | real external network | nightly |
| `evals/` | eval | Docker + network + **real inference** | nightly, sweep-only |

`backend/tests/` is the reference implementation of this and needs no change: it
is subdivided by surface (`api/`, `db/`), provisions its dependency in
`preload.ts` (which fails loudly rather than skipping), separates `support/` from
`fixtures/`, and already tags cost in filenames (`*-live.test.ts`).

**`live` means a real external SERVICE whose availability is the flake source** —
FRED, the Base RPC, `raw.githubusercontent.com`. Fetching a **pinned, cached
release artifact** (`scripts/lib/rmpc-fetch.ts`) is a build input, not a live
dependency: the version is pinned in code and the download is cached, so it is
classed `integration` and stays on the per-PR path. Without this distinction a
literal reading of the table above would demote §11 R6's byte-exactness gate
(`scripts/tests/integration/rmpc-canonical-apply.test.ts`) to nightly, which
would be a real loss of coverage on the critical path.

Realized so far — both packages with tests are split, and the split is about
**selectability only**: no test moved off the per-PR path.

- `contract/tests/` → `unit/` + `live/`. The package's `test` script is pinned to
  `bun test tests/unit` (a bare `bun test` would sweep `live/` back onto the
  default path) and `test:live` runs `bun test tests/live`; the unit half runs in
  the required `integration` workflow, the live half only in
  `nightly-fetchers.yml`'s `contract-live-urls` job.
- `scripts/tests/` → `unit/` (30 files: nothing but the checkout) + `integration/`
  (11 files: the docker CLI or daemon, GitHub Releases egress, a spawned
  `jq`/`git`/Playwright binary, or backend's own `node_modules`), with
  `fixtures/` kept at the `tests/` root as a sibling of both, mirroring
  `backend/tests/`. `test:unit` and `test:integration` select one class each and
  **the `integration` workflow runs both, as two separately named unconditional
  steps** — so a red is attributable to a cost class, and dropping the expensive
  half would have to be done in workflow config, in the open. `bun run test`
  stays `bun test scripts/tests`, which recurses, so the local one-command
  aggregate cannot silently lose a class either.

Directory selection replaces the env-gate pattern
(`RUN_LIVE_FETCHERS`/`EXPECT_LIVE`) rather than guarding it — there is no
conditional skip to get wrong. A selector pointed at a missing or emptied
directory exits non-zero on Bun, so `0 tests collected` is red, not a vacuous
green.

Harness code (today `scripts/`) separates by role rather than by medium:

```
bin/         executable entrypoints — the `bun run` targets
demo/        demo RUNTIME (the long-lived process): main, tui, schedule, committee/
stack/       SHARED compose lifecycle: profiles (core | full), ports, volumes
agent/       SHARED member-agent primitives: Dockerfile, run, config, classify
toolchain/   SHARED external-binary fetchers (rmpc)
checks/      one-shot CI checks where the exit code IS the verdict
ops/         credential/deploy utilities
```

The eval suite lives OUTSIDE the harness tree, in its own top-level cost class
(L1), split by what each half has to boot:

```
evals/onboarding/
  isolated/    layers 0-3 — NO server (runtime, skill install, rmpc toolchain, keygen+signing)
  admission/   layer 4    — `core` stack only (postgres + api), sampled
  support/     layer prompts, stopped-container probe, signature harvest, scorecard
```

**L3 — Dependency direction.** Tests and evals may import runtime and shared
code; **runtime must never import test or eval code**; both may import shared.
This is enforced by two grep checks in the same shape as
`backend/scripts/check-no-supabase.sh` and `check-no-ai-overview.sh` — the exit
code IS the verdict — not by convention alone. Both run per-PR in the required
`integration` job, and both are *executed against a planted violation* by a unit
test, so neither can go vacuously green:

| Check | Asserts | Self-tested by |
|---|---|---|
| `scripts/checks/check-no-test-imports-in-runtime.sh` | no runtime/shared tree (`backend/src`, `contract/src`, `frontend/public/assets/js`, `scripts`) imports from a `tests/`, `__tests__/`, `__mocks__/`, or `evals/` path or a `*.test.ts`/`*.spec.ts` module | `scripts/tests/unit/runtime-import-guard.test.ts` |
| `scripts/checks/check-eval-keyless.sh` | §11.3 E1–E2 — no key, paid model, or environment read at all, and no mock, injection seam, or conditional skip, under `evals/` | `scripts/tests/unit/evals-guard.test.ts` |

Both refuse to pass by absence: a scan whose target tree has vanished is a hard
failure, never a silently empty check.

Path citations are gated too. `scripts/tests/unit/test-path-citations.test.ts`
extracts every `scripts/tests/…`, `scripts/checks/…`, `contract/tests/…`,
`backend/tests/…`, and `evals/onboarding/…` reference from docs, workflow YAML,
and source comments and asserts the file exists — the split moved ~35 files and
broke ~40 such citations with a green CI, which is exactly the failure mode a
reader (or an onboarding agent) cannot detect on their own.
`docs/code-review/**` is excluded: those are dated artifacts describing the tree
as it was.

**Migration is incremental, not a big-bang reorg.** New directories are created
as the work that needs them lands (D22's extractions land directly in `stack/`
and `agent/`); the cost-class split of `scripts/tests/` is a mechanical file move
with no logic change; renaming `scripts/` itself is explicitly **not** planned
(D23).

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

> This section is the **canonical, complete spec** of the preview feature
> (decisions [D14](./decisions.md#d14--preview-mode-goldens-backed-over-the-baked-frozen-single-file),
> [D19](./decisions.md#d19--hosted-preview-urls-on-cloudflare-pages-revises-d14-and-d13),
> [D20](./decisions.md#d20--no-bake-preview-hosting-via-cloudflare-git-integration-revises-d19);
> the former `preview-server-spec.md` is retired).

Lightweight hosting for **agentic development of the marketing surface** (the
buildless SPA *is* the marketing site). A contributor — human or agent — working
from a git checkout can view and iterate on the site with **no backend, database,
or workers**. Contributor workflow in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

**Layout.** Three pinned locations:

- `frontend/preview/` — the preview wrapper `index.html` plus the Cloudflare
  static-hosting files `_redirects` (one line: `/ /preview/index.html 200`),
  `_headers` (`X-Robots-Tag: noindex` for `/*`), and `404.html` (frame-escape
  handler: redirects a missing path back to `/#<path>`). Deliberately a
  **sibling** of `frontend/public/`, so production never serves any of it.
- `frontend/public/` — the production SPA, byte-for-byte untouched by preview.
- `goldens/api-goldens.json` — the goldens. Pinned at `goldens/` because it is a
  **shared test fixture**: `frontend/test/browser/allocation-view.spec.ts`,
  `tokenomics-fees.spec.ts`, and the provenance note in
  `frontend/public/views/regime/indicators.html` all reference it there.

**The wrapper (`frontend/preview/index.html`).** A client-side iframe wrapper
that fetches `/index.html` (the production SPA), runs it inside a same-origin
iframe, and **patches the iframe's fetch and history BEFORE document.open()** so
the interception is in place when the SPA's HTML runs. The SPA is **unmodified**
— it still requests same-origin `/api/*` as normal, unaware of any interception.
GET `/api/*` calls are answered from goldens fetched from
`/goldens/api-goldens.json` into JS memory (query string dropped — a golden is
one point in time; an un-goldened route 404s); non-GET requests
(POST/PUT/DELETE) return `{ok: true, mocked: true}` no-ops. A red "PREVIEW"
watermark remains permanently visible. SPA navigation
(`history.pushState`/`replaceState`) mirrors to the parent URL's hash so deep
links are shareable: `/#/allocation` loads that view. The mocking is entirely
client-side — no backend, no reverse proxy, no server-side `/api` replay.

**URL space contract** — identical locally and hosted:

| Path | Serves |
| --- | --- |
| `/` | the wrapper (`frontend/preview/index.html`) |
| `/index.html`, `/assets/*`, everything else | the SPA (`frontend/public/*`) at the root, so its absolute asset paths work natively — no rewrite rules |
| `/goldens/api-goldens.json` | the goldens |
| `/preview/index.html` | the wrapper (direct path) |
| miss (incl. direct `/api/*`) | 404 via `404.html`, which bounces back to `/#<path>` |

**Local: `bun run preview`** (`scripts/preview-server.ts`). A minimal in-place
`Bun.serve` static server exposing the URL space above straight from the working
tree — **no copying, no build step**: edit a file under `frontend/public/` and
refresh. Random free port (printed on start; `PORT=<n>` to pin).

**Hosted: Cloudflare Pages Git integration.** There is **no deploy automation in
the repo** — no workflow, no wrangler, no GitHub secrets. The Cloudflare Pages
project is connected to the GitHub repo in the Cloudflare dashboard; on push to a
`preview/*` branch, Cloudflare checks out the branch and runs the
dashboard-configured build command `bash scripts/cloudflare-statics.sh` — a
~10-line transparent shell script (run only by Cloudflare's build, and locally
for verification; nothing in the repo invokes it) that assembles `_site`
(gitignored): `frontend/public/*` at the root, the wrapper at
`/preview/index.html`, goldens at `/goldens/api-goldens.json`, and
`_redirects`/`_headers`/`404.html` at the root. Cloudflare publishes `_site` to
a per-branch URL like `preview-foo.robotmoney-preview.pages.dev`. Dashboard
settings:

| Setting | Value |
| --- | --- |
| Project | `robotmoney-preview` |
| Root directory | *(empty — repo root)* |
| Build command | `bash scripts/cloudflare-statics.sh` |
| Build output directory | `_site` |
| Production branch | `main`, with **automatic production deploys disabled** |
| Preview deployments | custom branches: `preview/*` only |
| GitHub secrets | none required |

**Goldens (`goldens/api-goldens.json`).** One committed JSON keyed by request
pathname → response body, covering every route the frontend calls. It is a *mock*:
**field shapes are real, values are point-in-time.** Goldens are **captured from a
real running system** (a deployed test cluster or a local `bun run demo` stack)
via `bun run goldens:update` — never hand-authored and never derived from other
fixtures, so the shapes stay faithful to what the backend actually returns.

**Enforcement: every-PR CI, author-owned currency.** Keeping the preview current
is the **PR author's responsibility** — there is no nightly regeneration and no
deploy-side check. Two gates run in the normal PR suite:

- **Preview smoke** — `frontend/test/browser/preview-smoke.spec.ts` spawns the
  real `bun run preview` server and asserts the wrapper renders the SPA,
  goldens-backed GET mocking, non-GET no-ops, the 404 behavior, and hash deep
  links. It runs in the regular Playwright suite (`bun run test:browser`),
  executed by the **`e2e` workflow's `e2e` job** (demo readiness gate) on every
  ready PR.
- **Goldens drift gate** — `scripts/tests/unit/goldens-drift.test.ts` blocks a PR
  whose goldens no longer match the code (route set or field shapes). It runs in
  `bun run test:unit` in the **`integration` workflow's
  `backend-integration` job** ("Check root scripts (typecheck + unit tests)"
  step), which also runs
  `scripts/tests/unit/cloudflare-statics.test.ts` (asserts the assemble script lands
  the key files in `_site`).

An agent (or human) whose change alters an API route or shape must recapture in
the same PR — the fix for a red gate is `bun run goldens:update` against a
running backend, committed alongside the change (same discipline as updating
tests or the contract).

**Data fidelity caveat.** Because values are mock/point-in-time, preview is for
**layout, copy, components, and navigation** — not for trusting numbers or charts.
For realistic, evolving data (real analytics + simulations) run the full stack
with `bun run demo` (see the [Demo Specification](#demo-specification)).

---

## 5. Backend

A small server on **Bun** using `Bun.serve` — no framework, no build (Bun runs the
TypeScript sources directly).

- `src/api/index.ts` — the `Bun.serve` entry: a `/health` check and the API routes
  (`comments`, `dashboards`, `committee`, `projects`, `admin`, `analytics`), using
  `postgres` (postgres.js) with raw SQL.
- **Serves the static frontend too.** When `STATIC_DIR` is set, the same process
  serves `frontend/public` via `Bun.file`, with an `index.html` fallback for SPA
  deep links — so the SPA and its API are **same-origin** (no CORS) with no
  reverse proxy. In production this surface is its own subdomain
  (`committee.robotmoney.net`), Cloudflare-proxied for TLS (see the
  topology's [subdomain map](#3-the-surfaces--subdomain-map)); CORS headers remain for an optional split-origin
  setup.
- `src/worker/` — the always-on task-queue worker (see §7).
- `src/db/` — connection pools (`client.ts` for the API/migrations;
  `worker-client.ts` for the worker's queue-scoped access, honoring
  `WORKER_DATABASE_URL` → the restricted `rm_worker` role of migration
  `0016_worker_role.sql`) and the migration runner (`migrate.ts`).
- `src/lib/` — small helpers (e.g. `keys.ts`, sha256 access-key hashing).
- `migrations/` — forward-only numbered `*.sql`, applied once each, tracked in
  `schema_migrations`. Safe to run on every boot.

### Authentication & authorization

Four distinctions, kept deliberately separate:

- **Transport/identity vs authorship.** *Identity* answers "who is calling";
  *authorship* answers "whose data this is." They are independent checks — an
  authenticated caller still must prove a write is genuinely theirs.
- **One identity mechanism.** The **REST API** (browser/dashboards, plus the
  submit/onboarding endpoints — the only transport since D21 retired the MCP
  surface's OAuth 2.1 authorization server) uses the sha256 **access-key** hash
  (`keys.ts`). Public reads need neither.
- **Authorship = member signature.** Recommendations carry a signature the member
  produces **on their own side**; the backend only **verifies** it against the
  member's registered public key. RM never holds member private keys. (This is the
  on-chain seam: later only the signature is anchored.)
- **Credential exchange and membership are separate.** Active members exchange
  their member ID and bearer credential by signing a server-issued key-proof
  challenge (`token-claim/challenge` → `token-claim`, issue #205). Committee
  membership starts with `apply` (metadata + public key), followed by an
  administrator-controlled `applied → active` transition.
- **Scoped roles.** Every write is authorized to a role: members write only their
  own recommendations, the analytics provider only analytics data (the regime
  recompute + the typed `/api/analytics/*` ingestion routes, `ANALYTICS_TOKEN`
  bearer — `ADMIN_TOKEN` and member bearers are never substitutes), the host only
  session lifecycle, the public reads only — enforced in the API layer
  (`src/api/auth.ts` holds the shared constant-time credential checks). The
  worker's own database role is restricted too: migration `0016_worker_role.sql`
  provisions `rm_worker`, which can run the queue lifecycle and the non-analytics
  samplers but is DENIED insert/update/delete on the analytics data tables, so
  the API boundary is backed by database permissions. Migration
  `0007_committee_rls_stub.sql` documents deferred Postgres RLS; it is
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

A Postgres-backed queue replaces the old GitHub Actions cron + `scripts/`. Each
worker process (`backend/src/worker/`, entry `index.ts` → `runtime.ts`) runs
three loops:

- **Claim loop** (`loop.ts`): claims one due job **within its lane's kind
  allowlist** with `FOR UPDATE SKIP LOCKED` (safe across N workers), runs its
  handler by `kind`, and records the outcome in `job_runs`. On failure it retries
  with exponential backoff via `run_after` up to `max_attempts`, then marks the
  job `dead`. While a handler is live its owner **renews the lease**
  (`locked_at`, every `JOB_LEASE_RENEW_MS`, default ⅓ of the visibility timeout)
  so a long job is never reaped and executed concurrently; a lost lease cancels
  the run (ownership-guarded terminal writes discard the zombie's result).
- **Scheduler** (`scheduler.ts`): for each due `job_schedules` row it enqueues a
  job with a `dedupe_key` of `kind + slot` (`ON CONFLICT DO NOTHING` → exactly-once
  per slot) and advances `next_run_at` via a cron parser.
- **Reaper** (`reaper.ts`): requeues jobs stuck in `running` past a visibility
  timeout (crashed/abandoned worker — a live owner renews its lease), bounded by
  `max_attempts`.

**Execution lanes** (issue #107, `worker/lanes.ts`): every worker is pinned to a
lane via the **required** `WORKER_LANE` env (empty/unknown fails loudly at
startup). Lanes are deterministic kind allowlists applied inside the claim:

| Lane | Claims | Purpose |
|------|--------|---------|
| `committee` | `committee.%` only | **Reserved** interactive session-lifecycle capacity — no other lane may claim these kinds. |
| `analytics` | everything except `committee.%`/`research.%` | Regime classification + the scheduled data pipelines. |
| `research` | `research.%` only | Slow external research fetches, quarantined so a blocked fetch can never starve committee/regime work. |
| `generic` | everything except `committee.%` | Single-process dev convenience; never part of the compose topology and never able to consume reserved capacity. |

The production/default topology is one container per lane
(`worker-committee`/`worker-analytics`/`worker-research` in
`docker-compose.yml`); lanes scale independently (`--scale worker-research=2`).
Worker ids default to `<lane>-<pid>`, so `locked_by`, logs, and the admin jobs
dashboard are lane-attributable. Shutdown is **bounded**: on SIGINT/SIGTERM a
worker finishes its in-flight job up to `WORKER_SHUTDOWN_TIMEOUT_MS`, then
releases anything it still owns back to `pending` — a stopped worker never
leaves an orphaned `running` row.

**Idempotency** comes from upserting on natural keys; **exactly-once scheduling**
from the dedupe key; **concurrency safety** from `SKIP LOCKED`. Handlers
(`worker/handlers/`) are registered per `kind`; the distinct `regime.classify`
and `research.refresh` handlers drive the analytics suite (§7.1) on independent
schedules (the combined `analytics.run` kind is retired).

### Admin dashboard (task-queue observability)

A read-only operator surface over the queue tables — `backend/src/api/routes/admin.ts`
serving `/api/admin/*`, and the buildless `/admin` frontend view
(`frontend/public/views/admin.html` + the `adminSurfaceView` factory in
`alpine/views/admin-surface.js`). It SELECTs only; there is no new table:

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

The frontend shell also renders `/admin/research` and `/admin/queue` sections
(stage timeline, bounded artifact previews, filtered queue jobs, controlled
rerun/dead-job retry — issue #157) against the `admin.overview`,
`admin.researchRuns`, `admin.researchRun`, and `admin.jobRetry` routes declared
in `contract/src/routes.js`. Every `/admin/*` path resolves to this one shell
fragment (`frontend/public/assets/js/app/routes.js`); the component reads
`location.pathname` to pick a section. See the
[Admin Surface specification](#admin-surface-research-and-investment-committee) for the
full target contract — the backend routes those sections call are delivered by
issue #155 and exercised here only through Playwright's mocked API fixtures
until that lands.

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
  the CI backend unit tests and available as an explicit local-debug override — never
  a demo default (the demo default is `live`; see §7a of the Demo Specification).
  **`ANALYTICS_SOURCE`**, resolved by
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
  `AnalyticTool` interface (`id, kind, inputs, dependsOn, compute`) + a
  `Registry` that topologically orders `dependsOn` and runs tools — a tool
  may **compose** another's output (e.g. a future "regime tempered by
  channel-divergence") with no special-casing. `research.ts` holds the research
  payload shape; `regime.ts`, `channel-divergence.ts`, `late-cycle.ts` are the
  tools (pure compute only — persistence is owned by the orchestrator's
  `AnalyticsPersistence` port, issue #106; analyze/ never imports a store).
  `backtest.ts` (`computeBacktest`) and `correlations.ts` (`computeCorrelations`)
  add the asof-only regime **backtest** + predictive **correlations** payloads
  (ported from the original `regime-snapshot.json`).
- **`store/`** — the only SQL writes, and **API-owned** (issue #106): only the
  API process (its `/api/analytics` + committee regime routes via
  `store/direct.ts`), tests, and migration/demo tooling may import these
  writers. `regime-store.ts` (`saveRegimeSnapshots`), `research-store.ts`
  (`persistResearchSignal`), and `raw-history-store.ts` (the append-only
  persisted raw floor) all upsert on natural keys and accept an injectable
  handle so the API routes wrap each ingestion batch in one transaction;
  `floor-seed.ts` (`applyRawFloorSeed`) is the server-side gap-fill behind the
  seed-ingestion endpoint (parsing of the vendored seed lives in
  `extract/floor-seed.ts`; the orchestrator triggers it via
  `ANALYTICS_FLOOR_SEED=1`).
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
  endpoints, incl. the live chain feeds of §10). The frontend stays a consumer
  across the HTTP boundary.

**Persistence boundary (issue #106).** The orchestrator
(`analytics/index.ts::runAnalytics`) never writes SQL: every analytics-table
read/write goes through the `AnalyticsPersistence` port
(`analytics/persistence.ts`). Updater processes — the worker's `regime.classify`
and `research.refresh` jobs (issue #107 lanes) — use the HTTP implementation
(`analytics/api-client.ts`), submitting through the authenticated typed routes
`GET/POST /api/analytics/raw-history`, `POST /api/analytics/raw-history/seed`,
`POST /api/analytics/regime-snapshots`, and `POST /api/analytics/research-signals`
(`api/routes/analytics.ts`) with the analytics-provider bearer
(`ANALYTICS_TOKEN`; wiring: `ANALYTICS_API_URL`). Mutations validate the entire
payload before opening a transaction, are idempotent on their natural keys, and
there is NO generic SQL-over-HTTP endpoint. The API process injects the direct
service (`analytics/store/direct.ts`) instead; the worker's boot fails loudly in
demo/prod without its token (`assertAnalyticsUpdaterCredentials`), its DB pool
(`db/worker-client.ts`) is queue-scoped (`rm_worker`,
`0016_worker_role.sql` — analytics-table writes are DENIED at the database), and
`tests/analytics-api-boundary.test.ts` fails CI if updater/orchestrator/worker
modules import `db/client.ts`, `postgres`, a SQL tag, or an analytics store
writer.

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

**EDGAR/MNA seed (issue #108).** `late-cycle-signals`'s `MNA` input is a
monthly count of SEC EDGAR S-4 filings back to 2010-01 — a fresh live database
would otherwise have to crawl ~200 EDGAR requests before its first research
run. The repo commits a canonical, versioned seed instead:
`backend/tests/fixtures/regime/edgar-mna-seed.csv.gz` (a `date,indicator,value`
CSV, gzipped) plus `edgar-mna-seed.manifest.json` (format version, indicator
key, source, declared start/end month, the pinned as-of date the regeneration
ran, exact row count, and a sha256 checksum of the canonical **decompressed**
content — independent of gzip timestamp/metadata bytes). Format, checksum, and
full structural validation (unique ascending month-end dates, contiguous
monthly coverage, finite non-negative integer counts, single indicator, no
rows past the pinned as-of) live in
`analytics/extract/edgar-seed.ts` — pure, no I/O.

- **Bootstrap** (`analytics/edgar-seed-loader.ts::bootstrapEdgarSeed` →
  `backend/scripts/edgar-seed-bootstrap.ts`) loads + validates the committed
  artifact and submits it through the SAME authenticated seed-ingestion
  endpoint the vendored floor seed uses (`POST
  /api/analytics/raw-history/seed` → `store/floor-seed.ts`'s server-side
  gap-fill: existing real rows always win, a second run is a no-op). On
  success it calls `POST /api/analytics/research-eligibility`, which flips
  `job_schedules.research.refresh` to `enabled` — seeded **disabled** by
  `db/seed.ts` specifically so a fresh database's research schedule cannot
  become claimable before the floor is seeded. `scripts/lib/demo-main.ts` runs
  this CLI once, right after API health and before anything else (CI checks or
  the local action loops) that could observe a fired `research.refresh` job.
- **Repopulation** (`edgar-seed-loader.ts::repopulateEdgarSeed` →
  `backend/scripts/edgar-seed-repopulate.ts`) is an operator command for a
  database that lost some MNA rows: it diffs the committed artifact against
  whatever is persisted and reports `seeded` (restored), `existing` (already
  present, same value), and `rejected` (already present with a *different*,
  real value — correctly left standing) counts.
- **Regeneration** (`extract/edgar-seed-generator.ts` →
  `backend/scripts/edgar-seed-regenerate.ts`) is the ONLY way the committed
  pair is ever produced or replaced — never implicit in migrations, demo boot,
  or required per-PR CI. An operator runs `bun run edgar-seed:regenerate --end
  <last day of a complete month> --asof <today>` (optionally `--start`,
  default the declared 2010-01-01 baseline); it fetches live EDGAR bounded
  (one request/month via `extract/edgar.ts`'s retry/backoff), REFUSES to write
  anything if even one month is unrecoverable (never a partial seed), and
  atomically replaces both files (temp-write → round-trip through the exact
  parse/validate path → rename) so a failed regeneration never corrupts the
  committed pair. **Credentials:** none — EDGAR's full-text-search API is
  keyless; only a descriptive User-Agent is sent. **Review expectations:** a
  PR that regenerates the seed must be reviewed like a data change, not a code
  change — check the manifest's `rowCount`/`startMonth`/`endMonth`/`asOf` are
  what's expected and that the diff is additive (new trailing months), never a
  silent revision of historical counts.

The worker runs regime and research as **distinct jobs** (issue #107):
`regime.classify` daily at **22:30 UTC** (after US market close, so the fetched
raw is settled end-of-day data) in the analytics lane, and `research.refresh`
(both research signals, never the regime tool) daily at **23:00 UTC** in the
research lane; the API exposes regime at `/api/dashboards/regime-snapshots?range=`
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
the [network topology section](#network-topology--dns-origins--vendors) (decision D13); the GitOps pipeline and the Cloudflare
/ DO credentials CI needs are in [deployment.md](./runbooks/deployment.md). This section
covers what *this repo* ships.

**CI & demo — single box**, `docker-compose.yml`:

- `postgres` + `api` + the three worker lanes (`worker-committee` /
  `worker-analytics` / `worker-research`, §7). The `api` process **also serves
  the static frontend** (`STATIC_DIR=/srv/frontend`) — one origin, no app-level proxy.
- **DB modes** are driven by `DATABASE_URL` + the postgres volume:
  - *ephemeral* (CI): throwaway, `docker compose down -v`.
  - *demo*: named `pgdata` volume persists across restarts.

**Production — tiered on DigitalOcean, Cloudflare for DNS+observability** (D13;
credentials in [deployment.md](./runbooks/deployment.md)):

- **API tier** — `api` + the worker lanes on a DO droplet at its own subdomain
  (`committee.robotmoney.net`); the `api` co-serves this surface's SPA assets at the
  subdomain root. Cloudflare-proxied; a DO Cloud Firewall limits ingress to
  Cloudflare IPs.
- **Data tier** — `DATABASE_URL` points at a **DO Managed Postgres HA cluster**
  (no `postgres` container).
- **Static tier** — marketing is served separately from a **DO Spaces CDN** on the
  apex/`www`, not by this `api`.
- **Config**: the only required env var is `DATABASE_URL`. The frontend's only
  input is `API_BASE_URL` in `config.js` (`""` = same origin on its subdomain).
  Secrets (e.g. `BASE_RPC_URL`) live in the droplet env, not in the frontend;
  Anthropic/FRED API keys are reserved — not currently consumed by any code.
- **TLS** is provided by Cloudflare's proxy (the droplet serves a Cloudflare Origin
  CA cert).

**Preview mode — no-backend static hosting for development.** Independent of both
hosted shapes, preview is pure static files (D19): pushes to `preview/**`
branches deploy a per-branch URL on Cloudflare Pages, and `bun run preview`
serves the same composed deploy directory locally on a random free port. In both
cases the client-side wrapper (`preview/preview.html`) runs the live SPA in an
iframe and answers every `/api/*` call from committed goldens
(`goldens/api-goldens.json`) — no backend, no server-side mocking. Mechanism in
§4 "Preview mode (goldens-backed, no backend)"; workflow + fidelity caveats in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## 9. Investment Committee (feature architecture)

> Status: design reference for the IC feature (built in Phase 5). It reuses the
> shared infrastructure above — the boundary (§3), the buildless frontend (§4), the
> Bun server (§5), Postgres (§6), and the task queue (§7) — and adds a
> signed-submission protocol over the REST API.

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
`scheduled → collecting → window_closed → aggregated → published` (plus the
terminal `cancelled`; §9.4). Each member posts at most one signed **recommendation** (a "take") per
session; a non-submitting member is recorded **absent**, never fabricated. The
plurals (members / subjects / sessions / takes) are the moving parts — they are
**not** multiple committees.

### 9.1 Where the IC lives

It spans the layers but only through the contract (§3).

| Layer | IC responsibility |
|---|---|
| `contract/` | `ROUTES.committee` + `committee.d.ts` DTOs — the only thing crossing boundaries. |
| `backend/` | API routes (`src/api/routes/committee.ts`), committee Postgres tables, and the worker handlers that own the session lifecycle (§9.4). Owns the DB. |
| `frontend/` | Read-only committee views (members/subjects/sessions/apply) reaching the API via `app/lib/api.js`. |

All three depend only on `contract`; `frontend/` reaches `backend/` solely over
HTTP. A member's agent participates the same way — plain HTTP calls to the REST
API, following the `committee-onboarding` skill (§11 R4/R5) rather than
connecting to any RM-hosted service; nothing RM-hosted to install (D21 retired
the earlier MCP-server surface).

### 9.2 Actors & trust model

| Actor | Identity | Scoped writes | Reads |
|---|---|---|---|
| **Committee member** | access-key hash for identity; **signing key** for authorship | their **own signed recommendations** (scoped to `member_id`) | briefs, regime, published sessions |
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
- **Transport/identity** (*who is calling*): the access-key hash
  (`backend/src/lib/keys.ts`, sha256, never plaintext).
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
scheduled → collecting → window_closed → aggregated → published   (+ cancelled)
```

(Brief publication is the `scheduled → collecting` transition, not a persisted
state; `cancelled` is the terminal escape hatch.)

- `committee.open_session` (cron) — pick the rotation subject, create the session.
- `committee.publish_brief` — assemble the brief (regime + subject snapshot + recent
  sessions); open the submission window.
- *window:* members submit via the REST `submit` endpoint, calling the same
  **domain handler**, not the worker.
- `committee.close_window` (cron at deadline) — stop accepting submissions. For a
  session with a frozen expected roster (§9.4.1), this also materializes one durable
  `absent` agent-health event per non-excused member who never submitted.
- `committee.aggregate` — deterministic rollup + optional editorial synthesis **over
  the takes actually posted**; absences recorded as absent. **No host-authored takes.**
- `committee.publish` — mark the session visible via API + frontend.

The five `committee.*` cron rows are **environment-configurable** (issue #208):
`COMMITTEE_SCHEDULES_ENABLED` (default `false`) is the single switch for the whole
sequence, plus a `COMMITTEE_*_CRON` variable per kind and `COMMITTEE_WINDOW_MINUTES`
for the submission-window length. Production explicitly enables the daily
06:00–10:00 UTC sequence; staging may accelerate the cadence; repo demo/e2e stays
disabled (the demo drives lifecycle jobs itself via the admin enqueue-job endpoint,
unaffected). Re-running the migrate/seed step applies a changed value to the
existing `job_schedules` rows, not just a fresh database.

#### 9.4.1 Agent health

A roster member missing its expected submission window, and a rejected/tampered
submission signature, were previously visible only in an agent's own stdout.
Both are now recorded on a durable, append-only `committee_agent_health_events`
table (bounded, redacted `detail` — never a raw signature/public key/payload) and
exposed admin-only via `GET /api/committee/admin/agent-health` (raw event history
+ per-type counts). There is no automatic dead-agent threshold — an operator reads
the history and decides.

### 9.5 Surfaces — one core, one transport

The backend is a **domain/service layer** (plain Bun/TS functions over Postgres:
`getRegime()`, `getBrief()`, `getSession()`, `verifyAndStoreSubmission()`,
`aggregateSession()`, …) where window enforcement, signature verification, and
authz live **once**. **REST/JSON** (`Bun.serve`, paths in `ROUTES.committee`) is
the only transport — the website's transport and every member's transport (D21
retired the MCP transport that previously shared this layer). Reads public
(`members`, `subjects/:id`, `sessions`, `brief`); writes scoped (`apply` +
`apply/unlock`, `submit`, and a role-gated analytics `regime` write).

#### 9.5.1 Member surface — skill-taught, REST-only

A member's agent has nothing RM-hosted to connect to: it calls the REST API
directly. The **`committee-onboarding` skill** — installed into the agent's own
harness from `robotmoney-core` (robotmoney-core#1170/#1171; §11 R4/R5) — is the
procedure a member's owner follows, and is itself the discovery mechanism (its
content is maintained centrally, so it stays current without any live
server-side lookup). It teaches installing and configuring the `rmpc` client
(keygen, canonical-payload signing) and then walks the agent through the REST
calls (`ROUTES.committee.apply`, `signingPayload`, `submit`, `memos`).
**Signing stays member-side**: `rmpc` signs the canonical payload in the
member's own environment and the request carries the `signature`, which the
server only **verifies**. `ROUTES.committee.signingPayload` returns the exact
canonical bytes to sign.

Endpoints exercised: **read** (`openSession`, `sessions`, `session`, `brief`,
`memberTakes`, `subjectSnapshots`); **write** (`signingPayload`, `submit` with
the member signature, `memos`). Participation is tool-agnostic and RM imposes
no model/framework/data source — the skill is documentation plus the `rmpc`
binary, not a service RM operates.

> Decision flag: member-side signing preserves the on-chain seam (§9.3) with a
> plain REST endpoint, at the cost of a member signing step. A simpler v0 could
> rely on the access-key hash alone and defer per-payload signatures, but that
> weakens the "signature anchors on-chain later" property. Default: keep member
> signing.

### 9.6 RM analytics provider (the data utility)

The regime classifier runs on the provider's own infrastructure and **submits
regime snapshots through the authenticated `/api/analytics` boundary under a
scoped credential** (`ANALYTICS_TOKEN`; issue #106 — never direct SQL), the same
pattern as a member posting a take, different scope. Members consume it **optionally** via the regime read
(`ROUTES.dashboards.regimeSnapshots`) and may record which RM tools vs. their own
data they used. Producer (privileged write) and consumers (read) are cleanly
separated; this actor can later be a third party with no change.

### 9.7 Testing & demo

**No mocks of the submit path; no host-authored takes.** E2E runs the real
single-box stack (Postgres + API + worker + the analytics-provider client + N
member agents, each identified by its own access-key hash and signing with its
own key) and asserts: regime write lands and reads back; member signatures
verify; a no-show renders **absent**, not fabricated; out-of-window POSTs
are rejected; cross-role writes are denied; a published session renders the *real*
takes. The demo is the same harness at scale. Hermetic: a missing dependency fails
the run rather than silently skipping. Real-LLM member takes are a separate
opt-in: `COMMITTEE_REAL_INFERENCE=1` swaps the templated take for a keyless
opencode-zen call that is **time-bounded**
(`OPENCODE_TIMEOUT_MS`, default 120s — a hung inference kills the subprocess
instead of freezing the session), and member runs are settled rather than
`Promise.all`'d, so a per-member inference/session failure renders that member
**absent** instead of failing the whole session (#122; the e2e harness — formerly
`mcp/src/e2e.ts` — is relocated out of the retired `mcp/` package as part of
D21's follow-up code retirement).

**Known coverage gap (stated, not papered over).** No CI job currently exercises
the real-model committee-take authoring path: every committee take in CI —
including in the demo boot — takes the deterministic `stanceFor()`/`buildMemo()`
template path. D21 retired the job that previously covered a version of this (it
drove the now-deleted MCP tools), and re-establishing the coverage — a job that
sets `COMMITTEE_REAL_INFERENCE=1` and loud-fails on the deterministic fallback —
is tracked follow-up work. What *is* covered nightly is real-inference
**onboarding** (§11.3), a different surface; the two must not be conflated when
reading the CI signal.

### 9.8 Phase-5 build order & reconciliation

Build order: (1) committee migration (§9.4 tables + key registry); (2) finalize the
`CommitteeSubmission`/`CommitteeTake` DTOs; (3) API `committee.ts` (reads, `apply`,
`submit` with access-key + signature verification + window enforcement);
(4) orchestration handlers + `job_schedules` rows; (5) role-gated analytics regime
write; (6) E2E harness (REST-only, D21); (7) frontend pages; (8) stubbed
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
provenance fields, degrade rules) those feeds were built against is the
[live-data contract section](#live-data-contract--4-new-dashboard-endpoints).

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
  both resolved **at call time** by `vault-economics.ts` (not module load) so
  tests that flip `BASE_RPC_SOURCE=stub` directly (issue #147 removed the
  hermetic demo/CI stub that used to set this automatically — the demo/CI path
  now always resolves `'live'`) and env-overridden adapters are always
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

---

## Live-data contract — 4 new dashboard endpoints

Foundation contract for removing the last baked-in data from `/allocation`
(buyback table, token metrics, per-wallet sleeves, strategy/bucket target
weights). The parallel implementation workers build against **this** document so
the DTOs, provenance fields, modules, tables, and preview goldens are consistent
with the existing live dashboards (`vault-economics`, `wallet-balances`).

Everything here follows the **issue #50 honesty contract** already enforced by
`chain/vault-economics.ts` + `chain/wallet-balances.ts`:

- Every DTO carries provenance: `source` (`"live" | "stub"`) and either
  `stale: boolean` or a per-row `provenance` (`"live" | "stub" | "stale" |
  "seed"`), mirroring the existing dashboards.
- A value is **never fabricated**. A failed live read degrades to the
  last-persisted (`stale`) or seeded (`seed`) value with an explicit label, or
  to `null` — never a live-looking `$0`.
- Unconfigured / placeholder addresses (`config.isPlaceholderAddress`) are
  **never** `eth_call`ed.
- Resolvers (`resolveBaseRpcSource`, `resolvePriceSource`, …) are read **per
  request**, not at module load, so tests can flip env per case and provenance
  always tracks the current source.

Shared conventions (identical to `wallet-balances`):
- `asOf`: ISO-8601 timestamp of the read (`new Date(now).toISOString()`).
- `source`: `resolveBaseRpcSource()` result — always `"live"` in prod/demo
  (issue #147 removed the hermetic CI/demo layer); `"stub"` is still a valid
  value backend unit tests set directly via `BASE_RPC_SOURCE=stub`.
- Short-TTL in-process cache (`CACHE_TTL_MS = 30_000`) + a
  `_reset<Name>CacheForTests()` export, matching the existing modules.
- Handlers are thin adapters in `backend/src/api/routes/dashboards.ts` that just
  call the chain/db module (no query or DTO logic in the handler).

## Config the implementers consume (already shipped by this worker in `config.ts`)

| Getter | Returns | Real default (Base) |
|---|---|---|
| `resolveRobotmoneyToken(env)` | `string` | `0x65021a79aeef22b17cdc1b768f5e79a8618beba3` |
| `resolveWeth(env)` | `{ address, poolId }` | `0x4200…0006` |
| `resolvePropWallets(env)` | `string[]` (primary first) | `0xfbc2…c9d6`, `0x422c…8eee`, `0x8d0c…9442` |
| `resolveBuybackConfig(env)` | `{ primaryWallet, robotmoneyToken, wethToken, source }` | primary = `0xfbc2…c9d6` |
| `resolveTrackedAssets(env)` | `TrackedAsset[]` | ZYFAI-SS1 `0xc125…976d`, GIZA-SS1 `0x8e5c…8795` |
| `resolveVaultAdapters(env)` | `VaultAdapterConfig[]` (`configured:true` for real addr) | Morpho `0xa6ed…17e9`, Aave `0x2186…0bea`, Compound `0x8247…2652` |
| `isPlaceholderAddress(a)` | `boolean` | true for `0x1111…`/`0x7777…` etc. |
| `config.robotmoney`, `config.weth`, `config.propWallets`, `config.buyback` | load-time snapshots | — |

RPC client (shipped this worker): `chain/base-rpc-client.ts` now exports
`ethGetLogs(params, opts): Promise<EthLog[]>` (JSON-RPC `eth_getLogs`) with the
same throw-on-failure discipline as `ethCall` / `ethGetBalance`, plus the
existing `callBalanceOf` / `callTotalSupply` / `callConvertToAssets`.

---

## 1. Token buybacks — `GET /api/dashboards/buybacks`

- **Method**: GET (no query params).
- **Module/function**: `backend/src/chain/buyback-logs.ts` → `getBuybacks()`.
- **Source of truth**: robotmoney-site `wallet.ts::fetchBuybackTransactions` —
  Basescan/`eth_getLogs` of ROBOTMONEY `Transfer` events **into** the primary
  prop wallet (`config.buyback.primaryWallet`). WETH-spent / USD legs join the
  swap input. `config.buyback.source` drives live-vs-stub.
- **Postgres**: NEW table `buyback_swaps` (see migration note below) — the
  durable store. Live path reads `eth_getLogs`; on RPC failure degrade to the
  persisted rows marked `stale`; the historical 10-row set (all 2026-03-23,
  total `1.149114 WETH` / `$2,504.31` / `178.82M ROBOTMONEY`, real BaseScan tx
  hashes) is the `seed` provenance backfill (replaces `allocation.html:383-403`).

**DTO**
```ts
interface BuybackRow {
  date: string;              // ISO calendar day, e.g. "2026-03-23"
  txHash: string;            // 0x… Base tx hash (links to basescan.org/tx/…)
  wethSpent: number;         // WETH amount, 18dp normalized (e.g. 0.116534)
  valueUsd: number;          // USD value of the WETH spent (e.g. 253.97)
  robotmoneyReceived: number;// ROBOTMONEY tokens received (raw count, e.g. 18450000)
  provenance: "live" | "stub" | "stale" | "seed";
}
interface Buybacks {
  asOf: string;              // ISO timestamp
  source: "live" | "stub";
  stale: boolean;            // true if ANY row degraded to persisted/seed
  rows: BuybackRow[];        // newest-first
  totals: {
    wethSpent: number;       // 1.149114
    valueUsd: number;        // 2504.31
    robotmoneyReceived: number; // 178820000
  };
}
```

**Preview golden** (`goldens/api-goldens.json` → `routes["/api/dashboards/buybacks"]`):
```json
{
  "asOf": "2026-07-09T12:04:40.696Z",
  "source": "stub",
  "stale": false,
  "rows": [
    { "date": "2026-03-23", "txHash": "0xa19a086682db8ff57a94e8f594bb542c8e4ba1d8f79bf7ad48717be0587ffa37", "wethSpent": 0.116534, "valueUsd": 253.97, "robotmoneyReceived": 18450000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x9ce840624ce3742bca40f6b672587dfa1ad85ac40476ecb7cb71938a170319bc", "wethSpent": 0.11591,  "valueUsd": 252.61, "robotmoneyReceived": 17810000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x8dc090ca0ec59882d541dffd52adbe64adbdba4166dd63a230722d2ea0b29266", "wethSpent": 0.11591,  "valueUsd": 252.61, "robotmoneyReceived": 17770000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x1e09868aa284f8a969f7a85a11758e896b786f5f78daf8b503274b2828209361", "wethSpent": 0.114375, "valueUsd": 249.26, "robotmoneyReceived": 18170000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x79594aaa2a4b39bdcbc19ba9f39834963d0f00599b4437e17a517503f996450f", "wethSpent": 0.114375, "valueUsd": 249.26, "robotmoneyReceived": 18140000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x9364ec11ec2543438b2c1efaee79aad6ecc2ef42606ca9efa9f8378ac4837eac", "wethSpent": 0.115006, "valueUsd": 250.64, "robotmoneyReceived": 18200000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0xd63e11167880ef5ca9d7dfeb2e361b355e93aa01317ccb9ab5bdf5918168eb74", "wethSpent": 0.114251, "valueUsd": 248.99, "robotmoneyReceived": 18040000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0xe6d8138395fb5815157cf1197570dd26c10f4fd3c3792e08fa9f38956811ec33", "wethSpent": 0.114251, "valueUsd": 248.99, "robotmoneyReceived": 17460000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x81cf52a3f723c48a65c67999b5b4417a67b67687125aec29ba255246a6eba39f", "wethSpent": 0.114251, "valueUsd": 248.99, "robotmoneyReceived": 17430000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x3c9718e37624c0de8b5e295b3e8a9cf5dc98dcd0d08cbad395551c2ce6f8eab9", "wethSpent": 0.114251, "valueUsd": 248.99, "robotmoneyReceived": 17370000, "provenance": "seed" }
  ],
  "totals": { "wethSpent": 1.149114, "valueUsd": 2504.31, "robotmoneyReceived": 178820000 }
}
```

---

## 2. Token metrics — `GET /api/dashboards/token-metrics`

- **Method**: GET (no query params).
- **Module/function**: `backend/src/chain/token-metrics.ts` → `getTokenMetrics()`.
- **Source of truth**: `config.robotmoney` — `totalSupply` via
  `callTotalSupply` (18dp), `priceUsd` via `fetchAssetPriceUsd` (GeckoTerminal,
  `resolvePriceSource()`), `marketCapUsd = totalSupply * priceUsd`. `feeSplit`
  is a fixed Clanker-pool config constant (Protocol 57 / Bankr 40 / Clanker 3);
  it is `managed`/static, not a chain read — label its `source` accordingly but
  keep it in the DTO so the frontend stops baking it.
- **Postgres**: none required for the live read; may reuse
  `vault_share_price_history`-style persistence if a `stale` fallback is added
  (optional — otherwise degrade price/supply legs to `null`).
- **Degrade**: a failed supply or price leg → that field `null` +
  `stale: true`; never a fabricated price.

**DTO**
```ts
interface TokenMetrics {
  robotmoney: {
    priceUsd: number | null;     // e.g. 0.00000451
    totalSupply: number | null;  // token count, 18dp normalized (e.g. 5.5e10)
    marketCapUsd: number | null; // priceUsd * totalSupply
  };
  feeSplit: { label: string; pct: number }[]; // fixed Clanker pool config
  asOf: string;
  source: "live" | "stub";
  stale: boolean;
}
```

**Preview golden** (`routes["/api/dashboards/token-metrics"]`):
```json
{
  "robotmoney": { "priceUsd": 0.00000451, "totalSupply": 55000000000, "marketCapUsd": 248050 },
  "feeSplit": [
    { "label": "Protocol", "pct": 57 },
    { "label": "Bankr", "pct": 40 },
    { "label": "Clanker", "pct": 3 }
  ],
  "asOf": "2026-07-09T12:04:40.696Z",
  "source": "stub",
  "stale": false
}
```

---

## 3. Wallet sleeves — `GET /api/dashboards/wallet-sleeves`

- **Method**: GET (no query params).
- **Module/function**: `backend/src/chain/wallet-sleeves.ts` → `getWalletSleeves()`.
- **Source of truth**: per-prop-wallet on-chain reads (`config.propWallets`).
  This is the **per-wallet breakdown** the aggregate `wallet-balances` endpoint
  does NOT provide: `wallet_balance_samples` has **no wallet dimension**
  (`UNIQUE (sample_date, symbol)` only), so wallet-sleeves MUST do fresh
  per-wallet `callBalanceOf` / `ethGetBalance` reads — it cannot be derived from
  that table. Names/types come from the prop-wallet metadata:
  - `0xfbc2…c9d6` — "Bankr" / primary
  - `0x422c…8eee` — "Stablecoin Strategy 1" (delegated ZyfAI, ZYFAI-SS1)
  - `0x8d0c…9442` — "Stablecoin Strategy 2" (delegated Giza, GIZA-SS1)
- **Reuse**: value each holding with the same `resolveTrackedAssets` valuation
  kinds + `fetchAssetPriceUsd` as `wallet-balances.ts::valueAsset`, but keyed
  per wallet (do **not** `sumOverWallets`). Per-holding provenance mirrors #50.
- **Postgres**: none authoritative (no per-wallet table). Optional per-wallet
  degrade store is out of scope; a failed leg → holding value `null` +
  provenance `"stale"`.

**DTO**
```ts
interface SleeveHolding {
  symbol: string;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  provenance: "live" | "stub" | "stale" | "seed";
}
interface WalletSleeve {
  name: string;      // "Bankr" | "Stablecoin Strategy 1" | …
  address: string;   // 0x… (lowercased)
  type: string;      // "primary" | "strategy"
  totalUsd: number;  // sum of holdings[].valueUsd (nulls as 0)
  holdings: SleeveHolding[];
}
interface WalletSleeves {
  wallets: WalletSleeve[];
  asOf: string;
  source: "live" | "stub";
}
```

**Preview golden** (`routes["/api/dashboards/wallet-sleeves"]`):
```json
{
  "wallets": [
    { "name": "Bankr", "address": "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6", "type": "primary", "totalUsd": 38331,
      "holdings": [
        { "symbol": "USDC", "amount": 9037.405, "priceUsd": 0.9983, "valueUsd": 9022, "provenance": "stub" },
        { "symbol": "ROBOTMONEY", "amount": 6499610000, "priceUsd": 0.00000451, "valueUsd": 29300, "provenance": "stub" },
        { "symbol": "BNKR", "amount": 25081.3083, "priceUsd": 0.000377, "valueUsd": 9, "provenance": "stub" }
      ] },
    { "name": "Stablecoin Strategy 1", "address": "0x422c906083ca40b7e055b811d517f03bbbef8eee", "type": "strategy", "totalUsd": 9022,
      "holdings": [
        { "symbol": "ZYFAI-SS1", "amount": 9037.405, "priceUsd": 0.9983, "valueUsd": 9022, "provenance": "stub" }
      ] },
    { "name": "Stablecoin Strategy 2", "address": "0x8d0c331e45beca4184b758f3049f8897aabb9442", "type": "strategy", "totalUsd": 8965,
      "holdings": [
        { "symbol": "GIZA-SS1", "amount": 8980.0, "priceUsd": 0.9983, "valueUsd": 8965, "provenance": "stub" }
      ] }
  ],
  "asOf": "2026-07-09T12:04:40.696Z",
  "source": "stub"
}
```

---

## 4. Allocation framework — `GET /api/dashboards/allocation`

- **Method**: GET (no query params).
- **Module/function**: `backend/src/chain/allocation-framework.ts` (or a `db/` reader) →
  `getAllocationFramework()`. This is **admin/committee-managed** data (no chain
  read, no AI enrichment — see the "projects overviews admin-managed" policy):
  it reads the single-row `allocation_framework` table.
- **Source of truth**: `robotmoney-site/data/committee/allocation.json`
  (`buckets[].target_weight` + `items[].target_weight`, `vault_contract
  0x4f83…49dd`) seeded into `allocation_framework`. Replaces the baked bucket
  percentages in `allocation.html` (95% Conservative DeFi Yield / 5% Agent
  Tokens / 0% Protocol / 0% RWA and the per-item legend weights).
- **Postgres**: EXISTING table `allocation_framework`
  (`id=1, asof date, vault_contract text, buckets jsonb`) — currently unused,
  now the authoritative store. `strategy[]` (top-level pie) and `buckets[]`
  (2×2 cards) both project out of the `buckets` jsonb.
- **Provenance**: `managed: true` (admin-authored, not a live read); `source`
  reflects whether the row is present (`"live"` = DB row) vs a seed default.
  There is no `stale` chain concept here — the data is intentionally static
  until an admin rewrites it.

**DTO**
```ts
interface AllocationStrategy { label: string; targetPct: number }
interface AllocationItem     { label: string; targetPct: number }
interface AllocationBucket   { key: string; label: string; items: AllocationItem[] }
interface AllocationFramework {
  strategy: AllocationStrategy[]; // top-level pie (bucket target weights)
  buckets: AllocationBucket[];    // 2x2 detail cards
  asOf: string;                   // allocation_framework.asof (ISO day) or read time
  source: "live" | "stub";
  managed: true;                  // admin/committee-authored, never chain-derived
}
```

**Preview golden** (`routes["/api/dashboards/allocation"]`):
```json
{
  "strategy": [
    { "label": "Conservative DeFi Yield", "targetPct": 95 },
    { "label": "Agent Tokens", "targetPct": 5 },
    { "label": "Protocol Tokens", "targetPct": 0 },
    { "label": "Real World Assets", "targetPct": 0 }
  ],
  "buckets": [
    { "key": "defi-yield", "label": "Conservative DeFi Yield", "items": [
      { "label": "Aave", "targetPct": 40 },
      { "label": "Morpho", "targetPct": 35 },
      { "label": "Compound", "targetPct": 25 }
    ] },
    { "key": "agent-tokens", "label": "Agent Tokens", "items": [
      { "label": "Juno", "targetPct": 100 }
    ] },
    { "key": "protocol-tokens", "label": "Protocol Tokens", "items": [] },
    { "key": "rwa", "label": "Real World Assets", "items": [] }
  ],
  "asOf": "2026-07-09",
  "source": "stub",
  "managed": true
}
```
> The bucket-item weights above are the shape/example only. The implementer
> seeds the exact `target_weight` values from
> `robotmoney-site/data/committee/allocation.json`; do not invent weights the
> committee data does not carry.

---

## Migration + goldens checklist for implementers

- **New migration** `backend/migrations/0015_buyback_swaps.sql`:
  `buyback_swaps(id bigserial pk, block_number bigint, tx_hash text UNIQUE,
  log_index int, occurred_on date, weth_spent numeric, value_usd numeric,
  robotmoney_received numeric, provenance text NOT NULL DEFAULT 'live',
  ingested_at timestamptz DEFAULT now())`. Natural key `tx_hash` (or
  `(tx_hash, log_index)`) so a re-run never duplicates a swap — same
  upsert-on-natural-key convention as `0012`/`0014`. Seed the 10 historical rows
  `ON CONFLICT DO NOTHING` with `provenance='seed'`.
- **Seed** `allocation_framework` (id=1) from
  `robotmoney-site/data/committee/allocation.json` in `backend/src/db/seed.ts`.
- **Goldens**: every new route MUST have a `routes[...]` entry in
  `goldens/api-goldens.json` (preview 404s otherwise). Use the examples above as
  the shape; regenerate real values with `bun run goldens:update` against a
  running backend.
- **Frontend**: register the 4 new `ROUTES.dashboards.*` (already added:
  `buybacks`, `tokenMetrics`, `walletSleeves`, `allocation`) into the allocation
  view + Alpine so the baked tables in `frontend/public/views/allocation.html`
  are replaced by fetches.

---

## Demo Specification

What `bun run demo` must demonstrate to exercise the full Investment Committee lifecycle —
a single command that provisions everything, runs the session lifecycle end-to-end, and
keeps the stack live as a **standing demo** (see §0). Ctrl-C / SIGTERM tears the stack
down **but keeps the postgres data** (see §0(c)); a startup failure leaves it up for
inspection; `bun run demo:down` tears down an already-running (e.g. backgrounded) demo,
also keeping its data. `bun run demo -- --pg-data <host-dir>` bind-mounts postgres to a
host directory so a reboot resumes from it; `bun run demo:clean` is the only command that
deletes demo data volumes.

> **One committee, not many.** Everything below exercises the *single* Investment
> Committee. The harness drives it through **two sessions** (session 1 = today's
> subject; session 2 = a different subject the next day, referencing session 1's
> outcome), with N **members** submitting signed takes and one deliberate no-show
> (recorded absent). These plurals — members / subjects / sessions / takes — are the
> moving parts of the one committee, **not** separate committees.

> **D21 migration note.** MCP is retired (see [decisions.md
> D21](./decisions.md)); the normative sections below (§1, §§3–6, §11) already
> describe the target REST-only demo. The runtime/TUI mechanics elsewhere in
> this spec (docker-compose bring-up in §0, tuning notes in §7a, TUI panels in
> §10) still name the `mcp` compose service, its `/health` check, and
> `mcp/src/e2e.ts::runSession` as currently shipped — that code moves to a
> REST-only equivalent as D21's follow-up implementation work, not as part of
> this docs change.

```mermaid
flowchart TB
    subgraph Scheduler["⏱ Worker Scheduler"]
        SC["tickScheduler() every 30s<br/>reads job_schedules<br/>FOR UPDATE SKIP LOCKED"]
        SC -->|even minute| R["regime.classify<br/>→ regime snapshot<br/>(analytics lane)"]
        SC -->|odd minute| A["research.refresh<br/>→ research signals<br/>(research lane)"]
        R -->|"poll DB (TUI)"| TP
        A -->|"poll DB (TUI)"| TP
    end

    subgraph Core["👥 Core Members (seated at start)"]
        M1["Athena<br/>lens: macro risk"]
        M2["Boreas<br/>lens: on-chain flows"]
        M3["Cygnus<br/>lens: momentum"]
        M4["Draco — ABSENT"]
    end

    subgraph Prospects["🧑‍🚀 Prospective Members (join progressively)"]
        N1["Helios → ~1min"]
        N2["Selene → ~6min"]
        N3["Rhea → ~11min"]
        NX["… every 5min"]
    end

    subgraph Session["📋 Committee Session (per subject, ~2min cadence)"]
        direction LR
        S1["scheduled"] --> S2["collecting"] --> S3["window_closed"] --> S4["aggregated"] --> S5["published"]
    end

    subgraph Onboarding["📝 Onboarding Gates"]
        direction LR
        O1["connect"] --> O2["discover"] --> O3["toolchain"] --> O4["apply"] --> O5["approve"] --> O6["claim"]
    end

    subgraph TUI["🖥 TUI Panels"]
        TP["Research Queue"]
        TP2["Committee Status"]
        TP3["Onboarding Strip"]
    end

    Core -->|"sign → submit"| S3
    Prospects -->|walk through| Onboarding
    O6 -->|"admitted → joins roster"| S3
    Scheduler -.->|visible in| TP
    Session -.->|visible in| TP2
    Onboarding -.->|visible in| TP3

    style Scheduler fill:#1e3a5f33,stroke:#1e3a5f,stroke-width:2px
    style Core fill:#3b076433,stroke:#7c3aed,stroke-width:2px
    style Prospects fill:#3b076433,stroke:#a855f7,stroke-width:2px,stroke-dasharray:5 5
    style Session fill:#1e1b4b33,stroke:#4338ca,stroke-width:2px
    style Onboarding fill:#064e3b33,stroke:#059669,stroke-width:2px
    style TUI fill:#78350f33,stroke:#d97706,stroke-width:2px
```

---

## 0. Standing demo mode (`bun run demo`, local)

Locally, `bun run demo` is a **long-lived standing demo**, not a one-shot. It runs in
three phases and stays up until you stop it (Ctrl-C / SIGTERM):

**(a) Bring-up.** Build images → start Postgres → migrate (seeds `job_schedules`) →
start api + worker + mcp → wait for `/health` on api and mcp. Once healthy it writes a
run state file at `.agents/demo-state.json` (compose project name + this run's random
ports + compose env + the postgres data location, so teardown/status can find the run)
and prints the READY route table.

**Postgres data location.** By default each run uses a fresh anonymous named volume
`<project>_pgdata`, labeled `robotmoney.demo=1` (so `demo:clean` can find it). Passing
`bun run demo -- --pg-data <host-dir>` instead bind-mounts postgres's data directory to
`<host-dir>` (created if absent), so the SAME value on a later boot resumes the SAME
data — this is a CLI **argument**, never an env var, and is recorded in the state file.
Reuse constraints: the same postgres major (17) and the same baked-in demo credentials;
migrate + seed are idempotent (`backend/src/db/seed.ts` uses `ON CONFLICT DO NOTHING`),
so re-booting on old data converges rather than duplicating rows. (Bind mounts were
verified working on the Linux CI host — postgres:17-alpine chowns the bind dir to its own
container user and inits/resumes cleanly — so the named-volume fallback was not needed.)

**(b) Staggered scheduled actions (~2 min cadence).** The demo continuously produces
fresh activity, driven two ways (hybrid):

- **Regime + research** — driven by the worker's own scheduler. In demo mode
  (`DEMO_MODE=1` — the single demo-stack flag, pinned on every demo container by
  `docker-compose.demo.yml` and passed to the migrate/seed one-shot; it replaced
  the old `DEMO_FAST_SCHEDULES`) the seed appends fast
  demo-cadence rows to `job_schedules` in addition to the default daily 22:30 UTC rows:
  `regime.classify` on `*/2 * * * *` (regime only, analytics lane) and
  `research.refresh` on `1-59/2 * * * *` (both research signals only, research
  lane — issue #107 split the retired combined `analytics.run` kind). The
  one-minute cron offset staggers them so they fire at different times.
  `DEMO_MODE` also SLOWS the wallet sampler: it seeds an hourly
  `wallet.sample_balances` row (`3 * * * *`, staggered off the hourly vault
  sample) and disables the per-minute baseline — the standing demo and the
  self-hosted CI runner share one host IP, and per-minute GeckoTerminal/Base-RPC
  sampling exhausts the per-IP quotas (hourly token prices are an accepted demo
  tradeoff; the seed's cold-start enqueue still lands a live sample at boot).
- **Committee opinions** — driven by a loop inside `scripts/demo.ts`, because a
  committee session needs live MCP agents to sign + submit takes. After a one-time
  reset + setup, it runs one full session (open → brief → collect → agents →
  close → aggregate → publish) roughly every 120 s (recursive `setTimeout`, offset
  from the analytics ticks), rotating (date, subject) so sessions accumulate. It does
  **not** reset between ticks. It reuses the `runSession` runner exported from
  `mcp/src/e2e.ts` (whose entry-point `main()` is guarded so importing it does not
  trigger the reset-heavy standalone flow).

One immediate tick of each runs at startup so the site has data on first load; the
one-shot frontend check (`scripts/demo-frontend-check.ts`) also runs once,
non-fatally.

**(c) Teardown — keeps data by default.** The stack stays up until you stop it. **Ctrl-C
/ SIGTERM tears it down** (`docker compose down`, **no `-v`**), printing the log-file path
first (the log persists for post-mortem). Containers + network are removed but the
**postgres data volume (or `--pg-data` host dir) is KEPT**, so a later `bun run demo`
resumes from it. The state file is **kept too** — the data it points to survives, so the
pointer must survive; it is overwritten by the next boot and only cleared when
`demo:clean` deletes the volume it names. A **startup failure** is the exception: it dumps
diagnostics and leaves the containers up for inspection. For a demo that is already
running (e.g. started in the background, or its process was killed with SIGKILL):

- `bun run demo:down` — `docker compose down` (no `-v`) for the recorded run; keeps the
  data volume/dir and the state file.
- `bun run demo:status` — `docker compose ps` for the recorded run (also prints the log
  path and the postgres data location). A stopped-but-preserved demo shows no running
  containers while the state file still points at the kept data.
- `bun run demo:clean` — the **only** command that deletes demo data. It removes every
  volume labeled `robotmoney.demo=1` (with `--project <name>` it scopes to one run),
  listing what it removed and **loudly skipping** any in-use volume (a demo still running
  on it). It **never** touches a `--pg-data` host directory (those are not docker volumes).

CI (`process.env.CI`) runs the checks once and then tears down; because keep-by-default
would leak a volume on the **shared self-hosted runner**, the CI path additionally
reclaims **its own run's** volume (scoped by the `robotmoney.demo.project` label) on both
success and failure, and `.github/workflows/e2e.yml` has an `if: always()` backstop for a
killed/timed-out boot — so CI leaves zero volumes behind while never touching a co-tenant
standing demo.

## 1. Lifecycle stages

Every stage of the session state machine must be exercised with the real domain code:

```
scheduled → collecting → window_closed → aggregated → published   (+ cancelled)
```

| Stage | What the demo must exercise |
|---|---|
| **Research pipeline** | At least one research signal tool runs (channel-divergence, late-cycle, or future tool) and its output lands in `research_signals`. The brief that members read must include research signal data alongside regime. |
| **Regime classification** | A regime snapshot is written and readable. If the live provider (`FetcherProvider`) is unavailable, the seeded provider (`seededProvider`) is acceptable for hermetic runs — but the write path (same tables, same domain logic) must match production. |
| **Open session** | A new session is created with `scheduled` state, assigned a subject from the rotation. |
| **Publish brief** | Brief is assembled from regime + research signals + subject snapshot + recent session history. Window opens with a `window_closes_at` deadline. |
| **Collecting (submission window)** | Multiple autonomous agents call the REST API, read regime/brief, sign payloads, and submit. At least one agent no-shows (recorded absent, not fabricated). Out-of-window submissions are rejected. Cross-role writes are denied. |
| **Close window** | Window transitions to `window_closed`. Submissions after this point are rejected. |
| **Aggregate** | Deterministic rollup: stance counts, mean confidence, absence list, synthesis string. No host-authored takes. |
| **Publish** | Session is marked publicly visible. |

## 2. Worker orchestration

Transitions must go through the **worker job pipeline**, not direct domain calls:

- Each lifecycle transition is a job kind (`committee.open_session`,
  `committee.publish_brief`, `committee.close_window`, `committee.aggregate`,
  `committee.publish`) enqueued via the scheduler or explicitly for the demo.
- Jobs are claimed and executed through the real `FOR UPDATE SKIP LOCKED` claim loop.
- Job schedules are seeded so a no-intervention run would also progress through the
  lifecycle (even if the demo also triggers them explicitly for determinism).
  *(As shipped: the `committee.*` schedule rows are seeded disabled by default —
  `COMMITTEE_SCHEDULES_ENABLED`, issue #208 / PR #229 — and the demo pins them
  disabled, driving the lifecycle transitions explicitly via the admin
  enqueue-job endpoint.)*

## 3. Surfaces

### 3.1 REST API

REST is the only transport (D21 retired the MCP server); the routes below
must be demonstrated exercising the same domain code:

- `POST /api/committee/admin/open`
- `POST /api/committee/admin/brief`
- `POST /api/committee/admin/close`
- `POST /api/committee/admin/aggregate`
- `POST /api/committee/admin/publish`
- `POST /api/committee/submit`
- `POST /api/committee/regime` (role-gated analytics write)
- `GET /api/committee/members`
- `GET /api/committee/sessions` / `GET /api/committee/sessions/:date/:subject`
- `GET /api/committee/brief?date=&subject=`
- `GET /api/dashboards/regime-snapshots`
- `GET /api/dashboards/research-signals/:key`

### 3.2 Frontend

At least one headless assertion must verify that the published session renders
correctly in the SPA:

- Signed takes display with verification badges (green check / red mismatch).
- Absent members are listed as absent.
- Regime chart and research signal views render.
- The `/committee` view shows the published session.
- `memoUrl` values (if any) render as outbound links.

## 4. Actors and roles

Every actor role must be exercised and cross-role write denial asserted:

| Actor | What the demo must do |
|---|---|
| **Committee member** (× N agents) | Call the REST API, read regime/brief, sign with own ed25519 key, submit recommendation. One agent deliberately no-shows. Members must NOT be able to write regime data or mutate sessions. |
| **RM analytics provider** | Write a regime snapshot (and optionally research signals) under a scoped credential. Must NOT be able to submit recommendations or mutate sessions. |
| **Protocol host (worker)** | Drive lifecycle transitions through the job queue. Must NOT generate member takes. |
| **Public reader** | Anonymous reads: published sessions, regime, research signals, member list. Must NOT write anything. |

## 5. Security invariants

Each invariant must be asserted (either via E2E assertions or hermetic tests that the
demo also runs):

| Invariant | Assertion |
|---|---|
| No fabricated takes | Absent members are absent in the published aggregate; their count matches registered members minus submitters. |
| Signature verification | A tampered payload (mutation of stance, confidence, memoUrl, nonce) invalidates the submission. |
| Nonce uniqueness | Replay of the same nonce is rejected. |
| Window enforcement | Submissions before the window opens (the brief-publication `scheduled → collecting` transition) or after `window_closed` are rejected. |
| Cross-role denial | Member cannot write regime; analytics provider cannot submit; neither can close/aggregate/publish. |
| TOCTOU safety | Concurrent submissions for the same session from different members both succeed (different nonces, different members). |
| No plaintext secrets | Access keys are stored as sha256 hashes; private keys are never transmitted. |
| memoUrl covered by signature | Tampering with memoUrl after submission invalidates the signature (`backend/tests/signing.test.ts` already covers this — the demo must also exercise it). |

## 6. Agent autonomy

Each agent must:

1. Generate its own ed25519 keypair on its own machine, via the `rmpc` binary
   (never server-side — see §11 R3).
2. Register via the member onboarding flow (§11): after installing the
   `committee-onboarding` skill and `rmpc`, and local keygen, the agent submits
   a signed application (username, contact, public key, `rmpc` signature) via
   the REST API; the server verifies it and issues the member UUID.
3. Identify itself to the REST API with its access-key hash (or bearer token
   in dev mode).
4. Read regime + brief + research signals via the REST API (autonomously — no
   hardcoded stance based on agent identity).
5. Decide a stance using a deterministic but non-trivial policy (weighted composite of
   regime signals + per-agent bias).
6. Fetch the canonical signing payload via `ROUTES.committee.signingPayload`.
7. Sign with its own private key (managed by `rmpc`).
8. Submit via `ROUTES.committee.submit`.
9. Optionally publish a memo via `ROUTES.committee.memos` (or via `memoUrl` in the
   submission).

RM never holds the private key at any point.

## 7. Hermeticity and cleanup

- **Production parity, always (issues #50, #147).** `bun run demo` — local or CI,
  including the required per-PR `e2e` gate — runs the **live** data path
  end-to-end: the real keyless analytics pipeline (FRED/Yahoo/DeFiLlama/EDGAR/…)
  and a real Base mainnet JSON-RPC read for the `/allocation` vault-economics
  slice (§10 below). There is no hermetic/offline demo mode: issue #147 removed
  `DEMO_HERMETIC`, the in-compose `base-rpc-stub` fixture service, and
  `scripts/demo-rpc-guard.ts` entirely (decision: issue #163 — every PR's merge
  gate now depends on live external providers). A required credential or
  provider that is unavailable must fail the boot loudly (non-zero exit,
  actionable message naming the missing dependency) — never a silent fallback
  to a fixture or stub.
- The resolver (`scripts/lib/demo-env.ts::resolveDemoEnv`, re-exported by
  `scripts/demo.ts`) is the single source of truth for the live data path;
  `docker-compose.demo.yml` mirrors its defaults so the two layers can never
  disagree (asserted by `scripts/tests/integration/demo-compose-config.test.ts`).

### 7b. Demo readiness gate

The **demo readiness gate** is the LIVE boot-and-check step block in the required
`e2e` workflow (`.github/workflows/e2e.yml`, step "Full-stack demo (demo
readiness gate)"; job id `e2e`, unchanged so branch protection's required-status-check
mapping stays intact). On every PR targeting main it boots the full LIVE demo stack
and runs the loud-failure guards that keep broken demos off main:

- `scripts/demo-frontend-check.ts` — the **core-surface-missing detector**: fetches
  each route fragment from the live backend and exits non-zero if a core surface marker
  (e.g. `x-data="committeeView()"`) is absent. Its wallet-balances provenance
  assertion (issue #134) always expects `live` (`stale`/`seed` are allowed
  degrades, loudly logged) now that there is only one supported demo mode.
- `test:browser` (Playwright, `spa.spec.ts`) — drives the rendered SPA.
- `scripts/demo-live-smoke.ts` (issue #128) — asserts the LIVE steady state:
  ≥2 published committee sessions (the #101 starvation guard), a fresh regime
  snapshot, wallet + vault-economics provenance `live` (only the documented
  #120 ZYFAI/GIZA degrades tolerated, loud-logged), and both research signals
  landed. This is the SAME script + assertions the nightly
  `demo-live-smoke-nightly.yml` sweep runs — reused as-is, not re-authored, so
  the required gate and the nightly sweep can never drift apart.

The core-surface detector's own loud-failure path is **self-tested**, not assumed:
`scripts/tests/integration/demo-frontend-check.test.ts` (run in the required `integration` job via
`bun run test:integration`) spawns the real `scripts/demo-frontend-check.ts` against an in-process
stub backend and proves both directions — it exits non-zero when the
`x-data="committeeView()"` marker is stripped from the served `/views/committee.html`,
and exits 0 against the correct, unmodified content — so a change that silently weakened
the detector's assertions is caught. The `demo-live-smoke.ts` assertions are likewise
self-tested by `scripts/tests/integration/demo-live-smoke.test.ts`.

Because every PR's required gate now depends on live external providers (public
Base mainnet RPC, FRED/Coin Metrics/GeckoTerminal/Yahoo/EDGAR), this job runs
slower and is occasionally flakier against those upstreams than the retired
hermetic boot was — an accepted, deliberate consequence of issue #147/#163. A
genuinely-unreachable external provider after real retries is a legitimate
external blocker to file, not a bug in the workflow.

### 7a. Tuning the live path

The live path (the only path) can still be tuned via env before `bun run demo`.

- **`ANALYTICS_SOURCE`** — the single, authoritative source knob honored by the
  orchestrator (`analytics/index.ts::resolveAnalyticsSource`, called by api + worker):
  - unset / `live` → real keyless fetchers (the only value the demo default
    selects),
  - `hermetic` → the deterministic offline seeded source backend unit tests
    depend on directly (`backend/src/analytics/access/hermetic-source.ts`);
    still a valid explicit override for local debugging, but no demo default
    ever selects it,
  - any other value is **refused loudly** (fail-closed — a typo never silently hits
    the network).
  The legacy `PROVIDER` / `config.analyticsProvider` knob is **deprecated** for source
  selection and no longer influences the live/demo path; do not use it to opt in.
- **`ANALYTICS_FLOOR_SEED`** — one-time cold-DB raw floor seed: load a vendored real
  `raw_indicator_history` floor once so a fresh live boot doesn't re-fetch years of
  history (esp. ~200 SEC-EDGAR requests; live EDGAR fetches are themselves
  bounded since #103 — per-request timeouts, a cheap preflight probe, and a hard
  ~90s aggregate sweep ceiling in `analytics/extract/edgar.ts` — so a slow SEC
  upstream can't pin the run) before the first classify. Idempotent
  (append-only — existing DB rows win on overlap; no-op once warm). Defaults to `1`
  on every demo boot (`scripts/lib/demo-env.ts`); set `0` explicitly to disable it.
  `FLOOR_SEED_PATH` overrides the seed file (must be readable inside the container).
- On-disk fetch cache — no TTL knob anymore (the old `FETCH_CACHE_TTL_MS` env
  was removed): the TTL is mode-selected in
  `backend/src/analytics/extract/fetch-cache.ts` — 1 hour under `DEMO_MODE`
  (per-IP quota protection; the demo host also runs the self-hosted CI runner),
  off everywhere else. Optional `FETCH_CACHE_DIR` still overrides the cache
  directory (a path is genuinely environmental; the TTL is not).
- **`BASE_RPC_URL`** — the vault-economics eth_call endpoint (§10). Unset →
  backend `config.ts` falls through to its production default
  (`https://mainnet.base.org`); set explicitly to point at a private RPC.

The live path preserves the honesty model: empty fetch → persisted real floor; a
no-history indicator is excluded + logged (never synthetic).
- Random ports (Postgres, API, MCP) + unique compose project name: concurrent runs do
  not collide. The run identity (project + ports + compose env) is written to
  `.agents/demo-state.json` so the explicit teardown command can find it.
- **Teardown on exit (local).** Ctrl-C / SIGTERM tears the stack down
  (`docker compose down`, **no `-v`** — containers + network removed, postgres data
  **kept**, state file **kept**) and prints the log-file path first. A **startup failure**
  is the exception — it leaves the stack RUNNING so it can be inspected. `bun run
  demo:down` tears down an already-running demo the same way (keeps data); `bun run
  demo:status` shows the containers, the log path, and the postgres data location; `bun
  run demo:clean` is the only command that deletes demo data volumes (by
  `robotmoney.demo=1` label; loud skip on in-use; never a `--pg-data` host dir).
- **CI reclaims its own volume:** when `process.env.CI` is set the demo runs its checks
  once, tears down (`docker compose down`, no `-v`), then deletes **only its own run's**
  volume (scoped by the `robotmoney.demo.project` label) so the shared self-hosted runner
  leaks nothing while a co-tenant standing demo is untouched.
- A missing Docker dependency (Postgres image, build failure) must fail the run
  loudly, never silently skip.

## 8. Agent memo workflow (`memoUrl` + `post_memo`)

The demo must demonstrate the full agent memo lifecycle:

1. At least one agent publishes a long-form memo at a member-hosted URL (or a
   simulated URL within the demo).
2. The `memoUrl` is included in the submission payload and covered by the signature.
3. `ROUTES.committee.memos` writes the memo to the member's own storage and
   returns the URL.
4. The published session frontend renders the `memoUrl` as a link.
5. Tampering with the `memoUrl` after submission invalidates the signature (asserted
   in `signing.test.ts`).

## 9. Multi-session awareness

The demo should demonstrate at least two sessions (or the concept of rotation):

- Session N completes the full lifecycle.
- The brief for session N+1 references the outcome of session N.
- The session list view (`list_sessions`) shows both.

## 10. Demo output

### 10.1 TUI (default, interactive terminal)

In an interactive terminal the demo takes over the screen with a zero-dependency ANSI
TUI (`scripts/lib/tui.ts`) that repaints ~4×/s. Raw logs are **suppressed** on screen;
the TUI shows only distilled state. Layout:

- **Services** — the run's URLs (Site / Regime / Committee / Research per key / MCP /
  Admin), on `127.0.0.1:<random port>`. The **Admin** entry is the `/admin`
  task-queue jobs dashboard (#117); its password (`ADMIN_TOKEN`) is a fresh
  random value generated per run and rendered **only** here, on the pane's
  `Admin pass` line — never logged, never written to `demo-state.json`
  (`scripts/lib/demo-main.ts`).
- **Startup** — per-container status (postgres, api, worker, mcp) plus migrate and the
  `/health` checks, each shown pending / in-progress (spinner) / healthy / failed. After
  bring-up the icons are kept live by polling the **real docker container state**
  (`docker compose ps` every ~3 s), so a post-startup crash / restart-loop / `unhealthy`
  Docker healthcheck turns the icon red (with a detail like `exited 1` / `restarting` /
  `unhealthy`). The pane header shows a refresh spinner while a check is in flight.
- **Onboarding** (full-width strip) — each prospective member's join checklist:
  `connect → discover → toolchain → apply → approve → claim → session → memo →
  admitted`, each pending / spinner / ✓ / ✗ — tracking §11.2 exactly. Steps 1–6
  (`connect`…`claim`) render straight from the real-inference eval harness's
  observed step-state record (`scripts/lib/onboarding-eval.ts`): each admission
  launches a vanilla OpenCode member-agent container and hands it the canonical
  copy-paste prompt with a generated identity, and the agent works out skill
  install, `rmpc` install, keygen, and the signed application entirely on its
  own via real inference — the demo only observes the public application-status
  API and the admin roster (§11 R8). `session`/`memo`/`admitted` flip the same
  way as before: when the newly-admitted member is separately observed
  submitting a signed take + posting a memo in a live committee session. A
  failed or timed-out admission renders red and its container transcript is
  logged — a real eval result, never retried. Admitted members **retain their
  checklist** in the pane (most recent shown, with a `(+N earlier admitted)`
  note), and an `upcoming → Name in m:ss …` line **counts down** to the next
  scheduled admissions. See §11.
- **Activity** (largest region) — Research plus **one pane per committee subject**, laid
  out as responsive columns (side by side when they fit, stacking when the terminal is
  narrow):
  - **Research** — recent `regime.classify` / `research.refresh` runs, advancing
    queued → running → done as the worker's queue transitions are observed, annotated
    with what landed (e.g. `regime → risk_on 0.76`). Fidelity is queue-level (see
    [this specification's §10](#10-demo-output)), not fabricated sub-steps. The header shows a live **countdown** to
    the next scheduled regime/research run (from `job_schedules.next_run_at`, using the
    DB clock).
  - **One pane per subject** (woon, mav, …) — each subject runs on its **own schedule**
    (independent interval + stagger offset, serialized execution) and gets its own pane
    showing its session lifecycle state, each member's real stage (connect → fetch →
    thinking → reporting → waiting; no-shows absent), and a per-subject **countdown** to
    its next session (`running…` while in progress).
- **Log footer** — the last few distilled events plus: `Ctrl-C / SIGTERM tears down the
  stack (containers + network; postgres data kept)`.

Full verbose output from every process (api, worker, mcp, migrations, the committee
driver, and the orchestrator's own narration) is written to
`.agents/demo-<project>.log` (path shown in the TUI header, recorded in the state file,
and shown by `bun run demo:status`). On Ctrl-C / SIGTERM the terminal is restored first,
the log path is printed, the stack is torn down (data kept), and a resume/reclaim hint is
printed. A startup failure instead restores the terminal and leaves the containers up for
inspection (with the log path).

### 10.2 Plain fallback (non-TTY, CI, `--no-tui` / `NO_TUI=1`)

When stdout is not a TTY, in CI, or when the TUI is disabled, the demo keeps the plain
line-logging behavior: once healthy it prints a READY route table, then logs each
scheduled action as it fires.

```
── Robot Money demo ── READY ────────────────────────────
  Site:       http://127.0.0.1:<api>/
  Regime:     http://127.0.0.1:<api>/regime
  Committee:  http://127.0.0.1:<api>/committee
  Research:   http://127.0.0.1:<api>/research/<key>
  MCP:        http://127.0.0.1:<mcp>/health
  Admin:      http://127.0.0.1:<api>/admin  (password shown in the interactive TUI only)

  State file: .agents/demo-state.json
  Log file:   .agents/demo-<project>.log
  PG data:    volume <project>_pgdata (fresh-per-run; kept on teardown)
  Demo actions run on a ~2-min staggered cadence.
  Ctrl-C / SIGTERM tears down the stack (containers + network; postgres data kept).
  Reclaim stopped demos' data volumes with: bun run demo:clean
```

## 11. Member onboarding (normative spec)

Status: target sequence. This section is the plan of record for how a prospective
committee member joins; the demo (§10.1), e2e suite, and user-facing docs are aligned to
it (`scripts/lib/onboarding-eval.ts` drives the demo and e2e admission path;
`scripts/rmpc-release-e2e.ts` is the no-inference proof of the same signed-apply chain).
Where any other code differs, this section wins.

### 11.1 Requirements

- **R1 — Human-provided identity.** The human owner of the agent provides identifying
  information (a username/display name, contact) for the application. A real person
  stands behind every member. The identity always originates with the human, but the
  application itself is submitted by the already-set-up agent — via the public
  API — or on the web form using the same agent-produced signed payload.
- **R2 — Server issues only an id.** When an application completes — over whichever
  channel it arrived (API or web form) — the system generates a unique id (a
  random UUID) for the prospective member, returns it, and exposes it on the public
  application-status page. That id is the only thing the server mints at application
  time; everything else in the application (identity, public key, signature) comes
  from the owner's side.
- **R3 — Keygen is never centralized.** The centralized system never generates keys.
  Ed25519 keygen always happens on the agent's machine; Robot Money never sees a private
  key at any point in the lifecycle.
- **R4 — One-prompt setup.** Onboarding starts with a single copy-paste prompt the
  owner drops into their agent harness (canonical text in the participation
  quickstart). The prompt frames the long-running task (write investment memos,
  present them to the Investment Committee), tells the agent to install the
  **`committee-onboarding` skill** into its own harness (a stable docs URL), and
  carries the owner's identity (R1). Nothing beyond pasting this prompt is
  required of the human at setup time.
- **R5 — Skill-based discovery.** The **`committee-onboarding` skill** at
  `plugins/robotmoney-committee/skills/committee-onboarding/SKILL.md` in
  `robotmoney/robotmoney-core` (robotmoney-core#1170/#1171) is itself the
  canonical, current statement of the application steps — set up `rmpc`,
  generate keys, submit the signed application over the REST API, wait for
  approval, then participate — **and** the detailed procedure: setting up the
  owner's agent runtime (Claude Code, OpenClaw, Codex, or OpenCode) and
  installing the `rmpc` binary (from `robotmoney-core`), which manages keygen
  and all signatures. There is no separate discovery tool or endpoint call —
  the skill is maintained centrally in `robotmoney-core` and is fetched fresh
  on each install, so the copy-paste prompt never goes stale even though it
  only ever names the skill, not the steps themselves. (D21 retired the
  MCP-server `apply-how-to` tool that previously served this role; the skill
  now carries that property on its own.)
- **R6 — Setup-gated apply.** An application **cannot complete** unless the owner's
  agent demonstrably works: the application carries the member's username, contact,
  and public key together with an `rmpc` signature over the canonical application
  payload, and the server verifies that signature against the submitted key before
  recording anything. Setup — `rmpc` install, keygen — therefore happens
  **before** apply, apply runs fully headlessly over the REST API
  (`ROUTES.committee.apply`), and the review queue only ever contains
  applications whose toolchain is already proven; no separate setup-proof step
  exists.
- **R7 — Approval.** In production, the application then waits for a human admin to
  approve it. In `bun run demo`, approval is automatic after 10 seconds — invoked
  through the same admin API, not a different code path.
- **R8 — Isomorphism, no mocks: onboarding is an eval.** The whole process is
  isomorphic across (a) manual testing, (b) the `bun run demo` simulation,
  (c) production, and (d) e2e tests. All four use the real skill, the real
  `rmpc` binary, the real REST API, and real signature verification. In the demo and
  e2e, the member's side is not a script: each new member is a **vanilla OpenCode
  agent container** handed the same canonical copy-paste prompt (R4) a human would
  paste, doing **real inference** — onboarding doubles as a continuous eval of
  whether our instructions alone are enough to onboard a fresh agent. There are no
  mocks, stubs, or alternative code paths; the only permitted differences are
  configuration (endpoints, credentials) and who triggers approval and when (R7).
  The container is a **vanilla, keyless OpenCode install** (D22): no API key, no
  provider secret, no paid model, and no opt-in override may appear anywhere on an
  eval path, and there is **no inference-off mode** — an eval always makes a real
  model call, and a missing prerequisite fails loudly rather than passing by
  absence. The eval's structure, scoring, and shared components are §11.3.

### 11.2 Sequence

1. **connect** — the owner pastes the canonical prompt (R4) into their agent harness.
2. **discover** — following the prompt, the agent installs the `committee-onboarding`
   skill (R5) into its own harness, which supplies the current, detailed application
   steps.
3. **toolchain + keygen** — following the skill, the agent installs `rmpc`
   (R5) and `rmpc` generates the ed25519 keypair locally on the agent's machine (R3).
4. **apply (signed)** — headlessly, the agent submits the application: the owner's
   username and contact (R1) plus the public key and an `rmpc` signature over the
   canonical application payload (R6), over the REST API
   (`ROUTES.committee.apply`); the web form accepts the same agent-produced signed
   payload. The server verifies the signature against the submitted key, records
   the application, and mints and returns the member's UUID (R2), which the status
   page tracks from then on. An unsigned or badly-signed submission never
   completes — so no human review time is ever spent on a broken toolchain.
5. **review / approve** — a human admin approves in production; the demo auto-approves
   via the same admin API after 10 s (R7).
6. **claim + participate** — the member claims its bearer token by signing the server
   challenge (existing self-serve seating, issue #205), and from the next session on
   reads the brief and the research engine's signals over the REST API and submits
   `rmpc`-signed takes and memos (§6).

The demo's Onboarding strip (§10.1) renders exactly this checklist — its step names
track this sequence, and each step is driven by the real flow (R8): for every
admission the demo launches a vanilla OpenCode agent container, pastes the canonical
prompt with a generated identity, and the agent onboards **itself** with real
inference — skill install, `rmpc` install, keygen, signed apply, claim,
participation. The demo only observes, deriving the strip's step states from the
public application-status API, with the 10 s auto-approval as the only scripted
divergence. A member that fails to onboard is a red eval result — evidence the
instructions or tooling regressed, not something the demo papers over. The demo
admits its first member ~1 min after start and attempts the next ~5 minutes after
the previous admission finishes (real eval duration is additive, so a 20-minute
timeout pushes the next attempt out by that much). The newcomer roster is
**fixed and finite** — the five names in `scripts/lib/demo-newcomers.ts`, in
order, with no generated fallback once the list is exhausted (#260). The driver
then stops; the roster cap (`COMMITTEE_ROSTER_CAP`) is defence in depth and is
never reached by the standing demo. A failed admission is not retried and is not
replaced, so the demo can finish with fewer than five newcomers seated — that is
the eval result, reported rather than hidden.

### 11.3 Onboarding eval (normative)

Status: target design (D22). R8 makes onboarding an eval; this section specifies
what that eval is, how it is scored, and which components it shares with
`bun run demo`. Where any other code differs, this section wins.

**Goal.** This eval exists because nothing else in CI measures the product's
capability. Every other gate proves that code the team wrote runs; the
product's actual user is an unaided outside AI agent, and its product surface
is onboarding itself (§11.1). The only honest measurement of that is a real
one — real agent, real inference, real skill, real `rmpc`, real REST, real
signature verification — and this harness is the SDLC's instrument for taking
it. The harness's job is to report the truth about whether onboarding works,
never to reach green: a red backed by a true product or provider result is a
valid outcome, and a green the harness cannot back is worse than no eval at
all. E1–E7 below forbid, one by one, the seams through which a harness could
manufacture a pass instead of taking a measurement.

**E1 — Keyless, no exceptions.** Every layer runs a **vanilla, keyless OpenCode
install** pinned to the free OpenCode Zen tier (`opencode/big-pickle`). The model
id is an in-code constant. No API key, provider secret, paid model, or opt-in
override may be readable from, or passed to, any eval path — there is deliberately
no configuration surface through which a keyed model could be selected. A
contributor with a fresh checkout, Docker, and network egress can run the entire
eval.

**E2 — No inference-off mode.** Every layer makes a real model call. There is no
mock, no injection seam on the eval's own path, no scripted fallback that performs
the agent's steps for it, and no conditional skip: a missing Docker daemon or
missing egress **throws**, failing the eval loudly. Inference-off *rails* checks
(`scripts/tests/integration/onboarding-eval-infra.test.ts`) remain valuable and remain
separate — they prove the machinery an eval rides on, and they are never a
substitute for one.

**E3 — Layers.** The eval is graded, not monolithic. Layers 0-3 run isolated
(fast, parallel, sharp diagnostics); layer 4 is the integrated run that proves the
agent can sequence the whole thing itself.

| # | Layer | Proves | Stack | Observed by |
|---|---|---|---|---|
| 0 | runtime | image, `opencode.json`, provider reachable | none | trivial task completes; distinguishes *dead* from *refused*, and **gates the run** (below) |
| 1 | skill install | the agent can find and install `committee-onboarding` | none | `SKILL.md` present on disk in the runtime's skill path |
| 2 | toolchain | the agent can install `rmpc` for its own arch | none | binary on PATH; `--help` lists `committee-identity` |
| 3 | keygen + signing | local ed25519 identity, byte-exact canonical payload | none | signature harvested **passively** — from the drained run transcript and the stopped container's filesystem — then verified **offline** against `canonicalizeApplication` with the real backend `verifyApplicationSignature` |
| 4 | admission | the full R4→R8 sequence, unaided | `core` | server-minted member reaches the active roster |

**Layer 0 GATES the run.** Its task is to write two characters to a file; nothing
about Robot Money appears in it, so it cannot be refused on the merits and cannot
fail for any product reason. A red layer 0 therefore means the runtime or the
provider is not serving, and **the other layers' results in that run are not
measurements**. Observed 2026-07-26: layer 0 returned `admitted` in 6 seconds,
and 80 minutes later — same commit, same image — timed out at 5 minutes with an
**empty transcript**, while layers 1 and 2 ran to their full 25-minute caps in
between. A layer 2 timeout sitting under a red layer 0 says nothing about whether
an agent can install `rmpc`; it says the tier stopped answering. Read layer 0
first, re-run later rather than concluding, and do not spend the admission sweep
at all until it is green.

Layers 0-3 need **no server**. Layer 4 needs a `core` stack only — postgres and
the api — because apply/approve/claim is Postgres CRUD plus signature
verification and never touches the job queue. The eval never boots the full demo
cluster: no worker lanes, no EDGAR seed, no frontend checks, no session drivers.

Layers 1-3 observe by inspecting the **stopped container's filesystem** before
removal (layer 3 additionally reads the **drained run transcript**, which is
observation of the same already-finished run), never by instructing the agent to
emit artifacts — adding harness
instructions would edit the task under test. Layer 4 uses the canonical
`ONBOARDING_PROMPT` verbatim (identity placeholders filled, plus the existing
local-network note) and observes only server-side state, preserving the black-box
property where it matters most.

**The harness note (layers 1-3) is environment information, never how-to.**
Layers 1-2 slice the canonical prompt *before* the sentence carrying the
applicant's identity, and observed live on 2026-07-26 that removal changed what
layer 1 measured: the agent neither failed nor refused — it found the skill,
understood the job, and stopped to ask its owner "what display name and contact
email should I use?". That is the *correct* move under the skill's own Step 0
("if the owner's identity is missing or ambiguous, ask for it — never invent or
guess"), but in a container with nobody to answer it turned a skill-install
measurement into "does the agent ask a sensible question?". `harnessNote()`
(`evals/onboarding/support/layer-tasks.ts`) restores exactly the two facts the
slice dropped — who the owner is, and that no one is available to reply — as a
clearly delimited block appended after the task, in the same category as layer
4's local-network note. The boundary is enforceable and enforced: the note names
no install command, directory, URL, `rmpc` subcommand, or endpoint, and
`scripts/tests/unit/onboarding-layer-tasks.test.ts` re-runs every answer-leak
assertion against the **noted** tasks, so it cannot become a hint. Restoring
information the slice removed is legitimate; supplying information the agent is
being measured on discovering is not.

**E4 — Scored by sampling.** Layer 4 runs K samples with a fresh identity and
container each. Every outcome is classified — `admitted`, `refused`,
`rate-limited`, `timed-out`, `navigation-failure` — and the **admission rate is
the reported metric**. A refusal is data, not flake: a rising refusal rate is a
regression in prompt quality, and this is the only instrument that surfaces it.
The scorecard asserts K samples actually ran, so a zero-sample run is red rather
than a vacuous green.

**E5 — Shared components, not parallel ones.** The eval is the demo's onboarding
path with fewer services booted. Three components are shared by construction:

- **`scripts/stack/`** (entry `scripts/stack/index.ts`; the pure builders in
  `config.ts`, port allocation in `ports.ts`, the thin impure shell in
  `stack.ts`) — one bring-up with a `core`/`full` profile,
  free of module-scope side effects and of ambient-environment reads or writes
  (compose's env map is built from an explicit config object and passed to that
  one child process). The single deliberate exception is `host-env.ts`, whose
  one export returns ONLY allowlisted docker-client plumbing (`PATH`,
  `DOCKER_HOST`, proxies) and provably no key, token, or model id — it exists so
  the eval, which may contain no environment read at all, can still find a
  daemon. Consumed by all three: the demo (`full`), the eval (`core`), and the
  rails check (`core`, whose forked `bringUpInfra()` is deleted in its favour).
  The demo's `StackHooks` mapping is what keeps the TUI out of this module — each
  lifecycle event drives the panes the hand-rolled sequence used to drive
  directly, so the visible boot is unchanged and `runCompose`/`waitForPostgres`/
  `waitForHttp` are deleted from `demo-main.ts` rather than left as a parallel
  path. One demo-specific carve-out is deliberate: `DEMO_COMPOSE_PASSTHROUGH`
  forwards the demo's documented compose knobs (`COMMITTEE_*_CRON`,
  `BASE_RPC_URL`, `RM_ENV`, …) from the operator's environment through
  `extraComposeEnv`. The demo is an operator tool, not an eval — E1's no-ambient-
  read rule protects the eval path, and silently dropping an exported
  `COMMITTEE_WINDOW_MINUTES` would be a regression. Values the stack config owns
  (ports, credentials, `DATABASE_URL`, `POSTGRES_*`) are excluded from that list
  so an exported value can never shadow them.
- **`runMemberAgent()`** (`scripts/agent/member-agent.ts`, alongside
  `buildMemberAgentArgv`, `memberAgentContainerName`, and the
  `containerFileExists`/`copyFromContainer` `docker cp` helpers) — the
  member-agent container primitive (deterministic
  name, compose-run argv, pipe draining, guaranteed removal), extracted from
  `runOnboardingEval` so layers 0-3 and layer 4 launch containers the same way.
  Its `keepUntilInspected` + `inspect` bracket is how layers 1-3 read the
  **stopped** container's filesystem (E3) before removal.
- **`classifyOutcome()`** (`scripts/agent/classify-outcome.ts`, over the shared
  `opencode --format json` parser `scripts/agent/transcript.ts`) — one
  definition, three consumers: the retry predicate in
  `runOnboardingEvalWithRetry`, the demo's onboarding driver, and the eval's
  scorecard. `refused` requires three independent conjuncts — structural (no
  member row, clean exit, no timeout), positional (only the agent's FINAL
  assistant message is examined), and lexical (a first-person declination act
  **and** a safety rationale in that same message) — because a false `refused`
  would retry away a genuine navigation failure. A refusal is retryable in
  `runOnboardingEvalWithRetry`, which is why the demo no longer forfeits a finite
  roster seat to one unlucky sample; that wrapper serves the demo and the single
  e2e admission only, and the **layer-4 sampler calls the bare
  `runOnboardingEval`**, so the reported refusal rate is never softened by
  retries.

**E6 — CI placement and cost.** The eval is `CI_CLASS: heavy` — sweep-only,
therefore no `pull_request` trigger — and runs in the existing
`committee-opencode-nightly.yml` on `ubuntu-latest` (the self-hosted runner
shares its IP with the standing `rmdemo_*` stack and has a documented history of
429 flake on live-call gates). No new workflow is added. The per-PR signal stays
what it is today: the inference-off rails, plus the single real-inference
admission the `e2e` job performs off its own demo boot.

Every timeout is **derived from one cost model**
(`evals/onboarding/support/budget.ts`), never written as a literal in a layer
file or a workflow, and `scripts/tests/unit/onboarding-eval-budget.test.ts` pins
the two against each other on the per-PR path. Measured on 2026-07-25/26 (the
"~2-5 minutes per layer" estimate was only ever true of layer 0):

| Job | Healthy tier | Measured 2026-07-26 | Worst case |
|---|---|---|---|
| isolated (layers 0-3) | ~20 min | **59.5 min** (3 of 4 layers hit their cap) | **181 min** (`MAX_ATTEMPTS = 2` on each heavy layer) |
| admission (layer 4) | — never yet executed | — | **122 min** (`SAMPLE_COUNT` × 20 min, sequential, never retried, plus bring-up) |

**The free tier degrades by HANGING, not by returning 429.** Across a 59-minute
observed run there was not one rate-limit string, yet the provider progressively
stopped answering: the same four layers took 4.3, 25.0, 25.0, and 5.0 minutes, in
that order, three of them hitting their cap. `rate-limited` therefore rarely
fires on this tier and **`timed-out` is the real throttle signal**. Isolated
layers retry only `rate-limited` (retrying a 25-minute timeout would double an
already expensive layer), so a throttled run is reported rather than retried —
which is why the CI budget must cover the capped case rather than the happy one.

The ordering is normative:

> **in-test timeout < step `timeout-minutes` < job `timeout-minutes`**

The in-test bound must fire first because it is the only one that produces a
diagnosis. A GitHub step timeout is a SIGKILL of the runner step: it takes the
outcome classification, `explainLayerFailure()`'s output, the agent's final
message, and — for the sweep — the scorecard that `afterAll` writes for the
`if: always()` upload to collect. A truncated nightly cannot even report that it
was rate-limited, which is the one outcome meaning the eval measured nothing.
This matters most on a rate-limited night, when the run is both longest and
least conclusive.

**E7 — A refusal is a product defect to be answered, not a green to be
engineered.** When a layer reports `refused`, the eval has measured the shipped
prompt and the only legitimate lever is the **canonical `ONBOARDING_PROMPT`
itself**. Softening a layer task is forbidden: layers 1-3 are verbatim slices,
`canonicalFragment()` throws on paraphrase, and the answer-leak assertions
forbid how-to. The prompt may be revised only by adding bounds that are **true
and independently checkable** — never by reassuring an agent past a real risk.
This is a live requirement, not a hypothetical: vanilla agents refused the
shipped prompt in two separate runs, objecting to an install from a repository
they could not vouch for, to key generation, and to submission to an unknown
endpoint. Those objections were fair, and they cost real admissions rather than
merely eval greens. The prompt now answers each with a checkable claim — the
committee and its members' track records are public; the private key never
leaves the applicant's machine and Robot Money receives only the public half
(R3 — the server can only verify); a committee signature attests **authorship**
of a written recommendation and authorizes no transaction. An agent that still
declines after reading true bounds is making a legitimate call, and the eval
must report it as such.

---

## Admin Surface: Research and Investment Committee

Status: implementation specification
Audience: engineering agents implementing the next admin phase
Route: `/admin` and `/admin/*` (not linked from public navigation)

## 1. Outcome

Build one authenticated operator surface that lets a Robot Money administrator:

1. diagnose every run of the research pipeline from source access through the
   public report;
2. inspect and safely rerun queue work;
3. create and manage Investment Committee topics;
4. add, activate, deactivate, and review committee members;
5. schedule a committee session and observe its lifecycle;
6. inspect the exact roster, brief inputs, signed member recommendations,
   absences, aggregate, and publication for a session; and
7. see an immutable audit trail for every admin mutation.

An implementation is complete only when an admin can perform these workflows
without SQL access, shell access, or manual calls to the existing committee
admin dispatcher.

## 2. Decisions fixed by this specification

These decisions are not open implementation questions:

- Keep the existing `ADMIN_TOKEN` and `X-Admin-Token` authentication model.
  Role-based admin accounts are out of scope for this phase.
- Keep the buildless Alpine frontend and the frontend-to-backend HTTP boundary.
- Keep the Postgres queue as the executor. Admin requests enqueue lifecycle and
  research work; the browser never runs domain operations itself.
- Preserve accepted committee recommendations as append-only signed records.
  Admins cannot edit or delete them.
- “Remove member” means deactivate. No committee member is hard-deleted.
- “Topic” is the UI term; `committee_subjects` remains the database and API
  domain term.
- The persisted committee states are exactly `scheduled`, `collecting`,
  `window_closed`, `aggregated`, `published`, and the new terminal state
  `cancelled`. There is no persisted `brief_published` state in the product.
- A committee session snapshots its expected roster when it is created.
  Later global member changes do not rewrite that roster or historical quorum.
- Research recovery reruns a complete tool. Individual stages are not retried
  because the current stages share in-memory data and are not independently
  executable.
- Analytics natural-key rows remain current-value projections and may be
  upserted by a rerun. The new run/stage records preserve who ran what, the
  before/after checksums, warnings, and outcome; this phase does not introduce
  versioned copies of every raw time-series row.
- The seeded recurring committee schedules remain disabled. Product committee
  scheduling uses one-off queue jobs scoped to a specific session. Empty-payload
  recurring rows cannot identify a subject or session and must not be enabled by
  this UI. *(Superseded by issue #208 / PR #229: schedules are
  environment-configurable via `COMMITTEE_SCHEDULES_ENABLED` — see §9.4 of the
  main document.)*

## 3. Current product baseline

The implementation must extend, not replace, these pieces:

- `frontend/public/views/admin.html` and
  `frontend/public/assets/js/app/alpine/views/admin-jobs.js` provide the current
  password gate, five-second polling, schedules, queue jobs, runs, and JSON logs.
- `backend/src/api/routes/admin.ts` exposes `POST /api/admin/auth`,
  `GET /api/admin/jobs`, `GET /api/admin/jobs/:id`, and
  `GET /api/admin/runs`. These routes are read-only and fail closed before SQL.
- `jobs`, `job_schedules`, and `job_runs` are defined by migration `0003`.
  `jobs.status` currently allows `pending`, `running`, `succeeded`, `failed`, and
  `dead`; normal retry handling leaves the job `pending` and records `failed` or
  `degraded` on `job_runs`.
- Analytics runs through `runAnalytics()` and the stages described in
  `docs/architecture.md`: `access → extract → transform → analyze → store →
  report`. The production jobs are `regime.classify` at 22:30 UTC and
  `research.refresh` at 23:00 UTC.
- The analytics worker must persist through the authenticated
  `/api/analytics/*` boundary. Migration `0016` denies its database role writes
  to analytics tables. New analytics telemetry writes must respect the same
  boundary.
- The current committee domain supports public reads, applications, activation,
  signed submissions, memos, subject creation, and the five-state lifecycle.
  Several lifecycle functions currently lack state guards; this plan adds them.
- Canonical accepted takes live in `committee_recommendations`, one per
  `(session_id, member_id)`, with replay protection on `(member_id, nonce)`.
  Invalid signatures are rejected before insert and are not retained. The admin
  UI therefore shows accepted submissions only; rejected submission-attempt
  forensics are out of scope.
- Public committee DTOs intentionally omit secrets and admin metadata. Admin DTOs
  must be new types rather than widening public responses with contact or key
  information.

## 4. User stories and required behavior

### US-A1 — Sign in and retain a tab session

As an admin, I can enter the admin password once and use all admin sections in
that browser tab.

Acceptance:

- The existing `rm_admin_token` `sessionStorage` key is retained.
- Every admin request sends `X-Admin-Token`.
- Any 403 clears the stored token, stops polling, clears sensitive state, and
  returns to the login form with “Session expired — sign in again.”
- The token never appears in a URL, log, audit row, or rendered JSON payload.

### US-A2 — See operational health

As an admin, I can see current failures, stale research, active committee work,
and the next scheduled events on one page.

Acceptance:

- Overview cards show queue counts, last success/failure by production kind,
  stale analytics outputs, the next enabled analytics schedules, and the next
  committee session event.
- Alerts distinguish `not_run`, `running`, `degraded`, `failed`, `dead`,
  `stale`, and `healthy`.
- A “running too long” alert means `jobs.status = 'running'` and
  `locked_at < now() - JOB_VISIBILITY_TIMEOUT`; it does not guess from average
  duration.
- Regime staleness uses the existing regime projection’s staleness block.
- Each research signal is stale when its latest `research_signals.date` is more
  than two UTC calendar days behind the API server date. Use a named constant
  `RESEARCH_STALE_DAYS = 2` in the admin projection.

### US-R1 — List and filter research runs

As an admin, I can find a run by job kind, tool, as-of date, status, or job id.

Acceptance:

- One `regime.classify` attempt creates one analytics run with the `regime` tool.
- One scheduled `research.refresh` attempt creates one analytics run containing
  `channel-divergence` and `late-cycle-signals` tool traces.
- A manual single-tool research rerun creates a `research.refresh` run containing
  only the requested research tool.
- The list shows run id, job id, attempt, source mode, as-of date, tools,
  current stage, status, warning count, start, finish, and duration.

### US-R2 — Inspect every research stage

As an admin, I can open a research run and understand what happened at every
stage without reading arbitrary console logs.

Acceptance:

| Stage | Required recorded detail |
|---|---|
| `access` | `ANALYTICS_SOURCE` result (`live` or `hermetic`), requested tool inputs, persisted-floor row counts, floor-seed result, and cache configuration; never headers or tokens |
| `extract` | source and indicator/input keys, request outcome, timeout/error summary, fetched point counts, first/last date, and persisted-floor fallback use |
| `transform` | tool, date range, alignment mode, raw/aligned/transformed counts, missing/forward-filled/zero-filled counts, and bounded preview |
| `analyze` | tool, dependency list, methodology/version, output summary, insufficient-history warnings, and output checksum |
| `store` | authenticated API operation, target table, natural keys/counts, inserted-or-updated result, before/after checksum, and transaction outcome |
| `report` | public route checked, returned as-of date, payload checksum, staleness result, and whether it matches the stored output |

Stage states are `pending`, `running`, `succeeded`, `warning`, `failed`, and
`skipped`. A stage with zero rows is never silently shown as succeeded: it is
either `warning` with fallback detail or `failed` when no usable data exists.

The detail page links back to the queue job and exposes redacted `job_runs`
output/error. It displays at most 250 preview points per artifact. Complete
persisted raw history is fetched on demand by indicator/date range; it is not
copied into telemetry JSON.

### US-R3 — Navigate research datapoints

As an admin, I can move from a source indicator to stored data and the public
report it affects.

Acceptance:

- `regime` shows all registry indicators, their source, transform, latest raw
  date/value, transformed value, signed percentile, panel weight, and raw
  history range from `raw_indicator_history`.
- `channel-divergence` and `late-cycle-signals` expose the persisted payload for
  the selected `(signal_key, date)` and its bounded source/transform previews.
- A raw-series request accepts an indicator, start date, end date, and limit;
  it cannot execute arbitrary SQL or request an unregistered table.
- Links open the corresponding public `/regime` or `/research/:key` page in a
  separate tab.

### US-R4 — Rerun research safely

As an admin, I can rerun a failed, degraded, or stale research tool for an
explicit as-of date.

Acceptance:

- The form requires `kind`, `asof`, and a reason of 10–500 characters.
- `regime.classify` only permits tool `regime`.
- `research.refresh` permits either both research tools or exactly one of
  `channel-divergence` and `late-cycle-signals`.
- The API inserts a new pending job with a unique manual dedupe key and returns
  202 with the job id. It never resets or mutates the original job.
- The queue payload records only `asof`, optional `toolId`, and an internal
  audit request id. The human reason is stored in audit data, not copied into
  worker logs.
- A rerun may upsert existing natural keys. The store stage records before and
  after checksums so the admin can see whether the canonical output changed.

### US-Q1 — Inspect and retry queue work

As an admin, I can filter queue jobs and create a safe retry of dead work.

Acceptance:

- Existing queue screens remain available under `/admin/queue`.
- Filters cover kind, job status, run status, scope type/id, and created range.
- Job detail includes payload, dedupe key, worker lock, attempts, every run, and
  any linked analytics run or committee session.
- “Retry” is available only for a `dead` job. It clones kind/payload/priority into
  a new pending job, gives it a unique manual dedupe key, and audits the source
  and new job ids. It never changes the dead row.
- Schedule editing is limited to enabled/disabled for existing analytics
  schedules. Cron, timezone, kind, and payload are read-only in this phase.
- The five disabled recurring `committee.*` rows are labelled “legacy/demo —
  not product scheduling” and cannot be enabled from the UI. *(Superseded by
  issue #208 / PR #229: schedules are environment-configurable via
  `COMMITTEE_SCHEDULES_ENABLED` — see §9.4 of the main document.)*

### US-C1 — Create and edit a committee topic

As a committee manager, I can add a topic and make it eligible for future
sessions.

Acceptance:

- Create and edit support every durable `committee_subjects` field.
- New topic ids match `^[a-z0-9][a-z0-9-]{1,63}$` and are immutable after create.
- Required fields are id, name, operator, thesis, source type, and
  recommendation type.
- Source type is `rpc`, `manual`, `vault_tvl`, or `framework`.
- Recommendation type is `position_actions` or `bucket_weights`.
- Wallet and NFT entries have `address`, `chain`, and optional `label` strings.
  `framework` requires an empty wallet array; `rpc` requires at least one wallet.
- `linkedMemberId`, when present, must reference an existing member.
- Deactivation sets `status = 'inactive'`. It prevents new sessions but leaves
  old sessions, briefs, snapshots, and recommendations unchanged.
- Edits require the current `version`; a stale version returns 409.

### US-C2 — Review and manage committee members

As a committee manager, I can review applications and manually manage the
roster without destroying history.

Acceptance:

- Roster filters are `applied`, `active`, and `inactive`.
- Member detail includes profile fields, contact email, application status,
  timestamps, active-key metadata, participation history, and audit events.
  It never returns `token_hash` or any bearer token already issued.
- Activating an applicant uses the existing pending public key, marks the
  application approved, and returns a new bearer token exactly once. The UI
  presents a copy-and-dismiss panel and cannot retrieve the token later.
- Manual add requires member id, name, public key, and optional profile/contact
  fields. It creates an active member, one active key, and returns a bearer token
  exactly once.
- Deactivate changes the member to `inactive` and deactivates all member keys in
  the same transaction. Existing recommendations and roster snapshots remain.
- Reactivate requires a new public key. It inserts a new active key, keeps old
  keys inactive, returns a new bearer token once, and sets status active.
- Key rotation for an active member likewise requires a new public key and
  atomically revokes old keys before issuing a new token.
- Rejecting an application sets its application status to `rejected`, sets the
  member inactive, and leaves its key inactive.
- `COMMITTEE_ROSTER_CAP` is HARD-ENFORCED on every transition-to-active. The
  production admin API (manual add, activate/approve, reactivate — and the demo
  `registerMember` shortcut) refuses an admission that would exceed the cap with
  a 409, race-safely (a transaction-scoped advisory lock serializes admissions
  so two concurrent activations cannot both slip past the last free seat).
- All writes require the current member `version`; stale writes return 409.

### US-C3 — Schedule and observe a committee session

As a committee manager, I can select a topic and schedule its collection and
publication times.

Acceptance:

- The create form requires an active topic, session date, brief-open timestamp,
  window-close timestamp, publish timestamp, and reason.
- Times are ISO 8601 instants. Validation is
  `briefOpensAt < windowClosesAt < publishAt` and session date equals the UTC date
  of `briefOpensAt`.
- `(date, subject_id)` remains unique.
- Creation inserts the session in `scheduled`, snapshots all currently active
  members into `committee_session_members`, and enqueues four one-off jobs:
  `publish_brief` at brief open, `close_window` at window close, `aggregate` one
  second after close, and `publish` at publish time.
- Each job has `scope_type = 'committee_session'`, `scope_id = session UUID`, and
  dedupe key `committee:<session-id>:<action>`. Repeated creation or enqueue does
  not duplicate jobs.
- Session detail presents the timeline in UTC and browser-local time, linked job
  states, countdown, expected roster, response count, and next legal action.
- Members activated after creation are not automatically added. Before the
  session reaches `collecting`, an admin may explicitly add or excuse a roster
  member. Once collecting starts, the roster is immutable.

### US-C4 — Operate guarded committee transitions

As a committee manager, I can run or recover a session lifecycle without
creating impossible state.

The transition matrix is authoritative:

| From | Action | To | Conditions |
|---|---|---|---|
| `scheduled` | publish brief | `collecting` | topic active; expected roster non-empty; brief is upserted; absolute close time is in the future |
| `scheduled` | cancel | `cancelled` | reason required; pending scoped lifecycle jobs become cancelled |
| `collecting` | close window | `window_closed` | normal schedule or manual early close with reason |
| `window_closed` | reopen | `collecting` | exceptional reason and new future close time required; aggregate/publish jobs are rescheduled |
| `window_closed` | aggregate | `aggregated` | roster snapshot exists; aggregate only accepted verified recommendations |
| `aggregated` | publish | `published` | aggregate and synthesis are present |

All other transitions return 409. Repeating an action already reflected in state
returns 200 with `{ idempotent: true }` only when the target state and associated
artifact already exist; it must not rewrite timestamps or enqueue duplicate jobs.
`published` and `cancelled` are terminal in this phase.

Manual actions enqueue the same worker kind used by scheduled actions and return
202 with a job id. `cancel` and `reopen` add `committee.cancel` and
`committee.reopen_window` worker kinds so every transition remains observable in
the committee lane.

### US-C5 — Inspect member datapoints and aggregation

As a committee manager, I can inspect what every expected member supplied and
how the aggregate was derived.

Acceptance:

- The roster matrix derives one row per `committee_session_members` row and
  reports `expected`, `excused`, `submitted`, or `absent`.
- `submitted` includes recommendation id, stance, confidence, received time,
  verification state, body, memo URL, nonce, signature, and canonical payload.
  Signature and payload are admin-only and rendered in a collapsed disclosure.
- The UI can filter and sort by roster state, stance, confidence, received time,
  and member.
- The aggregate denominator comes from non-excused session roster rows, never
  the current global active-member query.
- The aggregate view shows stance counts, mean confidence, expected/submitted/
  absent counts, consensus, disagreements, actions or weights, and the source
  recommendation ids used.
- No admin endpoint can update `committee_recommendations`.

### US-A3 — Inspect audit history

As an admin, I can determine who or what changed operational state and why.

Acceptance:

- Every admin mutation records actor `admin`, action, target, reason, request id,
  before summary, after summary, outcome, timestamp, and related job/session ids.
- Existing public/member events remain visible (`public:apply` and member
  submission events).
- Audit rows are append-only through the application. No delete/update endpoint
  exists.
- Secrets, token hashes, bearer tokens, signatures, full recommendation bodies,
  and request headers are excluded from audit JSON.

## 5. Database migration

Add one forward migration, `backend/migrations/0017_admin_surface.sql`. It must be
idempotent in the same style as existing migrations and preserve all current
rows.

### 5.1 Queue extensions

Add to `jobs`:

```sql
scope_type     text,
scope_id       text,
requested_by   text,
audit_request_id uuid
```

Add index `(scope_type, scope_id, id DESC)`. Replace the jobs status check so it
also allows `cancelled`. Do not remove the currently allowed `failed` value even
though normal retries use `pending`; existing deployments may contain it.

### 5.2 Research telemetry

Create `analytics_runs`:

```text
id uuid primary key default gen_random_uuid()
job_id bigint references jobs(id) on delete set null
job_kind text not null
attempt int not null
asof date not null
source_mode text not null check (live, hermetic)
tools jsonb not null                         -- JSON array of allowed tool ids
status text not null check (running, succeeded, warning, failed)
current_stage text
code_version text not null default 'unknown'
warning_count int not null default 0
warnings jsonb not null default []
error text
started_at timestamptz not null default now()
finished_at timestamptz
created_by text not null                     -- scheduler or admin
audit_request_id uuid
```

Index `(started_at DESC)`, `(job_id, attempt)`, and `(asof DESC, job_kind)`.
There is no uniqueness constraint on job/attempt because telemetry failure and a
subsequent retry must not block a new trace; list projection selects the latest
trace and flags duplicates.

Create `analytics_stage_runs`:

```text
id bigserial primary key
analytics_run_id uuid references analytics_runs(id) on delete cascade
tool_id text not null
stage text not null check (access, extract, transform, analyze, store, report)
sequence smallint not null
status text not null check (pending, running, succeeded, warning, failed, skipped)
started_at timestamptz
finished_at timestamptz
summary jsonb not null default {}
error text
unique (analytics_run_id, tool_id, stage)
```

Create `analytics_artifacts`:

```text
id bigserial primary key
analytics_run_id uuid references analytics_runs(id) on delete cascade
stage_run_id bigint references analytics_stage_runs(id) on delete cascade
tool_id text not null
kind text not null
artifact_key text not null
checksum text
row_count int
first_date date
last_date date
preview jsonb                            -- maximum 250 points/items
storage_ref jsonb not null default {}    -- allowlisted table/key/date reference
created_at timestamptz not null default now()
```

Index `(analytics_run_id, tool_id)` and `(artifact_key, created_at DESC)`.
Telemetry tables are analytics-owned: migration `0017` must explicitly revoke
worker `INSERT/UPDATE/DELETE` on them. Worker telemetry is written through new
analytics-provider endpoints, never the worker SQL connection.

### 5.3 Committee integrity and scheduling

Add `version int NOT NULL DEFAULT 1` and `updated_at timestamptz NOT NULL DEFAULT
now()` to `committee_members`, `committee_subjects`, and `committee_sessions`.

Add to `committee_sessions`:

```text
brief_opens_at timestamptz
publish_at timestamptz
cancelled_at timestamptz
```

Keep existing `window_closes_at` and `published_at`. Add a state check allowing
the six states in section 2. Validate existing values before validating the
constraint. Add foreign keys from sessions/recommendations/snapshots/briefs to
subjects only after a migration query proves there are no orphan subject ids;
otherwise insert placeholder inactive subjects for the orphan ids first.

Create `committee_session_members`:

```text
session_id uuid references committee_sessions(id) on delete cascade
member_id text references committee_members(id)
member_name text not null
member_lens text
status text not null default 'expected' check (expected, excused)
included_at timestamptz not null default now()
excused_at timestamptz
reason text
primary key (session_id, member_id)
```

Backfill existing sessions from the historical evidence available:

- insert every member that submitted to the session as `expected` using current
  name/lens snapshots;
- for sessions with `committee_recommendation.quorum.active`, add currently
  active members until the recorded active count is reached, ordered by member
  id; and
- if the exact historical roster cannot be reconstructed, retain the row set and
  add an audit event `backfill_session_roster` with `scope.approximate = true`.

Create `committee_session_events`:

```text
id bigserial primary key
session_id uuid references committee_sessions(id) on delete cascade
from_state text
to_state text not null
action text not null
actor text not null
reason text
job_id bigint references jobs(id) on delete set null
at timestamptz not null default now()
```

Index `(session_id, at)`. Backfill one `backfill` event per existing session using
its current state and `generated_at`.

Add checks for member status (`applied`, `active`, `inactive`), subject status
(`active`, `inactive`), and application status (`pending`, `approved`,
`rejected`). Normalize unknown existing values to `inactive`/`rejected` before
validating.

### 5.4 Audit extension

Extend existing `audit_log` without removing `scope`:

```text
request_id uuid default gen_random_uuid()
target_type text
target_id text
reason text
before_state jsonb
after_state jsonb
outcome text not null default 'succeeded'
job_id bigint references jobs(id) on delete set null
session_id uuid references committee_sessions(id) on delete set null
```

Index `(at DESC)`, `(target_type, target_id, at DESC)`, and `request_id`.

## 6. Backend implementation

### 6.1 Boundaries and module placement

- Keep `handleAdmin` as the single `/api/admin/*` dispatcher, but split SQL and
  domain logic into `backend/src/admin/` projections/services so the route does
  not become a monolith.
- Add admin DTOs to `contract/src/admin.d.ts` and routes to
  `contract/src/routes.js`/`routes.d.ts`. Run `scripts/sync-contract.ts` so the
  browser contract copy stays generated from the canonical contract.
- Add committee mutations to `backend/src/committee/domain.ts` or focused
  modules under `backend/src/committee/`; both REST and workers call the same
  functions.
- Add an optional analytics trace observer to `runAnalytics`. The compute path
  must remain usable with a no-op observer in tests and non-worker callers.
- Change `JobHandler` to `(payload, context)`, where context is
  `{ jobId, kind, attempt, workerId }`, and pass it from `processOneJob`. Existing
  non-admin handlers may ignore the second argument.

### 6.2 Analytics telemetry write path

Add analytics-provider-only endpoints alongside existing ingestion routes:

- `POST /api/analytics/runs` — begin a trace;
- `PATCH /api/analytics/runs/:id` — finish/update run status;
- `PUT /api/analytics/runs/:id/stages/:tool/:stage` — idempotently start or
  finish one stage;
- `POST /api/analytics/runs/:id/artifacts` — add bounded artifact metadata.

They use `ANALYTICS_TOKEN`, validate complete payloads before transactions, and
redact/reject forbidden keys matching `token`, `authorization`, `header`,
`cookie`, `secret`, or `password` case-insensitively. Preview payloads larger
than 256 KiB or more than 250 entries return 400.

Telemetry is best-effort with respect to analytics computation: inability to
begin or update telemetry does not prevent canonical analytics persistence. The
handler must include `telemetryWarning` in `job_runs.output`; the admin overview
then flags “completed without trace.” Canonical data failures still fail the job.

Instrument actual code boundaries:

- source selection/floor loading in `analytics/index.ts` emits `access`;
- per-source fetch outcomes in `analytics/extract/sources.ts` and data-source
  adapters emit `extract` summaries;
- alignment and `applyTransform` emit `transform` summaries;
- each pure tool computation emits `analyze`;
- each `AnalyticsPersistence` call emits `store`; and
- after store, the worker fetches the relevant public dashboard route and emits
  `report` verification.

### 6.3 Admin read/write API

All routes below require `X-Admin-Token`. Validate auth before parsing bodies or
querying SQL. List routes accept `limit` default 50/max 200 and opaque cursor;
responses are `{ items, nextCursor }`. Invalid input is 400, unauthenticated is
403 (matching current admin behavior), missing is 404, stale version/illegal
state is 409, accepted queue work is 202, and successful synchronous mutation is
200 or 201.

| Method and route | Purpose |
|---|---|
| `GET /api/admin/overview` | health cards and alert feed |
| `GET /api/admin/jobs` | extend existing list with filters and scope fields |
| `GET /api/admin/jobs/:id` | extend existing detail with domain links |
| `POST /api/admin/jobs/:id/retry` | clone a dead job |
| `GET /api/admin/runs` | retain queue-run feed and add filters |
| `PATCH /api/admin/schedules/:id` | toggle an analytics schedule only |
| `GET /api/admin/research/runs` | analytics-run list |
| `GET /api/admin/research/runs/:id` | stages, artifacts, linked queue runs |
| `GET /api/admin/research/series/:indicator` | allowlisted raw history range |
| `GET /api/admin/research/signals/:key/:date` | stored signal payload |
| `POST /api/admin/research/runs` | enqueue manual rerun |
| `GET /api/admin/committee/overview` | session/member/topic summary |
| `GET/POST /api/admin/committee/subjects` | list/create topics |
| `GET/PATCH /api/admin/committee/subjects/:id` | topic detail/edit |
| `POST /api/admin/committee/subjects/:id/deactivate` | deactivate topic |
| `GET /api/admin/committee/members` | all statuses/applications |
| `GET /api/admin/committee/members/:id` | private admin member projection |
| `POST /api/admin/committee/members` | manual active member add |
| `PATCH /api/admin/committee/members/:id` | profile fields only |
| `POST /api/admin/committee/members/:id/activate` | activate applicant |
| `POST /api/admin/committee/members/:id/deactivate` | deactivate and revoke keys |
| `POST /api/admin/committee/members/:id/reactivate` | new key/token and activate |
| `POST /api/admin/committee/members/:id/rotate-key` | rotate active key/token |
| `POST /api/admin/committee/members/:id/reject` | reject application |
| `GET/POST /api/admin/committee/sessions` | list/create scheduled session |
| `GET /api/admin/committee/sessions/:id` | complete operational session DTO |
| `PATCH /api/admin/committee/sessions/:id/roster` | add/excuse before collecting |
| `POST /api/admin/committee/sessions/:id/actions/:action` | enqueue transition |
| `GET /api/admin/audit` | filtered append-only audit list |

Mutation request and response shapes are fixed as follows. Unknown fields are
rejected with 400 rather than ignored.

```ts
type AdminReason = string; // trimmed, 10..500 characters

type ResearchRerunRequest = {
  kind: "regime.classify" | "research.refresh";
  asof: string; // YYYY-MM-DD
  toolId?: "channel-divergence" | "late-cycle-signals"; // research only
  reason: AdminReason;
};

type TopicWriteRequest = {
  version?: number; // absent on create, required on edit/deactivate
  id?: string; // required on create, forbidden on edit
  name: string;
  status?: "active" | "inactive"; // create defaults active
  operator: string;
  homepage?: string | null;
  xHandle?: string | null;
  thesisBlurb: string;
  wallets: Array<{ address: string; chain: string; label?: string }>;
  nftContracts: Array<{ address: string; chain: string; label?: string }>;
  source: { type: "rpc" | "manual" | "vault_tvl" | "framework" };
  recommendationType: "position_actions" | "bucket_weights";
  linkedMemberId?: string | null;
  structuralNotes: string[];
  lastReviewed?: string | null; // YYYY-MM-DD
  reason: AdminReason;
};

type MemberProfileWrite = {
  version: number; // profile edit only
  name: string;
  tagline?: string | null;
  lens?: string | null;
  mandate?: string | null;
  biases?: unknown;
  voiceMd?: string | null;
  mode?: string | null;
  operator?: string | null;
  avatar?: unknown;
  contactEmail?: string | null;
  reason: AdminReason;
};

type ManualMemberCreateRequest = Omit<MemberProfileWrite, "version"> & {
  memberId: string;
  publicKey: string;
};

type MemberStatusRequest = {
  version: number;
  publicKey?: string; // required for reactivate and rotate-key; forbidden otherwise
  reason: AdminReason;
};

type SessionCreateRequest = {
  subjectId: string;
  date: string; // YYYY-MM-DD
  briefOpensAt: string; // ISO instant
  windowClosesAt: string; // ISO instant
  publishAt: string; // ISO instant
  reason: AdminReason;
};

type RosterPatchRequest = {
  version: number;
  operation: "add" | "excuse" | "restore";
  memberId: string;
  reason: AdminReason;
};

type SessionActionRequest = {
  version: number;
  reason?: AdminReason; // required for cancel, early close, reopen, manual retry
  windowClosesAt?: string; // required for reopen
};

type TopicDeactivateRequest = { version: number; reason: AdminReason };
type DeadJobRetryRequest = { reason: AdminReason };
type ScheduleToggleRequest = { enabled: boolean; reason: AdminReason };
```

Create responses are `{ item, auditRequestId }` with status 201. Synchronous
updates are `{ item, auditRequestId }`. A response that reveals a newly issued
member credential additionally contains `credential: { token }`; that property
is produced only by create/activate/reactivate/rotate and is never persisted in
an API response table. Enqueued operations return
`{ jobId, auditRequestId, existing: boolean }` with status 202. A 409 response is
`{ error, code: "stale_version" | "invalid_transition" | "duplicate", current? }`.

For a manual lifecycle action, first locate the scoped job with the canonical
dedupe key. If it is pending, atomically move `run_after` to `now()` and return
that job with `existing: true`. If it is running, return it unchanged with
`existing: true`. If it is terminal or absent, enqueue a recovery job with
dedupe key `committee:<session-id>:<action>:manual:<audit-request-id>`. This is
how “run now” coexists with the four jobs created at scheduling time.

Reopen atomically changes the session to `collecting`, sets the new close time,
marks any pending canonical aggregate/publish jobs `cancelled`, and creates new
close/aggregate/publish jobs suffixed with the reopen event id. Cancel atomically
changes the session to `cancelled` and marks all pending scoped jobs cancelled.
Neither operation touches running or terminal queue rows.

The generic existing `/api/committee/admin/:action` endpoints remain for demo
compatibility but the new browser must not call them. Mark `reset` and
`subject_fixtures` dev/demo-only and return 403 for them when `RM_ENV=prod`.

### 6.4 Required domain corrections

Before wiring UI controls, correct these current behaviors:

- `openSession` must not reset an existing non-scheduled session to `scheduled`.
  On conflict return the existing row idempotently only when it is already
  scheduled; otherwise return 409.
- `publishBrief` must require `scheduled`, a real active subject, a non-empty
  roster snapshot, and an absolute future close timestamp.
- Brief regime data and research signals must be the latest rows at or before the
  session date; do not require an exact signal date and do not read future data.
- `closeWindow` must detect a zero-row guarded update and return 409 instead of
  reporting a transition that did not occur.
- `aggregateSession` must require `window_closed`, read expected members from
  `committee_session_members`, and use the latest subject snapshot at or before
  the session date.
- `publishSession` must require `aggregated` and non-null recommendation and
  synthesis.
- `submitRecommendation` must require an `expected` roster row for the member.
- `registerMember` and `resetSessions` remain demo helpers and are not used for
  production admin workflows.
- Every transition writes `committee_session_events` and `audit_log` in the same
  transaction as the state update.

## 7. Frontend implementation

### 7.1 Routing and structure

Use one admin shell for:

- `/admin`
- `/admin/research`
- `/admin/research/runs/:id`
- `/admin/queue`
- `/admin/committee`
- `/admin/committee/subjects/:id`
- `/admin/committee/members/:id`
- `/admin/committee/sessions/:id`
- `/admin/audit`

Update `frontend/public/assets/js/app/routes.js` so every `/admin` subpath maps to
`/views/admin.html`; otherwise the current catch-all will request nonexistent
view fragments. The shell reads `location.pathname`, uses `history.pushState`,
and listens for `popstate`. It remains absent from public navigation.

Replace `adminJobsView` with one `adminSurfaceView` Alpine factory and move
section-specific fetch/state helpers into modules under
`alpine/views/admin/`. Register the factory at boot in `alpine/views.js`; inline
scripts in the injected HTML fragment will not execute.

### 7.2 Common UI behavior

- Persistent left/top admin navigation, page title, last-refreshed timestamp,
  refresh, pause polling, and sign out.
- Poll overview/active records every five seconds only while `document.hidden`
  is false. Lists and historical detail do not continuously poll.
- Preserve list filters in query parameters and record selection in the path.
- Every empty, loading, error, stale, and unauthorized state has visible text.
- Show UTC first for committee schedules, with browser-local time secondary.
- Render JSON in collapsed, copyable `<pre>` blocks. Never inject payload HTML.
- Mutation buttons disable while pending. Success links to the created job or
  record; errors remain beside the form.
- Confirmation dialogs name the target, explain historical impact, and require
  the reason before enabling destructive/exceptional actions.
- Token reveal is a one-time modal with copy and acknowledgement. Clearing or
  navigating away destroys the plaintext value from Alpine state.

## 8. Verification

### 8.1 Backend/database tests

Add tests proving:

- every new admin route rejects a missing/wrong token before SQL;
- telemetry endpoints reject admin/member credentials and accept only the
  analytics-provider bearer;
- worker-role SQL writes to all three telemetry tables are denied;
- migration backfills existing sessions and does not orphan historical data;
- topic validation, uniqueness, optimistic concurrency, and deactivation;
- member activate/manual-add/deactivate/reactivate/rotate/reject transactions,
  including one-time token behavior and key revocation;
- session creation snapshots the roster and creates exactly four deduped jobs;
- each legal state transition, every illegal transition, idempotent repeats,
  cancel, and reopen;
- member changes after session creation do not alter historical quorum;
- submissions from members outside the session roster are rejected;
- aggregation uses the roster snapshot and at-or-before data only;
- analytics run/stage/artifact recording, redaction, preview limits, and missing
  telemetry warning behavior;
- dead-job retry clones rather than mutates; and
- schedule PATCH cannot modify cron/kind/payload or enable committee demo rows.

### 8.2 Browser tests

Expand `frontend/test/browser/admin-view.spec.ts` into focused cases for:

- login, persisted tab session, 403 logout, navigation, and browser back/forward;
- overview alerts and polling pause;
- research list filters, stage timeline, artifact preview, raw-series navigation,
  and rerun confirmation;
- queue filters, job detail, dead-job retry, and schedule toggle;
- topic create/edit/deactivate validation;
- member application activation, manual add, one-time token modal,
  deactivation, and participation history;
- session create, UTC/local schedule, roster snapshot, transition controls,
  invalid-action disabled states, and linked jobs;
- recommendation matrix, signature/payload disclosure, aggregate derivation,
  and absences; and
- audit filters and redaction.

Use mocked API fixtures for browser rendering and backend integration tests for
domain correctness. Do not place real admin, analytics, or member credentials in
fixtures or snapshots.

### 8.3 Required repository checks

Run at minimum:

```text
bun run test                      # scripts/tests/ — recurses into unit/ AND integration/
(cd contract && bun run test)
(cd backend && bun run test)
bunx playwright test frontend/test/browser/admin-view.spec.ts
bun run check-contract
bun run typecheck
bash scripts/checks/check-eval-keyless.sh
bash scripts/checks/check-no-test-imports-in-runtime.sh
```

`bun run test:unit` / `bun run test:integration` select one cost class each (§3
L1) — useful while iterating, but the aggregate above is what "at minimum"
means: skipping the integration class locally only defers its failure to CI,
which runs both.

Also run the repository’s analytics boundary, worker-role, committee lifecycle,
and frontend route guard tests touched by these changes.

## 9. Delivery order

Implement in this order so every phase leaves a usable product:

1. migration `0017`, constraints, roster/session-event backfill, and audit helper;
2. guarded committee domain transitions and roster-based aggregation;
3. admin DTOs/routes and queue scope/retry/schedule services;
4. analytics telemetry tables, authenticated write client, observer, and stage
   instrumentation;
5. admin shell, routing, overview, queue, and research read-only views;
6. topic, member, roster, scheduling, and lifecycle mutation UI;
7. audit UI, all browser tests, integration tests, and documentation updates.

The first production deployment must run the migration before API or worker code
that writes the new columns/tables. API can be deployed next, workers after the
analytics telemetry endpoints exist, and the frontend last.

## 10. Definition of done

The phase is done when all user stories in section 4 pass, no existing public
committee/research route regresses, production admin and telemetry routes fail
closed, a research job can be traced through all six stages, and a committee
manager can create a topic, manage members, schedule a roster-snapshotted
session, inspect every accepted member datapoint, operate guarded lifecycle
transitions, and explain every mutation from the audit log.

---

## Network topology — DNS, origins & vendors

How `robotmoney.net` presents several independent product surfaces as one
seamless site, organized by a clean **separation of concerns** — both across
infrastructure tiers and across **two vendors**. This document is cross-cutting:
it spans the **marketing** site, **this repo** (Investment Committee + analytics),
and the **on-chain dapp** (`robotmoney-core`). It is a companion to
the rest of this document (this frontend's internals) and
[decisions.md](./decisions.md); the production topology here is decision **D13**,
which supersedes the single-box parts of D8/D11 (see [§10](#10-relationship-to-existing-decisions)).
**D21** retires D18's fourth subdomain, `mcp.` — REST is the only surface
members use (see [§10](#10-relationship-to-existing-decisions)).

```mermaid
flowchart LR
    subgraph Users["Users"]
        Visitors["Web Visitors"]
        Members["Committee Members<br/>(REST API clients via the<br/>committee-onboarding skill)"]
    end

    subgraph Frontend["Frontend"]
        Static["Static Assets<br/>HTML + Alpine.js + CSS<br/>p5.js + Chart.js"]
        API["API Server<br/>Bun.serve — routes, auth,<br/>committee domain"]
    end

    subgraph Backend["Backend"]
        Worker["Task Queue<br/>& Analytics Pipeline"]
        DB["Data<br/>Postgres"]
    end

    subgraph External["External Data Sources"]
        direction LR
        Sources1["DefiLlama"]
        Sources2["CoinMetrics"]
        Sources3["Yahoo Finance"]
        Sources4["FRED"]
    end

    Visitors -->|browser| Static
    Static -->|HTTP JSON| API
    Members -->|HTTP JSON| API
    API <--> DB
    Worker <--> DB
    Worker -.->|fetch raw series| External

    style Users fill:#7c3aed1a,stroke:#7c3aed,stroke-width:2px
    style Frontend fill:#2563eb1a,stroke:#2563eb,stroke-width:2px
    style Backend fill:#0596691a,stroke:#059669,stroke-width:2px
    style External fill:#dc26261a,stroke:#dc2626,stroke-width:2px
```

---

## 1. Principle — two separations of concern

**By tier.** Three surfaces with different lifecycles and infra, deployed
independently:

- **Static tier** — asset delivery. No runtime dependency on anything else; serves
  even when the API and data tiers are down (**fail-open**).
- **API tier** — request/response compute. Stateless services.
- **Data tier** — durable state. One high-availability database.

**By vendor.** Each vendor owns one job, and **no routing software runs anywhere**:

- **Cloudflare — DNS + observability.** Authoritative DNS, proxied TLS/DDoS, and
  monitoring (Health Checks, analytics, Logpush). This is *configuration, not code*
  — no Worker, no reverse proxy.
- **DigitalOcean — compute + storage.** Droplets, Spaces (+CDN), and Managed
  Postgres.

Because Cloudflare runs no routing code and DigitalOcean has no managed
path-router, surfaces are addressed by **subdomain** (host-based routing via plain
DNS), not by path prefix. The seamless look is carried by the **shared design
layer** (ARCHITECTURE §4), not by a shared origin.

---

## 2. The vendor split

| Vendor | Owns | Form |
|--------|------|------|
| **Cloudflare** | DNS, TLS, DDoS, **observability** (Health Checks, analytics, Logpush) | Configuration only — **no software** |
| **DigitalOcean** | **Compute** (Droplets), **storage** (Spaces + CDN), **data** (Managed Postgres HA) | The running system |

**Rule of thumb: Cloudflare resolves and watches; DigitalOcean runs and stores.**
All deployable software lives on DigitalOcean.

---

## 3. The surfaces — subdomain map

Each surface is its own hostname, resolved by a plain DNS record:

| Hostname | Surface | Tier → home | Source |
|----------|---------|-------------|--------|
| `robotmoney.net`, `www.` | Marketing | Static → **DO Spaces CDN** | marketing UI (this repo, D1) |
| `committee.robotmoney.net` | IC + analytics (REST — the only member surface, D21) | API → **DO droplet** (Bun) + Data → **Postgres HA** | `robotmoney-frontend` (this repo) |
| `app.robotmoney.net` | Dapp | API → **DO droplet** (`rmpc` + gateway) | `robotmoney-core` |

Each app is served at **its own root**, so there is **no path-prefix and no
base-path handling** — the SPA history router (D4) and import maps (D2) work
unmodified. The SPA and its API are **same-origin** on the same subdomain (no CORS
within a surface).

> **D21.** The MCP server previously had its own subdomain and port here
> (`mcp.`, port `8443` — D18). D21 retired the MCP transport; members now use
> `committee.`'s REST API like every other client, so the fourth subdomain and
> its §3.1 provisioning (Cloudflare alternate port, `MCP_PORT`, firewall rule)
> no longer apply. Actually decommissioning the DNS record, firewall rule, and
> `mcp` container is tracked as D21's follow-up implementation work.

---

## 4. DNS & TLS — how each hostname resolves

- **Marketing** (`robotmoney.net` via CNAME-flattening, and `www`) → a **DNS-only**
  (grey-cloud) CNAME to the **DO Spaces CDN endpoint**. This is the CDN's native
  host-based usage: DO delivers, caches, and terminates TLS with its **custom-domain
  certificate**. Cloudflare does *not* sit in the data path here, so there is **no
  double-CDN** (§7).
- **App subdomains** (`committee.`, `app.`) → **proxied** (orange-cloud) records to
  the droplet. Cloudflare presents its edge certificate to users and provides
  TLS/DDoS plus traffic analytics; the droplet serves a **Cloudflare Origin CA
  certificate** to the proxy. The droplet's **DO Cloud Firewall** allows ingress
  only from Cloudflare's IP ranges.
- **(Optional hardening)** a **Cloudflare Tunnel** can replace the proxied-DNS +
  firewall approach for *zero* public ingress, at the cost of running the
  `cloudflared` connector on the droplet. Default is proxied DNS + firewall (no
  connector to run).

---

## 5. Static tier — marketing (DO Spaces CDN)

The static marketing assets (the marketing UI preserved per D1) are uploaded to a
**DigitalOcean Space with its CDN enabled**, served on the apex/`www` hostname.
The tier has **no runtime dependency on the API or data tiers** — it is pure static
— so when a droplet or Postgres is unavailable, marketing **still serves
(fail-open)**. Any dynamic data a marketing page wants is fetched client-side and
must **degrade gracefully**; the page never hard-depends on the API.

---

## 6. API tier — services on DO droplets

Request/response services run on **DigitalOcean Droplets**, one surface per
subdomain:

- **`committee.`** — this repo's Bun `api` + `worker`; the `api` co-serves this
  surface's SPA assets (`STATIC_DIR`) same-origin at the subdomain root.
- **`app.`** — the `rmpc` daemon + on-chain gateway (`robotmoney-core`).

Ingress is Cloudflare-proxied DNS locked to Cloudflare IPs by a DO Cloud Firewall
(§4). Droplets are used because Cloudflare has no always-on instance and the `rmpc`
daemon must stay synced to chain head — a scale-to-zero model is wrong for it.

---

## 7. Data tier — Postgres HA cluster (DO)

Durable state is a **DigitalOcean Managed Postgres high-availability cluster**:
primary + standby with automated failover, daily backups, and point-in-time
recovery. Only the API tier connects, via `DATABASE_URL`. This refines D8's
production mode (one Postgres) to a managed HA cluster; the single-box Dockerized
Postgres remains the CI and demo mode (D8).

---

## 8. No double-CDN

Marketing's CDN is **DO Spaces CDN**, reached **DNS-only** (§4), so Cloudflare adds
no second cache in front of it — one cache, one invalidation path (purge is a DO
operation). The proxied app subdomains are dynamic; Cloudflare passes them through.

---

## 9. Seamless without a single origin, and observability

**Seamless look** does not require one origin — it comes from the shared design
layer (`tokens.css` + shared nav/footer chrome; ARCHITECTURE §4), identical on
every subdomain. Shared login/session works by setting cookies on
`.robotmoney.net`. Cross-surface API calls (rare — each surface mostly calls its
own same-host API) use CORS.

**Observability** is Cloudflare's second job, complemented by DO:

- **Cloudflare** — **Health Checks** probe each surface's `/health`; traffic +
  security **analytics** and **Logpush** per hostname.
- **DigitalOcean** — droplet **Monitoring/alerts**, **Uptime** checks, and Managed
  Postgres metrics (replication lag, failover, connections).
- **`/health` JSON contract** (the keystone) — every surface returns the same shape
  and checks its own deps: marketing trivially `200`; IC = Postgres; dapp =
  `rmpc` alive + gateway + RPC reachable + chain-head lag below threshold.
- **Fail-open** keeps a single failed tier from cascading; the static marketing
  tier in particular stays up independently.

---

## 10. Relationship to existing decisions

- **D13 (vendor-split tiered topology)** — **surface list refined by D18, then
  D18 superseded by D21:** MCP (`mcp.`) was documented as a fourth
  subdomain-routed surface (D18); D21 retired the MCP transport entirely, so
  the surface map is back to three subdomains — `committee.` serves REST to
  every client, member and browser alike.
- **D11 (single box, no reverse proxy)** — **superseded for production by D13.**
  Production splits across subdomains on DO with Cloudflare for DNS+observability;
  there is still **no reverse proxy** (host-based DNS routing, not a proxy). The
  single-box `docker-compose` remains the **CI and demo** deployment.
- **D8 (one Postgres in Docker)** — **prod mode refined by D13:** production is a
  **DO Managed Postgres HA cluster**; ephemeral (CI) and demo modes unchanged.
- **D10 (split-ready repos)** — reinforced: each surface is already an independent
  host, so a repo split stays mechanical.
- **D4 (SPA history router)** — works **unmodified at the subdomain root**; the
  earlier path-prefix/base-path concern is gone.
- **D2 (buildless)** — import maps resolve at the root, no base-path rewriting.

---

## 11. Task queue topology

The Postgres-backed task queue replaces the old GitHub Actions cron. Three
concurrent loops run inside the `worker` process:

```mermaid
flowchart TB
    subgraph Scheduler["Scheduler<br/>runs every 30s"]
        SC["Reads job_schedules<br/>FOR UPDATE SKIP LOCKED"]
        SC -->|"INSERT job per missed slot<br/>ON CONFLICT (dedupe_key)"| Jobs
    end

    subgraph Jobs["Jobs (Postgres)"]
        direction LR
        Pending["pending"]
        Running["running"]
        Done["succeeded / failed / dead"]
    end

    subgraph DrainLoop["Drain Loop<br/>polls every 2s"]
        DC["Claims 1 pending job<br/>FOR UPDATE SKIP LOCKED"]
        DC -->|dispatch by kind| Handler["Registered Handler"]
        Handler -->|success| Succeed["→ succeeded"]
        Handler -->|failure| Retry["→ failed → pending<br/>(exponential backoff)"]
        Handler -->|exhausted| Kill["→ dead"]
    end

    subgraph Reaper["Reaper<br/>runs every 60s"]
        RP["Reclaims jobs stuck<br/>in 'running' > 5 min"]
        RP -->|"attempts < max"| Pending
        RP -->|"attempts ≥ max"| Done
    end

    subgraph Handlers["Registered Handlers"]
        H1["regime.classify daily 22:30 UTC<br/>research.refresh daily 23:00 UTC<br/>(distinct kinds, own lanes)"]
        H2["committee.*<br/>session lifecycle<br/>(open → brief → close →<br/>aggregate → publish)"]
    end

    Pending -->|"claimed"| Running
    Running -->|"handled"| Done

    DrainLoop --> Handlers
    Succeed --> Done
    Retry --> Pending
    Kill --> Done

    style Scheduler fill:#1e3a5f33,stroke:#1e3a5f,stroke-width:2px
    style Jobs fill:#064e3b33,stroke:#059669,stroke-width:2px
    style DrainLoop fill:#3b076433,stroke:#7c3aed,stroke-width:2px
    style Reaper fill:#78350f33,stroke:#d97706,stroke-width:2px
    style Handlers fill:#1e1b4b33,stroke:#4338ca,stroke-width:2px
```

## 12. Analytics pipeline — research & report jobs

The analytics suite runs as two scheduled jobs with distinct kinds and lanes
(issue #107): `regime.classify` (daily 22:30 UTC, analytics lane) and
`research.refresh` (daily 23:00 UTC, research lane).
It drives three compute pipelines through a shared 6-stage access → extract →
transform → analyze → store → report flow:

```mermaid
flowchart TB
    subgraph Sources["Data Sources"]
        FRED["FRED — macro indicators"]
        Yahoo["Yahoo Finance — prices, indices"]
        DefiLlama["DefiLlama — TVL, stablecoins"]
        Other["Other — blockchain.com,<br/>Coinmetrics, EDGAR, Shiller"]
    end

    subgraph Extract["Extract"]
        E1["26 registry indicators<br/>for regime classifier"]
        E2["Research inputs:<br/>BTC, QQQ, SPY, RSP, TOP7,<br/>M&A, margin, confidence"]
    end

    subgraph Transform["Transform"]
        T["buildDateAxis → alignDailyForwardFill<br/>→ applyTransform → mergeSeries"]
    end

    subgraph Analyze["Analyze"]
        R["Regime Classifier<br/>per-indicator percentile →<br/>inverse-correlation weighted<br/>→ composite regime label"]
        C["Channel Divergence<br/>BTC beta + BTC/QQQ ratio +<br/>stablecoin flow → channel gauge"]
        L["Late-Cycle Signals<br/>concentration + M&A +<br/>margin debt + confidence<br/>→ cycle saturation gauge"]
    end

    subgraph Store["Store"]
        S1["raw_indicator_history"]
        S2["regime_snapshots<br/>+ regime_indicators"]
        S3["research_signals"]
    end

    subgraph Report["Report → API"]
        P1["GET /api/dashboards/<br/>regime-snapshots"]
        P2["GET /api/dashboards/<br/>research-signals/:key"]
    end

    Sources --> Extract
    Extract --> Transform
    Transform --> Analyze
    R --> S1
    R --> S2
    C --> S3
    L --> S3
    S2 --> P1
    S3 --> P2

    style Sources fill:#5a2d0c33,stroke:#dd6b20,stroke-width:2px
    style Extract fill:#1e3a5f33,stroke:#1e3a5f,stroke-width:2px
    style Transform fill:#1e3a5f33,stroke:#1e3a5f,stroke-width:2px
    style Analyze fill:#3b076433,stroke:#7c3aed,stroke-width:2px
    style Store fill:#064e3b33,stroke:#059669,stroke-width:2px
    style Report fill:#064e3b33,stroke:#059669,stroke-width:2px
```

---

## Documentation map

The `docs/` directory holds the repository's durable technical documentation.
The GitHub Plan issue is the canonical execution queue; do not add mutable
roadmaps, task checklists, or phase ordering to `docs/`.

## Canonical documents

These documents describe current product and system commitments:

- Architecture (this document) — system boundaries, runtime components,
  data flows, and deployment shape.
- [Decisions](./decisions.md) — accepted architecture decision records (ADRs).
- [Deployment](./runbooks/deployment.md) — GitOps environments, credentials, and
  operational setup.
- The demo, live-data, admin-surface, and topology specifications are
  incorporated in this document under their dedicated sections above. (The
  former preview-server spec was retired by decision D19 — preview mode is
  now described in §4 "Preview mode (goldens-backed, no backend)".)
- [Credential doctor](./runbooks/credential-doctor.md)

## Reviews and investigations

Point-in-time review artifacts live under [`code-review/`](./code-review/).
Resolved debugging notes live under [`archive/`](./archive/), with their
original dates and findings preserved. Archived material is evidence, not a
statement of current behavior; update the canonical document when a finding
changes a system commitment.
