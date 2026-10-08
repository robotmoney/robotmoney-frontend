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
   rebind of the in-house members, R6.7) belong to that release's runbook, never here.
4. The checks are **cumulative**. A check a past release needed stays here after
   that release ships. A check leaves only through section 6, with an owner decision
   that says why.
5. A release that fixes a defect adds the check that would have caught it to this
   file in the same pull request, or files the issue that does.
6. A check with no tool is a missing tool. The row says `gap`, names the issue, and
   the release stays blocked until the issue closes or the owner records an exception.

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
| SP.2 | Backup taken and **restore proven** into a fresh local database, with the restore time recorded | release runbook R2 and the twin restore | both | manual |
| SP.3 | Production's real migration ledger read from the replica and equal to the shipped baseline | `rm_readonly` query, per release runbook | prod | manual |
| SP.4 | Smoke preflight: 1 role auth, 2 privileges, 3a manifest, 3b compat, 4 `~/.env` keys, 5 identity, 6 subject scheduling columns | `bun smoke` (runs at boot) | both | script |
| SP.5 | Log baseline: what is already broken, triaged before the cutover | `bun run prod:gate --mode baseline` | prod | script |
| SP.6 | Product baseline: row counts, published AUM, database size, recorded for the postflight comparison | release runbook R2.4 | prod | manual |
| SP.7 | Code gate on the RC commit: root and backend typecheck and unit, as CI runs them | release runbook R1 | stage | script |
| SP.8 | Production runs only what stage passed: a stage run journal with the same step-list hash, at the same commit, with every step ok (D61 rule 2) | `bun run release:run --target prod --stage-journal <dir>` ([`release-run.md`](./release-run.md)) | prod | script |

## 4. Phase R — stage rehearsal (policy 4.4 and 4.5)

**QA branch (policy 4.6, owner 2026-10-06).** Every stage session runs on its own
`qa/A.B.x-<YYYY-MM-DD>` branch cut from the release branch tip. All the session's patches,
runbook fixes included, merge into that branch. The release branch and `main` take no commit
during the session. The owner picks what moves to each one afterwards. A pushed QA branch is
never rewritten (owner 2026-10-07): when the session needs a new base, cut a new branch
(`qa/A.B.x-<YYYY-MM-DD>-2` on the same day) and leave the old one as it is.

| ID | Check | Tool | Target | Status |
|---|---|---|---|---|
| SR.0 | A production dump captured for this run (policy 4.3 fresh dump rule): unless the operator names one, never a dump already on the host; a reused copy only for rapid turnaround and at most 24 hours old | `bun smoke:capture --out <new dir>` | capture host | script |
| SR.1 | The SR.0 dump boots to READY on the RC commit as a twin (`--local dump`, never the remote database), every active member seated on a **spoofed** key and running as its own participant container (agents and the judge) | `bun smoke --local dump --spoof-keys --credentials <file listing every active member>` | stage | script |
| SR.9 | **Accelerated schedule.** After the checks that need production's epochs (the restored grid), the twin's subjects get short epochs through the admin API, its open windows are pulled in, and the scheduler rebuilds its timers. Every check that needs sessions to publish (SR.4, the SR.7 window, the judge) runs after it. Re-run it after every fresh boot | `bun run twin:accelerate --instance NAME [--epoch 900]` | stage | script |
| SR.2 | Readiness: api, pipeline worker, analytics-producer, scheduler | `bun smoke:status` | stage | script |
| SR.3 | Product verification, full tier | `bun run verify:live --tier full` | stage | script |
| SR.4 | Twin gate, after SR.9: sessions judged (a `no_consensus` publish is a warning, owner 2026-10-06), participants never restarted, judge on, no dead job, containers healthy, every log error classified, no FATAL | `bun run twin:gate` | stage | script |
| SR.5 | Interruption at a phase boundary resumes, before and after replace | release runbook R3.6 | stage | manual |
| SR.6 | Rollback rehearsal: restore time recorded, and the old code's behavior against the new schema recorded | release runbook R3.9 | stage | manual |
| SR.7 | Cumulative standing invariants (the 0.5.x R8 list, section 7) | `bun run soak:checks --instance NAME --since T0 --full` (`--record` once at READY) | stage | script |
| SR.10 | Cutover rehearsal: the production step list runs unmodified and unattended against the production-shaped stage target (D61), twice from a fresh dump | `bun run release:run --target stage` | stage | gap, issue agent-executed runbooks (1225) |
| SR.8 | Rehearsal report: RC SHA, dump identity, plan id, receipts, results, what could not be covered, operator go/no-go | policy 4.5 | stage | manual |

## 5. Phase C, V, W — cutover, verification, watch

