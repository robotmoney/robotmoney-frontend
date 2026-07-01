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
bun run demo                 # provisions everything, runs committee sessions, keeps it live
```

That's it — no separate `docker compose up` needed. `bun run demo` is a
self-contained orchestrator (`scripts/demo.ts`) that on every run:

- picks three **random free ports** (Postgres, API, MCP) so repeated/concurrent
  runs never collide;
- brings up Postgres in Docker under a **unique compose project**, runs
  migrations, then starts the API (serving the static site), the worker, and the
  MCP server as Bun child processes;
- drives **two sessions of that one committee** through the MCP server (regime +
  N signed agents, one deliberate no-show per session; the second session reviews
  a different subject the next day and references the first's outcome);
- prints the live URLs and **keeps the servers running** so you can open a
  browser;
- on Ctrl-C / exit (or any startup failure) **tears down every container and
  volume it created** — nothing is left behind.

The printed URLs use that run's random API/MCP ports, e.g.:
- `http://localhost:<api>/` — the site · `/regime` · `/committee` · `/research/*`
- `http://localhost:<mcp>/health` — the MCP server

No reverse proxy: the `api` process serves both the API and `frontend/public`.

## Useful commands

```bash
bun run migrate              # apply migrations
bun run api                  # API only (no static)   — backend/
bun run worker               # task-queue worker      — backend/
bun test                     # hermetic suite (spins ephemeral Postgres) — backend/
bun run typecheck            # tsc --noEmit            — backend/
docker compose down -v       # tear down + wipe the db volume (ephemeral reset)
```
