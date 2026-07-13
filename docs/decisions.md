# Decisions

The significant architecture decisions for this rebuild, with the reasoning and
the alternatives that were rejected. Newest decisions can supersede older ones;
each entry stands on its own. See [architecture.md](./architecture.md) for how the
pieces fit together.

---

## D1 — Clean rewrite, drop React/Next.js

**Decision.** Rebuild robotmoney.net from scratch rather than refactor the
existing Next.js 16 / React 19 app.

**Why.** The old site had accreted many surfaces and a fragmented data layer
(committed CSV/JSON via 16 GitHub Actions crons, Upstash Redis, GitHub-as-DB). We
want a lean foundation and only two feature areas carried forward.

**Scope.** Preserve the marketing UI; cherry-pick the **regime/research** views
(the regime classifier + its regime-family research signals) and the **Investment
Committee**. Out of scope: allocation / vault / wallet dashboards, generative-art
visualizations, blog/media, other editorial pages. **Superseded in part by D15
and D16**: the `/allocation` page's vault-economics slice (TVL, share price,
adapters, 7-day APY) and the prop-wallet valuation feed (live holdings +
history) are each brought into scope with a live Base RPC pipeline; buyback
stays out of scope.

---

## D2 — Buildless: no ahead-of-time transpile/compile/bundle

**Decision.** The browser does all the work at runtime; only evergreen browsers
are supported. No bundler, JSX, SFC compilation, TypeScript build, or Tailwind
compile.

**Allowed.** `<script type="module">`, import maps, prebuilt CDN library files,
and Bun's runtime TypeScript execution on the backend (no build artifact).

**Why.** Maximum simplicity and longevity; the source you write is the source that
runs. Eliminates build tooling and its maintenance.

---

## D3 — Alpine.js as the interactivity layer (not React/Lit/etc.)

**Decision.** Use **Alpine.js**, loaded as a single classic CDN `<script>`, for
all reactivity and binding, on plain HTML.

**Why.** HTML-first: markup stays as HTML and Alpine sprinkles behavior via
attributes (`x-data`, `x-for`, `@click`). No build, browser-native, mature.

**Alternatives rejected.**
- **Lit** — a real component engine and buildless-capable, but its model is "JS
  that emits HTML" (`html\`…\`` template literals). We want to author HTML directly.
- **dagger.js** — closest to the buildless ideal philosophically, but v0.9,
  single-maintainer; too immature to anchor a production site.
- **Vue/petite-vue** — viable, but Alpine fits the "HTML + sprinkles" shape best.
- **React/Preact** — require a build/JSX; ruled out by D1/D2.

---

## D4 — Single-page app (SPA), not multi-page (MPA)

**Decision.** One shell (`index.html`) + a small client-side history-API router;
routes map to HTML partial files under `frontend/public/views/` fetched into
`<main>`.

**Why.** Cleanly removes cross-page duplication of the nav/footer (rendered once
in the shell). The usual SPA downsides don't apply here:
- **SEO** — modern crawlers (Googlebot) execute JS and index client-rendered
  content, so indexing is a wash.
