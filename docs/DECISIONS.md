# Decisions

The significant architecture decisions for this rebuild, with the reasoning and
the alternatives that were rejected. Newest decisions can supersede older ones;
each entry stands on its own. See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the
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
visualizations, blog/media, other editorial pages.

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

> **Superseded for production by D13** (Cloudflare edge + tiered DO topology). The
> single-box `docker-compose` remains the **CI and demo** deployment; same-origin
> /no-CORS is preserved *within* each surface because the Bun `api` still co-serves
> its SPA assets.

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

## D13 — Tiered cloud topology: Cloudflare edge + DO static/API/data tiers

**Decision.** For **production**, deploy `robotmoney.net` as a separation of
concerns across three tiers behind a Cloudflare routing edge. The full map is
[TOPOLOGY.md](./TOPOLOGY.md):

- **Edge** — Cloudflare for DNS, TLS, and a path-routing Worker (fail-open per
  route). Cloudflare does **not** cache marketing.
- **Static tier** — marketing assets in a **DO Spaces CDN**; no runtime dependency
  on other tiers (fail-open — marketing serves even when the API is unavailable).
- **API tier** — request/response services on **DO Droplets** (this repo's Bun
  `api`+`worker`; the dapp's `rmpc`+gateway), reached via Cloudflare Tunnel.
- **Data tier** — a **DO Managed Postgres HA cluster** (primary+standby failover,
  backups, PITR).

**Why.** The three surfaces (marketing, IC+analytics, dapp) have different
lifecycles, failure domains, and infra needs. Organizing infrastructure by
concern — delivery vs compute vs state — lets each tier scale, fail, and deploy
independently, and keeps marketing serving when the API/data tiers are down.
Cloudflare has no always-on VM or managed database and (by this decision) does not
cache marketing, so delivery, compute, and state all stay on DigitalOcean.

**Relationship.** Supersedes D11 for production (there is now an edge and multiple
origins; same-origin/no-CORS is preserved *within* a surface because the Bun `api`
still co-serves its SPA assets). Refines D8's prod mode to a managed HA cluster.
The single-box `docker-compose` (D8/D11) remains the CI and demo deployment.

**Alternatives rejected.**
- **All-Cloudflare compute** (Workers/Containers) — no always-on instance for the
  chain-synced `rmpc` daemon and no managed Postgres; scale-to-zero is wrong for it.
- **Cloudflare caching marketing** (single-vendor edge cache) — chose the DO Spaces
  CDN so all delivery, compute, and state sit on one provider (DO); Cloudflare stays
  DNS/TLS/routing only, avoiding a double-CDN.
- **Keeping the single box for prod** — no isolation between the marketing, API,
  and data failure domains, and no database HA.
