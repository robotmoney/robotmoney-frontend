# Deployment & credentials (GitOps)

How changes ship to **staging** and **production**, and the exact credentials to
generate from **Cloudflare** and **DigitalOcean** so CI can deploy. Companion to
[architecture.md](../architecture.md) (the map — decision D13) and ARCHITECTURE §8 (what
this repo ships). Assumes **GitHub Actions** as the CI; the credential inventory is
CI-agnostic, only the storage mechanism (GitHub Environment secrets) is specific.

The vendor split (D13) keeps this short: **Cloudflare = DNS + observability** (no
software to deploy), **DigitalOcean = compute + storage** (everything CI builds and
runs). There is no Worker/`wrangler`, no reverse proxy, and no tunnel by default.

---

## 1. GitOps principle

**Git is the source of truth; our CI pipeline applies changes.** We do **not** rely
on vendor repo-watching:

- **Disabled:** DigitalOcean App Platform auto-deploy and any Cloudflare git
  integration. No vendor monitors the repo.
- **Consequence:** CI is the *only* actor that mutates infrastructure, so it must
  authenticate to each vendor's API — hence the scoped tokens below.
- **No OIDC:** neither Cloudflare nor DigitalOcean exposes GitHub OIDC federation
  for their management APIs, so these are **long-lived scoped tokens**. Least
  privilege + rotation are the mitigation (§6).
- **Branch → environment** (example, adjust to your branch model): merge to
  `dev` → deploy **staging**; tag a release → deploy **production**.

**Which credential deploys which D13 tier:**

| Tier / role (D13) | Deployed / configured with |
|---|---|
| Cloudflare — DNS + observability | Cloudflare API token (DNS + Health Checks, §3.1) |
| Static — marketing → DO Spaces CDN | DO Spaces keys + DO API token (CDN + custom-domain cert), §4.1–4.2 |
| API — droplets | SSH key **or** container registry + app secrets + Cloudflare **Origin CA cert** + DO Cloud Firewall, §4.4 / §3.4 |
| Data — Managed Postgres HA | `DATABASE_URL` (§4.3) |

---

## 2. Environments — staging & production isolated

Each environment gets its **own complete set of credentials and its own infra** —
separate subdomains, droplet, Space, Postgres, and firewall. Store secrets as
**GitHub Environment secrets** (not repo-wide), so the two are isolated and
`production` can require a reviewer.

| Resource | Staging | Production |
|---|---|---|
| Marketing host | `staging.robotmoney.net` | `robotmoney.net`, `www.` |
| IC + analytics host (REST — the only member surface, D21) | `committee.staging.robotmoney.net` | `committee.robotmoney.net` |
| Dapp host | `app.staging.robotmoney.net` | `app.robotmoney.net` |
| Droplets | staging droplets | production droplets |
| Spaces (marketing) | `rm-marketing-staging` | `rm-marketing-prod` |
| Postgres | single-node (cost) | **HA cluster** |

D21 retired the MCP transport (formerly its own `mcp.` host on port `8443`,
co-located on the `committee.` droplet — D18); members now use `committee.`'s
REST API like every other client. Decommissioning the `mcp.` DNS record,
firewall rule, and container is tracked as D21's follow-up implementation
work.

---

## 3. Cloudflare credentials

Cloudflare's only jobs are DNS and observability, so the token is narrow.

### 3.1 API token — scoped, one per environment

Dashboard → **My Profile → API Tokens → Create Token** (custom). Scope to the
`robotmoney.net` zone. Permissions:

| Permission | Why |
|---|---|
| Zone · DNS · **Edit** | manage the subdomain records (CI/IaC) |
| Zone · Health Checks · **Edit** | provision the synthetic `/health` monitors |
| Zone · Analytics · **Read** | observability dashboards/exports |
| Zone · Logpush · **Edit** | configure log delivery |
| Zone · Zone · **Read** | resolve zone metadata |

Store as **`CF_API_TOKEN`**. (No Workers/Tunnel/Cache permissions — there is no
Worker, and marketing is reached DNS-only so Cloudflare does not cache it.)

### 3.2 Identifiers (config, not secret)

- **`CF_ACCOUNT_ID`**, **`CF_ZONE_ID`** — required by the API / IaC.

### 3.3 Cloudflare Tunnel (optional — not the default)

