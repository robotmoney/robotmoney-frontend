# Release standing runbook — the checks every release runs

This is the **global** runbook. Every production release runs every check in it,
at its phase, **in addition to** the checks its own `vX-Y-Z-rollout.md` adds.
A release runbook never replaces this one, never copies a check out of it, and
never silently drops one. It points here and then lists only what is new.

| Document | Owns | Changes |
|---|---|---|
| [`release-runbooks.md`](../technical/release-runbooks.md) | **Policy.** Gates, rc numbering, branch rules, tracking issue | Rarely |
| **this document** | **Standing checks.** What every release runs, by phase | A release adds rows. Rows are never removed without a recorded owner decision |
| `runbooks/vX-Y-Z-rollout.md` | **This release.** Identity, delta, migrations, decisions, extra checks | One per release |

## 1. The inheritance rule

1. A release runbook starts with a section named **Inherits the standing runbook**.
   It states the commit of this file it was written against.
2. Every row below applies to the release unless the release runbook lists it under
   **Exceptions**, with the reason, the owner who approved it, and the issue that
   brings the check back. A silent omission is a defect.
3. A release runbook adds checks as **release-specific rows** in its own sections.
   They run after the standing row of the same phase.
   One-time migrations that only one release performs (for example 0.6.0's credential
   rebind of the in-house members, R6.7) belong to that release's runbook, never here. In
   the runner they are delta steps of that release (`RELEASE_DELTAS` in
   `scripts/release/steps.ts`, [`release-run.md`](./release-run.md#delta-steps)), gated on a
   precondition receipt, never rows of the generic list.
4. The checks are **cumulative**. A check a past release needed stays here after
   that release ships. A check leaves only through section 6, with an owner decision
   that says why.
5. A release that fixes a defect adds the check that would have caught it to this
   file in the same pull request, or files the issue that does.
6. A check with no tool is a missing tool. The row says `gap`, names the issue, and
   the release stays blocked until the issue closes or the owner records an exception.
7. **Every production data change ships as a migration** (owner, 2026-10-09). No admin-route
   write, no SQL by hand, no one-off script. R6.3 is the one step of a release that writes
   production data, and the migration ledger is the record of every change. A release runbook
   lists its migrations and nothing else as its data delta.

A release runbook holds only its delta: its identity, its migrations, its new routes and
checks, its exceptions and its owner decisions. Everything a release repeats is a row here,
cited by ID. The record of a shipped release stays as it was written (its runbook is history
from the day W3 tags it), so a reader of the live delta runbook never meets a past release's
one-time steps.

## 2. How to read the tables

| Column | Meaning |
|---|---|
| ID | `S` plus a phase letter and a number. Release runbooks cite it, never restate it |
| Tool | The command that performs the check. Policy §5: no check by eye |
| Target | `stage` (twin or stage host), `prod` (production, read-only unless stated), or `both` |
| Status | `script` runs today. `manual` has steps but no assertion tool. `gap` has neither (issue named) |

Every row runs through `bun run release:run` from the control machine (D61). A row whose tool
needs a person at a host terminal is a `gap`.

Exit rule for every row: a WARN is not a pass. A check with nothing to assert is
unverified, not satisfied.

## 3. Phase P — preflight and baseline (before anything changes)

| ID | Check | Tool | Target | Status |
|---|---|---|---|---|
| SP.1 | Position: which release, which commit, which phase | `bun smoke:status` and the release runbook's section 1 | both | script |
| SP.2 | Backup taken and **restore proven** into a fresh local database, with the restore time recorded | `bun run release:run` R2.1, R2.2 and R2.4r (`scripts/release/restore-proof.ts`) | both | script |
| SP.3 | Production's real migration ledger, read through `rm_readonly`, reconciles with `backend/migrations` and the bytes at the version the running stack reports: no recorded name the repository lacks, no applied file whose bytes differ from the tag's, never a count or a number order (D66, issue 1273; "a prefix by filename set" from 2026-10-12 under issue 1272, "equal to the shipped baseline" before that) | `bun run release:run` R1.2 and R2.3 (`scripts/release/ledger.ts`) | both | script |
| SP.4 | Smoke preflight: 1 role auth, 2 privileges, 3a manifest, 3b compat, 4 `~/.env` keys, 5 identity, 6 subject scheduling columns | `bun smoke` (runs at boot) | both | script |
| SP.5 | Log baseline: what is already broken, triaged before the cutover | `bun run prod:gate --mode baseline` | prod | script |
| SP.6 | Product baseline: row counts, published AUM, database size, recorded for the postflight comparison | release runbook R2.4 | prod | manual |
| SP.7 | Code gate on the RC commit: root and backend typecheck and unit, as CI runs them | release runbook R1 | stage | script |
| SP.8 | Production runs only what stage passed: a stage run journal with the same step-list hash, at the same commit, with every step ok (D61 rule 2) | `bun run release:run --target prod --stage-journal <dir>` ([`release-run.md`](./release-run.md)) | prod | script |

## 4. Phase R — stage rehearsal (policy 4.4 and 4.5)

**QA branch (policy 4.6, owner 2026-10-06).** Every stage session runs on its own
`qa/A.B.x-<YYYY-MM-DD>` branch cut from the release branch tip. All the session's patches,
runbook fixes included, merge into that branch. The release branch and `main` take no commit
during the session. The owner picks what moves afterwards. It reaches the release branch from `main` by cherry-pick or merge. A direct PR from the QA branch onto the release branch is allowed only when the change is incompatible with `main` or fixes a regression on `main`, and the PR body names which (D62). A pushed QA branch is
never rewritten (owner 2026-10-07): when the session needs a new base, cut a new branch
(`qa/A.B.x-<YYYY-MM-DD>-2` on the same day) and leave the old one as it is.

| ID | Check | Tool | Target | Status |
|---|---|---|---|---|
| SR.0 | The stage target's starting dump (policy 4.3): by default the newest production dump already on the capture host, if it is under 24 hours old; capture a new one only when none is. Production's own backup (R2.1) is always captured new, right before the cutover (owner, 2026-10-08) | `bun smoke:capture --out <new dir>` | capture host | script |
| SR.1 | The SR.0 dump boots to READY on the RC commit as a twin (`--local dump`, never the remote database), every active member seated on a **spoofed** key and running as its own participant container (agents and the judge) | `bun smoke --local dump --spoof-keys --credentials <file listing every active member>` | stage | script |
| SR.9 | **Accelerated schedule.** After the checks that need production's epochs (the restored grid), the twin's subjects get short epochs through the admin API, its open windows are pulled in, and the scheduler rebuilds its timers. Every check that needs sessions to publish (SR.4, the SR.7 window, the judge) runs after it. Re-run it after every fresh boot | `bun run twin:accelerate --instance NAME [--epoch 900]` | stage | script |
| SR.2 | Readiness: api, pipeline worker, analytics-producer, scheduler | `bun smoke:status` | stage | script |
| SR.3 | Product verification, full tier | `bun run verify:live --tier full` | stage | script |
| SR.4 | Twin gate, after SR.9: sessions judged (a `no_consensus` publish is a warning, owner 2026-10-06), participants never restarted, judge on, no dead job, containers healthy, every log error classified, no FATAL | `bun run twin:gate` | stage | script |
| SR.5 | Interruption at a phase boundary resumes, before and after replace | release runbook R3.6 | stage | manual |
| SR.6 | Rollback rehearsal: restore time recorded, and the old code's behavior against the new schema recorded | release runbook R3.9 | stage | manual |
| SR.7 | Cumulative standing invariants (section 7) | `bun run soak:checks --instance NAME --since T0 --full` (`--record` once at READY) | stage | script |
| SR.10 | Cutover rehearsal: the production step list runs unmodified and unattended against the production-shaped stage target (D61), once, from a dump under 24 hours old (SR.0) (the standing rule since 2026-10-08; a release runbook may ask for more) | `bun run release:run --target stage` | stage | gap, issue agent-executed runbooks (1225) |
| SR.8 | Rehearsal report: RC SHA, dump identity, plan id, receipts, results, what could not be covered, operator go/no-go | policy 4.5 | stage | manual |

## 5. Phase C, V, W — cutover, verification, watch

| ID | Check | Tool | Target | Status |
|---|---|---|---|---|
| SC.1 | Recovery matrix decided and signed before the cutover | the go file's required `recovery` key, read and hashed by `bun run release:run` | prod | script |
| SC.2 | retired 2026-10-08: no human in the loop; the operator's authority is one recorded go (SC.3), decided by the owner, D61, issue agent-executed runbooks (1225) | — | — | — |
| SC.3 | The operator's go for the run is recorded: release, commit and target, given before the run | `bun run release:run --go <file>` refuses without it ([`release-run.md`](./release-run.md)) | prod | script |
| SV.1 | Identity: `/api/version` equals the RC's `{api, commit}` | `curl` per release runbook | prod | manual |
| SV.2 | `bun smoke:status` receipt: preflight green, readiness green | `bun smoke:status` | prod | script |
| SV.3 | Product verification, **readonly tier only** | `bun run verify:live --instance rm_prod` | prod | script |
| SV.4 | Log verdict after the release: what the release was meant to fix is fixed, nothing new is unclassified | `bun run prod:gate --mode post-release` | prod | script |
| SV.5 | Row counts only grow, AUM did not step, the ledger did not balloon | release runbook R7.5 | prod | manual |
| SV.6 | No container mounts a Docker socket, `~/.env` holds only allowed keys (D61 adds `rm_owner`; a `doadmin` line is not allowed, amendment 2026-10-08), no container's environment holds `rm_owner` or `doadmin`, token files are mode 0600 | `scripts/release/host-guards.ts` | prod | gap, issue agent-executed runbooks (1225) |
| SW.1 | Watch until every subject publishes once: every subject opens, agents submit, the judge submits, consensus publishes or reads `no_consensus` | `bun run release:run` W1 (`prod:gate --mode post-release` since READY) and R7.4a (`scripts/release/schedule-parity.ts`), not before READY + the target's `watchHours` (37 h: the longest first epoch, 1.5 × 24 h, plus judging and publish grace; `scripts/release/watch.ts`), sessions graded. A stage target may watch shorter only with `watchSessions: deferred`, which does not satisfy this row | prod | script |
| SW.2 | Cumulative standing invariants over the soak window (section 7) | `bun run soak:checks --instance rm_prod --since T0 --full` (`--record` once at READY) | prod | script |
| SW.3 | Tag the running commit and file the production report | `bun run release:run` W3 tags the commit; the report is policy 4.9 | prod | manual |

## 6. Changing this file

- **Add** a row in the pull request that needs it. Give it the next number in its phase.
- **Retire** a row only with an owner decision. Replace the row's text with
  `retired <date>: <reason>, decided by <owner>, issue <name> (<number>)`. The ID is
  never reused.
- A row going from `gap` or `manual` to `script` is an edit of its Status cell and Tool cell only.

## 7. The standing invariants (SR.7, SW.2)

These read-only invariants hold on every healthy stack, at every gate. They run as ONE
instance-aware script, `bun run soak:checks` (`scripts/standing-soak.ts`, decisions in
`scripts/lib/gate/standing.ts`), beside `twin:gate` and `prod:gate`. Like the gates it takes
`--instance`, reads the stack record, runs every query through the instance's api container on a
read-only session, reads container logs and `docker inspect`, and holds no admin token, no
superuser and no Docker socket. T0 is the instant the stack became READY (`--since`). Run it once
with `--record` at READY: R8.d and R8.p compare with that baseline (without one R8.p FAILS and
R8.d is unverified). `--full` adds the slow vintage join of R8.l. Every check has a unit test with
a red control (`scripts/tests/unit/standing-soak.test.ts`). The runner runs it at R7.3b.

| Id | Invariant | Status | Note |
|---|---|---|---|
| R8.a, R8.b | Scheduled regime and research runs each produced their output artifact | script | The cron is read from the `analytics-producer` container's `PRODUCER_REGIME_CRON` and `PRODUCER_RESEARCH_CRON`. Compose defaults to daily (22:30, 23:00). Production runs every 3 h (:30, :00), so the 3 h cadence holds only if the boot sets those variables (the `--static-port` boot does). A cron the script cannot expand is a WARN |
| R8.c | No producer failure line since T0 | script | Also matches the day-roll regime failure line (1108) |
| R8.d | Ledger growth stays inside the recorded baseline | script | Baseline from `--record`, in the instance state directory (`soak-baseline.json`) |
| R8.e | Writers record only real changes: no noise-only revisions, no `unchanged` rows | script | |
| R8.f | Parity sweeps: none dead, longest under the api statement timeout | script | |
| R8.g | Website server errors: none, or only warned | script | |
| R8.h, R8.i | Quorum excludes the judge. Every published session has takes, a judgement and a receipt | script | |
| R8.j | No session wedged past its window plus grace | script | |
| R8.k, R8.k2 | Every ledger guard armed. The old payload table stays gone | script | |
| R8.l | Newest vintage: run lengths add up to the member count | script | |
| R8.m | No connection-pool starvation (sessions idle in a transaction) | script | `pg_stat_activity` shows the api role only its own sessions, so the detail says how many of the open sessions it could see |
| R8.n | Host disk | script | `df /` on the host the script runs on |
| R8.p | `schema_migrations` equals the recorded baseline | script | Baseline recorded at READY with `--record`, so a release's own migrations are in it. Rule 7 of section 1: the ledger is the record of every data change |
| R8.q | Judge config: enforce, pinned model, third parties off | script | The pin is `deepseek-v4.1-flash` (migration 0111). The two pre-0111 ids are a WARN, valid only before 0111 applies |
| R8.r | Role and grant integrity: `rm_worker` INSERTs, the api connects as `rm_app`, `rm_readonly` reads sequences | script | Graded on a production (`external`) stack only. A twin's dump carries no grants |
| R8.s | `/health` and the judgements route answer 200 | script | Probes the api at the stack record's port. `--base-url` probes the public origin instead |
| R8.t | Every published session has `openedAt` | script | Sessions dated on or after `--opened-at-from` (default 2026-09-22) |
| R8.u | Api: no cut-off at the request limit on a reader, every slow request listed | script | R8.u2 lists slow requests as a WARN. The api's limit is 10 s and a request over 5 s is logged |
| R8.v | The buyback scan never fails on a refused range | script | Reads every `worker-*` lane, not one named container |
| R8.w | Gecko tier matches the key, no 429/401/403, the key is in no ledger row or api/website environment | script | Key presence is read from `docker inspect`; no value is ever printed. R8.w2 and R8.w3 are its error and containment halves |
| R8.x | The regime day is logged | script | `regime asof D` is logged from the `analytics-producer` container, so each line is compared with its own Docker timestamp |
| R8.o | Informational: error-like lines per container | script | INFO by design: it never fails. The gates classify the lines |

A query that errored never reads as a pass: a read that fails is a FAIL of the check that needed it.
A release that adds an invariant adds a row here, with its red-control test, in the same pull request
(rule 5 of section 1).

## 8. Keeping the site up through a release (issue 1220)

The website is its own release unit (D54), so a release does not stop it.

Order of units, one at a time: the website, then the api and workers, then the migrate, then the participants. `bun scripts/rollout-probe.ts plan <plan.json>` refuses a plan that is out of order. It also refuses a step that stops website-server unless the step carries an `ownerDecision` naming the owner decision that allows it.

Before a window that takes the api down:

1. Schedule it with `POST /api/admin/maintenance`. The site shows a banner with the start and expected end.
2. Start the probe: `bun scripts/rollout-probe.ts run <site-url> <receipts.jsonl>`. It asks for `/` every 15 s.
3. At the start, call `POST /api/admin/maintenance/:id/start`, then write `maintenance.json` into the instance web directory (`writeMaintenanceFile`, `scripts/lib/maintenance-file.ts`). website-server serves it for `/api/status/maintenance` and answers other `/api/` calls with a 503 maintenance body while the api is down.
4. At the end, call `POST /api/admin/maintenance/:id/end` and remove `maintenance.json` (`clearMaintenanceFile`).

Postflight: `bun scripts/rollout-probe.ts grade <receipts.jsonl> <startMs> <endMs>` fails on any non-200 answer or any gap over 15 s.

Host or tunnel loss is covered off-host: `ops/cloudflare/offhost-fallback.html` and `ops/cloudflare/error-pages.json` (5xx and 1033). Applying them to the Cloudflare zone is an operator step.
