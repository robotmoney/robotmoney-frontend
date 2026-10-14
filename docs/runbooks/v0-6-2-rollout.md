# v0.6.2 production rollout — the delta runbook

> **Draft — production blocked by the gaps in section 8.** This is the next release's runbook. It holds only what v0.6.2 changes. Everything
> the release repeats is a row of [`release-standing-runbook.md`](./release-standing-runbook.md),
> cited by ID, and the steps are the generic list in [`release-run.md`](./release-run.md), which
> the runner executes (D61). This file lists no command for a person to paste on a host. When W3
> tags `v0.6.2`, this file freezes as history and the next patch gets a new one.

## Inherits the standing runbook

This release runs **every check in the standing runbook** as it stands in the same commit as this
file. This revision was verified against `origin/main` at
`a0c8457d` on 2026-10-14, including the standing runbook at that commit. The local
checkout was older; commands below refer to that inspected source, not the local runner.
Freeze and record the final full SHA after the reviewed runbook and any tooling fixes reach
`releases-0.6.x`; all rehearsal evidence must then name that SHA. It adds the v0.6.2-specific checks below and
cites standing checks by ID. The standing IDs map to the runner steps as
[`release-run.md`](./release-run.md#the-step-list) records (the `standing` column).

**Exceptions** (carried since v0.6.0, owner 2026-10-08, restoring issue agent-executed runbooks
(1225)): SP.6 and SV.5 for the published AUM figure; SW.2 over the watch window (`soak:checks`
runs at READY only); the stage watch is 15 minutes with sessions deferred (`stage.json`).

**Rule (owner, 2026-10-09).** Every production data change ships as a migration. This release's
data delta is section 2.1 and nothing else: no admin-route write, no SQL, no one-off script.

## 1. Release identity

| Item | Value |
|---|---|
| Release branch | `releases-0.6.x`, taking `main` by merge (D62 route (a)) |
| From | v0.6.1 at `bca5186e`: `/root/rm-061`, instance `rm_prod`, ledger through `0119`. R1.2 reads it from the database; the runner holds no baseline constant (issue 1272) |
| To | v0.6.2 at the commit the rc tag names, in a new checkout (`/root/rm-062`), the same instance |
| Stage | Candidate checkout `/home/stage-server/rm-stage-target-v062`; a `releases-0.6.x` commit named by the stage go's `commit:` (D64) |
| rc | `bun scripts/release/tag.ts rc --release v0.6.2 --commit <stage commit>` once the stage run passes; the production go names `tag: v0.6.2-rc.N` |
| Final tag | W3 tags `v0.6.2` at the same commit. A failed later check does not withhold it (D63) |
| Availability | Website stays reachable throughout deploy and rollback; a backend upgrade may temporarily disable API features behind a maintenance notice. Whole-stack stop is forbidden for this release |
| Tracking | Release v0.6.2 (1305): phases runner and gates (1287), deployment lifecycle (1027), 0.5.x port (1304), swarm and analytics fixes (1288) |

**Version interpretation:** the next release within the requested 0.6.x line is `v0.6.2`
(a SemVer patch). A SemVer minor would be `v0.7.0` on `releases-0.7.x`.

Before the run, the target files' `release` reads `v0.6.2` and prod's `checkout` names the new
folder; a go for another release refuses (`P.go`). That edit is a release-branch commit, not a
runner step.

## 2. The delta

### 2.1 Migrations (R6.3 applies them, in filename order)

| File | Does | Postflight |
|---|---|---|
| `0120_maintenance_windows` | The maintenance-window event log (issue 1220): `scheduled`, `started`, `ended`, `cancelled`, one row per state change, insert-only for `rm_app` | R7.3b: R8.k reads the guard on the new table |
| `0121_subject_closes_six_hours_apart` | The four anchors' times of day become exactly 21600 s apart on vault's grid (woon, allocation and treasury move 6 to 12 minutes earlier). Epochs stay 24 h. Idempotent: a second run moves no `version` | section 4 |
| `0122_swarm_dormancy_baseline` | Creates a singleton `counted_from` at migration time; resets the origin for consecutive missed-session counts, without removing seats. Runtime roles have SELECT only | Assert one row, unchanged on migration rerun, correct runtime grants and member-page counts |

For the observed v0.6.1 baseline, R2.3 must list `0120`, `0121` and `0122` as
pending. R6.3 must receipt their full filenames and successful application. Reconcile
by filename and shipped bytes, not by a numeric maximum. Read the live baseline again
before executing; a changed baseline requires a fresh plan and rehearsal.

### 2.2 API and site

| Change | What it does | Issue |
|---|---|---|
| `GET /api/status/maintenance` | The public answer: the live window, or none | 1220 |
| `POST /api/admin/maintenance`, `/:id/start`, `/:id/end`, `/:id/cancel` | The operator's audited window routes | 1220 |
| website-server maintenance mode | With `maintenance.json` in the instance web directory the site serves the maintenance view and answers other `/api/` calls 503 while the api is down. Off-host fallback: `ops/cloudflare/` | 1220 |
| `GET /api/swarm/open-sessions` | Unchanged since v0.6.1. Listed because the member notice (section 5) names it | — |

### 2.3 Gates and runner that changed since v0.6.1

- `prod:gate` fails a release on a boot-time connect retry of `analytics.parity_sweep` before the api
  listens (1307), and classifies web access-log lines and judge SSE reconnects by default, with the
  v0.6.1 shapes classified (1278, 1316). R2.5's triage covers a FAIL check's findings only.
- The runner: the ledger is a prefix check by filename set; R6.1 still stops the stack the smoke state
  names with `smoke:down` — a release blocker under the website availability requirement; R1.1 clones a missing checkout; `--accept` records an owner's acceptance
  of one failed reversible step (1282); a one-time action is a delta step (`RELEASE_DELTAS`). v0.6.2
  declares no delta step.
- D64: stage runs a release-branch commit, the rc is cut there, production runs only by the rc tag,
  and R7.1 fails a production boot whose `/api/version` does not carry it.
- `soak:checks` adds R8.n2 (each container's writable layer under 2 GB) and R8.n3 (host free disk
  within 2 GB of the `--record` baseline), so R7.3b catches disk growth before an outage (1258).

## 3. Release-specific checks

| Check | Phase | Tool | Status |
|---|---|---|---|
| A. The maintenance window is announced before R6.1 and ended after R6.9, and the site stays up through it (standing section 8) | C | `POST /api/admin/maintenance` before the run; `bun scripts/rollout-probe.ts run` during it; `grade` after R6.9: no non-200 answer, no gap over 17 s (15 s interval plus 2 s jitter) | gap: lifecycle helpers exist, but runner integration is missing (1220 / 1305) |
| B. `/api/status/maintenance` answers `none` once the window ends | V | `curl` after check A ends | gap: lifecycle helpers exist, but runner integration is missing (1220 / 1305) |
| C. The four anchors' times of day are 21600 s apart and every epoch is 86400 s | V | R7.4a's receipt lists each subject's anchor and epoch; R7.4a asserts both, the epoch and the 21600 s spacing in the order vault, woon, allocation, treasury (issue 1310) | script (R7.4a) |
| D. The one transition window per moved subject | W | W1 and R7.4a receipts, section 4 | script (R7.4a, graded) |
| E. No container's writable layer is over 2 GB, and host free disk has not fallen more than 2 GB since the READY baseline (issue 1258: the HTTP fetch cache filled prod's disk) | V | R7.3b: `soak:checks` R8.n2 (writable layers) and R8.n3 (host disk free against the `--record` baseline) | script (R7.3b) |

