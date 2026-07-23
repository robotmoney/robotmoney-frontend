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
visualizations, blog/media, other editorial pages. **Superseded in part by D15,
D16, and D17**: the `/allocation` page's vault-economics slice (TVL, share price,
adapters, 7-day APY) and the prop-wallet valuation feed (live holdings +
history) are each brought into scope with a live Base RPC pipeline, and D17
then retired the last baked literals (buybacks, token metrics, wallet sleeves)
the same way — nothing of this exclusion remains a static port.

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
the static port and stay out of scope *(as of this decision — wallet balances
were since brought into scope by D16 and buybacks by D17)*. The vault's adapter
set comes from
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
wallet's tracked assets **on the worker schedule** (never on the request
path — hardened by #119): ERC-20/native balances and ERC-4626
strategy shares via Base `eth_call` (`backend/src/chain/base-rpc-client.ts`,
reused from D15, since batched through ≤2 Multicall3 calls per sample), priced
through the existing keyless `token-prices.ts` (pinned $1 for USDC,
GeckoTerminal/Yahoo otherwise), behind a short-TTL in-process cache on the
sampler (`backend/src/chain/wallet-balances.ts`). The per-minute
(cron `* * * * *`) `wallet.sample_balances` worker job persists one row per
`(sample_date, symbol)` into `wallet_balance_samples` (migration
`0014_wallet_balance_samples.sql`),
seeded once with a pre-launch history backfilled from the retired baked
constants (`chain/wallet-history-seed.ts`, marked `provenance: 'seed'`, never
`'live'`). Served at `GET /api/dashboards/wallet-balances`
(`ROUTES.dashboards.walletBalances`), which reads only the last persisted
per-symbol samples — zero chain reads at request time; `allocationView()` and the
`/performance` wallet chart (`frontend/public/assets/js/app/alpine/views.js`)
fetch and bind it, replacing the retired static `WALLET_SNAPSHOT_TOTAL_USD`
scalar and the baked 99-day `walletPerfView` series.

**Why.** Same motivation as D15: a baked snapshot permanently diverges from
real wallet state, defeating D1's "reproduce the look exactly" goal now that
there are real prop wallets to reflect. Per-holding (not whole-payload)
degrade keeps one bad chain/price read from blanking the whole feed — each
tracked asset values independently and falls back to its own last-persisted
sample. *(Since #119's Multicall3 batching, per-holding independence holds for
price legs and for per-sub-call reverts inside a successful batch; a
whole-batch RPC failure degrades all chain-read legs of that sample together —
the trade accepted to cut the 429-drawing RPC fan-out to ≤2 calls.)*

**Rejected.**
- **Whole-payload degrade on any single leg's failure** — would turn one
  flaky price feed (e.g. GeckoTerminal) into a blanked-out total; per-holding
  fallback isolates the failure to the affected asset (price legs and per-call
  reverts still degrade individually post-#119; see above for the batch-level
  exception).
- **An archive indexer to reconstruct gap-free pre-launch history** — explicitly
  out of scope for #84; the one-time seed from the ported baked constants
  (`provenance: 'seed'`) already carries that history forward honestly, and a
  full indexer is more machinery than the feature needs.
- **Fabricating or silently freezing a value on a failed live read** — same
  invariant as D15: a value is either a real read, a labelled stub, or the
  last-persisted sample marked `stale`/`seed` — never presented as live.

---

## D17 — Remove the last baked frontend data (live buybacks, token metrics, sleeves; supersedes D1's remaining exclusions)

