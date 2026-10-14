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
> [10. Standing invariants](#10-the-standing-invariants-sw2)

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
2026-10-09). No admin-route write, no SQL by hand, no one-off script. R6.3 is the one step that
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
session report names which branch each piece of evidence ran on.

## 3. Release candidates and version tags

An rc tag `vA.B.C-rc.N` (`N` from 0) names a commit whose tree passed stage. A version tag
`vA.B.C` names what production was cut over to. Production runs only by an rc tag.

The cycle (D70):

1. **Stage runs on a QA branch.** Stage runs a clean, pushed QA commit, never a PR head or a fix
   branch. Fixes merge into the QA branch, and stage reruns on its new tip. A stage failure
   consumes no rc number.
2. **Refresh the lockfiles.** Every rc carries a freshly resolved lockfile (owner, 2026-10-14): run
   `bun scripts/release/lockfile.ts refresh` on the QA branch and commit the result before the
   stage run. Stage's preflight check `P.lockfile` refuses a commit whose lockfiles differ from a
   fresh resolve. Hosts install with `--frozen-lockfile`.
3. **The runbook passes on stage.** Record the commit and its tree hash.
4. **Squash the QA branch onto the release branch.** The release branch must not have moved since
   the QA branch was cut, and the squash tree must equal the stage-passed tree.
5. **Cut `vA.B.C-rc.N` at the squash commit** with
   `bun scripts/release/tag.ts rc --release vA.B.C --commit <squash> --stage-journal <passed stage run>`.
   It refuses a commit whose tree is not the stage run's tree, and pushes the tag.
6. **Production runs only by that rc tag.** SP.8 refuses a tag whose tree differs from the
   stage-passed tree.
7. **A failure before the cutover** (preflight, baseline, backup, or any step before R6.3) means the
   rc never reaches production. Fix it on a new QA branch, rerun stage, squash again and cut
   `vA.B.C-rc.(N+1)`.
8. **The cutover starts (R6.3)** → step C1 tags `vA.B.C` at the rc's commit at once. A later failed
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

### 4.1. Code readiness

Every Phase and feature issue linked from the tracking issue's Phases tasklist is closed, and the
objective is stated (§6). Every commit expected to ship is on the release branch by §2 route (a).
The tracking issue itself stays open until §4.9.

### 4.2. Baseline

