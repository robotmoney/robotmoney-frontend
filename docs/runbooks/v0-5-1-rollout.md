# v0.5.1 production rollout

> Operator procedure for upgrading production from **v0.5.0** to **v0.5.1**.
> **No RC is cut yet on this branch.** The candidate is whatever `v0.5.1-rc.*`
> tag is next cut on `releases-0.5.x`; record its tag and SHA here when it
> exists. This document is not authority for a moving branch.
>
> **The RC tag is cut at §5.1, after stage preflight and rehearsal both
> pass — not before them** (`release-runbooks.md` §3, revised 2026-09-11). A
> rejected stage pass therefore consumes no rc number.

This runbook implements the foundational policy in
[`docs/technical/release-runbooks.md`](../technical/release-runbooks.md) and
the shared mechanics in [`rollout-procedure.md`](./rollout-procedure.md).

## 0. The baseline this release assumes, and its verification

**v0.5.1 is a patch on top of v0.5.0, and v0.5.0 reached production on
2026-09-21.** Verified directly against the read-only replica
(`rm_readonly@db-rm-prod-slave-readonly-…:25060/defaultdb`, `pg_is_in_recovery
= true`) on 2026-09-21:

| | Expected by this runbook | Production, verified 2026-09-21 |
| --- | --- | --- |
| Migration ledger | `0039`–`0061` recorded | **`0039`–`0061` recorded** ✅ |
| `rm_owner` | present, NOLOGIN, NOSUPERUSER | **present, NOLOGIN, NOSUPERUSER** ✅ |
| `rm_app` / `rm_worker` / `rm_readonly` | present, LOGIN, NOSUPERUSER | **all present, LOGIN, NOSUPERUSER** ✅ |
| `rm_owner` membership | a LOGIN role holds it; neither runtime role does | **`doadmin` holds it** ✅ |

The ledger shows the rollout in two distinct boots, which is worth recording
because it is the only evidence of *how* production got here:

```
0045-0048   2026-09-08T14:43:24Z   an ordinary deploy, not a rollout
0049-0052   2026-09-21T01:54:23Z   the v0.5.0 cutover
0053        2026-09-21T01:55:03Z   the role taxonomy (40s later — the §4.1 pre-step)
0054-0061   2026-09-21T01:55:22Z   the remainder, once rm_owner existed
```

**This corrects `v0-5-0-rollout.md`'s standing note**, which says production is
at `0048` with `rm_owner` and `rm_app` "ABSENT from `pg_roles` at all". That
was true when it was written on 2026-09-18 and stopped being true three days
later. Do not carry that note forward into this release's decisions — re-read
the live ledger, as §4.4's preflight does, rather than trusting either
document's prose.

**One observation, not a blocker.** `pg_auth_members` lists `doadmin` as a
member of `rm_owner` **twice**, which is what a migration-side grant plus a
provisioning-script grant produces. It is harmless — membership is a set, not
a count — and `preflight.ts`'s `role-readiness` record passes on it, since the
property it asserts is "at least one LOGIN role holds the membership, and
neither runtime role does". Noted here so the duplicate is not mistaken for
drift on a later read.

## 1. Release identity and objective

v0.5.1 is the repository's **first code-only release**. It carries **no
migration file**: the migration set on `releases-0.5.x` is byte-identical to
the set `v0.5.0-rc.9` carried (`0043`–`0061`, verified with `git ls-tree` on
both refs). The objective is to ship the v0.5.0 application's correctness
fixes without touching its schema:

- stop swarm sessions wedging in a non-terminal state across the session
  lifecycle (`ebbfc0bb`, `f2c21a56`);
- make the publish wait survive the lane by waiting on the `swarm.judge` job's
  own row rather than a wall clock (`f2c21a56`);
- bound the API connection-pool timeouts that produced 502s under load;
- restore the prod-bootstrap step and the judge weights bypass (`3941883c`,
  `c0392fc1`, `bdd4811b`);