**Decision.** Remove every remaining baked data literal from the frontend
(issue #111) — the `/allocation`/`/tokenomics` buyback table, ROBOTMONEY token
metrics, per-wallet sleeve breakdowns, and the strategy/bucket target weights
are all served from live API endpoints: `GET /api/dashboards/buybacks`
(ROBOTMONEY `Transfer`-log reads into the primary prop wallet + WETH/USD swap
legs, `backend/src/chain/buyback-logs.ts`, refreshed by the `buybacks.refresh`
job, cron `15 */6 * * *`, persisted via migration `0015_buyback_swaps.sql`),
`/token-metrics` (`chain/token-metrics.ts`), `/wallet-sleeves`
(`chain/wallet-sleeves.ts`), and the `allocation_framework` read
(`chain/allocation-framework.ts`) — ending D1's "buyback stays out of scope"
remnant: nothing of the original allocation/vault/wallet exclusion remains a
static port. Real adapter and token addresses ship as `config.ts` defaults
(retiring the perpetual "Not configured" placeholder adapters; a
placeholder-form env override still flips an adapter back to
`configured: false`), and `base-rpc-client.ts` becomes the **single RPC
transport** for every chain read. The shared endpoint contract the feeds were
built against (DTOs, provenance fields, degrade rules) is
[contract-live-data.md](./contract-live-data.md); the frontend binds via
boot-registered factories in `alpine/views.js` (e.g. `buybackSummary`).

**Why.** Same motivation as D15/D16, applied to the leftovers: a baked literal
permanently diverges from chain state, and a mixed page — some cells live,
some frozen at the 2026-06-26 snapshot — is worse than either extreme. One
transport plus one written contract keeps the honesty rules (provenance
labels, never a fabricated value, placeholders never `eth_call`ed, resolvers
read per request) uniform across every dashboard feed instead of re-deriving
them per endpoint.

**Rejected.**
- **Keeping the buyback table static** (the last D1 remnant) — it drifts the
  moment the next buyback lands, and `Transfer` logs are cheaply readable with
  the transport the repo already has.
- **A per-feature RPC client** — N copies of encode/timeout/retry logic; a
  single `base-rpc-client.ts` transport concentrates the later 429/backoff and
  Multicall3 hardening (#119) in one place.
- **Shipping placeholder adapter/token addresses** — the real addresses are
  public chain facts, not secrets; placeholder defaults just rendered
  permanent "Not configured" cells on a stock deploy.

**Open follow-ups (#112).** Buyback USD valuation prices at spot-at-read
rather than the swap-leg execution price, and the log scan's reorg margin is a
fixed constant — both flagged in #112 for a later pass.

---

## D18 — Publish the MCP server as a fourth subdomain-routed surface (refines D13)

**Decision.** Give the IC MCP server (`mcp/src/server.ts`) its own hostname
instead of leaving it undocumented (issue #189): `mcp.staging.robotmoney.net`
(staging) / `mcp.robotmoney.net` (production), Cloudflare-proxied like
`committee.`/`app.` (topology.md §3.1). It is deployed to the **same DO
droplet** as `committee.` (it is this repo's surface, and the `/health`
contract already couples IC health to MCP reachability — topology.md §9), but
runs as its **own container** (`mcp` service in `docker-compose.yml`) on its
**own port**, so it cannot share `committee.`'s proxied port `443`. It uses
Cloudflare's alternate proxied-HTTPS port **`8443`** (one of Cloudflare's
fixed supported-port list, forwarded on any plan with no Origin Rule and no
reverse proxy): `MCP_PORT=8443` in the droplet env is the only production
config this requires, since `mcp/src/server.ts` already reads `MCP_PORT`
straight into `Bun.serve({ port })`. Full endpoint:
`https://mcp.<staging.>robotmoney.net:8443/mcp`, replacing the "ask your
operator" placeholder previously in `participation.html`.

**Why.** D13 established subdomain-per-surface as the mechanism for adding a
new independently-addressed surface without a reverse proxy; MCP is exactly
that — a distinct container/port that must not become a path prefix under
`committee.` (which would require path-routing software D13 explicitly
rejects). Reusing a Cloudflare-supported alternate port keeps the "no
Worker, no reverse proxy, no new vendor permission" property intact instead
of reaching for Cloudflare Origin Rules or a second droplet.

**Relationship.** Refines D13 (topology.md §3/§3.1): the surface table gains a
fourth row; the "no reverse proxy" and "no routing software" properties are
unchanged. No code change — `mcp/src/server.ts` and `docker-compose.yml`
were already correctly parameterized (`MCP_PORT`, own service block); this is
a docs-only, config-value decision.

**Alternatives rejected.**
- **Path-prefix under `committee.` (e.g. `committee.robotmoney.net/mcp`)** —
  requires a reverse proxy or path-routing software on the `committee.`
  droplet process; rejected by D13's "no routing software" rule the same way
  a Cloudflare Worker router was rejected there.
- **A second droplet just for MCP** — real infra/cost for a service that is
  already correctly isolated by container + port on the existing droplet;
  no isolation benefit big enough to justify it here.
- **Cloudflare Origin Rules to remap `mcp.` port 443 → origin `8788`** — works,
  but adds a Cloudflare permission/config surface (`Zone · Origin Rules ·
  Edit`) not otherwise needed anywhere in this repo's deployment; a
  Cloudflare-supported alternate port achieves the same "one droplet, two
  proxied listeners" outcome with zero new vendor surface.

---

## D19 — Hosted preview URLs on Cloudflare Pages (revises D14 and D13)

**Decision.** Ship a **hosted, per-branch preview URL** on Cloudflare Pages
(via `wrangler pages deploy --branch`) for every push to `preview/**` branches.
Retire the `scripts/serve-preview.ts` server and `docs/preview-server-spec.md`
specification. Replace server-side `/api` mocking with a **client-side iframe
wrapper** (`preview/preview.html`) that runs the production SPA inside an
iframe and intercepts `fetch` calls to serve goldens from a static JSON file
loaded in JS memory. The wrapper is pure static files; the mocking is entirely
client-side.

**Motivation.** D14 introduced goldens-backed preview with `bun run preview`,
a ~40-line Bun server that mocks `/api/*` responses. This works locally, but
has no hosted deployment path — marketing and external reviewers cannot access
a branch preview without cloning and running locally. A hosted, shareable URL
(e.g., `preview-foo.robotmoney.pages.dev`) requires either a persistent server
or static hosting. Static hosting + client-side mocking is simpler: it removes
the server entirely, eliminates a class of bugs (server crashes, mismatches
between local server and built artifact), and makes the preview experience
identical everywhere — local or hosted, same wrapper, same goldens.

**Relationship to D14.** D14 rejected baked frozen-single-file bundles and
server-side mocking in favor of live SPA + server replay. This decision
preserves that — the SPA is still live (zero preview-mode switches in
production code) — but shifts the server from `scripts/serve-preview.ts`
to the static wrapper. The goldens contract is unchanged; the wrapper is the
new replay engine. D14's language "a CI drift gate blocks a PR" is now
enforced in `scripts/tests/goldens-drift.test.ts`. The spec at D14's
conclusion (preview-server-spec.md) is retired; preview mode is now described
in `docs/architecture.md` alongside D14's mechanism.

**Relationship to D13.** D13 established that production surfaces live on DO
with Cloudflare for DNS + observability only — no compute, no routing
software. D13 explicitly rejected Cloudflare Pages and Workers. This decision
uses Cloudflare **Pages only** (not Workers, not compute), purely as a **CDN
for static files** composed on each CI run (frontend/public + preview/ +
goldens). The Cloudflare scope **remains DNS + observability** for the
production surfaces; Pages hosts only ephemeral, branch-scoped preview URLs,
not any production surface. No Workers, no routing software, no new compute
platform. Preview is fundamentally outside the D13 topology (it is not a
production surface). The DNS record (`preview-*.robotmoney.pages.dev`) is
Cloudflare's, not ours; we own none of that subdomain. D13's properties
(all production compute on DO, no Cloudflare code) are intact.

**Changes made.**
- New `preview/` directory: `preview.html` (iframe wrapper), `_redirects`
  (`/ → /preview.html` rewrite), `_headers` (X-Robots-Tag: noindex),
  `404.html` (frame-escape handler).
- New `scripts/compose-preview-deploy.ts`: composes the deploy directory
  (frontend/public + preview/ + goldens/api-goldens.json); serves it locally
  with `--serve`.
- New `.github/workflows/preview-pages.yml`: smoke test job (hermetic
  Playwright test, no CF credentials) + Pages deploy job on `preview/**`
  push.
- Retired `scripts/serve-preview.ts` (superseded by static wrapper).
- Retired `docs/preview-server-spec.md` (preview contract folded into
  architecture.md).
- Updated `package.json` `preview` script: `bun scripts/compose-preview-deploy.ts --serve`.
- Updated `scripts/update-goldens.ts` header: names wrapper as consumer,
  references `docs/architecture.md` as contract home, names
  `scripts/tests/goldens-drift.test.ts` as the wired gate.
- Updated `docs/architecture.md` preview section: describes wrapper, static
  hosting, client-side interception, hosted Cloudflare Pages story,
  repurposed `bun preview`.

**Alternatives rejected.**
- **Cloudflare Workers** — would require maintaining runtime code on a second
  vendor; rejected to keep all production compute on DO (D13). Branch previews
  have no such constraint; Pages is purely CDN.
- **Keep `scripts/serve-preview.ts` for local, deploy separately for hosted** —
  means maintaining two implementations and explaining when to use which;
  wrapper approach gives identical experience everywhere with one codebase.
- **Persistent DO droplet for preview** — adds cost/ops for an ephemeral
  feature; static hosting is cheaper and simpler.
- **Hand-rolled `/api` replay in the wrapper vs. client-side fetch intercept**
  — fetch intercept is the native browser pattern, requires zero server, and
  survives into the SPA's own fetch calls without needing the wrapper to
  understand the app's structure.

**Fidelity caveat.** Unchanged from D14: preview is for layout/copy/components
/navigation; values are mock/point-in-time. Run `bun run demo` for realistic
data (see [demo-spec.md](./demo-spec.md)).

---

## D20 — No-bake preview hosting via Cloudflare Git integration (revises D19)

**Decision.** Remove the repo-side preview deploy machinery D19 introduced: the
TypeScript composer (`scripts/compose-preview-deploy.ts`), the
`preview-pages.yml` GitHub Actions workflow, and their tests. Hosting is owned
by **Cloudflare Pages Git integration**, configured in the Cloudflare dashboard
(no GitHub secrets, no wrangler, no deploy code in the repo): on push to
`preview/*` branches, Cloudflare checks out the branch and runs
`bash scripts/cloudflare-statics.sh` — a ~10-line transparent shell script that
assembles the deploy dir `_site` (frontend/public at the root, the wrapper at
`/preview/index.html`, goldens at `/goldens/api-goldens.json`, plus
`_redirects`/`_headers`/`404.html`). The wrapper moves from `preview/` to
`frontend/preview/` (a sibling of `frontend/public/`, so production never
serves it), renamed `preview.html` → `index.html`. Goldens stay pinned at
`goldens/api-goldens.json` — they are a shared test fixture
(`allocation-view.spec.ts`, `tokenomics-fees.spec.ts`, and the
`views/regime/indicators.html` provenance reference them there). Locally,
`bun run preview` is a minimal in-place `Bun.serve` static server
(`scripts/preview-server.ts`) exposing the same URL space with no copying —
edits show on refresh.

**Why.** D19's shape violated the project's no-bake / author-owned-correctness
principles (D14): a TS composer with byte-identity tests, a deploy workflow,
and a CI-composed artifact are exactly the kind of machinery D14 removed. The
SPA sits at the deploy root, so its absolute asset paths (`/assets/...`) work
natively — no wildcard rewrite rules; `_redirects` is one line
(`/ → /preview/index.html`). Keeping the preview current remains the **PR
author's responsibility**, enforced by the every-PR CI checks (the preview
smoke spec in the required e2e Playwright run and the goldens drift gate in the
required root `bun test`) — never by automation, mirroring D14's rejection of
nightly regeneration. A red check means: run `bun run goldens:update` in the
same PR.

**Rejected.**
- **Uploading the whole repo tree with root-level `_redirects` wildcards** —
  exposes the entire repo on the CDN and scatters Cloudflare-specific files at
  the repo root; the tiny assemble script keeps the deploy surface explicit.
- **Moving the wrapper into `frontend/public/`** — production would serve it.
- **Runtime fetch of files from raw.githubusercontent.com** — the repo is
  private; and it would reintroduce a runtime dependency on a second host.
- **Keeping the D19 composer + GH Actions deploy** — repo-side deploy
  automation, secrets, and byte-identity tests for what is a `cp -r`; the
  dashboard-configured Git integration does the same with zero repo machinery.

**Fidelity caveat.** Unchanged from D14/D19: preview is for
layout/copy/components/navigation; values are mock/point-in-time. Run
`bun run demo` for realistic data (see [demo-spec.md](./demo-spec.md)).
