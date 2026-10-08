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
bun run release:run --target stage --dry-run
bun run release:run --target stage --go ~/go-v0.6.0-stage.txt
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal ~/.local/state/robotmoney-release/stage/<run-ts>
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal <dir> --run <run-ts> --from R6.4
bun run release:run --target stage --go ~/go-v0.6.0-stage.txt --only R7.7
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal <dir> --run <run-ts>   # after the watch window
```

- The runner prints the full plan first: the target, the commit, the step-list hash and every remote command.
- `--dry-run` prints the plan and stops. It needs no go file.
- `--go <file>` is required for any real run.
- `--from <step>` resumes a run. It needs `--run <run-ts>`. The failed run prints the exact command.
- `--only <step>` runs one step.
- `--run <run-ts>` without `--from` continues at the first step that is not ok.
- `--stage-journal <dir>` is required when the target is `prod`.
- A watch step (W1, R7.4a) runs no earlier than R6.9's end plus 6 hours. Reaching it early, the runner stops with exit 3 and prints when it becomes runnable. `--run <run-ts>` resumes it then.

## The go file

The go is the operator's one recorded authorization for the release. It names the
release, the commit, the target and the signed recovery matrix. A go for anything else refuses.

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
unknown key refuses. The committed targets are `prod.json` and `stage.json`.

| Key | Meaning | prod | stage |
|---|---|---|---|
| `release` | The release name the go must match | `v0.6.0` | `v0.6.0` |
| `commit` or `tag` | The release commit (full SHA), or a tag that resolves to it | the release commit | the same commit |
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

Step R1.2 checks the precondition on every target, read-only, through `rm_readonly`:

- the database `~/.env` names answers;
- its ledger equals a supported baseline;
- `deployment_identity` is absent, or holds the kind `RM_ENV` implies (`prod` means `production`, `stage` means `rehearsal`).

With the identity row present, the ledger may also record `0081_deployment_identity.sql`. A remote twin prepared by [`pre-identity-remote-twin.md`](./pre-identity-remote-twin.md) has that shape. A database already migrated by this release fails the check. A failed run resumes with `--from`. It never restarts at R1.

Step R1.2 also proves, before R6.1 stops the legacy stack, the `~/.env` keys the cutover needs later:

- a non-empty `doadmin` line, and a doadmin login with `SELECT 1`. It is read-only. The statement is the registry's provisioning shape `doadminLoginCheck`, declared in `backend/scripts/enable-owner-login.ts`;
- `rm_owner` is optional. Absent, R6.2b generates it. Present, R6.2b keeps it. An empty line refuses. Its password cannot be proven at R1.2: the role is NOLOGIN until R6.2b;
- `RM_CREDENTIALS` is not required. R6.2a writes it.

R6.2 checks `doadmin` and `RM_CREDENTIALS` again, as defence in depth.

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

| Id | Host | Command | Irreversible | Standing |
|---|---|---|---|---|
| R1.1 | target | `git fetch --tags origin`; `git checkout --detach <commit>` | no | SP.1 |
| R1.2 | target | `bun scripts/release/host-identity.ts --commit <sha> --confirm-target <T>` (identity, target precondition, and the cutover's `~/.env` keys: a non-empty `doadmin` line whose login is proven read-only; `rm_owner` optional) | no | SP.1 |
| R1.3 | target | `bun install --force`; `bun install --force --cwd backend` | no | SP.1 |
| R1.4 | capture | `git fetch --tags origin`; `git checkout --detach <commit>` | no | SP.1 |
| R1.5 | capture | `bun scripts/release/host-identity.ts --commit <sha>` | no | SP.1 |
| R1.6 | capture | `bun install --force`; `bun install --force --cwd backend` | no | SP.1 |
| R2.1 | capture | `bun run smoke:capture --out <capture home>/rm-backup-<target>-<run-ts>` | no | SR.0, SP.2 |
| R2.2 | capture | `sha256sum` of the `.gpg` files into `SHA256SUMS` | no | SP.2 |
| R2.4r | capture | `bun scripts/release/restore-proof.ts --dump <R2.1 dir>`: restore into a throwaway local container, record the time, drop it | no | SP.2 |
| R2.3 | target | `bun scripts/release/baseline.ts --instance <i> --run <run-ts>` | no | SP.3, SP.6 |
| R2.5 | target, legacy checkout | `bun run prod:gate --mode baseline --state-file <legacy>/.agents/smoke-state.json` (the legacy checkout's own gate) | no | SP.5 |
| R5.rc | control, prod only | `bun scripts/release/tag.ts rc --release <r> --commit <sha>` (the next free `<r>-rc.N`, unless one points at the commit) | no | — |
| R6.1 | target | `bun scripts/release/stop-legacy.ts stop …` | **yes** | SC.2 |
| R6.2a | target | `bun scripts/release/credentials-init.ts`: the in-house roster's `credential.json` and `RM_CREDENTIALS` (before R6.2 moves the model key out) | no | — |
| R6.2 | target | `bun scripts/release/env-rewrite.ts --run <run-ts>` | no | SV.6 |
| R6.2b | target | `bun scripts/prod-init.ts enable-owner-login --instance <i> --confirm-target <T>` | no | SC.2 |
| R6.3 | target | `bun run migrate --instance <i> --confirm-target <T>` | **yes** | SC.2 |
| S8.1 | target | `bun scripts/release/stop-legacy.ts retire …` (renames the old checkout to `<path>.v0.5.4-retired`, then moves its `.env` secret lines to `~/.env.legacy-retired-<run-ts>` and makes that `.env` 0600) | no | — |
| R6.4 | target | `bun scripts/prod-init.ts set-identity --instance <i> --confirm-target <T>` | no | — |
| R6.5 | target | `bun scripts/prod-init.ts provision-tokens --instance <i> --confirm-target <T>` | no | — |
| R6.7a | target | `PROJECTS_SOURCE=live bun run smoke --static-port --instance <i>` (boot 1) | no | SP.4 |
| R6.7b | target | `bun run smoke:status --instance <i>` | no | SV.2 |
| R6.7c | target | `bun scripts/prod-init.ts rebind-members --instance <i> --confirm-target <T>` | **yes** | — |
| R6.7d | target | `PROJECTS_SOURCE=live bun run smoke --static-port --instance <i>` (boot 2) | no | SP.4 |
| R6.9 | target | `bun run smoke:status --instance <i>` | no | SV.2 |
| R6.10 | target | `bun run smoke:web --instance <i>` | no | — |
| R7.1 | target | `bun scripts/release/identity-check.ts --origin <o> --commit <sha>` | no | SV.1 |
| R7.2 | target | `bun run smoke:status --instance <i>` | no | SV.2 |
| R7.3 | target | `bun run verify:live --instance <i> --emit-receipt=R7.verify` (readonly tier) | no | SV.3 |
| R7.3a | target | `bun run prod:gate --mode post-release --defer-sessions --instance <i>` | no | SV.4 |
| R7.3b | target | `bun run soak:checks --instance <i> --record`; then `--full` | no | SW.2 |
| R7.5 | target | `bun scripts/release/compare-baseline.ts --instance <i> --run <run-ts> --max-size-ratio 1.5` | no | SV.5 |
| R7.7 | target | `bun scripts/release/host-guards.ts --instance <i> --legacy-retired <dir>` | no | SV.6 |
| W1 | target, not before R6.9 + 6 h | `bun run prod:gate --mode post-release --instance <i> --since <R6.9 end>` (sessions graded) | no | SW.1 |
| R7.4a | target, not before R6.9 + 6 h | `bun scripts/release/schedule-parity.ts --instance <i> --run <run-ts>` | no | SW.1 |
| W3 | control, prod only | `bun scripts/release/tag.ts final --release <r> --commit <sha>` | no | SW.3 |

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
| `scripts/release/host-identity.ts` | R1.2, R1.5 | HEAD equals the commit; the tree is clean; `bun`, `docker`, `tmux` and `git` resolve under the fixed `PATH`; no `DATABASE_*` variable was inherited; `~/.env` resolves to `confirmTarget`; the target precondition holds, `~/.env` has a non-empty `doadmin` line and doadmin logs in with `SELECT 1` (R1.2 only) |
| `scripts/release/baseline.ts` | R2.3 | Through `rm_readonly` on a proven read-only session: the ledger, `deployment_identity`, the five roles, migration 0101's would-clear list (the R2.3 query, verbatim), `matchSupportedRelease`, the R2.4 counts and the database size. Refuses an in-house seat in the would-clear list and a ledger that matches no supported baseline |
| `scripts/release/restore-proof.ts` | R2.4r | Restores the run's capture into a throwaway local Postgres container through `scripts/lib/restore-container.ts`, counts its ledger, records the restore time, and always drops the container |
| `scripts/release/stop-legacy.ts` | R6.1, S8.1 | `stop`: kills the tmux driver, then `docker compose down` from the old checkout, never `-v`, and proves no container of the project remains. `retire`: renames the old checkout, then moves its `.env` lines that hold a database URL with a password, `MIGRATE_DATABASE_URL`, `WORKER_DATABASE_URL`, `OPENCODE_API_KEY` or another known secret to `~/.env.legacy-retired-<run-ts>` (0600). Key names only |
| `scripts/release/tag.ts` | R5.rc, W3 | On the control machine: `rc` tags the next free rc at the commit unless one points there; `final` tags the release at the commit, or confirms it already does; each pushes its tag |
| `scripts/release/schedule-parity.ts` | R7.4a | Every active subject has 6 h epochs; every session in flight at R2.3 published within its judging time plus 30 min of its unmoved close; the analytics-producer's regime cron runs at minute 30; reports the last parity sweep and fails a dead one |
| `scripts/release/credentials-init.ts` | R6.2a | Reads the member ids of `athena`, `noop-analyst`, `robot-money` (agents) and `themis` (judge) through `rm_readonly`, and refuses a handle that is missing, not `active` or of the wrong role. Writes `<HOME>/.config/robotmoney/credential.json` (dir 0700, file 0600): one entry per member with a fresh Ed25519 key, the model key from `~/.env`'s `OPENCODE_API_KEY`, and a placeholder bearer that R6.7c replaces. Appends `RM_CREDENTIALS` to `~/.env` when absent. An existing file with the same roster and member ids is kept. A different roster refuses. Prints handles and key names only |
| `scripts/release/env-rewrite.ts` | R6.2 | Moves every `~/.env` key outside the D61 allowlist to `~/.env.retired-<run-ts>` (mode 0600). Refuses when `doadmin` or `RM_CREDENTIALS` is missing. Does not require `rm_owner`: R6.2b runs after it and writes that line when absent. Prints key names only |
| `scripts/release/identity-check.ts` | R7.1 | `/api/version` and `/version.json` carry the commit, with no `+dirty` or `+unknown` |
| `scripts/release/compare-baseline.ts` | R7.5 | Every R2.4 count only grew; the database size is within the bound |
| `scripts/release/host-guards.ts` | R7.7 | No container of the instance mounts a Docker socket; `~/.env` keys are within the allowlist; the three token files are mode 0600; no world-readable file under `HOME` or the retired checkout holds a postgres URL with a password |

The D61 `~/.env` allowlist is `host`, `port`, `database`, `dbname`, `sslmode`, `rm_app`,
`rm_worker`, `rm_readonly`, `rm_owner`, `doadmin`, `RM_ENV`, `RM_CREDENTIALS` and
`COINGECKO_API_KEY`.

## How stage and prod share it

The step list is one constant, `RELEASE_STEPS` in `scripts/release/steps.ts`. It does
not branch on the target. The step-list hash is sha256 over the templates, so it never
sees a target value. The runner prints the hash and records it in the journal.

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
