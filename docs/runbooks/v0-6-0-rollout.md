# v0.6.0 production rollout — the first cutover on the smoke production design

> **Status: draft, cutover BLOCKED.** Section 0 lists what must clear first.
> Written against `origin/main` at `d20429ca` (the `releases-0.6.x` cut). Every
> command below was checked to exist at that commit (`package.json`, the script
> headers named in each step). Re-run section 1 at the RC commit and fix any line
> that moved. Policy: [`release-runbooks.md`](../technical/release-runbooks.md).
> Mechanism: [`smoke-production-spec.md`](../technical/smoke-production-spec.md) (D47).

## Why this runbook is not like the 0.5.x ones

Every 0.5.x runbook drove one stack with `bun run smoke:stage`, shipped images with
`ship-images.ts`, and ran checks from per-release `preflight.ts` / `postflight.ts` /
`stage-rehearsal.ts` scripts. **None of that is the mechanism now.** Do not copy a
step from `v0-5-*-rollout.md`. This release is the first one that moves production
from the old host (`RM_ENV=smoke`, overlay compose, an in-process host driver)
onto the adopted design (spec §9.3).

| Old (0.5.x) | Now (this release) |
|---|---|
| `bun run smoke:stage`, `smoke:archive`, `--db`, `--smoke`, `--agents`, `--twin` | `bun smoke --static-port` (retired flags refuse and name the replacement) |
| Stack stays attached; sessions driven by a host driver in tmux | `bun smoke` boots and **exits**; Docker keeps the containers; `system-scheduler` times sessions |
| Migrations run at boot or by a migrate role | `bun run migrate`, `rm_owner` password **typed**, `y`, receipt. Never part of a boot |
| `ADMIN_TOKEN`, `.env` in the checkout, `agent-launcher` with the Docker socket | `~/.env` (exact key list), per-instance service-token files, `credential.json`; **no container holds a Docker socket** |
| Roster by `--agents` | The roster is `credential.json` (`RM_CREDENTIALS`) |
| Site shipped with the API (`static:assemble`) | Own release unit: `bun smoke:web`, checked against `apiRange` |
| Per-release `upgrades/A-to-B/*.ts` | None exist for 0.6.0. Gates are the spec's, run by the tools below. `verify:live` is the product check |
| `twin:gate`, `prod:gate`, `soak-checks.sh` | **Not on main** (issue 1071 undecided). See B3 |

## 0. Blockers (cutover stays blocked until each is closed)

| # | Blocker | Evidence | What clears it |
|---|---|---|---|
| B1 | **Production's ledger is not the supported baseline.** `SUPPORTED_RELEASES` holds one entry, the 73-name ledger read 2026-09-25 (v0.5.0 + `0062`). Production has since shipped v0.5.1–v0.5.4. Computed from the `v0.5.4` tree (76 names), the matcher says `NO MATCH`: 3 extra (`0061_rm_worker_wallet_backfill_grant`, `0063_swarm_judge_model_default`, `0080_analytics_ledger_compaction`). The first production migrate refuses a ledger that matches no entry (spec §9.1). The same 73-name check is in the pre-identity twin runbook. | `backend/src/db/supported-releases.ts`; issue 1074 | **Owner decision** (D55 (8): adding a baseline takes one). Then a PR to `main` adding the entry, its fixture and the matching spec/runbook text, cherry-picked here. Confirm the real ledger first (R2.3), do not trust the tag-derived list |
| B2 | `e2e` failed on `main` at `d20429ca` (2026-10-02 10:42Z). | `gh run list --branch main` | Green `e2e` on the RC commit |
| B3 | No product or log gate on main for a rehearsal: `twin:gate` and `prod:gate` were not ported (issue 1071). `verify:live` is all there is. | issue 1071 | Owner decides port-or-retire. The runbook uses `verify:live` plus the checks in R3/R7 until then, and says so in the report |
| B4 | The stray tag `v0.6.0-rc.0` already exists on origin. It points at `bd62e32e` (the v0.3.0 runbook commit, "cut whole from v0.5.0-rc.8"), not at this line. | `git ls-remote --tags origin 'v0.6*'` | Owner decides: delete it (it is a placeholder, never deployed) or start at `rc.1`. Do not re-point a pushed tag without that decision |
| B5 | No `release:v0.6.0` tracking issue; Phases tasklist not complete (open: 1086, 1079, 1078, 1074, 1071). | `gh issue list` | Policy §4.1: file the issue, freeze scope, close or defer each open item in writing |
| B7 | **The paid CoinGecko key has no allowed home.** Spec §3 says `COINGECKO_API_KEY` lives in host `~/.env`, but `ENV_FILE_ALLOWED_KEYS` (`backend/src/db/preflight.ts:1126`) does not list it. Preflight check 4 **refuses the boot on prod** for any other key. Without the key the Gecko calls fall back to the keyless host (about 10 calls a minute per IP, which 429ed the `new_pools` sweep on 2026-09-28 to 09-30). | `backend/src/db/preflight.ts`; spec §3 | A PR to `main` that adds the key to the allowlist (or moves its delivery), cherry-picked here. Until then the rollout either ships keyless or cannot boot |
| B6 | Whether `rebind-members` (needs a running api) comes before or after the first boot is not fixed by the spec for the breaking-migration path. | R6.7 | Settled by the stage rehearsal (R3.8) and recorded here before R6 |

