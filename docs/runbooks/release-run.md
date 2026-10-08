# Release run — the agent-executed runbook runner

> **Authority.** [D61](../decisions.md) (owner, 2026-10-08). Policy:
> [`release-runbooks.md`](../technical/release-runbooks.md). Standing checks:
> [`release-standing-runbook.md`](./release-standing-runbook.md). The steps it runs
> come from [`v0-6-0-rollout.md`](./v0-6-0-rollout.md).

`bun run release:run` executes a release runbook end to end. It runs on the control
machine. Every step runs on a host over ssh. No person logs in to a host.

## What D61 asks, and where the runner does it

| D61 rule | The runner |
|---|---|
| 1. No human in the loop | One go file, read before the run. Nothing prompts during the run |
| 2. Prod is rehearsed unmodified on stage | One step list for every target. Only the target file differs. Prod refuses to start without a passed stage run of the same list at the same commit (SP.8) |
| 3. Every database operation is scripted | Each read or write is a committed script with a receipt. No step runs `psql` |
| 4. Everything runs from the control machine | Each step is `ssh -T -o BatchMode=yes <host> '<command>'` with stdin closed |

## Commands

```bash
bun run release:run --target prod  --preflight [--go ~/go-v0.6.0-prod.txt] [--triage <file>] [--stage-journal <dir>]
bun run release:run --target stage --go ~/go-v0.6.0-stage.txt
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal ~/.local/state/robotmoney-release/stage/<run-ts>
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal <dir> --run <run-ts> --from R6.4
bun run release:run --target stage --go ~/go-v0.6.0-stage.txt --only R7.7
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal <dir> --run <run-ts>   # after the watch window
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal <dir> --after-preflight ~/.local/state/robotmoney-release/prod/preflight-<ts>
bun run release:run --target stage --abandon <run-ts>   # a run killed mid-step still reads running; mark it failed
```

