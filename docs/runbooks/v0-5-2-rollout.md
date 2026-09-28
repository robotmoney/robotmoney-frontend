# v0.5.2 production rollout — PROPOSED

> **Status: proposal (2026-09-28).** Walk this runbook on `v0.5.2-rc.0` (then
> `rc.1`, …). It follows `docs/runbooks/v0-5-1-rollout.md` step for step; only
> the differences are argued here. Stage steps (R1, R3, R4) run on this machine
> and `rm-frontend-stage-2`. Production steps (R2, R6–R9) run on
> `rm-frontend-prod-1` and start only on the owner's go.

## 0. Why v0.5.2

v0.5.1 (`3ac99f9c`) shipped on 2026-09-25 and fixed the judge, the wallet
grants and the parity NUL, but its soak did not pass. The analytics ledger
(issue 1035) kept growing, about 2 GB a day (8.3 GB on 2026-09-25, 14 GB on
2026-09-28, 30 GB disk). By 2026-09-28 the regime run could not save, so every
swarm session died before its brief (17 h without a session), and the hourly
parity sweep died every hour. v0.5.2 stops the growth, removes what is already
there, and lets a session go ahead when a regime save fails.

| v0.5.1 gap | Closed by |
|---|---|
| Ledger grows ~2 GB/day; regime saves and the parity sweep time out | PRs 1046 + 1051: writer skips unchanged and sub-tolerance values, vintages store id ranges, no raw bodies; migration `0080` compacts the ledger and drops `source_payloads`; `VACUUM FULL` returns the disk |
| A failed regime save cancels the session | The driver catches it and publishes the brief with the last saved regime (`30761568`) |
| `swarm session failed` after every session with an outside member | Format checks grade only the takes the driver ran |
| The soak gate graded production wrongly (memos not takes, adopted sessions invisible, every known issue fatal) and could not see sessions stopping | `prod:gate` rewritten (`b9629cec`, then the per-release grading): published-in-window sessions, real takes, a liveness check, known issues graded against the release that fixed them |
| The twin rehearsal restores a slim dump that has **no** ledger rows | R4 restores a **full** dump and times `0080` on production's real volume |

## 1. Release identity

| Item | Value |
|---|---|
| From | `v0.5.1` (`3ac99f9c`), running on `rm-frontend-prod-1` |
| To | `v0.5.2-rc.N` → `v0.5.2`, cut from `releases-0.5.x` |
| Migrations | **One, and not reversible:** `0080_analytics_ledger_compaction.sql`. One transaction: compacts `source_value_versions`, `analytics_vintage_members` and `analytics_overwrite_events`, drops `source_payloads`, rebuilds vintage manifests, raises if any vintage's membership or any head changes, re-arms every guard. Then `VACUUM (FULL, ANALYZE)` on the compacted tables. The API is down for all of it. |
| Rollback | **Code alone cannot go back.** v0.5.1's writer inserts into `source_payloads`, which `0080` drops. Going back needs a database restore (R9). |

### 1.1 Decisions (owner)

| ID | Question | Decision |
|---|---|---|
| E1 | The cutover window: the API is down for `0080` + `VACUUM FULL` | Sized from R4.3's measured time on the full dump; owner picks the slot |
| E2 | Issue 1035's symptoms (API 502s under load, dead parity sweeps, failed regime saves) after v0.5.2 | v0.5.2 claims to fix them, so their rules carry `issue: "1035"` with `fixedIn: "0.5.2"`, and a recurrence **fails** the soak |
| E3 | `judge-agent.ts` spool default in `/tmp` | Not in v0.5.2: the file exists only on `main` (PR 1014); fixed there |

## R1. Code readiness (workstation)

As v0.5.1 R1, except:

| Step | Command | Pass |
|---|---|---|
| R1.3 | `git diff --name-only v0.5.1 "$RC_SHA" -- backend/migrations` | **exactly** `0080_analytics_ledger_compaction.sql` |
| R1.4 | `git diff --stat v0.5.1 "$RC_SHA" -- docker-compose.yml` | empty |
| R1.8 | backend tests, including `tests/analytics-ledger-compaction-migration.test.ts` and `tests/analytics-ledger-vintage-repair.test.ts` | 0 fail |

## R2. Production baseline (read-only, `rm-frontend-prod-1`)

As v0.5.1 R2 (scratch clone at `RC_SHA`, `prod:gate --mode baseline`, triage every finding), plus:

| Step | Command | Pass | Record |
|---|---|---|---|
| R2.11 | Row counts and sizes of the three ledger tables and `source_payloads` (`pg_total_relation_size`, `count(*)` or `reltuples`) | recorded | the numbers R7.4 compares against |
| R2.12 | Database size vs the 30 GB disk | size + the largest table ≤ free space (`VACUUM FULL` rewrites each table beside the old one) | GB |

