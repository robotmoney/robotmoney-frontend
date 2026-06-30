# Network topology — DNS, origins & vendors

How `robotmoney.net` presents several independent product surfaces as one
seamless site, and which vendor owns each layer. This document is cross-cutting:
it spans the **marketing** site, **this repo** (Investment Committee + analytics),
and the **on-chain dapp** (`robotmoney-core`). It is a companion to
[ARCHITECTURE.md](./ARCHITECTURE.md) (this frontend's internals) and
[DECISIONS.md](./DECISIONS.md); where it touches a prior decision, the
relationship is called out in [§9](#9-relationship-to-existing-decisions).

---

## 1. Principle — separate origins, two shared seams

Robot Money has three surfaces with very different lifecycles and infrastructure:
static marketing copy (changes often, trivial to host), the IC + analytics
backend (Bun + Postgres + MCP), and the dapp (a long-running Rust daemon, the
on-chain gateway, wallet flows). They are **deployed independently** — separate
codebases, separate releases, separate failure domains. Merging them into one
deploy would couple three cadences for no benefit.

They are unified at **exactly two seams**:

1. **The edge** — one origin, path-based routing (this document).
2. **The design layer** — shared `tokens.css` + shared nav/footer chrome, so
   every surface shares identical framing (see ARCHITECTURE §4).

Everything else stays separate.

---

## 2. Vendors & the division of labor

| Layer | Vendor | Responsibility |
|-------|--------|----------------|
| DNS | **Cloudflare** | Authoritative DNS for `robotmoney.net` |
| Edge / CDN / cache | **Cloudflare** | TLS termination, static caching, the single edge |
| Path router | **Cloudflare Worker** | Maps URL prefix → origin; fail-open per route |
| Ingress | **Cloudflare Tunnel** (`cloudflared`) | Dial-out connection from each DO origin |
| Marketing host | **DigitalOcean** App Platform (static site) | Serves the static marketing bytes |
| IC + analytics compute | **DigitalOcean** | Bun process (this repo's backend) |
| Database | **DigitalOcean** Managed Postgres | Durable always-on datastore |
| Dapp daemon + gateway | **DigitalOcean** | `rmpc` + on-chain gateway (`robotmoney-core`) |

**Rule of thumb: Cloudflare owns the edge; DigitalOcean owns long-running
stateful compute.** Cloudflare has no always-on VM equivalent — Workers are
request-scoped, Durable Objects hibernate, Containers scale to zero — so anything
that must stay running (the daemon synced to chain head, Postgres) lives on DO.

---

## 3. The single origin — path map

Every surface is served under one origin, `robotmoney.net`, routed by **path
prefix** (not subdomains):

| Path | Surface | Origin | Source |
|------|---------|--------|--------|
| `/`, `/about`, `/docs` | Marketing (static) | DO App Platform static site | marketing source |
| `/committee/*`, `/analytics/*` | Investment Committee + analytics | DO Bun + Managed Postgres (via Tunnel) | `robotmoney-frontend` (this repo) |
| `/app/*` | Dapp | DO `rmpc` + gateway (via Tunnel) | `robotmoney-core` |

**Why path-prefix, not subdomains.** A single origin means navigation between
surfaces never feels like leaving the site, session cookies are shared, and there
is no CORS. Subdomains (`app.`, `committee.`) advertise "different product" — the
opposite of seamless.

This **preserves and strengthens** the same-origin property from D11: the browser
still sees one origin for both the SPA and its API, so there is no CORS — and now
that guarantee extends across *all three* surfaces, because the edge presents them
as one origin.

---

## 4. The router (Cloudflare Worker)

A thin Worker at the apex maps each path prefix to its origin. It is chosen over
plain **Origin Rules** for one reason: **fail-open per route**. If an origin is
down, the Worker returns that surface's own (or cached/stale) response rather than
a global `502`. So a bad deploy on the dapp cannot take down marketing or the
committee — blast radius is one surface.

(Marketing *could* alternatively be served directly from the Worker as Static
Assets, but we host it on DO for vendor consistency — see §5.)

---

## 5. Origins on DigitalOcean

- **Marketing** → App Platform **static site** component: connect a git repo, it
  builds and serves static files, free, no server to run. DO's equivalent of
  Cloudflare Pages, kept on DO for one billing/ops surface. (If a Spaces bucket is
  used instead, **disable its CDN** — see §7.)
- **IC + analytics** → this repo's Bun process + **DO Managed Postgres**.
- **Dapp** → `rmpc` daemon + gateway from `robotmoney-core`.

All non-static origins are reached through **Cloudflare Tunnel**: the origin dials
*out* to Cloudflare, so there is **no public ingress** — no exposed ports, no
inbound firewall rules, no origin TLS certificates to rotate. This removes a whole
class of "is the port open / is the cert expired" operational and monitoring
burden, and shrinks the attack surface on the two stateful surfaces.

---

## 6. Base paths (the one real gotcha)

Each app is mounted under a **prefix** (`/committee`, `/app`), not at root. With
the buildless model (import maps, runtime asset resolution; see D2), asset and
import URLs must resolve relative to that prefix. **Make each app base-path-aware**
— it knows it lives at `/committee` and builds its links, router paths (D4), and
import-map URLs accordingly — rather than stripping the prefix at the edge and
relying on `<base href>`, which interacts subtly with import maps.

---

## 7. No double-CDN

**Cloudflare is the single edge cache.** DigitalOcean origins serve uncached
bytes; Cloudflare caches them at its edge. Do not enable the DO Spaces CDN or any
second CDN behind Cloudflare — two caches mean two invalidation paths for no gain.
One edge, one invalidation path.

---

## 8. Monitoring

- **Standardized `/health` JSON contract** across every surface is the keystone.
  Each surface checks its *own* dependencies and returns the same shape, so one
  dashboard reads a heterogeneous stack (static / Bun / Rust):
  - marketing — trivially `200` (static)
  - IC + analytics — Postgres reachable, MCP up
  - dapp — `rmpc` alive, gateway reachable, **RPC reachable + chain-head lag below
    threshold**
- **Cloudflare Health Checks** hit each `/health` on an interval (or an external
  uptime monitor — either works).
- **Cloudflare Logpush** ships Worker + tunnel logs to one aggregator; **Worker
  analytics** gives per-route request/error rates for free — the "is a surface
  degraded" view with nothing to operate.
- **Fail-open per route** (§4) keeps a single failed origin from cascading.

The genuine operational weight is the dapp's on-chain monitoring (daemon, RPC,
chain-head freshness) — and that exists regardless of this topology; the `/health`
contract just makes it visible.

---

## 9. Relationship to existing decisions

- **D11 (single box, no reverse proxy)** — **evolved.** Each origin is still a
  single DO box/component, but there is now a Cloudflare edge layer in front and
  multiple origins behind it. The reason D11 cited for "no reverse proxy" —
  same-origin, no CORS — is *preserved and extended*: the edge presents all
  surfaces as one origin.
- **D8 (one Postgres)** — unchanged; in production it is **DO Managed Postgres**.
- **D10 (split-ready repos)** — reinforced. Each surface is already an independent
  origin behind the edge, so an eventual repo split is purely mechanical.
- **D4 (SPA history router)** — now **base-path-aware** under `/committee` (§6).
- **D2 (buildless)** — drives the base-path handling in §6 (import-map URLs must
  resolve under the prefix).