- drop `WORKER_DATABASE_URL` from `DEMO_COMPOSE_PASSTHROUGH` so a demo stack
  cannot inherit a worker credential (`ffa431b6`);
- bind `Bun.serve` to `127.0.0.1` so CI's IPv6 resolution cannot pick a
  different interface than the checks do (`8052db12`).

The release-specific tools are in `backend/scripts/upgrades/0.5.0-to-0.5.1/`.

**What "code-only" changes about the gates.** Every prior release's preflight
proved *the pending migration set is exactly what this release ships, and none
of it has landed yet*. There is no pending set here, so the same question
inverts: the target must **already** be at the full v0.5.0 schema, and the
ledger must have **nothing left to apply**. A pending migration is drift by
definition — see `preflight.ts`'s `no-pending-migrations` record. If a
migration ever merges onto this branch, `backend/tests/rollout-steps-0-5-1.test.ts`
goes red on the on-disk comparison, which is the intended tripwire.

## 2. Code delta: systems upgraded and risks

| Code | System affected | What changes in production | Primary risk | Mitigation |
| --- | --- | --- | --- | --- |
| `scripts/lib/swarm/session.ts`, `scripts/lib/swarm/inference.ts` | Swarm session lifecycle | A session's publish step waits on the `swarm.judge` job row reaching a terminal state instead of a fixed wall-clock budget; the publish lane survives a slow judge | A wait that never terminates replaces a wait that terminated too early — a wedge of a different shape | Postflight's `no-wedged-sessions` names the symptom directly: any session convened in the last 24h whose window closed 2h+ ago and is still non-terminal is a FAIL |
| `backend/src/db/*` pool configuration | API | Connection-pool acquire timeouts are bounded, so a saturated pool returns an error rather than hanging the request | A timeout set too low converts load into 502s instead of latency | `verify:live --tier readonly` (P8.verify-prod) exercises the real routes after cutover |
| `scripts/lib/verify/legs/twin-roster.ts` | Verification | The twin-roster leg is restored and correct — `646446c4` removed the rehearsal bypass `v0.5.0-rc.9` carried as a local commit | A bypassed leg silently stops asserting every active member is seated | The bypass is gone on this branch; `twin-roster:every-active-member-seated` runs for real in the rehearsal |
| `scripts/lib/smoke-compose-env.ts` | Demo/smoke stacks | `WORKER_DATABASE_URL` is dropped from `DEMO_COMPOSE_PASSTHROUGH` | A demo stack that depended on inheriting it fails to boot rather than borrowing a worker credential | Failing closed is the intent |
| `frontend/**`, `scripts/prerender.ts` | Static frontend | Rebuilt from this checkout | A stale asset bundle | `smoke-frontend-check.ts` runs against the booted stack in §5 |

Systems **not** upgraded by this release:

- **the database schema, in any respect.** No migration, no column, no index,
  no grant, no role. This is the release's defining property, asserted by
  `preflight.ts`'s `code-only` record and by the manifest test;
- the v0.4.0 judge/receipt tables and invariants;
- `analytics_read_mode` — v0.5.1 ships no cutover and does not flip it.
  Postflight records the mode it finds rather than requiring one, because
  flipping it is a supported operator action (v0.5.0 runbook §6.1).

## 3. Preconditions and release candidate

```bash
git fetch origin --tags
git switch releases-0.5.x
git rev-parse HEAD
git tag --points-at HEAD -l 'v0.5.1-rc.*'   # expected: prints nothing yet
bun install --force
bun install --force --cwd backend
```

Record the SHA as `RC_SHA`. **Do not tag it yet** — the tag is cut at §5.1,
after the stage gates pass, and it must be on `releases-0.5.x`, never `main`.

The forced installs are a blocking prerequisite, not hygiene: Bun copies the
local `@robotmoney/contract` file dependency rather than symlinking it, so a
checkout that moved past a contract change runs old route definitions with no
import error. Postflight's `contract-freshness` record is the check for this.

