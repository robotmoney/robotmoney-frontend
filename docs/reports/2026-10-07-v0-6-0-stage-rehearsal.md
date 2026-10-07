# v0.6.0 stage rehearsal — QA session 2026-10-07 (stage-2)

Date: 2026-10-07, 01:53 to 04:30 UTC
Runbook: [`v0-6-0-rollout.md`](../runbooks/v0-6-0-rollout.md) R1 to R3.10, with every standing check in
[`release-standing-runbook.md`](../runbooks/release-standing-runbook.md) accounted for by ID.
Policy: [`release-runbooks.md`](../technical/release-runbooks.md) §4.5, §4.6.
Verdict: **no-go.** Two gates fail. One is open blocker B20, which waits on the owner. The other is one
unclassified Postgres line seen during migrate. Operator signature: not given.

## Identity

| Item | Value |
|---|---|
| QA branch | `qa/0.6.x-2026-10-07`, cut from `releases-0.6.x` at `88825199` (equal to `main`) |
| Code under test | `88825199` for every boot. `dd596952` (gate rules, PR 1211) for the twin gate re-run |
| Stage host | `rm-frontend-stage-2`, clean checkout `~/rm-060`, `git status --porcelain` empty |
| Dump (SR.0) | `~/rm-backup-prod-20261007T015352Z`, captured for this run at 02:00:06Z from the replica (`pg_is_in_recovery()=true`, read-only). 362,796,016 bytes. sha256 dump `049a4e19…4126e`, globals `c3d66df2…c91911`. pg_dump and server 18.6 |
| Plan ids | R3.6 and R3.2: `14bdb0f919d9`. R3.8 boot 2: `d7595de351ca` |
| Evidence | stage-2 `~/qa-0.6.x-2026-10-07/` (every log named below), `~/twin-gate-reports/twin-gate-88825199-*.md` and `twin-gate-dd596952-20261007T042815Z.md`, receipts `R3.verify-twin-20261007*.json` |

## Results by check

| Check | Result | Evidence |
|---|---|---|
| R1 / SP.7 code gate | **pass on CI, environment failures on stage-2.** typecheck, check-contract, check:agent-surface: exit 0. Root tests 17 fail of 4651; backend tests 12 fail of 3362. Re-run alone: the 12 backend ones pass (5 s timeouts under capture load). The 16 root ones fail because stage-2 has no `node` binary (`tsc`, Playwright listing, `#!/usr/bin/env node` stubs). CI on `88825199`: `unit`, `backend`, `integration` green on `main` | `R1.log`, `R1-rerun-*.log` |
| R2.2 dump identity | pass | `R2.log` |
| R2.3 / SP.3 ledger | pass. 76 rows; `deployment_identity` absent; matcher `v0.5.0+0061+0062+0063+0080 (production ledger 2026-10-01)`. Migration 0101 would clear nobody | `ledger-prod-2026-10-07.txt`, `would-clear-prod-2026-10-07.txt` |
| R2.4 / SP.6 baseline | 353 sessions, 1392 recommendations, 32 receipts, 32 judgements, 269,681 `source_value_versions`, 1730 MB. AUM not read (no browser on the host) | `R2.log` |
| R2.5 / SP.5 `prod:gate --mode baseline` | **not run.** It reads the production host's containers; stage-2 has none | — |
| R3.2 / SR.1 boot | pass. READY at 03:00Z, 7 agents and the judge seated on spoofed keys | `R3.2-boot.log` |
| R3.3 / SR.2 readiness | pass, all services healthy | `R3.3-status.log` |
| R3.3a / SR.9 | B3 grid pass: all 4 subjects at 21600 s, each open close on the grid. Accelerated to 900 s | `R3.3a-*.log` |
| R3.4 / SR.3 `verify:live --tier full` | pass 9 of 9, exit 0. Again after R3.8: pass, exit 0 | `R3.4-verify.log`, `final-verify.log` |
| R3.4a / SR.4 `twin:gate` | **fail**, 2 checks. See findings 1 and 2 | `R3.4a-twin-gate*.log`, `final-twin-gate.log` |
| R3.4b / SR.7 `soak:checks` | at READY: 0 FAIL, 1 WARN. `--full` after 75 min: **1 FAIL (R8.i), 1 WARN (R8.u2)**. See findings 1 and 3 | `SR.7-*.md`, `final-soak.md` |
| R3.5 schema | pass. 114 ledger rows, no duplicates; identity `rehearsal`; `schema_manifest` present; no DELETE/TRUNCATE on runtime roles; 32 WebAuthn challenge slots | `R3.5-schema.log` |
| R3.6 / SR.5 interruption | pass. KILL inside `prepare (migrate)` left 77 ledger rows; each rerun resumed plan `14bdb0f919d9`; INT before preflight and INT at participants stopped at a boundary; the last rerun reached READY | `P1.log`, `R3.6-*.log` |
| R3.7 site | pass. Forward, rollback to `0.1.0-da5862fa`, forward to `0.1.0-88825199` | `R3.7-*.log` |
| R3.8 production-shaped sequence | pass. Rebind 8 of 8; old bearers answer 401 (`tokenValid=false`); boot 2 `--reuse` adopted the twin, restored nothing, reached READY; athena, zyfai and dualmint submitted takes on the new keys; subjects kept 900 s | `P3.log`, `R3.8-boot2.log` |
| R3.9 / SR.6 rollback | as section 8 states. Restore 2 min 51 s. Runtime DELETE as `rm_app` and `rm_worker` refused. The v0.5.4 checkout's `bun run migrate` against a copy of the migrated database exits 0, reports 76 files current, re-seeds the 5 `swarm.*` schedules (B13, unchanged). The copy was dropped | `P1.log`, `R3.9.log`, `R3.9-old-migrate.log` |
| B17 judge | pass. All 18 sessions published after READY are `judged` with a judgement. All but the vault in-flight session (finding 1) carry a receipt | `final-judge.log` |