A gap blocks production until a committed receipt-producing step implements it and
stage rehearses it. The carried exceptions above do not authorize a website outage
or waive these new gaps. Cite all results in SR.8 and the production report.

## 4. The turnover proof for the moved anchors (R7.4a and W1)

- An open window keeps the close it opened with. At its turnover the next window closes at the
  first grid instant after that close. Because every move is earlier, that instant is a day later
  less the move: one window of 23 h 54 m (woon), 23 h 52 m (allocation) and 23 h 48 m (treasury),
  then 24 h windows. Vault's anchor is unchanged and its windows stay 24 h throughout.
- Every session in flight at R2.3 publishes on its unmoved close (R7.4a, graded on prod).
- W1 is the 37 h graded watch: every subject publishes one judged session after READY. The three
  short windows close inside it, so W1 sees each subject's first window on the new grid.
- A window shorter than 23 h 48 m, or any subject with a second short window, fails the proof.

## 5. The member notice

The notice to woon, shodai, zyfai and dualmint drafted in the v0.6.0 post-mortem (owner decision
4, not decided) still waits on the owner's word. This release moves three closes by 6 to 12
minutes earlier; if the notice is sent, it names the new close times (vault 00:52, woon 06:52,
allocation 12:52, treasury 18:52 UTC). It is not a runner step.