## R3. Backup (stage-2, against the replica)

As v0.5.1 R3, with `backend/scripts/upgrades/0.5.1-to-0.5.2/restore-check.ts` for R3.3 ("DUMP SAFE FOR 0.5.2": v0.5.1's migrations recorded, exactly `0080` pending). **Take R3 as close to R6 as possible**: it is the only way back, and everything production writes after it is lost on a restore (R9).

## R4. Twin rehearsal (stage-2) — on a **full** dump

| Step | Command | Pass | Record |
|---|---|---|---|
| R4.1 | Wipe (as v0.5.1) | 0 containers, 0 volumes | — |
| R4.2 | `git checkout --detach "$RC_SHA"`; installs | HEAD = `RC_SHA` | HEAD |
| R4.3 | In tmux: `bun smoke:twin -- --no-tui --full-dump 2>&1 \| while IFS= read -r l; do printf '%s %s\n' "$(date -u +%T)" "$l"; done \| tee ~/twin-$RC_SHA.log` | READY | READY time |
| R4.3a | `grep -E 'migrated: 00\|VACUUM\|reclaim' ~/twin-$RC_SHA.log` | `migrated: 0080_analytics_ledger_compaction.sql`; no error | **start and end times of 0080 and of the vacuum**: this is E1's window |
| R4.3b | Ledger sizes and counts after the boot (as R2.11, on the twin) | far below R2.11; every vintage's `member_count` unchanged (0080 raises otherwise) | the numbers |
| R4.4 | `bun run twin:gate -- --driver-log ~/twin-$RC_SHA.log --report ~/twin-gate-reports/R4.4-$RC_SHA.md --wait 40 --sessions 2 --min-attendance 1` | exit 0 | the report |
| R4.6–R4.9 | Browser pass, judgements API, NULL-judge fidelity, teardown (as v0.5.1) | as v0.5.1 | as v0.5.1 |

## R5. Go / no-go and RC tag

As v0.5.1 R5. The owner's go names the cutover slot from R4.3a's measured window.

## R6. Production cutover

As v0.5.1 R6 (pre-cut session list R6.2a, stop the driver, check out the tag, boot `smoke:archive` in tmux with `--no-tui`), with:

- **R6.4**: the boot applies `0080` and runs `VACUUM FULL` before READY. Expect the API to be down for about R4.3a's measured time. A boot still inside `0080` is not a hang: watch `pg_stat_activity` from the migration login before calling it one.
- **R6.5**: `schema_migrations` gains exactly `0080_analytics_ledger_compaction.sql` (76 rows); `source_payloads` no longer exists; both guards report armed in the boot log.

## R7. Immediate postflight

As v0.5.1 R7, with the gate run as:

`bun run --cwd /root/rm-gate-$RC_SHA prod:gate -- --mode post-release --release v0.5.2 --since "$T0" --defer-sessions --db-capacity-gb 30 --state-file /root/robotmoney-frontend/.agents/smoke-state.json --driver-log /root/smoke-archive-v0.5.2.log --report /root/prod-gate-reports/R7-post-$RC_SHA.md`

| Step | Check | Pass |
|---|---|---|
| R7.4 | Database size and the three tables' counts vs R2.11 | the drop R4.3b predicted |

## R8. Soak (T0 → T0 + 24 h)

The driver runs one session at a time with 6 h windows, so four subjects need about 24 h. Gate every 6 h with `--defer-sessions`; at T0 + 24 h run it **without** it:

`… prod:gate -- --mode post-release --release v0.5.2 --since "$T0" --liveness-hours 12 …`

Pass: every subject published a judged session with a receipt in the window; no gap over 12 h; no dead job whose cause is a regression of v0.5.2 or earlier (the parity sweep included); no issue 1035 symptom (a rule with `fixedIn: "0.5.2"`) in any log.

## R9. Rollback — needs a database restore

Trigger as v0.5.1 R9. Because `0080` is not reversible:

1. Stop the driver (as R6.3).
2. Restore the database: the managed cluster's point-in-time restore to just before R6.4 (preferred: it loses nothing written before the cutover), or R3's full dump restored from stage-2 (loses everything written after R3).
3. Boot v0.5.1 exactly as v0.5.1 R6.4 did, and run R7.1 with `--release v0.5.1`.

## R10. Completion

1. Tag `v0.5.2` on the rc that passed R8.
2. Merge `releases-0.5.x` into `main` with a real merge commit. PRs 1046 and 1051 came from `main`, so their changes merge back without conflict.
3. The rollout report: every step's evidence and every gate report.
