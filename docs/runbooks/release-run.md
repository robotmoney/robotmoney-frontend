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
```

- The runner prints the full plan first: the target, the commit, the step-list hash and every remote command.
- `--dry-run` prints the plan and stops. It needs no go file.
- `--go <file>` is required for any real run.
- `--from <step>` resumes a run. It needs `--run <run-ts>`. The failed run prints the exact command.
- `--only <step>` runs one step.
- `--run <run-ts>` without `--from` continues at the first step that is not ok.
- `--stage-journal <dir>` is required when the target is `prod`.

## The go file

The go is the operator's one recorded authorization for the release. It names the
release, the commit and the target. A go for anything else refuses.

```text
release: v0.6.0
commit: <40-hex sha>
target: prod
operator: <name>
date: 2026-10-08
```

`operator`, `date` and `note` are optional. Any other key refuses. The journal records
the go file's sha256. A resume must present the same file.

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
| `legacy` | The old stack: checkout, tmux session, compose project, compose files, how it started, version | `/root/robotmoney-frontend`, `driver`, `rm_prod` | `/home/stage-server/rm-stage-legacy`, `stage-driver`, `rm_stage_legacy` |
| `confirmTarget` | `host:port/database`; every write's `--confirm-target` | placeholder | placeholder |
| `bootEnv` | Non-secret boot settings from R6.2a (`WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, the RPC and backfill budgets) | `{}` | `{}` |

`confirmTarget` ships as a placeholder. The runner refuses a live run until it is filled.
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

## The step list

Every step runs as
`cd <checkout> && env HOME=<home> RM_ENV=<rmEnv> <command>` on the target host, or
`cd <capture checkout> && env HOME=<capture home> <command>` on the capture host.
R2.5 alone runs from the legacy checkout, with `HOME` and no `RM_ENV`: the old code
grades the old stack it started. Each step first touches a marker in the run's remote directory. The runner copies back
only the receipts written after that marker.

| Id | Host | Command | Irreversible | Standing |
|---|---|---|---|---|
| R1.1 | target | `git fetch --tags origin`; `git checkout --detach <commit>` | no | SP.1 |
| R1.2 | target | `bun scripts/release/host-identity.ts --commit <sha> --confirm-target <T>` (identity and target precondition) | no | SP.1 |
| R1.3 | target | `bun install --force`; `bun install --force --cwd backend` | no | SP.1 |
| R1.4 | capture | `git fetch --tags origin`; `git checkout --detach <commit>` | no | SP.1 |
| R1.5 | capture | `bun scripts/release/host-identity.ts --commit <sha>` | no | SP.1 |
| R1.6 | capture | `bun install --force`; `bun install --force --cwd backend` | no | SP.1 |
| R2.1 | capture | `bun run smoke:capture --out <capture home>/rm-backup-<target>-<run-ts>` | no | SR.0, SP.2 |
| R2.2 | capture | `sha256sum` of the `.gpg` files into `SHA256SUMS` | no | SP.2 |
| R2.3 | target | `bun scripts/release/baseline.ts --instance <i> --run <run-ts>` | no | SP.3, SP.6 |
| R2.5 | target, legacy checkout | `bun run prod:gate --mode baseline --state-file <legacy>/.agents/smoke-state.json` (the legacy checkout's own gate) | no | SP.5 |
| R6.1 | target | `bun scripts/release/stop-legacy.ts stop …` | **yes** | SC.2 |
| R6.2 | target | `bun scripts/release/env-rewrite.ts --run <run-ts>` | no | SV.6 |
| R6.2b | target | `bun scripts/prod-init.ts enable-owner-login --instance <i> --confirm-target <T>` | no | SC.2 |
| R6.3 | target | `bun run migrate --instance <i> --confirm-target <T>` | **yes** | SC.2 |
| S8.1 | target | `bun scripts/release/stop-legacy.ts retire …` (renames the old checkout to `<path>.v0.5.4-retired`) | no | — |
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
| R7.7 | target | `bun scripts/release/host-guards.ts --instance <i>` | no | SV.6 |

The go file stands for SC.2 (D61 replaces the operator's step-by-step authorization).
The steps the runner does not cover are the manual rows: SP.2's restore proof, SC.1,
SW.1 and SW.3. They stay in the release report.

### The scripts the runner adds

| Script | Step | What it does |
|---|---|---|
| `scripts/release/host-identity.ts` | R1.2, R1.5 | HEAD equals the commit; the tree is clean; `bun`, `docker`, `tmux` and `git` are on the non-interactive `PATH`; `~/.env` resolves to `confirmTarget`; the target precondition holds (R1.2 only) |
| `scripts/release/baseline.ts` | R2.3 | Through `rm_readonly` on a proven read-only session: the ledger, `deployment_identity`, the five roles, migration 0101's would-clear list (the R2.3 query, verbatim), `matchSupportedRelease`, the R2.4 counts and the database size. Refuses an in-house seat in the would-clear list and a ledger that matches no supported baseline |
| `scripts/release/stop-legacy.ts` | R6.1, S8.1 | `stop`: kills the tmux driver, then `docker compose down` from the old checkout, never `-v`, and proves no container of the project remains. `retire`: renames the old checkout |
| `scripts/release/env-rewrite.ts` | R6.2 | Moves every `~/.env` key outside the D61 allowlist to `~/.env.retired-<run-ts>` (mode 0600). Refuses when `rm_owner`, `doadmin` or `RM_CREDENTIALS` is missing. Prints key names only |
| `scripts/release/identity-check.ts` | R7.1 | `/api/version` and `/version.json` carry the commit, with no `+dirty` or `+unknown` |
| `scripts/release/compare-baseline.ts` | R7.5 | Every R2.4 count only grew; the database size is within the bound |
| `scripts/release/host-guards.ts` | R7.7 | No container of the instance mounts a Docker socket; `~/.env` keys are within the allowlist; the three token files are mode 0600 |

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

- **The confirm-target interface is new.** `--confirm-target`, `enable-owner-login`, the `rm_owner` and `doadmin` lines in `~/.env`, and the `prod-init` commands under `RM_ENV=stage` against a `rehearsal` target land in the credentials branch. Steps R6.2b to R6.7c need that branch.
- **`BASE_RPC_URL` has no delivery path.** It stays out of `bootEnv`. A private RPC URL carries its key, and a secret never goes in a process argument. If production uses a private RPC, the boot needs another way to receive it.
- **The legacy stack must be a production boot.** The legacy gate refuses a stack whose `.agents/smoke-state.json` is not a `--db external` boot. On stage, the legacy stack must be booted that way against the stage target's database.
