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

v0.5.1's **application** delta is code-only: the feature-bearing migration set
on `releases-0.5.x` is byte-identical to the set `v0.5.0-rc.9` carried
(`0043`–`0061`, verified with `git ls-tree` on both refs). It carries exactly
**one** migration, `0062`, and that migration implements no feature — it is a
repair of the backup gate (§4.1.1). The objective is to ship the v0.5.0
application's correctness fixes without touching its schema:

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

**What this changes about the gates.** There is no earlier work for this
release to do, so preflight asks two things at once: the target must **already**
be at the full v0.5.0 schema, and the only thing pending may be `0062` itself
(`pending-is-this-release-only`). Anything else came from another branch —
`releases-0.6.x` collides with this line at `0056`–`0061` — and a boot would
apply it as a side effect of the deploy. If a migration merges onto this branch
that neither list names, `backend/tests/rollout-steps-0-5-1.test.ts` goes red on
the on-disk comparison, which is the intended tripwire.

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

**The mechanism — this is a CODE defect in `0053`, not an operator error.**
An earlier revision of this section blamed the timing of the operator's run.
That was wrong, and the measured evidence disproves it: the readable/unreadable
split falls *exactly* at migration `0056`, with every sequence from `0055` and
earlier granted and every sequence from `0056` on ungranted. A timing slip
would not produce a boundary on a migration number.

`0053` revokes the default privilege on **both** tables and sequences, then
restores it for tables only:

```sql
ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES    FROM rm_app, rm_worker, rm_readonly;  -- line 103
ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON SEQUENCES FROM rm_app, rm_worker, rm_readonly;  -- line 104
...
ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES TO rm_readonly;                        -- line 118
--                                          ^^^^^^ no SEQUENCES counterpart
```

That asymmetry is the bug. It becomes destructive because **`0053` is applied
twice by design** (`v0-5-0-rollout.md` §4.1.3): the provisioning script applies
it through `psql`, which cannot write `schema_migrations`, so the boot applies
and records it again. It must run out-of-band first because line 37 is
`GRANT rm_owner TO current_user`, and migrations `0054`+ open with
`SET LOCAL ROLE rm_owner` — the membership has to exist before the migration
session starts.

So the real sequence is:

```
script: apply 0053          → sequence default REVOKED
script: GRANT ON ALL SEQUENCES + ALTER DEFAULT ... GRANT ON SEQUENCES
                            → existing sequences granted, default restored
boot:   apply 0053 AGAIN    → sequence default REVOKED a second time  ← the defect
boot:   apply 0054-0061     → twelve new sequences created with no default
```

**The script cannot win.** Any grant it makes between the two applications of
`0053` is erased by the second. `0053`'s "safe by construction" audit is sound
about `CREATE ROLE` (guarded by `IF NOT EXISTS`) and the ownership sweep
(re-runnable, transactional). It simply never considered default privileges,
which are absolute assignments rather than idempotent guards — re-running a
`REVOKE` is not a no-op when something was granted in between.

**The durable fix is one line in `0053`**, mirroring line 118 so the file
converges on the right state however many times it runs:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO rm_readonly;
```

Until that ships, the command below repairs the twelve that already exist.

**⛔ 4.1.2 — THE CIRCULAR DEPENDENCY, and the one manual step that breaks it.**
`0062` fixes this permanently, and `0062` cannot fix it here. The loop:

```
P3.backup   needs pg_dump to run as rm_readonly
            needs SELECT on all sequences
            needs 0062