## 4. Baseline, backup, and live preflight

Run these on the **staging host** (`rollout-procedure.md` §2). Credentials come
from **`$HOME/.env`** — the single credential file for the whole gate family
(`scripts/lib/env-role.ts`). There is no repo-root `.env` and no
`.env.readonly`; the checkout carries only `.env.example`.

**4.1 — Role/credential cutover.** Nothing to do *for this release*: v0.5.1
adds no role and applies no migration, so it needs no `rm_owner` membership of
its own. But it **boots** on v0.5.0's taxonomy — `config.ts:710` refuses a
`doadmin` `DATABASE_URL` in production and `worker-client.ts:20` hard-requires
`WORKER_DATABASE_URL` — so the taxonomy must already exist. §4.4's
`role-readiness` record is the read-only proof, and §0 records it passing
against production on 2026-09-21.

**4.1.1 — ⛔ KNOWN BLOCKER: twelve sequences are unreadable by `rm_readonly`,
and it breaks §4.2's backup before it starts.** Found 2026-09-21 by running
`bun run smoke:capture` against the live replica:

```
pg_dump: error: failed to get data for sequence "analytics_data_vintages_id_seq";
         user may lack SELECT privilege on the sequence
```

The message's second clause ("or the sequence may have been concurrently
dropped") is a red herring; the first is exact. Twelve of production's forty
`public` sequences deny `rm_readonly` a read:

```
analytics_data_vintages_id_seq                analytics_parity_observations_id_seq
analytics_ledger_methodology_versions_id_seq  analytics_report_snapshots_id_seq
analytics_ledger_run_events_id_seq            analytics_vintage_members_id_seq
analytics_ledger_runs_id_seq                  source_acquisition_events_id_seq
analytics_output_snapshots_id_seq             source_value_versions_id_seq
analytics_overwrite_events_id_seq             swarm_brief_revisions_id_seq
```

All twelve are owned by `rm_owner` and created by migrations `0056`–`0060`.

**The mechanism, because it will recur otherwise.** `0053` revokes ALL on
sequences from `rm_readonly`, and restoring the read is deliberately *not* a
migration — it is `scripts/ops/provision-db-role-taxonomy.sh`'s job, which
issues two statements: a `GRANT SELECT ON ALL SEQUENCES` (retroactive, covers
what exists *now*) and an `ALTER DEFAULT PRIVILEGES` (prospective, covers what
`rm_owner` creates *later*). Neither one covers a sequence created in the
window **between** them and the migration boot. That is exactly what happened
on 2026-09-21: `0053` applied at 01:55:03, the operator was still in the
script's `\password` prompts, and the boot applied `0054`–`0061` at
01:55:22–01:55:36, creating twelve sequences the retroactive grant had already
passed over.

Contrast the ACLs — `jobs_id_seq` predates the grant and carries it,
`analytics_data_vintages_id_seq` does not:

```
jobs_id_seq                     {rm_owner=rwU/rm_owner,rm_app=rU/rm_owner,rm_readonly=r/rm_owner,rm_worker=rU/rm_owner}
analytics_data_vintages_id_seq  {rm_owner=rwU/rm_owner,rm_app=rU/rm_owner}
```

**The symptom is silent until the NEXT release.** Nothing at runtime reads
those sequences as `rm_readonly`; the only consumer is `pg_dump`. So a release
that provisions roles this way looks completely healthy and breaks the backup
gate of the release that follows it — which is precisely where v0.5.1 found it.

**Remediation — one command, on the PRIMARY, as a login holding `rm_owner`
membership (`doadmin`).** It is idempotent and grants no write:

```bash
psql -X -v ON_ERROR_STOP=1 "$PRIMARY_ADMIN_URL" \
  -c "GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_readonly" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO rm_readonly"
```

Run it on the **primary** — the replica is in recovery and cannot be granted
on; the change replicates. Then re-run `bun run smoke:capture` and confirm it
reaches `dumping … -> rm-preupgrade-<STAMP>.dump`.