| ID | Check | Tool | Target | Status |
|---|---|---|---|---|
| SC.1 | Recovery matrix decided and signed before the cutover | policy 4.8 | prod | manual |
| SC.2 | retired 2026-10-08: no human in the loop; the operator's authority is one recorded go (SC.3), decided by the owner, D61, issue agent-executed runbooks (1225) | — | — | — |
| SC.3 | The operator's go for the run is recorded: release, commit and target, given before the run | `bun run release:run --go <file>` refuses without it ([`release-run.md`](./release-run.md)) | prod | script |
| SV.1 | Identity: `/api/version` equals the RC's `{api, commit}` | `curl` per release runbook | prod | manual |
| SV.2 | `bun smoke:status` receipt: preflight green, readiness green | `bun smoke:status` | prod | script |
| SV.3 | Product verification, **readonly tier only** | `bun run verify:live --instance rm_prod` | prod | script |
| SV.4 | Log verdict after the release: what the release was meant to fix is fixed, nothing new is unclassified | `bun run prod:gate --mode post-release` | prod | script |
| SV.5 | Row counts only grow, AUM did not step, the ledger did not balloon | release runbook R7.5 | prod | manual |
| SV.6 | No container mounts a Docker socket, `~/.env` holds only allowed keys (D61 adds `rm_owner` and `doadmin`), no container's environment holds `rm_owner` or `doadmin`, token files are mode 0600 | `scripts/release/host-guards.ts` | prod | gap, issue agent-executed runbooks (1225) |
| SW.1 | Watch one full session cycle: every subject opens, agents submit, the judge submits, consensus publishes or reads `no_consensus` | release runbook | prod | manual |
| SW.2 | Cumulative standing invariants over the soak window (section 7) | `bun run soak:checks --instance rm_prod --since T0 --full` (`--record` once at READY) | prod | script |
| SW.3 | Tag the running commit and file the production report | policy 4.9 | prod | manual |

## 6. Changing this file

- **Add** a row in the pull request that needs it. Give it the next number in its phase.
- **Retire** a row only with an owner decision. Replace the row's text with
  `retired <date>: <reason>, decided by <owner>, issue <name> (<number>)`. The ID is
  never reused.
- A row going from `gap` or `manual` to `script` is an edit of its Status cell and Tool cell only.

## 7. The 0.5.x standing invariants, ported (issue 1179)

The 0.5.3-to-0.5.4 `soak-checks.sh` ran these read-only checks at every gate. They are owed by
SR.7 and SW.2 and now run as ONE instance-aware script, `bun run soak:checks`
(`scripts/standing-soak.ts`, decisions in `scripts/lib/gate/standing.ts`), beside `twin:gate` and
`prod:gate`. Like the gates it takes `--instance`, reads the stack record, runs every query through
the instance's api container on a read-only session, reads container logs and `docker inspect`, and
holds no admin token, no superuser and no Docker socket. T0 is the instant the stack became READY
(`--since`). Run it once with `--record` at READY: R8.d and R8.p compare with that baseline
(without one R8.p FAILS and R8.d is unverified). `--full` adds the slow vintage join of R8.l.
Every check has a unit test with a red control (`scripts/tests/unit/standing-soak.test.ts`).
Source of the old list: the script header at tag `v0.5.4`.

| Old id | Invariant | Status | Note on the port |
|---|---|---|---|
| R8.a, R8.b | Scheduled regime and research runs each produced their output artifact | script | The cron is read from the `analytics-producer` container's `PRODUCER_REGIME_CRON` and `PRODUCER_RESEARCH_CRON`. Compose defaults to daily (22:30, 23:00). 0.5.x production ran every 3 h (:30, :00), so the 3 h cadence holds only if the deploy sets those variables. A cron the script cannot expand is a WARN |
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
| R8.p | `schema_migrations` equals the shipped baseline | script | Baseline recorded at READY with `--record`, so a release's own migrations are in it |
| R8.q | Judge config: enforce, pinned model, third parties off | script | The pin is `deepseek-v4.1-flash` (migration 0111). The two pre-0111 ids are a WARN, valid only before 0111 applies |
| R8.r | Role and grant integrity: `rm_worker` INSERTs, the api connects as `rm_app`, `rm_readonly` reads sequences | script | Graded on a production (`external`) stack only. A twin's dump carries no grants, as in 0.5.x |
| R8.s | `/health` and the judgements route answer 200 | script | Probes the api at the stack record's port. `--base-url` probes the public origin instead |
| R8.t | Every published session has `openedAt` | script | Sessions dated on or after `--opened-at-from` (default 2026-09-22), as in 0.5.x |
| R8.u | Api: no cut-off at the request limit on a reader, every slow request listed | script | R8.u2 lists slow requests as a WARN |
| R8.v | The buyback scan never fails on a refused range | script | Reads every `worker-*` lane, not one named container |
| R8.w | Gecko tier matches the key, no 429/401/403, the key is in no ledger row or api/website environment | script | Key presence is read from `docker inspect`; no value is ever printed. R8.w2 and R8.w3 are its error and containment halves |
| R8.x | The regime day is logged | script | 0.5.x read a host driver log. Main logs `regime asof D` from the `analytics-producer` container, so each line is compared with its own Docker timestamp |
| R8.o | Informational: error-like lines per container | script | INFO by design: it never fails. The gates classify the lines |

The old script had no R8.y. Its R8.z (a query that errored must never read as a pass) is built in:
a read that fails is a FAIL of the check that needed it.

## 8. What was lost between 0.5.x and 0.6.0, and where it stands

Recorded 2026-10-06 so the loss is not found twice.

| Lost | Where it was | Status |
|---|---|---|
| Cumulative standing invariants script | `upgrades/0.5.3-to-0.5.4/soak-checks.sh` | ported, issue 1179: `bun run soak:checks` (section 7) |
| Release-independent procedure (position probe, backup proof, twin, rollback limits) | `docs/runbooks/rollout-procedure.md` | not carried, issue 1180 |
| Environment and credential inventory | `docs/runbooks/deployment.md` | not carried, issue 1180 |
| Per-release `preflight.ts` and `postflight.ts` | `backend/scripts/upgrades/<from>-to-<to>/` | their stack-level checks became SP.4 and SV.2. Release-level schema checks are `manual` rows SP.3 and SV.5 |
| Log gates | `twin:gate`, `prod:gate` | kept, ported to the instance model (1071). Never run on a healthy 0.6.0 stack before 2026-10-06 |
