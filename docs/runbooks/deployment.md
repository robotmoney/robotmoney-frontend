# Deployment & credentials (GitOps)

How changes ship to **staging** and **production**, and the exact credentials to
generate from **Cloudflare** and **DigitalOcean** so CI can deploy. Companion to
[architecture.md](../architecture.md) (the map — decision D13) and ARCHITECTURE §8 (what
this repo ships). Assumes **GitHub Actions** as the CI; the credential inventory is
CI-agnostic, only the storage mechanism (GitHub Environment secrets) is specific.

The vendor split (D13) keeps this short: **Cloudflare = DNS + observability** (no
software to deploy), **DigitalOcean = compute + storage** (everything CI builds and
runs). There is no Worker/`wrangler`, no reverse proxy, and no tunnel by default.

> **⛔ Upgrading production to v0.2.2? Read
> [the rollout runbook](./v0-2-2-rollout.md) FIRST — before anything below.**
> This document is the *standing* credential and topology reference;
> [`v0-2-2-rollout.md`](./v0-2-2-rollout.md) is the *version-specific* procedure
> for **v0.2.1 → v0.2.2**, and this one is **not sufficient for it**. Two of its
> go/no-go gates decide the outcome before any instruction here applies: an
> **admin-lockout gate** that can leave the upgrade unrecoverable, and a
> **mandatory `--external-pg`** — without it the cutover silently boots an empty
> database and serves it as production. Neither is decided here.

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
| IC + analytics host (REST — the only member surface, D21) | `swarm.staging.robotmoney.net` | `swarm.robotmoney.net` |
| Dapp host | `app.staging.robotmoney.net` | `app.robotmoney.net` |
| Droplets | staging droplets | production droplets |
| Spaces (marketing) | `rm-marketing-staging` | `rm-marketing-prod` |
| Postgres | single-node (cost) | **HA cluster** |

D21 retired the MCP transport (formerly its own `mcp.` host on port `8443`,
co-located on the `swarm.` droplet — D18); members now use `swarm.`'s
REST API like every other client. Decommissioning the `mcp.` DNS record,
firewall rule, and container is tracked as D21's follow-up implementation
work.

### 2.1 Marketing cutover host — the `api` process, serving an assembled `STATIC_DIR`