There is **no tunnel by default** (§1) — the default is proxied DNS + DO Cloud
Firewall. A host may nonetheless opt into a `cloudflared` connector as the
zero-public-ingress hardening ARCHITECTURE §4 describes, and one does today:
`site.robotmoney.net`.

Because the connector is **host-side software with no presence in
`docker-compose*.yml`**, its configuration is checked in as
[`cloudflared.config.example.yml`](../../cloudflared.config.example.yml) at the
repository root — otherwise the only description of what a public hostname
resolves to lives on one droplet's filesystem, reviewable by nobody. Copy it to
`/etc/cloudflared/config.yml` and fill in the tunnel UUID; **never** commit the
credentials JSON `cloudflared tunnel create` writes to `~/.cloudflared/`.

Two properties the template documents at length and a reviewer should not have
to rediscover:

- **The origin port is `48787` and cannot be anything else** — the single fixed
  host port in the system (`scripts/stack/ports.ts:39`), pinned by
  `bun run demo:stage`, which fails rather than falls back because the
  tunnel routes that port and nothing else.
- **The tunnel does not close the direct path.** Compose publishes `48787` on
  `0.0.0.0`, so the droplet's public IP answers there too, bypassing Cloudflare.
  Zero public ingress additionally requires a DO Cloud Firewall rule or an
  iptables `DOCKER-USER` rule; `ufw` will not do it, since `docker-proxy`
  publishes past it.

Note also that a pinned-port origin serves a **demo** stack (`RM_ALLOW_INSECURE=1`,
`DEMO_MODE=1`, fixture-backed `/projects`), not a production one — see §5 for
what a production deployment requires instead.

### 3.4 Origin CA certificate (for the proxied app subdomains)

The `committee.`/`app.` droplets are Cloudflare-proxied, so each serves a
**Cloudflare Origin CA certificate** (a long-lived cert Cloudflare issues for
origin pulls; generated once in the dashboard or via API). Install the cert + key
on the droplet (injected at deploy as **`CF_ORIGIN_CERT`** / **`CF_ORIGIN_KEY`**).
This is config, not running software.

---

## 4. DigitalOcean credentials

### 4.1 API token — scoped read+write, one per environment

Dashboard → **API → Tokens → Generate New Token**. Use a **scoped** token limited
to the resources CI manages (droplets, databases, spaces, registry, firewalls).
Store as **`DO_API_TOKEN`** — used by `doctl`/Terraform, to manage the **Spaces CDN
+ custom-domain cert**, the **Cloud Firewall** (allow Cloudflare IP ranges), and to
log in to the Container Registry.

### 4.2 Spaces access keys (S3) — separate from the API token

Dashboard → **API → Spaces Keys → Generate**. Yields an **access key ID + secret**
(S3-compatible). CI uses them to sync marketing assets to the Space. Store as
**`DO_SPACES_KEY`** / **`DO_SPACES_SECRET`**; also record `SPACES_BUCKET`,
`SPACES_REGION`, and the CDN endpoint. (The marketing CDN's TLS uses a DO-managed
custom-domain certificate, provisioned via `DO_API_TOKEN` — no key to store.)

### 4.3 Managed Postgres connection

From the cluster's **Connection Details**: host, port (`25060`), database, user,
password, `sslmode=require`, and the **CA certificate** (download). Assemble into
**`DATABASE_URL`**; ship the CA as **`DO_DB_CA_CERT`** if your client needs the
file. For the HA cluster, prefer the **connection-pool** URI (PgBouncer) if
enabled. Migrations (D9) run with this credential.

### 4.4 Droplet access — pick a deploy mechanism

- **SSH deploy (simplest).** Generate an SSH keypair; put the public key in the
  droplet's `authorized_keys` (and register it in DO); store the private key as
  **`SSH_PRIVATE_KEY`**. CI SSHes in and runs `docker compose pull && up -d`.
- **Container registry (reproducible).** Push images to **DO Container Registry**;
  `DO_API_TOKEN` authenticates `doctl registry login`. The droplet needs its own
  scoped **read** token to pull.

The droplet's **DO Cloud Firewall** (managed via `DO_API_TOKEN`) restricts inbound
to **Cloudflare's published IP ranges** plus your admin SSH source.

---

## 5. Application & data secrets (per environment)

These live in the **droplet env**, injected by CI at deploy — never in the
frontend, never committed (`.env` stays gitignored):

