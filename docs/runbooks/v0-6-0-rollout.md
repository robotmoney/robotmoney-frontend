# v0.6.0 production rollout — the first cutover on the smoke production design

> **Status: draft, cutover BLOCKED.** Section 0 lists what must clear first.
> Written against `origin/main` at `d20429ca` (the `releases-0.6.x` cut). Every
> command below was checked to exist at that commit (`package.json`, the script
> headers named in each step). Re-run section 1 at the RC commit and fix any line
> that moved. Policy: [`release-runbooks.md`](../technical/release-runbooks.md).
> Mechanism: [`smoke-production-spec.md`](../technical/smoke-production-spec.md) (D47).

## Inherits the standing runbook

This runbook runs **every check in [`release-standing-runbook.md`](./release-standing-runbook.md)**
(written against the commit that adds it) and adds the 0.6.0-specific checks below. It cites
standing checks by ID. **Exceptions:** none granted. Two standing rows are `gap` and block the
cutover until they close: SR.7 and SW.2 (the cumulative standing invariants, issue 1179, B16).

Where the standing runbook says to run a check and a step below does not repeat it, run it anyway.
The standing checks this release's steps map to:

| Phase | Standing checks | Where it runs below |
|---|---|---|
| Preflight and baseline | SP.1 to SP.7 | R1, R2, `bun smoke` preflight; **SP.5 `prod:gate --mode baseline` is R2.5** |
| Stage rehearsal | SR.1 to SR.8 | R3.2 to R3.10; **SR.4 `twin:gate` is R3.4a** |
| Cutover and verification | SC.1, SC.2, SV.1 to SV.6 | R6, R7; **SV.4 `prod:gate --mode post-release` is R7.3a** |
| Watch | SW.1 to SW.3 | R7.6, R7.8 |

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
| `twin:gate`, `prod:gate` | Ported to main's instance model (1071, B7 merged). Run at R2.5, R3.4a, R7.3a |
| `soak-checks.sh` (cumulative R8 invariants) | **Not ported.** Issue 1179, blocker B16. Standing runbook rows SR.7 and SW.2 |

## 0. Rule, decisions and blockers

**Rule (owner, 2026-10-03).** v0.6.0 changes how production is deployed, not what the
product does. Where main differs from production (v0.5.4), production's behavior wins
unless a recorded decision says otherwise. An upgrade does not change usual schedules.
Plan and status: phase issue 1099.

**Decided, not built:** operator cancel/reopen stays removed (D55 (4)); main keeps its
stricter four-weight submit rule (notice: 1124); the stray `v0.6.0-rc.0` tag is deleted
(2026-10-03), so the first candidate is `v0.6.0-rc.0`; the log gates are ported (1071).

**Cutover stays blocked until every row is closed with evidence.** State at releases-0.6.x
tip 41d75aaa (2026-10-03): code for B1-B8 is merged and CI is green. What remains is proof
on stage-2 with the real restored dump, plus the three open rows below.