**`robotmoney.net` cuts over onto the `api` process** (decision
[D29](../decisions.md#d29--the-api-process-static_dir-is-the-cutover-host-for-robotmoneynet-and-its-deploy-path-prerenders-per-route-html-issue-480)),
which co-serves the marketing SPA from `STATIC_DIR` with no reverse proxy
(D11/D13) — the shape the cutover origin `site.robotmoney.net` already runs
behind the connector in §3.3. **Cloudflare Pages is not a production host
here**: §1 disables Cloudflare git integration, the §3.1 token carries no Pages
permission, and the one Pages project (`robotmoney-preview`, D20) has automatic
production deploys disabled with previews limited to `preview/*`. D13's DO
Spaces CDN (§4.2) remains the intended end-state tier for marketing and is not
yet wired; it inherits everything below unchanged, because what it would upload
is the same assembled directory.

**`STATIC_DIR` is a build output, not the source tree.** `frontend/public` holds
exactly one `index.html` — the home-page shell — so an api serving it answers
every extensionless route with the home page's `<title>`/`og:*`, and every
shared link unfurls as the home page (unfurlers never run
`assets/js/app/seo.js`). The deploy path therefore assembles:

```sh
bun run static:assemble        # scripts/static-assembly.sh → _static/
```

which copies `frontend/public` into `_static/` and runs `scripts/prerender.ts`
over it (`PRERENDER_DIR=_static`), writing a `<route>/index.html` for every
`<loc>` in `frontend/public/sitemap.xml` from `seo.js`'s `metaFor` table — the
same prerenderer `scripts/cloudflare-statics.sh` runs over `_site`, so there is
one metadata table for both hosts. `docker-compose.yml` bind-mounts `./_static`
read-only at `/srv/frontend`.

**Operationally:**

- `scripts/stack/stack.ts`'s `up()` runs the assembly before `docker compose up`,
  so `bun run demo`, `bun run demo -- --stage`, the evals and CI all serve
  prerendered HTML with no extra step. Assembly failure aborts the bring-up.
- A **hand-run `docker compose -p <project> up -d` must run `bun run
  static:assemble` first.** Docker creates an *empty* directory at a bind path
  that does not exist, and the api would then serve nothing. (`-p` is not
  optional — see "FIRST: find the project name" in §2.1.)
- A **redeploy that changes `sitemap.xml` or `seo.js` must re-run the assembly**;
  the prerendered files are otherwise stale. The assembly empties `_static/` in
  place (never `rm -rf`), so it is safe to re-run against a live bind mount.
- `scripts/tests/integration/prerender-static-dir.test.ts` is the CI gate: it
  runs the real assembly, boots the real `backend/src/api/index.ts` against it,
  and fails red if any sitemap route answers with the home-page shell's metadata.

**The api refuses to start against a handle/id namespace violation** (issue
#602). `docker compose up -d` runs neither `migrate` nor
`backend/scripts/db-preflight.ts`, so `backend/src/api/index.ts` re-checks the
one invariant a restore can get in behind — one member's handle being another
member's id, which makes `/swarm/members/<name>` address two members — before it
binds a port. On a violation the container exits non-zero with
`[api] REFUSING the boot: …`, naming both members; with `restart:
unless-stopped` it will restart-loop until repaired.

**The repair, exactly.** Every refusal line ends with the statement that fixes
that line:

```
member 'a1' has handle 'woon', which is member 'woon's id
  — repair: UPDATE swarm_members SET handle = '<a name nobody else holds>' WHERE id = 'a1';
```

Run **one statement per line printed, all of them**, then restart the api.
Two rules, both verified against a real Postgres carrying migration 0031's
trigger rather than reasoned about:

- The statement moves the **holder**'s handle — the member named *first* on that
  line, whose handle is the offending value. Updating the **shadowed** member's
  handle instead reports `UPDATE 1`, raises no trigger error and leaves the
  violation exactly in place; restarting then produces the identical refusal.
- A **mutual** collision (A's handle is B's id *and* B's handle is A's id) prints
  **two** lines and needs **two** updates. After the first, one violation
  remains and the boot is still refused.

Nothing repairs it automatically: each statement repoints a live published URL,
and only an operator can choose the new name.

**The same two rules apply if it is the MIGRATION that refuses.** On a
first-time install of `0031_swarm_member_handle_namespace.sql` over already
restored violating rows (a brand-new database seeded from an old dump, then
migrated), the migration's own `DO` block raises before the trigger is created
and the message says *"Change one of the two public names"*. That wording
predates the correction above and is wrong in the same way: **update the
holder** — the member whose *handle* is the offending value — not the shadowed
one, and run one update per pair reported. The migration file is deliberately
left as-is: `backend/src/db/migrate.ts` tracks applied migrations by filename,
so editing an applied file changes nothing anywhere it already ran, and this
repo treats applied migrations as frozen artefacts.

**FIRST: find the project name. Every compose command below needs `-p`.**
Nothing in this repo runs a bare `docker compose`. Every invocation is built as
`docker compose -p <project> -f …` (`scripts/stack/config.ts:275`), and the
spawn env deliberately does **not** export `COMPOSE_PROJECT_NAME` or
`COMPOSE_FILE` (`scripts/stack/config.ts:200`) so a stale exported value can
never redirect a bring-up. A bare `docker compose …` pasted into your shell
therefore does not inherit the project — it falls back to the directory name and
**can address a different stack, or none**.

That is not a theoretical mismatch here: outside GitHub Actions the project name
is **random per boot** — `rm_demo_stack_<10 hex>`, where the hex is
`shortHash(crypto.randomUUID())` (`scripts/stack/naming.ts:138`, `:149-151`). Two
boots leave two projects, and a command scoped to the wrong one reports on an
orphan.

```bash
# Authoritative for the LAST boot this checkout made: .agents/demo-state.json,
# which `bun run demo:status` reads and prints (scripts/demo-status.ts:111).
RM_PROJECT="$(bun -e 'console.log(JSON.parse(await Bun.file(".agents/demo-state.json").text()).project)')"
echo "$RM_PROJECT"     # e.g. rm_demo_stack_0114ac93de

# Cross-check against what is actually RUNNING — this is what catches an
# orphaned stack from an earlier boot that the state file no longer names.
docker compose ls
```

If `docker compose ls` shows more than one `rm_demo_stack_*` project, the state
file names only the most recent one; tear the rest down (`bun run demo:down`
after re-pointing, or `docker compose -p <other> down`) before you diagnose
anything, or you will read the wrong container's logs.

For a hand-run production stack you chose the project yourself — use that name.
Export it once and every command below is safe to paste:

```bash
export RM_PROJECT=rm_demo_stack_0114ac93de   # or your own
```

**Getting a SQL session to run it in.** The runbook's own two topologies:

```bash
# bundled Postgres (docker-compose.yml). Its host port is Docker-assigned by
# design, so go in through the container rather than guessing a port. The
# variables are expanded INSIDE the container by `sh -lc` on purpose: compose
# sets them on the postgres service, but your own shell has never seen them
# (their defaults live in docker-compose.yml's `${POSTGRES_USER:-robotmoney}`
# interpolation and in .env), so an unquoted paste would run `psql -U "" ""`.
docker compose -p "$RM_PROJECT" exec postgres sh -lc 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'

# managed Postgres (§4.3). $DATABASE_URL here IS a variable of your own shell —
# export it, or paste the url literally:
psql "$DATABASE_URL"
```

**If the guard is wrong, or the site must come up before the data can be fixed.**
Set **`RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1`** in the **droplet env** — the same
place `DATABASE_URL` and the tokens live (§4.4), from where CI's `docker compose
pull && up -d` interpolates it — and redeploy. **`up -d`, never `restart`**: the
recreate is what delivers the new value (see the box at the end of this section;
OPS-610-009). **That variable reaches the
container only because `docker-compose.yml`'s api `environment:` block names
it**: that block is an allowlist, there is no `env_file:` in any compose file
here and `backend/Dockerfile` sets no `ENV`, so a variable it does not name is
simply never delivered and the api's refusal log will still tell you to set the
variable you just set. (`scripts/tests/integration/demo-compose-config.test.ts`
asserts both this variable and `PG_NAMESPACE_GUARD_TIMEOUT_MS` resolve into the
api service in every composition, from real `docker compose config` output, so
that block cannot lose them silently.)

The api then logs the same block plus an `OVERRIDE:` line, serves anyway, and
reports `handle_namespace: "overridden"` at `/health` for the whole life of the
process. It is not silent and it is not sticky **in the process** — but it *is*
sticky in the deploy environment, and it disarms the guard for every future
boot, so **unset it and redeploy once the rows are repaired**. A boot that finds
the variable set and no violation to override says exactly that
(`… is set but this boot found no violation to override — the guard is
DISARMED …`), which is the only signal that distinguishes a safe system from a
disarmed one once the data is clean. Rolling the whole release back instead
means redeploying the previous image tag (`docker compose -p "$RM_PROJECT" pull
&& docker compose -p "$RM_PROJECT" up -d` against the prior tag, §4.4); the guard
is boot-time only, so a rollback removes it immediately.

**What still boots, and how to tell.** An empty database, a pre-0030 schema, and
a database the api cannot query all boot normally. The last of those logs
`handle/id namespace guard could NOT run` — the greppable line — and serves
**UNCHECKED**. Because container logs are not scraped anywhere and the api's
json-file buffer rotates (`x-logging`: 10MB × 3), that line is not a durable
signal, so the same outcome is also readable at **`/health`**.

Reaching `/health` needs the same care the psql block above takes with Postgres:
`8787` is the **container-internal** port and answers nothing on the host, because
this compose file publishes the api with the short form `- "8787"` and the daemon
picks the host port. Ask for it rather than guessing, or go in through the
container:

```bash
# bundled compose (docker-compose.yml) — host port assigned by the daemon.
# `-p` is required: see "FIRST: find the project name" above. This is the same
# form docker-compose.yml:230 documents.
curl -s "http://127.0.0.1:$(docker compose -p "$RM_PROJECT" port api 8787 | cut -d: -f2)/health"

# …or from inside the container. NOT curl: the image is oven/bun and carries no
# curl, which is why the compose healthcheck itself uses `bun -e`.
docker compose -p "$RM_PROJECT" exec api bun -e 'console.log(await (await fetch("http://127.0.0.1:8787/health")).text())'

# pinned-origin host (§3.3): 48787, the one fixed host port in the system
curl -s http://127.0.0.1:48787/health

# {"status":"ok","env":"…","db":"up","handle_namespace":"clean"}
```

(A literal `127.0.0.1:8787` is right in exactly one place — a host-side `bun run`
of the backend, where `backend/src/config.ts`'s default applies — which is not
either deployment topology.)

`handle_namespace` is `clean` (the check ran and found nothing), `unchecked`
(the database was not queryable within the guard's budget — this boot proves
nothing; once the database is queryable again, `docker compose -p "$RM_PROJECT"
up -d api` to get a checked boot, since nothing re-checks it in place) or
`overridden`.
**A 200 from `/health` is not by itself evidence the guard ran; that field is.** The status code stays 200 in every case on purpose:
the compose healthcheck keys on `.ok`, and failing it because Postgres was slow
at boot would trade a wrong-attribution risk for a restart loop.

`handle_namespace` is readable whenever `/health` answers, which is every case
except one: against a **black-holed** database (packets dropped, no RST — a
firewall-rule mismatch or a managed-Postgres failover), `/health`'s own
`SELECT 1` on the shared pool is unbounded and Bun closes the connection on its
idle timeout first (10s by default, and enforced on a coarse timer — measured
8.0s, 12.0s and 12.0s on three consecutive requests), so `curl` reports an empty
reply and you see neither `db` nor `handle_namespace`. That is a pre-existing
property of `/health` — it predates
this guard and is not changed by it; a database that *rejects* connections
answers 200 immediately. In that one state the `[api]` log line above is the
only signal, so **read the container log (`docker compose -p "$RM_PROJECT" logs
api | grep 'namespace guard'`) when `/health` does not answer at all.**

**Bounded.** The guard cannot delay the boot by more than its wall-clock budget
(`PG_NAMESPACE_GUARD_TIMEOUT_MS`, an integer count of **milliseconds**, default
`8000`) for *any* database state — down, slow, black-holed, or with
`swarm_members` held under an `ACCESS EXCLUSIVE` lock by a migration replay,
`REINDEX` or `VACUUM FULL`. It runs on its own connection with server-side
`statement_timeout`, `lock_timeout` and `connect_timeout`, and each attempt
races the time remaining.

Set it where the override is set — the droplet env, passed into the container by
`docker-compose.yml`'s api `environment:` allowlist (see above; a variable that
block does not name never arrives). Write that value as **milliseconds only** —
`PG_NAMESPACE_GUARD_TIMEOUT_MS=15000`, never `15s`. A value that is not a positive number is **ignored**: the api logs
`[api] PG_NAMESPACE_GUARD_TIMEOUT_MS="15s" is not a positive number of
MILLISECONDS — IGNORING it and using 8000ms` and boots on the default. It never
runs unbounded and never refuses the boot over a typo, but you did not get the
budget you asked for, so grep for that line after changing it.

There is also a **ceiling**: `2147483647` (the largest delay a timer can hold,
~24.8 days). Above it a bigger number is not a bigger budget — the timer clamps
to 1ms and the guard would retry once a second in front of the port, binding
nothing and logging nothing — so such a value is ignored exactly like a typo,
with its own line (`… is larger than the maximum 2147483647ms a timer can hold —
IGNORING it and using 8000ms`). In practice a ten-digit value here is a duration
written in the wrong unit (microseconds or nanoseconds); write milliseconds.

**A value at or just under that ceiling is ACCEPTED, silently, and is a budget
of up to 24.8 days.** Nothing rejects it, because the only defensible ceiling is
what a timer can hold. While an accepted budget is running against an unqueryable
database the api has **bound no port and logged nothing** — it is indistinguishable
from a hung boot, for as long as the budget lasts. So write this value in
**seconds' worth of milliseconds** (`8000`, `15000`, `30000`), never a count that
works out to hours or days: nine or ten digits here is always a unit error, and
the api cannot tell it from an intention.

**It is a boot-time snapshot, not a standing guarantee.** The check runs once,
at process start; there is no periodic re-check and no request-path re-entry.
**After any `pg_restore` (or manual bulk load) into a database a running stack
is already connected to, recreate the api** — `docker compose -p "$RM_PROJECT"
up -d api` — because nothing re-validates a database that changed underneath a
live process, and a restore is precisely the population path this guard exists
for. (`docker compose -p "$RM_PROJECT" restart api` is enough *here*, where no
environment changed — but see the box below, and prefer the one verb that is
always correct.)

> **`docker compose restart` does NOT apply environment changes.** `restart`
> stops and starts the **existing** container with the environment it was
> created with; only `up -d` **recreates** it and picks up a changed
> `RM_ALLOW_HANDLE_NAMESPACE_VIOLATION`, `PG_NAMESPACE_GUARD_TIMEOUT_MS`, or any
> other value. This is verified against real compose, not reasoned about: with
> the override exported, `restart api` leaves the container at
> `RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=` — unchanged — and the api prints the
> identical refusal telling you to set the variable you just set, with no port
> bound and no `/health` to check. **Whenever you change a variable in this
> runbook, the follow-up verb is `docker compose -p "$RM_PROJECT" up -d`** (or a
> full stack restart — `bun run demo`/`bun smoke` again), never `restart`.
> Tracked as OPS-610-009 in issue #611.

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
explicit demo schedules, fixture-backed `/projects`), not a production one — see §5 for
what a production deployment requires instead.

### 3.4 Origin CA certificate (for the proxied app subdomains)

The `swarm.`/`app.` droplets are Cloudflare-proxied, so each serves a
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
  path (swarm take authorship, the member-agent onboarding containers). ONE
  variable name across CI / Stage / local, with a **different value in each**, so
  spend is attributable and rotating one never touches another. Needs pay-as-you-go
  credit on its Zen workspace (an opencode subscription does not fund it).
  `AGENT_MODEL` selects which model it buys — see `.env.example` and
  `scripts/lib/model-registry.ts`; `AGENT_MODEL=free` runs with no key at all.
  **When that credit runs out**, the key still authenticates and every paid call
  fails with Zen's typed `CreditsError`. Real-inference CI (the `e2e`
  full-stack job, the onboarding eval) then goes red with
  `cause=exhausted-credits` on the member failure line — that string means
  *top up the workspace balance*, not that the application regressed, and no
  rerun can clear it (the provider marks it `isRetryable: false`). Kinds are
  classified at the inference boundary
  (`scripts/agent/inference-failure.ts`): `auth-rejected` is a bad or revoked
  key, `quota-limited` a plan cap, `throttled` the only one worth retrying.
  Observed 2026-08-05, when the balance ran out mid-morning and six e2e runs
  were misread as an intermittent provider outage.
- **`PROJECTS_SOURCE=live`** — not a secret, but **required in prod**: the
  `/projects` directory pipelines fail closed
  (`backend/src/projects/access/select.ts` throws
  `projects pipelines require PROJECTS_SOURCE=live in prod`) rather than serve
  the vendored fixture directory as production data. Leave unset in demo/dev
  (offline fixture source); the ephemeral CI env is always hermetic regardless.
- Any swarm signing secrets as applicable.

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
