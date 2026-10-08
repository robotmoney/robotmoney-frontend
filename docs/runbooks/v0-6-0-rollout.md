# v0.6.0 production rollout — the first cutover on the smoke production design

> **Status: executed by `bun run release:run` ([D61](../decisions.md), the last decision).** No person types on a
> host. Production runs only with three things in hand:
>
> 1. a passed stage journal of the same step-list hash and the same commit (standing check SP.8);
> 2. the owner's go file, with its `recovery:` key naming the signed recovery matrix (section 8);
> 3. the owner's R2.5 triage file (section 6).
>
> Written against the QA branch `qa/0.6.x-2026-10-08` at `d84f4a2c`. The step list is
> `RELEASE_STEPS` in [`scripts/release/steps.ts`](../../scripts/release/steps.ts). That file is the
> authority. This runbook says why each step exists and what to read in its receipt.
> Runner: [`release-run.md`](./release-run.md). Stage target: [`stage-target.md`](./stage-target.md).
> Policy: [`release-runbooks.md`](../technical/release-runbooks.md).
> Mechanism: [`smoke-production-spec.md`](../technical/smoke-production-spec.md) (D47).

## Inherits the standing runbook

This runbook runs **every check in [`release-standing-runbook.md`](./release-standing-runbook.md)**
as it stands at `d84f4a2c`. It adds the 0.6.0-specific checks below. It cites standing checks by ID.
**Exceptions** (owner, 2026-10-08): SP.6 and SV.5 for the published AUM figure, and SW.2 over the
watch window. v0.6.0 ships with those rows unscripted. Issue agent-executed runbooks (1225) brings
them back as runner steps. The twin is **not** waived: the owner chose a short twin rerun at the
release commit (section 7.3).

Each standing ID maps to the runner steps that satisfy it (the `standing` field in `steps.ts`):

| Standing ID | Runner step ids | Note |
|---|---|---|
| SP.1 position | R1.1, R1.2, R1.3, R1.4, R1.5, R1.6 | Target and capture checkouts at the commit, clean, tools resolved |
| SP.2 backup and restore proof | R2.1, R2.2, R2.4r | Fresh capture, `SHA256SUMS`, restore time |
| SP.3 real ledger | R2.3 | `baseline.ts` through `rm_readonly` |
| SP.4 smoke preflight | R6.7a, R6.7d | Preflight runs inside each boot |
| SP.5 log baseline | R2.5 | Passes on a non-zero exit only with `--triage` covering every finding |
| SP.6 product baseline | R2.3 | Counts and size. The published AUM figure: owner exception for v0.6.0 |
| SP.7 code gate | none | CI on the pinned commit, read before the go (section 4) |
| SP.8 prod runs only what stage passed | the runner's start check | `--stage-journal` names a passed stage run |
| SR.0 fresh dump | R2.1 | A new dated directory every run |
| SR.1 twin boots, every member seated | none | The short twin rerun (section 7.3), required for v0.6.0 |
| SR.2 readiness | R6.7b, R6.9, R7.2 on the stage target | |
| SR.3 product verification | R7.3 on the stage target | Readonly tier. The full tier runs on the short twin rerun (section 7.3) |
| SR.4 log gate on stage | W1 on the stage target | `prod:gate --mode post-release` since READY. `twin:gate` runs on the optional twin only |
| SR.5 interruption resumes | the runner's resume (`--run`, `--from`) | Evidence of 2026-10-06 and 2026-10-07 stands (section 7.4) |
| SR.6 rollback rehearsal | R2.4r, S8.1 | Restore time per run. Old-code behavior is B13 |
| SR.7 standing invariants | R7.3b on the stage target | |
| SR.8 rehearsal report | the two passed stage journals | Section 7.2 |
| SR.9 accelerated schedule | none | The short twin rerun (section 7.3), required for v0.6.0. The stage target keeps 6 h epochs |
| SR.10 cutover rehearsal, twice | two stage runs, all steps | Section 7 |
| SC.1 recovery matrix signed | the go file's `recovery:` key | Section 8 |
| SC.2 | retired 2026-10-08 (D61) | |
| SC.3 operator's go recorded | the go file | Section 4 |
| SV.1 identity | R7.1 | |
| SV.2 status receipt | R6.7b, R6.9, R7.2 | |
| SV.3 product verification, readonly | R7.3 | |
| SV.4 log verdict after release | R7.3a | |
| SV.5 counts only grow | R7.5 | The published AUM figure: owner exception for v0.6.0 |
| SV.6 host guards | R6.2, R7.7 | |
| SW.1 one full session cycle | W1, R7.4a | Not before R6.9 plus 6 h |
| SW.2 invariants over the window | R7.3b | Runs at READY only. The watch-time run: owner exception for v0.6.0 |
| SW.3 tag and report | W3 | The report stays manual (section 11) |

Gaps against the standing runbook, each decided by the owner on 2026-10-08:

- **AUM (SP.6, SV.5).** No step records or compares the published AUM figure. Recorded exception.
- **SW.2 over the window.** R7.3b runs `soak:checks` at READY. No step reruns it at the watch. Recorded exception.
- **SR.1, SR.9 and the full tier of SR.3.** Only the twin exercises them. The owner chose a short twin
  rerun at the release commit: accelerated epochs for about 45 minutes, then torn down.

## Why this runbook is not like the 0.5.x ones

Every 0.5.x runbook drove one stack with `bun run smoke:stage`, shipped images with
`ship-images.ts`, and ran checks from per-release `preflight.ts` / `postflight.ts` /
`stage-rehearsal.ts` scripts. **None of that is the mechanism now.** Do not copy a
step from `v0-5-*-rollout.md`. This release is the first one that moves production
from the old host (`RM_ENV=smoke`, overlay compose, an in-process host driver)
onto the adopted design (spec §9.3).