| # | Blocker | Code | Proof still owed |
|---|---|---|---|
| B1 | Baseline: production's 76-name ledger replaces the old one; unreleased migrations renumbered 0081-0110 so no pending file sorts inside the recorded range (1097) | merged | first production migrate on the real 2026-10-01 dump (R3.2, R6.3); read the live ledger (R2.3) |
| B2 | In-flight sessions finish on their normal timing, no drain step (1111) | merged | a dump with sessions in each state publishes them (R3) |
| B3 | Existing subjects stay on 6 h epochs, grid continued from each subject's last close (1112) | merged | R7.4a on the rehearsal; the owner confirms the grid against prod session history |
| B4 | Settings reach the containers; prod refuses without `PROJECTS_SOURCE=live` (1113) | merged | list of keys taken from the old host's checkout `.env` (R6.2a) |
| B5 | Parity sweep keeps its 240 s exemption (1114) | merged | a 25 s sweep completes on stage |
| B6 | Production parity: judge retry (1117), judge model from the database (1118), verified receipt path (1119), today's regime (1108), in-house seats keep their operator (1120), absence savepoint (1122) | merged | R7 checks. **Persona-voiced sectioned takes (1116): PR 1131 open, waiting on the owner's decision** |
| B7 | Log gates `twin:gate` and `prod:gate` ported (1071) | merged | first live run will show unclassified lines; add a rule only with evidence |
| B8 | Mid-window dump adoption and the first-epoch bound (1121) | merged | `e2e` green on the RC commit |
| B9 | `release:v0.6.0` tracking issue | open | to file |
| B10 | `rebind-members` order on the breaking-migration path | none | settled by R3.8; the twin route needed PR 1176 (prod-init targets the twin) and is bounded by 1174 (no cold re-boot of a twin) |
| B11 | The buyback indexer ran in the worker as `rm_worker` while its `buyback_scan_state`/`buyback_swaps` sites declared `rm_app`, so every sweep on the migrated dump was refused and swallowed; production's v0.5.x worker holds the api's URL under `RM_ENV=smoke`, which is why buybacks work there today (1150) | fixed (1171), verified on `90f00c8b`: rm_worker holds INSERT/SELECT/UPDATE on `buyback_scan_state`, no `live index failed` line, the sweep scans | R3/R7: `docker logs <project>-worker-analytics-1 \| grep "live index failed"` empty, and `buyback_scan_state.updated_at` advancing on the twin |
| B12 | The twin seated only `credential.json` members; the verify leg `twin-roster:every-active-member-seated` caught it (1152) | fixed (1164), verified: 7 of 7 seated on `7d69d17c` | — |
| B13 | The old checkout's `bun run migrate` runs clean against the migrated database and re-seeds the `swarm.*` job_schedules 0089 deleted (1155) | closed, no action (owner 2026-10-05) | section 8 says: never run the old checkout after R6.3; R6.1 renames it |
| B14 | A resume after replace could not start participants from the pruned api image id (1160) | fixed (1161), verified on `62ec5920` | — |
| B15 | A failed take re-ran on the next tick with no delay; seven seats hammered the shared Zen key (see the issue). The take one-shot also could not find its script from the per-take workspace (1166) | fixed: backoff (1168) and give-up after 5 failed takes (1169, owner rule), verified on `7d69d17c` | — |
| B16 | The cumulative standing invariants (`soak-checks.sh`, R8.a to R8.y) are not on the 0.6 line, so SR.7 and SW.2 have no tool (1179) | open | port to the instance model, or an owner decision per standing runbook section 6 |

Also open: the notice to external members about the four-weight rule (1124); the
`judging` banner (1115, merged) and admin items (1123, merged) need only the R7 spot check.
Known flake: the smoke integration suites hit an EPIPE in the boot child (1141); re-run, do
not treat as a product failure.

## 1. Release identity

| Item | Value |
|---|---|
| Branch | `releases-0.6.x` (cut from `origin/main` at `d20429ca`, 2026-10-02) |
| From (production today) | v0.5.4: backend at `becb6897` (v0.5.2), site at v0.5.3, 76-name ledger (to be confirmed at R2.3) |
| To | v0.6.0 |
| RC tags | `v0.6.0-rc.N`, cut only after stage passes (policy §3). `N` starts at 0 (the stray tag is gone) |
| Final tag | `v0.6.0`, same commit as the deployed rc, after R7 passes |
| Window | **Long and breaking.** Pending migrations include `breaking` ones, so the stack is **down** from R6.1 until R6.9. Plan for the api, the site and every participant to be unavailable |

```bash
git fetch origin --tags
git switch releases-0.6.x
git rev-parse HEAD            # record as RC_SHA; do not tag yet
bun install --force && bun install --force --cwd backend   # re-run after every switch/checkout
```

### 1.1 Pending migrations (36 files, from the 76-name ledger)

> **Owner, 2026-10-05 (1173):** from v0.6.0 the migration strategy is to become ONE idempotent,
> lossless schema file runnable at any database version. That is filed, not started; this
> release still ships the numbered files below, and this runbook describes that path.

Classification is each file's own `compat:` header at `d20429ca`. Re-derive at the RC:
`comm -13 <(ledger) <(ls backend/migrations | sort)`.

