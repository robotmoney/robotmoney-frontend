# v0.6.0 stage rehearsal — QA session 2026-10-07, second run (stage-2)

Date: 2026-10-07, 19:28 to 21:12 UTC
Runbook: [`v0-6-0-rollout.md`](../runbooks/v0-6-0-rollout.md) R1 to R3.10, with every standing check in
[`release-standing-runbook.md`](../runbooks/release-standing-runbook.md) accounted for by ID.
Policy: [`release-runbooks.md`](../technical/release-runbooks.md) §4.5, §4.6.
Earlier run the same day: [`2026-10-07-v0-6-0-stage-rehearsal.md`](./2026-10-07-v0-6-0-stage-rehearsal.md).
Verdict: **stage passes, go pending the operator.** Every stage gate passes. B20 is proven on the twin.
One soak WARN (R8.u2, slow analytics requests at boot) is open under issue 1079 and needs the owner's
reading, since a WARN is not a pass. Operator signature: not given.

## Identity

| Item | Value |
|---|---|
| QA branch | `qa/0.6.x-2026-10-07-2`, cut from `releases-0.6.x` at `a502de30`. `releases-0.6.x` was fast-forwarded to `main` first, so the two are equal. A new branch, because `qa/0.6.x-2026-10-07` is pushed and never rewritten (policy §4.6) |
| Code under test | `a502de30` for every step. No patch landed on the QA branch during the run |
| Stage host | `rm-frontend-stage-2`, clean checkout `~/rm-060`, `git status --porcelain` empty, nothing ahead of the remote |
| Dump (SR.0) | `~/rm-backup-prod-20261007T192832Z`, stamp `20261007T192833Z`, captured for this run at 19:35:08Z from the replica (`pg_is_in_recovery()=true`, `transaction_read_only=on`). 380,264,581 bytes. sha256 dump `e7f65265…cce60`, globals `071055ba…24450`. pg_dump and server 18.6 |
| Plan ids | R3.6: `ab37d853563e`. R3.2: `ab37d853563e` after reset. R3.8 boot 2: `ccc1b158c73e` |
| Evidence | stage-2 `~/qa-0.6.x-2026-10-07-2/` (every log named below), `~/twin-gate-reports/twin-gate-a502de30-*.md`, receipts `~/rm-backup-v022/receipts/R3.verify-twin-20261007-2*.json` |

## Results by check

