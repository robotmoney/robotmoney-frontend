# Release cycle & topology compatibility

> **Status: draft, second pass.** Still a proposal, not a ratified spec —
> there is no accepted decision in [decisions.md](../decisions.md) behind it
> yet. Since the first draft, however, the topology (§3) and the rollout
> mechanics (§6) have been **decided in discussion**: those two sections
> describe a chosen direction with rejected alternatives recorded, not an
> open survey. The "Open questions" section at the end remains the live
> agenda for everything else.

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

That is the topology as D13 defines it today. §3 below records the
production topology now chosen in discussion, which amends parts of D13's
detail.

## 3. Proposed production topology

This section records the topology **decided in discussion** — the direction
is chosen; the remaining choices inside it are minor and listed in §8. Three
tiers, same as D13's frame, with two significant changes: both frontends
move to Cloudflare's edge, and the compute tier becomes a single-node
Kubernetes (k3s) cluster instead of docker-compose.

### 3.1 Static tier — Cloudflare edge, for both frontends

Marketing **and** the committee/dashboard SPA are buildless static trees
(D2), and both get served from **Cloudflare's edge network**. Whether that
is Cloudflare Pages or R2 behind the CDN is a minor open question (§8) —
either way the properties that matter are the same:

- **The SPA gets its own independent release path.** This breaks the
  `STATIC_DIR` version-lock described in §2(b)/§4(d): the SPA is no longer
  co-served by the API process, so pushing frontend assets no longer means
  deploying the API, and vice versa. (This resolves the first draft's open
  question of whether the SPA gets its own deploy path — yes.)
- **`/api/*` is a proxied path on the same hostname.** Cloudflare routes
  `/api/*` on the SPA's hostname through to the origin (the compute tier,
  §3.2), so the SPA stays same-origin with the API — no CORS surface, no
  preflight, no second hostname for the frontend to configure.
- **Edge-cached-SPA-vs-API skew becomes an everyday scenario.** Once the
  SPA is cached at the edge on its own cadence, a cached SPA calling a
  newer or older API is no longer a theoretical browser-tab corner case
  (§4d) — it is the normal state between any two deploys. That upgrades
  §5.3's additive-only API contract discipline from aspirational to
  **mandatory**.
