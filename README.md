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
- Docker (for Postgres)

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

## Run the full stack + end-to-end demo

> **One committee, many of everything else.** There is exactly **one** Investment
> Committee. It has many **members** (autonomous signing agents, each with an
> analytical lens — macro risk, on-chain flows, momentum, contrarian), reviews many
> **subjects** (the portfolios under review, e.g. Woon Treasury, Mav Holdings), and
> runs many **sessions** (one per date + subject). Each member posts at most one
> signed **take** per session; a member who doesn't submit is recorded **absent**.
> The plurals (members / subjects / sessions / takes) are the moving parts — *not*
> multiple committees.

```bash
bun run demo                 # provisions everything, then runs a standing demo (stays up)
bun run demo:status          # show the running demo's containers
bun run demo:down            # tear down the demo (containers + volume)
```

That's it — no separate `docker compose up` needed. `bun run demo` is a
self-contained orchestrator (`scripts/demo.ts`) that:

- picks three **random free ports** (Postgres, API, MCP) so repeated/concurrent
  runs never collide, and records the run to `.agents/demo-state.json`;
- brings up Postgres in Docker under a **unique compose project**, runs
  migrations, then starts the API (serving the static site), the worker, and the
  MCP server as Bun child processes;
- prints the live URLs once the stack is healthy, then runs **recurring demo
  actions on a ~2-minute staggered cadence** — regime + research refresh (driven by
  the worker's scheduler under `DEMO_FAST_SCHEDULES`) and **committee sessions of that
  one committee** (regime + N signed MCP agents, one deliberate no-show per session;
  successive sessions review different subjects and reference prior outcomes) — so the
  site keeps showing fresh data;
- **stays up until you stop it** — Ctrl-C / SIGTERM tears the stack down (containers +
  volume) and prints the log-file path; a startup failure instead leaves it up for
  inspection. `bun run demo:down` tears down a demo left running in the background.

In an interactive terminal it renders a **live TUI** (service URLs, container
startup/healthcheck status, and split Research / Committee activity panes); verbose
output goes to `.agents/demo-<project>.log`, not the screen. Disable with `NO_TUI=1`
(or a non-TTY / CI), which falls back to plain line logging.

The printed URLs use that run's random API/MCP ports, e.g.:
- `http://127.0.0.1:<api>/` — the site · `/regime` · `/committee` · `/research/*`
- `http://127.0.0.1:<mcp>/health` — the MCP server

No reverse proxy: the `api` process serves both the API and `frontend/public`.

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

## Frozen build — offline, server-less single file

The **frozen** distribution bakes the whole SPA into **one self-contained
`dist/frozen/index.html`** that renders every view **offline** — a non-technical
user can double-click it (`file://`, no server, no network, no build tools) and
browse a point-in-time snapshot of the site. See
[`docs/ARCHITECTURE.md` §4 "Frozen (offline single-file) distribution"](./docs/ARCHITECTURE.md#4-frontend)
for how it works.

```bash
# Bake from a LIVE backend (snapshots every endpoint the frontend requests):
BACKEND_URL=http://127.0.0.1:8787 bun run frozen

# Bake fully OFFLINE from committed fixtures (no backend needed):
bun run frozen:fixtures
```

Both produce, under `dist/frozen/`:

- `index.html` — the single self-contained file (app + views + baked API JSON +
  vendored p5/Chart.js/Alpine, all inlined). Open it directly: `file://…/dist/frozen/index.html`.
- `frozen-manifest.json` — bake metadata (`bakedAt`, `source`, endpoint list, byte size).

**Constraints:** it is a *snapshot* — data is frozen as-of the bake, writes
(POST/PUT/DELETE) are accepted no-ops, query params are ignored (keyed by
pathname), and the URL bar stays on `index.html` while views swap in place. The
bake fails loudly if any endpoint the frontend requests can't be satisfied (no
silent gaps). Not for production hosting of live data — it's for offline demos,
archival, and email/USB hand-off.

## Useful commands

```bash
bun run migrate              # apply migrations
bun run api                  # API only (no static)   — backend/
bun run worker               # task-queue worker      — backend/
bun test                     # hermetic suite (spins ephemeral Postgres) — backend/
bun run typecheck            # tsc --noEmit            — backend/
bun run demo:down            # tear down the standing demo (containers + volume)
bun run frozen               # bake offline single file from a live backend  — root
bun run frozen:fixtures      # bake offline single file from fixtures (no backend) — root
docker compose down -v       # tear down + wipe the db volume (ephemeral reset)
```