- **No `compat:` header (6, they predate the runner's metadata):** `0056_swarm_judge_requires_model`, `0057_swarm_judge_policy_stamp`, `0058_swarm_judge_fault_injection`, `0059_swarm_judgement_completion_usage`, `0062_rm_worker_analytics_ledger_read_grant`, `0081_deployment_identity`. `0081` is applied first by the guarded pass (R6.3). A `NULL` compat refuses an older image (spec §8.4); confirm the runner treats these as the spec requires at R3.
- **Breaking (8):** `0084` (drops the notification outbox table), `0089_drop_swarm_schedules`, `0096_drop_swarm_scheduler_jobs`, `0097_stream_events_grant_only`, `0098_stream_event_counter`, `0106_webauthn_challenge_slots`, `0107_revoke_runtime_delete`, `0110_drop_swarm_judge_fault_injection`.
- **Additive:** the rest (`0082`–`0083`, `0085`–`0095`, `0099_swarm_judge_model_bare_id`, `0100`–`0105`, `0108`, `0109`).

Because any pending migration is `breaking`, the order is fixed by spec §8.5:
**`bun smoke:down` → `bun run migrate` → `bun smoke --static-port`.** There is no rolling variant.

`0107_revoke_runtime_delete` takes `DELETE`/`TRUNCATE` from every runtime role. The old
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
| Gecko | The paid key is on the `~/.env` allowlist and forwarded to the worker lanes (1098) | None |


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

**On a twin there is no human in the loop.** A `--local dump`/`--local volume` instance
owns a throwaway copy, and smoke generated its `rm_owner` password into the instance state
directory (`role-passwords.json`); smoke's own `enroll`, `migrate` and `tokens` phases type it
for you. Every R3 step, R3.8 included, is therefore runnable by an agent on a stage host; the
typed-at-the-keyboard rule binds R6 on production only. (Clarified 2026-10-05 after an agent
waited on the operator for a twin's password.)

## 4. R0 Go/no-go (policy §4.1)

- B1–B10 each closed, with the decision written in the tracking issue.
- `release:v0.6.0` tracking issue exists, scope frozen, Phases complete (policy §6).
- Every intended commit is on `releases-0.6.x`: `git log --oneline origin/main..releases-0.6.x` and the reverse are empty or fully explained.
- `gh run list --branch releases-0.6.x` shows green `e2e`, `unit`, `backend`, `integration`, `contract`, `web-client`, `repo-guards`, `docs-lint`.
- Operator names the cutover window and the rollback authority.

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
SELECT to_regclass('public.deployment_identity');      -- expect NULL (pre-0081)
SELECT rolname, rolcanlogin, rolcreaterole FROM pg_roles
 WHERE rolname IN ('rm_owner','rm_app','rm_worker','rm_readonly','doadmin');
```

Also list who migration 0101 would clear (D55 (2), issue 1120). It is read-only and
mirrors the migration's rule. Run it, save the output as `would-clear-prod-<date>.txt`,
and read it before cutover. Every row must be a member you accept losing `robotmoney`
for. An in-house seat in the list (`athena`, `noop-analyst`, `robot-money`, `themis`) is
a defect: stop.

```sql
WITH self_writes AS (
  SELECT scope->>'memberId' AS member_id, max(id) AS last_id FROM audit_log
   WHERE action = 'update_profile' AND scope ? 'memberId'
     AND (NOT (scope ? 'fields') OR (scope->'fields') ? 'operator')
   GROUP BY 1),
admin_writes AS (
  SELECT scope->>'memberId' AS member_id, max(id) AS last_id FROM audit_log
   WHERE action = 'member_update' AND scope ? 'memberId'
     AND jsonb_typeof(scope->'fields') = 'array' AND (scope->'fields') ? 'operator'
   GROUP BY 1)
SELECT m.id, m.handle, m.operator, s.last_id AS self_write_audit_id, w.last_id AS admin_write_audit_id
  FROM swarm_members m
  JOIN self_writes s ON s.member_id = m.id
  LEFT JOIN admin_writes w ON w.member_id = m.id
 WHERE lower(trim(m.operator)) = 'robotmoney'
   AND (w.last_id IS NULL OR w.last_id < s.last_id)
   AND m.handle <> ALL (ARRAY['athena','noop-analyst','robot-money','themis'])
 ORDER BY m.id;
```

Then compare with the matcher (`matchSupportedRelease` in
`backend/src/db/supported-releases.ts`). Expect a match with
`v0.5.0+0061+0062+0063+0080 (production ledger 2026-10-01)`. Any other result means
production's ledger moved: stop, and read the `describeUnmatchedLedger` difference.

R2.4 Save, with the dump: row counts of `swarm_sessions`, `swarm_recommendations`,
`swarm_consensus_receipts`, `swarm_session_judgements`, `source_value_versions`; database
size; the AUM figure the site publishes (copy the number and its date from the page). These are the
postflight comparison baseline.

R2.5 **Log baseline** (standing check SP.5): what is already broken in production's logs, triaged
before anything changes. Read-only.

```bash
bun run prod:gate --mode baseline --instance rm_prod
```

Every unclassified line is a decision: classify it with evidence in
`scripts/lib/gate/log-classifications.json`, or file the defect. Keep the report with the dump.
R7.3a is compared against it.

## 7. R3 Stage rehearsal (policy §§4.4, 4.5) — stage hosts only, never production

Run on a stage host (`rm-frontend-stage-2`, `stage.robotmoney-labs.dev`, or stage-1).
The twin is **`--local dump`**: Docker Postgres that smoke owns, restored from the R2 dump.
A pre-0081 dump gets its identity-first pass automatically, but only when its ledger equals
a supported baseline (spec §9.1). A dump that does not match refuses, which is the same
as B1 and proves it on stage before production sees it.

R3.1 Check out the RC commit as a clean checkout of a pushed commit. `git status --porcelain` must be empty and `git log origin/releases-0.6.x..HEAD` must be empty. **Never edit or commit on the stage host.** A blocker is fixed in a dev worktree branched from `releases-0.6.x`, merged there, and the host is re-checked-out at the new tip (policy §4.6). A host that ran other code proves nothing.

Prerequisites found on stage-2 (2026-10-02):

- The model is `deepseek-v4.1-flash` since the merge of main's #1159 (migration `0111` here renames the judge row); Zen answers 404 for the old id.
- `OPENCODE_API_KEY` must be in the process environment for the boot (export that one key from `~/.env`; the preflight warns it is not on the §3 list).
- A `--static-port` boot refuses while another stack holds `:48787`. Take the old stack down first (`bun run smoke:down` from its own checkout).
- Reset a failed attempt with `bun smoke:down --instance rehearse-060`, remove the `rm-restore-*` container, then `bun run smoke:clean`. A changed spoof request (a different member set) also needs the instance's persisted spoof generation moved aside (`~/.local/state/robotmoney-smoke/rehearse-060/spoof-generation`): a generation is reused only by a rerun of the same request, and the restored copy is fresh anyway. Seen 2026-10-05 when the roster grew from 2 to 8 seats.
- A bare `--spoof-keys` with no credentials file boots with an empty roster (no agents, no judges). Pass `--credentials rehearsal-creds.json` (R3.2) to exercise participants.
- Kill any `bun smoke:twin` (or other `bun smoke`) still running from the OLD checkout (`ps -eo pid,etimes,cmd | grep smoke`). On 2026-10-05 a four-day-old `smoke:twin --reuse` from `~/robotmoney-frontend` (v0.5.4) was still alive beside the new instance.
- On a twin, `--spoof-keys` (bare) spoofs EVERY active member, third parties and the judge included (spec §6.4 owned-twin exception, 2026-10-05), and the boot refuses a twin that leaves an active non-judge member unseated. So `rehearsal-creds.json` lists every active member of the dump — 7 agents and the judge `themis` on the 2026-10-01 dump — each with a throwaway key and the stage model key (`~/make-rehearsal-creds.ts` on stage-2 writes it from the member ids).

R3.2 Prepare a rehearsal credential file with **spoofed** keys, never the production
`credential.json`:

```bash
export RM_ENV=stage
export PROJECTS_SOURCE=live   # --static-port runs the containers as prod; without this the boot refuses (R6.2a)
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
invariants this target could not exercise. Passed 2026-10-05 on `7d69d17c` with the full roster: 9/9 PASS, exit 0 (receipt `R3.verify-twin-8seats.json`). Every leg must PASS; `twin-roster:every-active-member-seated` is the twin's own seating proof (B12).

R3.4a **Twin gate** (standing check SR.4), after R3.4 and after the roster has published
sessions. It reads every container log (participants included), default deny:

```bash
bun run twin:gate --instance rehearse-060 --wait 35
```

Exit 0 only when every check passes. A gate run on a twin whose participants cannot authenticate
(for example after R3.8's rebind, before the participants are recreated) fails by design: run it
on a twin in a healthy state, and keep the report. First run 2026-10-05 on `7a4f19ac`: failed on
a broken twin and listed an unclassified coin-price `DEGRADED` warning. Classify it with evidence
or fix it before the RC.

R3.5 Prove the schema gates on the twin (the lines from spec §10 this release depends on):
migrations all recorded once; `deployment_identity.kind = 'rehearsal'`; `schema_manifest`
hash matches the ledger; `rm_app`/`rm_worker`/`rm_readonly` hold no `DELETE`/`TRUNCATE`
(preflight check 2 passing is the proof); 32 WebAuthn challenge slots.

R3.6 **Interruption.** Kill `bun smoke` at a phase boundary before replace, then rerun
under the same plan id: it resumes. Repeat once after replace began. Done 2026-10-05 at `62ec5920`: before replace
(stopped before preflight, resumed to READY) passes; after replace (stopped before participants) resumes
and then fails on B14. A `--static-port` rerun over this instance's own website-server is accepted since #1157. Kill `bun run migrate`
between two commits (the stage form: `bun smoke --local volume --migrate`): the rerun
resumes. Record the journal phase each time.

R3.7 **Site.** Build and switch the site, then roll back:

```bash
bun smoke:web --instance rehearse-060
bun smoke:web --instance rehearse-060 --rollback
```

R3.8 **The production-shaped sequence (settles B10).** Repeat R6.3–R6.9 against a target
enrolled `rehearsal`, with the restored members holding keys the credential file does not
(production's case: fixture keys vs `credential.json`). Two targets qualify:

- A **remote** stage database (restore the dump there by hand per
  [`pre-identity-remote-twin.md`](./pre-identity-remote-twin.md)), with real `bun run migrate`
  prompts and `prod-init provision-tokens` under `RM_ENV=stage`. None exists as of 2026-10-05.
- The instance's **own twin** on stage-2. Nobody is at the keyboard: migrate and tokens are
  smoke's phases on the generated credentials (section 3), and `prod-init rebind-members`
  under `RM_ENV=stage` addresses the twin through its generated `rm_readonly` (PR 1176),
  not `~/.env`. What is left to rehearse is the ORDER of `bun smoke --static-port`,
  `prod-init rebind-members` and the participants picking up the new bearers.

The twin route, on stage-2, run 2026-10-05 at `7a4f19ac` (script `r38c.sh`):

1. Boot the twin (R3.2). Every restored member is seated on a generated key.
2. Give `~/rehearsal-creds.json` fresh keys, so it holds keys the database does not.
3. `bun scripts/prod-init.ts rebind-members --instance rehearse-060 --credentials
   ~/rehearsal-creds.json`. **Observed:** 8 of 8 rebound against the twin, no prompt but `y`.
4. **Observed:** the running participants, still on their old bearers, answer 401 and
   print `refuses to poll: tokenValid=false`. A rebind therefore always needs the
   participants recreated, so R6.7's re-run of `bun smoke --static-port` after
   `rebind-members` is REQUIRED, not conditional.
5. **Observed:** that re-run is a NEW plan, never a resume. The plan id includes the
   credential file's key fingerprints, and the rebind just changed them.

Limit of the twin route: step 5 cannot finish on a twin. A new plan under `--local dump`
restores a fresh copy beside the live twin and fails with `Postgres never became ready`;
`--local volume` cannot reattach a dump twin (issue 1174). So the twin proves steps 1 to 4
and the order. The second boot is only rehearsable on a remote stage database, or once
1174 closes. Never run `bun run migrate` on stage-2: its `~/.env` points at production's
read replica.
Write down the exact order that works for `rebind-members` and whether the participants
need a second `bun smoke --static-port` afterwards. Edit R6.7 to match, in a commit on
this branch, before any rc tag.

R3.9 **Rollback rehearsal.** Restore the R2 dump into a fresh local database and prove the
**old** (v0.5.4) code refuses or cannot run against the migrated one only in the ways
section 8 states. Record the restore time. Done 2026-10-05: restore of the 2026-10-01 dump takes
2 min 10 s on stage-2; runtime DELETEs as `rm_app`/`rm_worker` are refused; the old `bun run migrate`
is NOT refused (B13).

R3.10 Rehearsal report (policy §4.5): RC SHA, dump identity, plan id, preflight and
readiness receipts, participant results, `verify:live` output, interruption results, what
could not be covered (the cumulative standing invariants, SR.7, until issue 1179 closes), the `twin:gate` report (R3.4a), and a go/no-go signed by the operator. Every standing check in the standing runbook is accounted for by ID.

### R3.11 Cut the RC tag (only after R3.10 is a go)

```bash
git tag -a v0.6.0-rc.N "$RC_SHA" -m 'v0.6.0-rc.N'   # N starts at 0
git push origin v0.6.0-rc.N
```

## 8. Recovery matrix (policy §4.8) — decide this before R6, sign it in the report

| Where it stops | State | Recovery |
|---|---|---|
| Before R6.3 commits | Stack down, database untouched | `bun smoke --static-port` on the **old** checkout (v0.5.4). Old host driver restarted by hand |
| `bun run migrate` fails or is killed | Ledger partly ahead of manifest ("in progress"); application boot refuses it | **Rerun `bun run migrate`.** It validates committed work and resumes (spec §8.3). Do not edit rows. Do not boot |
| Migrate done, boot or preflight refuses | New schema, no service running | Fix forward: rerun `bun smoke --static-port`. The journal says the phase |
| Migrate done, product wrong | New schema, new code live | **No code-only rollback** (0107, section 1.1). Either fix forward on a new rc, or restore the R2 dump into a fresh primary and repoint, which loses everything written after the dump |
| Any step after R6.3, old checkout still on the host | The old `bun run migrate` (as `rm_owner`) does NOT refuse the migrated database: it reports its 76 files current and re-seeds the `swarm.*` job_schedules 0089 deleted (B13). Only the old api/worker's runtime DELETEs are refused (0107) | Never run anything from the old checkout after R6.3. R6.1 renames it (`mv ~/robotmoney-frontend ~/robotmoney-frontend.v0.5.4-retired`) before the window closes |
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

R6.2a **Settings the containers need** (issue 1113). `bun smoke` runs `--no-env-file`, so
the checkout `.env` reaches nothing. Non-secret settings have one path: `export` them in
the shell that runs `bun smoke --static-port`. Secrets never go in the shell or the repo.

| Key | Where it lives | Reaches |
|---|---|---|
| `PROJECTS_SOURCE=live` | shell export, **required**: a prod boot without it refuses before anything starts | api, `worker-analytics` |
| `BASE_RPC_URL` | shell export, if production used a private RPC (the boot prints a note when it is unset) | api, `worker-analytics` |
| `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID` | shell export (the boot prints a note when `WEBAUTHN_ORIGIN` is unset; admin passkeys otherwise use the request origin) | api |
| `BASE_RPC_MAX_CALLS_PER_SEC`, `BASE_RPC_RATE_BURST`, `WALLET_BACKFILL_MAX_DAYS_PER_RUN`, `WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY`, `GECKO_OHLCV_MIN_INTERVAL_MS` | shell export only if production's `.env` set them; unset keeps the built-in default | `worker-analytics` |
| `PG_NAMESPACE_GUARD_TIMEOUT_MS` | same | api |
| `COINGECKO_API_KEY` | `~/.env` (allowlisted, forwarded) | `worker-analytics`, `analytics-producer` |
| Role passwords, `RM_ENV`, `RM_CREDENTIALS` | `~/.env` | the boot |

Read the key names (not values) from the old host's checkout `.env` and export each one
that is in the table. Everything else in that file is dropped on purpose: tokens, session
schedules and judge settings no longer exist in the stack.
`RM_ALLOW_HANDLE_NAMESPACE_VIOLATION` is never forwarded.

R6.2b **One-time role step**, before R6.3 needs the login. If R2.3 showed `rm_owner`
`rolcanlogin = f` (expected on an existing cluster), the operator runs, as `doadmin`:
`ALTER ROLE rm_owner LOGIN PASSWORD '<new>'`, then proves it with a verification login.
Spec §9.1 step 1. The password is not written to any file.

R6.3 **The first production migrate.** Typed `rm_owner`, then `y`. It applies
`0081_deployment_identity` **first** with `production` written in the same transaction,
then every other pending file in filename order (including the five below 0081).

```bash
bun run migrate               # RM_ENV=prod; receipt + journal land in ~/.local/state/robotmoney-smoke/rm_prod/
```

Pass = the receipt records the pre-identity state, the matched baseline, and 36 applied
files (35 plus `0111_swarm_judge_model_deepseek_v4_1_flash` since the merge of main's #1159). A refusal here changes nothing; read the message (B1 is the expected one).
If interrupted after 0081 committed, rerun the same command (normal path, resumes).

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

Re-run `bun smoke --static-port` now. It is required: R3.8 showed every running participant answers 401 after the rebind until a new plan recreates it with the new bearers.

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

R7.3a **Log verdict after the release** (standing check SV.4):

```bash
bun run prod:gate --mode post-release --instance rm_prod
```

What the release was meant to fix is fixed and nothing new is unclassified. Compare with R2.5.

R7.4a Schedule parity (owner rule: an upgrade does not change usual schedules): every
active subject reads `epoch_duration_seconds = 21600`; each session that was in flight at
cutover published on its normal time; the next regime run lands at :30; the hourly parity
sweep completes without a 10 s cut-off.

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
