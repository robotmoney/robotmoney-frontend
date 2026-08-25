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
> cluster; the ephemeral (CI) and smoke (Docker) modes are unchanged.

**Decision.** Consolidate comments (was Upstash), committee (was GitHub-as-DB),
and dashboard data (was committed CSV/JSON) into a single self-hosted Postgres in
Docker. Mode is chosen by `DATABASE_URL` + volume: ephemeral (CI), smoke
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
> `docker-compose` remains the **CI and smoke** deployment; same-origin/no-CORS is
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
anywhere**. The full map is
[architecture.md § Network topology](architecture.md#network-topology--dns-origins--vendors):

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
`docker-compose` (D8/D11) remains the CI and smoke deployment.

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
test cluster or `bun run smoke`), not hand-written and not derived from other
fixtures — so **field shapes** stay faithful; values are point-in-time. Keeping
them correct is the **change author's responsibility** (no nightly regeneration);
a CI drift gate blocks a PR whose goldens no longer match the code (wired per
D19 in `scripts/tests/unit/goldens-drift.test.ts`). The most
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
realistic, evolving data run `bun run smoke` (see
[architecture.md § Demo Specification](architecture.md#smoke-specification)).
See [architecture.md § Preview mode](architecture.md#preview-mode-goldens-backed-no-backend)
for the full design (revised by D19: the replay engine is now the client-side
wrapper, not a server).

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
[architecture.md § Live-data contract](architecture.md#live-data-contract--4-new-dashboard-endpoints);
the frontend binds via
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

> **Superseded by D21** (retire the MCP server; REST API + a maintained skill
> only). The `mcp.` subdomain and port `8443` provisioning below no longer
> apply; decommissioning them is D21's follow-up implementation work.

**Decision.** Give the IC MCP server (`mcp/src/server.ts`) its own hostname
instead of leaving it undocumented (issue #189): `mcp.staging.robotmoney.net`
(staging) / `mcp.robotmoney.net` (production), Cloudflare-proxied like
`committee.`/`app.`
([architecture.md topology §3.1](architecture.md#31-mcp-hostname-and-port-d18)).
It is deployed to the **same DO
droplet** as `committee.` (it is this repo's surface, and the `/health`
contract already couples IC health to MCP reachability —
[architecture.md topology §9](architecture.md#9-seamless-without-a-single-origin-and-observability)), but
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

**Relationship.** Refines D13 (architecture.md topology
[§3](architecture.md#3-the-surfaces--subdomain-map)/[§3.1](architecture.md#31-mcp-hostname-and-port-d18)):
the surface table gains a
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
enforced in `scripts/tests/unit/goldens-drift.test.ts`. The spec at D14's
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
  `scripts/tests/unit/goldens-drift.test.ts` as the wired gate.
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
/navigation; values are mock/point-in-time. Run `bun run smoke` for realistic
data (see
[architecture.md § Demo Specification](architecture.md#smoke-specification)).

---

## D20 — No-bake preview hosting via Cloudflare Git integration (revises D19)

> **Never enabled, and its script is gone (2026-08-22).** Issue #670 confirmed
> the Cloudflare Pages Git integration this decision assigns hosting to was
> never turned on — no dashboard project, no build command, no `.pages.dev`
> URL. `scripts/cloudflare-statics.sh` was deleted in #608 (`7acf6e7`, #720).
> The decision below is kept as the record of what was decided; read its
> mechanism as history, not as a pipeline you can run. `bun run preview`
> (`scripts/preview-server.ts`) is the surviving half and still works.

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
`bun run smoke` for realistic data (see
[architecture.md § Demo Specification](architecture.md#smoke-specification)).

---

## D21 — Retire the MCP server; REST API + a maintained skill only (supersedes D18)

**Decision.** Abandon the hosted MCP transport (`mcp/`) as a member-facing
surface. Committee members participate over **REST/JSON only**
(`ROUTES.committee`, already the "REST sibling" of every MCP tool — see
[architecture.md §9.5](architecture.md#95-surfaces--one-core-one-transport)).
Everywhere the architecture previously described "MCP or REST" as parallel
transports, REST is now the only one. The new flow has three steps, each
already backed by something this project maintains or already ships:

1. The copy-paste prompt (R4) tells the owner's agent to install the
   **`committee-onboarding` skill** from `robotmoney-core`
   (robotmoney-core#1170/#1171) into its own harness. The skill — not a
   server-side tool call — is now the discovery mechanism: because it is
   maintained centrally and reinstalled/referenced fresh each time, its
   content can be updated without the static copy-paste prompt going stale,
   the same property the retired MCP `apply-how-to` tool provided. No new
   discovery endpoint is needed.
2. The skill instructs installing and configuring the **`rmpc` client**
   (keygen, canonical-payload signing) — unchanged from today.
3. The skill walks the agent through applying over the **existing REST API**
   (`ROUTES.committee.apply`, already implemented; `signingPayload` for the
   bytes to sign) using the `rmpc`-produced signature — no MCP `apply` tool,
   no new backend route.

This retires D18 (the `mcp.` subdomain, port `8443`, the fourth surface in
the topology's subdomain map) outright rather than refining it — there is no
narrower scope of D18 left standing once the surface it provisioned is gone.
The `mcp/` package, its Dockerfile/compose service, CI jobs
(`smoke-live-smoke-nightly.yml`, `committee-opencode-nightly.yml`,
`e2e.yml`'s MCP steps, `rmpc-release-e2e-nightly.yml`'s OAuth flow), and the
`mcp.<domain>` DNS/firewall provisioning are **not removed by this decision
alone** — this entry is the architecture/docs change; the code and
infrastructure retirement is follow-up implementation work, tracked as its
own issue so it gets its own review and CI verification rather than riding
along with a docs commit.

**Why.** MCP has no customer: no committee member has connected over it, and
the only consumers of the MCP surface in this repo are our own smoke/e2e
drivers exercising it end-to-end — the "member" was always our own harness.
Meanwhile the REST sibling has existed for every MCP tool since §9.5 was
written ("two transports" over one domain layer), so nothing about member
capability is lost — an agent that can make an HTTP call (every agent
framework can) can already do everything the MCP tools did. Maintaining a
second transport — its own OAuth 2.1 authorization-server implementation,
Streamable HTTP session handling, subdomain, port, and CI matrix — has been
pure carrying cost against a surface nobody outside this repo uses, and nothing
in the agent-tooling ecosystem this project tracks suggests that changes: the
"agents need a bespoke protocol to call an API" premise MCP was built on
hasn't materialized as the differentiator it was expected to be, and an API
service plus a maintained skill (already how this project ships the
`rmpc`/keygen procedure) covers the same ground with far less to run and
secure.

**Relationship.**
- **Supersedes D18** in full: the `mcp.` subdomain row leaves the surface map
  ([architecture.md §3](architecture.md#3-the-surfaces--subdomain-map)); §3.1
  is retired.
- **Revises architecture.md §9** (IC feature architecture): §9.1 drops the
  `mcp/` layer row and repo-layout entry; §9.2's actor identity mechanism is
  access-key hash only (the "OAuth 2.1 (MCP surface)" branch is gone); §9.3's
  transport/identity check is access-key hash only; §9.4's submission channel
  is the REST `submit` endpoint only; §9.5/§9.5.1 collapse from "one core, two
  transports" to one core, one transport, with the member-side signing
  property preserved (`rmpc` signs locally; the server only verifies —
  unchanged).
- **Revises architecture.md §11** (member onboarding, normative spec): R4/R5's
  discovery step becomes "install the `committee-onboarding` skill" instead
  of "call the MCP `apply-how-to` tool" — the skill itself, not a live server
  call, is now the up-to-date-by-construction source of the procedure; R6's
  "submission over MCP additionally proves reachability" clause is dropped
  (REST submission already proves API reachability, which is all that's
  needed); R8's eval still onboards a vanilla agent with real inference, now
  proving the skill + `rmpc` + REST path instead of the skill + MCP path. The
  onboarding *sequence* (connect → discover → toolchain+keygen → apply
  (signed) → review/approve → claim+participate) is unchanged in shape — only
  "connect"/"discover" collapse into a single "install the skill" step and
  every remaining step rides on REST instead of MCP.
- **Revises architecture.md §5** (Authentication & authorization): "two
  identity mechanisms by surface" (OAuth 2.1 for MCP, access-key hash for
  REST) collapses to the single access-key-hash mechanism; the "OAuth
  `client_credentials`" credential-exchange line is corrected to the actual
  mechanism members already use — the signed key-proof challenge
  (`token-claim/challenge` → `token-claim`, issue #205) — which this decision
  makes the *only* credential-exchange path rather than a REST alternative to
  an OAuth one.
- **`robotmoney-core#1170/#1171`** (the `committee-onboarding` skill): scope
  changes from "teach MCP setup, signed apply, and the skill" to "teach the
  REST-only flow" — a same-size authoring change (a transport swap in the
  skill's instructions), not new scope.

**Alternatives rejected.**
- **Keep MCP as an optional/secondary transport, REST primary.** Rejected:
  running two transports for one consumer set with zero MCP-only capability
  is carrying cost for no capability delta — every reason to keep it (dual
  auth server, dual CI matrix, dual smoke path) is a cost, not a benefit, once
  nothing requires it.
- **Wait and see — leave MCP deployed but stop building on it.** Rejected: an
  undeprecated surface with a live subdomain, port, and OAuth server invites
  new work to target it by default (as the onboarding-ic-workflow plan was
  about to do in Phase 3) and keeps paying the CI/ops cost with no offsetting
  signal that waiting produces a different answer.
- **Retire the code in the same change as this decision.** Rejected for scope
  control: this entry and the architecture.md/spec edits are reviewable as a
  docs-only change; deleting `mcp/`, its Dockerfile/compose service, and four
  CI workflows is real code surface that deserves its own PR, its own CI run,
  and independent review rather than being bundled sight-unseen into a
  documentation commit.

---

## D22 — Evals run a registry-selected OpenCode model; the onboarding eval is layered and shares the smoke's stack

**Local suite refinement (2026-07-29).** Development evals are registered as
native Bun tests under `evals/` and run through the separate `bun run eval`
entrypoint. Definitions own stable metadata, sample count, timeout/budget and
run/score semantics; the integrated admission definition reuses the existing
stack and member-agent observer. Suite manifest/summary files correlate the
existing redacted per-sample artifacts. Local eval execution now requires
`OPENCODE_API_KEY` and a funded registry selection before Docker: it does not
probe or fall back to the unreliable no-credential tier. The model registry
remains the only source of model ids and `AGENT_MODEL` remains the only
selector.

> **Rule 1 amended 2026-07-28.** This decision originally mandated a *vanilla
> keyless* install. Evals now run a funded, registry-selected model
> (`AGENT_MODEL` → `scripts/lib/model-registry.ts`), with `AGENT_MODEL=free`
> still available as a keyless path. Rules 2-4 are unchanged and still
> binding. Read the amendment at the end of this decision before relying on
> any statement below it.

**Decision.** Four rules, binding on every eval in this repo.

1. ~~**Keyless, always.**~~ **AMENDED 2026-07-28 — see "Amendment: rule 1" at
   the end of this decision.** The original text read: "Every eval runs on a
   **vanilla, keyless OpenCode installation**, pinned to the free OpenCode Zen
   tier (`opencode/big-pickle`). No API key, no provider secret, no paid model,
   and **no 'paid opt-in' override** — not as a default, not as an operator
   escape hatch, not as a nightly-only widening. The model is an **in-code
   constant**, never an environment variable, so there is no configuration
   surface through which a keyed model could be selected."
2. **No inference-off mode on an eval path.** An eval always makes a real model
   call. Inference-off *rails* checks are legitimate and valuable (they prove the
   machinery an eval rides on), but they are not evals, must not be named as
   such, and must never stand in for one. Concretely: no mock/injection seam on
   the eval's own path, no scripted fallback that performs the agent's steps for
   it, no conditional skip — a missing Docker daemon or missing network egress
   **fails loudly** rather than passing by absence.
3. **Layered, not monolithic.** The onboarding eval is a graded sequence, not one
   pass/fail run, and it never boots the full smoke cluster — only a `core` stack,
   and only for the final layer.
4. **Scored by sampling, not by a single run.** An eval measures a stochastic
   system, so it takes K samples, classifies every outcome, and reports the rate.
   A single sample is a coin flip reported as a verdict.

Rules 3 and 4 are specified normatively in
[architecture.md §11.3](architecture.md#113-onboarding-eval-normative) (E3, E4) —
the layer table, the observation mechanism, the outcome classes, and the CI
placement live there, not here.

The eval shares the smoke's components rather than paralleling them: one stack
module with a `core`/`full` profile, one member-agent container primitive, one
outcome classifier. The onboarding eval **is** the smoke's onboarding path with
the rest of the cluster not booted.

**Why.**

*Keyless.* An eval exists to measure whether a **vanilla** agent can navigate
this product unaided. A keyed or paid model changes the subject under test — it
measures a better model's tolerance for our instructions, not our instructions.
It also makes the result unreproducible by anyone without the secret, and an eval
that only CI can run is not a gate, it is a rumour. Keyless means any contributor
runs the complete eval locally with zero setup. The free tier is genuinely real
inference against a real provider, which is exactly why it is the right and only
default (see `scripts/lib/onboarding-eval.ts`'s own rationale).

*No inference-off mode.* The failure this eval exists to catch is invisible to
every rails check. On 2026-07-25 a smoke run recorded zero admissions because the
member agent **refused** the canonical prompt as a suspicious request; the
container exited cleanly in 15 seconds with all seven steps pending. Every
inference-off rail — image builds, container reaches the api, `rmpc` signs a
canonical payload that the server accepts — was green throughout, because the
rails were all fine. Nobody rode them.

*Layered.* The observe-only harness can only watch server-side state, so
connect/discover/toolchain collapse into one unit and a failure yields no
diagnostic beyond "it didn't apply". Layers localise: a green layer 3 with a red
layer 4 says the toolchain and signature are correct and the problem is the
prompt or the sequencing. Layer 3 in particular verifies the signature offline
against `canonicalizeApplication`, catching canonicalization drift (key order,
whitespace, `lens` omission) that would otherwise surface as an unexplained
`400`.

*Sampled.* The refusal measured on 2026-07-25 occurred in roughly 1 of 5 samples
of the identical prompt. Gating on one sample would be red about that often and
would read as flake, which is how a real signal gets ignored. Reporting the rate
turns the refusal into the metric it should always have been: a rising refusal
rate is a regression in prompt quality, and this is the only instrument that
would show it.

*Shared components.* The duplication is structural, not incidental.
`scripts/lib/smoke-main.ts` performs its setup at **module scope** — port
allocation, admin-token generation (including a `process.env` write), compose-env
construction, log-file opening — so importing anything from it boots a smoke.
`scripts/tests/integration/onboarding-eval-infra.test.ts` therefore had no choice but to fork
its own mini-stack (`bringUpInfra()`). Extracting a side-effect-free stack module
removes that fork rather than adding a second one, and continues the split
already begun by `smoke-env.ts` and `smoke-newcomers.ts`, both of which exist for
exactly this reason.

**Relationship.**
- **Revises architecture.md §11 R8** (onboarding is an eval): R8's "vanilla
  OpenCode agent container doing real inference" is unchanged in intent, and no
  inference-off substitute exists. ~~The install is **keyless** and no API key
  may appear on an eval path.~~ **Superseded by the rule-1 amendment below** —
  the eval runs a funded, registry-selected model and `OPENCODE_API_KEY` is
  expected on the eval path; §11.3 E1 carries the amended normative text. The
  layered structure, scoring, and shared components are specified in **§11.3**.
- **Retires the paid-model opt-ins.** `resolveModelConfig`'s non-default branch
  (`OPENCODE_MODEL` + `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`), `e2e.yml`'s
  `ONBOARDING_EVAL_MODEL` + `ANTHROPIC_API_KEY` trusted-context gate, and
  `committee-opencode-nightly.yml`'s `ONBOARDING_SWEEP_MODELS` sweep over
  `anthropic/claude-haiku-4-5` and `anthropic/claude-sonnet-5` all contradict
  rule 1 and are removed, not preserved. The trusted-context gating in `e2e.yml`
  disappears with them: with no secret to withhold, a fork PR and a same-repo PR
  run the identical eval.
- **Moves the sweep out of the smoke.** `smoke-main.ts`'s env-gated
  `ONBOARDING_REAL_EVAL` block moves to the eval, where sampling belongs. The
  smoke goes back to being a smoke; it keeps admitting members through the same
  shared harness.
- **Adds no workflow.** `committee-opencode-nightly.yml` is repointed at the eval
  on a `core` stack. It gets smaller: no Chromium install, no backend deps for
  the EDGAR seed bootstrap, no smoke-volume reclaim, and no `env:` block. It stays
  `CI_CLASS: heavy` (sweep-only — no `pull_request` trigger). ~~On
  `ubuntu-latest`, because the self-hosted runner shares its IP with the standing
  `rm_smoke_*` stack and has a documented history of 429 flake on live-call
  gates.~~ **Superseded by the rule-1 amendment (2026-07-28):** that IP-flake
  rationale was a property of the FREE tier, which rate-limits per source IP.
  Funded models bill the workspace, not an IP quota — verified from the
  self-hosted host itself, where `big-pickle` returns 429 while
  `deepseek-v4-flash` and `kimi-k2.7-code` return 200 at the same instant. Every
  workflow now runs on `[self-hosted, robotmoney-self-hosted]`, which is this
  repo's spec; `ubuntu-latest` was the exception that rationale bought, and it
  is retired with it.
- **Does not revise D21.** The REST-only onboarding flow is unchanged; this
  decision is about how that flow is evaluated.
- **Implementation is follow-up work**, tracked as its own issue so the code
  change gets its own review and CI run rather than riding along with a docs
  commit — the same scope discipline D21 applied.

**Alternatives rejected.**
- **Keep a paid-model opt-in for the nightly's cross-model signal.** Rejected:
  it reintroduces exactly the property rule 1 exists to prevent. The cross-model
  question ("does a stronger model refuse less often?") is real but is a research
  question about models, not a gate on our instructions — and answering it inside
  the gate makes the gate's subject ambiguous. The keyless rate is the number
  that means something about this product.
- **One integrated run instead of layers, to keep it simple.** Rejected: it is
  what exists today, and the 2026-07-25 investigation showed the cost — a red
  result with no indication of whether the prompt, the skill, the toolchain, or
  the canonicalization was at fault, recoverable only by reading a 500 KB
  container transcript by hand.
- **Gate the eval on every PR.** Rejected: ~8 minutes per layer-4 sample times K
  samples, with hard Docker and network dependencies, against a stochastic
  metric. Sweep-only (`heavy`) is the honest class. The per-PR signal remains the
  inference-off rails plus the single real-inference admission the `e2e` job
  already performs.
- **A new dedicated eval workflow.** Rejected: `committee-opencode-nightly.yml`
  already exists to run the real-inference onboarding sweep. A second workflow
  would duplicate its schedule, class annotation, and rmpc cache to run a
  strictly simpler job.

### Amendment: rule 1 (2026-07-28) — evals run a funded model, selected from a versioned registry

**What changed.** Rule 1's keyless mandate is replaced by:

> Every eval runs a model resolved from the **versioned registry** in
> `scripts/lib/model-registry.ts`, selected by the single `AGENT_MODEL` signal
> and billed to the environment's own `OPENCODE_API_KEY`. The repo default is
> `opencode/deepseek-v4-flash`. A keyless run remains **available and
> supported** — `AGENT_MODEL=free` selects Zen's no-credential tier — but it is
> no longer mandatory.

Rules 2, 3, and 4 are **unchanged and still binding**: no inference-off mode on
an eval path, layered not monolithic, scored by sampling.

**Why.** The keyless mandate did not survive contact with the free tier.

*The pinned model stopped existing in practice.* `opencode/big-pickle` returns
`FreeUsageLimitError` on every probe from CI's host — 429 on 5/5 and then 3/3
consecutive attempts, measured 2026-07-28 — while sibling free models answered
`200` from the same IP, with the same key, at the same instant. The throttle is
model-specific saturation upstream, not our network. And there is no funded tier
to escape to: `big-pickle` is priced at zero across `input`, `output`,
`cache_read`, and `cache_write`, and Zen's catalogue contains no paid sibling. A
keyless default that always 429s is not a keyless default; it is an outage
carrying a rationale. Issue #289 had already removed the per-PR eval for exactly
this reason — the rule was costing us the measurement it was meant to protect.

*The reproducibility argument was weaker than it looked.* Rule 1's case was that
a keyed eval is unreproducible by a contributor without the secret. But
`AGENT_MODEL=free` keeps a genuinely keyless path one env var away, so a
contributor can still run the complete eval unfunded. What they cannot do is
reproduce the *funded* run's model — which is the same, ordinary situation as
any other CI secret in this repo, and is why rule 4's sampling exists.

*The "changes the subject under test" argument is now handled better by naming
the model than by banning keys.* The concern was that a stronger model measures
its own tolerance for our instructions rather than the instructions. That is
real, and measurement showed it cuts both ways: Zen's Claude family carries an
OpenCode coding-assistant framing that **refuses** persona-shaped prompts
outright (`claude/haiku-4-5` declined a committee take as outside its scope;
`claude/sonnet-5` went off-format), which would have measured the refusal, not
our onboarding. The registry addresses this directly — each family carries a
note on what it is and is not suitable for, the nightly sweeps deepseek + kimi
deliberately, and every eval result records the model it ran. A named model in
versioned source is more honest than an unnamed one that happens to be free.

**What keeps rule 1's original intent.** The specific failure rule 1 guarded
against was *ambient, unreviewable* model selection. That guard is preserved,
and arguably strengthened: model **ids** live in versioned source, and the
environment carries only a **selector**. `AGENT_MODEL=deepseek` says which
family; which deepseek it is remains a code review away. An unknown family or
model **fails loudly** rather than falling back, so a run can never quietly use
a model other than the one it was asked for — the property rule 1's "in-code
constant" was actually protecting.

**Consequences.**
- `.github/workflows/e2e.yml` supplies `OPENCODE_API_KEY`; the retired
  `ANTHROPIC_API_KEY` + `ONBOARDING_EVAL_MODEL` opt-in is removed rather than
  preserved. (`committee-opencode-nightly.yml` did too, until D26 retired it.)
- ~~The nightly sweeps `deepseek:kimi` (families, not raw ids).~~ **Superseded
  by D26:** the multi-model sweep retired with that workflow; the nightly is
  now one admission on the registry default.
- Fork PRs cannot reach the secret. The eval fails loudly there rather than
  silently degrading; `AGENT_MODEL=free` is the documented fork-safe path.
- Re-enabling the per-PR eval that #289 removed is now affordable, but is
  **deliberately not part of this change** — it is a gating decision that
  deserves its own review.
- The surviving property is **enforced, not merely documented**:
  `scripts/checks/check-model-selection.sh` fails CI if a raw model-id literal
  appears outside `scripts/lib/model-registry.ts`, if a retired knob
  (`OPENCODE_MODEL`, `ONBOARDING_EVAL_MODEL`, a provider `*_API_KEY`) reappears,
  or if the contribution-advisory reviewer stops resolving through
  `keylessModel()`. It runs in the required per-PR `backend-integration` job,
  and `scripts/tests/unit/model-selection-guard.test.ts` executes it against
  planted fixtures so a green can never come from a scan that matched nothing.
  Rules 2-4's `evals/` properties (no conditional skip, no mock or injection
  seam) are enforced by the same script once that tree exists (#278); until then
  it prints exactly what it did not scan rather than passing silently.

### Amendment: E6 (2026-07-28) — the per-PR eval is opt-in, not unreachable

**What changed.** `.github/workflows/e2e.yml` gains a per-PR opt-in for the §11
R8 real-inference onboarding eval. `ONBOARDING_REAL_EVAL` now resolves to `"1"`
on three routes instead of one:

1. a push to `main` (unchanged);
2. a `pull_request` whose PR carries the label **`real-eval`**;
3. a `workflow_dispatch` started with the `real_eval` input set true.

Everything else is unchanged: an ordinary PR run still spends **zero** model
tokens, the nightly owns the trend sweep, and the inference-off rails check
still runs on every PR. ~~That nightly is
`committee-opencode-nightly.yml`.~~ **Superseded by D26 (issue #373):** that
workflow is retired and the scheduled home of the measurement is `e2e.yml`'s own
nightly `schedule` mirror of its push-to-`main` run, which adds a fourth route
(`github.event_name == 'schedule'`) to the three listed above.

**Why.** #289's arrangement made the eval reachable only *after* merge. A PR
that changes the eval — its model selection, its prompt, its stack — therefore
merges green and then breaks `main`, because the gate it changed could not be
exercised on the branch. That is exactly what happened to PR #292 (`main` red on
this gate for 5 of the 6 runs that followed). The missing capability was never
"run it on every PR"; it was "run it on the one PR that needs it".

**Why not on by default.** Cost is no longer an exhaustible free quota (rule 1's
amendment above), but this repo has one self-hosted runner, and an eval per PR
is minutes of exclusive runner time per PR against a stochastic metric. Off by
default, opt-in per PR, nightly for the trend.

**Mechanics and their costs.**
- `pull_request.types` gains `labeled` so applying the label re-triggers the
  workflow at once — no push, no manual re-run. The `workflow_dispatch` input is
  the secondary route only, because Actions reads dispatch input definitions
  from the **default branch's** copy of a workflow, so a dispatch input is
  unusable on the very PR that introduces it.
- The job-level `if:` ignores a `labeled` event whose label is not `real-eval`,
  so tagging a PR with anything else does not boot the live stack. Accepted
  cost: a job skipped by `if:` reports as *passing* to branch protection, so an
  unrelated label added on top of a red `e2e` would supersede it with a green
  skip. No automation in this repo labels PRs, the same property already holds
  for the pre-existing draft guard, and the alternative — running the full
  ~40-minute gate on every label event — is worse on one runner.
- A labelled **fork** PR still resolves no `OPENCODE_API_KEY`; the job summary
  reports `CANNOT RUN` rather than degrading silently.
- `scripts/tests/unit/e2e-onboarding-eval-pr-cost.test.ts` no longer greps the
  workflow — it **evaluates** e2e.yml's real Actions expressions against
  synthetic event payloads and asserts the resolved values, with red controls
  (including an expression that mentions `pull_request` yet still pays on every
  PR) proving the guard is not a tautology.

---

## D23 — Organize by CI cost class and domain; no big-bang reorg

**Decision.** Two organizing rules, plus a deliberately narrow migration.

1. **A directory is a selectable unit of CI cost.** CI selects by path, so any
   subset CI needs to run without the rest gets its own directory: `tests/unit/`
   (pure), `tests/integration/` (Docker or a local stack), `tests/live/` (real
   external network), `evals/` (real inference — D22). A test's cost class is
   legible from its path before anything is run.
2. **Shared code is named for its domain, never for its consumer.** Code shared
   between smoke runtime and test/eval time lives in `stack/`, `agent/`,
   `toolchain/` — not in a bucket named `lib/`. Harness code separates by role
   (`bin/`, `smoke/`, `checks/`, `ops/`) rather than by medium.

Dependency direction is fixed and enforced: tests and evals may import runtime
and shared code; **runtime must never import test or eval code**. The full target
layout is [architecture.md §3](architecture.md#test-eval-and-tooling-layout).

**Migration is incremental and bounded to three moves:** create `evals/`; land
D22's extractions directly in `stack/` and `agent/` rather than as more flat
files under `scripts/lib/`; split `scripts/tests/` by cost class. Nothing else
moves.

**Why.** The organizing failure is concrete and measurable: `scripts/tests/`
holds **32 test files**, of which 4 require a Docker daemon
(`smoke-compose-config`, `smoke-live-research`, `smoke-volume-lifecycle`,
`onboarding-eval-infra`) and 2 require network egress to GitHub Releases
(`onboarding-eval-infra`, `rmpc-canonical-apply`) — and all 32 run on every PR
under one `bun test scripts/tests` command, because there is no path by which CI
could select a cheaper subset. That single bucket is why the onboarding eval
(D22) had nowhere to live: any home inside `scripts/tests/` would have put an
8-minute, Docker-plus-real-inference run into the per-PR path.

`scripts/lib/` has the mirrored problem on the other axis: it holds smoke
*runtime* (`smoke-main.ts`, `tui.ts`, `smoke-schedule.ts`, `committee/`) beside
shared harness code (`onboarding-eval.ts`, `rmpc-fetch.ts`, `smoke-volumes.ts`)
with nothing marking or enforcing the difference, so nothing stops a test-only
helper being imported into runtime.

Enforcement is by grep check, not convention — the repo already proves the
pattern works: `scripts/checks/check-model-selection.sh` and
`check-no-test-imports-in-runtime.sh` are ~18-line examples and run in
milliseconds. An invariant that lives only in prose is an invariant that
rots.

(D8's own vendor-avoidance rationale stands; its prior grep enforcement,
`backend/scripts/check-no-supabase.sh`, was removed as an overzealous,
single-vendor-named guard — narrower review of new `backend/src` deps
covers the same ground without hardcoding one competitor's name into CI.
Issue #93's prior grep enforcement, `backend/scripts/check-no-ai-overview.sh`,
was removed as deprecated per owner decision; issue #93's underlying
admin-managed-overview-text intent is not otherwise affected by this PR.)

**Relationship.**
- **Serves D22**: `evals/` and the `stack/`/`agent/` extractions are where D22's
  implementation lands. The no-mock-under-`evals/` rule (D22 E2) becomes a grep
  check under rule 1's enforcement clause.
- **Adopts `backend/tests/` as the reference implementation.** It already does
  this — subdivided by surface, `preload.ts` provisioning that fails loudly
  instead of skipping, `support/` separate from `fixtures/`, cost tagged in
  filenames (`*-live.test.ts`). It needs no change; the other packages converge
  toward it as they are touched.

**Alternatives rejected.**
- **Rename `scripts/` → `harness/` for a clean tree.** Rejected: it touches every
  workflow, `package.json` target, and doc reference across the repo for a naming
  improvement with no behavioural benefit. The role-based tree is what a
  greenfield project of this kind should have; it is not worth a migration on a
  working repo. New subdirectories get the right names as they are created.
- **Keep one test bucket and select by filename convention alone
  (`*-live.test.ts`).** Rejected as insufficient on its own: naming makes cost
  *legible* but not *selectable* — `bun test <dir>` takes a path, not a glob over
  test names, so the per-PR run would still pay for every Docker-backed file.
  The naming convention is worth adopting as well, but underneath the split.
- **Unify fixtures and test conventions across all four packages now.**
  Rejected: `backend/tests/fixtures/`, `frontend/test/fixtures/`,
  `contract/src/__fixtures__/`, and `scripts/tests/fixtures/` are each coherent
  within their package, the cost of the divergence is a small lookup, and the
  migration is broad and touches every import path. Not worth it absent another
  reason to touch those files.

---

## D24 — Postgres as the indexer of record for vault-adapter and wallet-sleeve samples (refines D15/D17)

**Decision.** Finish the "worker schedule, never the request path" rule that
D16 already established for wallet-balances (§10.1) for the two remaining
request-time `eth_call` feeds: `/api/dashboards/vault-economics`'s per-adapter
balances and `/api/dashboards/wallet-sleeves`'s per-wallet holdings (issue
#294). Two new tables, migration `0021_chain_indexer_samples.sql`:
`wallet_sleeve_samples` (`UNIQUE (sample_date, wallet_address, symbol)`) and
`vault_adapter_samples` (`UNIQUE (vault_address, adapter_address, sample_hour)`),
upserted by two new worker handlers (`sampleWalletSleeves`,
`sampleVaultAdapters`, both boot-time one-shot enqueued mirroring
`wallet.sample_balances`'s cold start). `getWalletSleeves()` and
`fetchVaultEconomics()` are rewritten to read exclusively from Postgres —
**zero Base RPC and zero third-party price requests on either request path**.
`stale` is redefined per feed as `(now - observedAt) > freshness budget OR the
backing sample's own provenance is not 'live'`; both DTOs gain per-row
`observedAt`/`balanceObservedAt` fields so a consumer can see exactly how old a
served value is, never just a boolean. An executed guard
(`scripts/tests/unit/no-client-side-feeds.test.ts`) now fails CI if any file
under `frontend/public/` ever issues a chain-RPC or third-party-feed request,
with a planted-violation control proving the guard is not vacuous.

**Why.** The root-cause investigation
(`docs/archive/allocation-data-root-causes.md`) found `/allocation` intermittently
rendering `—` across the Vault TVL and Wallet Holdings (Sleeves) tables not
because of a frontend bug but because `vault-economics.ts` and
`wallet-sleeves.ts` still performed request-time Base RPC `eth_call`s and
degraded to nulls whenever the public node throttled — the same quota pressure
tracked by #285/#286/#287. Two dimensions had **no persisted home at all**:
per-wallet sleeve holdings (`wallet_balance_samples` has no wallet dimension)
and per-adapter vault balances (never persisted anywhere). D16 already proved
the fix for wallet-balances: move the chain read to a scheduled sampler and
serve the request path purely from the last-persisted row. This decision
applies that same shape to the two remaining feeds rather than inventing a
different one, so "the browser never calls a data feed" becomes an executed
guard instead of a documented intention that held for one feed out of three.

**Explicitly preserved boundary.** `valueLeg` (`chain/wallet-valuation.ts`)'s
default `priceReader` parameter stays `providerWalletPriceReader` — the
sampler that needs the persisted-fallback behavior
(`persistedFallbackWalletPriceReader`, used when a live price-provider read
fails) passes it **explicitly** at its own call site
(`sampleWalletSleeves`, `backend/src/worker/handlers/wallet.ts`), not via
`valueLeg`'s default. `wallet-balances.ts::valueAsset` (the out-of-scope
`/api/dashboards/wallet-balances` request path, fed by `sampleWalletBalances`)
calls `valueLeg` with no reader argument and must keep inheriting the
original ok:false-on-price-failure behavior unchanged.

**Rejected.**
- **A per-wallet/per-adapter degrade store instead of a full sampler.** The
  live-data contract (§ Live-data contract) already anticipated this shape for
  wallet-sleeves ("Postgres: none authoritative … optional per-wallet degrade
  store is out of scope") when the feed was still request-time RPC; once a
  scheduled sampler exists anyway, a degrade-only store adds a second
  persistence path for no benefit over just making the sampler's table
  authoritative.
- **Backfilling historical per-wallet/per-adapter series before the first
  sampler run.** Out of scope — the indexer accumulates forward only, same as
  every other samples table in this repo (`wallet_balance_samples`,
  `vault_share_price_history`).
- **Weakening the cold-boot smoke-readiness gate to tolerate the new samplers'
  empty-table window.** Ratified at intake (2026-07-28): the gate is not
  weakened; both new samplers get the same boot-time one-shot enqueue the
  existing wallet-balances sampler already relies on, and `ALLOWED_STALE_LEGS`
  does not grow.

---

## D25 — External-actor rail for simulated independent entities

**Decision (required topology, not an implementation-status claim).** Every
process that the product, smoke, or an eval presents as an independent actor must
run on one shared **external-actor rail**: one disposable container per actor, a
private writable filesystem, no ambient environment inheritance, explicitly
injected scoped credentials only, self-held signing keys, and REST-only access
to Robot Money. This applies to an onboarding-eval candidate, every sitting
committee member in smoke/e2e, and the independent analytics/research producer
described in §9.6 of [architecture.md](./architecture.md). A long-lived actor
gets a private persistent home volume so its identity survives disposable
executions; actors must never share a home, state database, keystore, or bearer
credential.

**Rollout status (2026-07-30).** The onboarding candidate and sitting-member
paths use the shared member-agent launch primitive; the sitting-member migration
and its identity-continuity checks are the member-side implementation of this
decision. The analytics/research boundary is also implemented: a dedicated
`analytics-producer` service has no database or admin credential, owns its cron
cadence, computes outside the API process, and submits through authenticated
HTTP. Its bearer is mounted from a secret file only into that producer and the
API verifier; the smoke host, committee members, and shared workers do not receive
the value. Consumer-DB analytics schedules are forced disabled, queued legacy
jobs are dead-lettered, and admin retry/toggle/rerun/enqueue plus the retired
`research-eligibility` path cannot reactivate them.

Two compatibility artifacts remain explicit. The old worker handler/lane code
and disabled schedule rows remain readable for tests, migrations, and historical
queue visibility, but have neither a supported control-plane caller nor the
producer bearer. The smoke TUI still observes those retired queue rows rather
than producer-native run/cadence telemetry. These are cleanup and observability
gaps, not alternate production paths or exceptions to the trust boundary.

Agent actors share `scripts/agent/member-agent.ts`'s `runMemberAgent()` launch
primitive, backed by the generic `scripts/lib/member-agent/Dockerfile`. It passes
no host environment through to the container. Non-secret facts are enumerated
explicitly; secrets are supplied only through the redacted owner/model inputs.
At most one registry-selected model credential is injected when an actor
performs inference. The analytics producer is a dedicated service rather than a
member-agent invocation, but obeys the same isolation rule: no DB/admin access
and only its secret-file-mounted provider bearer plus enumerated producer
configuration. An owner-held keystore passphrase may unlock a member's persisted
key; it does not give the harness the key.

**The harness plays only the owner/operator.** It may launch and stop the actor,
provide connection coordinates and owner-held secrets, open/close a committee
session, register a fixed smoke member's *public* key once as the protocol
operator, and observe externally visible results. It must not fetch analytical
context for a member, author or repair a take, hold a member private key, sign,
post a memo, or submit on the member's behalf. Those actions execute inside the
member container in `scripts/agent/member-session-client.ts`. A real-onboarded
member is never re-keyed by the harness: the key created during admission and
stored in that member's home volume signs later recommendations. A missing key,
bad credential, malformed model response, timeout, or container failure is
reported loudly and leaves that member absent; there is no template, neutral
stance, privileged re-enrollment, or host-process fallback.

For the analytics/research producer, the boundary means more than putting a
bearer string on an internal trigger. The producer computes outside the
consumer/API trust domain and submits the resulting data through the analytics
REST boundary under its scoped credential. The API verifies and persists the
submission; it does not recompute the provider's result, and an admin credential
does not substitute for the provider role. Scheduling lives in the producer,
not `job_schedules`; seed-time research is a producer command after authenticated
seed ingestion, not a consumer queue enqueue.

**Relationship to earlier decisions.** D21 remains the transport rule: REST is
the only member/provider boundary. D22 remains the normative eval policy and
model-selection rule. D25 generalizes D22's container primitive and zero-ambient
trust boundary to every simulated independent actor, including required smoke
and test executions. Internal protocol-host components (API, session worker,
aggregation) are not external actors and remain on the stack rail.

**Why.** A host-run committee driver previously placed every member in one
process environment. The harness fetched context, held signing keys, authored
prompts, signed and submitted, while concurrent OpenCode children shared host
state and inherited privileged credentials. A cold-run SQLite migration race
made one member fail nondeterministically. A temporary per-call XDG workaround
isolated that CLI database collision, but it is now retired: every sitting
member runs with its own private persistent `HOME` inside its container, and its
model credential reaches that environment only through the rail's explicit,
zero-ambient injection. The more serious defect was that the smoke could claim
independent authorship without executing an independent trust boundary. One
rail makes the production claim executable: isolation, identity continuity,
credential scope, and owner/member separation are properties of the launch
shape rather than prompt discipline.

**Rejected.**
- **Host subprocesses with scrubbed environment variables or per-call XDG
  directories.** These were temporary hardening, not a private filesystem,
  actor-held identity, or production-like trust boundary. The XDG workaround is
  removed, not retained as a second isolation path alongside the container
  rail.
- **A separate purpose-built harness for each actor.** Parallel launch paths
  drift on cleanup, redaction, credential injection, and failure semantics; the
  onboarding eval, sitting members, and producer must share the primitive.
- **Privileged shortcuts in the surface under test.** Admin registration may
  seed the fixed smoke roster once, but cannot replace real admission for an
  onboarding candidate, rotate an admitted member's identity, synthesize a
  take, or impersonate the analytics role.
- **Mocks, templates, and inference-off substitutes in behavioral gates.** A
  missing external resource fails loudly, and the gate must prove that at least
  one real actor execution crossed the REST boundary.

## D26 — Nightly is a mirror of the merge-to-main set (issue #373; supersedes #280/PR #367)

> **Amended 2026-08-23 — the push set now includes `releases-*`.** Those ten
> workflows trigger on `push: branches: [main, "releases-*"]`, because a release
> branch is where release code lives during a rollout: cut from `main`, then
> accumulating rc commits `main` does not see until the backport. Every one of
> those commits used to reach a stage host unverified, which is how v0.3.0 came
> to run its suites by hand and find a broken release gate four rcs deep. The
> isomorphism D26 asserts is unaffected — it is over the SET OF WORKFLOWS, not
> the branch list, and `scripts/tests/unit/nightly-mirrors-merge-set.test.ts`
> keys on `branches` *including* `main` for exactly that reason. One deliberate
> asymmetry: `e2e.yml`'s paid real-inference eval stays scoped to
> `refs/heads/main` and the nightly, since an rc push happens several times an
> hour during a rollout and the eval's coverage argument is one admission per
> night.

**Decision.** Nightly CI is **isomorphic** to the merge-to-main set. Every
workflow that runs on `push: branches: [main]` also runs on a nightly
`schedule:`, and **nothing else runs on a nightly schedule**. The relationship is
enforced mechanically by `scripts/tests/unit/nightly-mirrors-merge-set.test.ts`
in the required `unit` job — the equality is asserted in both directions, any
workflow on one side only is named in the failure text, and a job or step gated
on `github.event_name == 'schedule'` is itself a failure, because nightly must
run the merge set's work rather than extra work.

**Why.** A nightly that runs a *different* set of tests from merge-to-main
requires required reading to interpret. When it goes red you must first work out
which suite it was, what its pass semantics are, and whether the failure is a
product regression or a provider outage — before you know whether release code
is broken. That interpretation cost is paid every time, by whoever is on call.

Before this decision the two sets were not merely different, they were **fully
disjoint**: ten workflows carried `push: branches: [main]`, zero of the six
nightlies did. Nightly was *defined* as everything merge does not run. With the
sets equal, a red nightly means exactly one thing: the code on `main` — release
code — is broken, by an input that changed while nobody was watching.

**Disposition of the six pre-existing scheduled workflows.** The rule applied
was: **retire iff the merge set already runs the same assertions; fold in
otherwise.** Cost is a consequence of that rule, never the criterion.

| Workflow | Disposition | Reason |
| --- | --- | --- |
| `committee-opencode-nightly.yml` | **Retired** | Its real-inference admission is the same measurement `e2e.yml` already spends on a push to `main`. `e2e.yml` now also carries the `37 4 * * *` slot it held. |
| `smoke-live-smoke-nightly.yml` | **Retired** | It booted the same LIVE stack and ran the same `scripts/smoke-live-smoke.ts` assertions as `e2e.yml`; its own header said its "only distinguishing input is the schedule". |
| `onboarding-evals-nightly.yml` | **Folded** (`push: branches: [main]` added) | The four isolated claims bisect the funnel `e2e.yml`'s single admission reports as one opaque red. Nothing in the merge set duplicates them. |
| `rmpc-release-e2e-nightly.yml` | **Folded** | Nothing else proves a *released* rmpc binary drives the documented flow. Its "not every PR" rationale is about release-CDN flake on a **required PR gate**; push-to-`main` is not one. |
| `nightly-fetchers.yml` | **Folded** | The per-PR suites for these surfaces are fully offline/mocked, so the live sweep is not duplicated. Same PR-only rationale as above. |
| `contribution-advisory-reviewer.yml` | **Folded** | Nothing else reviews contribution-governance judgment on open PRs, and a merge is exactly when every open PR's diff has changed underneath it. Its `reviewed-head` dedupe now keys on "not a manual dispatch" so a push run re-reviews only PRs whose head moved. |

`admission-eval-nightly.yml` (a seventh heavy schedule running a bespoke K=5
sampled sweep) was **never created**: this decision supersedes #280, and PR #367
is closed in its favour.

**The admission rate comes free.** `e2e.yml` already spent one real admission on
a push to `main` (`ONBOARDING_REAL_EVAL` resolves to `"1"` there). Its nightly
mirror spends one more per night, so thirty nights is thirty samples — a **larger
denominator than K=5**, at zero additional cost, read off run history rather than
a bespoke scorecard. Reporting is added to the test that already exists: the run
is classified with the existing `scripts/agent/classify-outcome.ts` and rendered
as a small structured record (outcome, resolved model id, duration, member id,
agent-liveness counts, denominator membership) into `$GITHUB_STEP_SUMMARY` and an
uploaded artifact, on green and red runs alike. A `harness-error` renders
distinctly from a `refused` and is excluded from the denominator — it measured
nothing about the product. **No new test suite, eval, scorecard module, or
sampling loop is created in order to produce a report.**

**The tradeoff, accepted deliberately.** Time-to-detection. One sample a night
surfaces a shift in the admission rate over about **a week**, not in one night.
That is the price of not standing up a second measurement stack, and it is
cheaper than the alternative: the four-samples-in-one-night sweep answered
faster but required its own workflow, its own scorecard, and its own pass
semantics — the very "required reading" this decision exists to remove.

**Not in scope.**
- **Making any real-inference measurement a required branch-protection check.**
  A stochastic measurement cannot gate a merge: at the observed refusal rate a
  single-sample gate blocks roughly one merge in five at random (D22 rule 4 — "a
  single sample is a coin flip reported as a verdict"). Nightly parity is about
  *signal isomorphism*, never about promoting these to gates.
- **A release/promotion gate distinct from merge.** A real gap, and a separate
  decision.

**Cross-repo consequence.** The CI taxonomy rubric lives in the agent-prompts
tooling repo and currently specifies that only `heavy`/`sanity-meta` carry
`schedule:`. This decision makes non-heavy classes carry it too, so the rubric
needs a matching change — filed there as an issue, never edited from this repo.

---

## D27 — PR-body compliance rule relaxed to "starts with" a closing reference; scoped to open PRs (issue #343)

**Decision.** `audit-prs.sh`'s `body-must-be-single-closing-reference` check
now passes any open PR whose body **starts with** `Closes|Fixes|Resolves #N`
on its own line, rather than requiring the entire body to contain **only**
that line. The check (and the sibling `missing-linked-issue` check) is also
now scoped to `state == OPEN` PRs — merged and closed history is immutable
and was previously re-flagged forever, growing the violation count
monotonically regardless of how disciplined future PRs were.

**Where implemented.** `scripts/replan/audit-prs.sh` and
`scripts/replan/collect-open-prs.sh` do not live in this repo
(`robotmoney-frontend`) — they belong to the separate Superfield tooling
install (`SUPERFIELD_AGENTS`, checked out locally at
`/drive2/home/lucas/superfield/prompts`). The fix is commit `9305e43`
("patch pr scripts") on that repo's `main`, already pushed to
`origin/main` before this decision was recorded here:

```
--- a/scripts/replan/audit-prs.sh
-  if [[ ! "$body" =~ ^(Closes|Fixes|Resolves)\ #[0-9]+$ ]]; then
+  if [[ "$state" == "OPEN" ]]; then
+    if [[ ! "$body" =~ ^(Closes|Fixes|Resolves)\ #[0-9]+ ]]; then   # trailing $ dropped: prefix match
```

`scripts/replan/normalize-pr-body.sh` (the mechanical fix that rewrites a
whole PR body down to just `Closes #N`) is unchanged and remains
destructive if invoked — but it no longer needs to be invoked for a
compliant PR, since the audit itself now accepts a leading closing
reference followed by a substantive writeup. Option (b) from the issue
(move descriptions into a comment so the body can be rewritten losslessly)
was not needed once (a) was chosen.

**Why (a) over (b).** This repo's own convention — visible in
essentially every PR body, e.g. #374, #368, #406, #407, #408, #410 — is
already "`Closes #N` on line 1, then a full engineering writeup." Relaxing
the rule to match that existing convention required no PR authors to
change behavior; moving descriptions to a comment would have.

**Evidence the residue no longer reproduces.** The two PRs the blocker
named as live violators, #374 and #368, have since merged. Re-running
`audit-prs.sh` against this repo's current 6 open PRs (#404, #406, #407,
#408, #409, #410) after the tooling fix returns exactly one violation,
and it is not a residue of the old all-or-nothing rule — #409 is a
docs-only adhoc PR with no `Closes`/issue reference at all:

```json
{
  "ok": false,
  "violations": [
    {
      "number": 409,
      "title": "docs(release-cycle): production topology and release-cycle proposal",
      "url": "https://github.com/robotmoney/robotmoney-frontend/pull/409",
      "state": "OPEN",
      "reasons": ["body-must-be-single-closing-reference", "missing-linked-issue"]
    }
  ]
}
```

Every other open PR, including this decision's own #404, passes cleanly.

**Not in scope.** Fixing PR #409's missing issue link — that is a genuine,
unrelated violation the audit is correctly designed to catch, tracked on
its own PR, not a recurrence of the `replan-audit-residue` blocker.

## D28 — Committee → Swarm rename, pass 2: schema, routes, contract, and every frontend surface (issue #263, follow-up to #262/D-series pass 1)

**Decision.** Pass 1 (#262, PR #352) renamed backend-internal copy and
identifiers only, deliberately leaving the wire contract (routes), storage
(tables), and every user-facing surface untouched so it could ship without a
coordinated release. This pass finishes it: the `committee_*` Postgres
schema, `/api/committee/*` routes, the contract package's `Committee*`
types, the frontend SPA's `/committee/*` routes and every identifier/CSS
class/file name, the public onboarding skill file, smoke data fixtures,
tests, CI path filters, and user-facing copy ("Committee" → "Swarm" /
"Investment Swarm"). None of it was needed to ship the visible rebrand,
which pass 1 already delivered — this pass exists to finish it precisely
because it touches the wire contract and storage, which is why it was
deferred behind a coordinated release rather than bundled with the copy
pass.

**Migration approach.** `backend/migrations/0025_swarm_rename.sql` renames
every live `committee_*` table (and the one `committee_recommendation`
column) to its `swarm_*` equivalent, plus every explicit and
auto-generated constraint/index name for each table — Postgres does not
cascade a table rename to its own auto-named constraints/indexes, so each
is renamed explicitly. Forward-only, matching every other migration in
this repo: no automated rollback exists; the file's own header comment
documents the manual reverse-SQL order for recovery. Two tables from
`0001_backends.sql` (`committee_takes`, `committee_submissions`) were
already dropped as vestigial prototype remnants by
`0006_committee_reconcile.sql` and are correctly NOT touched by 0025 — they
don't exist. Historical migration files `0001`–`0024` are immutable and were
**not** renamed or edited, including their own `committee_*`-named DDL and
prose comments — matching this repo's existing "migration files are a
historical record of what actually ran" convention.

**Redirect strategy — three surfaces, same shape.** Every place an
already-integrated external party (a member agent, a bookmarked URL) could
have the OLD name memorized keeps resolving rather than hard-404ing:
- **API routes** (`backend/src/api/index.ts`): any `/api/committee/*`
  request gets a 308 (method/body-preserving, since several are POSTs) to
  the same path under `/api/swarm/*`.
- **Frontend SPA routes** (`frontend/public/assets/js/app/routes.js`):
  `viewFor()` rewrites any `/committee/*`, `/admin/committee/*`, or
  `/docs/investment-committee/*` prefix to its `/swarm`/`/admin/swarm`/
  `/docs/investment-swarm` equivalent and re-resolves through the same
  logic, covering every param sub-route (`/committee/members/:id`, etc.)
  without duplicating each regex for the old prefix too — same pattern this
  repo already used for the one-off `/allocation2` legacy redirect.
- **Public onboarding skill** (`frontend/public/skills/`): the file moved to
  `swarm-onboarding/SKILL.md`; a stub `SKILL.md` was left at the OLD
  `committee-onboarding/` path (served as a plain static file, no dynamic
  router involved) pointing to the new one, rather than deleting the old
  path outright.

**Historical smoke data kept its old field name — reader carries the
fallback.** `frontend/public/data/swarm/{sessions,briefs}/*.json` (~50
files, `git mv`'d from `data/committee/` per an explicit decision below) is
frozen historical content and was deliberately NOT content-swept — it still
says `"committee_recommendation"` inside each session JSON. The frontend
archive loader (`static-views.js`'s session normalizer) reads
`raw.swarmRecommendation ?? raw.swarm_recommendation ?? raw.committee_recommendation`,
in that fallback order, so the pre-rename archive keeps rendering without
rewriting its content.

**Two explicit product-copy decisions, made by Lucas rather than assumed:**
- Demo data fixture path: renamed to `data/swarm/` (not left at the old path
  as a stable mount point).
- Product branding: "Committee" becomes "Swarm" / "Investment Swarm"
  everywhere, including marketing copy — not just internal identifiers.
  This in turn forced a copy fix in `docs/investment-swarm.html`: the
  original prose used "IC" as a proper-noun abbreviation for the exclusive
  active committee, and *separately* defined a capitalized "The Swarm" as
  the open population of agents that could apply to join the IC. Collapsing
  IC→Swarm made that circular ("The Swarm... can apply to join the
  Swarm"). Resolved by collapsing to one concept — "Swarm" names the whole
  thing, members and applicants alike — and rewriting the affected
  sentences rather than preserving two tiers under a different name.

**`rmpc`'s own CLI is NOT part of this rename — found and reverted.** A
repo-wide text sweep initially renamed `committee-identity` (the rmpc CLI
subcommand) and `RMPC_COMMITTEE_IDENTITY_PASSPHRASE` (the env var it reads)
to `swarm-identity`/`RMPC_SWARM_IDENTITY_PASSPHRASE` across
`scripts/agent/member-session-client.ts`, `scripts/lib/rmpc-fetch.ts`,
`scripts/rmpc-release-e2e.ts`, the onboarding skill file, and several
tests. This was wrong: `rmpc` is a separate binary owned by
`robotmoney/robotmoney-core`, pinned at v0.3.2 — `scripts/lib/rmpc-fetch.ts`'s
own header comment (predating this rename) documents that subcommand name
as verified directly against that binary's `--help` output. Renaming it here
does nothing to the real binary and would have broken every live
`rmpc committee-identity sign` call this repo's onboarding/signing code
makes. Caught via `git diff HEAD` against the pre-sweep original before
committing, and reverted everywhere (subcommand string, env var, and the
purely-local `missingCommitteeIdentitySubcommands`/
`verifyCommitteeIdentitySubcommand` helper names, for consistency with the
un-renamed contract they check). A guard comment was added at both
`scripts/lib/rmpc-fetch.ts`'s pin declaration and the skill file's first
mention of `committee-identity`, so this doesn't get re-broken by a future
sweep. Renaming `rmpc`'s own CLI surface, if ever wanted, is a
robotmoney-core change tracked there, not here.

**Not in scope.** `mcp/` (already empty per D21's retirement); `recyclebin/`;
this file's own D1–D26 body (historical record, annotated rather than
rewritten, matching the regime-fidelity correction precedent on issue
#400/#447); `docs/code-review/*` and `docs/reports/*`'s own historical
content, except where a report cited a since-renamed *live* file path
(`docs/reports/2026-07-29-local-onboarding-eval-assets.md`'s validation-log
citation of the pre-rename contract test file was updated to
`contract/tests/unit/swarm-application.test.ts`, annotated as a post-hoc path
correction, since `scripts/tests/unit/test-path-citations.test.ts` scans
`docs/reports/` for exactly this and does not exempt it the way it exempts
`docs/code-review/`).

---

## D29 — The api process (`STATIC_DIR`) is the cutover host for `robotmoney.net`, and its deploy path prerenders per-route HTML (issue #480)

*(Runbook: [deployment.md](./runbooks/deployment.md) §2.1.)*

**Decision.** Two questions, answered together because the first determines the
second.

**1. Which host serves `robotmoney.net` after cutover? The `api` process,
serving an assembled `STATIC_DIR`.** It is what the cutover origin already
does — `robotmoney.network` is a `cloudflared` connector onto the single-box
stack (`docs/runbooks/deployment.md` §3.3), and `docker-compose.yml` sets
`STATIC_DIR: /srv/frontend` so the api co-serves the marketing SPA with no
reverse proxy (D11, D13). **Cloudflare Pages is not a candidate for
production**: D13 confines Cloudflare to DNS + observability with no software
to deploy, `docs/runbooks/deployment.md` §1 disables Cloudflare git integration
outright, `CF_API_TOKEN` carries no Pages permission, and the one Pages project
(`robotmoney-preview`, D20) has automatic production deploys **disabled** with
previews limited to `preview/*`. Pointing production at Pages would reverse
three decisions to obtain a prerenderer that can equally be run on the host we
already have.

**2. The prerender runs in that host's deploy path.** `STATIC_DIR` is now an
**assembled** directory, not the raw source tree: `scripts/static-assembly.sh`
copies `frontend/public` into `_static/` and then runs `scripts/prerender.ts`
over it (`PRERENDER_DIR=_static`), writing a `<route>/index.html` for every
`<loc>` in `frontend/public/sitemap.xml`. `docker-compose.yml` bind-mounts
`./_static` at `/srv/frontend`, and `scripts/stack/stack.ts`'s `up()` runs the
assembly before `docker compose up`, so every stack this repo brings up — smoke,
evals, CI, single-box production — serves prerendered HTML. `serveStatic`
(`backend/src/api/static.ts`) answers an extensionless client route with that
route's prerendered file when one exists, and with the home-page shell when it
does not.

**Why.** `frontend/public` contains exactly one `index.html` — the home-page
shell — so mounting it made the api answer *every* route with the home page's
`<title>`, `og:title`, `og:description` and `og:url`. `assets/js/app/seo.js`
fixes that after hydration, which is enough for Googlebot and useless for link
unfurlers: Slack, X, LinkedIn, iMessage, WhatsApp, Telegram and Discord read the
raw response. Every shared Robot Money link therefore unfurled as the home page,
with `og:url` pointing at `https://robotmoney.net/` rather than the page — a
**regression against the site being replaced**, which server-renders per-page
titles today.

**One metadata table, one host.** `scripts/prerender.ts` is unchanged in
substance: it still derives every field from `seo.js`'s `metaFor` table, and it
takes the assembly directory from `PRERENDER_DIR` (default `_site`). It was
written to be shared by two assemblies — `scripts/cloudflare-statics.sh`
(preview) and `scripts/static-assembly.sh` (cutover host) — so that neither
could disagree with the JS path. **`cloudflare-statics.sh` was removed in #608**
(the Pages pipeline it served was never turned on — D20's note, issue #670), so
`static-assembly.sh` is now the only caller. The parameterisation stays: there is
still no second, hand-maintained metadata table, and the prerendered path still
cannot disagree with the JS path.

**Relationship.** Refines D13's static tier for the cutover: D13 assigns
marketing on the apex/`www` to a **DO Spaces CDN**, which remains the intended
end-state tier and is unimplemented in this repo (no upload path, no workflow,
no credential wiring beyond the inventory in `docs/runbooks/deployment.md` §4).
This decision does not foreclose it — `_static/` is a plain static assembly, so
the Spaces migration, when it happens, uploads exactly this directory and
inherits the prerender for free. Supersedes nothing; D20 keeps Cloudflare Pages
for `preview/*` hosting, unchanged.

**Alternatives rejected.**
- **Enable production deploys on the Cloudflare Pages project** — reverses D13
  (Cloudflare = DNS + observability), D20 (`preview/*` only) and the GitOps
  principle that no vendor watches the repo, and would still leave
  `robotmoney.network`'s api-served origin unfixed.
- **Prerender into `frontend/public/` in place** — build output in the source
  tree, and `/skills` is both a sitemap route and an existing asset directory
  (`frontend/public/skills/`), so the outputs would interleave with sources.
- **Serve the shell and rewrite metadata per request in `serveStatic`** — moves
  a build-time substitution into the request path and puts a second copy of the
  metadata logic in the backend, which is exactly the "one source of truth"
  property the issue asks for.
- **Leave `docker-compose.yml` mounting `frontend/public` and rely only on the
  handler change** — the handler can only serve a per-route file that exists;
  with the raw source tree mounted, none ever would.
---

## D30 — AgentMail for Swarm onboarding email, sent from an isolated subdomain via one-time cross-account NS delegation (issue #549)

**Decision.** Two questions, resolved together since the vendor choice drives
the DNS shape.

**1. Vendor: AgentMail**, not Google Workspace's Gmail API and not Cloudflare
Email Service. `deploymentSwarmEmailTransport`'s existing
`{from,to,subject,text}` + Bearer contract (`backend/src/swarm/notifications.ts`)
is unchanged; a new adapter translates it into AgentMail's real send API
(`https://www.agentmail.to/docs/messages`), mapping `from` to the correct
AgentMail `inbox_id`.

**2. DNS: a dedicated subdomain, isolated from `robotmoney.net`'s live root,
delegated to a separate, secondary Cloudflare account.** `robotmoney.net`'s
root DNS is live production and is not touched: MX `smtp.google.com`, SPF
`v=spf1 include:_spf.google.com ~all`, a live `google._domainkey.robotmoney.net`
DKIM selector, DMARC `p=none`, NS on Cloudflare
(`veda.ns.cloudflare.com` / `cash.ns.cloudflare.com`). AgentMail instead sends
from a dedicated subdomain (`notify.robotmoney.net`) mapping `SWARM_NOTIFICATION_EMAIL_FROM` to the AgentMail `inbox_id` `swarm@notify.robotmoney.net`, with its own MX/SPF/DKIM/
DMARC. That subdomain zone is handed off with a **single one-time NS
delegation record** in the primary Cloudflare account (the one holding
`robotmoney.net`'s zone) pointing at a **separate, secondary Cloudflare
account**'s nameservers. Every ongoing change — AgentMail's MX/SPF/DKIM/DMARC
records, and the adapter's own compute if it is deployed as a Cloudflare
Worker — happens only in that secondary account. The primary account is
touched exactly once, ever, for the delegation record; whoever operates the
adapter/compute gets no standing login or DNS-edit API token on the primary
account.

**Why AgentMail over the alternatives.** Both alternatives were seriously
evaluated and are **tabled for later reconsideration, not rejected on
technical grounds**:
- **Gmail API** is built for human-mailbox conversational use, not automated
  bulk/transactional sends to strangers; Google Workspace actively discourages
  that traffic pattern even under its ~2,000/day cap, and using it here would
  put swarm-applicant notification volume on the same reputation surface as
  staff mail.
- **Cloudflare Email Service** is a strong technical fit — nearly identical
  request shape to this repo's existing contract, and naturally
  subdomain-isolated — but it is a brand-new April-2026 public beta with no
  proven deliverability reputation yet, and adopting it would require
  explicitly reconciling with D13's scoping of the *primary* Cloudflare
  account to DNS+observability only. Worth revisiting once the beta matures.

**Why the delegation shape.** The repo owner set an explicit "maximal
paranoia" requirement: the Cloudflare account holding `robotmoney.net`'s live
zone must never carry standing access for whoever operates the mail adapter.
Cross-account subdomain NS delegation (confirmed supported via Cloudflare's
own docs and community) satisfies that with a single, auditable, one-time
record, rather than a shared login or a long-lived DNS-edit token scoped down
by convention only.

**Relationship.** Does **not** amend D13. D13 governs the *primary* Cloudflare
account holding `robotmoney.net`'s zone and confines it to DNS + observability,
no Worker, no software to deploy — that stays true unchanged; the one-time NS
delegation record is a DNS entry, not compute. This decision's compute, if any
lives on Cloudflare (the adapter as a Worker), lands only in the new
**secondary** Cloudflare account, which is a distinct account outside D13's
scope entirely. Consistent with D13, not a revision of it.

**Alternatives rejected.**
- **Google Workspace Gmail API** — tabled; wrong traffic shape for automated
  sends to strangers, risks staff-mail reputation and ToS exposure.
- **Cloudflare Email Service** — tabled; immature beta, and would need its own
  explicit D13 boundary reconciliation before adoption.
- **Sending AgentMail traffic from `robotmoney.net`'s apex/root** — rejected;
  would risk collision with the live Google Workspace MX/SPF/DKIM/DMARC
  records backing staff mail.
- **A standing DNS-edit API token or shared login on the primary Cloudflare
  account for the adapter operator** — rejected under the maximal-paranoia
  requirement; the one-time NS delegation confines all ongoing blast radius to
  the secondary account instead.

**Still open (tracked on issue #549, not resolved by this decision).** The
exact subdomain name, the AgentMail inbox_id mapping, and — separately — which
executed-in-CI test surface (recorded HTTP fixture vs. sandbox AgentMail
account) covers the adapter's real HTTP transport path, since that path has
never been exercised against any real or fixture-backed vendor endpoint in
this repo's test suite.

---

## D31 — One canonical member-avatar path, `/avatars/swarm/<id>.<ext>`; the v0 archive's pre-rename path is rewritten by the importer (issue #540)

**Decision.** The canonical public path for a swarm member's avatar is
`/avatars/swarm/<id>.<ext>`, carried in the jsonb `swarm_members.avatar`
column's `path` field. (There is no `avatar_url` column — the whole avatar
object, `{path, source_url, credit}`, is one jsonb value; see migration
`backend/migrations/0001_backends.sql`.)

That form wins because three of the four writers already agree on it: the
committed member manifests
(`frontend/public/data/swarm/manifests/members/*.json`, all three of them,
woon included), the schema those manifests are written against
(`.../members/_SCHEMA.md`, which specifies `/avatars/swarm/<id>.<ext>`
literally), and `backend/src/swarm/roster-seed.ts`'s `LIVE_ROSTER`. Only the
v0 archive disagrees: `backend/seed-data/v0-committee-archive.json.gz` stores
`/avatars/committee/<id>.jpg`, the path v0 published before the
committee → swarm rename (D28).

**The archive is not edited.** `seed-data/` is a checksummed verbatim copy of
what v0 published, regenerated by `backend/scripts/v0-seed-regenerate.ts` from
`robotmoney/v0-archive`; rewriting it would make the artifact stop being that.
The rename is applied by the importer instead —
`backend/scripts/v0-seed-bootstrap.ts`'s `canonicalizeAvatar()`, at the point
of insert — which is the rule that file already followed for the v0 fields v1
has no column for (`take.model`/`usage`, `snapshot.fetched_at`/`source_type`).

**Why this needed deciding at all.** Two pipelines write the same
`swarm_members` rows for the two house members. `runV0SeedBootstrap()` ports
v0's history; `seedLiveRoster()` (#529, gated on `SWARM_SEED_ROSTER`) states
who is seated now. The backfill never overwrites an existing row — it reports
the difference as drift, and `bun run prod-bootstrap` exits non-zero on any
drift. So on a deployment where both had run, a cosmetic path difference on
rows nobody had edited blocked the entire production bootstrap path. That is
also the ordering `prod-bootstrap` produces by itself: its migrations step runs
`migrate()`, which calls `seed()`, which seats the roster before the v0-seed
backfill step ever reads `swarm_members`. (Since #602 a read-only handle/id
namespace precheck runs ahead of both — it writes nothing and does not change
this ordering.)

**Second half of the same fix: an empty column is filled, not called drift.**
`seedLiveRoster()` owns only the profile columns the manifests carry, so the
rows it seats hold no `voice_md` and no `submit`. The backfill now fills a
column that is NULL on an existing member row rather than reporting it —
column-level "append-only: fills in what's missing", the rule that file
already applied to whole rows. Nothing non-NULL is ever touched, so the
never-overwrite contract is unchanged: a hand-edited tagline is still reported
and still survives. No credential column and neither `applied_at` nor
`activated_at` is read or written by the reconciliation.

**Consequences.**
- No image file is renamed or moved. This repo currently ships no `/avatars/`
  assets at all — `frontend/public/avatars/` does not exist, and the member UI
  falls back to a coloured-initials SVG when the file behind `path` is missing
  (`_SCHEMA.md`, "if absent, UI falls back to colored initials SVG"). The
  decision is about the URL the database stores; committing the images under
  `frontend/public/avatars/swarm/` remains the separate task `_SCHEMA.md`
  already describes.
- `woon` is included: its avatar is canonicalized to `/avatars/swarm/woon.jpg`
  even though it is off the live roster, because its committed manifest
  already says exactly that.
- The two orderings are pinned by tests in
  `backend/tests/v0-seed-bootstrap.test.ts` (both, in isolation) and
  `backend/tests/prod-bootstrap.test.ts` (the real orchestrator, with
  `SWARM_SEED_ROSTER=1`).

**Rejected alternatives.**
- **Regenerate the archive with `/avatars/swarm/` baked in.** It would make
  `seed-data/` stop being a verbatim copy of v0, and the next regeneration
  from `robotmoney/v0-archive` would silently undo it.
- **Change the manifests to `/avatars/committee/`.** It would reinstate the
  pre-rename name D28 removed, on the public surface, and contradict
  `_SCHEMA.md`.
- **Exempt `avatar` from the drift comparison.** It would stop reporting a
  real corruption of a real column in order to hide one known-benign
  difference.

---

## D32 — One-time claim makes the admin credential durable; the per-boot token is superseded, not revoked (issue #553)

**Decision.** The admin credential can be claimed exactly once:
`POST /api/admin/claim`, authorized by the *current* admin credential (on a
first-ever boot, the per-boot token the interactive TUI displays), persists
the sha256 hex of an operator-chosen password (≥ 12 characters) into the new
one-row `admin_credential` table (migration
`backend/migrations/0028_admin_credential.sql`). While that row exists,
`backend/src/api/auth.ts`'s `isPrivileged()` treats the stored hash as the
durable operator credential: it survives every restart, so `bun run smoke` /
`bun run smoke:stage` re-boots stop rotating the operator out — the lockout
this issue is about. A public boolean probe, `GET /api/admin/is-claimed`,
lets the smoke boot decide whether the TUI may display the per-boot token.

**Superseded, not revoked.** After a claim, the per-boot `ADMIN_TOKEN` env
mint *remains valid* — but only as the stack-internal automation credential,
and it is never displayed again (the TUI shows the `Admin pass` line only
once the post-ready probe confirms *unclaimed*). This is deliberate, and is
the refinement of the issue's "stop minting" sketch: the smoke's own drivers
(swarm session runner, onboarding driver, e2e children) authenticate against
`X-Admin-Token`-guarded routes with the per-boot token threaded through
in-process, and the server holds only a *hash* of the claimed password, so it
cannot hand the claimed secret to that automation. Revoking the env token on
claim would kill the standing smoke's core loops on the next boot. The issue's
test plan anticipates exactly this shape ("or is superseded, per the chosen
design").

**`RM_ALLOW_INSECURE` stops opening the gate once claimed.** A claim is an
explicit security opt-in; after it, only the claimed password or the current
boot's own token authorizes — never the insecure-mode bypass.

**Hashing scheme.** sha256 hex via the existing `hashKey()`
(`backend/src/lib/keys.ts`) — the same never-plaintext posture already used
for swarm member access keys — compared constant-time (`timingSafeEqual`),
like every other credential in `auth.ts`. Not argon2/bcrypt: `isPrivileged()`
runs on every admin/swarm-admin request (the dashboard polls), a KDF per
request is a hot-path cost, and the credential is bearer-token-shaped
(`X-Admin-Token`), with the 12-character minimum bounding the offline-crack
exposure. The migration also `REVOKE`s the queue worker role's default grant
on the table so a worker-role compromise cannot read the hash at all.

**Fail closed and loud.** A database failure inside `isPrivileged()`
propagates to the router's sanitized 500 — it never silently falls back to
the env token while a claim might exist.

**Recovery path.** There is no self-serve reset for the single smoke admin. A
forgotten claimed password is an explicit operator action against the
database — `DELETE FROM admin_credential;` (or `bun run smoke:clean` for a
full wipe) — which re-arms the first-boot one-time-claim state, restoring
today's "restart shows a fresh TUI token" behaviour.

---

## D33 — A member may amend its take: append-only revisions, latest wins, capped per session (issue #573)

**Decision.** A seated swarm member may amend and resubmit its take inside a
session. Amendment is **append-only**: each revision is its own immutable row in
`swarm_recommendations`, with its own `gen_random_uuid()` permalink, its own
`received_at`, its own nonce, and its own Ed25519 signature over its own
content. **An accepted take's content is never `UPDATE`d.** Every read that
means "the session's takes" resolves **latest-per-member**. The volume is
bounded by a **per-member-per-session count cap** (`SWARM_TAKE_REVISION_CAP`,
currently 5), enforced server-side and refused **before** the signature is
verified. Amendment is confined to the session's **open, pre-aggregation**
window.

Migration `0028_swarm_take_revisions.sql` adds `revision integer NOT NULL
DEFAULT 1`, drops `UNIQUE (session_id, member_id)`, and replaces it with
`UNIQUE (session_id, member_id, revision)`. `UNIQUE (member_id, nonce)` is
untouched.

**Why this supersedes an unwritten rule.** `docs/architecture.md` asserts the
immutability of this table in four places (§9.4's "append-only" table list,
§2's "Preserve accepted swarm recommendations as append-only signed records.
Admins cannot edit or delete them", §3's "one per `(session_id, member_id)`",
and US-A2's "No admin endpoint can update `swarm_recommendations`") and none of
them had an ADR behind it. Three of the four survive this change **intact and
strengthened** — nothing is edited, nothing is deleted, no admin endpoint
writes. Exactly one is now false: takes are no longer one per
`(session_id, member_id)`. That is the statement this decision replaces, and it
is replaced with a constraint of the same kind rather than with nothing.

**Why append-only revisions and not in-place `UPDATE` with an
`expectedVersion`.** In-place was the cheaper option: the `expectedVersion` /
409 `stale_version` idiom already exists and is tested on members, subjects and
sessions (`backend/src/swarm/admin.ts`), it keeps every read path correct with
zero changes, and it keeps the permalink stable. It was rejected because:

- **It makes the permalink non-referential.** `/swarm/takes/:id` is titled a
  *verification receipt*, and `runbook.html` instructs members to "share that
  permalink as proof of participation". Under in-place amendment that URL
  addresses "whatever this member last said": the prior signed artifact is gone
  and `Filed <time>` either lies or silently moves. A receipt that can change
  what it attests is not a receipt.
- **It is the defect this repo has already named as structural.**
  `docs/v0-v1-quant-platform-parity-report.md` calls out the platform's binding
  constraint as "Any raw-data revision silently rewrites published history with
  no version bump and no audit trail… v1 is not reproducible against itself."
  Reintroducing that shape on the one table whose entire purpose is
  attributable, verifiable history would be a deliberate repeat.
- **The codebase already does append-only four times over** — `audit_log`,
  `swarm_session_events`, `swarm_agent_health_events`, `agent_activity_log` —
  plus the frozen-snapshot idiom of `swarm_session_members` ("later member
  changes never rewrite history").
- **It is free cryptographically.** `canonicalizeSubmission`
  (`contract/src/signing.js`) already signs `nonce`, `UNIQUE (member_id, nonce)`
  is global and permanent, and the client already mints a fresh
  `crypto.randomUUID()` per submit. Every revision is therefore already a
  distinct signed artifact: **no protocol change, no new key material, no rmpc
  rebuild, no external-agent breakage.** The one existing member-authenticated
  mutation, `updateMemberProfile` (D-less, issue #325), is a last-write-wins
  partial patch — it is *not* precedent here, because a profile is a mutable
  description of a member and a take is a dated, signed claim.

**The cap is part of the decision, not an addendum.** Until now
`UNIQUE (session_id, member_id)` was the **only** server-side bound on a
member's write volume, and members are unattended LLM-driven agents shipped
with a `while :; do … sleep 5; done` poll loop. Relaxing that constraint without
a replacement would leave nothing between a looping agent and unbounded writes.

- **A count, not a rate.** `swarm_member_keys` has no `last_used_at` and no
  counter, so a time-based throttle needs new per-token state; a count is
  checkable in the same statement as the write and bounds total volume rather
  than merely sustained rate.
- **Refused before the Ed25519 verify.** This is a requirement, not an
  optimisation. Before this change the duplicate 409 fired *last* — after the
  token lookup, the session lookup, two roster queries, `publicKeyFor` and a
  full signature verification — so a looping agent burned the expensive path on
  every rejected call. The cost asymmetry matters: an external member pays for
  its own inference on its own key, so runaway *cost* lands on its operator,
  while *our* exposure is write volume, DB growth and CPU. The cheap refusal is
  what makes the removal of the constraint safe.
- **The refusals are distinguishable.** `amendment cap reached`,
  `nonce already used by this member (replay)`, `amendment window closed
  (session already aggregated)` and `submission window closed` are four
  different answers, and an agent must be able to tell "stop" from "retry" from
  "re-mint a nonce". The old single 409 —
  `already submitted (member/nonce or session/member)` — named two causes at
  once precisely because it could not.

**Amendment is confined to the open, pre-aggregation window.**
`aggregateSession` copies take prose **verbatim** into
`swarm_recommendation.disagreements[].positions[].view` and is never recomputed
(`publishSession` is an unconditional `UPDATE` that does not re-aggregate). An
amendment landing after aggregation would leave a published session quoting a
body the take no longer carries, next to a live take list showing the new text.
The alternative — making aggregation re-entrant — was rejected as a much larger
change to the one code path whose output is published. #570 made the window a
subject's full cadence interval, so the confinement is not restrictive in
practice. The gate is **amendment-only**: a *first* take is still governed
solely by the advertised `windowClosesAt`, which is #570's published contract
and stays exactly as it was.

**Consequences.**

- Three read paths resolve latest-per-member via `DISTINCT ON`: `withTakes`,
  `aggregateSession`, `getMemberTakes` (`backend/src/swarm/domain.ts`).
- `aggregateSession` computes participation and quorum from **distinct
  members**, not `takes.length`. Left unfixed, revisions would have pushed
  published participation above 100%.
- `frontend/public/views/swarm/session.html` keys its two take loops on
  `memberId`, so a latest-per-member regression upstream surfaces as a loud
  Alpine duplicate-key error rather than two cards for one member.
- A superseded permalink keeps resolving, keeps verifying independently against
  the member's active key (`toVerifiedTake` re-verifies at read time, and every
  revision signs its own bytes), and renders a "superseded by →" pointer. It
  never 404s and never substitutes content.
- The public contract gains `SwarmTake.revision` and
  `SwarmTakeReceipt.supersededBy`. `contract/src/signing.js` is **unchanged**.
- `frontend/public/views/docs/investment-swarm/api-reference.html` and
  `frontend/public/skills/swarm-onboarding/SKILL.md` are updated in the same
  change: both promised external operators the exact guarantee this removes
  ("a second submit for the same session is rejected anyway"; "one take per
  session, duplicate-safe"; "re-running is always safe").

**Rejected alternatives.**

- **In-place `UPDATE` with `expectedVersion`** — see above.
- **Re-running aggregation on amendment** instead of confining the window. It
  makes the one published code path re-entrant, and it still leaves a
  window in which a reader saw a synthesis quoting prose that has since been
  withdrawn.
- **A per-IP request-rate limiter.** `handleSwarm(req, url)` is called without
  `clientIp` (`backend/src/api/index.ts`), so the swarm surface structurally
  cannot do IP limiting without a signature change; and the subject here is one
  authenticated member's write volume, which a per-IP window measures only by
  accident.
- **No cap at all, relying on the aggregation gate.** The window is a full
  cadence interval; unbounded writes inside it is the runaway case.

## D34 — The api's handle/id namespace boot gate is fail-closed, bounded, observable, and overridable (issue #602)

**Decision.** `backend/src/api/index.ts` refuses to bind a port when
`swarm_members` holds a handle/id namespace violation, and that refusal carries
three explicit properties, each of which is a choice rather than an omission:

- **Bounded.** The check may add at most a wall-clock budget
  (`PG_NAMESPACE_GUARD_TIMEOUT_MS`, milliseconds, default `8000`) to the boot,
  for any database state **and any value of that variable**. It runs on its own
  connection with server-side `statement_timeout`, `lock_timeout` and
  `connect_timeout` (the mechanism `src/db/worker-client.ts` already uses), and
  each retry races the time remaining. The budget is *validated*, not
  `Number()`-coerced: a non-finite, non-positive, or above-ceiling value is
  ignored with a loud `[api]` line and the default is used. `Number("8s")` is
  `NaN`, and a `NaN` budget makes every deadline comparison false — the retry
  loop would spin forever in front of `Bun.serve`, which is the same silent
  total outage the gate exists to prevent, reached through the gate's own knob.
  The ceiling is `2147483647`ms, the largest delay a timer can hold: above it
  the runtime clamps the delay to 1ms, so every attempt expires instantly and
  the loop spins the same way — a positive, finite, entirely plausible-looking
  value with the same effect as `NaN`. It is **rejected rather than clamped**,
  because clamping would remove the spin but keep a ~24.8-day boot during which
  no port is bound, and a ten-digit millisecond count is a unit error of the
  same class as `8s`, not a deliberate multi-week budget. A bad env var degrades
  to the default rather than throwing, because refusing the boot over an
  operator typo trades one outage for another.
- **Observable without changing the status code.** `/health` reports
  `handle_namespace: "clean" | "unchecked" | "overridden"` and keeps answering
  **200** in all three cases.
- **Overridable, loudly.** `RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1` downgrades
  the refusal to a warning, logged at boot and visible at `/health` for the
  life of the process. A boot that finds the variable set and **no** violation
  logs that the guard is DISARMED: `overridden` cannot carry that state (it
  means a violation *is* being served), so without a separate line an override
  left on after the repair is indistinguishable from a healthy boot — which is
  the guard's own harm, reached through its own escape hatch.
- **Both controls are enumerated in `docker-compose.yml`'s api
  `environment:`.** That block is an allowlist — no compose file here has an
  `env_file:` and `backend/Dockerfile` sets no `ENV` — so a control it does not
  name never reaches the container, and the failure is silent in both
  directions: the operator sets the variable, and the api's refusal log tells
  them to set the variable they just set. A documented emergency control that
  cannot be delivered is worse than none, so the delivery path is asserted
  against real `docker compose config` output over every composition the repo
  boots (`scripts/tests/integration/smoke-compose-config.test.ts`) — the
  spawn-based backend tests structurally cannot see it.

**Why bounded is not optional.** This is the only database round trip that has
ever stood between this process and its port, and the process also serves the
entire static frontend (D29). An `ACCESS EXCLUSIVE` lock on `swarm_members` — an
ordinary deploy-window event — blocks the detection SELECT while the guard's
readiness probe returns immediately, because catalog reads take no lock on the
table. A retry loop that consults its deadline only after a rejection bounds a
database that *rejects* and bounds nothing about one that *blocks*: the process
would hang with no port bound and not one log line written, and
`restart: unless-stopped` does not restart a process that hangs instead of
exiting. Asserted rather than measured by hand:
`backend/tests/api-boot-handle-namespace-guard.test.ts` boots the real
entrypoint against a `swarm_members` held under `ACCESS EXCLUSIVE` for the whole
boot, and asserts it serves `/health` inside the budget with the lock still
held — a test the pre-fix loop cannot pass, because it never reaches
`Bun.serve` at all.

**Why the status code does not move.** An "unchecked" boot is a real risk, but
making `/health` non-200 for it would fail the compose healthcheck (which keys
on `.ok`) whenever Postgres is slow to come up — trading a wrong-attribution
risk for a restart loop on the whole site. The field is the signal; the code
stays 200.

**Why an override exists at all.** The sibling fail-closed boot guard,
`assertNoVaultAddressCollision()`, fails on **configuration**, which an operator
fixes by editing `.env` and redeploying with the tooling they already have. This
one fails on **data**, and its repair needs an interactive SQL session against
production. A data gate with no way out is an operational hazard: if it ever
misfires, or if the repair itself needs the site up, the only remaining move is
to ship different code during an outage. The override is deliberately noisy
rather than quiet, because the failure mode of an escape hatch is that someone
leaves it on.

**Consequences.**

- `docs/runbooks/deployment.md` §2.1 carries the operator surface: the exact
  repair statement (one per refusal line, always the holder's handle), how to
  get a `psql` session in both topologies, the override, the rollback pointer,
  and the `/health` field.
- The guard is a **boot-time snapshot**. There is no periodic re-check, so a
  `pg_restore` into a live database is not re-validated until the api restarts;
  the runbook and `src/db/handle-namespace.ts` both say so rather than leaving
  the limit implied.

**Rejected alternatives.**

- **Periodic or request-path re-checking.** It would close the restore-into-a-
  live-stack window, but it puts a database read on a hot path and needs its own
  failure semantics; the documented restart is the smaller correct answer for
  now.
- **Failing `/health` on an unchecked boot.** See above — a worse outage than
  the one being guarded.
- **No override ("fail-closed means fail-closed").** Defensible for a
  configuration gate; not for a data gate whose repair path runs through the
  database the operator may not be able to reach.

---

## D35 — `robotmoney.network` is the canonical origin; `robotmoney.net` is retained for mail and for the deploy subdomains (issues #592, #603, #628)

**Decision.** The canonical public origin is `https://robotmoney.network`.
`robotmoney.net` is **not** decommissioned. Three classes of reference, and the
split between them is deliberate rather than unfinished work:

- **Canonical web surface → `.network`.** `ORIGIN` in
  `frontend/public/assets/js/app/seo.js` and `scripts/prerender.ts`,
  `sitemap.xml`, `robots.txt`'s `Sitemap:`, `llms.txt`, `index.html`'s
  canonical/OpenGraph/JSON-LD, `SWARM_ONBOARDING_SKILL_URL` in
  `contract/src/swarm-application.js`, and the operator-facing docs. Before #603
  both apexes served `canonical → https://robotmoney.net/`: the new domain told
  every crawler that its canonical identity was the flagged old one, which is
  the opposite of the move's purpose.
- **Mail stays `.net`.** `robotmoney.network` publishes a **NULL MX** (`0 .`,
  RFC 7505) — a positive declaration that the domain accepts no mail.
  `robotmoney.net` has Google Workspace (`smtp.google.com`). So `hi@`, `swarm@`,
  `noreply@`, `research@`, `SWARM_NOTIFICATION_EMAIL_FROM`, and the AgentMail
  mapping `swarm@robotmoney.net → swarm@notify.robotmoney.net` all stay. A
  migrated address does not degrade, it hard-bounces, and the two that would
  break first are the member key-rotation escape hatch
  (`recoveryMailto()`, `static-views.js`) and the waitlist POST fallback
  (`apply-form.js`) — the paths that exist precisely for an operator who is
  already locked out or already hitting an API error.
- **Deploy and ingress subdomains stay `.net`.** `site.`, `swarm.`, `app.` and
  `staging.` are on the `.net` zone under D13's host-based routing, with D29's
  api process serving the cutover host. The Cloudflare API token is scoped to
  the `robotmoney.net` zone (`docs/runbooks/deployment.md`). Rewriting these in
  a runbook produces hostnames that do not resolve, so the runbook and
  `cloudflared.config.example.yml` keep them.

**Why this needs writing down.** `robotmoney.net` is a strict substring of
`robotmoney.network`. Two consequences, both of which have already bitten:

- The half-match is not hypothetical and it is not only a replace-direction
  hazard: `scripts/prerender.ts` once spelled the host out next to `ORIGIN`, and
  when the site moved, `robotmoney.net` matched *inside* `robotmoney.network`,
  captured `work/…` as the route, and prerendered every page into an `ork/`
  directory. The fix there is the pattern to copy — **derive the host from
  `ORIGIN` rather than respelling it** — because a second literal is what rots.
  Where a literal is unavoidable, match `robotmoney\.net(?!work)`; a bare
  `s/robotmoney\.net/robotmoney.network/` yields `robotmoney.networkwork`.
- No repo-wide guard currently enforces that lookahead.
  `scripts/tests/unit/api-reference-no-dead-hosts.test.ts` asserts
  `/swarm\.(?:staging\.)?robotmoney\.net/i` without it, which is safe only
  because no `swarm.*.robotmoney.network` host exists — it would false-positive
  on the live host the day one does.
- More expensively: the substring makes a "finish the rename" pass look like
  tidy-up while it breaks mail delivery and tunnel ingress. The remaining `.net`
  strings are load-bearing, not residue, and nothing in the diff says so. A
  reader who greps for the old host and finds ~113 hits will otherwise conclude
  the migration stalled and complete it.

**Not done here.** The apex `robotmoney.net → robotmoney.network` 301 (RM-57) is
deliberately deferred behind RM-41. Unknown paths still answer **200** rather
than 404 (`backend/src/api/static.ts` — "so nothing 404s"), so redirecting the
apex now would funnel the old domain's inherited reputation flags onto ~100 dead
URLs and register them as soft 404s. `frontend/prod/_redirects` is **inert** —
Netlify/Pages syntax, and we serve from a Bun process behind cloudflared, so
nothing parses it; it is kept and marked rather than deleted because it
documents intended host policy. Real redirects belong in Cloudflare rules or the
app router.

**Rejected alternatives.**

- **Move mail to `.network` with the site.** Needs MX/SPF/DKIM provisioning and
  a Workspace domain move, and during the cutover every published support
  address bounces silently — for no user-visible gain, since the address is
  read from the page rather than typed from the domain.
- **Rename the deploy subdomains too, for consistency.** The zone, its token
  and D13's routing are all `.net`-scoped; consistency here buys nothing and
  costs a broken ingress plus a runbook that cannot be followed.
- **Delete `_redirects` outright.** It is the only written statement of intended
  host policy; deleting it loses that, whereas marking it inert prevents the
  actual failure (someone adding a rule that never fires).

---

## D36 — A block tag on the reads we already issue; not the archive indexer D16 rejected (issue #709, clarifies D16, reverses Open Question 9)

**Decision.** `backend/src/chain/base-rpc-client.ts`'s shared `RpcCallOptions`
carries an optional `blockTag`, applied at the only two sites in the backend that
hardcoded `"latest"` — `ethCall` and `ethGetBalance` — as `opts.blockTag ??
"latest"`. The backend may therefore read historical chain state at a pinned
block in order to **reconstruct chain-derived history it is missing**, and may
write the result into `wallet_balance_samples` / `wallet_sleeve_samples` tagged
`provenance='backfilled'`.

**Why this is not what D16 rejected.** D16 rejected *"an archive indexer to
reconstruct gap-free pre-launch history"* as out of scope for #84. An archive
*indexer* means ingesting and persisting chain history yourself: a new component,
a new store of chain events, its own reorg and consistency semantics. This is a
parameter on reads the app already makes, against the node it already reads.
`https://mainnet.base.org` — the default `BASE_RPC_URL` — answers archive state
queries, and returns a correct `"0x"` (not a `latest` fallback) for a
pre-deployment read, which is what makes the answers verifiable rather than
merely plausible. **D16's rejection of the component stands unaltered.** What is
corrected is an unstated premise inside it: that reconstructing the history
requires that component. It does not.

**The hole this exists to close.** The wallet/AUM series is `remediationClass:
"C"`, and before this the field had *zero behavioural consumers* —
`detectAllGaps` had exactly one caller, the read-only `GET /api/admin/gaps`. The
pipeline could see its own holes and had no way to close them. The gap's width is
`(DB bootstrap date) − 2026-06-26`, so it does not merely persist: it re-opens
wider on every database rebuild.

**Open Question 9 is reversed, explicitly.** `chain/token-prices.ts` stated that
historical valuation comes from the persisted series *"NOT from a re-fetched
OHLCV series"*, on the premise that GeckoTerminal OHLCV may not reach back far
enough for illiquid ROBOTMONEY/BNKR. It does; its daily candles are
UTC-midnight-aligned, matching the day key the sampler already writes. That
header is amended in the same change rather than left contradicting the code.
Same vendor, different endpoint — the `token-prices.ts` host constraint is
unchanged and still enforced by `tests/no-new-vendor.test.ts`.

**Scope fence.** Approval covers the block tag and a bounded, scheduled repair of
detected gaps, and nothing wider:

- **No archive indexer**, no persisted chain-event store, no new vendor, no new
  host.
- **No standing Class C reconciliation loop.** Repairing a known finite gap is a
  different cost problem from re-verifying every chain day forever. Class C gets
  an executor; it does not get a continuous verifier until there is a keyed
  provider.
- **No independent RPC limiter.** The provider meters **per-IP**, so in-process
  isolation cannot create budget: a second limiter beside the live sampler's sums
  to 2× against one bucket and 429s both, *causing* new gaps while repairing old
  ones. That is the 2026-08-10 storm in #651. One token bucket lives in the
  shared transport and every read draws from it — and note that
  `BASE_RPC_MAX_CONCURRENCY` is **not** that control: it bounds in-flight
  requests, and on a lane that claims one job at a time in-flight never exceeds
  1, so it paces nothing.
- **No live-path change.** `?? "latest"` is the default, and the silent-zero rule
  below is armed only for block-addressed reads.

**Honesty rules, carried by this decision rather than left to an implementer.**

- **`success: true` with `returnData: "0x"` is a hard failure for that day, never
  a zero.** It means there is no contract at that address at that block.
  `decodeUint256` maps it to `0n` by long-standing design and the live path
  depends on that; a backfill that inherits it does not read a balance of zero,
  it invents one — and inside a summed AUM total an invented zero is
  indistinguishable from a real drawdown once written.
- **A day is atomic.** Round 2 (`convertToAssets` NAV) depends on round 1's
  output, so a half-read day yields a total that is plausible and wrong. Nothing
  is written for a day that did not read completely.
- **A missing price fails the day** rather than valuing a real holding at zero.
- **Repair fills holes; it never restates history.** A day the sampler already
  wrote is never overwritten (§7.1's append-only reading).
- **An unrepaired day keeps looking unrepaired.** A day that cannot be read
  honestly stays in the gap report. A day that exhausts its retry ceiling stops
  costing RPC but remains a *disclosed* gap — never interpolated.
- **Backfilled rows stay distinguishable from `'live'`** for the life of the
  data. `'backfilled'` was already in the DTO union via #615, so no contract
  change was needed.

**PD6 is the gate, and it is also the opt-in.** The measured budget (~5-token
bucket refilling at ~0.55 calls/s, metered per-IP and per sub-call, structural
batch cap 10, Multicall3 giving 27:1 leverage) was taken from a developer IP. The
bucket's parameters are therefore **configuration, not constants**, and a live
backfill **refuses to run** until `BASE_RPC_MAX_CALLS_PER_SEC` is set. Unset
means no pacing (exactly the prior behaviour) *and* means the seeded
`ops.repair_gaps` schedule is a no-op — so a smoke or CI boot never sweeps months
of history, and a deployment opts into repair by measuring its own limit.

> **Superseded in part (2026-08-22): the opt-in is retired; the parameters stay
> configurable.** Making "unset" mean *unpaced and unhealing* meant the release
> that carries this feature shipped it inert, and the number it was waiting for
> does not exist to be looked up: Base publishes no rate limit for
> `https://mainnet.base.org`, only that its public endpoints are "rate-limited
> and not suitable for production traffic". So the transport now paces from a
> conservative constant — `DEFAULT_RATE_PER_SEC = 0.25` (half the measured
> refill, ~7.5× what the live samplers draw) with a burst of 5 (the measured
> bucket depth) — and `ops.repair_gaps` dispatches on an ordinary live
> deployment without configuration. Everything else above stands: it is still
> ONE bucket for the whole app, the value is still overridable with
> `BASE_RPC_MAX_CALLS_PER_SEC`, and `BASE_RPC_MAX_CALLS_PER_SEC=0` still means
> no limiter and no sweep — now an explicit opt-OUT rather than the default. A
> guess that is too low costs throughput; the 429/`-32016` feedback into the
> bucket corrects it downward. A droplet measurement still improves the number,
> and PD6's real question — a keyed provider on its own bucket — remains open.

**Self-healing means scheduled, not manual.** The repair is an ordinary producer
in the analytics lane — `ops.repair_gaps` (dispatch by `remediationClass`) and
`wallet.backfill_day` (one day per job) — and its work list is re-derived **from
the data** on every run, never from a cursor. Nothing about repair lives in a
migration or a one-shot script. Migration 0033 creates a permanent date→block
cache and a per-day checkpoint and inserts **no rows**.

**Rejected alternatives.**

- **Build first, record afterwards.** Three written statements (D16,
  `token-prices.ts`'s header, #294's out-of-scope list) contradicted the work, so
  it would have arrived at review with the record against it — the most expensive
  moment to unwind.
- **Abandon Class C repair and disclose the hole permanently.** Coherent and
  honest, but it makes the AUM gap permanent *and* growing, since its width
  re-opens on every rebuild.
- **Give the backfill its own rate limiter so it cannot starve the sampler.**
  Backwards: the limit is per-IP, so a second limiter doubles the offered rate
  against one bucket. Isolation here creates contention, not headroom.
- **A superseding ADR for D16 rather than this clarification (PD2).** D16's
  rejection names a component this does not build; superseding it would discard a
  judgement that remains correct.
- **Approximate SP500 in the backfill (PD7).** It is not a chain read at all, and
  #648 records that the column splices two different measurements. It is skipped,
  and a repaired day carries no SP500 row — honest sparseness, which
  `WalletHistoryPoint` already documents.

---

## D37 — Strategy-account positions are baked constants split by valuation standard; an idle-only NAV is disclosed, not refused (issue #642)

**Decision.** Four parts, all in `backend/src/config.ts` and
`backend/src/chain/wallet-valuation.ts`:

1. The strategy positions are **baked constants**. The five
   `STRATEGY_VAULT_*_ADDRESS` env reads and the `STRATEGY_VAULT_CANDIDATES` env
   indirection are removed, and nothing is added to `docker-compose.yml`,
   `x-worker-env`, or `.env.example`.
2. They are split by **valuation standard**, not lumped in one list.
   `STRATEGY_VAULTS` holds only verified ERC-4626 shares, read as
   `convertToAssets(balanceOf(account))`. `STRATEGY_UNDERLYING_POSITIONS` holds
   positions whose `balanceOf` is already denominated in the underlying and are
   summed directly, never converted.
3. `cUSDCv3` is **excluded from both lists**.
4. An idle-USDC-only NAV is **disclosed per leg** as
   `WalletHolding.strategyNavIdleOnly`, persisted by the sampler (migration
   0032) so the zero-RPC request path can serve it; an empty position list is a
   boot **warning**, never a refusal.

**Context — and a retraction.** The previous design (#120/#145) required an
owner-maintained vault list delivered through five env keys, justified by this
sentence, which reached `config.ts` as settled fact:

> the agent rotates vaults every 1-2 days per the #120 investigation

**That claim is withdrawn.** It originates as the auto-loop's own *default
rationale* in decision issue #145, whose checkboxes were never ticked by the
owner. It was auto-applied at the seven-day timeout and then written into a
source comment citing #120 — which established no such thing; #120's finding was
that both addresses revert on `balanceOf`, and its stated deliverable, owner
confirmation of the correct valuation, never arrived. Every later repetition,
including `docs/architecture.md` §12, traced back to that one
sentence. This is worth recording as a failure mode in its own right: an
auto-applied default acquired the authority of a verified finding purely by
being written down in code and then cited.

**Verified on-chain (Base mainnet, 2026-08-16)** — the facts that replace it:

| Account | State |
|---|---|
| ZYFAI-SS1 `0xC125…976D` | 0.000044 USDC, airdrop spam (`AGENT`, `SHOPEE`, `OCTA`), **no position at all** |
| GIZA-SS1 `0x8E5c…8795` | `gtUSDCp`, `steakUSDC`, `aBasUSDC`, `cUSDCv3` held **simultaneously**, all dust |

| Address | Standard | Evidence | Placement |
|---|---|---|---|
| `gtUSDCp` `0xee8f…4b61` | ERC-4626 | `decimals()` 18, `asset()` = USDC | vault list |
| `steakUSDC` `0xbeef…83b2` | ERC-4626 | `decimals()` 18, `asset()` = USDC | vault list |
| `aBasUSDC` `0x4e65…c0ab` | Aave aToken | `decimals()` 6, `asset()` **reverts** | underlying list |
| `cUSDCv3` `0xb125…eb2f` | Compound III Comet | `decimals()` 6, `asset()` **reverts** | excluded |

Holding four candidates at once is a portfolio, not a rotation. Present NAV
impact of the whole defect is **≈ $0** — this is a correctness fix, not a
recovery of misvalued capital.

**Why constants and not env keys.** The env mechanism could not work at all: no
compose `environment:` block named any of the five keys, and that block is the
only delivery path (no `env_file:`, no Dockerfile `ENV`), so the list was
unconditionally empty in every containerized deployment. Given the addresses are
stable, on-chain-verifiable facts rather than per-deployment configuration, the
owner ruled against adding keys to the allowlist — which is reserved for secrets
and operator escape hatches — and for the treatment `resolveRobotmoneyToken()`
and `resolveWeth()` already use: bake the real address, review a change to it.

**Why the split is the actual bug fix.** `convertToAssets` is an ERC-4626
method. Two of the five original candidates do not implement it, and on Base a
call to it reverts. A reverted sub-call fails its whole key, so the moment
anyone had populated the old uniform list with `aBasUSDC` or `cUSDCv3`, both
strategy legs would have degraded to `'stale'` — reproducing the exact #120
failure the vault list existed to fix. The undeliverable env keys were, in that
sense, the only thing preventing the design from failing. Guarded by
`backend/tests/api/wallet-balances.test.ts`, which asserts from decoded
Multicall3 sub-calls that `convertToAssets` reaches the ERC-4626 vault and
nothing else; it fails against a uniform implementation.

**Why `aBasUSDC` is valued inside the strategy leg rather than as its own
series.** An aToken rebases 1:1 with its underlying, which is the rule
`valuationKind: "aave"` / `resolveAaveATokens()` already applies to a
*prop-wallet* aToken leg; this applies that same rule to a position held by the
smart account. Routing it through `resolveAaveATokens()` literally would surface
it as a ninth top-level series, splitting one account's NAV across two chart
lines and breaking the eight-fixed-series shape asserted in the `WalletBalances`
DTO and `frontend/test/browser/performance-view.spec.ts`. GIZA-SS1's aToken
balance is part of GIZA-SS1's NAV, so it belongs inside that leg.

**Why `cUSDCv3` is excluded rather than given a Comet path.** It is not
ERC-4626, so it cannot join the vault list. A Comet path would require knowing
how Comet denominates `balanceOf`, and that was **not** verified on-chain — so
writing one would mean inventing a valuation rather than applying a checked one,
which is the same class of mistake as the rotation claim. The position is dust,
so exclusion costs ≈ $0 while a guess risks a wrong number in the fund's NAV.
Revisit if a Comet balance ever becomes material; the test asserts the address
is never touched until then.

**Why an idle-only NAV is disclosed, and why as a field.** ZYFAI-SS1 holds
nothing, so its NAV is idle dust — a real, non-reverting read that rendered
identically to a working strategy leg. `strategyNavIdleOnly` is derived from the
read (not from configuration, which is now a compile-time constant and would
disclose nothing) and is three-valued: `true` idle-only, `false` a position
contributed, **absent** for not-applicable or not-known — a degraded read, a
seeded row, a pre-0032 sample. It is not a new `WalletHoldingProvenance` value
because provenance answers *where the number came from* and that answer is
unchanged; folding composition into that enum would silently re-bucket the leg
for every consumer of `historyProvenance` and the non-live badge, and #145
recorded that the owner declined a distinct provenance for these legs.

**Why warn and not refuse.** The sibling guard
`assertNoVaultAddressCollision()` throws because a collision **double-counts**:
arithmetically wrong, unservable. An idle-only NAV is merely incomplete.
Refusing to boot would take down the `api` — which also serves the entire static
frontend (D29) — plus all three worker lanes and every unrelated pipeline they
run, for a condition the site has survived since launch. With the lists now
baked, the warning fires only if a code change empties them, which is precisely
when a silent regression would otherwise ship unnoticed.

**Consequences.**

- Migration 0032 adds `wallet_balance_samples.strategy_nav_idle_only`, nullable
  and three-valued. A `NOT NULL DEFAULT false` would have asserted "positions
  contributed" about thousands of historical rows nobody measured that way.
- The request path still makes zero RPC calls (issue #118); it echoes what the
  sampler recorded rather than recomputing.
- `docs/architecture.md` §12 (then `data-self-healing.md` §10.1) is corrected, with the original
  text retained so the correction is auditable.
- Both accounts being effectively empty is an **owner** question — wrong
  addresses, capital moved, or legs wound down — and is explicitly out of scope.

**Rejected alternatives.**

- **Making the five env keys deliverable** (the original plan for this issue,
  built and then reverted). It would have shipped a working delivery path for a
  list that should not be operator-configured, and left the non-ERC-4626 revert
  waiting for whoever populated it first.
- **On-chain discovery of the position set.** ZYFAI-SS1 holds airdrop spam
  (`AGENT`, `SHOPEE`, `OCTA`); a "value everything this account holds" scan would
  price airdropped tokens into the fund's NAV. The set stays an allowlist.
- **A new provenance value for idle-only legs.** See above.
- **Refusing the boot on an empty list.** See above.

---

## D38 — `seed-provenance-verify` runs as a `prod-bootstrap.ts` deploy step, not a worker cron (issue #638)

**Decision.** `backend/scripts/seed-provenance-verify.ts`'s core logic is
split out into an exported `runSeedProvenanceVerify(clean)`, and
`backend/scripts/prod-bootstrap.ts` calls it (`clean=true`) as a fourth,
final `seed-provenance:verify` step alongside `v0-seed:bootstrap` and
`edgar-seed:bootstrap`. It runs on every `bun run bootstrap` /
`prod-bootstrap.ts --already-migrated` invocation — the same real deploy path
`docker-compose`'s `Stack.up()` already drives for the `archive` scenario
(`scripts/lib/smoke-main.ts`) and the one `bun run bootstrap` (root
`package.json`) drives standalone. `main()` stays as a thin CLI wrapper around
the same core, for the manual/CI usage `backend/tests/seed-provenance-verify.test.ts`
already exercised.

**Why not the `ops.repair_gaps` worker cron (issue #638's suggested "natural
home").** `worker/handlers/repair.ts` was investigated first, and rejected on
two independent, structural grounds, not preference:

- **The database refuses the write.** Migration `0016_worker_role.sql`
  provisions the worker's restricted `rm_worker` role and explicitly
  `REVOKE`s `INSERT, UPDATE, DELETE ON raw_indicator_history` (and the other
  analytics tables) from it — by design, per issue #106: the worker keeps
  queue-scoped access only, and analytics-table writes are reserved for the
  API process's role. `verifySeedProvenance`'s `clean=true` path is a `DELETE
  FROM raw_indicator_history`. Run under `rm_worker` in a real deployment
  (one with `WORKER_DATABASE_URL` actually pointed at the restricted role,
  which is the point of #106), every cleanup attempt would fail with a
  permission error — the opposite of "a pre-#630 database actually gets
  repaired."
- **The source-level boundary refuses the import.** `tests/analytics-api-
  boundary.test.ts` scans `src/worker/**` and fails the suite on any import of
  an `analytics/store/**` writer (`IMPORT_STORE`), and separately asserts only
  `api/`, `analytics/store/`, `db/`, and `smoke/` may import one at all.
  `seed-provenance.ts` (the module `verifySeedProvenance` lives in) is exactly
  such a writer. Wiring it into `worker/handlers/repair.ts` — or any
  `worker/**` module — would have failed that guard outright, not passed it
  with a caveat.

Both facts hold specifically because `raw_indicator_history` is an
**analytics** table under the #106 persistence boundary — the same boundary
`ops.repair_gaps` itself respects by only ever enqueueing `wallet.backfill_day`
jobs, which write `wallet_balance_samples`/`wallet_sleeve_samples` (non-analytics,
`rm_worker`-writable tables), never `raw_indicator_history` directly. A cron
handler that needs to mutate an analytics table is not a variant of the #709
pattern; it is the thing #106 exists to keep out of the worker.

**Why `prod-bootstrap.ts` is the correct home instead.** It already imports
`db/client.ts` directly (the unrestricted owner pool) and already runs
direct-SQL, one-time production data-bootstrap pipelines in the same file —
`v0-seed:bootstrap` is the named precedent this step's Direct-SQL pattern
follows, per that step's own comment. `seed-provenance-verify.ts`'s own header
comment already called itself "the one-time PRODUCTION-side cleanup for a
database that was seeded BEFORE [the #616] regeneration landed" — the same
one-time-pipeline shape `prod-bootstrap.ts` was built to orchestrate — before
anything actually ran it there. Running it on every deploy rather than on a
separate cadence matches that one-time-cleanup shape exactly: idempotent,
converges in one pass (no reason to expect *new* calendar-invalid `source='seed'`
rows to appear later — `applyRawFloorSeed` gap-fills, it never re-seeds a row
that already exists — so a later cron tick would find nothing this step has
not already found), and covers every real boot instead of waiting on a
schedule.

**Consequences.**

- `docs/technical/regime-engine.md` §11's pattern-of-unwired-mechanisms
  passage is updated to reflect this one instance closed, while leaving
  `remediationClass` and `forward_fill_expired` — genuinely still unwired —
  as-is.
- `backend/tests/prod-bootstrap.test.ts` gained the new step to its fixed
  step-name assertions and a dedicated test inserting a calendar-invalid
  `source='seed'` row and asserting the deploy run cleans it.
- A future analytics-table repair mechanism should default to this same
  home (an idempotent `prod-bootstrap.ts` step) rather than the worker queue,
  unless it can operate entirely on `rm_worker`-writable tables the way
  `wallet.backfill_day` does.

**Rejected alternatives.**

- **`ops.repair_gaps` / `worker/handlers/repair.ts`.** See above — refused
  by both the DB role's `REVOKE` and the source-boundary test.
- **A new standalone cron process** (a sibling to `src/producer/index.ts`),
  scheduling `runSeedProvenanceVerify` on its own timer against `db/client.ts`
  directly. Workable, but a wholly new long-running process (with its own
  liveness/health surface) is a disproportionate answer to a cleanup that
  converges after its first successful run — the deploy-step shape already
  gives every real database a repair opportunity without adding a component.
- **A new authenticated `/api/analytics/*` route**, called by the existing
  producer or an operator script. Rejected for the same reason: this is a
  direct-SQL cleanup in the `v0-seed:bootstrap` shape, not an ingestion path
  that needs the analytics HTTP boundary's provider-credential semantics.

---

## D39 — The SP500 seed array's v0/v1 source seam is marked in place, not rewritten (issue #648, resolves PD7's seed-array half)

**Decision.** `AUM["SP500"]` in `backend/src/chain/wallet-history-seed.ts` is
**retained as-is** — all 99 entries, index 0 (`"Mar 18"`) through index 98
(`"Jun 26"`) — and now carries an inline comment at that exact array naming the
seam: every one of those 99 values is a v0-era Hyperliquid perp
`accountValue/|size|` reading (`scripts/lib/hyperliquid.js:148`,
`hourly-prices.js:155`), ported verbatim from the retired baked
`walletPerfView`. Index 98 is the **last** Hyperliquid-sourced value in the
SP500 column; the live daily sampler (`wallet.sample_balances`, running since
PR #90) prices every day after the seed from v1's Yahoo `^GSPC` quote instead
(`config.SP500_SIZE × fetchSp500PriceUsd(SP500_TICKER)`,
`chain/token-prices.ts:366`). #648 is the seam existing with **no marker and no
decision record**; this entry is that record, and the marker now lives beside
the data it describes.

**Why not rewrite the array to one source.** Recomputing `today's SP500_SIZE ×
historical Yahoo ^GSPC` for the pre-launch window would not recover history —
`SP500_SIZE` is a single present-tense constant with no position history (the
same fact PD7 already turned into "skip, don't approximate" for the forward
backfill, `docs/technical/regime-engine.md` §11.9 PD7). Applying that same logic
backwards into the seed would silently swap 99 genuine v0 readings for a
fabricated one, which is strictly worse than a splice that is at least now
labelled. **The seed's authority is that it is what v0 actually recorded**
(`docs/technical/markets-asset-pricing-ingest.md` §3.3's finding that the ~99 seeded
`'seed'`-labelled rows are real production output, not synthetic) — that
authority is destroyed by "fixing" it to a single retroactive source, not
restored.

**Why not extend `WalletHoldingProvenance`.** `WalletHistoryPoint.provenance`
(`contract/src/dashboards.d.ts`, populated by `dominantProvenance()` in
`wallet-balances.ts`, from PR #615/#397) is **day-level**: one value —
`live|backfilled|stale|seed|stub` — describing which pipeline stage produced a
whole day's row across every held asset. It has no within-day, per-asset axis,
and SP500's seam is a within-column instrument change on days that already
carry `provenance: 'seed'` for unrelated reasons (they are seed rows). Adding a
sixth provenance value, or a parallel field, to distinguish "seed row, SP500 leg,
Hyperliquid" from "seed row, SP500 leg, would-be-Yahoo" describes a distinction
that does not exist in this data (the seed's SP500 leg is uniformly
Hyperliquid) — there is nothing to encode. The seam is between the seed array
and the live series that follows it, not inside a single `WalletHistoryPoint`.

**Scope.** This closes only the seed-array half of #648/PD7 — the half that is
literal, static data with a knowable, fixed source. It does not decide PD7's
forward-looking half (SP500 in the backfill), which D36's rejected-alternatives
list already records as resolved (skip, don't approximate) and unaffected by
this entry.

**Rejected alternatives.**

- **Rewrite the array to a single retroactively-computed source** (see above) —
  fabricates 99 numbers to erase a splice that is otherwise just honestly
  labelled.
- **Delete the SP500 seed column entirely, starting SP500 history at the live
  launch date.** Throws away 99 real v0 observations to avoid documenting a
  source change; strictly less information for a cosmetic gain.
- **A file-level comment only** (no seam marker on the array itself). Considered
  and rejected per #648's own ask: a comment anywhere in the file is easy to
  read once and then drift from the data as the array is edited; a comment
  attached to the exact array carries forward with it.
- **Extend `WalletHoldingProvenance`** (see above) — no within-day distinction
  exists to encode; the seam is between two series, not within one point.

---

## D40 — Per-schedule catch-up policy; collapsed at the scheduler, not the handler (issue #651)

**Decision.** `job_schedules` gets a `catchup_policy` column (`'all'` default,
`'collapse-per-bucket'`) and `tickScheduler()`'s backlog loop reads it: under
`'collapse-per-bucket'`, a run of missed slots that fall in the same UTC-day
bucket collapses to just the LAST slot due that day — the intermediate slots
are never inserted as jobs at all. `'all'` keeps every existing schedule's
current behaviour (one job per missed slot) unchanged. Only
`wallet.sample_balances` and `wallet.sample_sleeves` are seeded with
`'collapse-per-bucket'` (migration 0034 applies it to existing rows too, not
just fresh seeds).

**Why this exists.** `worker/handlers/slot.ts` already classifies a same-day
replayed slot as `same-bucket-catchup` and lets it PROCEED — correctly, since a
live read taken today is exactly as honest for today's bucket as an on-time
sample would have been (see slot.ts's header). But "correct to run" is not
"cheap to run": the wallet samplers upsert a single `(sample_date, symbol)` row
per UTC day, via a fresh live Base RPC read, every time. A per-minute schedule
down for a few hours does dozens of live chain reads on restart to produce the
ONE row a single read would have produced — every read past the first is pure
RPC load for an already-decided outcome.

**Why at the scheduler, not the handler.** The handler-level fix would be
"only actually read the chain on the LAST same-bucket-catchup slot, decline the
rest" — but that still creates and dequeues every intermediate job first; the
waste moves from RPC calls to queue churn, and every Class-C handler would need
its own bookkeeping to know which same-day replay is "the last one" without
seeing the others. Collapsing in `tickScheduler()` instead means the redundant
jobs are never created — cheaper, and the collapsing logic lives in exactly one
place (the component that already owns "how many jobs does this backlog
become") rather than duplicated per handler.

**Why per-schedule, not global.** Most schedules are not this case. Buybacks
indexing (`buybacks.refresh`) and the projects pipelines each do distinct work
per occurrence — collapsing them would silently drop real catch-up work, not
just redundant reads. Only a schedule whose result is idempotent PER DAY
(same key, same day, regardless of which slot produced it) is safe to collapse,
and that is a property of the schedule/handler pair, not of the scheduler
loop — hence a column, defaulted to the safe no-op (`'all'`), rather than a
new global behaviour.

**Scope: per TICK-BATCH, not globally per day.** The collapse only merges
slots that are due within the SAME `tickScheduler()` call. A backlog wide
enough to overflow `MAX_SLOTS_PER_TICK` (issue #614) still finishes collapsing
across a couple of ticks — a later tick may enqueue one more job for a day
already partly flushed — rather than every schedule paying for a cross-tick
dedupe structure this issue's use case (hours, not weeks, of same-day backlog)
never needs. `slot.ts`'s existing same-bucket/past-bucket classification is
unchanged either way; it decides what the ONE enqueued job per bucket does, not
how many jobs get enqueued.

**Rejected alternatives.**

- **Decline every replayed slot past the first, at the handler.** Considered
  above — moves the waste from RPC calls to queue churn without removing it,
  and pushes bookkeeping into every Class-C handler individually.
- **A dedupe key on `(kind, day)` instead of `(kind, slot)` for these two
  schedules.** Collapses ALL same-day fires, not just backlog replay — an
  on-time steady-state tick would also be suppressed once one had already
  landed that day, breaking the near-real-time cadence issue #118 relies on.
  The column only changes CATCH-UP behaviour, leaving steady-state ticking
  exactly as it was.
- **Make it a global scheduler default instead of per-schedule.** Wrong for
  any schedule whose per-slot work is not day-idempotent (see "why per-schedule"
  above) — silently drops real catch-up work rather than redundant reads.

## D41 — The price series is separate from the holdings series (follows #742/#745; review tracked in #750)

**Decision.** Prices move out of `wallet_balance_samples` and
`wallet_sleeve_samples` into their own dense per-day table, `asset_prices`,
keyed `(price_date, symbol)`. A sample row keeps `amount` — per-day chain
state — and stops carrying the vendor's number for that day. For a **closed**
day, `value_usd` becomes a read-time join between the amount and that day's
price. **Today's live point is the one exception** and keeps its fused row,
because its amount and its spot price were genuinely read at the same instant.

The table is the shared quote record `markets-asset-pricing-ingest.md` §8.1
asks for, not a four-column minimum: asset identity, UTC day, currency, value,
provider, pool or ticker, response identity, and config identity. The three
`usdc`-priced assets are written as real rows with `source = 'pinned'` rather
than special-cased in the reader, so "no row" uniformly means "gap".

**Why this exists.** The two columns are different kinds of fact on different
clocks. `amount` is chain state at one block; `price_usd` is a sample of a
vendor time series that exists whether or not the fund held anything. Fusing
them into one row has three consequences, and #742 hit all three:

- **A missing price discards chain reads that succeeded.** The window executor
  refuses the whole day when any symbol is unpriced, so a vendor's bad minute
  throws away a correct, expensive, block-addressed multicall.
- **"Is this day complete" depends on what the fund held.** That is where the
  manifest and `expectedKeys` came from — a per-slot expected-key set, resolved
  from active configuration, with no point-in-time answer for historical days.
- **Prices cannot be reconciled.** A dense price series is re-derivable from the
  vendor and diffable against what is persisted. Welded to holdings it is not,
  which is why the "present and wrong" defect class
  (`regime-engine.md` §11.1) has no detector for the one series where a wrong
  value was actually served.

Gap detection for prices becomes expected days minus distinct persisted days,
per symbol — no manifest, no per-slot key sets. Repair becomes one OHLCV range
call per pool/token key, of which there are **three** (WETH and native ETH share
a pricing address; then ROBOTMONEY and BNKR), so a full year of prices costs
roughly ten requests.

**Why a read-time join does not float published history.** A join restates
every historical total whenever `asset_prices` changes, which is what repair
needs and exactly what the frozen-publication model forbids. Migration 0038
already separates these: the join is the **candidate**, and
`wallet_aum_snapshot_runs` is the **freeze point** — its header already hashes
price evidence alongside the constituent rows. So the split composes with 0038
rather than competing with it, and a published snapshot stays reproducible from
its own evidence even after the price series is repaired underneath it.

**Why "dense" needs a per-symbol floor.** ROBOTMONEY and BNKR have inception
dates and their pools carry no candles before them. If expected days were the
whole series range for every symbol, the split would manufacture permanent
unfillable gaps — reintroducing, on the price series, the noisy-report problem
`expectedKeys` created on the sleeve series. The floor is nearly free:
`fetchDailyCloses` already folds `oldestSec` and `floorProven` across pages, so
the first range call for a pool reports its first priceable day. Persist that
per symbol and expected-days is bounded by it.

**What this does not remove.** Amounts still need expected-key sets: a sample
missing a leg still understates a sum, and that is the substitution the
correctness contract forbids. `deployedAt` likewise stays — it was always an
amounts concern (the silent-zero rail), never a price one. And the shared-leg
attempt accounting (`deferDay`) survives on the amounts side, because block
resolution and the multicall pass are still shared across a window. What the
split buys is **one failure source per series**: a vendor problem can no longer
void a chain read, and a chain problem can no longer void a price.

**Migration note.** Seed `asset_prices` from `live` and `seed` provenance rows
only. Quarantined rows are precisely the ones whose price describes a different
asset (migration 0036), and re-admitting them through a backfill would restore
the defect the quarantine exists to contain.

**Rejected alternatives.**

- **Keep the fusion; write the amount with a NULL price when the vendor
  refuses.** Leaves `value_usd` ambiguous and pushes the decision into every
  reader, which must still choose what a null leg does to a sum. Completeness
  still depends on holdings, so the manifest machinery stays. It moves the
  problem to the read path rather than removing it.
- **A separate repair pass that fills the price column in place.** Same table,
  so the same coupling: gap detection is still per-slot-and-per-key, and the
  pass still cannot run without knowing which symbols were expected that day.
- **Materialize `value_usd` from `asset_prices` at write time, with no join.**
  This is what the 0038 snapshot already does at freeze; making it the *only*
  mechanism re-welds the two series and loses the property that a repaired
  price improves the candidate for every day at once.
- **Keep prices per-holding but add a vendor-side cache.** Addresses request
  cost, which is not the problem — three range calls a year was never
  expensive. The problem is that one series' failure invalidates another's
  successful reads.