## 6. Go/no-go (R0, policy §4.1)

Do not run the production command while any section 8 gap remains.
The owner writes the production go only when `bun run release:run --target prod --preflight` is
green apart from the pending go, the stage run passed at the rc's commit (SP.8), the tracking issue's
phases are closed, and the signed recovery matrix is named:

```text
release: v0.6.2
tag: v0.6.2-rc.0
target: prod
recovery: ~/recovery-matrix-v0.6.2.signed.md
operator: <name>
date: <yyyy-mm-dd>
```

## 7. Recovery

All three migrations declare `compat: additive` and neither takes a grant from a runtime role, so the recovery
matrix of [`release-run.md`](./release-run.md#the-go-file) applies unchanged: before the first service replacement fix and
resume; a failed R6.3 resumes at R6.3 while the website and maintenance notice stay up; after the migrate, fix forward on the next rc or restore the
R2.1 dump with the write loss it implies. A rollback withholds the tag (D63).


## 8. Website availability: mandatory preflight and cutover gates

The source at `a0c8457d` contains atomic website switches, graceful nginx reloads,
maintenance-file helpers, rollout-plan validation, a synthetic probe and an off-host
fallback asset. It does **not** connect those helpers to an unattended per-service
release cutover. `scripts/release/steps.ts` R6.1 invokes `stop-legacy.ts`, which invokes
`smoke:down` and proves all project containers stopped. A maintenance file cannot keep
HTTP available after nginx stops. Do not execute that list in production for v0.6.2.

| Gate | Required implementation and evidence | Current status / tracking |
|---|---|---|
| Z1. Actual cutover preserves website-server | Replace the whole-stack stop with scoped service operations. Validate the actual rendered plan with `rollout-probe.ts plan`; record nginx container ID/start time before and after. No `compose down`, `smoke:down`, or website recreation | gap, 1305 / deployment lifecycle phase 1027 |
| Z2. Unattended maintenance lifecycle | Committed steps announce/start the audited window, atomically write `web/maintenance.json` before API interruption, end the window and clear the file only after API readiness. Record receipts and recovery behavior | gap, 1305 / maintenance feature 1220 |
| Z3. Origin and public-edge continuity | Runner starts probes before any replacement and grades them through final readiness and rollback, copying receipts to the control journal. Add a faster concurrent route/asset probe for cutover gaps shorter than 15 s | gap, 1305; existing probe is a building block |
| Z4. Website-only runner | A dedicated step list must build/switch/verify/rollback only the site, and enforce the same-commit stage journal and one recorded go. The current runner has no website-only mode | gap, 1305; D54 deployment command already exists |
| Z5. Infrastructure prerequisites | Running nginx must already mount the instance web directory and support maintenance responses. Receipt the running image/config and verify the fallback is actually configured at Cloudflare | gap until deployment evidence exists, 1305 |

Adding an `ownerDecision` to a rollout plan is not permission to stop the website for
this release. A green plan validates ordering and declarations only; it does not prove
that execution follows the plan. An off-host error page also does not prove the normal
website stayed available.

The full-stack cutover must implement this sequence in the committed runner, then run
it unmodified on stage (SP.8, SR.10):

1. Run inherited preflight, baseline and backup/restore gates. Resolve the live API
   contract version and old/new site ranges; the site served during an API change must
   accept both versions. If no compatible bridge site exists, stop before cutover.
2. Start public and origin probes and record the window start in epoch milliseconds.
   Serve the compatible site by atomic switch; keep nginx and routing running.
3. Announce/start maintenance and persist the fallback maintenance JSON. Replace API
   and workers as individually scoped units, run the committed migration step, then
   replace participants, following the validated plan. Service dependencies must be
   rehearsed: no new worker or participant may write against an incompatible schema.
4. Require API/worker/participant readiness, end maintenance, clear its file, and
   verify `/api/status/maintenance` returns `state: "none"`. Run inherited postflight,
   this release's checks and the watch. Preserve both site trees for recovery.
5. Grade probes and write the production report. Website pages/assets must remain
   usable; API operations may show the planned maintenance state during backend work.

First-install constraint: v0.6.1 lacks migration `0120` and the maintenance routes.
Z2 must provide a rehearsed, scripted bootstrap path that can announce maintenance
through the static fallback before interrupting the old API, then receipt the audited
window once its schema/routes exist. Calling the new admin routes on the old API is
not a valid pre-cutover step. If the existing nginx lacks maintenance support, Z5
also needs a graceful configuration deployment proven under traffic before cutover.

The existing probe commands below run on the **control machine**, with the agent
managing the long-running probe and recording its process lifetime. Runner integration
must do this automatically; these commands alone do not close Z3:

```bash
bun scripts/rollout-probe.ts plan <rendered-rollout-plan.json>
bun scripts/rollout-probe.ts run https://robotmoney.network/ <public-probe.jsonl>
bun scripts/rollout-probe.ts grade <public-probe.jsonl> <start-epoch-ms> <end-epoch-ms>
```

Every recorded website response must be 200, with no connection errors. The current
15-second probe permits 2 seconds of scheduling jitter (17 seconds maximum gap).
Report that sampling limit honestly: it cannot establish the absence of a shorter
outage. The higher-frequency probe must cover `/`, changed routes, `/version.json`,
and referenced JS/CSS, including a page opened before the switch fetching its assets
afterwards. CDN caches must not conceal origin errors. Missing samples or missing
origin evidence fail the gate.

## 9. Independent website rollout and rollback

A website-only rollout may ship site changes from a commit that also contains backend
changes, because `smoke:web` assembles static files and reads the **running** API's
version; it does not deploy that commit's backend. Do not claim those backend changes
are live. A backend-only rollout still has to preserve the served site's API range.

Use the existing stack's instance state and Docker project, with a clean candidate
checkout on the same host and the same state-root/home as that stack. Production is
`rm_prod`; stage must name its own instance. Do not run `bun smoke` to prepare the
production site or use the full release list as a substitute for a site-only list.
No migrations, token provisioning, roster changes or API/worker restarts belong in
this mode. Website image/config changes require their own availability plan: static
`smoke:web` does not install a new nginx image or nginx config.

The dedicated runner's remote deployment step must execute the existing command
below over SSH from the control machine, from the clean checkout at the stage SHA
(stage) or its RC tag (production). These are step payloads, not instructions for a
person to log in to the host:

```bash
bun run smoke:web --instance <existing-instance>
bun run smoke:web --instance <existing-instance> --rollback
```

Before switching, assert the site's `apiRange` admits the live `/api/version` value;
never widen the range merely to bypass refusal. Keep the independent
`frontend/package.json` version and contract version distinct from the repository's
v0.6.2 release tag. Record all three identities in the report. Site-only identity
verification must check `/version.json` against the candidate while asserting that
`/api/version` is unchanged; the full-stack R7.1 check that demands one commit for both
would be wrong for this mode.

The operation builds into an isolated directory, installs an immutable site tree,
atomically switches `web/current`, records `web/previous`, reloads nginx gracefully,
and verifies the served identity. Archive `web/journal.jsonl` and `web/receipt.json`
from the resolved instance state directory (normally
`~/.local/state/robotmoney-smoke/<instance>/web`, subject to the tool's state-root
override); use the command's printed receipt path as authority. Record the site ID,
previous ID, digest, API version/range, source hashes and plan ID. Archive before a
rollback, which writes a new last receipt.

Rehearse deploy, rollback and redeploy under concurrent traffic on stage. Verify all
container IDs, start times and restart counts remain unchanged, as well as API
identity. Required existing integration coverage at the candidate commit:

```bash
bun test scripts/tests/integration/smoke-web-rolling.test.ts scripts/tests/integration/smoke-web-compat.test.ts scripts/tests/integration/smoke-web-lifecycle.test.ts
```

These tests use isolated Docker stacks. Run them only on a development/stage test
host; they supplement the production-shaped rehearsal rather than replace it.

If build or range validation fails, the old site remains current. If reload or served
identity validation fails **after** the switch, the new site may already be live and
there may be no new success receipt: inspect the journal and execute rollback
immediately through the runner. Rollback rechecks the previous site's range against
the live API. Missing previous state or an incompatible previous site blocks rollback;
fix forward with a rehearsed compatible site, keeping nginx running. Never resolve a
site-only failure by restarting the stack or restoring the database.

## 10. Execution, tagging and closing evidence

Prepare a reviewed merge from `main` into `releases-0.6.x` (D62); preserve branch
history. The scope observed on 2026-10-14 includes maintenance, schedule spacing,
dormancy counts, submission/open-session fixes, migration reconciliation, HTTP-cache
disk protection, runtime configuration changes, swarm skill/docs and member marks.
Record included commits and component deployment scope in tracking issue 1305.
Freeze a full SHA after all section 8 gaps are resolved and target files are reviewed.
For a site-only run, explicitly identify backend changes left undeployed.

The full-stack runner commands are valid interfaces at the inspected commit, but
production execution is blocked until its cutover satisfies section 8:

```bash
bun run release:run --target stage --preflight --go <stage-go-file>
bun run release:run --target stage --go <stage-go-file>
bun scripts/release/tag.ts rc --release v0.6.2 --commit <full-stage-passed-sha>
bun run release:run --target prod --preflight --go <prod-go-file> --stage-journal <passed-stage-run-dir>
bun run release:run --target prod --go <prod-go-file> --stage-journal <passed-stage-run-dir>
```

The stage go uses `commit: <full-sha>`; the production go uses `tag: v0.6.2-rc.N`.
Both name `release`, `target`, and the signed `recovery` matrix. A tooling, runbook or
candidate-tree change invalidates affected evidence: rerun stage at the final SHA.
A website-only run needs Z4's dedicated runner; the commands above deploy the full
system and must not be used for that mode. Do not invent a `--website-only` flag.

After the required postflight/watch, W3 creates the final tag at the deployed RC's
commit. Under D63, a deployed release retained in production receives its final tag
even if an owner explicitly accepts a later failed check with a follow-up issue;
record that exception and never describe it as a clean pass. A rollback withholds the
final tag. No tag is created on `main`, and existing tags are never moved.

The closing report links the frozen SHA/RC/final tag, scope, live site and API
identities, unchanged nginx evidence, maintenance lifecycle, probe grades and raw
receipts, stage journal/hash, migration receipts (full-stack only), product checks,
watch, recovery outcome, exceptions and follow-up issues. Close the tracking issue
only after that report and final tag exist. No production changes or tags are
performed merely by writing this runbook.
