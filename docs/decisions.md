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
realistic, evolving data run `bun run demo` (see
[architecture.md § Demo Specification](architecture.md#demo-specification)).
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
/navigation; values are mock/point-in-time. Run `bun run demo` for realistic
data (see
[architecture.md § Demo Specification](architecture.md#demo-specification)).

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
`bun run demo` for realistic data (see
[architecture.md § Demo Specification](architecture.md#demo-specification)).

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
(`demo-live-smoke-nightly.yml`, `committee-opencode-nightly.yml`,
`e2e.yml`'s MCP steps, `rmpc-release-e2e-nightly.yml`'s OAuth flow), and the
`mcp.<domain>` DNS/firewall provisioning are **not removed by this decision
alone** — this entry is the architecture/docs change; the code and
infrastructure retirement is follow-up implementation work, tracked as its
own issue so it gets its own review and CI verification rather than riding
along with a docs commit.

**Why.** MCP has no customer: no committee member has connected over it, and
the only consumers of the MCP surface in this repo are our own demo/e2e
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
  auth server, dual CI matrix, dual demo path) is a cost, not a benefit, once
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

## D22 — Evals run a registry-selected OpenCode model; the onboarding eval is layered and shares the demo's stack

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
   pass/fail run, and it never boots the full demo cluster — only a `core` stack,
   and only for the final layer.
4. **Scored by sampling, not by a single run.** An eval measures a stochastic
   system, so it takes K samples, classifies every outcome, and reports the rate.
   A single sample is a coin flip reported as a verdict.

Rules 3 and 4 are specified normatively in
[architecture.md §11.3](architecture.md#113-onboarding-eval-normative) (E3, E4) —
the layer table, the observation mechanism, the outcome classes, and the CI
placement live there, not here.

The eval shares the demo's components rather than paralleling them: one stack
module with a `core`/`full` profile, one member-agent container primitive, one
outcome classifier. The onboarding eval **is** the demo's onboarding path with
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
every rails check. On 2026-07-25 a demo run recorded zero admissions because the
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
`scripts/lib/demo-main.ts` performs its setup at **module scope** — port
allocation, admin-token generation (including a `process.env` write), compose-env
construction, log-file opening — so importing anything from it boots a demo.
`scripts/tests/integration/onboarding-eval-infra.test.ts` therefore had no choice but to fork
its own mini-stack (`bringUpInfra()`). Extracting a side-effect-free stack module
removes that fork rather than adding a second one, and continues the split
already begun by `demo-env.ts` and `demo-newcomers.ts`, both of which exist for
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
- **Moves the sweep out of the demo.** `demo-main.ts`'s env-gated
  `ONBOARDING_REAL_EVAL` block moves to the eval, where sampling belongs. The
  demo goes back to being a demo; it keeps admitting members through the same
  shared harness.
- **Adds no workflow.** `committee-opencode-nightly.yml` is repointed at the eval
  on a `core` stack. It gets smaller: no Chromium install, no backend deps for
  the EDGAR seed bootstrap, no demo-volume reclaim, and no `env:` block. It stays
  `CI_CLASS: heavy` (sweep-only — no `pull_request` trigger). ~~On
  `ubuntu-latest`, because the self-hosted runner shares its IP with the standing
  `rm_demo_*` stack and has a documented history of 429 flake on live-call
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
   between demo runtime and test/eval time lives in `stack/`, `agent/`,
   `toolchain/` — not in a bucket named `lib/`. Harness code separates by role
   (`bin/`, `demo/`, `checks/`, `ops/`) rather than by medium.

Dependency direction is fixed and enforced: tests and evals may import runtime
and shared code; **runtime must never import test or eval code**. The full target
layout is [architecture.md §3](architecture.md#test-eval-and-tooling-layout).

**Migration is incremental and bounded to three moves:** create `evals/`; land
D22's extractions directly in `stack/` and `agent/` rather than as more flat
files under `scripts/lib/`; split `scripts/tests/` by cost class. Nothing else
moves.

**Why.** The organizing failure is concrete and measurable: `scripts/tests/`
holds **32 test files**, of which 4 require a Docker daemon
(`demo-compose-config`, `demo-live-research`, `demo-volume-lifecycle`,
`onboarding-eval-infra`) and 2 require network egress to GitHub Releases
(`onboarding-eval-infra`, `rmpc-canonical-apply`) — and all 32 run on every PR
under one `bun test scripts/tests` command, because there is no path by which CI
could select a cheaper subset. That single bucket is why the onboarding eval
(D22) had nowhere to live: any home inside `scripts/tests/` would have put an
8-minute, Docker-plus-real-inference run into the per-PR path.

`scripts/lib/` has the mirrored problem on the other axis: it holds demo
*runtime* (`demo-main.ts`, `tui.ts`, `demo-schedule.ts`, `committee/`) beside
shared harness code (`onboarding-eval.ts`, `rmpc-fetch.ts`, `demo-volumes.ts`)
with nothing marking or enforcing the difference, so nothing stops a test-only
helper being imported into runtime.

Enforcement is by grep check, not convention — the repo already proves the
pattern works: `backend/scripts/check-no-supabase.sh` makes D8 executable, and
`check-no-ai-overview.sh` does the same for issue #93. Both are ~18 lines and
run in milliseconds. An invariant that lives only in prose is an invariant that
rots.

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
- **Weakening the cold-boot demo-readiness gate to tolerate the new samplers'
  empty-table window.** Ratified at intake (2026-07-28): the gate is not
  weakened; both new samplers get the same boot-time one-shot enqueue the
  existing wallet-balances sampler already relies on, and `ALLOWED_STALE_LEGS`
  does not grow.

---

## D25 — External-actor rail for simulated independent entities

**Decision (required topology, not an implementation-status claim).** Every
process that the product, demo, or an eval presents as an independent actor must
run on one shared **external-actor rail**: one disposable container per actor, a
private writable filesystem, no ambient environment inheritance, explicitly
injected scoped credentials only, self-held signing keys, and REST-only access
to Robot Money. This applies to an onboarding-eval candidate, every sitting
committee member in demo/e2e, and the independent analytics/research producer
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
API verifier; the demo host, committee members, and shared workers do not receive
the value. Consumer-DB analytics schedules are forced disabled, queued legacy
jobs are dead-lettered, and admin retry/toggle/rerun/enqueue plus the retired
`research-eligibility` path cannot reactivate them.

Two compatibility artifacts remain explicit. The old worker handler/lane code
and disabled schedule rows remain readable for tests, migrations, and historical
queue visibility, but have neither a supported control-plane caller nor the
producer bearer. The demo TUI still observes those retired queue rows rather
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
session, register a fixed demo member's *public* key once as the protocol
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
trust boundary to every simulated independent actor, including required demo
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
zero-ambient injection. The more serious defect was that the demo could claim
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
  seed the fixed demo roster once, but cannot replace real admission for an
  onboarding candidate, rotate an admitted member's identity, synthesize a
  take, or impersonate the analytics role.
- **Mocks, templates, and inference-off substitutes in behavioral gates.** A
  missing external resource fails loudly, and the gate must prove that at least
  one real actor execution crossed the REST boundary.

## D26 — Nightly is a mirror of the merge-to-main set (issue #373; supersedes #280/PR #367)

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
| `demo-live-smoke-nightly.yml` | **Retired** | It booted the same LIVE stack and ran the same `scripts/demo-live-smoke.ts` assertions as `e2e.yml`; its own header said its "only distinguishing input is the schedule". |
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