**The lasting fix, for `release-runbooks.md` §4 rather than this release.**
`provision-db-role-taxonomy.sh`'s retroactive `GRANT ... ON ALL SEQUENCES`
must be re-run **after the final migration boot**, not only before it. A
prospective `ALTER DEFAULT PRIVILEGES` alone cannot close a window that opens
behind it. Until the script does that itself, the two-statement command above
is a required post-cutover step for any release that adds a sequence.

**4.2 — Backup, restore proof, and baseline.**

```bash
bun run smoke:capture                                        # P3.backup
export RM_BACKUP_DIR=$HOME/rm-backup-v022
bun backend/scripts/upgrades/0.5.0-to-0.5.1/restore-check.ts $RM_BACKUP_DIR --emit-receipt   # P3.gate-c
```

Gate C grades the **dump**, not the live role cutover: the twin restores only
`rm_readonly`/`rm_worker` from the globals dump and would migrate as a
container superuser anyway, so `restore-check.ts` runs `runChecks()` *without*
the role-readiness record.

**A dump taken from a database that has not completed the v0.5.0 rollout fails
this gate, correctly** — it is the wrong baseline for this release, not a bad
backup. Since 2026-09-21 a production dump is no longer such a database, so
this gate is expected to pass; a dump captured **before** that date still
fails it, and that is the right answer for a stale artifact.

**4.3 — Baseline.** Record a read-only row-count baseline beside the dump, per
`rollout-procedure.md` §5.4 — including the swarm schedule rows, which no
restore returns.

**4.4 — Live preflight.**

```bash
bun backend/scripts/upgrades/0.5.0-to-0.5.1/preflight.ts --emit-receipt       # P4.preflight-live
```

Five records, all read-only:

| Record | Passes when |
| --- | --- |
| `role-readiness` | the four taxonomy roles exist with `0053`'s attributes, a LOGIN role holds `rm_owner` membership, neither runtime role does, and `rm_worker` holds `0054`'s allow-list grants |
| `v0.5-schema` | all 24 v0.4.0+v0.5.0 migrations are recorded |
| `no-pending-migrations` | nothing on disk is unapplied, and nothing recorded is absent from the checkout |
| `code-only` | `RELEASE_MIGRATIONS` is empty |
| `v0.4-runtime-schema` / `v0.5-tables-present` | the v0.4.0 runtime tables and all 19 v0.5.0 tables exist |

## 5. Digital smoke-twin rehearsal

⛔ **Blocking gate** (`rollout-procedure.md` §6, §6.4). Do not proceed to §6
until this exits `0` and every acceptance criterion in §5.2 is met.

```bash
cd <checkout>
bun backend/scripts/upgrades/0.5.0-to-0.5.1/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt
```

💳 **This spends real inference credit, on purpose.** `OPENCODE_API_KEY` must
be set in `$HOME/.env`. **Do not set `AGENT_MODEL`** — the model must resolve
to `DEFAULT_AGENT_MODEL`, the one production runs. A green `free` run does not
predict a production boot (`rollout-procedure.md` §6), and because Compose
auto-loads a repo-root `.env`, a stray `AGENT_MODEL=free` there silently
downgrades the rehearsal while still reporting exit `0`. There must be no
repo-root `.env`.

**What this rehearsal is actually for.** v0.5.1 applies no migration, so the
usual headline — "the migration ran for real against production-shaped data" —
is not the point. The point is the half `restore-check.ts` can never cover:
that *this code* boots against production-shaped rows and serves them. The
v0.5.1 delta is session lifecycle, pool timeouts and the judge-job wait, which
are exactly the failures a static schema check cannot see.

