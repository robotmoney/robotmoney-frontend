# Release cycle & topology compatibility

> **Status: first draft, open for discussion.** This is a proposal, not a
> ratified spec — there is no accepted decision in
> [decisions.md](../decisions.md) behind any of it yet. Treat the "Open
> questions" section at the end as the actual agenda; everything above it is
> a starting position meant to be argued with.

## 1. Purpose

Every environment we have exercised so far — CI, `bun run demo`, and local
dev via `docker-compose.yml` — provisions the database, API, workers, and
frontend **together, from the same checkout, at the same commit**, and
usually from a freshly seeded database (see
[architecture.md § Demo Specification](../architecture.md#demo-specification)).
That gives us zero signal on what happens when the four components drift
apart, because in every environment we've run, they never have. Production
will not have that luxury: per
[decisions.md D13](../decisions.md#d13--vendor-split-tiered-topology-cloudflare-dnsobservability--do-computestorage-surfaces-on-subdomains),
the API/worker tier, the Managed Postgres cluster, and the static marketing
tier are already three separately deployable things on separate lifecycles,
and nothing today stops one of them from shipping before the others catch
up. This doc exists to define a strategy for that drift *before* it happens
in an environment that matters, rather than discovering the failure modes in
production.

## 2. Topology today

Four components, concretely, as they exist in this repo:

- **(a) Database** — one Postgres instance. Schema lives entirely in
  `backend/migrations/*.sql`: forward-only, sequentially numbered files,
  applied once each and tracked in a `schema_migrations` table by
  `backend/src/db/migrate.ts`. There are no down-migrations. `migrate()` runs
  automatically on every API boot (CI, demo, and prod all take this same
  path) and is written to be idempotent/safe to re-run.
- **(b) API backend** — a single Bun process (`Bun.serve`, no framework) at
  `backend/src/api/index.ts`, talking to Postgres directly via `postgres.js`
  raw SQL (`src/db/client.ts`). It also co-serves the buildless frontend's
  static files when `STATIC_DIR` is set — so today the API and the frontend
  assets it serves are, in production, deployed as one unit on the
  `committee.` droplet (see below).
- **(c) Workers (research pipelines)** — a Postgres-backed task queue
  (`jobs`/`job_schedules`/`job_runs`, [decisions.md
  D9](../decisions.md#d9--custom-postgres-backed-task-queue-not-github-actions-cron--pg_cron)),
  consumed by three separately-deployed containers pinned to lanes via
  `WORKER_LANE` (`worker-committee`, `worker-analytics`, `worker-research` —
  see `docker-compose.yml` and
  [architecture.md §7](../architecture.md#7-task-queue--workers)). Workers
  connect to Postgres **directly**, not through the API, using a restricted
  `rm_worker` database role (migration `0016_worker_role.sql`) that is
  explicitly denied write access to analytics tables. A fourth process, the
  **analytics-producer**, is not a queue worker at all — it runs its own cron
  timers and talks to the API exclusively over authenticated HTTP through
  typed routes (`POST /api/analytics/regime-snapshots`, etc.), never touching
  Postgres directly.
- **(d) Frontend** — a buildless static SPA (`frontend/public/`: plain HTML +
  hand-written CSS + Alpine.js, no bundler — [decisions.md
  D2](../decisions.md#d2--buildless-no-ahead-of-time-transpilecompilebundle)).
  It talks to the API only over HTTP through `contract/src/routes.js` and
  `frontend/public/assets/js/app/lib/api.js`.

**How these deploy today.** CI and `bun run demo` use one
`docker-compose.yml` box: postgres + api + the three worker containers +
the producer, all built from the same checkout, migrated and started
together. There is no deploy automation in this repo yet — no
`.github/workflows/deploy*.yml` exists; the CI workflows present
(`backend.yml`, `contract.yml`, `frontend.yml`, `integration.yml`,
`e2e.yml`, `research-pipeline.yml`, `unit.yml`, `onboarding-eval-rails.yml`,
`repo-guards.yml`, `docs-lint.yml`) are all test gates, not release
pipelines. [`docs/runbooks/deployment.md`](../runbooks/deployment.md)
describes the *intended* GitOps shape for production (CI-driven,
environment-scoped secrets, "merge to `dev` → staging, tag a release →
production" given explicitly as an example to adapt) but that pipeline isn't
implemented yet. Production's actual topology per D13, once built, separates
into: an **API tier** droplet (API + all three worker containers
co-located — currently one deploy unit at the infra level even though they
are separate containers), a **data tier** (DO Managed Postgres HA, entirely
independent lifecycle), and a **static tier** (marketing served from DO
Spaces CDN, decoupled from the API entirely). The committee/dashboard SPA,
however, is still co-served by the API process (`STATIC_DIR`) — so today
that slice of the frontend is version-locked to whatever API build is on the
droplet, while marketing is not.

## 3. Per-component release cadence

- **(a) Database.** Triggered by a merged migration file. Because
  `migrate()` runs on every API boot and there's no rollback path, a bad
  migration is a forward-fix, not a revert — this makes migrations the
  highest-blast-radius release of the four. Realistic independence: **low**
  today (migrations ship in the same `backend/` deploy as API code and run
  as a precondition of API startup) but this is a choice, not a technical
  constraint — nothing stops a migration from landing and running well
  before the API code that depends on it. Compatibility risk: if the DB is
  *behind* what the newest API code expects, queries against
  not-yet-existent columns/tables fail outright — there is currently no
  guard against this. If the DB is *ahead* (migration applied, but the API
  build that uses it hasn't rolled out to every instance yet — relevant the
  moment there is more than one API process), older API code should be
  fine only if the migration was additive.
- **(b) API backend.** Triggered by any `backend/src/api/**` change.
  Realistically independent of the DB (given additive migrations) and of
  the workers (they don't call the API — see below), but currently coupled
  to the frontend it co-serves via `STATIC_DIR`. Compatibility risk when
  ahead: new endpoints/fields the frontend doesn't know about yet — safe if
  additive. Compatibility risk when behind: the frontend or workers
  assuming a response shape the API hasn't shipped yet.
- **(c) Workers.** Two different risk profiles under one label. The
  **queue-consuming lanes** (`committee`/`analytics`/`research`) read/write
  Postgres directly with a restricted role, so they are coupled to schema
  shape exactly like the API is, but *without* the API's ability to gate
  behavior behind a runtime check — a worker's compatibility posture is
  whatever its handler code hard-codes. The **analytics-producer** talks to
  the API only over authenticated HTTP through typed routes, so it inherits
  the API's compatibility surface rather than the DB's directly — it is,
  today, the one component already isolated from raw schema drift.
  Realistic independence: workers can deploy independently of the API code
  path (separate containers, separate images) but not of the DB schema
  their handlers assume.
- **(d) Frontend.** Triggered by `frontend/public/**` changes. Marketing
  (DO Spaces CDN) is fully decoupled and can ship any time. The
  committee/dashboard SPA is currently bundled into the API's deploy via
  `STATIC_DIR`, so it has no independent release path today even though
  nothing in its design requires that — it's a buildless static tree that
  could be pushed to its own CDN/bucket target the same way marketing is.
  Compatibility risk: an old cached SPA in a user's browser calling a
  newer/older API than the one it shipped against — a real scenario the
  moment the SPA gets its own CDN and stops being version-locked to the API
  process serving it.

## 4. Compatibility strategy

### 4.1 Expand/contract for DB migrations

Adopt the standard **expand/contract** (a.k.a. parallel-change) pattern for
every schema change that a running API/worker depends on:

1. **Expand** — add the new column/table/index additively; nothing reads it
   yet, nothing existing breaks.
2. **Migrate readers** — ship API/worker code that can read *both* old and
   new shapes, then code that writes the new shape (backfilling old rows as
   needed).
3. **Contract** — once every consumer (API instances, all three worker
   lanes, the analytics-producer) is confirmed on code that no longer
   reads/writes the old shape, drop the old column/table in its own
   migration.

Concretely for this repo: because `migrate.ts` has no down-migration and no
rollback, the "contract" step is the *only* place a schema change is allowed
to be destructive — every other migration in a feature's rollout should be
additive by construction. This also means a migration file should never be
required to land in the same deploy as the API code that depends on it;
today they usually do (§3), and that's the main thing this pattern would
change in practice.

### 4.2 API/DB version skew tolerance

The API should not assume the schema is at exactly the migration count its
own build was compiled against — `migrate()` running as a precondition of
boot masks this today (a single API instance always sees a fully-migrated
DB at the moment it starts), but it stops being true the moment there is
more than one API instance, or migrations and API deploys are decoupled
(§4.1). The right posture is **capability negotiation / feature detection**
rather than hard version pinning: instead of the API asserting "schema must
be exactly N," a query path should check for the concrete thing it needs
(does this column exist, is this table populated) and degrade — return a
partial payload, a `501`, or fall back to the pre-migration behavior —
rather than throwing an unhandled SQL error. This repo already has one real
example of the right shape to generalize: the regime DTO's explicit
staleness block (`{ asof, serverDate, ageDays, stale, thresholdDays }`,
[architecture.md §7.1](../architecture.md#71-analytics-suite-six-stage-pipeline))
lets the frontend render a clearly-marked degraded state instead of the API
silently returning wrong or absent data. The same "declare the degraded
state explicitly in the payload" instinct is what should apply to a
DB-ahead/DB-behind mismatch, not a raw 500.

### 4.3 API versioning for the frontend and workers as consumers

There is no versioning scheme in the API today — routes are flat paths in
`contract/src/routes.js`, shared as literal source between frontend and
backend, not as a semver'd artifact. That's fine as long as frontend and API
are deployed together (today's reality per §2), but the moment the SPA gets
an independent CDN deploy path (§3d), a stale browser tab can call an API
that has moved on. The lightest-weight approach consistent with this
project's minimalism: keep endpoint **shapes** additive-only (new optional
fields, never repurposing or removing a field in place — the same discipline
the goldens-drift gate already enforces for the preview mock layer,
[decisions.md D14](../decisions.md#d14--preview-mode-goldens-backed-over-the-baked-frozen-single-file)),
and reserve an actual path-prefix version (`/api/v2/...`) for the rare
breaking change, with the old prefix kept alive for a declared deprecation
window (§4.5) rather than deleted the day the new one ships. Workers/producer
should follow the same additive-fields discipline since the producer is
already an API consumer over authenticated HTTP (§2c).

### 4.4 Feature flags

No feature-flag infrastructure exists in this codebase today (confirmed —
no `FEATURE_*` env convention, no flag service, no flag table). For a
feature that spans schema + API + frontend + workers, a flag needs to be
readable by whichever of those components guards the user-visible or
data-mutating behavior — realistically that's **the API**, since it's the
one component every write and read passes through, and it already has a
precedent for environment-driven feature gating: the committee cron
sequence is gated by `COMMITTEE_SCHEDULES_ENABLED` plus per-kind cron env
vars ([architecture.md
§9.4](../architecture.md#94-data-model--session-lifecycle)). The frontend
would read flag state from the API (a field on an existing response, or a
small dedicated endpoint) rather than maintaining its own flag source, to
avoid a second source of truth. Workers reading flags would need the same
API-mediated (or DB-row-mediated) source rather than their own env-var copy,
to avoid a lane running stale flag state after a flip. None of this is
built; §6 flags the storage/source-of-truth question as explicitly open.

### 4.5 Deprecation policy

No deprecation policy exists today because nothing has ever needed to
outlive a replacement — every environment redeploys everything at once. Once
components decouple, an old endpoint/field shape needs to stay live for
**at least as long as the slowest consumer can realistically still be
running it** — for the frontend that means "at least until a browser tab
open at deploy time would have naturally reloaded," for a worker lane that
means "until every worker container has been redeployed," and for the DB
that means the expand/contract window (§4.1). Communicating a deprecation
today has no established channel — no changelog, no deprecation-header
convention in the API responses. The concrete window length and the
communication mechanism are both left open (§6).

## 5. Prior art

These are established, real patterns from the wider industry — named here
so any of them can be adopted (or explicitly rejected) rather than
reinvented ad hoc:

- **Expand/contract (parallel change) migrations** — the standard technique
  for schema changes in systems with rolling/independent deploys (used
  widely, documented by Martin Fowler and in the Google SRE / DDIA
  literature). Maps directly onto `backend/migrations/`: split every
  breaking schema change into an additive expand migration, a
  dual-read/dual-write transition, and a separate destructive contract
  migration only after all consumers (API + all three worker lanes +
  producer) are confirmed off the old shape.
- **N-1/N+1 compatibility windows** — the rule (common in Kubernetes,
  Kafka, and most rolling-deploy systems) that any two adjacent versions of
  a component must interoperate, so a rolling deploy never has a moment
  where old and new can't talk. Applies directly to API↔frontend (a cached
  browser tab is "N-1" against a freshly-deployed API) and to
  workers↔schema (a worker container mid-rollout is "N-1" against a
  just-applied migration).
- **Semantic versioning for internal service boundaries** — versioning the
  *contract*, not just the code, so a breaking change is a deliberate major
  bump rather than an accidental one. This repo already has the seam for
  it: `contract/` is explicitly designed as "the eventual split point,"
  described in [architecture.md
  §3](../architecture.md#3-repository-layout-split-ready) as "bumping the
  contract is the explicit, reviewable coupling point" once frontend and
  backend become separate repos. Formalizing that as an actual version
  number (rather than just a shared-file copy checked for drift) is the
  natural next step once components deploy independently.
- **Feature toggles (Martin Fowler's taxonomy)** — release toggles (hide
  incomplete work), ops toggles (kill switches), and permission toggles are
  the relevant categories here; the existing
  `COMMITTEE_SCHEDULES_ENABLED`-style env gate is closest to an ops toggle.
  A cross-component feature (schema + API + frontend all need to agree it's
  "on") is a **release toggle** in Fowler's terms, and those are explicitly
  meant to be short-lived and removed once the feature is fully rolled out
  — relevant to §4.5's deprecation discipline too, since a flag that never
  gets removed is its own form of permanent tech debt.
- **Capability negotiation / feature detection** — the general pattern (used
  by browsers detecting API support, by HTTP content negotiation, by
  protocol version handshakes) of asking "can you do X" rather than
  asserting "you must be version Y." Directly informs §4.2: the API
  checking for a column/table's existence (or a value in it) rather than
  trusting its own build's expected migration count.
- **Blue-green and canary deploys** — running two versions of a component
  side-by-side (blue-green: instant cutover between two full environments;
  canary: a small percentage of traffic on the new version first) to
  validate a new release under real conditions before it's the only thing
  serving traffic. This is the deploy-mechanics counterpart to N-1/N+1
  compatibility (previous bullet) — it's *why* two adjacent versions need to
  interoperate at all. Most directly applicable to the **API tier** droplet
  once it's more than one instance; less obviously applicable to the
  **data tier** (a Postgres HA cluster's failover is not the same problem as
  blue-green app deploys) or to the buildless **frontend** (a CDN swap is
  closer to blue-green than canary, since there's no meaningful
  "percentage of traffic" concept for static files).

## 6. Open questions

This section is deliberately unresolved — the point of a first draft.

- **Deprecation window length.** How long does an old endpoint shape,
  field, or DB column stay live after its replacement ships? A fixed
  duration (e.g. two release cycles), or tied to an observable signal (e.g.
  "until traffic against the old shape drops to zero")?
- **Do workers talk to the DB directly, or only through the API?** Today
  the queue-consuming lanes hit Postgres directly with a restricted role;
  the analytics-producer talks only to the API over HTTP. Should the
  direct-DB lanes move toward the producer's model (API-mediated, gaining
  capability negotiation for free) or is direct DB access with a
  capability-aware worker (checking schema shape itself) an acceptable
  permanent split?
- **Feature-flag storage and source of truth.** A DB table read by the API
  (and exposed to the frontend/workers via API-mediated reads), a
  dedicated env-var convention like `COMMITTEE_SCHEDULES_ENABLED`, or a
  third-party flag service? No decision has been made and none is implied
  by anything in this doc.
- **Does the committee/dashboard SPA get its own deploy path?** Right now
  it's version-locked to the API via `STATIC_DIR` co-serving. Splitting it
  onto its own CDN target (like marketing already is) is what would make
  §3(d)'s "independent frontend cadence" real rather than theoretical — is
  that worth doing, and on what timeline?
- **Where does the actual deploy pipeline live?** `docs/runbooks/deployment.md`
  describes an intended GitOps CI pipeline that isn't built yet. Should
  this doc's release-cadence assumptions wait for that pipeline to exist,
  or should the pipeline be designed to satisfy this doc's constraints
  (independent per-component triggers, environment promotion) from the
  start?
- **API version-prefix threshold.** What actually counts as a "breaking
  enough" change to warrant a new `/api/v2/` prefix versus just an additive
  field? No threshold is proposed here.
