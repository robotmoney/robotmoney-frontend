# v0.6.2 production rollout — the delta runbook

> **Live.** This is the next release's runbook. It holds only what v0.6.2 changes. Everything
> the release repeats is a row of [`release-standing-runbook.md`](./release-standing-runbook.md),
> cited by ID, and the steps are the generic list in [`release-run.md`](./release-run.md), which
> the runner executes (D61). This file lists no command for a person to paste on a host. When W3
> tags `v0.6.2`, this file freezes as history and the next patch gets a new one.

## Inherits the standing runbook

This release runs **every check in the standing runbook** as it stands in the same commit as this
file (both changed in the runbook split pr, 1324). It adds the v0.6.2-specific checks below and
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
| Stage | a `releases-0.6.x` commit named by the stage go's `commit:` (D64) |
| rc | `bun scripts/release/tag.ts rc --release v0.6.2 --commit <stage commit>` once the stage run passes; the production go names `tag: v0.6.2-rc.N` |
| Final tag | W3 tags `v0.6.2` at the same commit. A failed later check does not withhold it (D63) |
| Window | Short: both migrations are `additive`, so R6.1 to R6.9 is one stop, one migrate, one boot |
| Tracking | Release v0.6.2 (1305): phases runner and gates (1287), deployment lifecycle (1027), 0.5.x port (1304), swarm and analytics fixes (1288) |

Before the run, the target files' `release` reads `v0.6.2` and prod's `checkout` names the new
folder; a go for another release refuses (`P.go`). That edit is a release-branch commit, not a
runner step.

## 2. The delta

### 2.1 Migrations (R6.3 applies them, in filename order)

| File | Does | Postflight |
|---|---|---|
| `0120_maintenance_windows` | The maintenance-window event log (issue 1220): `scheduled`, `started`, `ended`, `cancelled`, one row per state change, insert-only for `rm_app` | R7.3b: R8.k reads the guard on the new table |
| `0121_subject_closes_six_hours_apart` | The four anchors' times of day become exactly 21600 s apart on vault's grid (woon, allocation and treasury move 6 to 12 minutes earlier). Epochs stay 24 h. Idempotent: a second run moves no `version` | section 4 |

R2.3 lists both as the pending set. R6.3's receipt lists them applied, so the ledger ends at `0121`.

### 2.2 API and site

| Change | What it does | Issue |
|---|---|---|
| `GET /api/status/maintenance` | The public answer: the live window, or none | 1220 |
| `POST /api/admin/maintenance`, `/:id/start`, `/:id/end`, `/:id/cancel` | The operator's audited window routes | 1220 |
| website-server maintenance mode | With `maintenance.json` in the instance web directory the site serves the maintenance view and answers other `/api/` calls 503 while the api is down. Off-host fallback: `ops/cloudflare/` | 1220 |
| `GET /api/swarm/open-sessions` | Unchanged since v0.6.1. Listed because the member notice (section 5) names it | — |

### 2.3 Gates and runner that changed since v0.6.1

- `prod:gate` fails a release on a boot-time connect retry of `analytics.parity_sweep` before the api
  listens (1307), and flags web access-log lines and judge SSE reconnects by default, with the
  v0.6.1 shapes classified (1278, 1316). R2.5's triage covers a FAIL check's findings only.
- The runner: the ledger is a prefix check by filename set; R6.1 stops the stack the smoke state
  names with `smoke:down`; R1.1 clones a missing checkout; `--accept` records an owner's acceptance
  of one failed reversible step (1282); a one-time action is a delta step (`RELEASE_DELTAS`). v0.6.2
  declares no delta step.
- D64: stage runs a release-branch commit, the rc is cut there, production runs only by the rc tag,
  and R7.1 fails a production boot whose `/api/version` does not carry it.

## 3. Release-specific checks

| Check | Phase | Tool | Status |
|---|---|---|---|
| A. The maintenance window is announced before R6.1 and ended after R6.9, and the site stays up through it (standing section 8) | C | `POST /api/admin/maintenance` before the run; `bun scripts/rollout-probe.ts run` during it; `grade` after R6.9: no non-200 answer, no gap over 15 s | manual, issue 1220 |
| B. `/api/status/maintenance` answers `none` once the window ends | V | `curl` after check A ends | manual, issue 1220 |
| C. The four anchors' times of day are 21600 s apart and every epoch is 86400 s | V | R7.4a's receipt lists each subject's anchor and epoch; R7.4a asserts both, the epoch and the 21600 s spacing in the order vault, woon, allocation, treasury (issue 1310) | script (R7.4a) |
| D. The one transition window per moved subject | W | W1 and R7.4a receipts, section 4 | script (R7.4a, graded) |

A `manual` row is read by the operator from the journal or the public API and cited in the report
(SR.8). A `gap` row names the issue that scripts it; the release runs with the owner's recorded
go, as the exceptions above do.

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

Both migrations are `additive` and neither takes a grant from a runtime role, so the recovery
matrix of [`release-run.md`](./release-run.md#the-go-file) applies unchanged: before R6.1 fix and
resume; a failed R6.3 resumes at R6.3; after the migrate, fix forward on the next rc or restore the
R2.1 dump with the write loss it implies. A rollback withholds the tag (D63).