## 1. Release identity

| Item | Value |
|---|---|
| Branch | `releases-0.6.x` (cut from `origin/main` at `d20429ca`, 2026-10-02) |
| From (production today) | v0.5.4: backend at `becb6897` (v0.5.2), site at v0.5.3, 76-name ledger (to be confirmed at R2.3) |
| To | v0.6.0 |
| RC tags | `v0.6.0-rc.N`, cut only after stage passes (policy §3). `N` per B4 |
| Final tag | `v0.6.0`, same commit as the deployed rc, after R7 passes |
| Window | **Long and breaking.** Pending migrations include `breaking` ones, so the stack is **down** from R6.1 until R6.9. Plan for the api, the site and every participant to be unavailable |

```bash
git fetch origin --tags
git switch releases-0.6.x
git rev-parse HEAD            # record as RC_SHA; do not tag yet
bun install --force && bun install --force --cwd backend   # re-run after every switch/checkout
```

### 1.1 Pending migrations (35 files, from the 76-name ledger)

Classification is each file's own `compat:` header at `d20429ca`. Re-derive at the RC:
`comm -13 <(ledger) <(ls backend/migrations | sort)`.

- **No `compat:` header (6, they predate the runner's metadata):** `0056_swarm_judge_requires_model`, `0057_swarm_judge_policy_stamp`, `0058_swarm_judge_fault_injection`, `0059_swarm_judgement_completion_usage`, `0062_rm_worker_analytics_ledger_read_grant`, `0063_deployment_identity`. `0063` is applied first by the guarded pass (R6.3). A `NULL` compat refuses an older image (spec §8.4); confirm the runner treats these as the spec requires at R3.
- **Breaking (8):** `0066_drop_swarm_notifications`, `0072_drop_swarm_schedules`, `0079_drop_swarm_scheduler_jobs`, `0080_stream_events_grant_only`, `0081_stream_event_counter`, `0088_webauthn_challenge_slots`, `0089_revoke_runtime_delete`, `0092_drop_swarm_judge_fault_injection`.
- **Additive:** the rest (`0064`–`0065`, `0067`–`0078`, `0081_swarm_judge_model_bare_id`, `0082`–`0087`, `0090`, `0091`).

Because any pending migration is `breaking`, the order is fixed by spec §8.5:
**`bun smoke:down` → `bun run migrate` → `bun smoke --static-port`.** There is no rolling variant.

`0089_revoke_runtime_delete` takes `DELETE`/`TRUNCATE` from every runtime role. The old
code deletes rows at runtime, so **old code cannot run against the migrated database**
(spec §3, D55 (6)). A code-only rollback after R6.3 is impossible. Recovery after that
point is a database restore (section 8).

## 2. What changes for the operator

| Area | Effect | Operator action |
|---|---|---|
| Credentials | `~/.env` may hold only: remote connection (`host`,`port`,`database`,`sslmode`), `rm_app`/`rm_worker`/`rm_readonly` passwords, `RM_ENV`, `RM_CREDENTIALS`. Anything else **refuses the boot on prod** (preflight check 4) | Clean `~/.env` at R6.2. Template: `.env.example` |
| `rm_owner` | Becomes `LOGIN` (one-time, via `doadmin`). Password typed per run, never stored | R6.2b |
| Service tokens | Three (`system-scheduler`, `analytics-producer`, operator admin) in the api's token store; secrets in per-instance files under `~/.local/state/robotmoney-smoke/rm_prod/tokens/<holder>/token`. Replaces `ADMIN_TOKEN` | R6.5 |
| Participants | Standing containers from `credential.json`. The judge is a participant (`themis`), no inline judging, no fallback path | R6.2, R6.7 |
| Sessions | Timed by `system-scheduler` per subject epoch. No schedule rows, nothing to enable. The host driver is retired | Stop the driver at R6.1 |
| Deletes | No runtime role deletes. Pruning is `bun run prune` (typed `rm_owner`, 7-day floor) | Not part of the cutover |
| Site | Own unit. `bun smoke:web` refuses a site whose `apiRange` excludes the running api, and `bun smoke` refuses an api outside the live site's range | R6.10 |
| API limit | Explicit 10 s request limit; a request over 5 s is logged | Read in R7 |
| Gecko | The paid key is not on the `~/.env` allowlist today. See B7 | Close B7 first |


## 3. Roles and what each step may hold

| Step | Credential held | How it arrives |
|---|---|---|
| R2 capture | `rm_readonly` against the **read replica** | `~/.env` on the capture host |
| R3 rehearsal | generated local passwords (`--local dump`) | smoke generates them in the instance state dir |
| R6.2b | `doadmin` | typed once, not stored |
| R6.3 migrate | `rm_owner` | **typed** at the terminal, plus a literal `y` |
| R6.5, R6.7 prod-init | `rm_owner` (tokens); operator token (rebind) | typed / token file |
| R6.8 boot | `rm_app`, `rm_worker`, `rm_readonly` | `~/.env` |

An agent may run every command below up to a prompt. **The operator types the
`rm_owner` and `doadmin` passwords and each `y`.** No step reads them from a file,
pipe or environment.

## 4. R0 Go/no-go (policy §4.1)

- [ ] B1–B7 each closed, with the decision written in the tracking issue.
- [ ] `release:v0.6.0` tracking issue exists, scope frozen, Phases complete (policy §6).
- [ ] Every intended commit is on `releases-0.6.x`: `git log --oneline origin/main..releases-0.6.x` and the reverse are empty or fully explained.
- [ ] `gh run list --branch releases-0.6.x` shows green `e2e`, `unit`, `backend`, `integration`, `contract`, `web-client`, `repo-guards`, `docs-lint`.
- [ ] Operator names the cutover window and the rollback authority.

## 5. R1 Gate on the RC commit (local, no network spend)

```bash
bun run typecheck
bun run check-contract
bun run check:agent-surface
bun test scripts/tests/unit scripts/tests/integration
bun run --cwd backend test
```

Pass = all green. This is also what proves the CI evidence policy §8.1 asks for
(snapshot = migrations; supported-release upgrade; additive compatibility). If the
suite names `upgrade-from-release`, `first-production-migrate` and `identity-first-pass`,
cite them in the report. Record any skipped file by name.

## 6. R2 Baseline and backup (policy §§4.2, 4.3) — read-only, replica only

R2.1 Confirm the capture target is the **replica** and serves reads. `smoke:capture`
proves this itself (three independent read-only guards) and has no override.

```bash
bun smoke:capture            # as rm_readonly, writes an encrypted dump + manifest.json
```

R2.2 Record beside the dump: manifest, sha256 of the `.gpg` files, `pg_dump` and server
versions. Never point any rehearsal tool at the primary.

R2.3 **Read the real ledger** (this is what B1 turns on). Through the replica as
`rm_readonly` (operator's documented path; the local `.env.readonly` is stale):

```sql
SELECT count(*) FROM schema_migrations;
SELECT name FROM schema_migrations ORDER BY name;      -- save as ledger-prod-<date>.txt
SELECT to_regclass('public.deployment_identity');      -- expect NULL (pre-0063)
SELECT rolname, rolcanlogin, rolcreaterole FROM pg_roles
 WHERE rolname IN ('rm_owner','rm_app','rm_worker','rm_readonly','doadmin');
```

Then compare with the matcher (`matchSupportedRelease` in
`backend/src/db/supported-releases.ts`). Expect `NO MATCH` until B1 is closed.

R2.4 Save, with the dump: row counts of `swarm_sessions`, `swarm_recommendations`,
`swarm_consensus_receipts`, `swarm_session_judgements`, `source_value_versions`; database
size; the AUM figure the site publishes (copy the number and its date from the page). These are the
postflight comparison baseline.

## 7. R3 Stage rehearsal (policy §§4.4, 4.5) — stage hosts only, never production

Run on a stage host (`rm-frontend-stage-2`, `stage.robotmoney-labs.dev`, or stage-1).
The twin is **`--local dump`**: Docker Postgres that smoke owns, restored from the R2 dump.
A pre-0063 dump gets its identity-first pass automatically, but only when its ledger equals
a supported baseline (spec §9.1). A dump that does not match refuses, which is the same
as B1 and proves it on stage before production sees it.

R3.1 Check out the RC commit. `git status --porcelain` must be empty.

R3.2 Prepare a rehearsal credential file with **spoofed** keys, never the production
`credential.json`:

```bash
export RM_ENV=stage
bun smoke --local dump=<R2 dump dir> --instance rehearse-060 \
  --credentials rehearsal-creds.json --spoof-keys --migrate --static-port
```

Read the printed **plan** first: instance, target, image identities, roster, mutations.
Record the **plan id**. Expect a journal and receipt under
`~/.local/state/robotmoney-smoke/rehearse-060/`.

R3.3 `bun smoke:status --instance rehearse-060`. Receipt must show preflight and all nine
readiness checks, including scheduler readiness (spec §6.3).

R3.4 Product verification, a **separate process**, twin may use the full tier:

```bash
bun run verify:live --instance rehearse-060 --tier full --emit-receipt=R3.verify-twin
```

Exit 0 = pass; 1 = product wrong; 2 = nothing asserted. A WARN is not a pass. List which
invariants this target could not exercise.

R3.5 Prove the schema gates on the twin (the lines from spec §10 this release depends on):
migrations all recorded once; `deployment_identity.kind = 'rehearsal'`; `schema_manifest`
hash matches the ledger; `rm_app`/`rm_worker`/`rm_readonly` hold no `DELETE`/`TRUNCATE`
(preflight check 2 passing is the proof); 32 WebAuthn challenge slots.

R3.6 **Interruption.** Kill `bun smoke` at a phase boundary before replace, then rerun
under the same plan id: it resumes. Repeat once after replace began. Kill `bun run migrate`
between two commits (the stage form: `bun smoke --local volume --migrate`): the rerun
resumes. Record the journal phase each time.

R3.7 **Site.** Build and switch the site, then roll back:

```bash
bun smoke:web --instance rehearse-060
bun smoke:web --instance rehearse-060 --rollback
```

R3.8 **The production-shaped sequence (settles B6).** Repeat R6.3–R6.9 on a **remote**
stage database enrolled `rehearsal` (restore the dump there by hand per
[`pre-identity-remote-twin.md`](./pre-identity-remote-twin.md), or use a `--local volume`),
with real `bun run migrate` prompts and `prod-init provision-tokens` under `RM_ENV=stage`.
Write down the exact order that works for `rebind-members` and whether the participants
need a second `bun smoke --static-port` afterwards. Edit R6.7 to match, in a commit on
this branch, before any rc tag.

R3.9 **Rollback rehearsal.** Restore the R2 dump into a fresh local database and prove the
**old** (v0.5.4) code refuses or cannot run against the migrated one only in the ways
section 8 states. Record the restore time.

R3.10 Rehearsal report (policy §4.5): RC SHA, dump identity, plan id, preflight and
readiness receipts, participant results, `verify:live` output, interruption results, what
could not be covered (state B3), and a go/no-go signed by the operator.

### R3.11 Cut the RC tag (only after R3.10 is a go)

```bash
git tag -a v0.6.0-rc.N "$RC_SHA" -m 'v0.6.0-rc.N'   # N per B4
git push origin v0.6.0-rc.N
```

## 8. Recovery matrix (policy §4.8) — decide this before R6, sign it in the report

| Where it stops | State | Recovery |
|---|---|---|
| Before R6.3 commits | Stack down, database untouched | `bun smoke --static-port` on the **old** checkout (v0.5.4). Old host driver restarted by hand |
| `bun run migrate` fails or is killed | Ledger partly ahead of manifest ("in progress"); application boot refuses it | **Rerun `bun run migrate`.** It validates committed work and resumes (spec §8.3). Do not edit rows. Do not boot |
| Migrate done, boot or preflight refuses | New schema, no service running | Fix forward: rerun `bun smoke --static-port`. The journal says the phase |
| Migrate done, product wrong | New schema, new code live | **No code-only rollback** (0089, section 1.1). Either fix forward on a new rc, or restore the R2 dump into a fresh primary and repoint, which loses everything written after the dump |
| After replace started | The old services may be gone | `bun smoke:status` for new/old per service; rerun resumes; `bun smoke:down` stops all |

The database restore path is a **decision for the operator at the time**, recorded with the
write loss it implies. Do not delete history rows to tidy a failed run (append-only).

## 9. R6 Production cutover — IRREVERSIBLE from R6.3. Operator authorizes each step.

Run on the production host (`rm-frontend-prod-1`), from a pinned checkout of the RC tag,
`git status --porcelain` empty. `RM_ENV=prod`. The window is announced.

R6.0 Reconfirm: `RC_SHA`, `git describe --exact-match HEAD` equals the rc tag, the
rehearsal report is signed, rollback authority is named, and the R2 dump is no older than
the window the operator accepts (state the maximum write loss).

R6.1 **Stop what exists.** Stop the host driver (tmux) first, then the old stack:

```bash
tmux ls                       # find the driver session; stop it by name
bun smoke:down                # on the OLD checkout/instance record; keeps the data volume if any
```

If the old stack was not started by the new `smoke` there is no instance record: stop it
with the old procedure's `docker compose down` from the old checkout. Do not use `-v`.

R6.2 Host files. `~/.env` holds exactly the keys in section 2; remove everything else
(move it aside to a file outside the checkout, do not delete it). `credential.json` exists
at the path `RM_CREDENTIALS` names, with the in-house roster (agents `athena`,
`noop-analyst`, `robot-money`; judge `themis`). Production's seated members still hold
fixture keys until R6.7.

R6.2b **One-time role step**, before R6.3 needs the login. If R2.3 showed `rm_owner`
`rolcanlogin = f` (expected on an existing cluster), the operator runs, as `doadmin`:
`ALTER ROLE rm_owner LOGIN PASSWORD '<new>'`, then proves it with a verification login.
Spec §9.1 step 1. The password is not written to any file.

R6.3 **The first production migrate.** Typed `rm_owner`, then `y`. It applies
`0063_deployment_identity` **first** with `production` written in the same transaction,
then every other pending file in filename order (including the six below 0063).

```bash
bun run migrate               # RM_ENV=prod; receipt + journal land in ~/.local/state/robotmoney-smoke/rm_prod/
```

Pass = the receipt records the pre-identity state, the matched baseline, and 35 applied
files. A refusal here changes nothing; read the message (B1 is the expected one).
If interrupted after 0063 committed, rerun the same command (normal path, resumes).

R6.4 `bun scripts/prod-init.ts set-identity` — reads `production` through `rm_owner` and
receipts it. It writes nothing.

R6.5 `bun scripts/prod-init.ts provision-tokens` — typed `rm_owner`, `y`. Mints the three
service tokens. Re-running is a rotation.

R6.7 **Bring the stack up** (the exact order for `rebind-members` is set by R3.8):

```bash
bun smoke --static-port       # prints plan, takes locks, preflight, replaces services, exits
bun smoke:status
```

Then, with the api up, rotate each seated member from fixture keys to `credential.json`:

```bash
bun scripts/prod-init.ts rebind-members
```

Re-run `bun smoke --static-port` if R3.8 showed participants need it to pick up the new bearers.

R6.8 Preflight must pass at boot. If it refuses, the printed check number names the cause
(1 role auth, 2 privileges, 3a manifest, 3b compat, 4 `~/.env` keys, 5 identity, 6 subject
scheduling columns).

R6.9 Observe: `bun smoke:status` shows the receipt as history and the daemon as now.

R6.10 **Site** (its own step, after the api is in range):

```bash
bun smoke:web
```

It refuses a site whose `apiRange` excludes the api. It restarts no api or worker.

## 10. R7 Postflight (policy §§4.7.1, 4.9)

R7.1 Identity: `curl -s https://<host>/api/version` equals `{api, commit}` for the RC;
`curl -s https://<host>/version.json` carries the site's range and the RC commit. No
`+dirty` or `+unknown`.

R7.2 `bun smoke:status` receipt: preflight green; readiness green for `api`, the pipeline
worker, `analytics-producer` (seed command done) and the scheduler (authenticated, stream
synced, every active subject holding a `collecting` session).

R7.3 Product verification, **readonly tier only** on production:

```bash
bun run verify:live --instance rm_prod --emit-receipt=R7.verify-prod
```

R7.4 Read the result: 0 pass, 1 wrong, 2 nothing asserted. WARN is not pass.

R7.5 Compare against the R2.4 baseline: row counts only grow, nothing shrank; the
published AUM figure did not step; the ledger did not balloon (database size within the
bound the operator set in R6.0).

R7.6 Watch one full session cycle: every subject opens a session on the day it opened,
agents submit one final take each, `themis` submits a judgement, a consensus receipt
publishes or the session reads `no_consensus` (not a failure). The 5 s slow-request log
line is the signal for the api limit:

```bash
docker logs rm_prod-api-1 2>&1 | grep -aE '\[api\] (slow request|request ran past)'
```

R7.7 Confirm the guards the refactor added: no container mounts a Docker socket
(`docker inspect` over `rm_prod-*`); `~/.env` holds only the allowed keys; the three token
files exist, mode 0600, under the instance state dir.

R7.8 **Close:** tag the running commit, then file the report (policy §4.9).

```bash
git tag -a v0.6.0 "$RC_SHA" -m 'v0.6.0'
git push origin v0.6.0
```

The tag goes on whatever commit production runs and was verified at, even if the soak was
imperfect. Fixes go in the next patch version from `-rc.0`.

## 11. Report (policy §4.9)

RC and tag; SHA; R2 backup manifest and checksums; rehearsal and production receipts
(`migrate-receipt-*.json`, `migrate-journal-*.json`, the smoke receipt); migration timing;
which blockers closed and how; verify:live output; unexercised invariants; backport TODOs
(§7 of the policy); operator sign-off. The tracking issue closes only after the report is
filed and `v0.6.0` exists on `releases-0.6.x`.