| Old (0.5.x) | Now (this release) |
|---|---|
| A person on the host, step by step | `bun run release:run` on the control machine. Every step is one ssh command with stdin closed (D61) |
| `bun run smoke:stage`, `smoke:archive`, `--db`, `--smoke`, `--agents`, `--twin` | `bun smoke --static-port` (retired flags refuse and name the replacement) |
| Stack stays attached; sessions driven by a host driver in tmux | `bun smoke` boots and **exits**; Docker keeps the containers; `system-scheduler` times sessions |
| Migrations run at boot or by a migrate role | `bun run migrate --confirm-target <host:port/database>`, `rm_owner` from `~/.env`, receipt. Never part of a boot (D61) |
| `ADMIN_TOKEN`, `.env` in the checkout, `agent-launcher` with the Docker socket | `~/.env` (exact key list), per-instance service-token files, `credential.json`; **no container holds a Docker socket** |
| Roster by `--agents` | The roster is `credential.json` (`RM_CREDENTIALS`), written by R6.2a |
| Site shipped with the API (`static:assemble`) | Own release unit: `bun smoke:web`, checked against `apiRange` |
| Per-release `upgrades/A-to-B/*.ts` | None exist for 0.6.0. Gates are the spec's, run by the steps below. `verify:live` is the product check |
| `twin:gate`, `prod:gate` | Ported to main's instance model (1071, B7). `prod:gate` runs at R2.5, R7.3a and W1 |
| `soak-checks.sh` (cumulative R8 invariants) | `bun run soak:checks` (1179, B16). Runs at R7.3b |
| A twin rehearsal stood in for production | The stage target runs production's step list unmodified (D61 rule 2) |

## 0. Rule, decisions and blockers

**Rule (owner, 2026-10-03).** v0.6.0 changes how production is deployed, not what the
product does. Where main differs from production (v0.5.4), production's behavior wins
unless a recorded decision says otherwise. An upgrade does not change usual schedules.
Plan and status: phase issue 1099.

**Decided, not built:** operator cancel/reopen stays removed (D55 (4)); main keeps its
stricter four-weight submit rule (notice: 1124); the stray `v0.6.0-rc.0` tag is deleted
(2026-10-03), so the first candidate is `v0.6.0-rc.0`; the log gates are ported (1071).

**Decided 2026-10-08 (D61):** the runner executes the whole runbook. The owner gives one go
before the run. The owner triages the R2.5 baseline in a file.

**Cutover stays blocked until every row is closed with evidence.**

| # | Blocker | Code | Proof still owed |
|---|---|---|---|
| B1 | Baseline: production's 76-name ledger replaces the old one; unreleased migrations renumbered 0081-0110 so no pending file sorts inside the recorded range (1097) | merged | R6.3 on the stage target restored from a fresh dump. R2.3 reads the live ledger |
| B2 | In-flight sessions finish on their normal timing, no drain step (1111) | merged | R7.4a on a stage run: every session in flight at R2.3 published |
| B3 | Existing subjects stay on 6 h epochs, grid continued from each subject's last close (1112) | merged | R7.4a. The owner confirms the grid against prod session history |
| B4 | Settings reach the containers; prod refuses without `PROJECTS_SOURCE=live` (1113) | merged. The runner sets `PROJECTS_SOURCE=live` on R6.7a and R6.7d | the target file's `bootEnv` (section 2) |
| B5 | Parity sweep keeps its 240 s exemption (1114) | merged | R7.4a reports the last sweep's duration |
| B6 | Production parity: judge retry (1117), judge model from the database (1118), verified receipt path (1119), today's regime (1108), in-house seats keep their operator (1120), absence savepoint (1122) | merged. Persona-voiced sectioned takes (1116) merged by PR 1131 | R7 and W1 |
| B7 | Log gates `twin:gate` and `prod:gate` ported (1071) | merged | first live run will show unclassified lines; add a rule only with evidence |
| B8 | Mid-window dump adoption and the first-epoch bound (1121) | merged | `e2e` green on the pinned commit |
| B9 | `release:v0.6.0` tracking issue | exists (1147), updated 2026-10-06 | — |
| B10 | `rebind-members` order on the breaking-migration path | PR 1176, `--reuse` (1186, 1195), tokens kept on `--reuse` (1202) | settled on the twin 2026-10-06 at `3cdc883b`: boot, rebind 8 of 8, boot 2 reaches READY, the participants take the new keys. The runner encodes the order as R6.7a to R6.7d |
| B11 | The buyback indexer ran in the worker as `rm_worker` while its `buyback_scan_state`/`buyback_swaps` sites declared `rm_app`, so every sweep on the migrated dump was refused and swallowed (1150) | fixed (1171), migration 0113 | R7.3b: soak check R8.v reads every `worker-*` lane for a refused scan |
| B12 | The twin seated only `credential.json` members (1152) | fixed (1164), verified 7 of 7 on `7d69d17c` | — |
| B13 | The old checkout's `bun run migrate` runs clean against the migrated database and re-seeds the `swarm.*` job_schedules 0089 deleted (1155) | closed, no action (owner 2026-10-05) | S8.1 renames the old checkout right after R6.3 |
| B14 | A resume after replace could not start participants from the pruned api image id (1160) | fixed (1161), verified on `62ec5920` | — |
| B15 | A failed take re-ran on the next tick with no delay; seven seats hammered the shared Zen key. The take one-shot could not find its script from the per-take workspace (1166) | fixed: backoff (1168), give-up after 5 failed takes (1169), verified on `7d69d17c` | — |
| B16 | The cumulative standing invariants were not on the 0.6 line (1179) | ported (1189, 1195) | R7.3b on each stage run |
| B17 | The judge gate counted only operator `robotmoney` as in-house; themis's operator is "RM Protocol Labs" since 2026-09-29 | fixed (1201): in-house by seat (owner 2026-10-06) | W1 on a stage run: sessions judged by themis |
| B18 | The restore pipe dropped the dump's tail (`pg_restore: could not read from input file`) | fixed (1193) | verified: both dumps restore, exit 0 |
| B19 | A `--reuse` boot minted new service tokens under a scheduler it did not recreate: readiness HTTP 403 | fixed (1202) | verified at `3cdc883b` |
| B20 | Sessions in flight at the cutover were convened by v0.5.x with no expected roster and no `brief_opens_at`, so the 0.6 take queue offered them to no one | fixed: migration 0114 seats the active roster on each open unrostered session (PR 1215, rule "production's behavior wins"). In a `bucket_weights` session it seats a filer whose final v0.5.x take has no canonical-four weight vector as `excused` (owner 2026-10-08, PR 1245): the 2026-10-08 stage watch saw the in-flight vault session publish without a receipt, refused `weights_not_authored_by_every_take` over Woon's and ShodAI's weightless takes | R7.4a and W1 on a stage run: each in-flight session publishes with a receipt |
| B21 | The twin ran production's 6 h epochs, so nothing published for hours | fixed: `bun run twin:accelerate`, standing SR.9 | applies to the optional twin only. The stage target keeps 6 h epochs and waits out W1 |
| B22 | R2.5 had no recorded decision path for a baseline failure | fixed: `--triage` (PR 1232) | finding 8 |
| B23 | Production has no `credential.json` and no `RM_CREDENTIALS` | fixed: step R6.2a, `credentials-init.ts` (PR 1233) | finding 3 |
| B24 | The standing boot needed `OPENCODE_API_KEY` in the process environment, an old hand export | fixed: preflight reads a participant's `modelKey` from `credential.json` (PR 1235) | finding 4 |
| B25 | The host guard over-reported files inside 0700 and 0750 directories | fixed: it judges effective access. S8.1 runs `chmod -R go-rwx` on the retired checkout (PR 1236) | finding 5 |
| B26 | `stage-target.ts` left a retired checkout across rebuilds | fixed (PR 1238) | finding 6 |
| B27 | R7.1 rejected the site's short commit stamp in `version.json` | fixed (PR 1239) | finding 7 |

