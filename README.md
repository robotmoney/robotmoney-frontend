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

## Frozen build — offline, server-less static SPA

The **frozen** distribution writes the whole SPA into a **self-contained static
directory `dist/frozen/`** that renders every view from point-in-time
`/data/*.json` snapshots — served over HTTP by any dumb static host (GitHub
Pages, S3, nginx, `python3 -m http.server`), with no backend, no database, and no
build tools. The one code seam is `lib/api.js`, which reads
`RM_CONFIG.STATIC_DATA_BASE` (`/data` in the dist) instead of a live API. See
[`docs/ARCHITECTURE.md` §4 "Frozen (offline, server-less static SPA) distribution"](./docs/ARCHITECTURE.md#4-frontend)
for how it works.

```bash
# Bake from a LIVE backend (snapshots every endpoint the frontend requests):
BACKEND_URL=http://127.0.0.1:8787 bun run frozen

# Bake fully OFFLINE from committed fixtures (no backend needed):
bun run frozen:fixtures

# Preview the dist over HTTP (SPA fallback for deep-link refreshes):
bun run frozen:serve            # or: python3 -m http.server -d dist/frozen
```

The bake produces, under `dist/frozen/`:

- The real static SPA (`index.html`, `config.js`, `assets/`, `views/`), with
  vendored p5/Chart.js/Alpine copied locally and the web-font `@import` dropped so
  the dist references **zero external resources** (enforced by
  `scripts/check-frozen-selfcontained.ts`, which scans the whole directory).
- `data/**.json` — one API snapshot per request pathname (e.g.
  `data/api/dashboards/regime-snapshots.json`).
- `404.html` — a copy of `index.html`, so hosts with a custom 404 page serve the
  SPA on a deep-link refresh.
- `frozen-manifest.json` — bake metadata (`bakedAt`, `source`, endpoint list).

**Constraints:** it is a *snapshot* — data is frozen as-of the bake, writes
(POST/PUT/DELETE) are accepted no-ops, and query params are ignored (snapshots are
keyed by pathname). The bake fails loudly if any endpoint the frontend requests
can't be satisfied (no silent gaps). Not for production hosting of live data —
it's for offline demos, archival, and static-host publishing.

## Useful commands

```bash
bun run migrate              # apply migrations
bun run api                  # API only (no static)   — backend/
bun run worker               # task-queue worker      — backend/
bun test                     # hermetic suite (spins ephemeral Postgres) — backend/
bun run typecheck            # tsc --noEmit            — backend/
bun run demo:down            # tear down the standing demo (containers + volume)
bun run frozen               # bake offline static SPA from a live backend    — root
bun run frozen:fixtures      # bake offline static SPA from fixtures (no backend) — root
bun run frozen:serve         # serve dist/frozen over HTTP with SPA fallback   — root
docker compose down -v       # tear down + wipe the db volume (ephemeral reset)
```
