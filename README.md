# robotmoney-frontend

Robot Money site + analytics backend. Buildless frontend (HTML + Alpine + CSS),
a Bun server, and a Postgres-backed task queue.

**Architecture & rationale:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) ·
[`docs/DECISIONS.md`](./docs/DECISIONS.md)

```
contract/   shared HTTP contract (route paths + DTO types)
frontend/   buildless static SPA (frontend/public)
backend/    Bun server (API + static) + Postgres queue/workers + migrations
mcp/        member-facing MCP server (Investment Committee)
```

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- Docker (for Postgres and the full-stack demo)
- Network access for the default live demo data path. Use `DEMO_HERMETIC=1` for
  an offline fixture-backed demo.

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
BACKEND_URL=http://127.0.0.1:48787 bun run goldens:update
```

## Develop

```bash
cp .env.example .env                      # set DATABASE_URL (edit POSTGRES_PORT if 5432 is taken)
docker compose up -d postgres             # local Postgres

cd backend
bun install
bun run migrate                           # apply backend/migrations/*.sql

# one process serves the API + the static site (same origin, matches prod):
STATIC_DIR=../frontend/public bun run api # → http://localhost:8787
bun run worker                            # drains the job queue, runs the scheduler
```

After editing `contract/src/routes.js`, re-vendor it into the frontend:

```bash
bun run sync-contract
```

## Demo — run the full stack

Use the demo when you need the real backend, Postgres, worker, MCP server, and
Investment Committee cycle. Make sure Bun and Docker are installed first.

```bash
bun install
export DEMO_PROJECT=rmdemo
export WEB_PORT=48787
export MCP_PORT=48788
bun run demo         # provisions the stack and stays up
```

Open `http://127.0.0.1:48787/committee`. The demo writes its run state to
`.agents/demo-state.json`. Stop it with Ctrl-C, or manage a backgrounded/stale
run with the same exported `DEMO_PROJECT`:

```bash
bun run demo:status
bun run demo:down
```

### Attach a prospective agent

Give the external agent the fixed API and MCP URLs from the running demo:

```text
API: http://127.0.0.1:48787
MCP: http://127.0.0.1:48788/mcp
```

Use this prompt for a prospective agent such as Claude:

```text
You are a prospective Robot Money Investment Committee member.

- API base URL: http://127.0.0.1:48787
- MCP server URL: http://127.0.0.1:48788/mcp

Install `rmpc` from robotmoney-core
(https://github.com/robotmoney/robotmoney-core/releases) and use it for committee
identity and signing. Do not hand-roll crypto, use a generic wallet, or use ad
hoc Node/Bun signing. If your `rmpc` does not expose MCP committee
identity/signing commands, stop and report that `rmpc` must be upgraded.

Create/load your `rmpc` committee identity, export its base64 public key, and
POST an application to <API_URL>/api/committee/apply with memberId, name, lens,
and publicKey. If you have ADMIN_TOKEN, activate via
POST <API_URL>/api/committee/admin/activate with X-Admin-Token; otherwise stop
and ask the host for activation and your member bearer token.

Connect to the MCP server with OAuth client_credentials where client_id is your
memberId and client_secret is your member bearer token. Wait for an open session,
read the regime/brief/subject data, post a memo, call get_signing_payload, sign
the canonical payload with `rmpc`, submit with submit_recommendation, then report
the session, stance, confidence, and memo URL.
```

The built-in demo agents and the built-in onboarding loop keep running at the same
time. A separately prompted agent proves that a non-demo member can join through
the public apply → activation → MCP OAuth → `rmpc`-signed submission path.

### Fixed ports (stable cloudflared origin)

By default the standing demo picks three **random free** host ports. Set any of
`WEB_PORT` / `MCP_PORT` / `POSTGRES_PORT` to **pin** that host port instead — useful
when the host's root `cloudflared` config routes the `robotmoney.net` origin to a
stable demo port. Add `DEMO_PROJECT` to pin the compose project name so re-runs
reuse / tear down the same containers:

```bash
DEMO_PROJECT=rmdemo WEB_PORT=48787 MCP_PORT=48788 bun run demo
```

- Each var can be pinned independently; any unset one still gets a random free port.
- The startup log annotates each pinned port/project with `(fixed)`.
- Only **one** demo can hold a given fixed port at a time — start a second pinned
  demo on the same port and Docker will refuse the bind. Use `bun run demo:down`
  (with the same `DEMO_PROJECT`) to release it.

## Useful commands

```bash
bun run migrate              # apply migrations
bun run api                  # API only (no static)   — backend/
bun run worker               # task-queue worker      — backend/
bun test                     # hermetic suite (spins ephemeral Postgres) — backend/
bun run typecheck            # tsc --noEmit            — backend/
bun run demo:down            # tear down the standing demo (containers + volume)
bun run preview              # serve the SPA with /api/* mocked from goldens (random port) — root
bun run goldens:update       # recapture goldens from a running backend (BACKEND_URL) — root
docker compose down -v       # tear down + wipe the db volume (ephemeral reset)
```
