# Release run — the agent-executed runbook runner

> **Authority.** [D61](../decisions.md) (owner, 2026-10-08), amended for issue 1272
> (the runner holds no past-upgrade fact). Policy:
> [`release-runbooks.md`](../technical/release-runbooks.md). Standing checks:
> [`release-standing-runbook.md`](./release-standing-runbook.md). The live delta runbook is
> the newest `vX-Y-Z-rollout.md` ([`v0-6-2-rollout.md`](./v0-6-2-rollout.md) today): it holds
> only what that release changes. The step ids keep the shape
> [`v0-6-0-rollout.md`](./v0-6-0-rollout.md) introduced; that runbook and
> [`v0-6-1-rollout.md`](./v0-6-1-rollout.md) are history and the tool reads nothing from them.

`bun run release:run` executes a release runbook end to end. It runs on the control
machine. Every step runs on a host over ssh. No person logs in to a host.

The same step list runs any patch from the version production actually runs, with no
per-release code edit. The runner reads the running system: the ledger from the database,
reconciled by filename set against `backend/migrations`; the running stack from the host's
smoke state and from `/api/version`; the pending set as the repository minus the ledger. It
holds no fact of a past upgrade: no supported-baseline constant, no previous commit, no tmux
session, no one-time cutover step. A release that needs a one-time action declares it as a
[delta step](#delta-steps) in its own delta runbook.

## What D61 asks, and where the runner does it

| D61 rule | The runner |
|---|---|
| 1. No human in the loop | One go file, read before the run. Nothing prompts during the run |
| 2. Prod is rehearsed unmodified on stage | One step list for every target. Only the target file differs. Prod refuses to start without a passed stage run of the same list at the same commit (SP.8). Stage runs a `releases-A.B.x` commit; the rc is cut there once stage passes; prod runs only by that rc tag (D64) |
| 3. Every database operation is scripted | Each read or write is a committed script with a receipt. No step runs `psql` |
| 4. Everything runs from the control machine | Each step is `ssh -T -o BatchMode=yes <host> '<command>'` with stdin closed |

## Commands

```bash
bun run release:run --target prod  --preflight [--go ~/go-v0.6.0-prod.txt] [--triage <file>] [--stage-journal <dir>]
bun run release:run --target stage --go ~/go-v0.6.0-stage.txt
bun scripts/release/tag.ts rc --release v0.6.0 --commit <the stage run's commit>   # after the stage run passed: cut the rc the production go names (D64)
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal ~/.local/state/robotmoney-release/stage/<run-ts>
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal <dir> --run <run-ts> --from R6.4
bun run release:run --target stage --go ~/go-v0.6.0-stage.txt --only R7.7
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal <dir> --run <run-ts>   # after the watch window
bun run release:run --target prod  --go ~/go-v0.6.0-prod.txt --stage-journal <dir> --after-preflight ~/.local/state/robotmoney-release/prod/preflight-<ts>
bun run release:run --target stage --abandon <run-ts>   # a run killed mid-step still reads running; mark it failed
bun run release:run --target prod  --run <run-ts> --accept R7.3a --reason "boot-race line, stack healthy" --issue 1280   # record the owner's acceptance of one failed step
```

- The runner prints the full plan first: the target, the commit, the step-list hash and every remote command. A production go names the rc tag; the runner resolves it to its commit on the control machine first (`git fetch --tags origin`, `git rev-parse <tag>^{commit}`) and refuses a tag origin does not have.
- Every live run refuses a commit that is not on `origin/releases-A.B.x`, the release's branch (D64). The preflight reports the same as `P.origin`.
- `--preflight` checks everything the run needs, before the go. `--dry-run` is the same flag. It needs no go file. It changes nothing a running service uses, on any host. It exits 0 only when no check is red. See [the preflight](#the-preflight).
- `--go <file>` is required for any real run.
- `--from <step>` resumes a run. It needs `--run <run-ts>`. The failed run prints the exact command.
- `--only <step>` runs one step.
- `--run <run-ts>` without `--from` continues at the first step that is not ok.
- `--stage-journal <dir>` is required when the target is `prod`.
- `--after-preflight <dir>` continues from a green preflight ended within the last 60 minutes, at the same commit and step list. The run takes the preflight's run stamp. R1.1 to R2.5 are its records, so the run starts at R6.1 with one dump, not two. An older or red preflight refuses.
- `--abandon <run-ts>` marks a run that still reads `running` as failed, step by step, with the time. A run killed mid-step never ends on its own. Until it is abandoned, the preflight's `P.busy` is red.
- `--accept <step> --reason "<why>" --issue <n>` with `--run <run-ts>` records the owner's acceptance of one failed step. See [accepting a failed step](#accepting-a-failed-step).
- Every step has a bound (`maxMinutes` in `steps.ts`, 10 by default; the dump 30, the restore proof 20, each boot 15). Past it the runner kills its ssh, records `timed out`, and stops. The remote command may still run to its end, so look at the host before a resume.
- R1.4 to R1.6 repeat R1.1 to R1.3 on the capture checkout. They run on every target: stage rehearses them as prod runs them. See [the capture checkout convention](#capture-checkout-convention).
- The journal records `downtimeSeconds`, R6.1's start to R6.9's end. Stage run `20261008T042158Z` measured 149 s. The recovery matrix names the ceiling.
- A watch step (W1, R7.4a) runs no earlier than R6.9's end plus the target's `watchHours` (37 h on prod, 15 min on stage). Reaching it early, the runner stops with exit 3 and prints when it becomes runnable. `--run <run-ts>` resumes it then.
- The target's `watchSessions` says how the watch treats sessions. It renders as `--sessions graded` or `--sessions deferred` on W1 and R7.4a. Prod is always `graded`. Stage is `deferred` (owner decision 2026-10-08): its watch is a 15-minute check, and no 24 h epoch closes in 15 minutes. Stage epochs are production's (24 h since 2026-10-09).
- Why 37 h on prod: W1 needs every subject to publish one good session after READY. A subject with no open window at boot gets a first epoch, which lasts up to 1.5 epochs (system-scheduler-spec §2.2). That is 36 h at 24 h epochs (one session per subject per day, owner decision 2026-10-09). Judging (15 min) and R7.4a's publish grace (30 min) bring it to 36.75 h, rounded up. `scripts/release/watch.ts` derives it. The old 6 h watch failed check 7 on stage run `20261008T042158Z`: treasury and woon were still collecting.


## The preflight

`scripts/release/preflight.ts`. Run it first, on any target, as often as you like. Each check reads green, red, pending or blocked.

| Check | Green when |
|---|---|
| `P.target` | `confirmTarget` is filled in |
| `P.go` | the go file is valid for this release and target. Pending without `--go` |
| `P.recovery` | the go's signed recovery matrix is readable (SC.1). Pending without `--go` |
| `P.commit` | the commit is the control checkout's clean HEAD. Without a go, HEAD is the candidate commit the go must name |
| `P.origin` | the commit is on `origin/releases-A.B.x`, the release's branch (D64). A commit on `main`, a QA branch or a PR head only is red |
| `P.ci` | every check run on the commit completed green, and `e2e`, `unit`, `backend`, `integration`, `contract`, `web-client`, `repo-guards` and `docs-lint` are present (R0, SP.7) |
| `P.stage` | prod only: a passed stage run of this step list at this commit exists (SP.8). It names the directory to pass as `--stage-journal` |
| `P.live.target`, `P.live.capture` | no running container on the host was started from the release checkout |
| P.busy | no run of this target still reads `running` under the journal root (`--abandon` clears a dead one) |
| R1.1 to R2.5 | the step passes, run exactly as the run runs it. R2.5 takes `--triage` the same way |

The remote steps are every step before the first irreversible one. They check out and install the release checkout, capture a fresh dump from the read replica into a new directory, restore it into a throwaway container, and read the database and the running stack's logs. None stops a service or writes a database.

They run lane by lane. A lane is one host and one checkout path. The cheap lane goes first: the target checkout R1.1 to R1.3, R2.3 and R2.5 (30 s), then the capture lane with its dump and restore proof (10 min). A red target step shows in seconds. Within a lane the run's order holds. A failed step blocks the rest of its lane. The capture lane is its own on both targets: the schema refuses a capture checkout that is the target's.

The journal is `~/.local/state/robotmoney-release/<target>/preflight-<ts>/`: `preflight.json`, `plan.txt` with every remote command, and each step's logs and receipts. It is never a run journal: SP.8 and `--run` refuse it.

A green preflight is the evidence the owner reads before writing the go. A run started within the hour continues from it with `--after-preflight`. A later run repeats R1.1 to R2.5.
## The go file

The go is the operator's one recorded authorization for the release. It names the
release, the ref, the target and the signed recovery matrix. A go for another release or target refuses.

The go is the only place the release ref is named. The target files name none. A stage go
carries `commit: <40-hex sha>`; a production go carries `tag: vA.B.C-rc.N`. The runner resolves a
tag to its commit on the control machine and renders every `{commit}` (R1.2, R1.5, R7.1, W3) from
it; `{ref}` (R1.1, R1.4, R7.1) is the tag or the commit as the go wrote it. A new commit after a
QA fix means a new go file, never a commit to the target files. SP.8 still refuses a prod go
whose tag resolves to another commit than the passed stage run's.

**What each target runs (D64, owner, 2026-10-10).**

1. Stage runs a commit on `releases-A.B.x`: its go names that commit. A go with
   a `tag:` refuses on stage. The run refuses a commit that is not on the release
   branch: never a PR head or a QA branch commit.
2. When the stage run passes, cut the rc at that commit on the control machine:
   `bun scripts/release/tag.ts rc --release <release> --commit <stage commit>`.
   It refuses a commit off the release branch and keeps an rc that already
   points there. The rc is no step of the run.
3. The production go names the rc tag, `tag: vA.B.C-rc.N`, never a branch or a
   bare commit (a `commit:` refuses on prod). The run resolves the tag to its
   commit, refuses a tag origin does not have, refuses a commit off the release
   branch, and SP.8 refuses a tag that is not at the stage-passed commit.
4. R1.1 and R1.4 fetch the tags and detach at the ref, so the host holds the rc
   tag before the boot. The boot's identity (`git describe --tags --exact-match`)
   sets `RM_BUILD_TAG`, and `/health` and `/api/version` report the tag. R7.1
   fails a production boot whose `/api/version` does not carry the go's tag.

Why: on 2026-10-10 the v0.6.1 stage and production runs used a PR head
(`bca5186e`). The squash merges carried its tree to `main` and `releases-0.6.x`
under other hashes, so production and both v0.6.1 tags named a commit outside
the release branch until an empty-diff merge brought it in. `/api/version` said
`"tag": null`: the old R5.rc pushed the rc after R1.1 had fetched.

```text
release: v0.6.0
commit: <40-hex sha>      # stage
tag: v0.6.0-rc.0          # prod
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
unknown key refuses. The committed targets are `prod.json` and `stage.json`. A target names
where the target lives and nothing of what runs there. A top-level `commit` or `tag` refuses,
because the go file names the release. A `legacy` block or a `tmuxSession` refuses too
(`PAST_FACT_KEYS` in `scripts/release/target.ts`): the running stack is whatever the host's
smoke state names for the instance, and R6.1 stops that. Neither committed file holds a commit
hash or a past version string; a unit test keeps it so.

| Key | Meaning | prod | stage |
|---|---|---|---|
| `release` | The release name the go must match | `v0.6.0` | `v0.6.0` |
| `rmEnv` | `stage` or `prod` | `prod` | `stage` |
| `host` | The ssh host alias | `rm-frontend-prod-1` | `rm-frontend-stage-2` |
| `checkout` | The release checkout on the host. Every release names a new one. R1.1 clones it from `git@github.com:robotmoney/robotmoney-frontend.git` when `<checkout>/.git` is missing (a plain clone, never `--reference` another checkout). Why: the v0.6.1 production preflight's R1.1 failed with `cd: /root/rm-061: No such file or directory` (2026-10-10) | `/root/rm-061` | `/home/stage-server/rm-stage-target` |
| `home` | `HOME` for every command; its `.env` is the target's credential file | `/root` | `/home/stage-server/stage-target` |
| `instance` | The smoke instance | `rm_prod` | `stage_target` |
| `publicOrigin` | The origin R7.1 checks | `https://robotmoney.network` | `https://stage.robotmoney-labs.dev` |
| `capture` | Capture host, its `HOME` and its checkout | `rm-frontend-stage-2`, `/home/stage-server`, `/home/stage-server/rm-capture` | `rm-frontend-stage-2`, `/home/stage-server`, `/home/stage-server/rm-capture` |
| `confirmTarget` | `host:port/database`; every write's `--confirm-target` | the primary's `host:25060/defaultdb` | `172.17.0.1:25060/defaultdb` |
| `watchMinAttendance` | W1's `--min-attendance` | 0.5 (default) | 0.4: the external members never file against stage |
| `watchHours` | Hours after R6.9 before W1 and R7.4a run. Prod, and any target that grades sessions, may set it longer, never below the derived 37 h. A target that defers sessions may set any positive value | 37 (default) | 0.25 (15 min, owner decision 2026-10-08) |
| `watchSessions` | `graded` or `deferred`, rendered as W1's and R7.4a's `--sessions`. `graded`: W1 check 7 needs every subject to publish one good session, and R7.4a needs every session in flight at R2.3 to publish on its normal close. `deferred`: W1 skips check 7, and R7.4a checks only that no in-flight session vanished or had its close moved. Prod must be `graded` | `graded` (default) | `deferred` |
| `bootEnv` | Non-secret boot settings the boots export (`WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, the RPC and backfill budgets) | `{}` | `{}` |

### Capture checkout convention

The capture checkout is a dedicated folder the release runner owns:
`/home/stage-server/rm-capture` on `rm-frontend-stage-2`, the same for every target
(`CAPTURE_CHECKOUT` in `scripts/release/target.ts`). It is never a release checkout.
R1.4 clones it from `git@github.com:robotmoney/robotmoney-frontend.git` when
`<checkout>/.git` is missing. Then it fetches and detaches at the commit. So a fresh capture
host or a deleted folder heals on the next run. A folder that exists without `.git` is not
touched: the clone refuses it, and R1.4 fails. The stage target (`stage-target up`, `down`,
`up --replace`) never creates or removes it. The target schema refuses a `capture.checkout`
that is the stage target's checkout (`/home/stage-server/rm-stage-target`), or the target's own
`checkout` on the same host. Why: on 2026-10-08 prod's capture checkout was the stage target's
checkout. `stage-target down` removed it after the stage rehearsal, and the production
preflight's R1.4 failed with `cd: /home/stage-server/rm-stage-target: No such file or directory`.
Stage shared that folder with its own R1.1, so it skipped R1.4 to R1.6 and never rehearsed them.

A placeholder `confirmTarget` refuses a live run.
Step R1.2 resolves `host:port/database` from the host's `~/.env` and refuses a
different value. `bootEnv` refuses `BASE_RPC_URL`: a private RPC URL carries its key,
and a secret never goes in a process argument.

## Target preconditions

A release run does not create its database. The database exists before the run.

- **Production.** The production database exists. The running stack is the one `bun smoke --policy prod --static-port` last booted for `rm_prod`, recorded in the host's smoke state (`/root/.local/state/robotmoney-smoke/rm_prod/`). The runner never names its checkout or commit; `/api/version` reports them.
- **Stage.** `scripts/release/stage-target.ts up --dump <dir>` sets the stage target up before the run: it restores a production dump and boots the stack production runs, at the tag and commit production's `/api/version` reports ([`stage-target.md`](./stage-target.md)). This is target setup, as production's database is. It is not a step.
- **Role passwords, both targets.** `bun run role-passwords --target <stage|prod>` runs on the control machine before the run. It is provisioning, not a runbook step. It is idempotent. As `doadmin` it sets the four role passwords and `rm_owner`'s `LOGIN`, and it writes each missing role line of the host's `~/.env`. The admin types the `doadmin` password at its hidden prompt. That is the one human input of the release process. The password goes to the host over ssh stdin and lives only in process memory. It is never stored in a file. No release step reads `doadmin` (D61 amendment, owner, 2026-10-08).
  - It asks for the `doadmin` password at a hidden prompt, or reads one line from its stdin with `--doadmin-stdin`. It passes the password to `bun scripts/prod-init.ts role-passwords --policy <p> --confirm-target <T> --doadmin-stdin` on the host over ssh's stdin. The host's checkout may predate `--policy`, so the command also sets the legacy `RM_ENV=<p>` that such a checkout reads (`scripts/release/legacy-policy-env.ts`); a current checkout ignores it. The password is never stored in a file, an argument, an environment variable or any output, on either machine.
  - For each of `rm_owner`, `rm_app`, `rm_worker` and `rm_readonly`, a `~/.env` line that logs in is `kept` and no `ALTER` runs. An absent line is `set`: the host generates a password and sends the server only its SCRAM-SHA-256 verifier. The host then writes `<role> = <password>` into `~/.env` (atomic, 0600) and proves the login. A line that does not log in refuses. Only `--rotate <role>` replaces a line, and it keeps the old one in `~/.env.retired-<ts>` (0600). An empty `<role>=` line refuses. `rm_owner` also becomes `LOGIN`. A runtime role's attributes never change.
  - A rerun reports every role `kept`. The receipt (`prod-init/role-passwords-*.json`) lists role → `kept`, `set` or `rotated`, never a value.
  - Never pass `--rotate` for a runtime role while the stack runs: it would lock the running stack out.
  - It runs from the target's release checkout, the one R1.1 fetches later, and clones and installs it when it is missing. It never names the running stack's checkout.
  - Stage runs it the same way, fed by the disposable stage credential. The stage sequence is production's:
    1. `bun scripts/release/stage-target.ts up --dump <dir>`;
    2. `bun scripts/release/stage-target.ts doadmin | bun run role-passwords --target stage --doadmin-stdin`;
    3. `bun run release:run --target stage`.

    Production has no `stage-target doadmin`: there the admin types the password at the prompt.

Step R1.2 checks the database precondition on every target, read-only, through `rm_readonly`:

- the database `~/.env` names answers;
- its ledger reconciles with `backend/migrations` and with the bytes at the version the running stack reports at `publicOrigin/api/version` (`scripts/release/ledger.ts`, [D67](../decisions.md#d67)): every recorded name is a repository file (check 1), the pending set, what R6.3 applies, is the repository minus the ledger (check 2), and every applied file's sha256 equals the same path's at that tag (check 3). A count is never judged, and neither is the number order: a file applied out of number order passes. An unknown name refuses with that name; an edited applied file refuses with both hashes; a running stack that reports no version refuses, because nothing pins the bytes; a tag the checkout cannot resolve refuses as `pin-ref-unresolved`, never a fallback. The receipt is in `host-identity.json` (`precondition.reconcile`);
- `deployment_identity` is absent, or holds the kind `--policy` implies (`prod` means `production`, `stage` means `rehearsal`). A ledger that records `0081_deployment_identity.sql` without the row refuses.

A remote twin prepared by [`pre-identity-remote-twin.md`](./pre-identity-remote-twin.md) has the pre-identity shape. A database already migrated by this release passes the ledger check with nothing pending. A failed run resumes with `--from`. It never restarts at R1.

Step R1.2 also proves, before R6.1 stops the running stack, what the cutover needs later:

- non-empty `rm_owner` and `RM_CREDENTIALS` lines in `~/.env` (`RM_CREDENTIALS` has named the credential file since v0.6.0; the generic list writes no `~/.env` key);
- an `rm_owner` login with `SELECT 1`. It is read-only. The statement is the registry's object-less `connectionCheck` shape, declared as `rm_owner` in `backend/scripts/owner-login-check.ts`. A failure refuses with "rm_owner cannot log in; run `bun run role-passwords --target <target>` first".

R6.2 checks `rm_owner` and `RM_CREDENTIALS` again, as defence in depth. The migrate (R6.3) and the later steps use `rm_owner` from `~/.env`.

## The step list

Every remote step runs as
`cd <checkout> && env -i HOME=<home> PATH=<fixed PATH> LANG=C.UTF-8 <command>`
on the target host, or from the capture checkout on the capture host. No command reads
a policy from its environment ([D69](../decisions.md#d69) part 4): each command that
takes one carries `--policy {policy}` on its argv, filled from the target's `rmEnv`
(`bun run migrate`, `bun run smoke`, `bun run smoke:web`, `prod-init`, `host-identity.ts`
and `baseline.ts`). `env -i` drops everything the login shell exports. Production's `/etc/environment`
exports a `doadmin` `DATABASE_URL` and its parts, and stage's does not. With `env -i` no
command sees either. The only other variables are the step's own (`PROJECTS_SOURCE=live`
and `bootEnv` for the boots). The fixed PATH is
`/root/.bun/bin:/home/stage-server/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`.
It is part of the template, so the hash covers it. R1.2 and R1.5 record where `bun`,
`docker`, `tmux` and `git` resolve under it, and refuse a command that inherited a
`DATABASE_*` variable.

Every target step runs from the release checkout, R2.5 included: `prod:gate --mode baseline`
grades the running stack the instance's smoke state names. The control step (W3) runs on the
control machine from the runner's own checkout. Each remote step first touches a marker in the run's remote directory. The
runner copies back only the receipts written after that marker.

The table below and the hash line are generated from `scripts/release/steps.ts` by `bun scripts/release/steps-table.ts --write docs/runbooks/release-run.md`. The docs lint fails when either is stale. The hash is the one SP.8 compares a stage journal and a production run by; it changes only when the list changes, and the change is recorded here on purpose.

Step-list hash: `215694744712c5f002f738722357c01e9a9352f971cab688161bf541e67f8519`

<!-- steps-table:begin -->
| Id | Host | Does | Command | Irreversible | Bound | Standing |
|---|---|---|---|---|---|---|
| R1.1 | target; clones the checkout when missing | Target checkout: clone it when missing, fetch the tags, then detach at the go's ref (the rc tag on prod, the commit on stage), so the host holds the tag the boot reports (D64) | `git fetch --tags origin`; `git -c advice.detachedHead=false checkout --detach {ref}` | no | 10 min | SP.1 |
| R1.2 | target | Target identity and precondition: HEAD is the commit, the tree is clean, the tools exist, ~/.env resolves to confirmTarget, the database answers, its ledger reconciles with backend/migrations and the bytes at the version the running stack reports (no recorded name the repository lacks, no applied file whose bytes differ from the tag's; never a count or a number order), its identity is absent or matches the target's policy; before R6.1, ~/.env holds non-empty rm_owner and RM_CREDENTIALS lines and rm_owner logs in (SELECT 1, read-only; refuses with "run bun run role-passwords --target <target> first"); no release step reads doadmin | `bun scripts/release/host-identity.ts --policy {policy} --commit {commit} --confirm-target {confirmTarget} --origin {publicOrigin} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SP.1 |
| R1.3 | target | Target install: bun install --force, root and backend | `bun install --force`; `bun install --force --cwd backend` | no | 10 min | SP.1 |
| R1.4 | capture; clones the checkout when missing | Capture checkout (runner-owned, never a release checkout): clone it when missing, fetch the tags, then detach at the go's ref | `git fetch --tags origin`; `git -c advice.detachedHead=false checkout --detach {ref}` | no | 10 min | SP.1 |
| R1.5 | capture | Capture identity: HEAD is the commit and the tree is clean | `bun scripts/release/host-identity.ts --commit {commit} --receipt-dir {captureHome}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SP.1 |
| R1.6 | capture | Capture install: bun install --force, root and backend | `bun install --force`; `bun install --force --cwd backend` | no | 10 min | SP.1 |
| R2.1 | capture | Fresh capture from production's read replica into a new dated directory (never a reused dump) | `bun run smoke:capture --out {captureHome}/rm-backup-{target}-{runTs}` | no | 30 min | SR.0, SP.2 |
| R2.2 | capture | Record the sha256 of the encrypted dump files beside the manifest | `sh -c cd {captureHome}/rm-backup-{target}-{runTs} && sha256sum -- *.gpg > SHA256SUMS` | no | 10 min | SP.2 |
| R2.4r | capture | Restore proof: restore the R2.1 dump into a throwaway local Postgres container, record the restore time, drop the container | `bun scripts/release/restore-proof.ts --dump {captureHome}/rm-backup-{target}-{runTs} --receipt-dir {captureHome}/.local/state/robotmoney-release/{target}/{runTs}` | no | 20 min | SP.2 |
| R2.3 | target | Baseline through rm_readonly: ledger, identity, roles, migration 0101's would-clear list, the ledger reconciliation (the pending set, every applied file's bytes against the version the running stack reports), R2.4 counts and size | `bun scripts/release/baseline.ts --policy {policy} --instance {instance} --run {runTs} --origin {publicOrigin}` | no | 10 min | SP.3, SP.6 |
| R2.5 | target | Log baseline of the running stack the instance's smoke state names, graded by prod:gate from the release checkout | `bun run prod:gate --mode baseline --instance {instance} --report {home}/.local/state/robotmoney-release/{target}/{runTs}/prod-gate-baseline.md` | no | 10 min | SP.5 |
| R6.1 | target | Stop the running stack: the one the instance's smoke state names, with bun run smoke:down --instance {instance} (never -v); refuses when the state names no stack; proves no container of its project remains | `bun scripts/release/stop-legacy.ts stop --instance {instance} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | **yes** | 10 min | SC.2 |
| R6.2 | target | Rewrite ~/.env to the D61 allowlist (rm_owner, never doadmin); every other key, a stray doadmin line included, moves to ~/.env.retired-<ts> (mode 0600); refuses without rm_owner or RM_CREDENTIALS; key names only | `bun scripts/release/env-rewrite.ts --run {runTs} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SV.6 |
| R6.3 | target | The first migrate: 0081 first with the identity --policy implies, then every pending file | `bun run migrate --policy {policy} --instance {instance} --confirm-target {confirmTarget}` | **yes** | 10 min | SC.2 |
| R6.4 | target | Report the deployment identity the migrate wrote (prod-init set-identity) | `bun scripts/prod-init.ts set-identity --policy {policy} --instance {instance} --confirm-target {confirmTarget}` | no | 10 min | — |
| R6.5 | target | Mint the three service tokens (prod-init provision-tokens) | `bun scripts/prod-init.ts provision-tokens --policy {policy} --instance {instance} --confirm-target {confirmTarget}` | no | 10 min | — |
| R6.7a | target | Boot 1: bun smoke --static-port (preflight, replace, readiness, exit) | `bun run smoke --policy {policy} --static-port --instance {instance}` | no | 15 min | SP.4 |
| R6.7b | target | Status after boot 1 | `bun run smoke:status --instance {instance}` | no | 10 min | SV.2 |
| R6.9 | target | Status after boot 2: the receipt as history, the daemon as now | `bun run smoke:status --instance {instance}` | no | 10 min | SV.2 |
| R6.10 | target | Site: bun smoke:web (refuses a site whose apiRange excludes the api) | `bun run smoke:web --policy {policy} --instance {instance}` | no | 10 min | — |
| R7.1 | target | Identity: /api/version and /version.json carry the release commit, no +dirty or +unknown; when the go's ref is the rc tag, /api/version carries it as tag (RM_BUILD_TAG) | `bun scripts/release/identity-check.ts --origin {publicOrigin} --commit {commit} --ref {ref} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SV.1 |
| R7.3 | target | Product verification, readonly tier | `bun run verify:live --instance {instance} --emit-receipt=R7.verify` | no | 10 min | SV.3 |
| R7.3a | target | Log verdict after the release (sessions graded later: the first one publishes hours after the cutover) | `bun run prod:gate --mode post-release --defer-sessions --instance {instance} --report {home}/.local/state/robotmoney-release/{target}/{runTs}/prod-gate-post-release.md` | no | 10 min | SV.4 |
| R7.3b | target | Standing soak checks: record the baseline at READY, then the full run | `bun run soak:checks --instance {instance} --record --report {home}/.local/state/robotmoney-release/{target}/{runTs}/soak-record.md`; `bun run soak:checks --instance {instance} --full --report {home}/.local/state/robotmoney-release/{target}/{runTs}/soak-full.md` | no | 10 min | SW.2 |
| R7.5 | target | Compare with the R2.3 baseline: row counts only grow, database size within the bound | `bun scripts/release/compare-baseline.ts --instance {instance} --run {runTs} --max-size-ratio 1.5` | no | 10 min | SV.5 |
| R7.7 | target | Host guards: no container mounts docker.sock, ~/.env keys within the allowlist, token files 0600, no world-readable file under home holds a postgres URL with a password | `bun scripts/release/host-guards.ts --instance {instance} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SV.6 |
| W1 | target, not before R6.9 + `watchHours` | The watch since READY: prod:gate post-release with sessions as the target's watchSessions says (prod graded: every subject publishes a judged session, the judge never restarted; stage deferred) | `bun run prod:gate --mode post-release --instance {instance} --since {readyIso} --min-attendance {watchMinAttendance} --sessions {watchSessions} --report {home}/.local/state/robotmoney-release/{target}/{runTs}/prod-gate-watch.md` | no | 10 min | SW.1 |
| R7.4a | target, not before R6.9 + `watchHours` | Schedule parity: 24 h epochs, every session in flight at R2.3 published on its normal close (graded; deferred checks only that no close moved), the regime run at :30, the last parity sweep's duration | `bun scripts/release/schedule-parity.ts --instance {instance} --run {runTs} --sessions {watchSessions} --receipt-dir {home}/.local/state/robotmoney-release/{target}/{runTs}` | no | 10 min | SW.1 |
| W3 | control, prod only | Tag the running commit with the release tag and push it (prod only) | `bun scripts/release/tag.ts final --release {release} --commit {commit}` | no | 10 min | SW.3 |
<!-- steps-table:end -->

The go file stands for SC.1 (its `recovery` key) and SC.2 (D61 replaces the operator's
step-by-step authorization). Every standing row of the cutover has a step.

### The final tag after a failed check (D63)

A production run that passes its first irreversible step (R6.1) and is not
rolled back gets the release tag, even when a later step fails. The runner
stops at the failed step and never skips it, so W3 does not run. The operator
then tags the running commit from the control checkout:

```bash
bun scripts/release/tag.ts final --release <release> --commit <go commit>
```

Each failed check becomes an issue against the next patch version. Its fixes
start at the next version's `-rc.0`. Only a rollback leaves the release
untagged.

### The one target difference: the release tag

W3 tags the release. It carries `onlyFor: "prod"` in the template. A stage run
records it as `skipped: stage` and tags nothing. The skip is data in the one list, not
a second list, so the step-list hash is the same for stage and prod. A skipped step
counts as done for the run's status and for SP.8. No other step differs by target: R1.1,
R1.4 and R7.1 take `{ref}`, a value, which is the rc tag on prod and the commit on stage.

### The scripts the runner adds

| Script | Step | What it does |
|---|---|---|
| `scripts/release/host-identity.ts` | R1.2, R1.5 | HEAD equals the commit; the tree is clean; `bun`, `docker`, `tmux` and `git` resolve under the fixed `PATH`; no `DATABASE_*` variable was inherited; `~/.env` resolves to `confirmTarget`; the target precondition holds, `~/.env` has a non-empty `rm_owner` line and `rm_owner` logs in with `SELECT 1` (R1.2 only) |
| `scripts/release/baseline.ts` | R2.3 | Through `rm_readonly` on a proven read-only session: the ledger, `deployment_identity`, the five roles, migration 0101's would-clear list (the R2.3 query, verbatim), the ledger reconciliation against `backend/migrations` and the running stack's version (the receipt, D67), the R2.4 counts and the database size. Refuses an in-house seat in the would-clear list and any reconciliation verdict but `ok` |
| `scripts/release/restore-proof.ts` | R2.4r | Restores the run's capture into a throwaway local Postgres container through `scripts/lib/restore-container.ts`, counts its ledger, records the restore time, and always drops the container |
| `scripts/release/stop-legacy.ts` | R6.1 | `stop --instance <name>`: reads the instance's smoke state, refuses with a non-zero exit when it names no stack, else runs `bun run smoke:down --instance <name>` (never `-v`) and proves no container of the record's project remains. No tmux session, compose project or checkout argument |
| `scripts/release/tag.ts` | after stage (rc), W3 | On the control machine: `rc` refuses a commit off `origin/releases-A.B.x`, then tags the next free rc at the commit unless one points there; `final` tags the release at the commit, or confirms it already does; each pushes its tag |
| `scripts/release/schedule-parity.ts` | R7.4a | Every active subject has 24 h epochs, and the four production subjects' anchor times of day are exactly 21600 s apart in the order vault, woon, allocation, treasury (migration 0121); every session in flight at R2.3 published within its judging time plus 30 min of its unmoved close (with `--sessions deferred`: only that each still exists with its close unmoved); the analytics-producer's regime cron runs at minute 30; reports the last parity sweep and fails a dead one |
| `scripts/release/credentials-init.ts` | none (stage target setup) | The v0.6.0 cutover's one-time credential file write. No step of the generic list. `stage-target up` runs it once when it builds the stage world; a release that needs it again declares a delta step gated on the file's absence |
| `scripts/release/env-rewrite.ts` | R6.2 | Moves every `~/.env` key outside the D61 allowlist to `~/.env.retired-<run-ts>` (mode 0600). A stray `doadmin` line moves too. Refuses when `rm_owner` or `RM_CREDENTIALS` is missing. Prints key names only |
| `scripts/release/identity-check.ts` | R7.1 | `/api/version` and `/version.json` carry the commit, with no `+dirty` or `+unknown`; with the rc tag as `--ref`, `/api/version` carries it as `tag` |
| `scripts/release/compare-baseline.ts` | R7.5 | Every R2.4 count only grew; the database size is within the bound |
| `scripts/release/host-guards.ts` | R7.7 | No container of the instance mounts a Docker socket; `~/.env` keys are within the allowlist; the three token files are mode 0600; no world-readable file under `HOME` holds a postgres URL with a password |

The D61 `~/.env` allowlist is `host`, `port`, `database`, `dbname`, `sslmode`, `rm_app`,
`rm_worker`, `rm_readonly`, `rm_owner`, `RM_CREDENTIALS` and
`COINGECKO_API_KEY`. `doadmin` is not on it: preflight check 4 refuses a `doadmin` line on prod.
`RM_ENV` is not on it either (D69 part 4): check 4 names a leftover line as the retired
policy variable, and R6.2 moves it to `~/.env.retired-<ts>` with every other key off the list.

## How stage and prod share it

The step list is one constant, `RELEASE_STEPS` in `scripts/release/steps.ts`. It does
not branch on the target. The step-list hash is sha256 over the templates, so it never
sees a target value. The watch steps' `notBefore` is in the hash as `{ afterStep: "R6.9", hours: "watchHours" }`, so changing the wait's form changes the hash, while a target's `watchHours` does not. W1 and R7.4a carry `--sessions {watchSessions}` as a template word, so stage's `deferred` and prod's `graded` give the same hash. The runner prints the hash and records it in the journal.

A stage run that passes every step leaves a journal with that hash and the commit.
Production refuses to start unless `--stage-journal` names such a journal (standing
check SP.8). A different hash, a different commit, a failed or missing step, or a
journal from a prod run all refuse.

The hash changed once, deliberately, for issue 1272: the one-time v0.6.0 steps R6.2a,
R6.7c, R6.7d and S8.1 left the list, R6.1 became the smoke:down stop, R2.5 moved to the
release checkout and R7.7 lost its retired-checkout argument. The recorded hash above is
that list's. Every earlier stage journal is refused by SP.8, as it should be: those runs
rehearsed a list that no longer exists.

### Delta steps

A release that needs a one-time action (the v0.6.0 credential file, a member rebind, a
second boot) declares it as a **delta step** in `RELEASE_DELTAS` (`scripts/release/steps.ts`),
keyed by the release name the target carries, with the runbook text in that release's delta
runbook. `stepsFor(release)` inserts it after its `after` step for that release only. A delta
step carries `gateAbsent`: a file whose absence proves the action has not run (for example
`{home}/.config/robotmoney/credential.json`). The rendered command runs the action only while
the file is absent, and records `skipped: <path> exists` otherwise, so a second run of the
same list never repeats it. The hash is taken over the list with the delta, so stage and
production of that release share it, and the generic list's hash is untouched. The generic
list holds no delta today.

## Triage of the baseline gate

R2.5 grades the running stack before anything changes. A failure there is
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

## Accepting a failed step

A post-release gate reads from the stack's boot, so a rerun of a failed R7.3a reads the
same line and fails again (issue 1282: v0.6.1 run `20261010T004257Z`, one boot-race line,
issue 1280, production healthy). Without a record, `--from W1` refuses, and W1, R7.4a and
W3 never run. The owner's decision is a journal record:

```bash
bun run release:run --target prod --run <run-ts> --accept R7.3a --reason "<why>" --issue <n>
```

- It takes no go file and runs nothing on any host. The failed run prints the command.
- The step's status becomes `accepted`. Its exit, output and receipts stay. `run.json` and
  `<step>/result.json` record `accepted: { reason, issue, at }`.
- An accepted step counts as done: `--from <later step>` no longer refuses because of it,
  `--run <run-ts>` without `--from` continues after it, and the run reads `passed` once
  every other step is ok, skipped or accepted.
- It refuses a step that is not `failed` (ok, skipped, running or never run), a step not in
  the list, a run that still reads `running` (abandon it first), an irreversible step (a
  failure there is the recovery matrix's, section 8), a missing reason, or an issue that is
  not a positive integer.
- SP.8 stays strict: a stage run with an accepted step does not authorize production. The
  refusal names the step.

## The journal

The runner journals on the control machine under
`~/.local/state/robotmoney-release/<target>/<run-ts>/`.

- `run.json` holds the target, the commit, the rc tag on a production run, the step-list hash, the go's sha256 and each step's outcome.
- `<step>/stdout.log` and `<step>/stderr.log` hold the step's output.
- `<step>/result.json` holds the exit code, the timings and the receipts.
- `<step>/receipts/` holds the receipts copied back from the host.

The runner stops at the first step whose exit differs from the expected exit, or whose
required receipt is missing. It prints the resume command and, for a reversible step, the
accept command. Past an irreversible step it also points at the recovery matrix (runbook
section 8).

## Secrets

The runner never knows a secret. It scrubs output and receipts by shape before they
reach the console or the journal: a known secret key with a value, a postgres URL
password and a bearer token. It never copies back a token file, a role-password file,
an `.env` file, a credential file, a passphrase or a dump.

## Open items on 2026-10-08

- **`git fetch` runs with the target's `HOME`.** On stage that is `/home/stage-server/stage-target`. A credential helper or `.gitconfig` in the login home is not seen there. R1.1 fails loudly if the fetch needs one.
- **`BASE_RPC_URL` has no delivery path.** It stays out of `bootEnv`. A private RPC URL carries its key, and a secret never goes in a process argument. If production uses a private RPC, the boot needs another way to receive it.
- **The running stack must be a production boot.** `prod:gate` refuses an instance whose smoke state is not an external-database boot. On stage, `stage-target up` boots the stack that way (`bun smoke --static-port`) against the stage target's database.
