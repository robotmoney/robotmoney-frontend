# Network topology — DNS, origins & vendors

How `robotmoney.net` presents several independent product surfaces as one
seamless site, organized as a clean **separation of concerns** across three
infrastructure tiers behind one routing edge. This document is cross-cutting: it
spans the **marketing** site, **this repo** (Investment Committee + analytics),
and the **on-chain dapp** (`robotmoney-core`). It is a companion to
[ARCHITECTURE.md](./ARCHITECTURE.md) (this frontend's internals) and
[DECISIONS.md](./DECISIONS.md); the production topology here is decision **D13**,
which supersedes the single-box parts of D8/D11 (see [§11](#11-relationship-to-existing-decisions)).

---

## 1. Principle — separation of concerns

Robot Money has three product surfaces with very different lifecycles and infra:
static marketing copy, the IC + analytics backend (Bun + Postgres + MCP), and the
dapp (a long-running Rust daemon, the on-chain gateway, wallet flows). They are
**deployed independently** — separate codebases, releases, and failure domains.

The infrastructure is organized **by concern, not by surface**, into three tiers,
fronted by one routing edge and unified visually by one design layer:

- **Static tier** — asset delivery. No runtime dependency on anything else; serves
  even when the API and data tiers are down (**fail-open**).
- **API tier** — request/response compute. Stateless services.
- **Data tier** — durable state. One high-availability database.

Two shared seams unify the surfaces: the **edge** (one origin, path routing — this
document) and the **design layer** (shared `tokens.css` + nav/footer chrome —
ARCHITECTURE §4).

---

## 2. Tiers, concerns & vendors

| Tier / layer | Concern | Vendor & home | Fail-open? |
|---|---|---|---|
| **Edge** | DNS, TLS, path routing | **Cloudflare** — DNS + a routing Worker | routes around dead origins |
| **Static** | Marketing asset delivery | **DigitalOcean Spaces CDN** | **yes** — independent of API/data |
| **API** | Request/response compute | **DigitalOcean Droplets** — Bun `api`+`worker`; `rmpc`+gateway | per-route at the edge |
| **Data** | Durable state | **DigitalOcean Managed Postgres — HA cluster** | n/a (primary+standby failover) |

**Rule of thumb: Cloudflare owns the edge (DNS, TLS, routing); DigitalOcean owns
delivery, compute, and state.** Cloudflare has no always-on VM and no managed
database, and — by this design — does not cache marketing. So the static CDN, the
droplets, and the Postgres cluster all live on DigitalOcean.

---

## 3. The single origin — path map

Every surface is served under one origin, `robotmoney.net`, routed by **path
prefix** (not subdomains):

| Path | Surface | Tier → home | Source |
|------|---------|-------------|--------|
| `/`, `/about`, `/docs` | Marketing | Static → **DO Spaces CDN** | marketing UI (this repo, D1) |
| `/committee/*`, `/analytics/*` | IC + analytics | API → **DO droplet** (Bun) + Data → **Postgres HA** | `robotmoney-frontend` (this repo) |
| `/app/*` | Dapp | API → **DO droplet** (`rmpc` + gateway) | `robotmoney-core` |

**Why path-prefix, not subdomains.** One origin → navigation never feels like
leaving the site, session cookies are shared, no CORS. The IC SPA and its API stay
**same-origin** under `/committee` (D11's same-origin/no-CORS property is preserved
within the surface, because the Bun `api` co-serves its own SPA assets); the edge
presents all surfaces as one origin.

---

## 4. The edge router (Cloudflare Worker)

A thin Worker at the apex maps each path prefix to its tier origin. Cloudflare's
role is strictly **DNS + TLS + routing — it does not cache marketing** (the Spaces
CDN owns that, §5). It is chosen over plain Origin Rules for **fail-open per
route**: if an origin is down, the Worker returns that surface's own (or
cached/error) response rather than a global `502`. A bad deploy on the dapp cannot
take down marketing or the committee — blast radius is one surface.

---

## 5. Static tier — marketing (DO Spaces CDN)

The static marketing assets (the marketing UI preserved per D1) are uploaded to a
**DigitalOcean Space with its CDN enabled**; the Spaces CDN distributes and caches
them at the edge. This tier has **no runtime dependency on the API or data tiers**
— it is pure static — so when an API droplet or Postgres is unavailable, marketing
**still serves (fail-open)**. Any dynamic data a marketing page wants is fetched
client-side and must **degrade gracefully**; the page itself never hard-depends on
the API being up.

---

## 6. API tier — services on DO droplets

Request/response services run on **DigitalOcean Droplets**:

- **IC + analytics** — this repo's Bun `api` + `worker`. The `api` co-serves this
  surface's SPA assets (`STATIC_DIR`) same-origin with its own API; only marketing
  is split out to the static tier.
- **Dapp** — the `rmpc` daemon + on-chain gateway (`robotmoney-core`).

Droplets are reached through **Cloudflare Tunnel** (`cloudflared` dials *out*): no
public ingress, no exposed ports, no inbound firewall rules, no origin TLS certs
to rotate. This removes a class of operational/monitoring burden and shrinks the
attack surface. (Droplets are used because Cloudflare has no always-on instance and
the `rmpc` daemon must stay synced to chain head — a scale-to-zero model is wrong
for it.)

---

## 7. Data tier — Postgres HA cluster (DO)

Durable state is a **DigitalOcean Managed Postgres high-availability cluster**:
primary + standby with automated failover, daily backups, and point-in-time
recovery. The API tier connects via `DATABASE_URL`; no other tier touches the
database. This refines D8's production mode (one Postgres) to a managed HA cluster
and replaces the single-box Dockerized Postgres for production (the Dockerized
Postgres remains the CI and demo mode — D8).

---

## 8. No double-CDN

The static tier's CDN is **DO Spaces CDN**; Cloudflare does **not** add a second
cache in front of it. Set Cloudflare to **bypass cache on the marketing paths**, so
there is one cache and one invalidation path. Cloudflare passes API responses
through uncached as well. One concern, one owner: marketing caching belongs to the
Spaces CDN.

---

## 9. Base paths (the one real gotcha)

Each surface is mounted under a **prefix** (`/committee`, `/app`), not at root.
With the buildless model (import maps, runtime asset resolution; D2), asset and
import URLs must resolve relative to that prefix. **Make each app base-path-aware**
— it knows it lives at `/committee` and builds its links, router paths (D4), and
import-map URLs accordingly — rather than stripping the prefix at the edge and
relying on `<base href>`, which interacts subtly with import maps.

---

## 10. Monitoring

- **Standardized `/health` JSON contract** across every surface is the keystone.
  Each checks its *own* dependencies and returns the same shape, so one dashboard
  reads a heterogeneous stack:
  - marketing — trivially `200` (static, no deps)
  - IC + analytics — Postgres reachable, MCP up
  - dapp — `rmpc` alive, gateway reachable, **RPC reachable + chain-head lag below
    threshold**
- **Cloudflare Health Checks** hit each `/health`; **Logpush** + **Worker
  analytics** give per-route request/error rates with nothing to operate.
- **Data tier** — rely on the DO managed cluster's metrics (replication lag,
  failover events, connection saturation).
- **Fail-open** (§4, §5) keeps a single failed tier from cascading; the static
  marketing tier in particular stays up independently of API and data.

---

## 11. Relationship to existing decisions

- **D11 (single box, no reverse proxy)** — **superseded for production by D13.**
  Production now has a Cloudflare edge and three DO tiers. The reason D11 cited —
  same-origin, no CORS — is *preserved within each surface* (the Bun `api` still
  co-serves its SPA assets). The single-box `docker-compose` remains the **CI and
  demo** deployment.
- **D8 (one Postgres in Docker)** — **prod mode refined by D13:** production is a
  **DO Managed Postgres HA cluster**; the ephemeral (CI) and demo modes are
  unchanged.
- **D10 (split-ready repos)** — reinforced: each tier/surface is already an
  independent origin behind the edge, so a repo split stays mechanical.
- **D4 (SPA history router)** — now **base-path-aware** under `/committee` (§9).
- **D2 (buildless)** — drives the base-path handling in §9.
