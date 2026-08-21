# Release process — foundational runbook policy

> **Status: in effect.** This document defines the foundational release-runbook
> policy that every per-release runbook must follow. It is not itself a
> runnable checklist; concrete rollouts are executed from per-release runbooks
> committed under `docs/runbooks/` (see §5). An example is
> [`docs/archive/v0-2-2-rollout.md`](../archive/v0-2-2-rollout.md) (archived after
> that release shipped), written
> against the `releases-0.2.x` branch.

This is not the process for landing ordinary feature work — that is PR review
against `main`, covered by [CONTRIBUTING.md](../../CONTRIBUTING.md) and the CI
taxonomy. This document is specifically about the step where a set of
already-merged `main` history is packaged, gated, and cut over into
production.

## 1. Scope and authority

Every production rollout of a numbered release must be planned, rehearsed, and
executed from a per-release runbook that conforms to this policy. The
per-release runbook is the **definitive, agent-executable procedure** for that
release — not the tracking issue (§6), and not tribal knowledge held by
whoever last did a rollout. The tracking issue's checklists exist to gate
progress through the runbook, not to duplicate or replace its content.

No release may skip a gate described here unless the release tracking issue
explicitly records the exception, the reason for it, and operator sign-off.

## 2. Release branch

Each release ships from a branch named `releases-A.B.x`:

- literal, plural **`releases`** (not `release`),
- `A.B` are the integer major and minor version being released,
- a literal trailing **`x`** where the patch number would go — the patch
  number is deliberately left blank, because the branch holds the whole
  `A.B` line, patches included.

Example: `releases-0.2.x` for the 0.2 line.

Feature PRs never target `releases-A.B.x` directly — ordinary feature work is
reviewed and merged via PR against `main`, exactly as this document's intro
paragraph says. Once a release's scope is decided, the branch receives only
(a) the specific commits cherry-picked from `main` that the release needs,
and (b) small incidental nit-fix commits made directly on the branch while
getting it out the door (see §7, Backporting). A release is **never tagged
directly on `main`** — the tag lands on the `releases-A.B.x` branch, so
`main` keeps moving with ordinary merges while the release line is frozen
except for the fixes it specifically needs. This applies to every tag the
release produces, release candidates included (§3).

Cherry-picking is what the branch needs *once `main` has moved past the
release scope*. A branch cut while the release scope is still exactly "all of
`main`" is legitimately cut whole and kept in step by fast-forward. Selective
cherry-pick starts at the point the branch and `main` must diverge, not at
the cut.

## 3. Version tags and release candidates

A version tag `vA.B.C` is **never** cut before **both** a completed preflight
and a completed postflight. The version tag records what has been *proven in
production*, not what is *intended for release*. Everything before that point
is a release candidate, tagged `vA.B.C-rc.N`, `N` counting from 0.

The cycle, run entirely on the release's `releases-A.B.x` branch (§2):

1. Cut `vA.B.C-rc.N` at the tip you intend to ship.
2. Run preflight against that rc. **Preflight fails** → fix, cut
   `vA.B.C-rc.(N+1)`, return to step 2.
3. **Preflight passes** → deploy that rc to production.
4. Run postflight. **Postflight fails** → patch, cut `vA.B.C-rc.(N+1)`, and go
   back through preflight (step 2) before deploying again. Every patch needed
   to reach a correct system consumes another rc number.
5. **Postflight clean** → tag `vA.B.C` at the exact commit that is running and
   verified in production — i.e. the final rc's commit.

Two consequences, stated outright because each one looks like a mistake and
neither is:

- **`vA.B.C` and the final `vA.B.C-rc.N` point at the same commit.** That is
  expected and correct, not duplication to clean up. Step 5 has no other
  commit available to it — the version tag names what production is running.
- **`vA.B.C` can never be cut at a commit that was not actually deployed and
  verified.** A fix that lands after the last deployed rc requires a new rc
  and another pass through steps 2–4; it cannot be "rolled into the final
  tag."

rc tags obey §2's branch rule exactly as the release tag does: they are cut on
`releases-A.B.x`, never on `main`.