Before anything changes, R2.3 records production's state through `rm_readonly`: the ledger and its
reconciliation with `backend/migrations` ([D67](../decisions.md#d67)), identity, roles, row counts,
the sessions in flight and the database size. R2.3 refuses any pending migration that is not
`compat: additive` (§4.7). R2.5 grades the running stack's logs; each finding there is triaged by
the owner before the cutover (`--triage <file>`).

### 4.3. Backup, restore proof and dumps

R2.1 always captures production's backup new, from the read replica, right before the cutover. R2.4r
restores it into a throwaway container and records the restore time.

**Stage's starting dump (owner, 2026-10-08; SR.0).** Unless the operator names a dump, stage starts
from the newest production dump already on the capture host if it is at most 24 hours old
(`manifest.json` `capturedAt`), else a new capture (`bun smoke:capture --out <new directory>`).
Never restore a dump older than 24 hours. Never point rehearsal preparation at the production
database.

### 4.4. Stage rehearsal

The cutover rehearsal runs the release's YAML unmodified with `bun run release:run --target stage`
against the production-shaped stage target ([stage-target.md](../runbooks/stage-target.md)): a
remote Postgres restored from a production dump, with the previous release running against it the
way production runs it. The stage sequence:

1. `bun scripts/release/stage-target.ts up --dump <dir>`;
2. `bun scripts/release/stage-target.ts doadmin | bun run role-passwords --target stage --doadmin-stdin`;
3. `bun run release:run --target stage --preflight`, then `--go <stage go>`.

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

The owner writes the go once the production preflight is green apart from the go, a stage run of the
same step list passed on the same tree (SP.8), and the tracking issue's phases are closed:

```text
tag: vA.B.C-rc.N
operator: <name>
date: <yyyy-mm-dd>
```

A stage go names `commit:` (the QA commit) instead of `tag:`. The go names nothing else (owner,
2026-10-14): the release comes from the target file and the rc tag, the target from `--target`, and
the recovery decision from the release's YAML (`recovery:`, SC.1). The runner refuses a stage commit
that is not on a QA branch of the release line, a production tag that is not an rc of the release
on `releases-A.B.x`, and stops at the first failed step.

The cutover never takes the website down:

1. **C0** starts the website probe on the control machine: the public origin's `/` and
   `/version.json` every 2 s.
2. **R6.3** migrates while the previous release still serves. Only `compat: additive` migrations
   may run this way; R2.3 refused anything else. A breaking migration needs its own plan.
3. **C1** tags `vA.B.C` (production only).
4. **R6.5** keeps every valid service token. A running holder keeps authenticating, and only a
   missing or stale token is minted.
5. **R6.7a**, the rolling boot (`bun smoke --static-port`), replaces api, worker-analytics,
   system-scheduler and analytics-producer one at a time, each healthy before the next.
   website-server is never recreated, and the boot refuses before replacing anything if compose's
   dry run says it would be. While the api swaps, nginx keeps serving the site and answers `/api/`
   from its maintenance fallback.
6. **R6.10** switches the site atomically and reloads nginx gracefully (`bun smoke:web`).
7. **C9** stops the probe and fails the release on any answer that is not 200, or on any gap.

The privileged credential `rm_owner` is a line in the host's `~/.env`. `doadmin` is stored in no
file: the admin types it into `bun run role-passwords` before the run, and no release step reads it
([D61's amendment](../decisions.md#d61-amendment-1272)). A write names its target with
`--confirm-target`. No container receives a privileged credential, and no receipt, journal or log
line prints one.

**Postflight and soak.** R7.1 to R7.7 verify identity, product (readonly tier), logs, the baseline
comparison and the host guards. Then the 30-minute soak (owner, 2026-10-14): W1 grades logs since
READY, W2 runs the standing invariants against the READY baseline, R7.4a checks schedule parity, and
W3 copies every container's logs and `docker inspect` into the journal. Sessions are deferred in the
soak. They are graded afterwards as a report, once 37 h have passed:
`bun run prod:gate --mode post-release --instance rm_prod --since <READY> --sessions graded`.

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
Before R6.3, fix and resume: nothing has changed. A failed R6.3 resumes at R6.3 while the previous
release keeps serving. After R6.3, fix forward on the next patch version, or restore the R2.1 dump
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
  absence (`gateAbsent`). The file also holds the release's `recovery:` decision (required) and its
  `notes:`: identity, migrations, exceptions and owner decisions.

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
against the new schema between R6.3 and R6.7a. API changes stay additive where possible, and the
site served during an API change must accept both API versions (`apiRange`).

## 9. Standing check IDs

Every step of a template names the standing checks it satisfies. A check leaves this list only by a
recorded owner decision.

| ID | Check | Steps |
|---|---|---|
| SP.1 | Position: which release, which commit, which phase; clean checkouts | R1.1–R1.6 |
| SP.2 | Backup taken and restore proven, with the restore time | R2.1, R2.2, R2.4r |
| SP.3 | The ledger reconciles with `backend/migrations` and the running tag's bytes (D67) | R1.2, R2.3 |
| SP.4 | Smoke preflight: role auth, privileges, manifest, compat, `~/.env` keys, identity | R6.7a |
| SP.5 | Log baseline, triaged before the cutover | R2.5 |
| SP.6 | Product baseline: row counts and database size | R2.3 |
| SP.7 | CI green on the commit | preflight `P.ci` |
| SP.8 | Production runs only what stage passed: same step-list hash, same tree, every step ok | preflight `P.stage` |
| SR.0 | Stage's starting dump at most 24 hours old | `stage-target up` |
| SC.1 | Recovery decided before the cutover | the release YAML's `recovery:`, preflight `P.recovery` |
| SC.3 | The operator's go is recorded before the run | `--go` |
| SC.4 | The website never goes down: every probe answer 200, no gap | C0, C9 |
| SC.5 | Rolling upgrade: additive migrations under the running release, services one at a time, website-server kept, valid tokens kept | R2.3, R6.3, R6.5, R6.7a, R6.10 |
| SV.1 | Identity: `/api/version` and `/version.json` carry the commit and the rc tag | R7.1 |
| SV.2 | Smoke status: preflight and readiness green | R6.9 |
| SV.3 | Product verification, readonly tier | R7.3 |
| SV.4 | Log verdict after the release | R7.3a |
| SV.5 | Row counts only grow; the database did not balloon | R7.5 |
| SV.6 | `~/.env` allowlist, no Docker socket mount, token files 0600 | R6.2, R7.7 |
| SW.1 | The soak: logs since READY graded, schedule parity | W1, R7.4a |
| SW.2 | The standing invariants over the soak (§10) | R7.3b, W2 |
| SW.3 | The version tag at the cutover's start | C1 |
| SW.4 | Every container's logs and inspect since READY in the journal | W3 |

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
a red control (`scripts/tests/unit/standing-soak.test.ts`). The runner records the baseline at R7.3b and runs the full check over the soak at W2.

| Id | Invariant | Status | Note |
|---|---|---|---|
| R8.a, R8.b | Scheduled regime and research runs each produced their output artifact | script | The cron is read from the `analytics-producer` container's `PRODUCER_REGIME_CRON` and `PRODUCER_RESEARCH_CRON`. Compose defaults to daily (22:30, 23:00). Production runs every 3 h (:30, :00), so the 3 h cadence holds only if the boot sets those variables (the `--static-port` boot does). A cron the script cannot expand is a WARN |
| R8.c | No producer failure line since T0 | script | Also matches the day-roll regime failure line (1108) |
| R8.d | Ledger growth stays inside the recorded baseline | script | Baseline from `--record`, in the instance state directory (`soak-baseline.json`) |
| R8.e | Writers record only real changes: no noise-only revisions, no `unchanged` rows | script | |
| R8.f | Parity sweeps: none dead, longest under the api statement timeout | script | |
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
| R8.r | Role and grant integrity: `rm_worker` INSERTs, the api connects as `rm_app`, `rm_readonly` reads sequences | script | Graded on a production (`external`) stack only. A twin's dump carries no grants |
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
