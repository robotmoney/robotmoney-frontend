# Release process — runbook policy

> **Status: in effect.** This is the one prose document for releases. It holds the rules. The
> steps are YAML: the general runbook templates in `scripts/release/runbooks/templates/`, and each
> release's own add-only copy in `scripts/release/runbooks/releases/` (§5). The runner,
> `bun run release:run`, executes a release's YAML. Older per-release Markdown runbooks were
> removed on 2026-10-14; recover one from Git (`git show v0.6.1:docs/runbooks/v0-6-1-rollout.md`)
> only when an audit needs the exact record.
>
> **Contents:** [1. Scope](#1-scope-and-authority) ·
> [2. Branches](#2-branches) · [3. Tags](#3-release-candidates-and-version-tags) ·
> [4. Workflow](#4-the-release-workflow) · [5. Runbooks](#5-runbooks-are-yaml) ·
> [6. Tracking issue](#6-the-tracking-issue) · [7. Backporting](#7-backporting) ·
> [8. Compatibility](#8-compatibility-contract) · [9. Standing checks](#9-standing-check-ids) ·
> [10. Standing invariants](#10-the-standing-invariants-sw2) ·
> [11. Analyst SDK releases](#11-analyst-sdk-releases)

This is not the process for ordinary feature work, which is PR review against `main`
([CONTRIBUTING.md](../../CONTRIBUTING.md)). It covers packaging a release, rehearsing it on stage
and cutting it over in production.

## 1. Scope and authority

[Smoke production spec](./smoke-production-spec.md) owns deployment, migration, target identity and
schema-preflight mechanics (D47). Production has booted with `bun smoke --static-port` since
v0.6.0. This document owns the release gates, phases, evidence and approval.

**Agent-executed, end to end ([D61](../decisions.md#d61), owner 2026-10-08).**

1. No human in the loop. An agent executes every step. The operator's authority is one recorded go
   given before the run.
2. Production runs what stage passed, unmodified: the same runner and the same step list, with only
   the target file different.
3. Every database operation is a committed script with a receipt. No step runs `psql` by hand.
4. Everything runs from the control machine over SSH. No step asks a person to log in to a host.

**The website never goes down (owner, 2026-10-14).** Every release, on stage and on production, is a
rolling upgrade (§4.7). No step stops the whole stack. No tmux session drives or holds any process.

**Every production data change ships as a migration** ([D66](../decisions.md#d66), owner
2026-10-09). No admin-route write, no SQL by hand, no one-off script. C05-migrate is the one step that
writes production data.

A check with no tool is a `gap`. A gap blocks the release until it is built or the owner records an
exception in the release's YAML (§5).

## 2. Branches

Each release line ships from `releases-A.B.x` (literal `releases`, the integer major and minor, a
literal `x`). Example: `releases-0.6.x`. Feature PRs never target it.

The release branch takes changes by two routes only ([D70](../decisions.md#d70), owner 2026-10-14):

- **(a) Scope.** Before a QA session starts, the release's scope reaches `releases-A.B.x` from `main`
  by merge or cherry-pick.
- **(b) The stage-passed QA branch.** After the runbook passes on stage at a commit of
  `qa/A.B.x-<YYYY-MM-DD>`, that branch is squash-merged onto `releases-A.B.x`. The squash commit's
  tree must equal the tree stage passed.

No commit lands on the release branch during a QA session. Session fixes reach `main` afterwards by
a separate PR from the QA branch (§7). A release branch is force-pushed only on an explicit owner
instruction, after `archive/releases-A.B.x-<YYYY-MM-DD>` is pushed. Tags land on the release
branch, never on `main` or a QA branch.

**QA branches (owner, 2026-10-06 and 2026-10-07).** A QA session cuts one
`qa/A.B.x-<YYYY-MM-DD>` branch from the release branch tip and pushes it. Every patch of the
session, runbook corrections included, merges there by PR. A pushed QA branch is never rewritten:
no force push, reset or rebase. A new base means a new branch, `qa/A.B.x-<YYYY-MM-DD>-2`, and the
session report names which branch each piece of evidence ran on. Every CI workflow runs on a push
to `qa/**`, so the commit stage runs carries its own green CI (SP.7).

## 3. Release candidates and version tags

An rc tag `vA.B.C-rc.N` (`N` from 0) names a commit whose tree passed stage. A version tag
`vA.B.C` names what production was cut over to. Production runs only by an rc tag.

The cycle (D70):

1. **Stage runs on a QA branch.** Stage runs a clean, pushed QA commit, never a PR head or a fix
   branch. Fixes merge into the QA branch, and stage reruns on its new tip. A stage failure
   consumes no rc number.
2. **Refresh the lockfiles.** Every rc carries a freshly resolved lockfile (owner, 2026-10-14): run
   `bun scripts/release/lockfile.ts refresh` on the QA branch and commit the result before the
   stage run. QA step Q01-lockfile refuses a commit whose lockfiles differ from a fresh resolve.
   Hosts install with `--frozen-lockfile`.
3. **The runbook passes on stage.** Record the commit and its tree hash.
4. **Squash the QA branch onto the release branch.** The release branch must not have moved since
   the QA branch was cut, and the squash tree must equal the stage-passed tree.
5. **Cut `vA.B.C-rc.N` at the squash commit** with
   `bun scripts/release/tag.ts rc --release vA.B.C --commit <squash> --stage-journal <passed stage run>`.
   It refuses a commit whose tree is not the stage run's tree, and pushes the tag.
6. **Production runs only by that rc tag.** SP.8 refuses a tag whose tree differs from the
   stage-passed tree.
7. **A failure before the cutover** (any preflight step, or C01-backup to C04-probe-start) means the
   rc never reaches production. Fix it on a new QA branch, rerun stage, squash again and cut
   `vA.B.C-rc.(N+1)`.
8. **The cutover starts (C05-migrate)** → step C06-version-tag tags `vA.B.C` at the rc's commit at once. A later failed
   check, a known defect or a rollback never withholds or moves it. Every defect found after the
   cutover is an issue against `vA.B.(C+1)`, whose first rc is `vA.B.(C+1)-rc.0`.

Consequences, stated because each looks like a mistake and none is:

- `vA.B.C` and the final `vA.B.C-rc.N` point at the same commit.
- Stage and production run different commits with the same tree. `/api/version` reports each
  target's own commit; the tree hash ties them together.
- An rc number counts production attempts stopped before the cutover. Five stage attempts and a
  clean first production attempt is `rc.0`.

## 4. The release workflow

Each gate blocks. A failed gate stops the release until it passes or the owner records an
exception in the release's YAML.

**Three phases (owner, 2026-10-15).** Every step of a runbook belongs to one phase, its id names it,
and the phases run in this order:

| Phase | Ids | Where and when | What it does |
|---|---|---|---|
| **QA** | `Q01`… | Stage only, as often as needed, on a QA branch commit | Checks the lockfile, picks or captures the dump, builds the stage target, sets its role passwords. A stage run then runs the preflight and cutover steps exactly as production does |
| **Preflight** | `P01`… | Production, once per rc, at most 60 minutes before the cutover (`--preflight`) | Read-only gates: checkouts and installs at the rc, host identity, `~/.env` keys and the rm_owner login, the ledger and its pending set, the log baseline. Nothing a running service uses changes |
| **Cutover** | `C01`… | Production, once (`--after-preflight`) | The release as it happens: backup and restore proof, the rolling upgrade, the site switch, the probe's grade |
| **Soak** | `S01`… | Every release, on stage (QA) and on production | The general checks: identity, product (readonly tier), logs, the baseline comparison, host guards, then 30 minutes after READY the log gate and the standing invariants (no crashed container, no pipeline errors), then every container's log |
| **Version** | `V01`… | Every release, on stage (QA) and on production, after the soak | The release's own checks, one per change it ships: a feature landed, a bug is fixed, a feature retired. Only a release runbook adds them; a template has none. A check that must write runs on stage only |

A stage run is QA: it builds stage, then runs the preflight, cutover, soak and version steps exactly
as production will, so production's checks have passed on stage before production runs them. Stage has
no separate preflight: the stage pass earns the rc, and nothing reruns on stage for it.
Production's cutover refuses without a green preflight of the same rc and step list from the last
60 minutes, and carries the preflight steps' records instead of running them again. Preflights are
cheap: run a new one rather than stretch an old one.

### 4.1. Code readiness

Every Phase and feature issue linked from the tracking issue's Phases tasklist is closed, and the
objective is stated (§6). Every commit expected to ship is on the release branch by §2 route (a).
The tracking issue itself stays open until §4.9.

### 4.2. Preflight

`bun run release:run --target prod --preflight --go <go>` checks, on the control machine, the rc
tag, CI on its commit (`P.ci`), a passed stage run of the same tree and step list (`P.stage`), the
recovery decision (`P.recovery`) and that no run is in flight. It then runs the preflight steps on
the hosts. P01-checkout to P06-capture-install put the release and capture checkouts at the rc and
install them frozen. P02-identity proves the host, `~/.env` and the rm_owner login. P07-baseline
records production's state through `rm_readonly`: the ledger and its reconciliation with
`backend/migrations` ([D67](../decisions.md#d67)), identity, roles, row counts, the sessions in
flight and the database size. It refuses any pending migration that is not `compat: additive`
(§4.7). P08-log-baseline grades the running stack's logs; each finding there is triaged by the
owner (`--triage <file>`).

### 4.3. Backup, restore proof and dumps

C01-backup captures production's backup new, from the read replica, as the cutover's first step.
C03-restore-proof restores it into a throwaway container and records the restore time, before the
first irreversible step (C05-migrate).

**Stage's starting dump (owner, 2026-10-08; SR.0).** Unless the operator names a dump, stage starts
from the newest production dump already on the capture host if it is at most 24 hours old
(`manifest.json` `capturedAt`), else a new capture (`bun smoke:capture --out <new directory>`).
Step Q02-dump does this; step Q03-stage-up restores the dump it left. Never restore a dump older
than 24 hours. Never point rehearsal preparation at the production database.

### 4.4. Stage QA

QA runs the release's YAML unmodified against the production-shaped stage target
([stage-target.md](../runbooks/stage-target.md)), as one run:

```bash
bun run release:run --target stage --go <stage go>
```

Q01-lockfile to Q04-role-passwords build the target (`onlyFor: stage`; production records them
skipped, and the step-list hash is the same for both, SP.8). Q04-role-passwords sets the role
passwords through the stage database: its doadmin is a disposable stage credential, passed on a
pipe and stored in no file, so the D61 rule on doadmin, which is production's, is kept. The
preflight and cutover steps then run as production runs them. A failed step resumes with
`--run <ts> --from <step>`. QA runs as many times as the fixes need.

Checks that need a seated roster and short epochs run on a twin (`--local dump`, spoofed keys,
`bun run twin:accelerate`, `bun run twin:gate`). Tear the stage stack down once the run passes: it
spends inference credits.

### 4.5. Stage report

The report names the QA commit and tree, the dump identity, the step-list hash, the receipts, the
results, what could not be covered, and the go/no-go. Reference generated artifacts instead of
restating their values.

### 4.6. Fix loop

A fix is developed in a development worktree, never on a host. A host runs a clean checkout of a
pushed commit (`git status --porcelain` empty). Fix on the QA branch (§2), redeploy its tip to
stage, and rerun. The same loop applies when an rc fails in production before the cutover (§3
step 7).

### 4.7. Production execution: a rolling upgrade

The owner writes the go once a stage run of the same step list passed on the same tree (SP.8) and
the tracking issue's phases are closed:

```text
tag: vA.B.C-rc.N
operator: <name>
date: <yyyy-mm-dd>
```

A stage go names `commit:` (the QA commit) instead of `tag:`. The go names nothing else (owner,
2026-10-14): the release comes from the target file and the rc tag, the target from `--target`, and
the recovery decision from the release's YAML (`recovery:`, SC.1). The runner refuses a stage commit
that is not on a QA branch of the release line, a production tag that is not an rc of the release
on `releases-A.B.x`, and stops at the first failed step. With the go, run the preflight (§4.2), then
within 60 minutes:

```bash
bun run release:run --target prod --go <go> --after-preflight <the preflight's journal>
```

The cutover backs up and proves the restore (C01-backup to C03-restore-proof), then never takes the
website down:

1. **C04-probe-start** starts the website probe on the control machine: the public origin's `/` and
   `/version.json` every 2 s.
2. **C05-migrate** migrates while the previous release still serves. Only `compat: additive` migrations
   may run this way; P07-baseline refused anything else. A breaking migration needs its own plan.
3. **C06-version-tag** tags `vA.B.C` (production only).
4. **C09-tokens** keeps every valid service token. A running holder keeps authenticating, and only a
   missing or stale token is minted.
5. **C10-rolling-boot**, the rolling boot (`bun smoke --static-port`), replaces api, worker-analytics,
   system-scheduler and analytics-producer one at a time, each healthy before the next.
   website-server is never recreated, and the boot refuses before replacing anything if compose's
   dry run says it would be. While the api swaps, nginx keeps serving the site and answers `/api/`
   from its maintenance fallback.
6. **C12-site** switches the site atomically and reloads nginx gracefully (`bun smoke:web`).
7. **C13-probe-grade** stops the probe and fails the release on any answer that is not 200, or on any gap.

The privileged credential `rm_owner` is a line in the host's `~/.env`. `doadmin` is stored in no
file: the admin types it into `bun run role-passwords` before the run, and no production step reads it
([D61's amendment](../decisions.md#d61-amendment-1272)). A write names its target with
`--confirm-target`. No container receives a privileged credential, and no receipt, journal or log
line prints one.

**Postflight and soak.** S01-verify-version to S06-host-guards verify identity, product (readonly tier), logs, the baseline
comparison and the host guards. Then the 30-minute soak (owner, 2026-10-14): S07-soak-gate grades logs since
READY, S08-soak-checks runs the standing invariants against the READY baseline, and
S09-collect-logs copies every container's logs and `docker inspect` into the journal. Sessions are deferred in the
soak. They are graded afterwards as a report, once 37 h have passed:
`bun run prod:gate --mode post-release --instance rm_prod --since <READY> --sessions graded`.

**A boot or a rolling boot is uneventful (issue 1378).** The services hold this
contract, so a runbook needs no step to drain or clean the queue by hand:

- `worker-analytics` claims no job until the api's `/health` answers. It waits
  in process as well as through compose, because a rolling boot starts each
  service with `--no-deps`.
- At worker start a sweep cancels the stale backlog of the `latest-only` and
  `collapse-per-bucket` kinds, with the reason `superseded at worker start`.
  A restored dump's backlog never runs, and live samplers start on time.
- After downtime each heavy kind enqueues one job, not one per missed slot.
- The stack stops the old `analytics-producer` before the seed one-shot. The
  new producer starts its boot catch-up a bounded, jittered delay after api
  readiness.
- On stop, `worker-analytics` releases its job inside its 45 s grace period.
  The api, `system-scheduler` and `analytics-producer` drain on SIGTERM and
  exit 0. A container that exits 137, or a job the reaper requeues after a
  stop, is a finding to triage, not expected noise.

**A session in `judging` during the swap (D71).** Every eligible judge judges, and one on-time answer
is drawn at the judging deadline. The rolling boot replaces the api before `system-scheduler`, and both
version mixes finalize at the judging deadline: an old scheduler already arms that timer, and a new one
waits for nothing else. Answers an old api filed during the swap are tagged `not_judge_of_record`, so they
are not candidates and that one session may publish `no_consensus`. Start the upgrade with no session in
`judging` where possible. Rolling back reads only `applied`, so drawn sessions look unjudged in the gates
and on the public page until the roll forward. No data is lost.

### 4.7.1. Product verification

Verification asks whether the product does what it claims; postflight asks whether the migration
landed. They are separate steps. Only the `readonly` tier of `verify:live` may run against
production: a `full` leg publishes sessions and spends inference. A WARN is not a pass, and
"nothing was asserted" (exit 2) is not "the product is wrong" (exit 1).

### 4.7.2. Log gates

`bun run twin:gate` grades a twin and `bun run prod:gate` grades production, before
(`--mode baseline`) and after (`--mode post-release`) the cutover. The rule is default deny: every
distinct error in every log must match a classification in
`scripts/lib/gate/log-classifications.json` with a written reason. A session that publishes
`no_consensus` is a warning, never a good session (owner, 2026-10-06).

### 4.8. Recovery

The recovery decision is the release YAML's `recovery:` text (SC.1). The preflight's `P.recovery`
refuses a release without one, and the run journals its sha256.
Before C05-migrate, fix and resume: nothing has changed. A failed C05-migrate resumes at C05-migrate while the previous
release keeps serving. After C05-migrate, fix forward on the next patch version, or restore the C01-backup dump
with the write loss it implies. The version tag stays either way (§3 step 8). Do not assume a
deployment tool rolls back by itself.

### 4.9. Production report

The closing artifact names the rc deployed, the cutover and postflight results, the probe grade, the
soak and its logs, issues opened against the next patch version, backport TODOs (§7), and the
operator's sign-off. The tracking issue closes only after the report is filed and the version tag
exists on the release branch.

## 5. Runbooks are YAML

There are two kinds of file, and the runner runs only the second:

- **A template** (`scripts/release/runbooks/templates/<name>.yaml`) is a general runbook: every step
  a kind of release runs, in order. `kitchen-sink`, the full-stack release, is the default. A
  `website-only` template joins with its runner mode.
- **A release runbook** (`scripts/release/runbooks/releases/vA.B.C.yaml`) names its template
  (`template: kitchen-sink` when omitted), holds a full copy of the template's steps, and **only
  adds**. Every template step stays, unchanged and in order. An added step or check may sit
  anywhere, and carries `added: vA.B.C`. A one-time action is an added step gated on a receipt's
  absence (`gateAbsent`). The file also holds the release's `recovery:` decision (required), its
  `notes:` (identity, migrations, exceptions and owner decisions), and its `scope:`.

**Scope (owner, 2026-10-15).** `scope:` lists every PR the release ships, each with
`check: <step>`, the version step that proves it landed, or `none: <reason>` (docs only, CI only,
release tooling the run itself exercises). QA step Q05-scope refuses a commit whose range from the
version the target runs carries a PR the scope does not list, or a listed PR it does not carry. A
version check is a file `scripts/release/version-checks/<release>/<name>.ts`, run by
`scripts/release/version-check.ts` on the target host; it reads, and a check that must write is
`onlyFor: stage`.

`scripts/release/runbook.ts` refuses a release runbook that drops, edits or reorders a template
step, and a unit test holds every in-flight release runbook to the current template, so a step
added to a template reaches them in the same pull request. The step-list hash SP.8 compares is
taken over the release runbook's steps. Every step names its standing check IDs (§9) and whether it
is irreversible; a step a tool cannot perform is a `gap`.

## 6. The tracking issue

Each release has one GitHub tracking issue labelled `release:vX.Y.Z`. It states the objective: the
end state, not a list of PRs. Its Phases tasklist is the precondition §4.1 checks. A box ticked there
claims the gate ran and passed.

## 7. Backporting

Not a gate. Every fix made on a QA branch reaches the release branch in the stage-passed squash
(§2 route (b)), and reaches `main` afterwards by a separate PR from the QA branch, evaluated against
`main` as it is then.

## 8. Compatibility contract

Schema identity, manifest integrity, migration metadata and code/schema compatibility are defined by
[smoke production spec §§8–9](./smoke-production-spec.md#8-schema). "Additive" means older supported
code keeps its query behavior, data meaning, bootstrap assumptions and required grants; adding a
column alone does not establish it. A rolling release depends on it: the previous release serves
against the new schema between C05-migrate and C10-rolling-boot. API changes stay additive where possible, and the
site served during an API change must accept both API versions (`apiRange`).

## 9. Standing check IDs

Every step of a template names the standing checks it satisfies. A check leaves this list only by a
recorded owner decision.

| ID | Check | Steps |
|---|---|---|
| SP.1 | Position: which release, which commit, which phase; clean checkouts | P01-checkout to P06-capture-install |
| SP.2 | Backup taken and restore proven, with the restore time | C01-backup, C02-backup-sums, C03-restore-proof |
| SP.3 | The ledger reconciles with `backend/migrations` and the running tag's bytes (D67) | P07-baseline |
| SP.4 | Smoke preflight: role auth, privileges, manifest, compat, `~/.env` keys, identity | C10-rolling-boot |
| SP.5 | Log baseline, triaged before the cutover | P08-log-baseline |
| SP.6 | Product baseline: row counts and database size | P07-baseline |
| SP.7 | CI green on the commit | preflight `P.ci` |
| SP.8 | Production runs only what stage passed: same step-list hash, same tree, every step ok | preflight `P.stage` |
| SP.9 | The commit carries a freshly resolved lockfile | Q01-lockfile |
| SR.0 | Stage's starting dump at most 24 hours old | Q02-dump, Q03-stage-up |
| SR.1 | Stage's role passwords set through its own database, as `role-passwords` sets production's | Q04-role-passwords |
| SR.2 | Every PR the release ships is in its scope, with a check or a reason | Q05-scope |
| SC.1 | Recovery decided before the cutover | the release YAML's `recovery:`, preflight `P.recovery` |
| SC.3 | The operator's go is recorded before the run | `--go` |
| SC.4 | The website never goes down: every probe answer 200, no gap | C04-probe-start, C13-probe-grade |
| SC.5 | Rolling upgrade: additive migrations under the running release, services one at a time, website-server kept, valid tokens kept | P07-baseline, C05-migrate, C09-tokens, C10-rolling-boot, C12-site |
| SV.1 | Identity: `/api/version` and `/version.json` carry the commit and the rc tag | S01-verify-version |
| SV.2 | Smoke status: preflight and readiness green | C11-ready |
| SV.3 | Product verification, readonly tier | S02-verify-product |
| SV.4 | Log verdict after the release | S03-log-verdict |
| SV.5 | Row counts only grow; the database did not balloon | S05-compare-baseline |
| SV.6 | `~/.env` allowlist, no Docker socket mount, token files 0600 | C07-env-rewrite, S06-host-guards |
| SV.7 | Each change the release ships is in place: a feature landed, a bug fixed, a feature retired | the release's version steps (V01…) |
| SW.1 | The soak: logs since READY graded | S07-soak-gate |
| SW.2 | The standing invariants over the soak (§10) | S04-soak-record, S08-soak-checks |
| SW.3 | The version tag at the cutover's start | C06-version-tag |
| SW.4 | Every container's logs and inspect since READY in the journal | S09-collect-logs |

Retired: SC.2 (2026-10-08, replaced by the go, D61).

## 10. The standing invariants (SW.2)

These read-only invariants hold on every healthy stack, at every gate. They run as ONE
instance-aware script, `bun run soak:checks` (`scripts/standing-soak.ts`, decisions in
`scripts/lib/gate/standing.ts`), beside `twin:gate` and `prod:gate`. Like the gates it takes
`--instance`, reads the stack record, runs every query through the instance's api container on a
read-only session, reads container logs and `docker inspect`, and holds no admin token, no
superuser and no Docker socket. T0 is the instant the stack became READY (`--since`). Run it once
with `--record` at READY: R8.d and R8.p compare with that baseline (without one R8.p FAILS and
R8.d is unverified). `--full` adds the slow vintage join of R8.l. Every check has a unit test with
a red control (`scripts/tests/unit/standing-soak.test.ts`). The runner records the baseline at S04-soak-record and runs the full check over the soak at S08-soak-checks.

| Id | Invariant | Status | Note |
|---|---|---|---|
| R8.a, R8.b | Scheduled regime and research runs each produced their output artifact | script | The cron is read from the `analytics-producer` container's `PRODUCER_REGIME_CRON` and `PRODUCER_RESEARCH_CRON`. Compose defaults to daily (22:30, 23:00). Production runs every 3 h (:30, :00), so the 3 h cadence holds only if the boot sets those variables (the `--static-port` boot does). A cron the script cannot expand is a WARN |
| R8.c | No producer failure line since T0 | script | Also matches the day-roll regime failure line (1108) |
| R8.d | Ledger growth stays inside the recorded baseline | script | Baseline from `--record`, in the instance state directory (`soak-baseline.json`) |
| R8.e | Writers record only real changes: no noise-only revisions, no `unchanged` rows | script | |
| R8.f | Parity sweeps: none dead, longest under 60 s, p50 at or under 5 s. The sweep runs once a day at 04:47 UTC, one request per domain (issue 1375), so a soak shorter than a day may see none: that is INFO, not a failure. The schedule parity check also fails unless `analytics.parity_sweep` is scheduled exactly once, at `47 4 * * *` | script | |
| R8.g | Website server errors: none, or only warned | script | |
| R8.h, R8.i | Quorum excludes the judge. Every published session has takes, a judgement and a receipt | script | |
| R8.j | No session wedged past its window plus grace | script | |
| R8.k, R8.k2 | Every ledger guard armed. The old payload table stays gone | script | |
| R8.l | Newest vintage: run lengths add up to the member count | script | |
| R8.m | No connection-pool starvation (sessions idle in a transaction) | script | `pg_stat_activity` shows the api role only its own sessions, so the detail says how many of the open sessions it could see |
| R8.n | Host disk | script | `df /` on the host the script runs on |
| R8.n2 | No container's writable layer is over 2 GB | script | `docker inspect --size` (`SizeRw`) for every project container. Issue 1258: the HTTP fetch cache grew to 20 GB in one worker's writable layer while R8.n still passed. An unreadable size is a FAIL |
| R8.n3 | Host free disk has not fallen more than 2 GB since the baseline | script | The baseline's free space comes from `--record`. A baseline without it (recorded before this check) is a WARN until the next `--record` |
| R8.p | `schema_migrations` equals the recorded baseline | script | Baseline recorded at READY with `--record`, so a release's own migrations are in it. §1: the ledger is the record of every data change |
| R8.q | Judge config: enforce, pinned model, third parties off | script | The pin is `deepseek-v4.1-flash` (migration 0111). The two pre-0111 ids are a WARN, valid only before 0111 applies |
| R8.r | Role and grant integrity: `rm_app` INSERTs on the chain-state tables, `rm_worker` holds none ([D75](../decisions.md#d75)), the api connects as `rm_app`, `rm_readonly` reads sequences | script | Graded on a production (`external`) stack only. A twin's dump carries no grants. A database before 0127 still grants `rm_worker`: a WARN |
| R8.s | `/health` and the judgements route answer 200 | script | Probes the api at the stack record's port. `--base-url` probes the public origin instead |
| R8.t | Every published session has `openedAt` | script | Sessions dated on or after `--opened-at-from` (default 2026-09-22) |
| R8.u | Api: no cut-off at the request limit on a reader, every slow request listed | script | R8.u2 lists slow requests as a WARN. The api's limit is 10 s and a request over 5 s is logged |
| R8.v | The buyback scan never fails on a refused range | script | Reads every `worker-*` lane, not one named container |
| R8.w | Gecko tier matches the key, no 429/401/403, the key is in no ledger row or api/website environment | script | Key presence is read from `docker inspect`; no value is ever printed. R8.w2 and R8.w3 are its error and containment halves |
| R8.x | The regime day is logged | script | `regime asof D` is logged from the `analytics-producer` container, so each line is compared with its own Docker timestamp |
| R8.o | Informational: error-like lines per container | script | INFO by design: it never fails. The gates classify the lines |

A query that errored never reads as a pass: a read that fails is a FAIL of the check that needed it.
A release that adds an invariant adds a row here, with its red-control test, in the same pull request
(§9).

## 11. Analyst SDK releases

The analyst SDK (`packages/analyst-sdk/`) has its own release line (proposed in
[D77](../decisions.md#d77)). Sections 2 to 10 govern platform releases only. None of them applies to an SDK
release. The SDK runs on an analyst's machine. Nothing deploys, so there is no QA branch, no stage
run, no rc tag and no production cutover.

**Branch.** The SDK ships from `analyst-sdk/releases-A.B.x`, where A.B comes from the SDK's own
semver. The `analyst-sdk/` prefix is required. Platform CI triggers on `releases-*`, and
`scripts/release/tag.ts` and `scripts/release/preflight.ts` treat `releases-A.B.x` as a platform
release line. Changes reach the branch from `main` only, by merge or cherry-pick (main-first, like
§2 route (a)). Feature PRs never target it.

**Tag.** A release is the tag `analyst-sdk-vA.B.C`. It lands only on a commit of
`analyst-sdk/releases-A.B.x`, never on `main`. Its version equals `version` in
`packages/analyst-sdk/package.json`. The namespace is separate from the platform's `v*` tags, as
`contract-v*` is for `contract/` (`.github/workflows/contract-publish.yml`). The first tag is
`analyst-sdk-v0.2.0`. Every untagged build so far reported `0.1.0` in its `User-Agent`, so a fresh
number separates tagged releases from them.

**Gate.** Before tagging, these are green at the commit:

- the `analyst-sdk` workflow (`.github/workflows/analyst-sdk.yml`);
- the backend analyst SDK parity tests in `.github/workflows/backend.yml`: the vintage round-trip,
  the public-archive recording, the backtest and correlations fidelity and the input-rule parity
  tests.

To be built: a guard that refuses a tag whose version differs from `package.json` or whose commit
is not on an `analyst-sdk/releases-*` branch. Also to be built: both workflows add
`analyst-sdk/releases-*` to their push branches. Until then neither workflow runs on a push to an
SDK release branch.

**Release notes.** Each tag gets a GitHub release. Its notes state:

1. the archive format it reads (format 1, [D72](../decisions.md#d72));
2. that it replays published report payloads byte for byte;
3. the platform tag whose analytics code it matches, or "ahead of production" when it carries
   `main` code no platform release has shipped. The SDK and the backend share code
   (D57).

**Install.** An analyst installs a release by its tag:

```sh
git clone --branch analyst-sdk-vA.B.C --depth 1 --filter=blob:none --sparse https://github.com/robotmoney/robotmoney-frontend.git
cd robotmoney-frontend
git sparse-checkout set packages/analyst-sdk
```