### Precedent — v0.2.1

This is a newly written-down convention, not a newly invented one. v0.2.1
already ran it, undocumented (`git log -1 --format='%h %ci %s' <tag>`):

- `v0.2.1-rc.0` → `c2b9afc`, 2026-08-07
- `v0.2.1-rc.1` → `5970f2d`, 2026-08-08
- `v0.2.1` → `5970f2d`, 2026-08-08 — **the same commit as `rc.1`**

That shared-commit final tag is the norm this section describes, not an
anomaly in the tag history. One honest limit on the precedent: v0.2.1 predates
the `releases-A.B.x` convention and is reachable from `main`
(`git merge-base --is-ancestor v0.2.1 origin/main` succeeds, as it does for
both rc tags). It is precedent for the **rc numbering**, not for the branch
placement rule — that rule starts with v0.2.2.

## 4. Foundational release workflow

Every per-release runbook must implement the following workflow, in order.
Each gate is blocking: the runbook must stop and escalate if a gate fails,
and no later gate may be started until the current one is satisfied or
explicitly waived by the operator with a written reason.

### 4.1. Code-readiness gate

Before any rollout activity, verify both of the following:

1. The release tracking issue is closed/complete — every Phase and feature
   issue linked from its Phases tasklist is closed, and the objective is
   clearly stated (§6).
2. Every commit expected to ship in this release is present on the release
   branch. Prefer merging to `main` first and cherry-picking to
   `releases-A.B.x`; verify with a diff or log inspection that no expected
   change is missing from the branch.

Do not begin preflight, rehearsal, or any other rollout step while either of
the above is incomplete.

### 4.2. Pre-upgrade baseline

Before the upgrade changes any production state, record the production
database state using a read-only user or cluster node. Capture especially the
properties that the upgrade will change or correct — schemas, reference data,
configuration values, row counts, checksums, or any other state the objective
identifies as changing.

Save this baseline artifact next to the pre-upgrade backup with a clear
filename and timestamp. It must be available for comparison during postflight
and for use during rollback if needed.

### 4.3. Backup/restore smoke test

On a staging host inside the production database's private network, test
backup and restore of the production read-only database. The test must prove
that the backup tooling produces a restorable artifact and that the restore
procedure completes without error. Do not proceed to the digital-twin
rehearsal until this smoke test passes.

### 4.4. Digital-twin rehearsal

Set up a digital twin by restoring the backup from §4.3 to a local Postgres
container (not a remote database) on a staging machine. Run the full upgrade
on the twin, including:

- preflight checks,
- the cutover step that applies the upgrade,
- postflight verification.

The twin must use the same release candidate that is planned for production.
Any failure, warning, or unexpected state change discovered on the twin is a
blocking issue.

### 4.5. Stage rehearsal report

After the digital-twin rehearsal, produce a written stage rehearsal report
that includes at least:

- twin setup summary (source backup, container details, RC used),
- preflight results,
- cutover steps executed and their results,
- postflight results,
- acceptance-criteria pass/fail status against the release objective,
- any issues found and how they were resolved,
- a go/no-go decision with operator sign-off.

The stage rehearsal gate passes only when this report exists, all acceptance
criteria pass, and the operator has signed off.

### 4.6. Fix loop

If the digital-twin rehearsal or stage report finds any issue that affects
production safety or acceptance criteria, do not proceed to production
execution. Instead:

1. Open PRs with fixes against `main`.
2. Merge the fixes to `main`.
3. Cherry-pick the merged fixes to the release branch (`releases-A.B.x`).
4. Cut a new release candidate (`vA.B.C-rc.(N+1)`) at the updated branch tip.
5. Restart the runbook from §4.1.

Runbook corrections that do not change deployed code (e.g., wording, command
corrections) may be committed directly to the release branch, but they still
cost a new rc and a fresh pass through §4.

### 4.7. Production execution

Once the stage rehearsal gate passes, run the actual cutover and postflight
on a production machine. Follow the per-release runbook step by step. Every
destructive or irreversible step must be explicitly marked in the runbook and
authorized by the operator before execution.

