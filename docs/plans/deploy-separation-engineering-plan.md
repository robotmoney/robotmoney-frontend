# Engineering plan — separating stand-up, migration and the bootstrap credential

> **Status: proposed, implements [`../technical/upgrade-deployment-spec.md`](../technical/upgrade-deployment-spec.md)
> under [D46](../decisions.md#d46).** Section references below marked `spec §n`
> are that document's; `policy §n` is
> [`release-runbooks.md`](../technical/release-runbooks.md).
>
> **⚠ Phase 1 is superseded.** [`smoke-production-spec.md`](../technical/smoke-production-spec.md)
> (adopted 2026-09-22) abandons `rm_migrator` in favor of `rm_owner` becoming
> `LOGIN` and serving as the migration credential directly (its §3, §9.1).
> None of Phase 1's items below should be built; the transition they were
> for is now that spec's §9.1 steps 1–2. **Phase 5 is superseded and
> resolved**, not just scoped: the new spec's §4 (environment/target),
> §1 (plan/lock/journal), and §9.3 (transition from the current host) are
> the decision this phase asked for. Phases 2–4 and 6 still describe real,
> undecided work, but should be re-read against the new spec's plan/lock/
> journal model (§§1–2) and schema/manifest model (§8) before being
> implemented as written — several of their files and tests (`schema-current.ts`,
> the `P7.*` step names, `ownsData()`) are affected by mechanisms the new
> spec adds on top of them.

## Sequencing rule

Policy §4.6 is unambiguous: a change that affects production safety sends an
in-flight release back to §4.1 and costs an rc. **Phases 1–4 change the cutover
path, so they land on `main` and ship in the release line after v0.5.1**, not
on `releases-0.5.x` mid-rollout. Phase 0 is documents and a decision, and is
safe on any branch. Phase 5 needs its own decision before it is scheduled.

Each phase is independently shippable and leaves the system consistent. Order
within a phase is dependency order.

Two commits on 2026-09-21 are prerequisites and are already on
`releases-0.5.x`: `2948e63f` (provisioning script survives a first bootstrap;
verification survives itself) and `de5efffa` (no runtime service declares
`MIGRATE_DATABASE_URL`). Everything below builds on them.

---

## Phase 0 — Record the decision *(this change)*

| # | Item | Files | Acceptance |
|---|---|---|---|
| 0.1 | Specification | `docs/technical/upgrade-deployment-spec.md` | exists; `scripts/lint-docs.sh` passes |
| 0.2 | Decision D46 | `docs/decisions.md` | appended in the D-format; cites the spec |
| 0.3 | This plan | `docs/plans/deploy-separation-engineering-plan.md` | — |
| 0.4 | Standing docs point at the spec | `release-runbooks.md` §4.4/§4.7/§5, `rollout-procedure.md` §1/§7.5/§8.2, `deployment.md` §1/§4.3, `v0-5-1-rollout.md` §6, `.env.example` | no in-flight `yaml step` block changes (`rollout-steps-0-5-1.test.ts` still passes) |

---

## Phase 1 — `rm_migrator`: retire `doadmin` below provisioning *(spec §2)*

**Why first:** everything later assumes a migration login that is not the
cluster admin. It is idempotent SQL plus guards, and it lands on production the
next time the provisioning script runs — which the runbooks already require
before a cutover.

| # | Item | Files | Tests | Acceptance |
|---|---|---|---|---|
| 1.1 | `0053` creates `rm_migrator` (`LOGIN NOINHERIT NOCREATEROLE NOCREATEDB`, guarded `IF NOT EXISTS`) and `GRANT rm_owner TO rm_migrator` | `backend/migrations/0053_database_role_taxonomy.sql` | extend `migration-0053-creates-every-role-it-alters.test.ts`: five roles, every one guarded; `database-role-taxonomy.test.ts`: `rm_migrator` can `SET ROLE rm_owner`, `rm_app`/`rm_worker` cannot, `rm_migrator` cannot `CREATE ROLE` or `CREATE DATABASE` | applies cleanly to a fresh cluster **and** to a migrated one (the throwaway-postgres proof from `2948e63f`, repeated) |
| 1.2 | Provisioning script verifies the new shape: `rm_migrator` exists, holds `rm_owner`, is not superuser; **the login running the script is reported, not required, as an `rm_owner` member** (the 2b check flips from "must" to "informational" once `rm_migrator` exists) | `scripts/ops/provision-db-role-taxonomy.sh` | `provision-roles-no-rotation.test.ts` gains the property; red-control against a throwaway cluster (revoke the membership → WRONG) | `--set-passwords` also prompts for `rm_migrator` |
| 1.3 | `migrate.ts` refuses `doadmin`, `rm_app`, `rm_worker` as the migration user | `backend/src/db/migrate.ts` | new unit test spawning `migrate.ts` with each forbidden URL → non-zero, message names the rule | the message names `rm_migrator` and `.env.example` |
| 1.4 | `config.ts` refuses a `doadmin` `DATABASE_URL` under **every** `RM_ENV` | `backend/src/config.ts:710` | existing test extended to `smoke` and `ephemeral` | production's guard is armed regardless of composition |
| 1.5 | The twin reshapes to the post-taxonomy shape and migrates as `rm_migrator` (G10) | `scripts/lib/restore-container.ts` (`TWIN_BOOTSTRAP_ROLE`, `shapeTwinToProductionPrivileges`) | the rehearsal-privileges test asserts the migration session's `current_user` is `rm_migrator` | `RM_TWIN_PRODUCTION_PRIVILEGES=1` no longer creates a `doadmin`-shaped role |
| 1.6 | Documented role line | `.env.example`, `scripts/lib/env-role.ts` (`ROLES` gains `rm_migrator`, cutover host only) | `env-role.test.ts` | `urlForRole(env, "rm_migrator")` assembles from the discrete tokens |

**Production action after 1.1–1.2 ship:** run the provisioning script once
(`doadmin`, prompted, last time it is needed for this), then
`--set-passwords` is *not* required for existing roles — only `rm_migrator`
needs a password, which a dedicated `--set-password rm_migrator` argument
should set (1.2 gains it) so the other three are never touched. Add the
`rm_migrator = …` line to the cutover host's `$HOME/.env`.

---

## Phase 2 — Smoke stands up; a separate tool migrates *(spec §3, §4, §6)*

| # | Item | Files | Tests | Acceptance |
|---|---|---|---|---|
| 2.1 | `schema-current.ts`: read-only comparison of `backend/migrations/*.sql` against `schema_migrations`; exit `0`/`1`/`2` per spec §3; `--emit-receipt` | `backend/scripts/schema-current.ts` | unit: fresh db → 2; migrated → 0; one file unapplied → 1 naming it | runs as `rm_app`; needs no privilege beyond `SELECT` on one table |
| 2.2 | `up()` migrates **iff `ownsData()`**; for `external` it runs 2.1 and refuses on non-zero, naming the pending files and the `migrate:external` command | `scripts/stack/stack.ts` (`up()`), `scripts/lib/smoke-db-mode.ts` (`ownsData` becomes the predicate `up()` reads) | `stack` ordering test: external → no `migrateArgs` call, one `schema-current` call; ephemeral/twin → unchanged | `bun run smoke:archive` against production issues **no DDL** |
| 2.3 | Smoke refuses an `external` boot if `MIGRATE_DATABASE_URL` is in its environment | `scripts/lib/smoke-compose-env.ts` (drop it from the passthrough for `external`), `smoke-main.ts` | test: `external` + the var set → exit non-zero before docker | the passthrough comment at `:58` is rewritten to say why it is `smoke-twin`-only |
| 2.4 | `migrate:external`: the migrate tool. Reads `$HOME/.env`, `urlForRole(env,"rm_migrator")`, refuses anything else (1.3), runs `migrateArgs()` as an ephemeral compose child with the credential named bare, then runs 2.1 and refuses to exit `0` unless it is current; `--emit-receipt=P7.migrate` listing applied files and the role | `scripts/migrate-external.ts`, `package.json` | test with a stubbed `docker` recording argv: bare `-e`, no secret in argv; receipt shape | the only command in the repo that names `rm_migrator` |
| 2.5 | `migrate.ts` no longer calls `seed()` when invoked by 2.4; seeding is `P7.initialize`'s job (`prod-bootstrap.ts`) | `backend/src/db/migrate.ts`, `backend/scripts/prod-bootstrap.ts` | existing seed tests run through the initialize path | a migration run changes schema and the ledger, nothing else |
| 2.6 | Compose: the migrate child inherits nothing it does not need — the `-e` list in `migrateArgs()` is the complete credential surface | `scripts/stack/config.ts` | `no-bootstrap-credential-in-services.test.ts` extended: the *only* consumer is `migrateArgs()` | — |

**Behaviour change to announce:** a `--db external` boot against a server with
pending migrations **stops** and tells you to run `migrate:external`. That is
the point.

---

## Phase 3 — The cutover is receipted steps *(spec §4, §7)*

| # | Item | Files | Tests | Acceptance |
|---|---|---|---|---|
| 3.1 | Manifest steps `P7.schema-current`, `P7.migrate`, `P7.deploy`, `P7.initialize` in the next release's `steps.ts`, with `hostRole: "cutover"`, `requires`, `dependsOn` (2.1/2.4's files, `backend/migrations/**`, `docker-compose.yml`, `scripts/stack/**`) | `backend/scripts/upgrades/<next>/steps.ts`, `backend/scripts/lib/rollout-manifest.ts` (a `cutoverCode()` glob group) | `rollout-steps-<next>.test.ts` | the probe shows P7 as four rows |
| 3.2 | `P7.migrate` may be **skipped with a receipt** when `P7.schema-current` is `0` — a `skipped` verdict the probe renders as done-by-evidence | `backend/scripts/lib/rollout-receipt.ts`, `rollout-where.ts` | probe test: skipped ≠ missing ≠ failed | a code-only release no longer encodes "no migration" as an absent step |
| 3.3 | `P7.deploy`'s `verify:` is `SMOKE_PROJECT=rm_prod bun run smoke:archive -- --no-tui --emit-receipt=P7.deploy`; smoke learns `--emit-receipt` (exit code, project, ports, image SHAs) | `scripts/lib/smoke-main.ts` | receipt shape test | `BOOT_STATUS=$?` leaves the runbook |
| 3.4 | `rollout-procedure.md` §8 rewritten as the four steps; §8.2's "writes three times" paragraph becomes history | docs | `lint-docs` | — |

