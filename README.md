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
cp .env.example .env         # set DATABASE_URL (+ POSTGRES_* for the bundled db)
docker compose up -d         # postgres + api (serves the site) + worker + mcp
bun run demo                 # runs one committee session: regime + N signed agents via MCP
```

Then open:
- `http://localhost:8787/` — the site · `/regime` — live classification · `/committee` — the session
- `http://localhost:8788/health` — the MCP server

No reverse proxy: the `api` process serves both the API and `frontend/public`.
`bun run demo` is re-runnable (it resets the day's session first).

## Useful commands

```bash
bun run migrate              # apply migrations
bun run api                  # API only (no static)   — backend/
bun run worker               # task-queue worker      — backend/
bun run typecheck            # tsc --noEmit            — backend/
docker compose down -v       # tear down + wipe the db volume (ephemeral reset)
```