Preflight must be re-run or re-confirmed on production before the cutover
begins, even if the twin rehearsal passed, to ensure the production
environment matches the twin assumptions.

The entire upgrade — preflight, cutover, and postflight — is **agent-executed
end to end**. No human runs commands against the production server directly;
a human's role is authorizing the release and reading the tracking issue's
checklists, not typing commands into a production shell.

### 4.8. Rollback

A postflight failure on production defaults to a full rollback by restoring
the pre-upgrade dump from §4.2. The operator may override the default
rollback only by recording the override reason, the alternate remediation
plan, and a second sign-off in the production rollout report (§4.9).

The rollback procedure must be written into the per-release runbook and
rehearsed on the digital twin at least once before production execution.

### 4.9. Production rollout report

After a successful cutover (or after rollback), produce a final production
rollout report covering at least:

- the release candidate deployed,
- cutover and postflight results (or rollback results),
- any issues encountered and their resolution,
- the final version tag applied,
- backport TODOs (§7),
- operator sign-off.

The report is the closing artifact of the release. The release tracking issue
is closed only after this report is filed and the final tag exists on the
release branch.

## 5. Per-release runbook format

Each release has an operator runbook committed under `docs/runbooks/`. The
runbook must:

- state the release identity and the delta it introduces,
- list go/no-go gates that map directly to §4,
- provide a preflight script or checklist,
- provide step-by-step cutover commands, with destructive or irreversible
  steps explicitly marked,
- provide post-cutover verification steps,
- be written so it can be executed top to bottom, every command
  copy-pasteable, every claim verified against a specific commit SHA rather
  than described from memory.

By convention the runbook lives on the release's `releases-A.B.x` branch,
alongside the code it describes cutting over to, so a runbook change and the
release content it documents move together.

Filenames under `docs/runbooks/` are kebab-case
(`scripts/lint-docs.sh` enforces this repo-wide for `docs/*.md` and
`docs/runbooks/*.md`).

## 6. Per-release GitHub tracking issue

Each release has one GitHub tracking issue carrying the label
`release:vX.Y.Z`. The tracking issue states the release's **objective**: the
end state the upgrade is meant to reach — which features should be live, what
state the database should be in — not just a list of merged PRs.

The issue carries two GitHub-checkbox checklists:

- a **preflight checklist**, mirroring the runbook's go/no-go gates and
  dry-run steps,
- a **postflight checklist**, mirroring the runbook's post-cutover
  verification steps.

Checking a box on the tracking issue is a claim that the corresponding gate
in the runbook was actually executed and passed — the issue is a state
summary derived from real runbook execution, never ticked off independent of
it.

The Phases tasklist is not just status tracking: it is the hard precondition
checked before preflight is allowed to start — see §4.1.

## 7. Backporting

**Not a go/no-go gate.** §4's workflow never checks backport debt, and an
outstanding backport is never a reason to hold up, fail, or re-run any step
of the rollout. Backporting is engineering hygiene owed once `vA.B.C` is
tagged and `releases-A.B.x` stops being the active release line — it is a
concern for whoever picks up work on `main` next, not for the agent executing
the rollout.

Fixes discovered directly on the `releases-A.B.x` branch during rollout —
during preflight dry-runs or the cutover itself — get merged back to `main`.
This is not a new rule invented for releases: it is the same standing
project convention that any code improvement lands on `main` and only what a
release specifically needs is carried onto its release branch (see §2) —
applied in the direction that matters once a fix is made *on* the branch
instead of on `main` first. A fix discovered on `releases-A.B.x` is exactly
the kind of "nit" §2 already expects the branch to accumulate; backporting it
is what keeps that branch's fixes from being silently lost the moment the
branch is done being the active release line.

The outstanding backport debt is a command, never a sentence in a document:

```bash
git log --oneline origin/main..origin/releases-A.B.x
```

Empty means the branch is a strict subset of `main` and nothing is owed.
Every commit listed is a fix that exists only on the release branch and must
be carried back to `main`.

---

## 8. Compatibility contract — how the components are allowed to drift