---

## Phase 4 — Rehearsals have logs *(spec §5, G9)*

| # | Item | Files | Tests | Acceptance |
|---|---|---|---|---|
| 4.1 | Driver tails `docker compose -p <project> logs -f --timestamps` per service from readiness to teardown into `$RM_BACKUP_DIR/rehearsal-logs/<stamp>/<service>.log`; killed in `finally` | `scripts/lib/smoke-twin-rehearsal.ts` | test with a stubbed compose that emits lines; files exist, tail dies on teardown | logs survive a failed rehearsal |
| 4.2 | `onReady` receives `logs: { since(t), grep(service, re), path(service) }` | same | unit over fixture files | — |
| 4.3 | Standard check: no privilege/auth failure line in any service during the window; pattern set shared with `smoke-telemetry.ts:117` and pinned by test | `scripts/lib/smoke-telemetry.ts`, driver | RED CONTROL: a planted `permission denied for table x` line → rehearsal exit `1` naming service + line | runs for every release, no per-release code |
| 4.4 | `P5.rehearsal` receipt hashes the log files as artifacts | `stage-rehearsal.ts` (next release), manifest `artifacts:` | `rollout-steps` test | policy §4.5 report cites them |
| 4.5 | *(follow-up, same shape)* `P7.deploy` captures the first N minutes of production service logs into the receipt's artifacts and runs 4.3's check — the outage of §0's last row becomes a red cutover instead of a green one | `smoke-main.ts` | — | — |

