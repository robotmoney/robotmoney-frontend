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
> [11. Analyst SDK releases](#11-analyst-sdk-releases) ·
> [12. Web content releases](#12-web-content-releases)

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
rolling upgrade (§4.7), except a release that declares `breaking:`, which stops the stack inside one declared window. No other step stops the whole stack. No tmux session drives or holds any process.

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

A new release line's branch `releases-A.B.x` is created from `main`, at the commit the release's
scope is chosen at, never from the previous release line (owner, 2026-10-26). Its scope then reaches
it from `main` by route (a). Nothing on `releases-A.B.x` descends from the previous line's branch.

No commit lands on the release branch during a QA session. Session fixes reach `main` afterwards by
a separate PR from the QA branch (§7). A release branch is force-pushed only on an explicit owner
instruction, after `archive/releases-A.B.x-<YYYY-MM-DD>` is pushed. Tags land on the release
branch, never on `main` or a QA branch.

**QA branches (owner, 2026-10-06 and 2026-10-07).** A QA session cuts one
`qa/A.B.x-<YYYY-MM-DD>` branch from the release branch tip and pushes it. Every patch of the
session, runbook corrections included, is committed straight to that branch and pushed as a
fast-forward (owner, 2026-10-16). No pull request opens into a QA branch. A pushed QA branch is never rewritten:
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

**Three phases (owner, 2026-10-16).** Every step of a runbook belongs to one phase and runs on one
target. Its id names its phase: `Q` for stage, `P` and `C` for production. The phases run in this
order:

| Phase | Ids | Target and when | What it does |
|---|---|---|---|
| **QA** | `Q01` to `Q48` | Stage only, as often as needed, on a QA branch commit | The whole rehearsal. Preparation first: the lockfile, the dump, the stage target, its role passwords, the scope. Then the upgrade exactly as production will run it: checkouts and installs, the baseline, backup and restore proof, the migrate, the rolling boot, the site, the probe. Then the soak. Then the release's own version checks, one per change it ships |
| **Preflight** | `P01` to `P08` | Production only, once per rc, at most 60 minutes before the cutover (`--preflight`) | Read-only gates that assume every QA step passed: checkouts and installs at the rc, host identity, `~/.env` keys and the rm_owner login, the ledger and its pending set, the log baseline. Nothing a running service uses changes |
| **Cutover** | `C01` to `C36` | Production only, once (`--after-preflight`) | The release as it happens: backup and restore proof, the rolling upgrade, the site switch, the probe's grade, then the soak and the version checks as stage ran them |

**Words.** "The cutover" is the production run (§4.7). Stage never runs a cutover. Its Q steps are
the rehearsal of one.

**Twins.** Every production step has a QA twin: the same name and the same commands, run on stage.
`Q18-migrate` is `C05-migrate`, `Q22-rolling-boot` is `C10-rolling-boot`, `Q32-soak-gate` is
`C20-soak-gate`. The runner refuses a step list where a P or C step has no twin, where a twin's
commands differ, or where the twins run in a different order (`twinProblems` in
`scripts/release/runbook.ts`). Four steps have no twin: stage's preparation (`Q01` to `Q05`) and
`C06-version-tag`, which stage never runs. A version check that must write is `stageOnly: true` and
has no production twin.

A stage run is the QA phase end to end, so production's checks have passed on stage before
production runs them. Stage runs no preflight: the stage pass earns the rc. Production's cutover
refuses without a green preflight of the same rc and step list from the last 60 minutes, and
carries the preflight steps' records instead of running them again. Preflights are cheap: run a new
one rather than stretch an old one.

**QA collects every error (owner, 2026-10-16).** A stage run does not stop at its first failed step.
It records the failure, runs the rest, and ends failed with every failure listed. A soak step whose
READY step failed is recorded as not run and failed. Stage is disposable. Production's cutover is
not: it stops at its first failed step, and the preflight reports every finding it can.

### 4.1. Code readiness

Every Phase and feature issue linked from the tracking issue's Phases tasklist is closed, and the
objective is stated (§6). Every commit expected to ship is on the release branch by §2 route (a).
The tracking issue itself stays open until §4.9.

### 4.2. Preflight

`bun run release:run --target prod --preflight --go <go>` checks, on the control machine, the rc
tag, CI on its commit (`P.ci`), a passed stage run of the same tree and step list (`P.stage`), the
recovery decision (`P.recovery`) and that no run is in flight. It then runs the preflight steps on
the hosts. P01-checkout to P06-capture-install put the release and capture checkouts at the rc and
install them frozen. P02-host-identity proves the host, `~/.env` and the rm_owner login. P02-host-identity
and P05-capture-identity (and Q07/Q10 on stage) also refuse a host whose Bun is older than the
oldest Bun that reads every committed `bun.lock` (`scripts/release/host-tools.ts`), before any
install step runs; `host-identity.json` records each tool's version and that minimum. P07-state-baseline
records production's state through `rm_readonly`: the ledger and its reconciliation with
`backend/migrations` ([D67](../decisions.md#d67)), identity, roles, row counts, the sessions in
flight and the database size. It refuses any pending migration that is not `compat: additive`
(§4.7). P08-log-baseline grades the running stack's logs; each finding there is triaged by the
owner (`--triage <file>`).

`P.ci` reads the rc commit's check runs first. The rc squash has the QA commit's tree, and its push
to the release branch starts CI again. When the rc commit's CI is not green yet, `P.ci` reads the
check runs of the stage journal's commit (`--stage-journal`, or the passed stage run `P.stage`
found) if `git rev-parse <commit>^{tree}` gives the same tree for both. Green CI there makes `P.ci`
green, and its detail names that commit and the tree. Any other tree, or red CI on both, keeps
`P.ci` red with both commits' problems.

### 4.3. Backup, restore proof and dumps

C01-backup captures production's backup new, from the read replica, as the cutover's first step.
C03-restore-proof restores it into a throwaway container and records the restore time, before the
first irreversible step (C05-migrate).

**Stage's starting dump (owner, 2026-10-08; issue 1564; SR.0).** Step Q02-dump always captures a
new dump (`bun smoke:capture --out <new directory>`, read-only against production's replica as
`rm_readonly`, as C01-backup does). It never reuses a dump already on the capture host, whatever
its age: reuse was for rapid hand turnaround only, and v0.7.1 QA's Q13-log-baseline failed on
reused dumps 8 to 31 hours old. Step Q03-stage-up restores the newest dump, which is the one Q02
just captured. `up` still refuses a dump older than 24 hours (`manifest.json` `capturedAt`), so an
operator-named dump must be fresh too. Never point rehearsal preparation at the production database.

### 4.4. Stage QA

QA runs the release's YAML unmodified against the production-shaped stage target
([stage-target.md](../runbooks/stage-target.md)), as one run:

```bash
bun run release:run --target stage --go <stage go>
```

**Before the run.** Run the scope check on the control machine against the QA commit, so a PR
missing from the release YAML's `scope:` is fixed before the stage run, not found by it:
`bun scripts/release/scope.ts --release vA.B.C --commit <QA commit> --origin <production origin>`.
Commit any scope or runbook fix to the QA branch first. Every commit after a stage run changes the
tree that run passed, so the run to count is the one at the final QA tip (§3 step 3).

**The precheck (issue 1563).** Run the release's own version checks against the live stage stack
before the full run, so a check defect costs minutes, not a 4-hour restart:

```bash
bun run release:precheck --target stage --release vA.B.C --commit <QA commit, 40-hex>
```

It selects every QA step of `runbooks/releases/<release>.yaml` (read at the commit) that carries
`added: <release>`, in runbook order. Template steps (no `added`) never run. It refuses (exit 2) a
target other than stage, a stage run in flight, and a commit that is not on a QA branch of the
release line. Target-host steps run on the stage host from a throwaway worktree of the commit
(`<home>/.local/state/robotmoney-release/stage/precheck-<ts>/checkout`, made from the target
checkout with `git worktree add --detach`, then `bun install --frozen-lockfile`). Control-host
steps run from a matching worktree on the control machine. Commands render with the stage target's
values, `{release}` from `--release` and `{runTs}` as `precheck-<ts>`, against the live instance.
It prints one line per check and exits 0 only when every check exited with its `expectExit`, else 1.
Results go to `<journal root>/stage/precheck-<ts>/precheck.json`, one row per step with its exit,
duration and the check's problems, beside each step's logs. Both worktrees are removed at the end,
pass or fail. A precheck is a tool, not a gate: it writes no `run.json`, changes no run's state,
and SP.8 never reads it. Fix what it finds on the QA branch, then start the full run.

**Running it.** A run lasts longer than one tool or terminal session. Start it detached from the
shell that launches it (`setsid nohup <script> </dev/null &`) and write its output to a log. A
run started inside a session that ends is killed with it, and the remote step it was driving keeps
running with nothing attached. Kill that remote step (`stage-target.js remote`, `pg_restore`) before
resuming, and match processes by an exact name: a `pkill -f` pattern that appears in your own command
line kills your own shell.

Q01-lockfile to Q05-scope prepare the target (production never runs them, and the step-list hash is
the same for both targets, SP.8). Q04-role-passwords sets the role passwords through the stage
database: its doadmin is a disposable stage credential, passed on a pipe and stored in no file, so
the D61 rule on doadmin, which is production's, is kept. The same run creates `pg_stat_statements`
and grants `rm_readonly` `pg_read_all_stats` when either is missing (issue 1581): on production the
admin's pre-release `bun run role-passwords --doadmin-stdin` does it, because the extension is
untrusted and `rm_owner` holds no admin option on that role, so no migration can. Stage's `up`
starts Postgres with `shared_preload_libraries=pg_stat_statements` and installs the extension as the
container superuser, as the managed cluster's provider would. Q06-checkout to Q34-collect-logs then run
the upgrade and the soak as production will run C01-backup to C22-collect-logs, and the release's
version checks follow. The run goes on past a failed step and ends with every failure listed (§4).
After fixes, rerun the whole QA at the new QA tip: the run that counts passes every Q step at the
final tip. `--run <ts> --from <step>` retries from one failed step while a fix is tried. A
log-baseline finding that is the old release's own defect, fixed by this release, is triaged in a
file passed with `--triage <file>` (`scripts/release/triage.ts`).

**The analytics load check (issue 1514).** From release v0.7.1, `Q34a-analytics-load` runs after
`Q34-collect-logs`. It is a stage-only step (`stageOnly: true`): it has no production twin, and the
runner accepts it without one. It runs `scripts/release/analytics-load-check.ts` on the stage host.
The check starts no analytics run. It waits for the next scheduled run, the next 3-hour boundary
in UTC (research `0 */3 * * *`, regime `30 */3 * * *`), and follows the analytics-producer's log
from it. The window closes 5 minutes after the tick's `[analytics] regime asof` line, or at the
120-minute cap when that line never comes; a window closed at the cap with no such line fails
("the tick logged no regime asof line", issue 1567). Then it reads the api container's log and
`/health` `db_pool` for that window. It prints one row per route:
the request count, p50, p95 and max duration, the limiter wait, the pool wait, the handler time,
and the 503 `db_saturated` count with the gate that refused. It exits 1 on any request of 5 s or
more, or any `db_saturated` answer. The api logs only slow requests and refusals, so the rows
count those. An api built before issue 1514 logs no wait split: the check shows it as unknown and
still fails. The step can wait up to 3 hours for the run, so it allows 320 minutes.

To grade a window by hand, run it on the stage host:
`bun scripts/release/analytics-load-check.ts --instance stage_target --receipt-dir <dir>` waits for
the next run. `--since <iso> --until <iso>` grades a window that has passed, and `--log <file>`
grades a saved api log.

**Production's connection budget on stage (issue 1514).** The api derives its request and batch
shares from the server's `max_connections` and reserved connections. Stage's own Postgres allowed
more connections than production's, so the stage api ran with other shares, and the stage soak saw
none of production's batch-pool saturation. `stage-target.ts up` (Q03-stage-up) now starts the
stage Postgres with production's `max_connections`, `superuser_reserved_connections` and
`reserved_connections`. It reads them from production's public `/health` (`db_pool.budget`), as it
reads `/api/version`, and records them in the target's `stage-target.json`. `up` refuses when
`/health` does not carry them. `--connection-limits <max>/<superuser_reserved>/<reserved>` sets
them by hand.

**A time limit is a cap (issue 1567).** A step's `maxMinutes`, or a check's window, is a cap and
never a fixed wait. A check exits as soon as its assertions are proven: Q34a-analytics-load closes
its window at the tick's `regime asof` line plus 5 minutes, with its 120-minute window as the cap. Only a check whose assertions are still unproven runs to its cap.

**Bounded runs.** The runner has no stop-after option. To run part of the QA, run the steps one at a
time with `--only <step> --run <ts>`. A bounded run is never a pass.

Checks that need a seated roster and short epochs run on a twin (`--local dump`, spoofed keys,
`bun run twin:accelerate`, `bun run twin:gate`). Tear the stage stack down once the run passes: it
spends inference credits.

### 4.4.1. Stage run liveness and notification

A stage run never sits dead without a report (issue 1555). The owner gets one of two outcomes: a
passed run, or a notification within minutes naming the run, the step, the reason and the exact
command to continue. None of this runs on production.

**Start it under the supervisor.**

```bash
bun run release:supervise --target stage --go <stage go> [--run <run-ts>]
```

The supervisor (`scripts/release/supervise.ts`) detaches itself (`setsid`, stdin closed) and writes
its output to `~/.local/state/robotmoney-release/stage/supervise-<run-ts>.log`. It outlives the shell
or agent session that started it. Without `--run` it picks the run stamp, and every child it starts
runs `release:run --target stage --go <go> --run <run-ts>`, so one supervisor writes one run.

- **Pause.** On a child's exit 3 (a watch step's `notBefore`) it reads `pausedUntil` from run.json,
  sleeps until then, and resumes the same run.
- **Died.** A child killed by a signal, a child that exits without recording a stop, or a run.json
  that says `running` with a heartbeat more than 10 minutes old is a died driver. The supervisor
  sends one `died` notification with the last step and the resume command. It never restarts a
  died run.

**Every invocation records its stop.** `release:run` on stage writes `stopReason`
(`{kind, step, detail, resume, at}`) into run.json on every exit: `passed` (0), `failed` (1),
`refused` (2, including every resume refusal), `paused` (3, with `pausedUntil`). A refusal before
any journal exists goes to `stage/refused-<ts>.json`. While a step runs, the runner writes
`heartbeatAt` and `driver: {pid, host}` every 60 s.

**One notification per stop.** `scripts/release/notify.ts` is the only transport. It posts a
comment on the one open issue labelled `release:<release>` (§6), scrubbed by `scrub.ts`. A new stage
run refuses (exit 2) unless exactly one open issue carries that label; a resume does not repeat the
check. When the lookup later finds no single issue, or gh fails, the message goes to stderr and
run.json records `stopReason.notified: false` with the reason. The exit code never changes.

**Blocked steps.** A failed step whose output holds `HTTP 402` or `Insufficient account funds` is
recorded with `cause: "blocked"` (the inference account is unfunded). The runner sends one `blocked`
notification when the step ends, never retries it and never switches model. Funding the account is
the owner's. The run goes on and collects every error, as §4.4 describes.

### 4.5. Stage report

The report names the QA commit and tree, the dump identity, the step-list hash, the receipts, the
results, what could not be covered, and the go/no-go. Reference generated artifacts instead of
restating their values.

### 4.6. Fix loop

A fix is developed in a development worktree, never on a host. A host runs a clean checkout of a
pushed commit (`git status --porcelain` empty). Fix on the QA branch (§2), redeploy its tip to
stage, and rerun. The same loop applies when an rc fails in production before the cutover (§3
step 7).

**Resume in place (stage only).** A fix that changes only check code need not restart the stage
run from Q01. `release:run --target stage --go <new go> --run <run-ts> [--from <step>]` with a go
naming the new QA commit is admitted when, on the control machine, `git diff --name-only` from the
journal's last commit to the new one lists only `CHECK_ONLY_PATHS` (`scripts/release/journal.ts`):
`scripts/release/version-checks/**`, `scripts/release/runbooks/**`,
`scripts/release/version-check.ts`, `scripts/release/analytics-load-check.ts`,
`scripts/release/sdk-check.ts`, `scripts/release/sdk-lib.ts`,
`scripts/release/public-analytics-read.ts`, `scripts/release/replay-row.ts` and
`scripts/tests/**`. The step-list hash must be unchanged and the new commit must pass the origin
check. A step's `maxMinutes` is not in the hash, so changing it is check-only; a `cmds` or
`description` edit still starts a new run. Any other path, the runner itself included, is refused.
`run.json` lists every commit the run ran at in `commits` (`{commit, tree, goSha256, fromStep,
at}`), and each step record names the `commit` it ran at; steps already ok keep their records.
SP.8 then also requires every earlier commit in `commits` to differ from the production commit only
in `CHECK_ONLY_PATHS`. Production never resumes at a new commit.

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
bun run release:run --target prod --go <go> --stage-journal <the passed stage run's journal dir> --after-preflight <the preflight's journal>
```

The preflight's `P.stage` line names the passed stage run to pass as `--stage-journal`. The runner
does not find it by itself (SP.8, [D70](../decisions.md#d70)): the operator names the stage run
that earned the rc.

The cutover backs up and proves the restore (C01-backup to C03-restore-proof), then never takes the
website down:

1. **C04-probe-start** starts the website probe on the control machine: the public origin's `/` and
   `/version.json` every 2 s.
2. **C05-migrate** migrates while the previous release still serves. Only `compat: additive` migrations
   may run this way; P07-state-baseline refused anything else. A breaking migration needs its own plan.
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

**Postflight and soak.** C14-verify-version to C19-host-guards (Q26 to Q31 on stage) verify identity, product (readonly tier), logs, the baseline
comparison and the host guards. Then the 30-minute soak (owner, 2026-10-14): C20-soak-gate grades logs since
READY, C21-soak-checks runs the standing invariants against the READY baseline, and
C22-collect-logs copies every container's logs and `docker inspect` into the journal. Q35 to Q37 and C23 to C25 (SV.8,
from v0.7.0) run the analyst SDK against the target from the control machine, read-only. From release v0.7.4,
Q37a-db-stats and C25a-db-stats (`scripts/release/db-stats-check.ts`, issue 1581) exit non-zero unless `pg_extension`
lists `pg_stat_statements` and `rm_readonly` reads other roles' rows in `pg_stat_statements` and `pg_stat_activity`
with no query text hidden. Q37b-jobs-plans (`scripts/release/jobs-query-plans.ts`, stage only) runs `EXPLAIN
(ANALYZE, BUFFERS)` of the jobs-table reads on production's dump as `rm_readonly` and exits non-zero unless the reaper,
the enqueue live guard, livePayloadField and the backlog sweep use `jobs_live_kind_locked_idx` with no Seq Scan on
`jobs` and run under 10 ms, and the admin job counts run under 50 ms with no heap scan of `jobs` executed. Sessions are deferred in the
soak. They are graded afterwards as a report, once 37 h have passed:
`bun run prod:gate --mode post-release --instance rm_prod --since <READY> --sessions graded`. The
full-row replay of a run made by the release is likewise a post-seal report, because the archive seals a
UTC day at a time: `bun scripts/release/sdk-check.ts --check post-seal --target stage|prod` (not a cutover
step) fills the whole archive, replays the newest archived run, and fails until the newest archived run was made by the fixed producer (a commit build identity, not a `pkg:` label). Q36 and C24 replay nothing: they are a contract smoke that fetches one backup (issue 1566).

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
  a kind of release runs, in order. `kitchen-sink`, the full-stack release, is the default and
  the only template. A content-only website release has no template here: it runs on its own
  release line (§12).
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

A release that carries a `compat: breaking` migration on purpose names the file in `breaking:` (D75, §8.5). Q12-state-baseline
and P07-state-baseline read the release from `RM_RELEASE` (set by the runner from the target file) and accept a breaking pending migration only
when that release's runbook names it. Such a release cuts over in the breaking order (§8.5 of the smoke spec), on stage and on
production alike: the runner skips the rolling `migrate` and `rolling-boot` steps and runs the template's `breakingOnly: true`
steps instead, in this order: `maintenance-on` (Q18a, C05a), `smoke-down` (Q18b, C05b), `migrate-breaking` (Q18c, C05c),
`full-boot` (Q22a, C10a) and `maintenance-off` (Q24a, C12a). Any other release records those steps skipped, so its step list and
hash are unchanged. The probe grade (Q25, C13) allows exactly the window from the start of `maintenance-on` to the end of
`maintenance-off`, read from the run journal, and still fails a gap outside it or a window that never closed.

A template step that carries `since: vA.B.C` binds the releases from that one on. A release before it
keeps the runbook it ran, unedited (the SDK steps Q35 to Q37 and C23 to C25 are `since: v0.7.0`, so v0.6.2's file is
unchanged). `scripts/release/runbook.ts` refuses a release runbook that drops, edits or reorders a template
step, and a unit test holds every in-flight release runbook to the current template, so a step
added to a template reaches them in the same pull request. The step-list hash SP.8 compares is
taken over the release runbook's steps. Every step names its standing check IDs (§9) and whether it
is irreversible; a step a tool cannot perform is a `gap`.

**Concurrent steps: `after` (issue 1557).** A step may declare `after: [<earlier step ids>]`. The
runner starts it as soon as its `notBefore` is met and every step it names is done (ok, skipped or
accepted), alongside any long waiter still running. A step without `after` waits for every earlier
step, so a runbook that declares none runs one step at a time, in order, as before, and its
step-list hash is unchanged (the hash includes `after` only on a step that carries it). The loader
(`scripts/release/runbook.ts`) refuses an `after` that names an unknown id, a later id, the step
itself or a step of another phase; an `after` on an irreversible step; an `after` list that lets a
step start before an earlier irreversible step ends; and one that does not wait for the step its
`notBefore` counts from. A QA step and its production twin carry the same list, with the phase
prefixes stripped. Real ordering stays expressible: a check that reads what another builds names it
(archive-routes after archive-records). The template's read-only SDK checks (Q35 to Q37, C23 to
C25) wait only for READY from release v0.7.3 on (`afterSince: v0.7.3`); a runbook of an earlier
release keeps them as it ran, without `after`.

The runner stays the only writer of `run.json`; a running step returns its record to it. On stage, a
failed step is recorded, the steps whose `after` names it (directly or through another) are recorded
failed, not run, and the runner waits for every running step to settle before it exits 1 with every
failure listed in runbook order. On production, the first failure stops new starts; the runner waits
for the steps in flight to settle and exits 1 with the resume command for the first failed step in
runbook order. When nothing is runnable and nothing is in flight but a step waits on a future
`notBefore`, the runner exits 3 as before. `--run` and `--from` select the same steps they always
did. `run.json`, receipts and the printed plan list the steps in runbook order whatever order they
finished in, and while a run has steps with `after` each output line a step streams starts with its
step id. The preflight (`--preflight`) stays sequential.

## 6. The tracking issue

Each release has one GitHub tracking issue labelled `release:vX.Y.Z`. It states the objective: the
end state, not a list of PRs. Its Phases tasklist is the precondition §4.1 checks. A box ticked there
claims the gate ran and passed.

## 7. Backporting

Not a gate. Every fix made on a QA branch reaches the release branch in the stage-passed squash
(§2 route (b)), and reaches `main` afterwards by a separate PR from the QA branch, evaluated against
`main` as it is then.

A change made on a previous release line reaches a later release only through `main`, so it is
backported to `main` by pull request first (§2).

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
| SP.1 | Position: which release, which commit, which phase; clean checkouts | Q06-checkout to Q11-capture-install, P01-checkout to P06-capture-install |
| SP.2 | Backup taken and restore proven, with the restore time | Q14-backup to Q16-restore-proof, C01-backup to C03-restore-proof |
| SP.3 | The ledger reconciles with `backend/migrations` and the running tag's bytes (D67) | Q12-state-baseline, P07-state-baseline |
| SP.4 | Smoke preflight: role auth, privileges, manifest, compat, `~/.env` keys, identity | Q22-rolling-boot, C10-rolling-boot |
| SP.5 | Log baseline, triaged before the cutover | Q13-log-baseline, P08-log-baseline |
| SP.6 | Product baseline: row counts and database size | Q12-state-baseline, P07-state-baseline |
| SP.7 | CI green on the commit, or on the stage commit with the same tree (§4.2) | preflight `P.ci` |
| SP.8 | Production runs only what stage passed: same step-list hash, same tree, every step ok, every earlier stage commit check-only apart (§4.6) | preflight `P.stage` |
| SP.9 | The commit carries a freshly resolved lockfile | Q01-lockfile |
| SR.0 | Stage's starting dump freshly captured by Q02; `up` refuses one over 24 hours old | Q02-dump, Q03-stage-up |
| SR.1 | Stage's role passwords set through its own database, as `role-passwords` sets production's | Q04-role-passwords |
| SR.2 | Every PR the release ships is in its scope, with a check or a reason | Q05-scope |
| SC.1 | Recovery decided before the cutover | the release YAML's `recovery:`, preflight `P.recovery` |
| SC.3 | The operator's go is recorded before the run | `--go` |
| SC.4 | The website never goes down: every probe answer 200, no gap | Q17-probe-start, Q25-probe-grade, C04-probe-start, C13-probe-grade |
| SC.5 | Rolling upgrade: additive migrations under the running release, services one at a time, website-server kept, valid tokens kept | P07-state-baseline, C05-migrate, C09-tokens, C10-rolling-boot, C12-site |
| SV.1 | Identity: `/api/version` and `/version.json` carry the commit and the rc tag | Q26-verify-version, C14-verify-version |
| SV.2 | Smoke status: preflight and readiness green | Q23-ready, C11-ready |
| SV.3 | Product verification, readonly tier | Q27-verify-product, C15-verify-product |
| SV.4 | Log verdict after the release | Q28-log-verdict, C16-log-verdict |
| SV.5 | Row counts only grow; the database did not balloon | Q30-compare-baseline, C18-compare-baseline |
| SV.6 | `~/.env` allowlist, no Docker socket mount, token files 0600 | Q19-env-rewrite, Q31-host-guards, C07-env-rewrite, C19-host-guards |
| SV.7 | Each change the release ships is in place: a feature landed, a bug fixed, a feature retired | the release's version checks (the steps it adds after the template's: Q on stage, C on production) |
| SV.8 | The analyst SDK works against the release: the archive routes answer format 1, a minimal contract smoke with the SDK's own format 1 code from a sparse clone of the release commit calls each route the quickstart uses once (the archive listing, the newest backup's record and the files it lists, verified against their sha256_raw, the reports listing, the newest run's report bytes against the listing's checksum, the run's vintages and one vintage's members) and fails naming the first route that does not answer, parse or verify, and the SDK package tests pass. The full-archive replay is the post-seal report, not a step | Q35-archive-routes, Q36-sdk-quickstart, Q37-sdk-tests, C23-archive-routes, C24-sdk-quickstart, C25-sdk-tests |
| SW.1 | The soak: logs since READY graded | Q32-soak-gate, C20-soak-gate |
| SW.2 | The standing invariants over the soak (§10) | Q29-soak-record, Q33-soak-checks, C17-soak-record, C21-soak-checks |
| SW.3 | The version tag at the cutover's start | C06-version-tag |
| SW.4 | Every container's logs and inspect since READY in the journal | Q34-collect-logs, C22-collect-logs |

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
a red control (`scripts/tests/unit/standing-soak.test.ts`). The runner records the baseline at Q29-soak-record (C17-soak-record on production) and runs the full check over the soak at Q33-soak-checks (C21-soak-checks).

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

The analyst SDK (`packages/analyst-sdk/`) has its own release line (accepted in
[D77](../decisions.md#d77)). Sections 2 to 10 govern platform releases only. None of them applies to an SDK
release. The SDK releases at any cadence, independent of the platform: an SDK tag needs no matching
platform release. The SDK runs on an analyst's machine. Nothing deploys, so it has no QA branch, no
stage run, no rc tag and no production cutover of its own.

**Runner.** The executable form of this section is `scripts/release/runbooks/analyst-sdk.yaml`, run by
`bun --no-env-file scripts/release/sdk-release.ts [--version A.B.C] [--commit <sha>] [--dry-run] [--notes-file <f>]`
(steps in `scripts/release/sdk-release-lib.ts`, issue 1550). It is
not a platform runbook: §5's runner and loader never read it. Its steps run in order: S01-preflight,
S02-branch, S03-gate, S04-tag, S05-tag-guard and S06-release. S02, S04 and S06 are irreversible. The
version defaults to `version` in `packages/analyst-sdk/package.json` at `origin/main`, and the commit
to the `origin/main` tip. The runner stops at the first failure with the step id, the reason and the
rerun command. A rerun reports the steps already done and continues at the first one that is not.
`--dry-run` runs the preflight and every step's read-only done check, and writes nothing.

The runner takes one branch route only: it creates `analyst-sdk/releases-A.B.x` at a commit of
`main`, or fast-forwards it to one. It never force-pushes. A tip that is not an ancestor of the
commit is refused, because a merge or cherry-pick onto an existing SDK release branch needs a pull
request. The operator must hold the admin permission on the repository: the preflight refuses
without it, because the tag push needs it.

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

The guard is `.github/workflows/analyst-sdk-tag-guard.yml`. On a push of an `analyst-sdk-v*` tag it
runs `scripts/check-analyst-sdk-tag.ts`, which refuses a tag whose version differs from
`package.json` or whose commit is not on an `origin/analyst-sdk/releases-*` branch. Both workflows
above carry `analyst-sdk/releases-*` in their push branches, so they run on a push to an SDK release
branch.

**Release notes.** Each tag gets a GitHub release. Its notes state:

1. the archive format it reads (format 1, [D72](../decisions.md#d72));
2. that it replays report payloads computed with its own arithmetic byte for byte, and that payloads
   published before [D78](../decisions.md#d78) replay up to rounding: the same structure, labels and
   nulls, with numbers that differ only in their last bits;
3. the platform tag whose analytics code it matches, when one exists. The SDK and the backend share
   code (D57).

**Install.** An analyst installs a release by its tag:

```sh
git clone --branch analyst-sdk-vA.B.C --depth 1 --filter=blob:none --sparse https://github.com/robotmoney/robotmoney-frontend.git
cd robotmoney-frontend
git sparse-checkout set packages/analyst-sdk
```

## 12. Web content releases

A copy, image or style edit to the web client ships on its own release line (accepted in
[D81](../decisions.md#d81), refining [D54](../decisions.md#d54) and [D70](../decisions.md#d70)).
Sections 2 to 10 govern platform releases. None of them applies to a web content release. It has
no QA branch, no stage run (owner, 2026-11-04), no rc tag, no backup, no migration and no rolling
boot. It changes only what `website-server` serves, through `bun smoke:web` (D54). The platform tag
production runs does not advance.

**Eligibility.** A release is content-only when its tree differs from the commit production's API
runs (`{publicOrigin}/api/version`) only inside `WEB_CONTENT_PATHS` and test paths (below)
(`scripts/lib/website-release.ts`): `frontend/` and the scripts `scripts/static-assembly.sh` runs,
with every relative import they reach. The site build scripts count as content (owner,
2026-11-04). The same list is `bun smoke:web`'s source identity. Any other path, such as
`backend/`, `contract/`, `website-server/nginx.conf`, `bun.lock` or `docker-compose.yml`, makes the
release a platform release: the runner lists every such path and names `bun run release:run`.

**What a named commit may carry beside content.** A main commit often carries a test or a doc
beside its web content (issue 1603). The runner cherry-picks each named commit's
`WEB_CONTENT_PATHS` part and its test paths under `scripts/tests/`. Tests are carried because they
deploy nothing and the web client's own gate runs them: `frontend/test/unit.list` names files under
`scripts/tests/unit`, so leaving one out fails W03 or runs a stale copy. No image copies `scripts/`
wholesale, and `scripts/checks/check-no-test-imports-in-runtime.sh` refuses a runtime import of
it. Other test directories are not carried: `backend/tests/fixtures/regime/*` is seed data the
backend image reads, so a path under `backend/tests/` counts as runtime. It leaves a path out only
when the content cannot depend on it:

- a doc path: `docs/**`;
- a comment-only edit of a JS or TS file that exists before and after the commit: Bun's
  transpiler, which drops comments, gives the same output for both sides. Macros are disabled:
  a macro import never runs and counts as a change.

So the release tree equals production's API commit outside the content and test paths, byte for
byte: production's backend is untouched and the served site equals the tag. Any other path outside
`WEB_CONTENT_PATHS` (runtime code, config, a lockfile, an added or deleted runtime file) refuses the
release at W01, since the content may depend on it. A commit that touches no content path is
refused too. Every carried and left-out path is listed in the run log and in the GitHub release
notes; the left-out ones are also named in the release commit's message.

**Runner.** The executable form of this section is `scripts/release/runbooks/web-content.yaml`, run by
`bun run release:web --commit <main sha> [--commit <main sha>]... [--target prod|stage] [--version A.B.C] [--dry-run]`
(steps in `scripts/release/web-release-lib.ts`, issue 1561). Each `--commit` names a `main` commit to
ship, cherry-picked in the given order. `--target` names the platform target file
(`scripts/release/targets/<name>.json`, default `prod`) for the host, home, instance and public
origin. No target key is added. `--target stage` exists for optional use only. The steps run in
order:

- **W01-preflight** (read only). Each named commit is on `origin/main`, touches a content path,
  and carries nothing else but tests and the paths the rule above leaves out. The runner reads
  production's API commit and cherry-picks the content and test part of each commit in a scratch
  worktree onto `web/releases-A.B.x`, or onto the base when the branch is absent. The commit
  message keeps the `(cherry picked from commit <sha>)` line and names the left-out paths. A
  conflict in a content or test path stops the run. A conflict in a left-out path is resolved to
  the base's content. The version is `--version`, else `frontend/package.json` at the last named
  commit. It must be A.B.C, equal the version in the cherry-picked tree and be above every `web-v*`
  tag. The eligibility base is the last `web-v*` tag below the version when it descends from the API
  commit, else the API commit. The cherry-picked commit must descend from the base, and its tree
  must differ from the base and from the API commit only inside `WEB_CONTENT_PATHS` and test paths. A tag that W08
  rolled back is refused (below). The operator must hold the admin permission on the repository.
  The runner reads the instance's `web/current` and `web/previous` links on the host (read only)
  and reports both. W07's switch makes today's `current` the `previous` that `bun smoke:web
  --rollback` returns to, so W01 refuses when `current` is absent or names no site directory:
  production would have no rollback target. W01 also launches W08's headless browser once (no page
  load) and refuses when it does not start (`bunx playwright install chromium`), so a missing
  browser is never found after the deploy.
- **W02-branch** (irreversible). Push the cherry-picked commit to `web/releases-A.B.x` as a
  fast-forward. A missing branch is created at the base: the commit production's API runs, or the
  last web tag on top of it, so content already shipped stays shipped. After a platform release
  moves production's API commit, the old branch no longer descends from it and W01 refuses it: the
  next web release bumps A.B in `frontend/package.json` on `main` and names that commit too. No pull request, never a
  force push.
- **W03-gate.** The `web-client.yml` push run (job `web-client`) and an `e2e-web.yml`
  `workflow_dispatch` run (job `e2e-web`) on the branch at the commit conclude success. `web-client`
  builds the site and runs the view specs against goldens. `e2e-web` boots a live stack from the
  release tree, whose backend is production's API commit, so it is the one check of the new content
  against the backend it will be served beside. GitHub reads a workflow's triggers from the commit
  it runs on, and the release tree carries production's `.github/`. Production's `web-client.yml`
  has carried `web/releases-*` in its push branches since issue 1561. Its `e2e-web.yml` has no such
  push trigger, but it has `workflow_dispatch`, so the runner dispatches it on the branch once (`gh
  workflow run e2e-web.yml --ref web/releases-A.B.x`) after checking the branch tip is the release
  commit. A dry run never dispatches. W01 refuses up front when the release tree's `web-client.yml`
  lacks the push trigger, its `e2e-web.yml` lacks `workflow_dispatch`, or its `web-tag-guard.yml`
  lacks the `web-v*` tag trigger.
- **W04-tag** (irreversible). `scripts/check-web-tag.ts`'s rule passes, then the annotated tag
  `web-vA.B.C` is pushed. It is cut before the deploy and never moved or deleted.
- **W05-tag-guard.** `.github/workflows/web-tag-guard.yml` passes for the tag.
- **W06-checkout.** Over ssh from the control machine (D61 (4)): clone `{home}/rm-web` when missing,
  fetch the tags, detach at the tag and run `bun install --frozen-lockfile`. It is the runner's own
  checkout, never the platform release checkout.
- **W07-deploy** (irreversible). Record the `api` and worker container ids and the `/api/version`
  body, then run `bun run smoke:web --instance {instance}` from `{home}/rm-web`. It writes no
  database row, runs no migration and restarts no backend service.
- **W08-live-check.** Four checks, in order, and then the backend:
  1. `{publicOrigin}/version.json` reports the tag's version and commit.
  2. **Served content equals the release.** Each changed path under `frontend/public/` is fetched
     at the URL it is served at (`frontend/public/X` at `/X`, with a one-off query so no cache
     answers) and its sha256 must equal the file in the host's `web/current`, which must name this
     release's site. The host's copy is the reference, not git's: the assembly stamps imports with
     `?v=` and prerenders routes, so a served file differs from its source by design. A path the
     release removes must be absent from `web/current`. A changed path the site does not serve (a
     build script, a test, `frontend/package.json`) is skipped and listed.
  3. Every sitemap route answers 200. This is weak on its own: nginx answers an unknown path with
     the SPA shell, 200.
  4. **Browser smoke against production.** From the control machine, a headless Chromium (the
     repository's `@playwright/test`, `scripts/release/web-browser-smoke.ts`, launched with
     Chromium's sandbox on) loads `/`, `/regime`, one swarm member page (a member read from
     `GET /api/swarm/members`), `/early-access`, and the route of each changed view: the first
     candidate route (those, the release tree's sitemap, a session and its subject from
     `GET /api/swarm/sessions`, then the catch-all route `/X` for `views/X.html`) for which the
     release's own `routes.js` `viewFor` names that view. W01 builds the same plan and refuses a
     changed view no route shows, unless `UNROUTED_VIEWS` names it (a fragment the router never
     renders as a page, such as `views/dash/_layout.html`). A page fails on an uncaught page error,
     any `console.error`, a same-origin request that fails or answers 4xx/5xx, the router rendering
     the not-found view, or not reaching the router's ready signal (`<html data-routed>`, set by
     `router.js` once the view is in the DOM; then up to 15 s for network idle). A page with any of
     these fails at once: it is never loaded again to get past a failure. Two things are exempt.
     A media request the browser aborts itself (`net::ERR_ABORTED` on a video or audio preload,
     seen on `/changelog`'s mp4) does not count; any other aborted request does. A same-origin
     `/api/` request that answers 503 (the api's own unavailability: its pool gate's
     `db_saturated`, a statement timeout) excuses only that request, Chrome's "Failed to load
     resource" line for it, and the archive-manifest 404 (`/data/swarm/manifests/`) its page falls
     back to; it never hides a page error, another `console.error`, the not-found view or a missed
     ready signal. On 2026-11-11 production's `GET /api/swarm/members/<handle>` hit Postgres'
     statement timeout now and then (503), and the member page fell back to its archive manifest
     (404). A load whose only fault is such a 503 is inconclusive, and the page is loaded again, up
     to three loads. A page with a clean load passes. A page inconclusive on every load fails W08
     when it shows a changed view (the release's own surface was never seen working); it is a
     warning when it shows none. The whole smoke has 3 minutes. The runner judges the site once per
     W08: the done check's result is the one the step acts on, so a page never gets a second smoke.
     It is read only: it submits no form, and any non-GET request a page makes is answered 204
     inside the browser. Cloudflare's edge scripts (`/cdn-cgi/`: Zaraz, the RUM beacon) are
     answered inside the browser (an empty script, or 204 for a beacon): the release holds none of
     them, and on 2026-11-11 Zaraz's Google Analytics tool broke the site's own CSP (`connect-src`)
     with a `console.error` on every page. `scripts/tests/integration/web-browser-smoke.test.ts`
     proves both against a local server with a real Chromium. W01 launches the browser with the
     same options and refuses when it does not start: on a host with
     `kernel.apparmor_restrict_unprivileged_userns=1` (Ubuntu 24.04) Chromium's sandbox needs an
     AppArmor profile that grants the Playwright Chromium binary `userns`, which only root can
     install. The sandbox is never turned off to get past it. A dry run prints the routes and
     files W08 would check, discovered with GETs only, and loads no page and hashes no file even
     when W07's record exists.

  Last, the `api` and worker container ids and `/api/version` are unchanged. On a failure the
  runner runs `bun run smoke:web --rollback`, reads `/version.json` again to report what production
  now serves, and exits non-zero. The branch and the tag stay; no GitHub release is created.
- **W09-release** (irreversible). The GitHub release for the tag lists the main commits, the
  changed paths and each commit's paths outside the content paths, carried or left out. It is never marked latest: the platform's release keeps that.

The runner stops at the first failure with the step id, the reason and the rerun command. A rerun
reports the steps already done and continues at the first one that is not. `--dry-run` runs the
preflight and every step's read-only done check, and writes nothing to `origin`, GitHub or the host.

**Branch.** A web content release ships from `web/releases-A.B.x`, where A.B comes from
`frontend/package.json`'s own semver. `--version` does not override it: W01 requires the version in
the cherry-picked tree to equal it, so a new version is a `frontend/package.json` bump merged to
`main` and named with `--commit`. The `web/` prefix keeps it off the platform's `releases-*`
glob. Changes reach it from `main` only, by the runner's cherry-picks. Feature PRs never target it.

**Tag.** A release is the tag `web-vA.B.C`, only on a commit of `web/releases-A.B.x`. Its version
equals `version` in `frontend/package.json` at that commit and is above every other `web-v*` tag.
The guard is `.github/workflows/web-tag-guard.yml`, which runs `scripts/check-web-tag.ts` on a push of
a `web-v*` tag. `/version.json` keeps reporting the web client's version and commit.

**Rollback.** A tag is never moved, deleted or cut again. When W08 rolls the site back, the host's
web receipt records it, and a rerun of the same version stops at W01, including when `bun
smoke:web` installed the site under a digest-suffixed id. The fix ships as
`web-vA.B.(C+1)`.