Also open: the notice to external members about the four-weight rule (1124); the
`judging` banner (1115, merged) and admin items (1123, merged) need only a look at R7.3's receipt.
Known flake: the smoke integration suites hit an EPIPE in the boot child (1141); re-run, do
not treat as a product failure.

### Findings of the D61 stage runs, 2026-10-08

| # | Finding | Resolution |
|---|---|---|
| 1 | Production's judge jobs die with HTTP 402. The OpenCode Zen balance was empty | The owner topped it up on 2026-10-08. Triaged at R2.5 |
| 2 | Legacy v0.5.4 members write empty transcripts. Zen answers 404 for the retired model id `opencode/deepseek-v4-flash` | Migration 0111 moves the judge to `deepseek-v4.1-flash` at R6.3. Triaged at R2.5 |
| 3 | Production has no `credential.json` and no `RM_CREDENTIALS` | New step R6.2a (PR 1233), B23 |
| 4 | The standing boot needed `OPENCODE_API_KEY` in the process environment (the old hand export) | Preflight reads a participant's `modelKey` from `credential.json` (PR 1235), B24 |
| 5 | The host guard over-reported files inside 0700 and 0750 directories | It judges effective access now. S8.1 runs `chmod -R go-rwx` on the retired checkout (PR 1236), B25 |
| 6 | `stage-target.ts` left a retired checkout across rebuilds | Fixed (PR 1238), B26 |
| 7 | R7.1 rejected the site's short commit stamp in `version.json` | Fixed (PR 1239), B27 |
| 8 | A baseline failure at R2.5 had no recorded decision path | `--triage` (PR 1232), B22 |

Production's old checkout `.env` has mode 0644. It holds a `doadmin` URL. `/root` is 0700, so no
other user reaches it. S8.1 moves its secret lines out anyway.

## 1. Release identity

| Item | Value |
|---|---|
| Release branch | `releases-0.6.x` |
| QA branch | `qa/0.6.x-2026-10-08`. Every fix of the session lands here (policy §4.6) |
| Release commit | `9d30b960fcb01a20e12a9118dd46dfd5c8f85eac`, the `commit` in `scripts/release/targets/prod.json` and `stage.json`. A new pin is a commit to both files |
| From (production today) | v0.5.4 at `1cda4085`, the target file's `legacy`: checkout `/root/robotmoney-frontend`, tmux session `driver`, compose project `rm_prod`, 76-name ledger (R2.3 confirms) |
| To | v0.6.0 in `/root/rm-060`, instance `rm_prod` |
| RC tag | R5.rc tags the next free `v0.6.0-rc.N` at the commit, prod run only. A stage run tags nothing |
| Final tag | W3 tags `v0.6.0` at the same commit, after the watch passes |
| Window | **Long and breaking.** Pending migrations include `breaking` ones, so the stack is **down** from R6.1 until R6.7a reaches READY. The api, the site and every participant are unavailable in between |

### 1.1 Pending migrations (40 files, from the 76-name ledger)

> **Owner, 2026-10-05 (1173):** from v0.6.0 the migration strategy is to become ONE idempotent,
> lossless schema file runnable at any database version. That is filed, not started. This
> release still ships the numbered files below.

Classification is each file's own `compat:` header at the release commit. R2.3's receipt lists
the live ledger. R6.3's receipt lists the files it applied.