- **`DATABASE_URL`** (§4.3)
- **`FRED_API_KEY`**, **`BASE_RPC_URL`** — per ARCHITECTURE §8.
  **`ANTHROPIC_API_KEY`** is reserved — not currently consumed by any code.
- **`OPENCODE_API_KEY`** — the OpenCode Zen credential for every real-inference
  path (committee take authorship, the member-agent onboarding containers). ONE
  variable name across CI / Stage / local, with a **different value in each**, so
  spend is attributable and rotating one never touches another. Needs pay-as-you-go
  credit on its Zen workspace (an opencode subscription does not fund it).
  `AGENT_MODEL` selects which model it buys — see `.env.example` and
  `scripts/lib/model-registry.ts`; `AGENT_MODEL=free` runs with no key at all.
- **`PROJECTS_SOURCE=live`** — not a secret, but **required in prod**: the
  `/projects` directory pipelines fail closed
  (`backend/src/projects/access/select.ts` throws
  `projects pipelines require PROJECTS_SOURCE=live in prod`) rather than serve
  the vendored fixture directory as production data. Leave unset in demo/dev
  (offline fixture source); the ephemeral CI env is always hermetic regardless.
- Any committee signing secrets as applicable.

The frontend's only input is `API_BASE_URL` in `config.js` (`""` = same origin on
its subdomain) — not a secret.

---

## 6. Least privilege, rotation, storage

- **One scoped token per vendor per environment.** Never reuse a production token in
  staging — blast radius stays one environment.
- Store everything as **GitHub Environment secrets**; gate the `production`
  environment with **required reviewers**. Never commit secrets.
- Because there is **no OIDC** for Cloudflare/DO management APIs (§1), these are
  long-lived tokens — **rotate on a schedule** and on any suspected exposure.
- SSH keys and the Origin CA cert are per-environment; rotating re-issues the
  `authorized_keys` entry / origin certificate.

---

## 7. Checklist — generate and hand to CI

Run the [credential doctor](./credential-doctor.md) from the repository root:

```sh
# Interactive: audit both environments and offer to configure missing values.
bun run credentials

# Read-only: suitable for local checks and CI; exits non-zero when required
# credentials or variables are missing.
bun run credentials:check

# Limit the interactive audit to one environment.
bun run credentials -- --environment staging
```

The doctor never prints secret values. GitHub does not expose stored Environment
secret values, so existing secrets can only be checked for presence. Cloudflare
and DigitalOcean tokens are validated against their APIs when entered
interactively, before they are uploaded. Generated application tokens and SSH
keys are backed up outside the repository under
`~/.config/robotmoney/gitops/<environment>/` with restrictive permissions.

Do this **once per environment** (staging, then production):

**Cloudflare** (DNS + observability)
- Scoped API token (DNS + Health Checks + Analytics + Logpush) → `CF_API_TOKEN`
- `CF_ACCOUNT_ID`, `CF_ZONE_ID`
- Origin CA cert + key for the proxied app subdomains → `CF_ORIGIN_CERT` / `CF_ORIGIN_KEY`
- ~~`mcp.<env.>robotmoney.net` DNS record~~ — D18's MCP subdomain is retired
  (D21); do not provision it for new environments. An existing record from
  before D21 is decommissioned as part of D21's follow-up implementation work.

**DigitalOcean** (compute + storage)
- Scoped API token → `DO_API_TOKEN`
- Spaces key/secret → `DO_SPACES_KEY` / `DO_SPACES_SECRET` (+ bucket, region, CDN endpoint)
- Marketing CDN **custom-domain cert** provisioned (via `DO_API_TOKEN`)
- `DATABASE_URL` (+ `DO_DB_CA_CERT`)
- SSH deploy key → `SSH_PRIVATE_KEY` (and/or a registry read token)
- Cloud Firewall allowing Cloudflare IP ranges (via `DO_API_TOKEN`)

**Application**
- `FRED_API_KEY`, `BASE_RPC_URL` (`ANTHROPIC_API_KEY` is reserved — not
      currently consumed by any code)
- `OPENCODE_API_KEY` (§5) — rotate per environment independently; revoking the
      Stage key must never affect CI's.
- `PROJECTS_SOURCE=live` in the prod droplet env (§5 — the projects
      pipelines fail closed without it)

**GitHub**
- Create `staging` + `production` **Environments**; load the above as
      Environment secrets; require reviewers on `production`.
- Confirm vendor git-integrations are **OFF** (no App Platform auto-deploy, no
      Cloudflare git integration).
