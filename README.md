# robotmoney-frontend

Robot Money site + analytics backend. Buildless frontend (HTML + Alpine + CSS),
a Bun server, and a Postgres-backed task queue.

**Architecture & rationale:** [`docs/architecture.md`](./docs/architecture.md) ·
[`docs/decisions.md`](./docs/decisions.md)

```
contract/   shared HTTP contract (route paths + DTO types)
frontend/   buildless static SPA (frontend/public)
backend/    Bun server (API + static) + Postgres queue/workers + migrations
```

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- Docker (for Postgres and the full-stack demo)
- Network access — `bun run demo` always boots the production-parity LIVE data
  path (public Base mainnet RPC + the keyless analytics/research providers).
  There is no offline/hermetic demo mode; a required credential or provider
  that is unreachable fails the boot loudly instead of falling back to a
  fixture (issue #147).

`bun run preview` only needs Bun and the checked-in goldens. It does **not** need
Docker, Postgres, backend services, or network access.

## Preview mode — view the site with no backend

Use preview for frontend/layout work. It serves the live `frontend/public` SPA and
mocks every `/api/*` route from committed goldens.

```bash
bun install
bun run preview      # open the printed URL
```

Preview binds a random free port, so multiple previews can run at once. Goldens
carry real field shapes but mock point-in-time values; use `bun run demo` for
real backend behavior.

```bash
BACKEND_URL=http://127.0.0.1:<demo api port> bun run goldens:update
```

## Develop

```bash
cp .env.example .env                      # set DATABASE_URL
# Host ports are REQUIRED inputs to raw compose now — there is no default
# (see "Ports: always random, except --static-port"). Pick any free port:
POSTGRES_PORT=5433 docker compose up -d postgres   # local Postgres

cd backend
bun install
bun run migrate                           # apply backend/migrations/*.sql

# one process serves the API + the static site (same origin, matches prod).
# Point STATIC_DIR at the ASSEMBLED dir, not the source tree: `_static/` is
# frontend/public plus the per-route prerendered HTML link unfurlers read
# (docs/decisions.md D29). `../frontend/public` still works, but then every
# route answers with the home page's <title>/og:* — the bug #480 fixed.
bun run static:assemble                   # → _static/ (repo root)
STATIC_DIR=../_static bun run api         # → http://localhost:8787
bun run worker                            # drains the job queue, runs the scheduler
```

After editing `contract/src/routes.js`, re-vendor it into the frontend:

```bash
bun run sync-contract
```

## Demo — run the full stack

Use the demo when you need the real backend, Postgres, worker, and Investment
Swarm cycle. Make sure Bun and Docker are installed first.

```bash
bun install
bun run demo         # provisions the stack and stays up
```

Every published host port is drawn **free at boot, on every run** — there is no
fixed default, and `WEB_PORT` / `POSTGRES_PORT` are no longer inputs (see
[Ports](#ports-always-random-except---static-port) below). The demo prints the port it
picked; open `http://127.0.0.1:<that port>/swarm`. The demo writes its run
state to `.agents/demo-state.json`. Stop it with Ctrl-C, or manage a
backgrounded/stale run from that state file:

```bash
bun run demo:status
bun run demo:down
```

### `bun run demo:stage` — the standing/public demo in one command

```bash
bun run demo:stage
```

A thin wrapper that decides two flags and then runs the ordinary demo, printing
the equivalent `bun run demo -- …` so the choice is always reproducible by hand:

- **`--static-port` always** — this is the boot a tunnel points at, so it takes
  the fixed host port rather than whatever Docker hands out.
- **`--external-pg` when `.env` describes a Postgres** — otherwise the demo's own
  ephemeral container, exactly as a plain `bun run demo` would use. An `.env`
  that is missing, has no database, or has an unusable one falls back quietly;
  nothing about probing may fail a boot.

This is the one command allowed to *infer* a data path, because inferring is its
documented job and it announces the choice before anything starts. `bun run demo
-- …` stays fully explicit. Extra flags pass through: `bun run demo:stage --
--no-tui`.

### Use a managed Postgres instead of the ephemeral container

By default the demo runs its own throwaway `postgres` container and a
fresh-per-run `pgdata` volume. `--external-pg` runs it against a managed server
instead, and starts **no postgres container at all** — no service, no volume, no
published pg port:

```bash
bun run demo -- --external-pg
```

The connection details come from **`.env`**, which the flag reads directly (not
from the ambient environment — a stray exported `host` must never decide which
database a demo writes to). `DATABASE_URL` wins when present; otherwise the
discrete keys DigitalOcean's connection panel prints are assembled into one, so
a pasted panel works unedited:

```ini
# either this…
DATABASE_URL=postgres://user:password@host:25060/defaultdb?sslmode=require

# …or exactly what DigitalOcean's "Connection details" panel gives you
username = doadmin
password = …
host     = private-dbaas-….g.db.ondigitalocean.com
port     = 25060
database = defaultdb
sslmode  = require
```

The **switch** stays a CLI argument (same hard rule as `--pg-data` and
`--static-port`): pointing a demo at a persistent database is a property of one
deliberate invocation, never of a shell that happens to have something exported.
`.env` only supplies the address.

**This writes to a real database.** The boot runs migrations and seeds against
that server, and the workers write to it for as long as the demo runs.
`demo:down` and `demo:clean` cannot undo any of it — they only ever touch
containers and Docker volumes, and there are none here. `demo:status` reports
`pg=EXTERNAL` rather than a port, and the state file records only a
password-redacted URL.

Refusals are loud, never a silent fall back to the throwaway container: a
missing `.env`, an unparseable or non-`postgres://` URL, or a URL pointing at
`postgres`/`localhost` (which inside a container means the container itself)
each fail the boot with the reason. `--external-pg` and `--pg-data` are mutually
exclusive.

### Attach a prospective agent

Give the external agent the API URL the running demo printed (the port is
random per run — `bun run demo:status` reprints it):

```text
API: http://127.0.0.1:<demo api port>
```

Use this prompt for a prospective agent such as Claude (REST-only — the MCP
transport was retired, see [`docs/decisions.md`](./docs/decisions.md) D21):

```text
You are a prospective Robot Money Investment Swarm member.

- API base URL: http://127.0.0.1:<demo api port>

Install the `swarm-onboarding` skill from robotmoney-core
(https://github.com/robotmoney/robotmoney-core) into your agent harness — it
walks you through installing `rmpc` (the swarm identity/signing client) and
applying over the REST API. Do not hand-roll crypto, use a generic wallet, or
use ad hoc Node/Bun signing.

Create/load your `rmpc` swarm identity, export its base64 public key, and
POST a signed application to <API_URL>/api/swarm/apply with name, contact,
lens, publicKey, and an `rmpc` signature over the canonical application payload.
If you have ADMIN_TOKEN, activate via POST <API_URL>/api/swarm/admin/activate
with X-Admin-Token; otherwise stop and ask the host for activation. Claim your
bearer token by signing the token-claim challenge with `rmpc`. Then, each
session: wait for an open session, read the regime/brief/subject data over REST,
post a memo, canonicalize + `rmpc`-sign the submission, POST it to
<API_URL>/api/swarm/submit with your bearer token, then report the session,
stance, confidence, and memo URL.
```

The built-in demo agents and the built-in onboarding loop keep running at the same
time. A separately prompted agent proves that a non-demo member can join through
the public apply → activation → claim → `rmpc`-signed REST submission path.

### Ports: always random, except `--static-port`

Every published host port (api **and** postgres) is drawn free at boot, on every
run. There is no fixed default anywhere: `docker-compose.yml` requires
`WEB_PORT`/`POSTGRES_PORT` (`${VAR:?…}` — it refuses to start rather than fall
back), `.env.example` no longer ships them, and setting them in your shell or
`.env` **does nothing**. `bun run demo` prints a loud warning if it finds one so
you don't believe a pin took effect — **delete both lines from any existing
`.env`.**

Why: the api port used to *prefer* 48787 and either port could be pinned from
the environment. The operator's `.env` pinned both (so nothing was ever random
locally), while CI — which has no `.env` — took the preferred-48787 path and
raced the standing stage demo for the exact port `cloudflared` routes
`stage.robotmoney-labs.dev` to. That was a real outage.

The single exception is the pinned boot:

```bash
bun run demo -- --static-port
```

(Previously spelled `--stage`. That name described an environment when the flag
only ever pinned a port; `--stage` still works and prints a deprecation warning.)

- Pins **only** the web/api host port to `48787`, the tunnel origin. Postgres
  (and anything else published) stays random.
- It is a CLI **argument**, never an env var — same rule as `--pg-data`.
- It prints a prominent warning that a fixed, tunnel-facing port is in use.
- If `48787` is already held it **fails and does not start**, naming what holds
  it (`docker ps` + `ss -tlnp`). It never falls back to a random port:
  `cloudflared` routes 48787 and nothing else, so a fallback would boot green
  and serve a 502.

### Container names and labels

Every container this repo starts is named for the environment that started it
(`scripts/stack/naming.ts`):

| | GitHub Actions | Local |
|---|---|---|
| demo / stack | `rm_ci_stack_<hash>` | `rm_demo_stack_<hash>` |
| onboarding eval | `rm_ci_eval_<hash>` | `rm_demo_eval_<hash>` |
| infra rails check | `rm_ci_infra_<hash>` | `rm_demo_infra_<hash>` |
| backend test postgres | `rm_ci_pgtest_<hash>` | `rm_demo_pgtest_<hash>` |

Under Actions the hash is derived from workflow + run + attempt + job, so it is
stable for every step of one job and distinct across runs; locally it is a
per-boot random value. The same facts are attached as **labels** —
`robotmoney.env=ci|local`, `robotmoney.env.hash=<hash>`, plus the existing
`robotmoney.demo.project` — which is the channel tooling should select on
(`docker ps --filter label=robotmoney.env=ci`); name matching is for humans.
Set `DEMO_PROJECT` to override the compose project name if you want re-runs to
reuse / tear down the same containers.

## Useful commands

```bash
bun run migrate              # apply migrations
bun run api                  # API only (no static)   — backend/
bun run worker               # task-queue worker      — backend/
bun test                     # hermetic suite (spins ephemeral Postgres) — backend/
bun run typecheck            # tsc --noEmit            — backend/
bun run demo:down            # tear down the standing demo (containers + network; KEEPS pg data)
bun run demo:clean           # delete stopped demos' pg data volumes (label robotmoney.demo=1)
bun run demo:reap -- --dry-run          # SHOW errant containers a sweep would remove (changes nothing)
bun run demo:reap -- --older-than 6h    # …then actually reap them (labels only, never name matching)
bun run demo -- --pg-data <host-dir>   # resumable demo: bind postgres data to <host-dir>
bun run demo -- --external-pg          # run against the MANAGED Postgres in .env (no pg container)
bun run preview              # serve the SPA with /api/* mocked from goldens (random port) — root
bun run goldens:update       # recapture goldens from a running backend (BACKEND_URL) — root
docker compose down -v       # tear down + wipe the db volume (ephemeral reset)
```
