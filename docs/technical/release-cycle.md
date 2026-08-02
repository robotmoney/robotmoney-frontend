# Release cycle & topology compatibility

> **Status: draft, second pass.** Still a proposal, not a ratified spec —
> there is no accepted decision in [decisions.md](../decisions.md) behind it
> yet. Since the first draft, however, the topology (§3), the four ordering
> rules (§5.1), and the rollout mechanics (§6) have been **decided in
> discussion**: those sections describe a chosen direction with rejected
> alternatives recorded, not an open survey. The mechanics have since been
> hardened against an adversarial review (per-SHA migration Jobs, the
> reconciler owning the static publish, the drift-check dead-man's switch),
> and the small code changes the design requires are collected in §6.1.
> The "Open questions" section at the end remains the live agenda for
> everything else.

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
  `swarm.` droplet (see below).
- **(c) Workers (research pipelines)** — a Postgres-backed task queue
  (`jobs`/`job_schedules`/`job_runs`, [decisions.md
  D9](../decisions.md#d9--custom-postgres-backed-task-queue-not-github-actions-cron--pg_cron)),
  consumed by three separately-deployed containers pinned to lanes via
  `WORKER_LANE` (`worker-swarm`, `worker-analytics`, `worker-research` —
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
Spaces CDN, decoupled from the API entirely). The swarm/dashboard SPA,
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

### 3.1 Static tier — Cloudflare edge, for both frontends; API on its own subdomain

Marketing **and** the swarm/dashboard SPA are buildless static trees
(D2), and both get served from **Cloudflare Pages**. The API is **not** on
those hostnames: it lives on its **own subdomain** (`api.`), reached
directly, exactly the way D13 already routes each surface to its own host.
There is no `/api/*` path on the static hostnames.

- **The SPA gets its own release path.** This breaks the `STATIC_DIR`
  version-lock described in §2(b)/§4(d): the SPA is no longer co-served by
  the API process, so a frontend change no longer means deploying the API,
  and vice versa. (This resolves the first draft's open question of
  whether the SPA gets its own deploy path — yes.) One deliberate caveat:
  the SPA's *publish* is executed by §6's reconciler as the final step of
  the deploy sequence, after the backend has converged — independence from
  the API process, not from the deploy ordering R4 requires.
- **Chosen: Cloudflare Pages. Rejected: R2 behind the CDN.** This started
  as a minor open question; it isn't one, because the frontend is
  buildless: with no bundler there are no content-hashed asset filenames —
  `assets/js/...` paths are **stable URLs** whose contents change across
  deploys. A mutable R2 bucket therefore has no atomic-deploy story and no
  invalidation story: mid-deploy readers can get a mixed tree, and a
  cached stale asset has no fingerprint to age it out. Pages gives atomic
  versioned deployments (a deploy is a new immutable version, switched
  whole) and a conservative default cache posture that fits unfingerprinted
  files: HTML effectively uncached, assets revalidated by ETag. Pages is
  also already in use here — preview mode deploys on it (D19/D20).
- **The SPA is cross-origin to the API, so the API grows a CORS surface.**
  The Bun API needs an **origin allowlist**, a real `OPTIONS` preflight
  handler, and `Access-Control-Allow-Credentials` if/when auth requires it
  — roughly 20–30 lines. (Today `backend/src/api/index.ts` answers every
  `OPTIONS` with a bare `204` and emits no `Access-Control-*` headers at
  all, because same-origin has always been assumed.) The honest trade:
  that code lives **in the repo**, is testable in CI, and is portable to
  any host, whereas an edge path-routing rule lives in vendor dashboard
  configuration outside git and is Cloudflare-specific. Twenty lines of
  reviewable, tested code is preferred over untracked vendor config.
- **Cookies still work — this is cross-origin but same-site.** The SPA
  hostname and `api.` share a registrable domain, so `SameSite=Lax`
  cookies flow between them unchanged: CORS response headers are required,
  `SameSite=None` is **not**. That only changes if the API ever moves to a
  different registrable domain.
- **Cache posture, stated honestly.** Splitting hostnames means `api.` is
  simply never cached — a property of the hostname rather than a
  path-exclusion rule someone can misconfigure. But the static side cannot
  be "cached aggressively": long-TTL asset caching requires fingerprinted
  filenames, and buildless (D2) means there are none. Pages' default
  posture — uncached HTML, ETag-revalidated assets — is the **ceiling**,
  and it is accepted as such. (A stale-while-revalidate window on assets is
  the most that could be layered on later.)
- **`api.` is a DNS-level lever.** It can be repointed at staging, or later
  at DOKS (§3.2), with a single DNS change that the static tier never
  notices.
- **Edge-cached-SPA-vs-API skew becomes an everyday scenario.** Once the
  SPA is cached at the edge on its own cadence, a cached SPA calling a
  newer or older API is no longer a theoretical browser-tab corner case
  (§4d) — it is the normal state between any two deploys. That upgrades
  §5.5's additive-only API contract discipline from aspirational to
  **mandatory**.
- **Rejected alternative: same-hostname `/api/*` path-prefix proxying.**
  Serving the API as a proxied path on the SPA's own hostname would keep
  everything same-origin and avoid CORS entirely — that is the *only*
  thing it buys. It was rejected because it requires edge routing software
  (a Cloudflare Worker, a Pages Function, or a routing rule), which D13
  explicitly rejected, and because it moves deploy-relevant configuration
  into a vendor dashboard instead of git.
- **This amends D13, narrowly.**
  [decisions.md D13](../decisions.md#d13--vendor-split-tiered-topology-cloudflare-dnsobservability--do-computestorage-surfaces-on-subdomains)
  specifies marketing served from a **DO Spaces CDN** on the apex/`www`,
  with Cloudflare confined to DNS + observability. The amendment is just
  that: **static hosting for both frontends moves from DO Spaces CDN to
  Cloudflare's edge.** D13 separately rejected "Cloudflare caching
  marketing" — but on the stated grounds that it would double-CDN *in
  front of* the DO Spaces CDN, and with Spaces gone there is no second CDN
  to stack, so that rejection's rationale no longer applies; the vendor
  choice for static delivery still changes and should be recorded. Nothing
  else in D13 is disturbed: putting the API on `api.` is D13's own
  subdomain-per-surface framing, and with the path proxy rejected there is
  still **no routing software anywhere**. **decisions.md needs a new entry
  recording this amendment** — this doc flags it but deliberately does not
  write it.

### 3.2 Compute tier — k3s on a single DO droplet

The production runtime for the API and workers is **k3s** — the certified
single-binary Kubernetes distribution (~512 MB overhead, SQLite datastore
instead of etcd) — on **one DigitalOcean droplet**, replacing
docker-compose as the production runtime. The rationale is that the release
goals this doc defines — independent per-component cadence (§4), N-1
compatibility windows (§7), zero-downtime deploys, and migration/code
decoupling (§5.2) — effectively require an orchestrator, and k3s delivers
one at single-droplet cost.

- **One image, five Deployments**: `api`, `worker-swarm`,
  `worker-analytics`, `worker-research`, and `analytics-producer`. All five
  are built from the single `backend/Dockerfile` today and differ only by
  `command:` (`src/api/index.ts`, `src/worker/index.ts`,
  `src/producer/index.ts`) and, for the lanes, `WORKER_LANE` — see
  `docker-compose.yml`. That carries straight over to Kubernetes: five
  Deployments, five independent *rollout* cadences, one image repository.
  **The consequence is worth stating plainly**: a backend commit produces
  **one** image SHA, so all five Deployments move together by default —
  and §6 decides that deliberately (CI bumps all five to the same SHA;
  per-Deployment pinning is reserved for exceptional cases like a staged
  worker rollout or a single-lane rollback). Independence is preserved as
  a *capability* of the manifests, not everyday practice.
  The flip side is a genuine upside: the migration Job runs
  `src/db/migrate.ts` from that **same** image, so pinning the Job to a
  newer tag than the `api` Deployment *is* the expand/contract posture
  (schema at N+1, code at N) at no extra build cost.
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
  enforcement of the expand/contract pattern (§5.2): schema ships first,
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
  being optional. Decided: **transaction-mode pooling**, which has a real
  client-side consequence: `postgres.js` uses named prepared statements by
  default, and those break when consecutive statements land on different
  server connections. `backend/src/db/client.ts` sets no `prepare` option
  today, so the client must pass `prepare: false` when running behind the
  pooler (env-gated, e.g. `PGBOUNCER=true`) — a required code change
  (§6.1).
- **One credential per Deployment**, continuing the per-component
  least-privilege role pattern that `rm_worker` (migration
  `0016_worker_role.sql`, §2c) started.
- **The cluster holds no state.** Postgres is the only stateful thing in
  the topology, and it is managed — the droplet and everything on it is
  disposable/rebuildable from git, made concrete by the idempotent
  `deploy/bootstrap.sh` this design requires (§6.1). The data itself rests
  on Managed PG backups/PITR — and because migrations are forward-fix only
  (§4a), restore is the genuine last resort, which is why §8 asks for a
  periodic restore drill rather than assuming backups work.

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
  guard against this, and §5.1's answer is to make it unreachable by
  ordering (R4) rather than to add one. If the DB is *ahead* (migration applied, but the API
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
  **queue-consuming lanes** (`swarm`/`analytics`/`research`) read/write
  Postgres directly with a restricted role, so they are coupled to schema
  shape exactly like the API is, but *without* the API's ability to gate
  behavior behind a runtime check — a worker's compatibility posture is
  whatever its handler code hard-codes. The **analytics-producer** talks to
  the API only over authenticated HTTP through typed routes, so it inherits
  the API's compatibility surface rather than the DB's directly — it is,
  today, the one component already isolated from raw schema drift.
  Realistic independence: workers can deploy independently of the API code
  path (separate containers, separate `command:` entrypoints — though, per
  §3.2, the *same image*) but not of the DB schema their handlers assume.
- **(d) Frontend.** Triggered by `frontend/public/**` changes. Marketing
  (DO Spaces CDN) is fully decoupled and can ship any time. The
  swarm/dashboard SPA is currently bundled into the API's deploy via
  `STATIC_DIR`, so it has no independent release path today even though
  nothing in its design requires that — it's a buildless static tree that
  could be pushed to its own CDN/bucket target the same way marketing is.
  Compatibility risk: an old cached SPA in a user's browser calling a
  newer/older API than the one it shipped against — a real scenario the
  moment the SPA gets its own CDN and stops being version-locked to the API
  process serving it.

## 5. Compatibility strategy

### 5.1 The four rules

The minimal approach, chosen in discussion. The governing insight is that
**ordering discipline makes runtime detection unnecessary — you don't need
to detect a mismatch you have made impossible.** These four rules are *the*
operational contract; everything else in §5 is either the pattern that
implements them (§5.2) or an option deliberately deferred because they hold
(§5.4).

- **R1 — Every migration is additive.** New tables, columns, and indexes
  only. Nullable or defaulted, never `NOT NULL` without a default. No
  renames, no drops, no type narrowing. *Consequence: the DB can always be
  safely ahead of the code.* Schema-additive is not automatically
  *semantics*-safe, though: until every **writer** has rolled, rows keep
  arriving with the new column NULL/absent — so readers must treat
  NULL/missing as the legacy state for the whole transition. That is not
  an extra rule; it is the dual-read phase of expand/contract (§5.2),
  stated explicitly.
- **R2 — Destructive changes wait until provably safe.** A drop or rename
  ships in a **later PR** than the code that stopped using the old shape,
  never the same one. "Later" is defined operationally, not by calendar
  feel — a destructive migration may merge only when **both** hold:
  1. the drift check (§6) confirms all five Deployments **and** the Pages
     deploy are on SHAs at or past the commit that removed the last use of
     the old shape;
  2. a browser-tab grace window has elapsed since that deploy — proposed
     default **7 days**; the exact number is the one parameter left open
     (§8).
- **R3 — API responses only gain fields, and consumers don't lead with
  requests.** Never remove, rename, or change the type or meaning of a
  response field: JSON clients ignore unknown fields natively, so an old
  SPA calling a new API just works. The corollary in the request
  direction: a consumer (SPA, producer, worker) must not **send** a new
  request field until the API that accepts it is deployed — R3 makes old
  clients safe against new servers, and this corollary keeps new clients
  from outrunning old servers.
- **R4 — Deploy provider before consumer.** The DB deploys before its
  readers (API, worker lanes); the API deploys before its callers (SPA,
  analytics-producer). "DB → backend → frontend" is the common case, but
  the rule is the dependency direction, not the list. Combined with R1 and
  R3, the only skew that can arise is "the provider is ahead," which is
  safe by construction.

**What this covers**, without a line of detection code: rolling API
replicas (both versions work against an additive DB — R1); a worker
mid-rollout (same reason); a lagging writer against a new reader (R1's
dual-read clause); an edge-cached SPA against a newer API (R3); a
rolled-ahead producer (R3's request corollary plus R4); and rollback,
since old code still works against a forward DB (R1 again). Within the
backend itself, §6's bump-all-five policy means api/worker/producer skew
exists only inside a single rolling window, not as a persistent state.

**Enforcement**, kept as light as the rules themselves:

- **R1** — a CI grep over changed files under `backend/migrations/` for
  `DROP` / `RENAME` / `ALTER ... TYPE`, failing the PR unless it carries an
  explicit contract-migration label. The same gate flags a bare
  `CREATE INDEX`: on a live database a non-concurrent index build blocks
  writes for its duration while being perfectly "additive," so an index
  migration must use `CREATE INDEX CONCURRENTLY` (with the
  `-- no-transaction` runner support, §5.3) or carry an explicit
  small-table override label. Roughly ten lines either way; not built yet
  (§6.1).
- **R3** — **not enforced today, and the existing gate is narrower than it
  looks.** The goldens-drift gate (D14) is
  `scripts/tests/unit/goldens-drift.test.ts`, and what it actually asserts
  is that the committed `goldens/api-goldens.json` is non-empty, that its
  route set is populated, and that a few key routes have plausible shapes.
  The goldens themselves are *captured* from a running backend by
  `scripts/update-goldens.ts`, so they do track real response shapes — but
  the gate compares goldens to the current code, not a new response shape
  to the **previous** one. It is a freshness check on the preview mock
  layer, not an additive-only check on the API contract. Enforcing R3
  mechanically would mean diffing response shapes across versions; that
  gate does not exist.
- **R4** — enforced by making one sequencer own the whole order. §6's
  reconciler runs migration Job → backend rollout → static publish as one
  sequence on one machine, so "provider before consumer" is the only order
  that can happen. (An earlier draft called this "already free" with the
  SPA on its own CI-triggered deploy — wrong: nothing would have stopped a
  new SPA going live seconds after merge against a backend that converges
  minutes later. The fix is that the reconciler deploys the static tier
  too; see §6.)

**The explicit limit.** All four rules rest on being able to guarantee
deploy order. If you ever need to ship API code *before* its migration, R4
breaks and nothing here protects you — you would need real feature
detection (§5.4). Plainly: don't do that.

### 5.2 Expand/contract for DB migrations

Expand/contract is the pattern R1 and R2 implement; it is spelled out here
because the middle step is the part the rules don't state. Adopt the
standard **expand/contract** (a.k.a. parallel-change) pattern for
every schema change that a running API/worker depends on:

1. **Expand** — add the new column/table/index additively; nothing reads it
   yet, nothing existing breaks.
2. **Migrate readers** — ship API/worker code that can read *both* old and
   new shapes, then code that writes the new shape (backfilling old rows as
   needed). "Both shapes" explicitly includes rows a not-yet-rolled writer
   is still producing with the new column NULL/absent — a reader must
   treat NULL/missing as the legacy state until *every* writer (API and
   all lanes) is confirmed on the new code, not merely until its own
   deploy lands.
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

### 5.3 Migration hygiene gaps against a live database

Every environment we run today migrates a **fresh or short-lived** database
(§1). Three properties of `backend/migrations/` + `backend/src/db/migrate.ts`
are benign under that assumption and stop being benign the moment migrations
are a gated pre-deploy step (§3.2) against a live Managed Postgres with real
data and real concurrent traffic. The first remains an open gap; the second
and third are now **resolved by prescribed runner changes** (collected in
§6.1).

- **Numeric prefixes are not unique, and nothing checks.** Two collisions
  already exist on main: `0014_projects_pipelines.sql` /
  `0014_wallet_balance_samples.sql`, and `0021_chain_indexer_samples.sql` /
  `0021_committee_waitlist.sql` (the historical filename — issue #263 renamed
  the live schema in `0025_swarm_rename.sql`, but migration files themselves
  are an immutable record of what actually ran and are never renamed).
  `migrate.ts` sorts by *filename*, so
  ordering is deterministic (the suffix breaks the tie) — but the prefixes
  are not unique and not truly sequential, and nothing catches a collision
  at merge time. Harmless when a single boot applies everything to a fresh
  DB; a real ordering hazard once expand/contract sequencing has to hold
  across branches that merge concurrently.
- **`migrate()` calls `seed()` — resolved: split them.** The runner ends
  with `await seed()` — inserting `job_schedules` rows and similar
  required state. Left alone, §3.2's pre-deploy migration Job would
  **re-seed production on every deploy**; `seed()` is idempotent, and
  re-seeding a fresh demo DB is exactly what it is for, but a live
  production DB is a different risk posture. Decided: **the production
  migration Job runs schema-only** — seeding is split out of `migrate()`
  behind a flag or separate entrypoint, demo/CI keep today's combined
  behavior, and production seeds deliberately (at bootstrap, or on
  explicit operator action), never implicitly per deploy (§6.1).
- **No lock or timeout discipline — resolved: runner defaults plus a
  transaction carve-out.** There is no `lock_timeout`, no
  `statement_timeout`, and no `CREATE INDEX CONCURRENTLY` anywhere in
  `backend/migrations/`. Against a live database, an `ALTER TABLE` that
  takes an ACCESS EXCLUSIVE lock behind a long-running query queues — and
  everything behind *it* queues too, stalling traffic on a table that was
  never being altered. That risk simply does not exist against the fresh
  DBs every current environment uses. And there is a structural conflict:
  `CONCURRENTLY` cannot run inside a transaction, while `migrate.ts` wraps
  each file in `sql.begin(...)`. Prescribed (§6.1): the runner sets
  `lock_timeout` and `statement_timeout` defaults for every migration, and
  honors a `-- no-transaction` header comment that runs that file outside
  `sql.begin`, making `CREATE INDEX CONCURRENTLY` expressible; §5.1's R1
  gate then rejects bare `CREATE INDEX` so the safe form is the default
  form.

### 5.4 API/DB version skew: why runtime detection is deferred

R1–R4 (§5.1) make runtime version detection unnecessary: if the DB is only
ever additive and only ever ahead, there is no mismatch left to detect. So
the API does **not** need to negotiate capabilities today, and this doc does
not propose that it should.

Worth recording precisely because it constrains any future attempt: there is
no schema version to pin to. `schema_migrations` (see
`backend/src/db/migrate.ts`) is `name text PRIMARY KEY` — a **set of applied
migration filenames**, not an ordered version counter. "The DB is at version
N" is not a value anything can read; hard version pinning isn't merely
undesirable here, it isn't implementable without inventing a new version
concept.

**Considered and deferred: a published schema-version / capability
descriptor** — recorded the same way as Flux (§6) and Kustomize (§6):

- A version **integer** was rejected outright. The filename set is strictly
  richer information, and collapsing it to an ordinal is lossy — especially
  given that the prefixes are not linearly ordered (§5.3).
- If adopted, the shape would be **two layers**: fine-grained *schema*
  capabilities internal to the API and workers (probed with `to_regclass` /
  `information_schema` and cached at boot), and coarse *feature*
  capabilities published to clients (the AND of schema-supports-it,
  flag-is-on, config-present). The split matters: DB shape never leaks into
  the client contract.
- **Adoption trigger**: when deploy ordering can no longer be guaranteed —
  multiple independent operators, or customer-managed deployments. One
  operator and one cluster (§3.2) is not that.

The degraded-state instinct this repo already has stays relevant regardless:
the regime DTO's explicit staleness block
(`{ asof, serverDate, ageDays, stale, thresholdDays }`,
[architecture.md §7.1](../architecture.md#71-analytics-suite-six-stage-pipeline))
declares a degraded state in the payload instead of failing opaquely — the
right shape for any mismatch that does reach a client.

### 5.5 API versioning for the frontend and workers as consumers

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
window (§5.7) rather than deleted the day the new one ships. Workers/producer
should follow the same additive-fields discipline since the producer is
already an API consumer over authenticated HTTP (§2c).

### 5.6 Feature flags

No feature-flag infrastructure exists in this codebase today (confirmed —
no `FEATURE_*` env convention, no flag service, no flag table). For a
feature that spans schema + API + frontend + workers, a flag needs to be
readable by whichever of those components guards the user-visible or
data-mutating behavior — realistically that's **the API**, since it's the
one component every write and read passes through, and it already has a
precedent for environment-driven feature gating: the swarm cron
sequence is gated by `SWARM_SCHEDULES_ENABLED` plus per-kind cron env
vars ([architecture.md
§9.4](../architecture.md#94-data-model--session-lifecycle)). The frontend
would read flag state from the API (a field on an existing response, or a
small dedicated endpoint) rather than maintaining its own flag source, to
avoid a second source of truth. Workers reading flags would need the same
API-mediated (or DB-row-mediated) source rather than their own env-var copy,
to avoid a lane running stale flag state after a flip. None of this is
built; §8 flags the storage/source-of-truth question as explicitly open.
If the two-layer capability descriptor of §5.4 is ever adopted, its coarse
*feature* layer — the AND of schema-supports-it, flag-is-on,
config-present — is the natural home for exactly this: one published
answer to "is X available," with the flag as one input. Noted as a
connection, not a commitment; both remain deferred.

### 5.7 Deprecation policy

No deprecation policy exists today because nothing has ever needed to
outlive a replacement — every environment redeploys everything at once. Once
components decouple, an old endpoint/field shape needs to stay live for
**at least as long as the slowest consumer can realistically still be
running it** — for the frontend that means "at least until a browser tab
open at deploy time would have naturally reloaded," for a worker lane that
means "until every worker container has been redeployed," and for the DB
that means the expand/contract window (§5.2). Communicating a deprecation
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
- **CI builds and bumps — all five Deployments, one SHA.** On merge, CI
  builds the image, pushes it to a registry tagged with the **immutable
  git SHA** (registry choice — GHCR vs DO Container Registry — is a minor
  open question, §8), and commits an edit of the `image:` field in the
  plain YAML (`yq`/`sed`-level tooling, nothing manifest-aware). Decided:
  on any `backend/**` or `contract/**` change, the bump moves **all five
  Deployments to the same SHA**. They are one image (§3.2) — the code was
  built and tested together, and R1–R4 make rolling all five safe — so
  lockstep *within the backend* is embraced rather than fought.
  Per-Deployment pinning stays available as an exceptional capability
  (staged rollout of a risky worker change, single-lane rollback), not
  everyday practice. **Rejected: path-filtered bumps** (`src/api/**` →
  `api`, etc.) — the filter map is a hand-maintained dependency graph, and
  the day it misses a shared dependency (`src/db/**`, `contract/**`) a
  Deployment silently keeps running code that no longer matches its
  siblings' assumptions. CI's write access still ends at git; it never
  touches the cluster.
- **A pull-based reconciler on the droplet.** A systemd timer (~every
  minute) runs a small script (`set -euo pipefail` — any failing step
  aborts the run): `git fetch` with a **read-only deploy key**; if the
  manifest ref moved, run the deploy sequence below and log the result.
  Pull-based means: no inbound access to the droplet, no cluster
  credentials in GitHub, and no in-cluster controllers to run or upgrade.
- **Migration gating: a per-SHA Job, because Jobs are immutable.** A
  Kubernetes Job's `spec.template` cannot be updated in place — naively
  re-applying "the" migration Job with a bumped image errors, and a
  reconciler that shrugged that off would then `kubectl wait` against the
  *old* completed Job and roll out code ahead of schema: precisely the
  state R4 exists to prevent. So each deploy creates a **fresh Job named
  for the image SHA** (`migrate-<sha>`), the reconciler waits on **that
  exact name** with `kubectl wait --for=condition=complete`, and finished
  Jobs clean themselves up via `ttlSecondsAfterFinished`. A failed or
  timed-out migration aborts the run **with the old code still serving** —
  the mechanical guarantee behind R4 and §5.2's schema-first ordering.
- **The reconciler deploys the static tier too, as the last step.** After
  `kubectl rollout status` confirms the backend converged, the reconciler
  publishes `frontend/public/` **from the same checked-out commit** to
  Cloudflare Pages (`wrangler pages deploy`). This is what makes R4's
  backend-before-frontend ordering real: CI's write access ends at git and
  nothing else knows when the backend converged, so a CI-triggered Pages
  deploy could go live seconds after merge against a backend still minutes
  from converging. One sequencer, one source of truth. Honest costs: a
  Cloudflare API token now lives on the droplet, and a frontend-only
  change rides the reconciler's cadence (~a minute, plus backend
  convergence when there is one) instead of landing in seconds.
- **Rollback is `git revert`** of the bump commit. The reconciler
  converges to whatever the repo says; because images are SHA-tagged and
  immutable, reverting the manifest reverts the running code exactly — and
  because the static publish is the reconciler's last step, the same
  revert republishes the previous SPA *after* the backend has rolled back:
  both tiers restored, in the right order, from one commit. (Schema
  rollback remains forward-fix only, per §4a — this loop doesn't change
  that.)
- **Failure visibility — a dead-man's switch, git-native.** A halted
  rollout writes a log on the droplet, which nobody reads; worse, a *dead*
  reconciler (rotated deploy key, full disk, wedged timer) means deploys
  silently stop forever while CI stays green. Three mitigations, no new
  vendors: (a) the API exposes its **build SHA** — `/health` today returns
  only `{ status, env, db }`, so this is a small code change (§6.1); (b) a
  **scheduled GitHub Action** fetches the deployed SHA and compares it to
  the manifest's expected SHA, going red when they diverge for more than N
  minutes — one check that catches failed rollouts *and* a dead
  reconciler, because either way the SHAs stop converging; (c) the
  reconciler itself, best-effort, comments via `gh` or opens an issue on
  hard failure. Accepted limitation, recorded rather than designed away:
  the single manifest apply means a failed migration **head-of-line
  blocks all five components'** deploys until fixed forward — with one
  operator, being loudly blocked is preferred over partial-deploy states.
- **Upgrade trigger, recorded now.** The day the reconciler script needs
  real features — multi-env promotion, health-gated progressive delivery,
  deploy notifications beyond the dead-man's switch — is the signal to
  adopt **Flux**. The manifests carry over unchanged; only the script is
  discarded.
- **Secrets: created once at bootstrap, never in git.** Kubernetes
  Secrets (`DATABASE_URL`, `ADMIN_TOKEN`, `ANALYTICS_TOKEN`, the
  Cloudflare token, …) are created by the operator at bootstrap time
  (`kubectl create secret` from a local env file) and live only in the
  cluster. Manifests reference them by name; the repo never contains a
  secret value. **Considered and deferred: SOPS / sealed-secrets** —
  encrypted-secrets-in-git buys auditability and multi-operator handoff,
  which one operator on one cluster doesn't need; adoption trigger is a
  second operator or a second environment.
- **Rejected extra-minimal variant:** k3s's
  `/var/lib/rancher/k3s/server/manifests/` auto-apply directory. Rejected
  because it is k3s-specific (doesn't port to DOKS, breaking §3.2's growth
  path) and handles deletions poorly.

This also resolves the first draft's "where does the actual deploy pipeline
live?" question: the pipeline is designed to satisfy this doc's constraints
(independent per-component triggers, migration-first ordering, reviewable
deploy state) rather than the doc waiting on a pipeline to exist.

### 6.1 Required implementation changes

The proposal is docs-only, but it *prescribes* a small set of code and CI
changes. They are collected here — one visible list, each a future issue —
rather than scattered through the sections that motivate them:

1. **`migrate.ts`: `-- no-transaction` header support** — a migration file
   carrying that header runs outside `sql.begin`, enabling
   `CREATE INDEX CONCURRENTLY` (§5.3).
2. **`migrate.ts`: `lock_timeout` / `statement_timeout` defaults** applied
   to every migration, so a blocked DDL fails fast instead of queueing
   traffic behind it (§5.3).
3. **`migrate.ts`: split `seed()` out of `migrate()`** — flag or separate
   entrypoint; demo/CI keep the combined behavior, the production
   migration Job runs schema-only (§5.3).
4. **Disable migrate-on-boot in-cluster** — env-gated, so the API no
   longer runs `migrate()` as a boot precondition in production (§3.2).
5. **`client.ts`: `prepare: false` behind PgBouncer** — env-gated for
   transaction-mode pooling (§3.3).
6. **API CORS layer** — origin allowlist, real `OPTIONS` preflight,
   `Access-Control-Allow-Credentials` as needed (§3.1).
7. **Build SHA on `/health`** (or a `/version` route) — it currently
   returns only `{ status, env, db }`; the drift check needs the deployed
   SHA to be readable (§6).
8. **CI migration gate** — the R1 grep: `DROP` / `RENAME` /
   `ALTER ... TYPE` / bare `CREATE INDEX` over changed
   `backend/migrations/` files, with the contract-migration and
   small-table override labels (§5.1).
9. **Scheduled drift-check workflow** — the dead-man's switch comparing
   deployed SHA to manifest SHA (§6).
10. **`deploy/` manifests + reconciler script + CI build/bump workflow** —
    the pipeline itself (§6).
11. **`deploy/bootstrap.sh`** — idempotent droplet bootstrap: k3s install,
    deploy key, systemd timer + reconciler script, `cloudflared`, and
    prompted secret creation (§6). This is what makes "rebuildable from
    git" (§3.3) a tested property instead of a hope.

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
  `SWARM_SCHEDULES_ENABLED`-style env gate is closest to an ops toggle.
  A cross-component feature (schema + API + frontend all need to agree it's
  "on") is a **release toggle** in Fowler's terms, and those are explicitly
  meant to be short-lived and removed once the feature is fully rolled out
  — relevant to §5.7's deprecation discipline too, since a flag that never
  gets removed is its own form of permanent tech debt.
- **Capability negotiation / feature detection** — the general pattern (used
  by browsers detecting API support, by HTTP content negotiation, by
  protocol version handshakes) of asking "can you do X" rather than
  asserting "you must be version Y." Directly informs §5.4: the API
  checking for a column/table's existence (or a value in it) rather than
  trusting its own build's expected migration count.
- **Diagnostic version vs. branchable capability** — the specific split
  §5.4 would need if it were ever adopted, and Postgres itself is the
  cleanest example: `server_version_num` exists for diagnostics and
  reporting, while `information_schema` is what you actually branch on.
  Kubernetes API discovery (the server publishes the resources and versions
  it serves; clients adapt) and HTTP content negotiation are the same shape
  — the server declares what it supports, the client adapts, and nobody
  compares ordinals.
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

Questions answered in earlier passes have moved into the body as decided
positions: the SPA's own deploy path (yes — Cloudflare Pages, §3.1), where
the deploy pipeline lives (the minimal GitOps loop, §6), Pages vs R2
(Pages, R2 rejected — §3.1), whether CI bumps all five Deployments or a
path-filtered subset (all five, path-filtering rejected — §6), and whether
the production migration Job runs `seed()` (no — schema-only, seeding split
out, §5.3/§6.1). What follows is still genuinely open.

Carried over from the first draft:

- **Grace-window length for destructive changes.** R2 (§5.1) now defines
  the contract step by two checkable conditions — drift-check confirmation
  that every Deployment and the Pages deploy are past the last old-shape
  usage, plus a browser-tab grace window. The remaining open parameter is
  that window's length: **7 days is the proposed default**, unratified.
  The same number is the natural default for API-shape deprecations
  (§5.7), unless traffic observation ("old shape at zero") replaces it.
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
  dedicated env-var convention like `SWARM_SCHEDULES_ENABLED`, or a
  third-party flag service? No decision has been made and none is implied
  by anything in this doc.
- **API version-prefix threshold.** What actually counts as a "breaking
  enough" change to warrant a new `/api/v2/` prefix versus just an additive
  field? No threshold is proposed here — and §3.1 makes the question more
  pressing, since edge-cached SPA skew is now the everyday case.

New questions raised by the §3/§6 design:

- **GHCR vs DO Container Registry.** GHCR keeps images next to CI with no
  extra credentials in GitHub; DOCR keeps pulls inside DO's network next
  to the droplet. Either works with §6's SHA-tagged immutable images.
- **How the buildless SPA learns its API base URL.** Today
  `frontend/public/assets/js/app/lib/api.js` reads
  `window.RM_CONFIG.API_BASE_URL`, set by `frontend/public/config.js`,
  which is committed with `""` — meaning "same origin, the API serves this
  page" — and is documented as a file the host substitutes at deploy time.
  With the API on `api.` (§3.1) that value stops being an implicit empty
  relative base and becomes **explicit, per-environment configuration**,
  and because there is no bundler (D2) there is no build-time env
  substitution to do it. Candidate mechanisms: keep `config.js` but have
  the static deploy emit the right one per environment, move the value to
  a `<meta>` tag in the HTML, or derive it at runtime from the page's own
  hostname. No option is chosen here. (Routes themselves are unaffected —
  `contract/src/routes.js` holds only paths, never an origin.)
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
- **Recovery objectives and a restore drill.** The design leans on Managed
  PG backups/PITR as the last resort (§3.3), and forward-fix-only
  migrations mean a bad-enough day ends in a restore. What RTO/RPO is
  actually acceptable, and on what cadence is a **restore drill** run
  (restore a backup into a scratch cluster, boot the stack against it,
  verify)? An untested restore is not a restore.
- **Drift-check threshold.** The dead-man's switch (§6) goes red when
  deployed SHA and manifest SHA diverge for more than N minutes; N has to
  be long enough to tolerate a slow image pull and short enough to matter.
  Unset here.

Image and registry questions, noted as unaddressed rather than decided:

- **Base-image and Bun version pinning cadence.** `backend/Dockerfile`
  pins `oven/bun:1.3.5` today; nothing says when or how that moves, or who
  notices a base-image CVE.
- **Build architecture.** Images built on the CI runner and pulled by the
  droplet, or built on the droplet? Affects registry choice, arch
  matching, and how much the droplet needs installed.
- **Image retention / GC.** SHA-tagged images accumulate one per merge
  forever; no retention policy is proposed.
- **Do PRs build images at all**, or only merges to main? Building on PRs
  catches Dockerfile breakage early and multiplies stored images.
- **Provenance and signing.** SBOM generation, `cosign` signatures, and
  whether the reconciler should verify anything before applying. Nothing
  in §6 currently does.