> **Migrated here 2026-08-21** from `docs/technical/release-cycle.md` §5, which
> was archived as
> [`docs/archive/release-cycle.md`](../archive/release-cycle.md). That document
> mixed two things: this compatibility contract, which is **live policy**, and a
> proposed k3s/GitOps production topology, which is a future-infrastructure
> proposal alongside the `stack-*` documents. Only the contract is normative, so
> only the contract moved.
>
> These rules are what make a rollback survivable. `rollout-procedure.md` §10
> asks each release whether its outgoing code is safe against the incoming
> schema; **R1 is the reason the answer is normally yes.**


### 8.1 The four rules

The minimal approach, chosen in discussion. The governing insight is that
**ordering discipline makes runtime detection unnecessary — you don't need
to detect a mismatch you have made impossible.** These four rules are *the*
operational contract; everything else in §8 is either the pattern that
implements them (§8.2) or an option deliberately deferred because they hold
(§8.4).

- **R1 — Every migration is additive.** New tables, columns, and indexes
  only. Nullable or defaulted, never `NOT NULL` without a default. No
  renames, no drops, no type narrowing. *Consequence: the DB can always be
  safely ahead of the code.* Schema-additive is not automatically
  *semantics*-safe, though: until every **writer** has rolled, rows keep
  arriving with the new column NULL/absent — so readers must treat
  NULL/missing as the legacy state for the whole transition. That is not
  an extra rule; it is the dual-read phase of expand/contract (§8.2),
  stated explicitly.
- **R2 — Destructive changes wait until provably safe.** A drop or rename
  ships in a **later PR** than the code that stopped using the old shape,
  never the same one. "Later" is defined operationally, not by calendar
  feel — a destructive migration may merge only when **both** hold:
  1. the drift check (the drift check described in the archived release-cycle proposal) confirms all five Deployments **and** the Pages
     deploy are on SHAs at or past the commit that removed the last use of
     the old shape;
  2. a browser-tab grace window has elapsed since that deploy — proposed
     default **7 days**; the exact number is the one parameter left open
     (left open in that proposal).
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
  `-- no-transaction` runner support, §8.3) or carry an explicit
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
detection (§8.4). Plainly: don't do that.

### 8.2 Expand/contract for DB migrations

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

### 8.3 Migration hygiene gaps against a live database

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
  `sql.begin`, making `CREATE INDEX CONCURRENTLY` expressible; §8.1's R1
  gate then rejects bare `CREATE INDEX` so the safe form is the default
  form.

### 8.4 API/DB version skew: why runtime detection is deferred

R1–R4 (§8.1) make runtime version detection unnecessary: if the DB is only
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
descriptor** — recorded the same way as Flux (the drift check described in the archived release-cycle proposal) and Kustomize (the drift check described in the archived release-cycle proposal):

- A version **integer** was rejected outright. The filename set is strictly
  richer information, and collapsing it to an ordinal is lossy — especially
  given that the prefixes are not linearly ordered (§8.3).
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

### 8.5 API versioning for the frontend and workers as consumers

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
window (§8.7) rather than deleted the day the new one ships. Workers/producer
should follow the same additive-fields discipline since the producer is
already an API consumer over authenticated HTTP (§2c).

### 8.6 Feature flags

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
If the two-layer capability descriptor of §8.4 is ever adopted, its coarse
*feature* layer — the AND of schema-supports-it, flag-is-on,
config-present — is the natural home for exactly this: one published
answer to "is X available," with the flag as one input. Noted as a
connection, not a commitment; both remain deferred.

### 8.7 Deprecation policy

No deprecation policy exists today because nothing has ever needed to
outlive a replacement — every environment redeploys everything at once. Once
components decouple, an old endpoint/field shape needs to stay live for
**at least as long as the slowest consumer can realistically still be
running it** — for the frontend that means "at least until a browser tab
open at deploy time would have naturally reloaded," for a worker lane that
means "until every worker container has been redeployed," and for the DB
that means the expand/contract window (§8.2). Communicating a deprecation
today has no established channel — no changelog, no deprecation-header
convention in the API responses. The concrete window length and the
communication mechanism are both left open (left open in that proposal).
