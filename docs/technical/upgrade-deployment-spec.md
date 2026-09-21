# Upgrade deployment — the tool-separation specification

> **Status: proposed, pending [D46](../decisions.md#d46).** This document is the
> mechanism contract between the tools and the runbooks. It does not change the
> release **policy** — every gate in
> [`release-runbooks.md`](./release-runbooks.md) §4 stands — and it does not
> change the **topology** — [`deployment.md`](../runbooks/deployment.md) remains
> the standing reference for what exists. What it changes is *which tool does
> which job*, and the credential each job holds while doing it. The engineering
> plan that implements it is
> [`../plans/deploy-separation-engineering-plan.md`](../plans/deploy-separation-engineering-plan.md).
>
> **Naming.** `scripts/stack/` in this repository is the internal orchestrator
> library the smoke tool boots through. It is unrelated to
> [bozemanpass/stack](https://github.com/bozemanpass/stack), the Kubernetes
> tool evaluated in
> [`stack-runbook-reconciliation.md`](./stack-runbook-reconciliation.md). This
> document never means the latter.

## 0. The defect this specification exists to remove

Production is deployed by the smoke tool: `SMOKE_PROJECT=rm_prod bun run
smoke:archive -- --no-tui` (`rollout-procedure.md` §8.2). That command's own
documentation says what it does before anyone can look: *"It writes to
production three times before you can inspect anything: this release's
migrations, `seed()` rewriting the five `swarm.*` schedule rows, and the archive
initializer."* The tool whose job is to stand an environment up is the tool
that changes production's schema, and it does so unconditionally —
`scripts/stack/stack.ts`'s `up()` calls `migrate()` between "postgres ready" and
"start services" with no way to not.

Everything else follows from that one coupling, and each consequence was
observed on 2026-09-21:

| Consequence | Observed as |
|---|---|
| Starting services needs the schema-owner credential | A routine redeploy needed `doadmin`, the cluster's bootstrap login, present in the deploy shell |
| The credential could not be short-lived, so it leaked into the runtime | Five long-running containers carried `MIGRATE_DATABASE_URL=postgres://doadmin:…` for 19 hours, read by nothing (`src/api/index.ts:51` — the api process "invokes neither migrate nor db-preflight"; no worker lane imports `migrate()`) |
| Rotating the bootstrap credential made production un-redeployable | `doadmin` was rotated at ~22:40Z; the stack could not be restarted without re-exporting it, though no schema change was pending |
| The migration credential *was* the bootstrap credential | `0053_database_role_taxonomy.sql:56` — `GRANT rm_owner TO current_user` — welds whoever provisions the taxonomy into the permanent migration login; on DigitalOcean that is `doadmin`, and it is the only holder of `rm_owner` membership on production |
| Production runs as a smoke environment | `docker-compose.smoke.yml` is always appended (`rollout-procedure.md` §2 fact 1), so production's api reports `env=smoke`, and `config.ts:710`'s refusal of a `doadmin` `DATABASE_URL` — gated on `RM_ENV === "prod"` — has never been armed there |
| A schema defect surfaced as a runtime outage nothing reported | 1,968 dead sampler jobs behind six green healthchecks; the only evidence was `permission denied for table asset_prices` in a worker's log, which no gate reads |

The taxonomy in `0053` was designed to prevent exactly this: *"A human-run
deployment connects with the short-lived `MIGRATE_DATABASE_URL` and `SET ROLE
rm_owner` for DDL. Runtime processes authenticate only as `rm_app` or
`rm_worker`."* The tools never implemented the first sentence.

## 1. The tools, and the one rule that separates them

**A tool does one job, holds only the credential that job needs, and is
sequenced by a runbook — never by another tool.** The runbook is the only
place that knows the order; the manifest (`steps.ts`) is the only place that
records it; the probe (`backend/scripts/upgrades/runbook.ts`) is the only thing
that says where you are.

| Tool | Job | May write to a database it does not own? | Role it connects as | Named entry point |
|---|---|---|---|---|
| **capture** | Produce the encrypted backup a twin restores | No — read-only, replica only | `rm_readonly` | `bun run smoke:capture` |
| **preflight** | Grade the live target and the dump *before* anything runs | No | `rm_readonly` | `upgrades/<from>-to-<to>/preflight.ts` |
| **smoke** | Stand an environment up and prove it serves | **No.** It migrates and seeds only a database it created (§3) | `rm_app` / `rm_worker` | `bun run smoke …` |
| **migrate** | Apply pending migrations, once, and record them | Yes — that is its whole job, and the only one | `rm_migrator` (§2) | `bun run migrate:external` (new, §4) |
| **initialize** | Idempotent data bootstrap after a deploy (schedules, archive rows) | Yes, idempotently, through the runtime role | `rm_app` | `prod-bootstrap.ts --already-migrated` |
| **postflight** | Grade what landed | No | `rm_readonly` | `upgrades/<from>-to-<to>/postflight.ts` |
| **verify** | Grade what the product does, over HTTP | Tiered: `readonly` never; `full` never against production | HTTP, not SQL | `bun run verify:live` |
| **runbook** | Sequence the above; write and grade receipts | Never directly | none | `runbook.ts`, `steps.ts` |

Three consequences the current tooling violates:

1. **Smoke never holds a migration credential.** `MIGRATE_DATABASE_URL` is not
   in smoke's compose passthrough for an `external` data path. If it is
   present in the environment of an `external` boot, smoke refuses to start
   (§6) — a migration credential near a stand-up is a category error, not a
   convenience.
2. **A runbook sequences tools; it does not reach around them.** The cutover
   is *steps*, each with a receipt: assert the schema is current, migrate if it
   is not, deploy, initialize, grade. Today none of those is a receipted step
   (no release's `steps.ts` has ever carried a `P7.*` entry; the cutover is
   prose in `rollout-procedure.md` §8.2 and a `$?` the operator is told to
   capture by hand).
3. **Every check a runbook needs is a tool it can call**, including the ones a
   human would do by eye — tailing the logs of a rehearsal is one of them
   (§5).

## 2. Credentials — who holds what, and where it lives

| Role | Attributes | Holds | Lives on | Used by |
|---|---|---|---|---|
| `doadmin` (cloud bootstrap) | cluster admin, `CREATEROLE` | everything the provider gives it | **the provider's dashboard or an operator vault, and nowhere else** | `provision-db-role-taxonomy.sh`, once, at first bootstrap; and provider-level break-glass |
| `rm_owner` | `NOLOGIN` | owns every object in `public` | nowhere — it cannot authenticate | assumed via `SET LOCAL ROLE` by the migration session |
| **`rm_migrator`** (new) | `LOGIN NOINHERIT NOCREATEROLE NOCREATEDB` | membership in `rm_owner`, nothing else | `$HOME/.env` on the **cutover host only**, as a `rm_migrator = …` line | the migrate tool, and only the migrate tool |
| `rm_app` | `LOGIN` | DML on application tables | `$HOME/.env` on the cutover host; `DATABASE_URL` in api/worker containers | api, initialize |
| `rm_worker` | `LOGIN` | allow-listed DML (`0054`) | `$HOME/.env` on the cutover host; `WORKER_DATABASE_URL` in worker containers | worker lanes |
| `rm_readonly` | `LOGIN` | `SELECT` everywhere, replica | `$HOME/.env` on the **stage host** | capture, preflight, postflight, the twin |

**`doadmin` is deprecated everywhere below the provisioning script.** Its blast
radius is the cluster; `rm_migrator`'s is the schema of one database. A
migration run as `rm_migrator` cannot create or drop a role, cannot create or
drop a database, and cannot touch a sibling database on the cluster. That is the
whole of what a migration needs, so it is the whole of what the migration login
gets.

**`0053` is corrected, not replaced.** It creates `rm_migrator` under the same
`IF NOT EXISTS` guard as its siblings and grants `rm_owner` to it. It still
grants `rm_owner` to `current_user` — the ownership sweep in the same
transaction needs it — but the runbooks stop describing that grant as "the
migration login", because it is not. The provisioning script's verification
asserts `rm_migrator` holds the membership and that neither runtime role does.

**Refusals, so the model is enforced rather than described:**

- `backend/src/db/migrate.ts` refuses a `MIGRATE_DATABASE_URL` whose user is
  `doadmin`, unconditionally — the symmetric guard to `config.ts:710`.
- `config.ts` refuses a `doadmin` `DATABASE_URL` *regardless of `RM_ENV`*. The
  `RM_ENV === "prod"` gate is what let production run unguarded (§0).
- The rehearsal twin is reshaped to the **post-taxonomy** shape — `rm_owner`
  owning `public`, `rm_migrator` holding membership — and migrates as
  `rm_migrator`. `restore-container.ts`'s current `rm_twin_bootstrap`
  mirrors `doadmin`'s attribute set, which rehearses the credential this
  specification retires.

## 3. Ownership decides who migrates

The smoke tool already models this and does not act on it.
`scripts/lib/smoke-db-mode.ts:132`:

```ts
// ephemeral ✓ (its own container) · smoke-twin ✓ (a copy it created) · external ✗
export function ownsData(dp: { kind: DbMode }): boolean {
  return dp.kind !== "external";
}
```

**The rule:** `up()` migrates and seeds **if and only if `ownsData()`**.

| `--db` | Owns the data? | What `up()` does about the schema |
|---|---|---|
| `ephemeral` | yes — it created the container | migrate + seed, as today |
| `smoke-twin` | yes — it restored the copy | migrate + seed **as `rm_migrator`** (§2), because the rehearsal's point is that the migration runs for real |
| `external` | **no** | **assert the schema is current, and refuse to start services if it is not** |

The assertion is a read: every file in `backend/migrations/` is recorded in
`schema_migrations`. It runs as `rm_app` — no privilege beyond `SELECT` on one
table — and it is a separate tool, `backend/scripts/schema-current.ts`, because
runbooks need it as a step in its own right (§4). Exit `0` current; exit `1`
pending, naming every unapplied file; exit `2` could not determine (unreachable,
table absent).

**Why refuse rather than warn.** Serving an old schema under new code is the
outage the migration exists to prevent, and it is silent: the api serves,
`/health` is green, and the first failing query is wherever the new column is
first read. A refusal names the files and the command that applies them. A
warning is scrollback.

**Why a fresh external database is not an exception.** The first deploy to an
empty managed server is the one case where "assert current" fails on a
database with no `schema_migrations` at all. That is exit `2`, and it is
correct: standing up an environment against an unmigrated server is a
*bootstrap*, which is a runbook (§4, P7) — not something a stand-up tool should
quietly turn into.

## 4. The upgrade sequence

Phases keep their numbers and policy mapping; the change is that **P7 becomes
receipted steps** instead of one irreversible command. Every step is a
`RolloutStep` in the release's `steps.ts` (`backend/scripts/lib/rollout-manifest.ts`),
with the host role, actor, `requires`, `dependsOn` and `verify:` command that
type demands. The probe grades them like every other step.

| Step | Phase | Policy | Host | Actor | Tool | Writes? |
|---|---|---|---|---|---|---|
| `P3.backup` | backup | §4.3 | stage | agent | capture | no |
| `P3.gate-c` | backup | §4.3 | stage | script | restore-check | no (into a throwaway) |
| `P4.preflight-live` | preflight | §4.7 | stage | script | preflight | no |
| `P5.rehearsal` | rehearsal | §4.4 | stage | script | smoke (`--db smoke-twin`) + release checks + **log capture (§5)** | into the twin only |
| `P6.rc-tag` | identity | §3 | any | operator | git | — |
| **`P7.schema-current`** | cutover | §4.7 | cutover | script | `schema-current.ts` against the live primary | no |
| **`P7.migrate`** | cutover | §4.7 | cutover | script | `migrate:external`, as `rm_migrator`; **skipped with a receipt when `P7.schema-current` is `0`** | **yes — the only DDL step** |
| **`P7.deploy`** | cutover | §4.7 | cutover | script | smoke (`--db external`), which asserts `schema-current` again and starts services | no |
| **`P7.initialize`** | cutover | §4.7 | cutover | script | `prod-bootstrap.ts --already-migrated`, as `rm_app` | idempotent DML |
| `P8.postflight-prod` | verify | §4.7 | cutover | script | postflight | no |
| `P8.verify-prod` | verify | §4.7.1 | cutover | script | verify-live `readonly` | no |

**The migration credential exists for one step.** `P7.migrate`'s `verify:`
command is the only line in a runbook that names `rm_migrator`. It reads the
role line from `$HOME/.env` through `urlForRole(env, "rm_migrator")`, runs the
migration as an ephemeral `docker compose run` child with the credential named
**bare** (`-e MIGRATE_DATABASE_URL`, never `-e VAR=value` — argv is public), and
writes a receipt recording the files it applied. `P7.deploy` runs with no
migration credential in its environment at all, and refuses if one is present.

**A code-only release skips `P7.migrate` mechanically, not by omission.**
`P7.schema-current` returning `0` on the live primary is itself the receipt
that `P7.migrate` was not needed. The v0.5.1 manifest today encodes "carries no
migration" as *the absence of a step*, which the probe cannot distinguish from
"forgot to add one".

**`P7.deploy` is a restart, and a restart needs nothing privileged.** With the
schema asserted current, a redeploy needs `rm_app` and `rm_worker` — the
credentials already on the cutover host — and nothing else. Rotating `doadmin`
or `rm_migrator` cannot make production un-restartable, which is the property
§0's third row shows we did not have.

**Rollback (policy §4.8) keeps its two axes.** Code: `P7.deploy` at the previous
tag — a restart, no credential. Data: the dump restore, a runbook step that
*does* need `rm_migrator`-level access to drop and recreate, and is receipted as
such. The axes are independent, and a migration that ran is not undone by
redeploying old code; the runbook says which axis it is rolling.

## 5. The rehearsal contract, extended

`rollout-procedure.md` §6.2's G1–G8 stand. Two are added.

**G9 — the window has logs, and the release's checks can read them.** Today the
driver (`scripts/lib/smoke-twin-rehearsal.ts`) hands `onReady` a database URL
and nothing else; the release's checks poll the database
(`functional-rehearsal.ts`) and the container logs are advice printed to the
console (`smoke-main.ts:819`: *"logs: `docker compose -p <project> logs -f`"*).
The 0054 outage was invisible to every one of those checks and visible in the
first line of the worker's log.

- From readiness until teardown the driver tails `docker compose -p <project>
  logs -f --timestamps` for every service into
  `$RM_BACKUP_DIR/rehearsal-logs/<stamp>/<service>.log`. The files are
  artifacts of `P5.rehearsal` and are hashed into its receipt.
- `onReady` receives a `logs` handle: `logs.since(readyAt)`,
  `logs.grep(service, pattern)`, `logs.path(service)`.
- A **standard check** ships with the driver and runs for every release, not
  per release: **no line matching a privilege or authentication failure in any
  service during the window** (`permission denied`, `42501`, `28P01`,
  `password authentication failed`, `role .* does not exist`). The pattern set
  lives beside `smoke-telemetry.ts:117`'s existing error picker and is extended
  by a test, not by hand. A match fails the rehearsal and names the service,
  the timestamp and the line.
- A release may add its own log assertions in `onReady` the same way it adds
  database ones.

**G10 — the rehearsal migrates as the migration login, not as a bootstrap
login.** `RM_TWIN_PRODUCTION_PRIVILEGES=1` stays the opt-in, and what it
reshapes changes: the twin gets `rm_owner` owning `public` and `rm_migrator`
holding the membership, and `P5.rehearsal`'s migration runs as `rm_migrator`.
A rehearsal that migrated as a role production will never use again proves the
wrong thing (policy §4.4: *"a gate that runs with more privilege than
production proves less than it appears to"*).

## 6. Refusals

Each is a hard exit with a message naming the rule, never a warning.

| Tool | Refuses when | Because |
|---|---|---|
| smoke, `--db external` | `MIGRATE_DATABASE_URL` is set in its environment | a stand-up holding a migration credential is the coupling this document removes |
| smoke, `--db external` | `schema-current.ts` exits non-zero | serving an old schema is silent; refusing is not |
| smoke, `--db external` | `RM_ENV` is not `prod` | production must run with its guards armed; the smoke composition's `RM_ALLOW_INSECURE=1` is a smoke property and cannot reach an external boot (**plan phase 5** — this is the one row that needs design work, because `docker-compose.smoke.yml` is unconditionally appended today) |
| migrate | the credential's user is `doadmin` | deprecated below provisioning (§2) |
| migrate | the credential's user is `rm_app` or `rm_worker` | a runtime role that could `SET ROLE rm_owner` could run DDL — `preflight.ts` already fails on this |
| migrate | `schema-current.ts` exits `2` and the target is not a fresh database | it cannot tell "nothing to do" from "cannot see" |
| `config.ts` | `DATABASE_URL` names `doadmin`, any `RM_ENV` | the current `prod`-only gate is why production ran unguarded |
| provisioning script | verification finds `rm_migrator` without `rm_owner` membership, or a runtime role with it | the credential model of §2 |

## 7. Evidence

Each new step writes the receipt the manifest already defines: exit code,
verdict, SHA, rc tag, host, database identity, artifact hashes. Two additions:

- `P7.migrate`'s receipt lists the migration files it applied (possibly none)
  and the role it connected as, so "what changed the schema, and as whom" is a
  mechanical answer.
- `P5.rehearsal`'s receipt hashes the captured service logs (§5), so a
  rehearsal report (policy §4.5) can cite them rather than paraphrase them.

Receipts still hold no secrets; a role *name* is identity, not a credential.

## 8. What this specification does not decide

- **Where production images are built.** Today the cutover host builds
  (`up()` → `build()`), which `smoke-twin-rehearsal.ts`'s own header forbids
  for the rehearsal on the grounds that a production host cannot spare the
  load. `stack-runbook-reconciliation.md` §4.2 argues for commit-addressed
  published images. This document requires only that `P7.deploy` be a restart;
  whether it pulls or builds is that document's decision.
- **The Kubernetes path.** Nothing here presumes compose beyond what the tools
  do today; every step maps onto the reconciliation document's gate table.
- **Seeding on a fresh external database.** `P7.initialize` covers production,
  which is populated. The first deploy to an empty managed server is an
  environment-bootstrap runbook, not covered here.