- The runner prints the full plan first: the target, the commit, the step-list hash and every remote command.
- `--preflight` checks everything the run needs, before the go. `--dry-run` is the same flag. It needs no go file. It changes nothing a running service uses, on any host. It exits 0 only when no check is red. See [the preflight](#the-preflight).
- `--go <file>` is required for any real run.
- `--from <step>` resumes a run. It needs `--run <run-ts>`. The failed run prints the exact command.
- `--only <step>` runs one step.
- `--run <run-ts>` without `--from` continues at the first step that is not ok.
- `--stage-journal <dir>` is required when the target is `prod`.
- `--after-preflight <dir>` continues from a green preflight ended within the last 60 minutes, at the same commit and step list. The run takes the preflight's run stamp. R1.1 to R2.5 are its records, so the run starts at R5.rc with one dump, not two. An older or red preflight refuses.
- `--abandon <run-ts>` marks a run that still reads `running` as failed, step by step, with the time. A run killed mid-step never ends on its own. Until it is abandoned, the preflight's `P.busy` is red.
- Every step has a bound (`maxMinutes` in `steps.ts`, 10 by default; the dump 30, the restore proof 20, each boot 15). Past it the runner kills its ssh, records `timed out`, and stops. The remote command may still run to its end, so look at the host before a resume.
- R1.4 to R1.6 repeat R1.1 to R1.3 on the capture host. When the capture host and checkout are the target's (stage), they are recorded `skipped: same checkout as R1.x`. On prod the hosts differ, so they run.
- The journal records `downtimeSeconds`, R6.1's start to R6.9's end. Stage run `20261008T042158Z` measured 149 s. The recovery matrix names the ceiling.
- A watch step (W1, R7.4a) runs no earlier than R6.9's end plus the target's `watchHours` (10 h on prod, 15 min on stage). Reaching it early, the runner stops with exit 3 and prints when it becomes runnable. `--run <run-ts>` resumes it then.
- The target's `watchSessions` says how the watch treats sessions. It renders as `--sessions graded` or `--sessions deferred` on W1 and R7.4a. Prod is always `graded`. Stage is `deferred` (owner decision 2026-10-08): its watch is a 15-minute check, and no 6 h epoch closes in 15 minutes. Stage epochs stay 6 h.
- Why 10 h on prod: W1 needs every subject to publish one good session after READY. A subject with no open window at boot gets a first epoch, which lasts up to 1.5 epochs (system-scheduler-spec §2.2). That is 9 h at 6 h epochs. Judging (15 min) and R7.4a's publish grace (30 min) bring it to 9.75 h, rounded up. `scripts/release/watch.ts` derives it. The old 6 h watch failed check 7 on stage run `20261008T042158Z`: treasury and woon were still collecting.


## The preflight

`scripts/release/preflight.ts`. Run it first, on any target, as often as you like. Each check reads green, red, pending or blocked.

| Check | Green when |
|---|---|
| `P.target` | `confirmTarget` is filled in |
| `P.go` | the go file is valid for this release and target. Pending without `--go` |
| `P.recovery` | the go's signed recovery matrix is readable (SC.1). Pending without `--go` |
| `P.commit` | the commit is the control checkout's clean HEAD. Without a go, HEAD is the candidate commit the go must name |
| `P.origin` | the commit is on a branch of origin |
| `P.ci` | every check run on the commit completed green, and `e2e`, `unit`, `backend`, `integration`, `contract`, `web-client`, `repo-guards` and `docs-lint` are present (R0, SP.7) |
| `P.stage` | prod only: a passed stage run of this step list at this commit exists (SP.8). It names the directory to pass as `--stage-journal` |
| `P.live.target`, `P.live.capture` | no running container on the host was started from the release checkout |
| P.busy | no run of this target still reads `running` under the journal root (`--abandon` clears a dead one) |
| R1.1 to R2.5 | the step passes, run exactly as the run runs it. R2.5 takes `--triage` the same way |

The remote steps are every step before the first irreversible one, minus the control machine's rc tag. They check out and install the release checkout, capture a fresh dump from the read replica into a new directory, restore it into a throwaway container, and read the database and the legacy logs. None stops a service or writes a database.

They run lane by lane. A lane is one host and one checkout path. The cheap lanes go first: the legacy gate R2.5 (10 s), then the target checkout R1.1 to R1.3 and R2.3 (20 s), then the capture lane with its dump and restore proof (10 min). A red R2.5 shows in seconds. Within a lane the run's order holds. A failed step blocks the rest of its lane. On stage the target and capture lanes are one directory, so they are one lane.

The journal is `~/.local/state/robotmoney-release/<target>/preflight-<ts>/`: `preflight.json`, `plan.txt` with every remote command, and each step's logs and receipts. It is never a run journal: SP.8 and `--run` refuse it.

A green preflight is the evidence the owner reads before writing the go. A run started within the hour continues from it with `--after-preflight`. A later run repeats R1.1 to R2.5.
## The go file

The go is the operator's one recorded authorization for the release. It names the
release, the commit, the target and the signed recovery matrix. A go for another release or target refuses.

The go is the only place the release commit is named. The target files name none. The runner
renders every `{commit}` (R1.1, R1.2, R1.4, R1.5, R5.rc, R7.1, W3) from the go's `commit:` line.
A new commit after a QA fix means a new go file, never a commit to the target files. SP.8 still
refuses a prod go whose commit differs from the passed stage run's commit.

```text
release: v0.6.0
commit: <40-hex sha>
target: prod
recovery: ~/recovery-matrix-v0.6.0.signed.md
operator: <name>
date: 2026-10-08
```

`recovery` is required (standing check SC.1). It is the path of the signed recovery
matrix (runbook section 8), or that file's sha. A path must be readable on the control
machine. The journal records its sha256. `operator`, `date` and `note` are optional.
Any other key refuses. The journal records the go file's sha256. A resume must present
the same file.

## Target files

A target file is `scripts/release/targets/<name>.json`. The schema is closed: an
unknown key refuses. The committed targets are `prod.json` and `stage.json`. A target names no
release commit: a top-level `commit` or `tag` refuses, because the go file names it.
`legacy.commit` stays: it is the old stack's commit, not the release.

| Key | Meaning | prod | stage |
|---|---|---|---|
| `release` | The release name the go must match | `v0.6.0` | `v0.6.0` |
| `rmEnv` | `stage` or `prod` | `prod` | `stage` |
| `host` | The ssh host alias | `rm-frontend-prod-1` | `rm-frontend-stage-2` |
| `checkout` | The release checkout on the host | `/root/rm-060` | `/home/stage-server/rm-stage-target` |
| `home` | `HOME` for every command; its `.env` is the target's credential file | `/root` | `/home/stage-server/stage-target` |
| `instance` | The smoke instance | `rm_prod` | `stage_target` |
| `publicOrigin` | The origin R7.1 checks | `https://robotmoney.network` | `https://stage.robotmoney-labs.dev` |
| `capture` | Capture host, its `HOME` and its checkout | `rm-frontend-stage-2` | `rm-frontend-stage-2` |
| `legacy` | The old stack: checkout, commit, tmux session, compose project, compose files, how it started, its log, version | `/root/robotmoney-frontend` at `1cda4085`, `driver`, `rm_prod`, `/root/smoke-archive-v0.5.4.log` | `/home/stage-server/rm-stage-legacy` at `1cda4085`, `stage-driver`, `stage_target`, `/home/stage-server/stage-target/smoke-archive-v0.5.4.log` |
| `confirmTarget` | `host:port/database`; every write's `--confirm-target` | the primary's `host:25060/defaultdb` | `172.17.0.1:25060/defaultdb` |
| `watchMinAttendance` | W1's `--min-attendance` | 0.5 (default) | 0.4: the external members never file against stage |
| `watchHours` | Hours after R6.9 before W1 and R7.4a run. Prod, and any target that grades sessions, may set it longer, never below the derived 10 h. A target that defers sessions may set any positive value | 10 (default) | 0.25 (15 min, owner decision 2026-10-08) |
| `watchSessions` | `graded` or `deferred`, rendered as W1's and R7.4a's `--sessions`. `graded`: W1 check 7 needs every subject to publish one good session, and R7.4a needs every session in flight at R2.3 to publish on its normal close. `deferred`: W1 skips check 7, and R7.4a checks only that no in-flight session vanished or had its close moved. Prod must be `graded` | `graded` (default) | `deferred` |
| `bootEnv` | Non-secret boot settings from R6.2a (`WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, the RPC and backfill budgets) | `{}` | `{}` |

Both legacy stacks were started by `SMOKE_PROJECT=<project> bun run smoke:archive -- --no-tui`
(`bun scripts/smoke.ts --smoke --static-port --db external`) in their tmux session.

A placeholder `confirmTarget` refuses a live run.
Step R1.2 resolves `host:port/database` from the host's `~/.env` and refuses a
different value. `bootEnv` refuses `BASE_RPC_URL`: a private RPC URL carries its key,
and a secret never goes in a process argument.

## Target preconditions

A release run does not create its database. The database exists before the run.

- **Production.** The production database exists. The legacy stack runs from the legacy checkout.
- **Stage.** `scripts/release/stage-target.ts up --dump <dir>` sets the stage target up before the run. It restores a production dump into the stage target's database. This is target setup, as production's database is. It is not a step.
- **Role passwords, both targets.** `bun run role-passwords --target <stage|prod>` runs on the control machine before the run. It is provisioning, not a runbook step. It is idempotent. As `doadmin` it sets the four role passwords and `rm_owner`'s `LOGIN`, and it writes each missing role line of the host's `~/.env`. The admin types the `doadmin` password at its hidden prompt. That is the one human input of the release process. The password goes to the host over ssh stdin and lives only in process memory. It is never stored in a file. No release step reads `doadmin` (D61 amendment, owner, 2026-10-08).
  - It asks for the `doadmin` password at a hidden prompt, or reads one line from its stdin with `--doadmin-stdin`. It passes the password to `bun scripts/prod-init.ts role-passwords --confirm-target <T> --doadmin-stdin` on the host over ssh's stdin. The password is never stored in a file, an argument, an environment variable or any output, on either machine.
  - For each of `rm_owner`, `rm_app`, `rm_worker` and `rm_readonly`, a `~/.env` line that logs in is `kept` and no `ALTER` runs. An absent line is `set`: the host generates a password and sends the server only its SCRAM-SHA-256 verifier. The host then writes `<role> = <password>` into `~/.env` (atomic, 0600) and proves the login. A line that does not log in refuses. Only `--rotate <role>` replaces a line, and it keeps the old one in `~/.env.retired-<ts>` (0600). An empty `<role>=` line refuses. `rm_owner` also becomes `LOGIN`. A runtime role's attributes never change.
  - A rerun reports every role `kept`. The receipt (`prod-init/role-passwords-*.json`) lists role → `kept`, `set` or `rotated`, never a value.
  - Never pass `--rotate` for a runtime role while the legacy stack runs: it would lock the legacy stack out.
  - Stage runs it the same way, fed by the disposable stage credential. The stage sequence is production's:
    1. `bun scripts/release/stage-target.ts up --dump <dir>`;
    2. `bun scripts/release/stage-target.ts doadmin | bun run role-passwords --target stage --doadmin-stdin`;
    3. `bun run release:run --target stage`.

    Production has no `stage-target doadmin`: there the admin types the password at the prompt.

Step R1.2 checks the database precondition on every target, read-only, through `rm_readonly`:

- the database `~/.env` names answers;
- its ledger equals a supported baseline;
- `deployment_identity` is absent, or holds the kind `RM_ENV` implies (`prod` means `production`, `stage` means `rehearsal`).

With the identity row present, the ledger may also record `0081_deployment_identity.sql`. A remote twin prepared by [`pre-identity-remote-twin.md`](./pre-identity-remote-twin.md) has that shape. A database already migrated by this release fails the check. A failed run resumes with `--from`. It never restarts at R1.

Step R1.2 also proves, before R6.1 stops the legacy stack, what the cutover needs later:

- a non-empty `rm_owner` line in `~/.env`;
- an `rm_owner` login with `SELECT 1`. It is read-only. The statement is the registry's object-less `connectionCheck` shape, declared as `rm_owner` in `backend/scripts/owner-login-check.ts`. A failure refuses with "rm_owner cannot log in; run `bun run role-passwords --target <target>` first";
- `RM_CREDENTIALS` is not required. R6.2a writes it.

R6.2 checks `rm_owner` and `RM_CREDENTIALS` again, as defence in depth. The migrate (R6.3) and the later steps use `rm_owner` from `~/.env`.

## The step list

Every remote step runs as
`cd <checkout> && env -i HOME=<home> PATH=<fixed PATH> LANG=C.UTF-8 RM_ENV=<rmEnv> <command>`
on the target host, or the same without `RM_ENV` from the capture checkout on the capture
host. `env -i` drops everything the login shell exports. Production's `/etc/environment`
exports a `doadmin` `DATABASE_URL` and its parts, and stage's does not. With `env -i` no
command sees either. The only other variables are the step's own (`PROJECTS_SOURCE=live`
and `bootEnv` for the boots). The fixed PATH is
`/root/.bun/bin:/home/stage-server/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`.
It is part of the template, so the hash covers it. R1.2 and R1.5 record where `bun`,
`docker`, `tmux` and `git` resolve under it, and refuse a command that inherited a
`DATABASE_*` variable.

R2.5 alone runs from the legacy checkout, with no `RM_ENV`: the old code grades the old
stack it started. Control steps (R5.rc, W3) run on the control machine from the runner's
own checkout. Each remote step first touches a marker in the run's remote directory. The
runner copies back only the receipts written after that marker.

The table below is generated from `scripts/release/steps.ts` by `bun scripts/release/steps-table.ts --write docs/runbooks/release-run.md`. The docs lint fails when it is stale.

<!-- steps-table:begin -->
| Id | Host | Does | Command | Irreversible | Bound | Standing |
|---|---|---|---|---|---|---|
| R1.1 | target | Target checkout: fetch, then detach at the release commit | `git fetch --tags origin`; `git -c advice.detachedHead=false checkout --detach {commit}` | no | 10 min | SP.1 |
| R1.2 | target | Target identity and precondition: HEAD is the commit, the tree is clean, the tools exist, ~/.env resolves to confirmTarget, the database answers, its ledger is a supported baseline, its identity is absent or matches RM_ENV; before R6.1, ~/.env holds a non-empty rm_owner line and rm_owner logs in (SELECT 1, read-only; refuses with "run bun run role-passwords --target <target> first"); no release step reads doadmin; RM_CREDENTIALS is not required (R6.2a writes it) | `bun scripts/release/host-identity.ts --commit {commit} --confirm-target {confirmTarget} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SP.1 |
| R1.3 | target | Target install: bun install --force, root and backend | `bun install --force`; `bun install --force --cwd backend` | no | 10 min | SP.1 |
| R1.4 | capture; skipped when it is R1.1's checkout | Capture checkout: fetch, then detach at the release commit | `git fetch --tags origin`; `git -c advice.detachedHead=false checkout --detach {commit}` | no | 10 min | SP.1 |
| R1.5 | capture; skipped when it is R1.2's checkout | Capture identity: HEAD is the commit and the tree is clean | `bun scripts/release/host-identity.ts --commit {commit} --receipt-dir {captureHome}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SP.1 |
| R1.6 | capture; skipped when it is R1.3's checkout | Capture install: bun install --force, root and backend | `bun install --force`; `bun install --force --cwd backend` | no | 10 min | SP.1 |
| R2.1 | capture | Fresh capture from production's read replica into a new dated directory (never a reused dump) | `bun run smoke:capture --out {captureHome}/rm-backup-{target}-{runTs}` | no | 30 min | SR.0, SP.2 |
| R2.2 | capture | Record the sha256 of the encrypted dump files beside the manifest | `sh -c cd {captureHome}/rm-backup-{target}-{runTs} && sha256sum -- *.gpg > SHA256SUMS` | no | 10 min | SP.2 |
| R2.4r | capture | Restore proof: restore the R2.1 dump into a throwaway local Postgres container, record the restore time, drop the container | `bun scripts/release/restore-proof.ts --dump {captureHome}/rm-backup-{target}-{runTs} --receipt-dir {captureHome}/.local/state/robotmoney-release/{target}/{runTs}` | no | 20 min | SP.2 |
| R2.3 | target | Baseline through rm_readonly: ledger, identity, roles, migration 0101's would-clear list, supported-baseline match, R2.4 counts and size | `bun scripts/release/baseline.ts --instance {instance} --run {runTs}` | no | 10 min | SP.3, SP.6 |
| R2.5 | target, legacy checkout | Log baseline of the running legacy stack, graded by the legacy checkout's own prod:gate (its .agents/smoke-state.json names the stack) | `bun run prod:gate --mode baseline --state-file {legacyCheckout}/.agents/smoke-state.json --report {home}/.local/state/robotmoney-release/{target}/{runTs}/prod-gate-baseline.md` | no | 10 min | SP.5 |
| R5.rc | control, prod only | Tag the release candidate at the commit (the next free <release>-rc.N) unless one already points there; push it | `bun scripts/release/tag.ts rc --release {release} --commit {commit}` | no | 10 min | — |
| R6.1 | target | Stop the legacy stack: its tmux driver, then docker compose down (never -v); prove no legacy container remains | `bun scripts/release/stop-legacy.ts stop --session {legacySession} --project {legacyProject} --legacy-checkout {legacyCheckout} --compose-files {legacyComposeFiles} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | **yes** | 10 min | SC.2 |
| R6.2a | target | Write the in-house roster's credential.json (fresh keys, the model key from ~/.env, placeholder bearers for R6.7c) and RM_CREDENTIALS; an existing file with the same roster is kept | `bun scripts/release/credentials-init.ts --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | — |
| R6.2 | target | Rewrite ~/.env to the D61 allowlist (rm_owner, never doadmin); every other key, a stray doadmin line included, moves to ~/.env.retired-<ts> (mode 0600); refuses without rm_owner or RM_CREDENTIALS; key names only | `bun scripts/release/env-rewrite.ts --run {runTs} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SV.6 |
| R6.3 | target | The first migrate: 0081 first with the identity RM_ENV implies, then every pending file | `bun run migrate --instance {instance} --confirm-target {confirmTarget}` | **yes** | 10 min | SC.2 |
| S8.1 | target | Rename the legacy checkout to <path>.<version>-retired, then move its .env secrets (database URLs, model keys) to ~/.env.legacy-retired-<ts> and make that .env 0600 | `bun scripts/release/stop-legacy.ts retire --legacy-checkout {legacyCheckout} --version {legacyVersion} --run {runTs} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | — |
| R6.4 | target | Report the deployment identity the migrate wrote (prod-init set-identity) | `bun scripts/prod-init.ts set-identity --instance {instance} --confirm-target {confirmTarget}` | no | 10 min | — |
| R6.5 | target | Mint the three service tokens (prod-init provision-tokens) | `bun scripts/prod-init.ts provision-tokens --instance {instance} --confirm-target {confirmTarget}` | no | 10 min | — |
| R6.7a | target | Boot 1: bun smoke --static-port (preflight, replace, readiness, exit) | `bun run smoke --static-port --instance {instance}` | no | 15 min | SP.4 |
| R6.7b | target | Status after boot 1 | `bun run smoke:status --instance {instance}` | no | 10 min | SV.2 |
| R6.7c | target | One-time credential migration: rebind the in-house members to credential.json (one-way) | `bun scripts/prod-init.ts rebind-members --instance {instance} --confirm-target {confirmTarget}` | **yes** | 10 min | — |
| R6.7d | target | Boot 2: a new plan that recreates the participants on the new bearers | `bun run smoke --static-port --instance {instance}` | no | 15 min | SP.4 |
| R6.9 | target | Status after boot 2: the receipt as history, the daemon as now | `bun run smoke:status --instance {instance}` | no | 10 min | SV.2 |
| R6.10 | target | Site: bun smoke:web (refuses a site whose apiRange excludes the api) | `bun run smoke:web --instance {instance}` | no | 10 min | — |
| R7.1 | target | Identity: /api/version and /version.json carry the release commit, no +dirty or +unknown | `bun scripts/release/identity-check.ts --origin {publicOrigin} --commit {commit} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SV.1 |
| R7.3 | target | Product verification, readonly tier | `bun run verify:live --instance {instance} --emit-receipt=R7.verify` | no | 10 min | SV.3 |
| R7.3a | target | Log verdict after the release (sessions graded later: the first one publishes hours after the cutover) | `bun run prod:gate --mode post-release --defer-sessions --instance {instance} --report {home}/.local/state/robotmoney-release/{target}/{runTs}/prod-gate-post-release.md` | no | 10 min | SV.4 |
| R7.3b | target | Standing soak checks: record the baseline at READY, then the full run | `bun run soak:checks --instance {instance} --record --report {home}/.local/state/robotmoney-release/{target}/{runTs}/soak-record.md`; `bun run soak:checks --instance {instance} --full --report {home}/.local/state/robotmoney-release/{target}/{runTs}/soak-full.md` | no | 10 min | SW.2 |
| R7.5 | target | Compare with the R2.3 baseline: row counts only grow, database size within the bound | `bun scripts/release/compare-baseline.ts --instance {instance} --run {runTs} --max-size-ratio 1.5` | no | 10 min | SV.5 |
| R7.7 | target | Host guards: no container mounts docker.sock, ~/.env keys within the allowlist, token files 0600, no world-readable file under home or the retired checkout holds a postgres URL with a password | `bun scripts/release/host-guards.ts --instance {instance} --legacy-retired {legacyCheckout}.{legacyVersion}-retired --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SV.6 |
| W1 | target, not before R6.9 + `watchHours` | The watch since READY: prod:gate post-release with sessions as the target's watchSessions says (prod graded: every subject publishes a judged session, the judge never restarted; stage deferred) | `bun run prod:gate --mode post-release --instance {instance} --since {readyIso} --min-attendance {watchMinAttendance} --sessions {watchSessions} --report {home}/.local/state/robotmoney-release/{target}/{runTs}/prod-gate-watch.md` | no | 10 min | SW.1 |
| R7.4a | target, not before R6.9 + `watchHours` | Schedule parity: 6 h epochs, every session in flight at R2.3 published on its normal close (graded; deferred checks only that no close moved), the regime run at :30, the last parity sweep's duration | `bun scripts/release/schedule-parity.ts --instance {instance} --run {runTs} --sessions {watchSessions} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SW.1 |
| W3 | control, prod only | Tag the running commit with the release tag and push it (prod only) | `bun scripts/release/tag.ts final --release {release} --commit {commit}` | no | 10 min | SW.3 |
<!-- steps-table:end -->

The go file stands for SC.1 (its `recovery` key) and SC.2 (D61 replaces the operator's
step-by-step authorization). Every standing row of the cutover has a step.

### The one target difference: the release tags

R5.rc and W3 tag the release. They carry `onlyFor: "prod"` in the template. A stage run
records each as `skipped: stage` and tags nothing. The skip is data in the one list, not
a second list, so the step-list hash is the same for stage and prod. A skipped step
counts as done for the run's status and for SP.8. No other step differs by target.

### The scripts the runner adds

| Script | Step | What it does |
|---|---|---|
| `scripts/release/host-identity.ts` | R1.2, R1.5 | HEAD equals the commit; the tree is clean; `bun`, `docker`, `tmux` and `git` resolve under the fixed `PATH`; no `DATABASE_*` variable was inherited; `~/.env` resolves to `confirmTarget`; the target precondition holds, `~/.env` has a non-empty `rm_owner` line and `rm_owner` logs in with `SELECT 1` (R1.2 only) |
| `scripts/release/baseline.ts` | R2.3 | Through `rm_readonly` on a proven read-only session: the ledger, `deployment_identity`, the five roles, migration 0101's would-clear list (the R2.3 query, verbatim), `matchSupportedRelease`, the R2.4 counts and the database size. Refuses an in-house seat in the would-clear list and a ledger that matches no supported baseline |
| `scripts/release/restore-proof.ts` | R2.4r | Restores the run's capture into a throwaway local Postgres container through `scripts/lib/restore-container.ts`, counts its ledger, records the restore time, and always drops the container |
| `scripts/release/stop-legacy.ts` | R6.1, S8.1 | `stop`: kills the tmux driver, then `docker compose down` from the old checkout, never `-v`, and proves no container of the project remains. `retire`: renames the old checkout, then moves its `.env` lines that hold a database URL with a password, `MIGRATE_DATABASE_URL`, `WORKER_DATABASE_URL`, `OPENCODE_API_KEY` or another known secret to `~/.env.legacy-retired-<run-ts>` (0600). Key names only |
| `scripts/release/tag.ts` | R5.rc, W3 | On the control machine: `rc` tags the next free rc at the commit unless one points there; `final` tags the release at the commit, or confirms it already does; each pushes its tag |
| `scripts/release/schedule-parity.ts` | R7.4a | Every active subject has 6 h epochs; every session in flight at R2.3 published within its judging time plus 30 min of its unmoved close (with `--sessions deferred`: only that each still exists with its close unmoved); the analytics-producer's regime cron runs at minute 30; reports the last parity sweep and fails a dead one |
| `scripts/release/credentials-init.ts` | R6.2a | Reads the member ids of `athena`, `noop-analyst`, `robot-money` (agents) and `themis` (judge) through `rm_readonly`, and refuses a handle that is missing, not `active` or of the wrong role. Writes `<HOME>/.config/robotmoney/credential.json` (dir 0700, file 0600): one entry per member with a fresh Ed25519 key, the model key from `~/.env`'s `OPENCODE_API_KEY`, and a placeholder bearer that R6.7c replaces. Appends `RM_CREDENTIALS` to `~/.env` when absent. An existing file with the same roster and member ids is kept. A different roster refuses. Prints handles and key names only |
| `scripts/release/env-rewrite.ts` | R6.2 | Moves every `~/.env` key outside the D61 allowlist to `~/.env.retired-<run-ts>` (mode 0600). A stray `doadmin` line moves too. Refuses when `rm_owner` or `RM_CREDENTIALS` is missing. Prints key names only |
| `scripts/release/identity-check.ts` | R7.1 | `/api/version` and `/version.json` carry the commit, with no `+dirty` or `+unknown` |
| `scripts/release/compare-baseline.ts` | R7.5 | Every R2.4 count only grew; the database size is within the bound |
| `scripts/release/host-guards.ts` | R7.7 | No container of the instance mounts a Docker socket; `~/.env` keys are within the allowlist; the three token files are mode 0600; no world-readable file under `HOME` or the retired checkout holds a postgres URL with a password |

The D61 `~/.env` allowlist is `host`, `port`, `database`, `dbname`, `sslmode`, `rm_app`,
`rm_worker`, `rm_readonly`, `rm_owner`, `RM_ENV`, `RM_CREDENTIALS` and
`COINGECKO_API_KEY`. `doadmin` is not on it: preflight check 4 refuses a `doadmin` line on prod.

## How stage and prod share it

The step list is one constant, `RELEASE_STEPS` in `scripts/release/steps.ts`. It does
not branch on the target. The step-list hash is sha256 over the templates, so it never
sees a target value. The watch steps' `notBefore` is in the hash as `{ afterStep: "R6.9", hours: "watchHours" }`, so changing the wait's form changes the hash, while a target's `watchHours` does not. W1 and R7.4a carry `--sessions {watchSessions}` as a template word, so stage's `deferred` and prod's `graded` give the same hash. The runner prints the hash and records it in the journal.

A stage run that passes every step leaves a journal with that hash and the commit.
Production refuses to start unless `--stage-journal` names such a journal (standing
check SP.8). A different hash, a different commit, a failed or missing step, or a
journal from a prod run all refuse.

## Triage of the baseline gate

R2.5 grades the running legacy stack before anything changes. A failure there is
what is already broken, and each one is an owner decision before the cutover. The
decision is a triage file, passed with `--triage <file>`:

```text
# check | fragment of the gate's detail line | reason, issue or decision
jobs | model_unavailable:judge model responded 402 | Zen balance empty until the 2026-10-08 top-up
```

- Only R2.5 reads it. A post-release gate never does.
- R2.5 passes on a non-zero exit only when every detail line of every `FAIL` check in the
  gate's JSON report contains the fragment of an entry for that check.
- A finding the file does not name still stops the run, and the runner lists it.
- The journal records the file's path, its sha256 and the entries it used.
- The triage file is not the go. A run resumes with a new triage and the same go.

## The journal

The runner journals on the control machine under
`~/.local/state/robotmoney-release/<target>/<run-ts>/`.

- `run.json` holds the target, the commit, the step-list hash, the go's sha256 and each step's outcome.
- `<step>/stdout.log` and `<step>/stderr.log` hold the step's output.
- `<step>/result.json` holds the exit code, the timings and the receipts.
- `<step>/receipts/` holds the receipts copied back from the host.

The runner stops at the first step whose exit differs from the expected exit, or whose
required receipt is missing. It prints the resume command. Past an irreversible step it
also points at the recovery matrix (runbook section 8).

## Secrets

The runner never knows a secret. It scrubs output and receipts by shape before they
reach the console or the journal: a known secret key with a value, a postgres URL
password and a bearer token. It never copies back a token file, a role-password file,
an `.env` file, a credential file, a passphrase or a dump.

## Open items on 2026-10-08

- **`git fetch` runs with the target's `HOME`.** On stage that is `/home/stage-server/stage-target`. A credential helper or `.gitconfig` in the login home is not seen there. R1.1 fails loudly if the fetch needs one.
- **`BASE_RPC_URL` has no delivery path.** It stays out of `bootEnv`. A private RPC URL carries its key, and a secret never goes in a process argument. If production uses a private RPC, the boot needs another way to receive it.
- **The legacy stack must be a production boot.** The legacy gate refuses a stack whose `.agents/smoke-state.json` is not a `--db external` boot. On stage, the legacy stack must be booted that way against the stage target's database.