---

## Phase 5 — Production is not a smoke environment *(spec §6, third row)* — **needs its own decision**

`docker-compose.smoke.yml` is appended to every smoke boot (`smoke-main.ts:284`)
and it sets `RM_ALLOW_INSECURE=1` and `SWARM_SCHEDULES_ENABLED=0`. Production
runs under it, so `RM_ENV=smoke` and no `prod` guard has ever been armed there
(spec §0). Untangling this is not a mechanical change: the static-port
production boot *requires* `SWARM_SCHEDULES_ENABLED=0` (the host driver is the
scheduler — `rollout-procedure.md` §8.2 flag table), so the overlay carries one
setting production needs and one it must never have.

Work to scope, not to schedule here:

- a `docker-compose.external.yml` (or a profile) carrying what an external boot
  needs and nothing a smoke needs — `RM_ENV=prod`, no `RM_ALLOW_INSECURE`, the
  scheduler pin as an explicit, documented production setting;
- `--db external` selects it *instead of* the smoke overlay;
- a test that an `external` composition never renders `RM_ALLOW_INSECURE`;
- `deployment.md` §2 gains the line `stack-runbook-reconciliation.md` §4.5
  asks for: there is no `staging` `RM_ENV`; staging runs `prod`.

Decision required because it changes what production *is*, and every prod-only
fail-closed path (`PROJECTS_SOURCE=live`, token requirements) arms at once.

