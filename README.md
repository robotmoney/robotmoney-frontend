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
  the worker's scheduler under `DEMO_FAST_SCHEDULES`) and committee sessions (driven
  by signed MCP agents) — so the site keeps showing fresh data;
- **keeps everything running** — it does NOT tear down on Ctrl-C or on startup
  failure. Stop it explicitly with `bun run demo:down`.

In an interactive terminal it renders a **live TUI** (service URLs, container
startup/healthcheck status, and split Research / Committee activity panes); verbose
output goes to `.agents/demo-<project>.log`, not the screen. Disable with `NO_TUI=1`
(or a non-TTY / CI), which falls back to plain line logging.

The printed URLs use that run's random API/MCP ports, e.g.:
- `http://127.0.0.1:<api>/` — the site · `/regime` · `/committee` · `/research/*`
- `http://127.0.0.1:<mcp>/health` — the MCP server

No reverse proxy: the `api` process serves both the API and `frontend/public`.

## Useful commands

```bash
bun run migrate              # apply migrations
bun run api                  # API only (no static)   — backend/
bun run worker               # task-queue worker      — backend/
bun test                     # hermetic suite (spins ephemeral Postgres) — backend/
bun run typecheck            # tsc --noEmit            — backend/
bun run demo:down            # tear down the standing demo (containers + volume)
docker compose down -v       # tear down + wipe the db volume (ephemeral reset)
```