- **Social link previews** — these *would* favor MPA (unfurlers don't run JS), but
  per-link previews are not needed for this project.

**Alternatives rejected.** Static MPA (one HTML file per route) — would give
per-route social previews and instant first paint, but reintroduces shared-chrome
duplication; not worth it given previews don't matter here.

---

## D5 — No Web Components

**Decision.** Forbidden. No custom elements / `<template>`-based components.

**Why.** Their only real benefit here was reusing the nav/footer across pages —
which the SPA shell (D4) already solves by rendering chrome once. Lifecycle needs
(e.g. tearing down the hero's p5 sketch on view change) are handled by Alpine's
`init()` / `destroy()`. Removing them keeps one composition model (HTML + Alpine).

---

## D6 — Hand-written CSS, drop Tailwind

**Decision.** Author our own CSS (`tokens.css`, `design-system.css`,
`components.css`); no Tailwind.

**Why.** Tailwind needs a compile step to generate utility CSS, which violates D2.
The original `globals.css` design system (tokens, keyframes, utilities like
`text-gradient`/`glow`/`grid-pattern`/`prose-rm`) ports over verbatim; the only new
work is replacing utility-class soup with semantic classes during the markup port.

**Alternatives rejected.** Tailwind browser CDN (dev-only, FOUC, runtime cost);
one-shot Tailwind compile (adds a CSS build step).

---

## D7 — Libraries as plain CDN files (not a transpiling CDN)

**Decision.** Load Alpine, chart.js (+ datalabels), and p5 as **prebuilt files
from jsDelivr** (classic `<script>` globals / UMD).

**Why.** They run as-is in the browser; no transpiling service (e.g. esm.sh) and
no import map are needed. Keeps the runtime dependency to plain static files.

---

## D8 — One Postgres, run in Docker (not Supabase)

> **Prod mode refined by D13:** production is a DigitalOcean Managed Postgres HA
> cluster; the ephemeral (CI) and demo (Docker) modes are unchanged.

**Decision.** Consolidate comments (was Upstash), committee (was GitHub-as-DB),
and dashboard data (was committed CSV/JSON) into a single self-hosted Postgres in
Docker. Mode is chosen by `DATABASE_URL` + volume: ephemeral (CI), demo
(persistent volume), prod (external/managed URL).

**Why.** One datastore, owned by the backend, portable across environments. Self-
hosted fits the single-box deployment (D11). Supabase was rejected to avoid a
third-party platform dependency and to keep the analytics backend self-contained.

---

## D9 — Custom Postgres-backed task queue (not GitHub Actions cron / pg_cron)

**Decision.** Rebuild the data pipeline as `jobs` / `job_schedules` / `job_runs`
tables plus a worker (claim loop with `FOR UPDATE SKIP LOCKED`, scheduler with
dedupe-key exactly-once enqueue, reaper for crashed jobs).

**Why.** Durable, observable, idempotent (upsert on natural keys), and concurrency-
safe — owned by us, portable, not tied to GitHub or a Postgres extension.

---

## D10 — Split-ready `frontend/` + `backend/` + `contract/`

**Decision.** Three top-level dirs in one repo now; designed to split into two
repos later (`git filter-repo`) with no source edits. The only coupling is the
HTTP API + the `contract` package (route paths + DTO types). Frontend is HTTP-only.

**Why.** Clean separation of the frontend from the analytics backend, with a
single versioned seam (the contract) that makes the eventual split mechanical.

---

## D11 — Single box, no reverse proxy

> **Superseded for production by D13** (vendor-split tiered topology: Cloudflare
> DNS+observability, DO compute+storage, surfaces on subdomains). The single-box
> `docker-compose` remains the **CI and demo** deployment; same-origin/no-CORS is
> preserved *within* each surface because the Bun `api` co-serves its SPA assets at
> the subdomain root.

**Decision.** Deploy on one box (e.g. a DigitalOcean droplet). The Bun `api`
process serves both the JSON API and the static frontend (`STATIC_DIR`).

**Why.** Same origin → no CORS, nothing to run in front of the app. No
Caddy/nginx, no third-party hosting platform. TLS, if wanted, is terminated on the
box however preferred.

---

## D12 — Bun for the backend (not Node + a framework)

**Decision.** Run the backend on **Bun** with `Bun.serve` — no HTTP framework. Bun
executes the TypeScript sources directly; static files are served via `Bun.file`.

**Why.** Bun runs `.ts` with no build (satisfies D2), and `Bun.serve` covers both
API routing and static serving on its own, so a framework (Hono) and a separate
static server are unnecessary. Fewer dependencies, one runtime.

---

## D13 — Vendor-split tiered topology: Cloudflare (DNS+observability) + DO (compute+storage), surfaces on subdomains

**Decision.** For **production**, deploy `robotmoney.net` with a clean separation
of concerns across both **tiers** and **vendors**, with **no routing software
anywhere**. The full map is [topology.md](./topology.md):

- **Cloudflare — DNS + observability only.** Authoritative DNS, proxied TLS/DDoS,
  and monitoring (Health Checks, analytics, Logpush). Configuration, not code — no
  Worker, no proxy.
- **DigitalOcean — compute + storage.** Droplets, Spaces (+CDN), Managed Postgres.
- **Surfaces on subdomains** (host-based DNS routing, since there is no routing
  software): marketing on the apex/`www` → **DO Spaces CDN** (DNS-only, native
  host-based CDN use, fail-open); `committee.robotmoney.net` → **DO droplet** (Bun
  `api`+`worker`); `app.robotmoney.net` → **DO droplet** (`rmpc`+gateway). App
  subdomains are Cloudflare-proxied with a DO Cloud Firewall limited to Cloudflare
  IPs (a Tunnel is optional hardening).
- **Data** — a **DO Managed Postgres HA cluster** (primary+standby failover,
  backups, PITR).

**Why.** Two preferences drive this: (1) keep **all deployable software on one
vendor** (DO), with Cloudflare reduced to DNS + observability — so no Worker or
proxy to maintain on a second vendor; (2) keep the three surfaces independent in
lifecycle and failure domain. Subdomains satisfy both: host-based DNS needs no
routing code, and it makes marketing→DO-CDN a natural host-based CNAME (no
double-CDN, no proxy hop). The seamless look is carried by the shared design layer
(D4-adjacent), not by a single origin; shared cookies use `.robotmoney.net`.

**Relationship.** Supersedes D11 for production (surfaces are now separate hosts on
DO; same-origin/no-CORS is preserved *within* a surface because the Bun `api`
co-serves its SPA assets at the subdomain root — and there is still no reverse
proxy). Refines D8's prod mode to a managed HA cluster. The single-box
`docker-compose` (D8/D11) remains the CI and demo deployment.

**Alternatives rejected.**
- **Cloudflare Worker doing path-prefix routing** (single origin) — real software
  (wrangler, CI deploy, logic) on a *second* vendor; rejected to keep all software
  on DO.
- **A reverse proxy (Caddy/nginx) on a DO droplet** (single origin, all software on
  DO) — viable, but adds a component to run and a single ingress point; not worth it
  versus subdomains given the seamless look comes from the design layer.
- **All-Cloudflare compute** (Workers/Containers) — no always-on instance for the
  chain-synced `rmpc` daemon and no managed Postgres; scale-to-zero is wrong for it.
- **Cloudflare caching marketing** — would double-CDN in front of the DO Spaces CDN;
  marketing is reached DNS-only so DO owns its delivery.
- **Keeping the single box for prod** — no isolation between failure domains, no DB HA.

---

## D14 — Preview mode (goldens-backed) over the baked "frozen" single file

**Decision.** For no-backend development of the marketing surface, serve the live
`frontend/public` SPA over HTTP and mock `/api/*` from a committed goldens file
(`goldens/api-goldens.json`), via `bun run preview`. Remove the deprecated
single-file `file://` "frozen" distribution (the `scripts/bake-frozen.ts` +
`scripts/lib/frozen-*` bake, `frozen-boot.js` fetch/history shim, the
self-contained guard, and the `frozen-publish` artifact workflow).

**Why.** A static page should not need to be pre-baked into a monolith with a
`fetch`/`history` monkeypatch — that machinery existed only to satisfy the
`file://` double-click case. The real audience is a **Claude-assisted contributor
with a git checkout**, who has the agent start a thin server, edit files, and open
a PR — so a hosted URL and a `file://` bundle are both unnecessary. Mocking `/api/*`
from one goldens file keeps the SPA byte-for-byte the source (no app changes) and
makes edits show on refresh.

**Correctness.** Goldens are **captured from a real running system** (a deployed
test cluster or `bun run demo`), not hand-written and not derived from other
fixtures — so **field shapes** stay faithful; values are point-in-time. Keeping
them correct is the **change author's responsibility** (no nightly regeneration);
a CI drift gate blocks a PR whose goldens no longer match the code. The most
important check is that the **fields** are correct, not the numbers.

**Rejected.**
- **Baked single-file `file://` bundle** (the prior #14 implementation) — inlining
  + fetch/history shim to dodge `file://` restrictions; unnecessary once `file://`
  is dropped.
- **Static-dist bake + hosting** — per-endpoint JSON dist served by a static host;
  more machinery than the audience needs (no hosted URL required).
- **Nightly-regenerated goldens** — makes correctness a bot's job; we want the
  change author to own it, and a value-refresh cron conflicts with a strict drift
  gate.

**Fidelity caveat.** Preview is for layout/copy/components/navigation; for
realistic, evolving data run `bun run demo` (see [demo-spec.md](./demo-spec.md)).
See [preview-server-spec.md](./preview-server-spec.md) for the full design.

---

## D15 — Live vault-economics pipeline from Base RPC (supersedes D1's vault-dashboard exclusion)

**Decision.** Bring the `/allocation` page's **vault economics** slice (Total
Vault Assets, share price, total rmUSDC shares, per-adapter holdings, 7-day
APY, the Total AUM hero) into scope, backed by a real Base JSON-RPC pipeline
(issue #40) — superseding D1's "out of scope: allocation / vault / wallet
dashboards" for this slice only. The backend reads the vault via `eth_call`
(`totalAssets()`, `totalSupply()`), the vault's idle USDC balance
(`USDC.balanceOf(vault)`), and three configured adapters'
`totalAssets()`, computing TVL/share price/total shares/holdings on demand
behind a short-TTL server cache (`backend/src/chain/vault-economics.ts`). A
7-day APY is derived from share-price samples an hourly worker job persists
(`vault_share_price_history`, `backend/src/worker/handlers/vault.ts`), served
at `GET /api/dashboards/vault-economics`. `allocationView()` fetches and binds
this section; other `/allocation` sections (buyback, wallet balances) remain
the static port and stay out of scope. The vault's adapter set comes from
**config, not on-chain discovery** — the vault + USDC addresses are the ones
already documented publicly (`frontend/public/views/docs/skill/installation.html`,
`skills.html`); the three adapter contract addresses aren't published anywhere
yet, so their defaults are non-functional placeholders pending real values via
env.

**Why.** The prior static port (#39) baked every vault-economics figure from a
single 2026-06-26 snapshot, permanently diverging from both robotmoney-site and
actual Base chain state — the opposite of D1's "reproduce the look exactly"
goal once there is a real vault to reflect. Fetching at serve time (not a
committed snapshot) keeps this data seam consistent with the rest of the
pipeline (D9): Postgres-backed, worker-scheduled, cache-fronted — no bespoke
cron-commit machinery.

**Rejected.**
- **GitHub-Actions-cron snapshot-commit pipeline** (mirroring the old
  robotmoney-site model D1 explicitly moved away from) — reintroduces a
  committed-data seam this rebuild deliberately removed.
- **On-chain adapter discovery/registry reads** — more moving parts than a
  fixed 3-adapter vault needs; config with mainnet defaults is simpler and the
  adapter set changes rarely enough to be an explicit deploy-time value.
- **An external chain SDK (ethers/viem)** — the feature needs exactly three
  read-only selectors; hand-rolled selector encode/decode over plain `fetch`
  keeps the buildless-backend dependency footprint (D2, D12) unchanged.
- **Degrading with a 5xx or a fabricated number on RPC failure** — the contract
  is explicit `stale: true` + last-persisted-or-null values, never a made-up
  figure, so the UI can show a clearly-marked degraded state instead of silently
  wrong numbers.

---

## D16 — Live wallet-balances pipeline from Base RPC (supersedes D1's wallet-dashboard exclusion)

**Decision.** Bring the prop-wallet **valuation feed** into scope (issues
#84/#90) — the `/allocation` hero's total prop-wallet value and the
`/performance` page's wallet-performance history — superseding D1's "out of
scope: allocation / vault / wallet dashboards" for this slice only, the same
way D15 did for vault economics. The backend values each configured prop
wallet's tracked assets on demand: ERC-20/native balances and ERC-4626
strategy shares via Base `eth_call` (`backend/src/chain/base-rpc-client.ts`,
reused from D15), priced through the existing keyless `token-prices.ts`
(pinned $1 for USDC, GeckoTerminal/Yahoo otherwise), behind a short-TTL
in-process cache (`backend/src/chain/wallet-balances.ts`). A daily
`wallet.sample_balances` worker job persists one row per `(sample_date,
symbol)` into `wallet_balance_samples` (migration `0014_wallet_balance_samples.sql`),
seeded once with a pre-launch history backfilled from the retired baked
constants (`chain/wallet-history-seed.ts`, marked `provenance: 'seed'`, never
`'live'`). Served at `GET /api/dashboards/wallet-balances`
(`ROUTES.dashboards.walletBalances`); `allocationView()` and the
`/performance` wallet chart (`frontend/public/assets/js/app/alpine/views.js`)
fetch and bind it, replacing the retired static `WALLET_SNAPSHOT_TOTAL_USD`
scalar and the baked 99-day `walletPerfView` series.

**Why.** Same motivation as D15: a baked snapshot permanently diverges from
real wallet state, defeating D1's "reproduce the look exactly" goal now that
there are real prop wallets to reflect. Per-holding (not whole-payload)
degrade keeps one bad chain/price read from blanking the whole feed — each
tracked asset values independently and falls back to its own last-persisted
sample.

**Rejected.**
- **Whole-payload degrade on any single leg's failure** — would turn one
  flaky price feed (e.g. GeckoTerminal) into a blanked-out total; per-holding
  fallback isolates the failure to the affected asset.
- **An archive indexer to reconstruct gap-free pre-launch history** — explicitly
  out of scope for #84; the one-time seed from the ported baked constants
  (`provenance: 'seed'`) already carries that history forward honestly, and a
  full indexer is more machinery than the feature needs.
- **Fabricating or silently freezing a value on a failed live read** — same
  invariant as D15: a value is either a real read, a labelled stub, or the
  last-persisted sample marked `stale`/`seed` — never presented as live.