---

## Phase 6 — Deferred, tracked elsewhere

- **The cutover host builds images.** `up()` → `build()` runs on the production
  API host. `stack-runbook-reconciliation.md` §4.2 (commit-addressed published
  images; `--build-policy prebuilt-remote`) is the answer; it is that plan's
  item, and spec §8 leaves it there.
- **Fresh-external-database bootstrap runbook.** Spec §8; not needed for
  production, which is populated.

---

## Risks and how each phase bounds them

| Risk | Bound by |
|---|---|
| Phase 2 turns a working production redeploy into a refusal because something was pending nobody knew about | `P7.schema-current` (2.1) is run **first** by the runbook and reported by the probe; today's silent pending `0062` would have been exactly this — the refusal is the feature |
| `rm_migrator` password drift, the class `2948e63f` fixed for `rm_readonly` | the provisioning script's `--set-password <role>` is per-role (1.2); `.env.example` names the line; `env-role` resolves it; the migrate tool fails loudly on auth, never silently |
| A migration that needs `CREATEROLE` (like `0062`'s drop) cannot run as `rm_migrator` | correct, and already the design: `0062` documents the two-path split (boot skips with a notice; the provisioning script performs it as the bootstrap login). Migrations that need cluster privileges are provisioning-script work, and the migrate tool's receipt names what it skipped |
| Log tailing (4.1) leaks a secret from a container log into `$RM_BACKUP_DIR` | that directory is already outside the tree and already holds the encrypted dump; the receipt hashes the file and never inlines it; the redaction allow-list for committed receipts is unchanged |
| The twin reshaped without `doadmin` fails to rehearse a migration that genuinely needs the bootstrap login | that is a *finding*, and the rehearsal reports it as such — the same rule policy §4.4 states for privilege-level coverage |

## Definition of done

- A production redeploy (`P7.deploy`) succeeds with **no** migration credential
  in any environment, file, or container on the cutover host.
- `git grep doadmin` outside `scripts/ops/`, `docs/`, and tests returns nothing.
- Every `P7.*` step has a receipt; the probe renders a code-only release's
  `P7.migrate` as skipped-by-evidence.
- A rehearsal with a planted `permission denied` line in any service log exits
  `1` and names it.