## Findings

1. **B20 seen on the twin.** The vault session `01db4950` was convened by v0.5.x at 00:38Z, before the
   capture. It has no `swarm_session_members` rows and no `brief_opens_at`, so the 0.6 queue offered it
   to nobody. It published at 03:12Z with the 2 takes production already held (under 4 of 7), a
   judgement and **no consensus receipt**. `twin:gate` check 1 and soak R8.i fail on it. The other three
   subjects' in-flight sessions published with receipts. This is the open owner decision, not a new defect.
2. **Unclassified boot lines.** The 2026-10-06 rules (1207) did not cover the analytics ledger guard's
   42501 probe refusals (13 `LEDGER_FAMILIES` tables, ×3 each) or the scheduler's
   `initial connect failed: Unable to connect` line. Fixed on the QA branch by PR 1211; the re-run at
   `dd596952` shows neither. Still unclassified there: one Postgres `canceling autovacuum task` at
   02:59:00Z on `analytics_overwrite_events`, during the twin's own migrate. It needs a rule or an
   issue, by the owner's call. Three other lines in that re-run came from this session's manual queries,
   and three autovacuum cancels came from the R3.9 copy. Neither set is product behavior.
3. **Slow API requests at boot (R8.u2 WARN).** In the catch-up right after READY, four
   `POST /api/analytics/source-acquisitions` took 10.1 to 10.7 s and were cut off at the 10 s limit, and
   `GET /api/analytics/raw-history` (7.9 s) and `POST /api/analytics/vintages` (5.4 s) were over 5 s.
   The standing rule is no API request over 5 s. Needs an issue.
4. **Misleading parity-sweep log line.** `POST /api/analytics/parity-sweep` (32.6 s) is exempt from the
   10 s limit (`index.ts`, B5), and it completed. But `request-timing.ts` still logs it as "ran past the 10s
   limit, so the client was cut off". The logger does not know about the exemption. Needs an issue.
5. **Release-branch CI after the reset.** The `contract` run on `releases-0.6.x` at `88825199` failed
   because the push's before SHA (`79cdd8e5`) left the history in the force push. Not a code failure.
6. **Session process.** `qa/0.6.x-2026-10-07` was force-pushed to follow the release-branch reset
   instead of a new QA branch being cut. The owner ruled that wrong. The rule is recorded in policy
   §4.6 by PR 1210.

## Not covered

- R2.5 / SP.5 and every prod-target standing row: they run on the production host.
- R2.4 AUM figure from the public page.
- The full soak window. This run covered 75 minutes of accelerated sessions (18 published).

## State left behind

The final twin (`rehearse-060`, after R3.8 boot 2, 900 s epochs, 7 agents and the judge on rekeyed
credentials) is **still running** on stage-2 for manual inspection: site `http://127.0.0.1:48787/`, api
`:32893`, twin database container `rm-restore-20261007T015352Z-9cobr5`.