**Note on the twin's ledger.** A dump captured on or after 2026-09-21 already
carries `0049`–`0061`, so the boot finds nothing pending and the ledger does
not move — the code-only case, rehearsed exactly as production will see it. A
dump captured **earlier** restores a pre-v0.5.0 database, and the boot then
legitimately applies the outstanding migrations, growing the ledger mid-run;
that is expected too, but it rehearses the v0.5.0 cutover rather than this
release. Prefer a fresh dump. What must never appear — on the twin or in production — is a migration this checkout does
not carry; `releases-0.6.x` collides with this line at `0056`–`0061`, and
postflight's `no-release-migrations` record is the check for exactly that.

**5.1 Cut the RC tag.** Only once §4.4 and §5 have both passed:

```bash
git tag -a v0.5.1-rc.0 -m "v0.5.1 release candidate 0" $RC_SHA
git push origin v0.5.1-rc.0
```

**5.2 Stage rehearsal report.** Per `rollout-procedure.md` §6.5, saved beside
the backup artifacts as `stage-rehearsal-report-<STAMP>.md`. Acceptance
criteria for this release:

1. `restore-check.ts` exits `0` against a dump captured on or after 2026-09-21.
2. The stack reaches readiness and `/health` answers `200`.
3. `smoke-frontend-check.ts` passes against the published port.
4. Postflight's nine records are all PASS against the migrated twin.
5. `no-wedged-sessions` is PASS — the release's own objective.
6. The closed-day allocation total is unchanged across the D41 read path.
7. The boot's `swarm now N seats` line equals the restored active-member count
   (`twin-roster:every-active-member-seated`), with the rc.9 bypass gone.
8. The migration ledger after the run contains no migration this checkout lacks.
9. Zero containers, volumes or processes survive teardown (G6).

## 6. Production cutover

Mechanics are release-independent — `rollout-procedure.md` §7 (config), §8
(stop/start), §9 (verification). v0.5.1 adds nothing to them and removes
nothing.

**The one thing that is different, and it is a simplification:** there is no
migration to apply, so there is no `MIGRATE_DATABASE_URL` run and no
`SET LOCAL ROLE rm_owner` in the cutover path. The boot's `migrate.ts` finds
nothing pending and proceeds straight to `seed()`. Rollback is correspondingly
cheaper: see §8.

## 7. Production postflight

```bash
bun backend/scripts/upgrades/0.5.0-to-0.5.1/postflight.ts --emit-receipt=P8.postflight-prod
bun run verify:live --tier readonly --emit-receipt=P8.verify-prod
```

| Check | Asserts |
| --- | --- |
| `schema-preserved` | all 24 v0.4.0+v0.5.0 migrations remain recorded |
| `no-release-migrations` | v0.5.1 added none, and none this checkout lacks is recorded |
| `runtime-schema` | the v0.4.0 judge/receipt tables are present |
| `v0.5-tables-preserved` | all 19 v0.5.0 tables are present |
| `asset-prices-seeded` | `asset_prices` is non-empty |
| `subject-name-backfill` | no session's `subject_name` has drifted from its subject |
| `third-party-judging-off` | `swarm_judge_config.third_party_enabled` is `false` |
| `analytics-read-mode` | the `analytics_read_mode` row exists (mode recorded, not required) |
| `no-wedged-sessions` | no recent session is stuck non-terminal — **the release's objective** |
| `contract-freshness` | the installed `@robotmoney/contract` matches the checkout |

**7.1 — `--tier readonly` is not optional.** `--tier full` publishes sessions,
spends inference and sends mail; it belongs on the twin and nowhere else
(`rollout-procedure.md` T2a). Against production it would manufacture the very
history the readonly legs exist to audit.

## 8. Rollback and completion

Rollback for a code-only release is redeploying the previous tag. **No schema
change means no data loss window and no restore** — which is the one genuine
operational advantage this release has over every prior one, and the reason
its rollback section is three lines instead of `rollout-procedure.md` §10's
full procedure. That section still governs the stack stop/start mechanics and
its "what rollback does NOT undo" warnings still apply to anything the new
code wrote while it was live.

Triggers, and everything rollback does not undo: `rollout-procedure.md` §10.