- **No `compat:` header (6, they predate the runner's metadata):** `0056_swarm_judge_requires_model`, `0057_swarm_judge_policy_stamp`, `0058_swarm_judge_fault_injection`, `0059_swarm_judgement_completion_usage`, `0062_rm_worker_analytics_ledger_read_grant`, `0081_deployment_identity`. `0081` is applied first by the guarded pass (R6.3). A `NULL` compat refuses an older image (spec §8.4).
- **Breaking (8):** `0084` (drops the notification outbox table), `0089_drop_swarm_schedules`, `0096_drop_swarm_scheduler_jobs`, `0097_stream_events_grant_only`, `0098_stream_event_counter`, `0106_webauthn_challenge_slots`, `0107_revoke_runtime_delete`, `0110_drop_swarm_judge_fault_injection`.
- **Additive (26):** `0082`, `0083`, `0085`–`0088`, `0090`–`0095`, `0099`–`0105`, `0108`, `0109`, `0111_swarm_judge_model_deepseek_v4_1_flash`, `0112_rm_app_overwrite_events_read`, `0113_rm_worker_buyback_indexer_grants`, `0114_seat_in_flight_unrostered_sessions`, `0115_token_market_samples`.

After R6.3 the ledger holds 116 rows: the 76 recorded names plus these 40 files.

Because a pending migration is `breaking`, spec §8.5 fixes the order: stop (R6.1), migrate (R6.3),
boot (R6.7a). There is no rolling variant.

`0107_revoke_runtime_delete` takes `DELETE`/`TRUNCATE` from every runtime role. The old
code deletes rows at runtime, so **old code cannot run against the migrated database**
(spec §3, D55 (6)). A code-only rollback after R6.3 is impossible. Recovery after that
point is a database restore (section 8).

## 2. What changes for the operator

The operator gives one go and reads receipts. The operator types nothing on a host during the run.
The one human input of the release process comes before it, in provisioning: the admin types the
`doadmin` password into `bun run role-passwords --target prod` (D61 amendment, owner, 2026-10-08).

| Area | Effect | Step |
|---|---|---|
| Credentials | `~/.env` holds only the D61 allowlist: `host`, `port`, `database`, `dbname`, `sslmode`, `rm_app`, `rm_worker`, `rm_readonly`, `rm_owner`, `RM_ENV`, `RM_CREDENTIALS`, `COINGECKO_API_KEY`. Anything else refuses the boot on prod (preflight check 4). A `doadmin` line refuses, named as the provisioning credential | R6.2 moves every other key, a stray `doadmin` line included, to `~/.env.retired-<run-ts>` (0600) |
| `rm_owner` | A line in the host's `~/.env` (D61). The runbook uses `rm_owner` only. No container, receipt, journal or argument receives it | R1.2 proves it logs in (`SELECT 1`, read-only) before R6.1. R6.2 refuses without it. R6.3 and later read it |
| `rm_owner` password | Nobody types or pastes it. `role-passwords` generates it on the host when `~/.env` has no `rm_owner` line. It sets the password through `doadmin` as a SCRAM-SHA-256 verifier, so the plaintext never reaches the server. It writes `rm_owner = <password>` into `~/.env` (atomic, 0600) and proves the login. A working line is kept. An empty line refuses. A line that does not log in refuses: only `--rotate rm_owner` replaces it, keeping the old one in `~/.env.retired-<ts>` | Before the run: `role-passwords`. R6.3 to R6.5 read it |
| `rm_app`, `rm_worker`, `rm_readonly` | `role-passwords` keeps each working line and runs no `ALTER`. It generates an absent one. It never rotates one without `--rotate`, which would lock out the legacy stack while it runs | Before the run: `role-passwords` |
| `rm_owner` password and login | Set before the run by the provisioning step `bun run role-passwords --target prod`. It is idempotent: it sets the password and `LOGIN` as `doadmin` and writes the `rm_owner` line. R1.2 refuses with "rm_owner cannot log in; run `bun run role-passwords --target prod` first" | Before R1, not a runbook step |
| `doadmin` | Stored in no file. The admin types it at the hidden prompt of `bun run role-passwords`. It lives only in that process's memory. No release step reads it | Provisioning only |
| `credential.json` | Written by the runner at `~/.config/robotmoney/credential.json` (dir 0700, file 0600). It holds the in-house roster (agents `athena`, `noop-analyst`, `robot-money`; judge `themis`), fresh keys, the model key from `~/.env`, and placeholder bearers. It appends `RM_CREDENTIALS` to `~/.env` | R6.2a, before R6.2 moves the model key out |
| Service tokens | Three (`system-scheduler`, `analytics-producer`, operator admin) in the api's token store. Secrets in per-instance files under `~/.local/state/robotmoney-smoke/rm_prod/tokens/<holder>/token`. Replaces `ADMIN_TOKEN` | R6.5 |
| Participants | Standing containers from `credential.json`. The judge is a participant (`themis`). No inline judging, no fallback path | R6.7a, R6.7d |
| In-house keys | **One-time credential migration (this release only).** The three seated agents and the judge move from the committed fixture keys to the keys in `credential.json`. One-way | R6.7c |
| Sessions | Timed by `system-scheduler` per subject epoch. No schedule rows. The host driver is retired | R6.1 stops the driver |
| Old checkout | Renamed `<path>.v0.5.4-retired`, locked `go-rwx`, its `.env` secrets moved to `~/.env.legacy-retired-<run-ts>` | S8.1 |
| Deletes | No runtime role deletes. Pruning is `bun run prune` (`rm_owner`, 7-day floor) | Not part of the cutover |
| Site | Own unit. `bun smoke:web` refuses a site whose `apiRange` excludes the running api | R6.10 |
| API limit | Explicit 10 s request limit; a request over 5 s is logged | R7.3b reads it (R8.u) |
| Analytics cadence | The `--static-port` boot sets the realistic profile: regime `30 */3 * * *`, research `0 */3 * * *` | R7.4a checks minute 30 |
| Gecko | The paid key is on the `~/.env` allowlist and forwarded to the worker lanes (1098) | None |

**Boot settings.** `bun smoke` runs `--no-env-file`, so the old checkout `.env` reaches nothing. The
runner exports `PROJECTS_SOURCE=live` on both boots. Other non-secret settings go in the target
file's `bootEnv`: `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, `BASE_RPC_MAX_CALLS_PER_SEC`,
`BASE_RPC_RATE_BURST`, `WALLET_BACKFILL_MAX_DAYS_PER_RUN`, `WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY`,
`GECKO_OHLCV_MIN_INTERVAL_MS`, `PG_NAMESPACE_GUARD_TIMEOUT_MS`. Set one only if production's old
`.env` set it. `prod.json` ships `bootEnv: {}`. `BASE_RPC_URL` has no delivery path: a private RPC
URL carries its key, and the target file refuses it. Tokens, session schedules and judge settings
from the old `.env` no longer exist in the stack. `RM_ALLOW_HANDLE_NAMESPACE_VIOLATION` is never
forwarded.

## 3. Roles and what each step may hold

| Step | Credential held | How it arrives |
|---|---|---|
| R2.1 capture | `rm_readonly` against the **read replica** | the capture host's `~/.env` |
| R1.2, R2.3, R6.2a | `rm_readonly`, read-only session | the target's `~/.env` |
| R2.5 | none. It reads container logs | — |
| R1.2 owner login proof | `rm_owner`, `SELECT 1` only | `~/.env` |
| `role-passwords` (before the run, not a step) | `doadmin` | typed at a hidden prompt on the control machine, then ssh's stdin, plus `--confirm-target`. Never a file |
| R6.3 migrate | `rm_owner` | `~/.env`, plus `--confirm-target` |
| R6.4, R6.5 | `rm_owner` | `~/.env`, plus `--confirm-target` |
| R6.7c rebind | operator admin token | the R6.5 token file, plus `--confirm-target` |
| R6.7a, R6.7d boot | `rm_app`, `rm_worker`, `rm_readonly` | `~/.env` |
| R7.x, W1 | read-only roles and container logs | `~/.env` |

**No step prompts** (D61). Each command runs under `env -i` with a fixed `PATH`, `HOME` and
`RM_ENV`. Production's `/etc/environment` exports a `doadmin` `DATABASE_URL`, and no command sees
it. Each write names its target with `--confirm-target <host:port/database>`. The value is the
target file's `confirmTarget`. R1.2 refuses a value that differs from what `~/.env` resolves.

## 4. R0 Go/no-go (policy §4.1)

The owner writes the go only when all of these hold:

- B1–B27 each closed, with the decision written in the tracking issue.
- `release:v0.6.0` tracking issue exists, scope frozen, Phases complete (policy §6).
- The QA commits the owner picked are merged into `releases-0.6.x` (policy §4.6 step 5). The pinned
  commit's tree is the tree that passed stage.
- CI on the pinned commit is green: `e2e`, `unit`, `backend`, `integration`, `contract`,
  `web-client`, `repo-guards`, `docs-lint` (standing SP.7).
- Two stage runs passed (section 7). The prod run names the second one.
- The recovery matrix (section 8) is signed. The window and the maximum write loss are named in it.

The go file lives on the control machine. Its format is in [`release-run.md`](./release-run.md#the-go-file):

```text
release: v0.6.0
commit: 9d30b960fcb01a20e12a9118dd46dfd5c8f85eac
target: prod
recovery: ~/recovery-matrix-v0.6.0.signed.md
operator: <name>
date: <yyyy-mm-dd>
```

## 5. R1 Release identity (steps R1.1 to R1.6)

| Step | Host | Does | Irreversible | Read in the receipt |
|---|---|---|---|---|
| R1.1 | target | `git fetch`, then detach at the commit in `/root/rm-060` | no | stdout: HEAD at the commit |
| R1.2 | target | `host-identity.ts`: HEAD and clean tree; `bun`, `docker`, `tmux`, `git` resolve; no inherited `DATABASE_*`; `~/.env` resolves to `confirmTarget`; the database answers; its ledger is a supported baseline; its identity is absent; `~/.env` holds a non-empty `rm_owner` line and `rm_owner` logs in (`SELECT 1`, read-only), else it refuses naming `bun run role-passwords --target prod` | no | `host-identity.json`: tool paths, resolved target, ledger match, `ownerLogin` |
| R1.3 | target | `bun install --force`, root and backend | no | exit 0 |
| R1.4 | capture | the same checkout on `rm-frontend-stage-2` | no | stdout |
| R1.5 | capture | `host-identity.ts` without the database checks | no | `host-identity.json` |
| R1.6 | capture | `bun install --force`, root and backend | no | exit 0 |

The code gate (standing SP.7) is CI on the pinned commit. The runner does not run tests on a host.
A test suite that names `upgrade-from-release`, `first-production-migrate` and
`identity-first-pass` is the CI evidence policy §8.1 asks for. Cite it in the report.

## 6. R2 Baseline and backup (policy §§4.2, 4.3), read-only

| Step | Host | Does | Irreversible | Read in the receipt |
|---|---|---|---|---|
| R2.1 | capture | `smoke:capture` from production's **read replica** as `rm_readonly`, into a new `~/rm-backup-<target>-<run-ts>`. Three read-only guards, no override | no | `manifest.json`: `capturedAt`, sizes, `pg_dump` and server versions |
| R2.2 | capture | `sha256sum` of the `.gpg` files | no | `SHA256SUMS` |
| R2.4r | capture | `restore-proof.ts`: restore the R2.1 dump into a throwaway local Postgres, count its ledger, drop it | no | `restore-proof.json`: restore time, ledger count 76 |
| R2.3 | target | `baseline.ts` through `rm_readonly`: ledger, `deployment_identity`, the five roles, migration 0101's would-clear list, `matchSupportedRelease`, row counts, database size, sessions in flight | no | `baseline*` under the instance's release dir |
| R2.5 | target, legacy checkout | the legacy checkout's own `prod:gate --mode baseline` on the running v0.5.4 stack | no | `prod-gate-baseline.md` and its JSON |

What to check in R2.3's receipt:

- The ledger has 76 rows. It matches `v0.5.0+0061+0062+0063+0080 (production ledger 2026-10-01)`.
  Any other match means production's ledger moved. The step refuses.
- `deployment_identity` is absent (pre-0081).
- `rm_owner` reads `rolcanlogin = t`: `bun run role-passwords --target prod` ran before the release, and R1.2 proved the login.
- The would-clear list (D55 (2), issue 1120) names only members you accept losing `robotmoney` for.
  An in-house seat (`athena`, `noop-analyst`, `robot-money`, `themis`) refuses the step.
- The counts of `swarm_sessions`, `swarm_recommendations`, `swarm_consensus_receipts`,
  `swarm_session_judgements`, `source_value_versions` and the database size. R7.5 compares them.
- The in-flight sessions. R7.4a checks each one published.

**R2.5 triage.** Every failed finding is an owner decision before the cutover. The owner writes a
triage file on the control machine, one line per accepted finding
([`release-run.md`](./release-run.md#triage-of-the-baseline-gate)):

```text
# check | fragment of the gate's detail line | reason, issue or decision
jobs | model_unavailable:judge model responded 402 | Zen balance empty until the 2026-10-08 top-up
```

The 2026-10-08 stage runs name two entries: the 402 above (finding 1) and the 404 on the retired
model id (finding 2). R2.5 passes on a non-zero exit only when the file covers every finding. A
finding the file does not name stops the run. R7.3a never reads the triage.

## 7. Stage rehearsal (policy §§4.4, 4.5), stage-2 only, never production

The stage target is production's pre-cutover shape on `rm-frontend-stage-2`
([`stage-target.md`](./stage-target.md)). It has a remote-style Postgres restored from a fresh
production dump, DigitalOcean's role shape, a `~/.env` with production's key names, and the
legacy v0.5.4 stack running against it the way production runs it. The runner runs production's
step list against it unmodified (D61 rule 2). Only `scripts/release/targets/stage.json` differs.

### 7.1 The run, twice (standing SR.10)

Everything runs from the control machine. Repeat this sequence twice, each time from a new dump.

1. **Capture a fresh dump** on stage-2 from production's replica. [`stage-target.md`](./stage-target.md#rebuild-it-for-each-rehearsal)
   step 1 gives the control-machine ssh line. Never reuse a dump already on the host (policy §4.3).
2. **Rebuild the stage target** from that dump:

   ```bash
   bun scripts/release/stage-target.ts up --dump /home/stage-server/rm-backup-prod-<stamp> --replace
   bun scripts/release/stage-target.ts status
   ```

   `up` refuses a dump older than 24 hours. `--replace` runs `down` first. A full `up` takes about
   15 minutes. `status` must report every piece present, the ledger at 76, no identity row, and the
   legacy driver running.
3. **Run the release** against it:

   ```bash
   bun run release:run --target stage --dry-run
   bun run release:run --target stage --go <stage go file> --triage <triage file>
   ```

   The stage go names `target: stage`, the same commit and a `recovery:` file. Pass `--triage`
   only when R2.5 fails on the stage legacy stack. The run stops before W1
   with exit 3 and prints when W1 becomes runnable (R6.9 plus 6 h). R5.rc and W3 record
   `skipped: stage`.
4. **Resume for the watch** after the 6 h:

   ```bash
   bun run release:run --target stage --go <stage go file> --run <run-ts>
   ```

5. **Tear stage down** as soon as the run ends, passed or stopped:

   ```bash
   bun scripts/release/stage-target.ts down
   ```

   Owner rule 2026-10-08: never leave stage running and spending inference credits. A stopped run
   that is fixed and resumed the same hour may stay up. Otherwise tear down, and the next attempt
   starts again at step 1.

A failure stops the run at the failed step. The fix lands in a worktree branched from the QA branch,
merges into the QA branch, and the target files are re-pinned to the new commit. The step-list hash
or the commit then differs, so the run starts again from step 1 on a new dump. A stage failure does
not consume an rc number.

### 7.2 What the stage journals prove

Each run journals on the control machine under `~/.local/state/robotmoney-release/stage/<run-ts>/`.
The prod run names the second passed run with `--stage-journal`. The rehearsal report (policy §4.5,
standing SR.8) cites both journals: commit, step-list hash, dump identity (`manifest.json`,
`SHA256SUMS`), restore time (R2.4r), R6.3's migrate receipt, the boot plans and readiness, R7.3's
verify output, the R7.3a and W1 gate reports, R7.3b's soak reports, R7.4a's parity receipt, and the
operator's go/no-go.

The stage target keeps production's 6 h epochs. W1 and R7.4a therefore grade the real schedule:
B2, B3, B5 and B20 are proven there.

### 7.3 The short twin rerun (required for v0.6.0, owner 2026-10-08)

The twin is a `--local dump` instance: Docker Postgres that smoke owns, restored from a fresh dump,
every active member seated on a spoofed key, with short epochs set by `twin:accelerate` (standing
SR.1, SR.9). It covers the roster and judge checks that the 6 h stage target cannot: the four external members
never reach a stage database, so only the twin seats every active member. For v0.6.0 it runs once at
the release commit, accelerated to 900 s epochs for about 45 minutes, then it is torn down (owner rule:
no stage stack keeps spending inference credits). It checks:
every member seated (`twin-roster:every-active-member-seated`), the full verify tier (SR.3), the
twin gate (SR.4) and the judge on short epochs (B17). It is not the cutover rehearsal and proves
nothing about production's step list. The standing runbook's SR rows name its tools. Tear it down
the same way when done. Its last full run passed on 2026-10-06 at `df5a4aa7` and on 2026-10-07 at
`88825199` ([report](../reports/2026-10-07-v0-6-0-stage-rehearsal.md)).

### 7.4 Evidence carried from the twin sessions

These checks ran on the twin and are not repeated by the runner:

- **Interruption (SR.5).** 2026-10-06 at `3cdc883b`: a SIGKILL inside `prepare (migrate)` left the
  ledger at 77 rows; the rerun resumed and finished at 114. SIGINT at `prepare (images)` and at
  `participants` each resumed plan `45777480e01d` to READY. 2026-10-07 repeated it at `88825199`.
  The runner itself resumes at a step boundary with `--run` and `--from`.
- **Rollback (SR.6).** 2026-10-06: restore 2 min 55 s; runtime DELETE as `rm_app`/`rm_worker`
  refused; the old `bun run migrate` exits 0 and re-seeds the 5 `swarm.*` schedules (B13).
- **Site rollback.** 2026-10-07: forward, rollback, forward again. No runner step rolls the site back.
- **Rebind order (B10).** 2026-10-06: rebind, old bearers answer 401, a second boot recreates the
  participants on the new keys. R6.7a to R6.7d encode that order.

## 8. Recovery matrix (policy §4.8), signed before the go

The go's `recovery:` key names the signed copy of this matrix. The journal records its sha256.

| Where it stops | State | Recovery |
|---|---|---|
| Before R6.1 | Nothing changed | Fix and resume the run (`--run <run-ts> --from <step>`) |
| After R6.1, before R6.3 commits | Legacy stack down, database untouched | Restart the legacy stack as the target file's `legacy.startedBy` says. No runner step does this yet. It is the operator's recorded decision |
| R6.3 fails or is killed | Ledger partly ahead of manifest ("in progress"); the boot refuses it | **Resume at R6.3** (`--from R6.3`). The migrate validates committed work and resumes (spec §8.3). Do not edit rows. Do not boot |
| Migrate done, a boot or preflight refuses | New schema, no service running | Fix forward: a new commit, re-pinned, re-run on stage, then resume. The journal names the phase |
| Migrate done, product wrong | New schema, new code live | **No code-only rollback** (0107, section 1.1). Either fix forward on a new rc, or restore the R2.1 dump into a fresh primary and repoint, which loses everything written after the dump |
| Any step after R6.3, old checkout present | The old `bun run migrate` (as `rm_owner`) does NOT refuse the migrated database: it reports its 76 files current and re-seeds the `swarm.*` job_schedules 0089 deleted (B13). Only the old api/worker's runtime DELETEs are refused (0107) | Never run anything from the old checkout after R6.3. S8.1 renames it right after R6.3 |
| After R6.7a began | The old services are gone | R6.7b or R6.9's status shows new and old per service. Resume at the failed step |
| R6.7c done, R6.7d fails | The in-house members hold the new keys; running participants answer 401 | Resume at R6.7d. Never rerun R6.7c |

The database restore path is a **decision for the operator at the time**, recorded with the
write loss it implies. Do not delete history rows to tidy a failed run (append-only).

## 9. Production run, IRREVERSIBLE from R6.1

Run from the control machine, at the pinned commit, with a clean checkout:

```bash
bun run release:run --target prod --dry-run
bun run release:run --target prod --go <go file> --triage <triage file> --stage-journal <passed stage journal dir>
```

The runner prints the plan: target, commit, step-list hash and every remote command. It refuses to
start unless the stage journal has the same hash and commit with every step ok (SP.8). It stops at
the first failed step and prints the resume command. Past an irreversible step it points at
section 8.

The run stops before W1 with exit 3. Resume it after R6.9 plus 6 h:

```bash
bun run release:run --target prod --go <go file> --stage-journal <passed stage journal dir> --run <run-ts>
```

The journal is under `~/.local/state/robotmoney-release/prod/<run-ts>/`. Each step's
`result.json`, `stdout.log` and `receipts/` are what the operator reviews.

### R5 and R6 cutover steps

| Step | Does | Irreversible | Read in the receipt |
|---|---|---|---|
| R5.rc | Tags the next free `v0.6.0-rc.N` at the commit and pushes it, on the control machine. Keeps an rc that already points there | no | stdout: the tag name |
| R6.1 | `stop-legacy.ts stop`: kills tmux `driver`, then `docker compose down` for `rm_prod` (never `-v`), proves no legacy container remains | **yes**: the stack is down from here | `stop-legacy.json`: session and project stopped, zero containers left |
| R6.2a | `credentials-init.ts`: reads the four in-house member ids through `rm_readonly`, writes `credential.json` and `RM_CREDENTIALS`. Keeps an existing file with the same roster | no | `credentials-init.json`: handles and key names only |
| R6.2 | `env-rewrite.ts`: `~/.env` to the D61 allowlist. Other keys, a stray `doadmin` line included, move to `~/.env.retired-<run-ts>` (0600). Refuses without `rm_owner` or `RM_CREDENTIALS` | no | `env-rewrite.json`: kept and moved key names |
| R6.3 | `bun run migrate`: `0081_deployment_identity` first with `production` in the same transaction, then every pending file in filename order | **yes**: no code-only rollback after this | `migrate-receipt-*.json`: pre-identity state, matched baseline, **40 applied files**, ledger at 116 rows (76 + 40) |
| S8.1 | `stop-legacy.ts retire`: renames the old checkout to `/root/robotmoney-frontend.v0.5.4-retired`, `chmod -R go-rwx`, moves its `.env` secret lines to `~/.env.legacy-retired-<run-ts>` (0600) | no | `retire-legacy.json`: new path, moved key names |
| R6.4 | `prod-init set-identity`: reads the identity the migrate wrote. Writes nothing | no | `set-identity-*.json`: kind `production` |
| R6.5 | `prod-init provision-tokens`: mints the three service tokens. A rerun is a rotation | no | `provision-tokens-*.json`: three holders |
| R6.7a | Boot 1: `bun smoke --static-port` with `PROJECTS_SOURCE=live`. Preflight, replace, readiness, exit | no | stdout: plan id, preflight checks 1 to 6, readiness |
| R6.7b | `smoke:status` after boot 1 | no | stdout: every service ready |
| R6.7c | `prod-init rebind-members`: the one-time credential migration. The in-house members move from fixture keys to `credential.json`. No external member is rebound | **yes**: one-way, old keys stop at once | `rebind-members-*.json`: the in-house members rebound, no external one |
| R6.7d | Boot 2: a new plan, never a resume, because the rebind changed the key fingerprints. Recreates the participants on the new bearers | no | stdout: a new plan id, participants ready |
| R6.9 | `smoke:status` after boot 2. Its end is READY, the start of the 6 h watch | no | stdout: the receipt as history, the daemon as now |
| R6.10 | `bun smoke:web`: the site, after the api is in range. Restarts no api or worker | no | stdout: the site's `apiRange` accepted |

The rebind (R6.7c) runs **once, at this cutover**. It is spec §9.1 step 6, never part of `bun smoke`
or of a later boot. It is not a standing check. A later release repeats it only if that release
changes who holds which key, and says so in its own runbook.

If preflight refuses at R6.7a or R6.7d, the printed check number names the cause: 1 role auth,
2 privileges, 3a manifest, 3b compat, 4 `~/.env` keys, 5 identity, 6 subject scheduling columns.

## 10. R7 Postflight and watch (policy §§4.7.1, 4.9)

| Step | Does | Irreversible | Read in the receipt |
|---|---|---|---|
| R7.1 | `identity-check.ts`: `/api/version` and `/version.json` at `https://robotmoney.network` carry the commit (the site's short stamp accepted). No `+dirty` or `+unknown` | no | `identity-check.json` |
| R7.2 | `smoke:status`: preflight green; readiness green for `api`, the pipeline worker, `analytics-producer` (seed done) and the scheduler (authenticated, stream synced, every active subject holding a `collecting` session) | no | stdout |
| R7.3 | `verify:live`, **readonly tier only** | no | `R7.verify` receipt: exit 0 pass, 1 wrong, 2 nothing asserted. A WARN is not a pass. List what it could not exercise |
| R7.3a | `prod:gate --mode post-release --defer-sessions`: nothing new is unclassified. Sessions are graded later at W1 | no | `prod-gate-post-release.md`. Compare with R2.5. The 402 and the 404 must not recur |
| R7.3b | `soak:checks --record` at READY, then `--full` | no | `soak-record.md`, `soak-full.md`: 0 FAIL. Read every WARN. R8.u lists slow api requests (the 5 s line) |
| R7.5 | `compare-baseline.ts`: every R2.3 count only grew; database size within 1.5× | no | `compare-baseline.json` |
| R7.7 | `host-guards.ts`: no container mounts `docker.sock`; `~/.env` keys within the allowlist; token files 0600; no file other users can reach under `HOME` or the retired checkout holds a postgres URL with a password | no | `host-guards.json` |
| W1 | Not before R6.9 plus 6 h. `prod:gate --mode post-release --since <READY>`, sessions graded | no | `prod-gate-watch.md` |
| R7.4a | Not before R6.9 plus 6 h. `schedule-parity.ts` | no | `schedule-parity.json` |
| W3 | Tags `v0.6.0` at the commit and pushes it, on the control machine | no | stdout: the tag |

**R7.4a, schedule parity** (owner rule: an upgrade does not change usual schedules). Every active
subject reads `epoch_duration_seconds = 21600` (B3). Every session in flight at R2.3 published on
its unmoved close, within its judging time plus 30 minutes (B2, B20). The regime cron has minute 30.
The last parity sweep's duration is reported, and a dead sweep fails (B5).

**W1, one full session cycle** (what the old R7.6 watched by eye). Every subject opens a session on
its grid. Agents submit one final take each. `themis` submits a judgement and is never restarted. A
consensus receipt publishes, or the session reads `no_consensus`, which is a warning, not a failure.

The tag goes on the commit production runs and was verified at, even if the watch was imperfect.
Fixes go in the next patch version from `-rc.0`.

## 11. Report (policy §4.9)

The report cites the prod journal and the two stage journals. It names: the rc and final tags; the
commit and step-list hash; the R2.1 manifest and `SHA256SUMS`; the R2.4r restore time; the go's and
the triage's sha256; R6.3's migrate receipt and timing; the boot plans; which blockers closed and
how; R7.3's verify output and its unexercised invariants; the gate, soak and parity reports; the
backport TODOs (§7 of the policy); and the operator's sign-off. The tracking issue closes only after
the report is filed and `v0.6.0` exists on `releases-0.6.x`.