0062        is applied by migrate.ts at boot
the boot    is P7.cutover
P7.cutover  requires P3.backup   ←  closed loop
```

A migration cannot unblock the backup that gates its own deployment. So
production needs **one manual GRANT, once**, before P3.backup can run.

**This is a pre-step, not a workaround, and it has direct precedent.**
`v0-5-0-rollout.md` §4.1 is exactly this shape: a human-run credential step
that "gates everything below", because `0053` must create `rm_owner` before a
migration session can `SET LOCAL ROLE rm_owner`. A boot cannot bootstrap its
own permissions. This is the same class of problem with the same answer.

**The pre-step is the provisioning script**, which now applies `0062` as well
as `0053`. Run it on the **PRIMARY**, as a login holding `rm_owner` membership
(`doadmin`). The replica is in recovery and cannot be granted on; the change
replicates.

```bash
# The host's OWN $HOME/.env — the single credential file of the #699
# convention, NOT a separate provisioning.env to be written for the occasion.
bash scripts/ops/provision-db-role-taxonomy.sh "$HOME/.env"
```

That file carries the discrete `host`/`port`/`database`/`sslmode` tokens and one
`<role> = <password>` line per role. The bootstrap login is `doadmin`, which is
**not** one of the runtime roles and is normally *absent* from the file — so the
command prompts once for it and never stores it. Add a `doadmin = …` line only
on a host that must run this unattended (`.env.example` documents both). Pass
`--role <login>` if the bootstrap login is not `doadmin`.

A `.env` holding `MIGRATE_DATABASE_URL` still works; it is the pre-#699 shape,
and if its password is embedded in the URL it is visible in `ps` for the life of
the run. The command says so when that happens.

⚠ **Do not pass `--set-passwords`.** Without it the command changes no
password and creates no account, so it is safe to re-run — which matters,
because `0053`'s chicken-and-egg means this script gets run for reasons that
have nothing to do with credentials. `--set-passwords` rotates `rm_app`,
`rm_worker` and `rm_readonly`, and every host holding those credentials then
stops authenticating until its `$HOME/.env` is updated by hand. Only a
brand-new cluster needs it. See §4.1.3.

It applies `0062` through `psql`, which does not write `schema_migrations`, so
the boot still applies and records it — expect `0062` in the migration log
even though you ran it here. That is `0053`'s behaviour too
(`v0-5-0-rollout.md` §4.1.3), and it is safe for the same reason: every
statement in the file is idempotent.

**Two of `0062`'s three statements only work on this path.** The
`rm_readonly_test` drop needs `CREATEROLE`; `rm_owner` is `NOCREATEROLE` and
`migrate.ts` runs every migration from `0054` on as `rm_owner`, so at boot the
drop is skipped with a notice. The script runs as the bootstrap login and
performs it. Postflight's `test-role-removed` check is what distinguishes
"`0062` is recorded" from "the role is gone".

Confirm the grant took, against the replica:

```bash
# expect: 0
psql "$REPLICA_READONLY_URL" -tAc "
  WITH s AS MATERIALIZED (
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S')
  SELECT count(*) FROM s WHERE NOT has_sequence_privilege('rm_readonly', oid, 'SELECT')"
```

Then `bun run smoke:capture` succeeds and §4.2 proceeds normally.

**`0062` still ships, and is still worth shipping.** After the script has run
it is very nearly a no-op on production — which is the point. It means no
other environment — a fresh database, a restored twin, a new staging host —
ever needs this pre-step at all. The script repairs one database; `0062`
repairs the class.

**4.1.3 — ⚠ The credential drift this release traced, and why it recurred.**
Two staging hosts failed `smoke:capture` with
`password authentication failed for user "rm_readonly"` while both held a
`rm_readonly` line that someone had recently written. There is no second
account and no duplicate username — the failing value simply authenticates as
no role on the cluster.

It was the provisioning script. It used to end with three **unconditional**
`\password` prompts, so every run rotated `rm_app`, `rm_worker` and
`rm_readonly`, and propagation was a sentence in its closing message asking the
operator to hand-copy the new values into each host's `$HOME/.env`. The run on
2026-09-21 at 01:55Z rotated `rm_readonly`; a host `.env` written at 00:14Z
kept the August value; nothing reconciled them.

The trap was that this script **must** be re-run for reasons unrelated to
passwords. So a routine, correct re-provision broke every host's backup, and
the only symptom surfaced at the next release's first gate.

Provisioning roles is idempotent and safe to repeat. Rotating passwords is
neither. They are no longer the same command, and
`scripts/tests/unit/provision-roles-no-rotation.test.ts` pins that — a comment
saying "do not rotate" would not have survived this, a test does.

**Preflight grades this correctly rather than refusing.**
`readonly-sequence-access` is a **WARN** while the sequences are unreadable and
`0062` is still pending, because that is the condition the release exists to
repair — failing preflight on it would refuse to deploy the fix. It becomes a
**FAIL** only once `0062` is recorded and sequences are still unreadable, which
would mean the repair did not take. Postflight asserts the count is zero.

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

**5.2 The four functional acceptance criteria.**

⛔ **These are the release.** v0.5.1 changes no schema, so every schema check is
necessarily green before it does anything; what it actually claims is
behavioural, and none of it is a fact about a row's existence. They run inside
the rehearsal's graded postflight
(`backend/scripts/upgrades/0.5.0-to-0.5.1/functional-rehearsal.ts`), against the
live twin, and they gate the `P5.rehearsal` receipt.

| # | Criterion | Check | Passes when |
| --- | --- | --- | --- |
| **(a)** | Wedged sessions **and schedulers** self-healed | `a-self-healed` | No session is past its close time and still open, no enabled schedule is >30m overdue, and no job is stuck pending past its `run_after` |
| **(b)** | Sessions that expired or failed are **closed** | `b-expired-sessions-closed` | Every session past `window_closes_at` is `published` or `cancelled` |
| **(c)** | New sessions **opened** | `c-new-sessions-opened` | At least one session convened after the twin's postmaster started |
| **(d)** | A full session **submitted by proposers and judged** | `d-full-session-judged` | A session convened this boot has verified takes **and** a judgement naming its judge |

**There is no grace period on (a)/(b), deliberately.** An earlier draft allowed
a session 30 minutes past `window_closes_at` before counting it wedged, on the
reasoning that the publish lane takes a few minutes. That reasoning smuggles the
defect in: a grace period makes "closed late" indistinguishable from "never
closed", and a wedge is precisely a session that is late forever. The window is
the prescribed time — the system chose that timestamp itself — so the assertion
is that every session past it is closed, compared against `now()` with nothing
added. What absorbs a genuinely in-flight publish is the **observation window**,
not the assertion: the check re-evaluates every 30s for up to 30 minutes, so a
session mid-publish only has to finish.

**The restored/new boundary is `pg_postmaster_start_time()`.** The twin's
Postgres is created fresh per run and the dump restored into it, so every
production row predates the postmaster and every row the rehearsal produced
follows it. That needs no snapshot taken at the right instant and is not fooled
by the driver having already driven the product — it runs `verify-live --tier
full` before this hook, and those rows are correctly counted as new.

**Criterion (c) exercises the steady-state loop, not cron.**
`docker-compose.smoke.yml` pins `SWARM_SCHEDULES_ENABLED=0`, so the `swarm.*`
schedules do not fire in a smoke boot. New sessions come from the steady-state
session loop, which does run. Do not read a passing (c) as proof the cron
schedules are healthy; that is what (a)'s schedule-staleness half covers.

⚠ **The criteria are proven to discriminate.** `backend/tests/rehearsal-functional-0-5-1.test.ts`
establishes the RED before the GREEN for each one, against a real database —
including a session **one minute** past its window, the case the old grace
period would have graded healthy. A criterion that passed on an empty result
set would turn the whole rehearsal into theatre (`rollout-procedure.md` §9.1).

**5.3 Stage rehearsal report.** Per `rollout-procedure.md` §6.5, saved beside
the backup artifacts as `stage-rehearsal-report-<STAMP>.md`. It must record:

1. `restore-check.ts` exit code, against a dump captured on or after 2026-09-21.
2. Time to readiness, and the `/health` verdict.
3. `smoke-frontend-check.ts` verdict against the published port.
4. A result for **every** record the graded run emits — the schema checks, the
   four criteria above, and the closed-day price check — since they now share
   one verdict and one receipt.
5. The boot's `swarm now N seats` line against the restored active-member count
   (`twin-roster:every-active-member-seated`), with the rc.9 bypass gone.
6. Zero containers, volumes or processes surviving teardown (G6).
7. **GO / NO-GO**, with reason, and operator sign-off.

## 6. Production cutover

> **This release cuts over on the pre-D46 mechanic:** one command
> (`rollout-procedure.md` §8.2) that migrates, seeds and boots, with the
> operator capturing `BOOT_STATUS` by hand. D46
> (`docs/technical/upgrade-deployment-spec.md`) replaces it with receipted
> `P7.*` steps and retires `doadmin` as the migration login; per policy §4.6 that
> lands on the release line after this one, not here. Two things it changes are
> already true for this cutover and worth knowing: no runtime service declares
> `MIGRATE_DATABASE_URL` any more (`de5efffa`), and the provisioning script
> verifies the taxonomy end-state and passes the credential to `psql` without
> putting it in `argv` (`2948e63f`, `30688688`).

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
| *(rehearsal only)* | criteria (a)-(d) above run against the twin, not production: (c) and (d) DRIVE the product, and `--tier full` behaviour belongs on a twin and nowhere else (`rollout-procedure.md` T2a) |
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
