# robotmoney-frontend

**Deployment documentation:** [Smoke production spec](docs/technical/smoke-production-spec.md)
is the sole adopted design (approved for implementation, not yet shipped).
[Release policy](docs/technical/release-runbooks.md) remains in force. Historical
release procedures and unadopted deployment proposals have been removed from the
documentation tree; recover them from Git when historical evidence is needed.

Robot Money site + analytics backend. Buildless frontend (HTML + Alpine + CSS),
a Bun server, and a Postgres-backed task queue.

**Architecture & rationale:** [`docs/architecture.md`](./docs/architecture.md) ·
[`docs/decisions.md`](./docs/decisions.md)

**Research & regime engine:** the market-regime classifier and the two
research signals (`channel-divergence`, `late-cycle-signals`) are documented
in [`docs/technical/regime-engine.md`](./docs/technical/regime-engine.md) and
[`docs/technical/research-signals.md`](./docs/technical/research-signals.md) —
what they compute, why, and where the numbers come from. Entry point:
`backend/src/analytics/index.ts::runAnalytics`.

```
contract/   shared HTTP contract (route paths + DTO types)
frontend/   buildless static SPA (frontend/public)
backend/    Bun server (API + static) + Postgres queue/workers + migrations
```

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- Docker (for Postgres and the full-stack smoke)
- Network access for the **currently shipped smoke implementation** —
  `bun run smoke` boots the production-parity LIVE data path (public Base
  mainnet RPC + the keyless analytics/research providers).
  There is no offline/hermetic smoke mode; a required credential or provider
  that is unreachable fails the boot loudly instead of falling back to a
  fixture (issue #147). The adopted refactor is approved but not yet shipped.

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
carry real field shapes but mock point-in-time values; use `bun run smoke` for
real backend behavior.

```bash
BACKEND_URL=http://127.0.0.1:<smoke api port> bun run goldens:update
```

Add `?api=prod` or `?api=stage` to the preview URL (or any `?api=<origin>`) to
answer `/api/*` from a live api instead of goldens — reads only, never writes.
See `frontend/preview/index.html`'s header comment.

## Web client versioning and CI

`frontend/package.json` (`@robotmoney/web-client`) versions the static client
independently of `backend/package.json` and `contract/package.json` — see
[decisions.md D45](./docs/decisions.md#d45--the-web-client-gets-its-own-manifest-version-and-merge-gate--narrow-and-fast-separate-from-apibackend-ci-lucas-2026-09-17).
`.github/workflows/web-client.yml` is its own merge gate: client unit tests,
static assembly, and a fixtures-mode Playwright sweep of every route block the
merge; the same sweep against production/stage is advisory only.

```bash
bun run --cwd frontend test           # the client's own unit-test subset
bun run --cwd frontend assemble       # static assembly + prerender
bun run --cwd frontend check          # Playwright sweep, fixtures (blocking in CI)
bun run --cwd frontend check:prod     # same sweep against production (advisory)
bun run --cwd frontend check:stage    # same sweep against stage (advisory)
```

## Develop

```bash
cp .env.example .env                      # set DATABASE_URL
# Host ports are REQUIRED inputs to raw compose now — there is no default
# (see "Ports: always random, except --static-port"). Pick any free port:
POSTGRES_PORT=5433 docker compose up -d postgres   # local Postgres

cd backend
bun install
# Local dev database only: the ungated runner the test harness uses. It is NOT
# `bun run migrate`, which is the production operator command in both
# package.json files (backend/scripts/migrate.ts): it prompts for rm_owner,
# runs the §8.5 gates and writes a receipt (smoke-production-spec.md §8.5).
bun run src/db/migrate.ts                 # apply backend/migrations/*.sql

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

## Full-stack smoke and deployment

The [smoke production design](docs/technical/smoke-production-spec.md) is the
sole adopted target, approved for implementation but not yet shipped. The
running code still exposes its older smoke interface; its presence in the
package scripts does not make it the adopted design or a future runbook.
The [smoke summary](scripts/lib/smoke.README.md) is informational. Production
release gates remain in [release policy](docs/technical/release-runbooks.md).

The design specifies a detached boot, separate status and shutdown commands,
per-instance state, explicit participant configuration, target identity checks,
and schema and privilege preflight. Those interfaces do not exist in the running
implementation yet. Some command names overlap with legacy scripts, but that
does not mean they implement this contract. A release procedure must be validated
against the exact code and commit that it exercises; the adopted design cannot be
operated until its tools are implemented.

For frontend-only work, use [preview mode](#preview-mode--view-the-site-with-no-backend).

## Useful commands

```bash
bun run preview          # frontend with API responses from committed goldens
bun run api              # API only — backend/
bun run worker           # task-queue worker — backend/
bun test                 # backend suite
bun run typecheck        # backend TypeScript check
bun run --cwd frontend test
bun run --cwd frontend assemble
bun run --cwd frontend check
```