| Check | Result | Evidence |
|---|---|---|
| R0 CI | pass. Every workflow on `releases-0.6.x` at `a502de30` is green. `integration` failed once on a 300 s Docker timeout (onboarding eval rails) and passed on rerun; the same commit was green on `main` | run 37674630688 |
| R1 / SP.7 code gate | **pass on CI, environment failures on stage-2.** typecheck, check-contract, check:agent-surface: exit 0. Root tests 16 fail of 4664; backend 6 fail of 3370. Every one of the 22 also failed in the earlier run (no `node` binary on stage-2, timeouts under capture load). None is new | `R1.log`, `R1-full.log`, `fails-new.txt` |
| R2.2 dump identity | pass | `R2.log` |
| R2.3 / SP.3 ledger | pass. 76 rows; `deployment_identity` absent; `rm_owner` cannot log in (R6.2b still needed); matcher `v0.5.0+0061+0062+0063+0080 (production ledger 2026-10-01)`. Migration 0101 would clear nobody. Pending files re-derived: 39 (section 1.1 corrected) | `ledger-prod-2026-10-07.txt`, `would-clear-prod-2026-10-07.txt` |
| R2.4 / SP.6 baseline | 356 sessions, 1398 recommendations, 33 receipts, 33 judgements, 276,474 `source_value_versions`, 1803 MB. AUM not read (no browser on the host) | `R2.log` |
| R2.5 / SP.5 `prod:gate --mode baseline` | **not run.** It reads the production host's containers | — |
| R3.2 / SR.1 boot | pass. Restore 2 min 52 s; READY at 20:31:35Z; 7 agents and the judge seated on spoofed keys | `R3.2-boot.log` |
| R3.3 / SR.2 readiness | pass | `R3.3-status.log` |
| R3.3a / SR.9 | B3 grid pass: all 4 subjects at 21600 s, each open close on the grid. Accelerated to 900 s | `R3.3a-*.log` |
| R3.4 / SR.3 `verify:live --tier full` | pass 9 of 9, exit 0. Again after R3.8: pass, exit 0 | `R3.4-verify.log`, `final-verify.log` |
| R3.4a / SR.4 `twin:gate` | **pass.** First run (20:51Z): all checks, 0 unclassified of 34 distinct messages. After R3.8, a run at 20:54Z failed only on three Postgres errors from this session's own ad hoc queries; the rerun with `--since 2026-10-07T20:58:41Z` passes every check | `twin-gate-a502de30-20261007T205124Z.md`, `final-twin-gate-2.log` |
| R3.4b / SR.7 `soak:checks` | at READY and `--full`, before and after R3.8: **0 FAIL, 1 WARN (R8.u2)**. See finding 2 | `SR.7-*.md`, `final-soak.md` |
| R3.5 schema | pass. 115 ledger rows (76 plus 39), no duplicates; identity `rehearsal`; `schema_manifest` present; no DELETE/TRUNCATE on runtime roles; WebAuthn challenge table present | `R3.5-schema.log` |
| R3.6 / SR.5 interruption | pass. KILL inside `prepare (migrate)` left 77 ledger rows; each rerun resumed plan `ab37d853563e`; INT at `prepare (images)` stopped before preflight; INT at `participants` stopped before readiness; the last rerun reached READY | `P1.log`, `R3.6-*.log` |
| R3.7 site | pass. Forward, rollback, forward | `R3.7-*.log` |
| R3.8 production-shaped sequence | pass. Rebind 8 of 8; old bearers answer 401 (`tokenValid=false`); boot 2 `--reuse` adopted the twin, restored nothing, reached READY; athena, zyfai and dualmint submitted takes on the new keys; subjects kept 900 s | `P3.log`, `R3.8-boot2.log` |
| R3.9 / SR.6 rollback | as section 8 states. Restore 2 min 52 s. Runtime DELETE as `rm_app` and `rm_worker` refused. The v0.5.4 checkout's `bun run migrate` against a copy of the migrated database exits 0, reports 76 files current, re-seeds the 5 `swarm.*` schedules (B13, unchanged). The copy was dropped; the twin's ledger stayed at 115 | `P1.log`, `R3.9.log` |
| B17 judge | pass. All 11 sessions published after READY are `judged`, each with a judgement and a consensus receipt | `final-judge.log` |
| B20 in-flight sessions | **pass.** The treasury session `8a9a889f` was convened by v0.5.x at 18:50Z and was collecting at the capture. Migration 0114 seated 7 members; it collected 7 takes and published at 20:42Z with a judgement and a receipt. The earlier run's vault session published short with no receipt | `B20-proof.log` |

## Findings

1. **B20 is closed on stage.** Migration 0114 (merged in 1215) does what the blocker asked. Section 0
   is updated. Production proof stays owed at R7.4a.
2. **Slow API requests at boot (R8.u2 WARN), unchanged from the earlier run.** In the catch-up after
   READY: 3 `POST /api/analytics/source-acquisitions` (one cut off at the 10 s limit),
   `POST /api/analytics/raw-history/seed` and `GET /api/analytics/raw-history` over 5 s. The
   source-acquisition write is issue 1079 (open). The two raw-history paths have no issue yet. The
   standing rule is no API request over 5 s. The owner decides whether this blocks the cutover.
3. **Misleading parity-sweep log line, unchanged.** `POST /api/analytics/parity-sweep` is exempt from
   the 10 s limit (B5) and completes, but `request-timing.ts` still logs it as cut off. No issue yet.
4. **The autovacuum line of the earlier run did not recur.** The first twin gate saw 0 unclassified errors.
5. **Session scripts.** P1's in-line R3.9 step ran the v0.5.4 code under `RM_ENV=stage`, which it
   refuses. The standalone `r39.sh` repeats the step correctly on a copy, and its result is the one
   above. Its schedule count query names a column the 0.6 schema lacks, so the before and after
   counts are blank; the migrate output itself says 5 `swarm.*` schedules were seeded.

## Runbook corrections in this pull request

- Section 0, B20: code and proof filled in.
- Section 1.1 and R6.3: 39 pending files, not 36 (`0111` to `0114` merged since the cut, all additive).

## Not covered

- R2.5 / SP.5 and every prod-target standing row: they run on the production host.
- R2.4 AUM figure from the public page.
- The full soak window. This run covered about 40 minutes of accelerated sessions (11 published).

## State left behind

The final twin (`rehearse-060`, after R3.8 boot 2, 900 s epochs, 7 agents and the judge on rekeyed
credentials) is **still running** on stage-2 for inspection: site `http://127.0.0.1:48787/`, api
`:32937`, twin database container `rm-restore-20261007T192833Z-ml1bl3`.