- **This amends D13.**
  [decisions.md D13](../decisions.md#d13--vendor-split-tiered-topology-cloudflare-dnsobservability--do-computestorage-surfaces-on-subdomains)
  specifies marketing served from **DO Spaces CDN** and confines Cloudflare
  to DNS + observability; this design moves static serving (both surfaces)
  and `/api/*` path-proxying to Cloudflare. **decisions.md needs a new
  entry recording this amendment** — this doc flags it but deliberately
  does not write it.

### 3.2 Compute tier — k3s on a single DO droplet

The production runtime for the API and workers is **k3s** — the certified
single-binary Kubernetes distribution (~512 MB overhead, SQLite datastore
instead of etcd) — on **one DigitalOcean droplet**, replacing
docker-compose as the production runtime. The rationale is that the release
goals this doc defines — independent per-component cadence (§4), N-1
compatibility windows (§7), zero-downtime deploys, and migration/code
decoupling (§5.1) — effectively require an orchestrator, and k3s delivers
one at single-droplet cost.

- **Five independent Deployments**: `api`, `worker-committee`,
  `worker-analytics`, `worker-research`, and `analytics-producer`. Five
  images, five independent rollout cadences — the per-component release
  independence §4 calls "low today" becomes the deployment unit structure
  itself.
- **Zero-downtime API deploys on a single node.** The `api` Deployment uses
  rolling updates with `maxSurge: 1, maxUnavailable: 0` and readiness
  probes: the new replica must pass readiness before the old one is
  terminated, so there is never a moment with zero ready API pods —
  something docker-compose cannot express.
- **Migrations move out of API boot into a pre-deploy Kubernetes Job.**
  Today `migrate()` runs on every API boot (§2a); with more than one
  replica rolling, that races, and it couples schema deploys to code
  deploys. Instead, a migration Job runs and **completes before** the API
  rollout proceeds (gating mechanics in §6). This is the mechanical
  enforcement of the expand/contract pattern (§5.1): schema ships first,
  additively; code follows. In-cluster/production, migrate-on-boot is
  disabled.
- **Ingress via `cloudflared` in-cluster.** A `cloudflared` Deployment
  points at the API Service — matching the team's existing stage-tunnel
  practice — so there is no DO Load Balancer and no directly-exposed
  origin. (D13 called a Tunnel "optional hardening"; here it is the
  ingress.)
- **Honest costs.** The team maintains the manifests (plain Kubernetes
  YAML, §6) and owns k3s
  version upgrades. And a single-node cluster gives zero-downtime
  *deploys*, not high availability — the droplet is still a SPOF for
  compute.
- **Growth path: DOKS.** The manifests are plain Kubernetes — if the
  droplet is outgrown, the same YAML moves to DOKS (managed control plane)
  unchanged. DOKS is the explicit growth path, not a rewrite.
- **Rejected alternative: docker-compose plus a deploy-runner script.**
  Rejected because compose has no rolling updates — every API deploy is a
  stop/start, i.e. per-deploy downtime — and its migration gating is
  whatever a shell script remembers to do, with none of the
  Job/readiness-probe machinery above.

### 3.3 Data tier — DO Managed Postgres

Unchanged in kind from D13, sharpened in detail:

- **DO Managed Postgres** in the **same VPC** as the droplet, reachable
  over **private networking only** — no public DB endpoint.
- **PgBouncer** (built into DO Managed Postgres) fronts connections —
  connection count multiplies across five Deployments, so pooling stops
  being optional.
- **One credential per Deployment**, continuing the per-component
  least-privilege role pattern that `rm_worker` (migration
  `0016_worker_role.sql`, §2c) started.
- **The cluster holds no state.** Postgres is the only stateful thing in
  the topology, and it is managed — the droplet and everything on it is
  disposable/rebuildable from git (§6).

## 4. Per-component release cadence

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

## 5. Compatibility strategy

### 5.1 Expand/contract for DB migrations

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
today they usually do (§4), and that's the main thing this pattern would
change in practice — §3.2's pre-deploy migration Job is the mechanism that
makes the split real, and §6 the rollout gate that enforces the ordering.

### 5.2 API/DB version skew tolerance

The API should not assume the schema is at exactly the migration count its
own build was compiled against — `migrate()` running as a precondition of
boot masks this today (a single API instance always sees a fully-migrated
DB at the moment it starts), but it stops being true the moment there is
more than one API instance, or migrations and API deploys are decoupled
(§5.1) — both of which §3.2 now makes the production baseline (rolling
replicas, migrate-on-boot disabled). The right posture is **capability negotiation / feature detection**
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

### 5.3 API versioning for the frontend and workers as consumers

There is no versioning scheme in the API today — routes are flat paths in
`contract/src/routes.js`, shared as literal source between frontend and
backend, not as a semver'd artifact. That's fine as long as frontend and API
are deployed together (today's reality per §2), but §3.1 commits the SPA to
an independent edge deploy path — so an edge-cached SPA (or a stale browser
tab) calling an API that has moved on is the normal state between deploys,
not a corner case. The lightest-weight approach consistent with this
project's minimalism: keep endpoint **shapes** additive-only (new optional
fields, never repurposing or removing a field in place — the same discipline
the goldens-drift gate already enforces for the preview mock layer,
[decisions.md D14](../decisions.md#d14--preview-mode-goldens-backed-over-the-baked-frozen-single-file)),
and reserve an actual path-prefix version (`/api/v2/...`) for the rare
breaking change, with the old prefix kept alive for a declared deprecation
window (§5.5) rather than deleted the day the new one ships. Workers/producer
should follow the same additive-fields discipline since the producer is
already an API consumer over authenticated HTTP (§2c).

### 5.4 Feature flags

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
built; §8 flags the storage/source-of-truth question as explicitly open.

### 5.5 Deprecation policy

No deprecation policy exists today because nothing has ever needed to
outlive a replacement — every environment redeploys everything at once. Once
components decouple, an old endpoint/field shape needs to stay live for
**at least as long as the slowest consumer can realistically still be
running it** — for the frontend that means "at least until a browser tab
open at deploy time would have naturally reloaded," for a worker lane that
means "until every worker container has been redeployed," and for the DB
that means the expand/contract window (§5.1). Communicating a deprecation
today has no established channel — no changelog, no deprecation-header
convention in the API responses. The concrete window length and the
communication mechanism are both left open (§8).

## 6. Rollout mechanics (GitOps)

Decided in discussion alongside §3: the rollout loop is **GitOps,
deliberately minimal**. **Flux and Argo CD were considered and rejected**
for now — their headline features (continuous drift correction, image
automation, dashboards, multi-cluster sync) don't pay for themselves with
one node, five Deployments, and one operator. The chosen loop keeps the
GitOps *principle* from
[`docs/runbooks/deployment.md`](../runbooks/deployment.md) — deploy state
is declarative, in git, and reviewable — while the machinery is a script:

- **Manifests in git.** Plain Kubernetes YAML files in a `deploy/`
  directory — roughly ten small files covering the five Deployments
  (§3.2), the migration Job, Services, and `cloudflared`. No templating,
  no base/overlay structure: **Kustomize was considered and deferred** by
  the same minimalism logic that deferred Flux — with exactly one
  environment there is nothing to overlay, so a layering tool only adds
  indirection. The upgrade trigger, recorded now exactly as for Flux:
  adopt Kustomize the day a second environment (staging, §8) would
  otherwise mean duplicating the YAML files; until then, one environment =
  plain files. Whether the files live in this repo or a separate deploy
  repo is open (§8).
- **CI builds and bumps.** On merge, CI builds the component's image,
  pushes it to a registry tagged with the **immutable git SHA** (registry
  choice — GHCR vs DO Container Registry — is a minor open question, §8),
  and commits a one-line edit of the `image:` field in the plain YAML
  (`yq`/`sed`-level tooling, nothing manifest-aware). CI's write access
  ends at git; it never touches the cluster.
- **A pull-based reconciler on the droplet.** A systemd timer (~every
  minute) runs a ~20-line script: `git fetch` with a **read-only deploy
  key**; if the manifest ref moved, `kubectl apply -f deploy/`, then
  `kubectl rollout status`, and log the result. Pull-based means: no
  inbound access to the droplet, no cluster credentials in GitHub, and no
  in-cluster controllers to run or upgrade.
- **Migration gating lives in the reconciler.** It applies the migration
  Job first, `kubectl wait --for=condition=complete`, and only then
  applies the rest. A failed migration **halts the rollout with the old
  code still serving** — the mechanical guarantee behind §5.1's
  schema-first ordering.
- **Rollback is `git revert`** of the tag-bump commit. The reconciler
  converges to whatever the repo says; because images are SHA-tagged and
  immutable, reverting the manifest reverts the running code exactly.
  (Schema rollback remains forward-fix only, per §4a — this loop doesn't
  change that.)
- **Upgrade trigger, recorded now.** The day the reconciler script needs
  real features — multi-env promotion, health-gated progressive delivery,
  deploy notifications — is the signal to adopt **Flux**. The manifests
  carry over unchanged; only the ~20-line script is discarded.
- **Rejected extra-minimal variant:** k3s's
  `/var/lib/rancher/k3s/server/manifests/` auto-apply directory. Rejected
  because it is k3s-specific (doesn't port to DOKS, breaking §3.2's growth
  path) and handles deletions poorly.

This also resolves the first draft's "where does the actual deploy pipeline
live?" question: the pipeline is designed to satisfy this doc's constraints
(independent per-component triggers, migration-first ordering, reviewable
deploy state) rather than the doc waiting on a pipeline to exist.

## 7. Prior art

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
  — relevant to §5.5's deprecation discipline too, since a flag that never
  gets removed is its own form of permanent tech debt.
- **Capability negotiation / feature detection** — the general pattern (used
  by browsers detecting API support, by HTTP content negotiation, by
  protocol version handshakes) of asking "can you do X" rather than
  asserting "you must be version Y." Directly informs §5.2: the API
  checking for a column/table's existence (or a value in it) rather than
  trusting its own build's expected migration count.
- **Blue-green and canary deploys** — running two versions of a component
  side-by-side (blue-green: instant cutover between two full environments;
  canary: a small percentage of traffic on the new version first) to
  validate a new release under real conditions before it's the only thing
  serving traffic. This is the deploy-mechanics counterpart to N-1/N+1
  compatibility (previous bullet) — it's *why* two adjacent versions need to
  interoperate at all. Most directly applicable to the **API tier** droplet
  once it's more than one instance — §3.2's rolling update
  (`maxSurge: 1, maxUnavailable: 0`) is the small-scale member of this
  family; less obviously applicable to the
  **data tier** (a Postgres HA cluster's failover is not the same problem as
  blue-green app deploys) or to the buildless **frontend** (a CDN swap is
  closer to blue-green than canary, since there's no meaningful
  "percentage of traffic" concept for static files).

## 8. Open questions

Two of the first draft's questions are now **answered** and have moved into
the body as decided positions: *does the committee/dashboard SPA get its own
deploy path?* — yes, Cloudflare edge (§3.1); and *where does the actual
deploy pipeline live?* — the minimal GitOps loop of §6, designed to satisfy
this doc's constraints rather than waiting for one to exist. What follows is
still genuinely open.

Carried over from the first draft:

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
  permanent split? (§3.3's one-credential-per-Deployment pattern works
  either way, so the topology doesn't force this.)
- **Feature-flag storage and source of truth.** A DB table read by the API
  (and exposed to the frontend/workers via API-mediated reads), a
  dedicated env-var convention like `COMMITTEE_SCHEDULES_ENABLED`, or a
  third-party flag service? No decision has been made and none is implied
  by anything in this doc.
- **API version-prefix threshold.** What actually counts as a "breaking
  enough" change to warrant a new `/api/v2/` prefix versus just an additive
  field? No threshold is proposed here — and §3.1 makes the question more
  pressing, since edge-cached SPA skew is now the everyday case.

New questions raised by the §3/§6 design:

- **Cloudflare Pages vs R2 + CDN for the static tier.** Both serve a
  buildless tree from the edge; Pages brings per-branch previews and
  atomic deploys (and is already used for preview mode, D19/D20), R2+CDN
  is a plainer bucket. Minor, but it decides the static deploy tooling.
- **GHCR vs DO Container Registry.** GHCR keeps images next to CI with no
  extra credentials in GitHub; DOCR keeps pulls inside DO's network next
  to the droplet. Either works with §6's SHA-tagged immutable images.
- **Manifests in this repo vs a separate deploy repo.** In-repo keeps code
  and deploy state reviewable together but means CI's tag-bump commits land
  in the main history; a deploy repo isolates that churn at the cost of a
  second repo to keep in sync.
- **Staging environment shape under k3s.** A second namespace on the same
  node (cheap, shares the SPOF and the k3s version) or a second droplet
  (isolated, doubles the cost)? Either way, committing to a second
  environment is also §6's recorded Kustomize trigger — the point where
  plain YAML files would start duplicating. Note the existing stage tunnel
  pins its origin to `localhost:48787` today — whatever shape staging
  takes has to either preserve or deliberately replace that arrangement.
