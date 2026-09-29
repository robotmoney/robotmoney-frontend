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
| Ledger grows ~2 GB/day; regime saves and the parity sweep time out | PRs 1046 + 1051: writer skips unchanged and sub-tolerance values, vintages store id ranges, no raw bodies; migration `0080` adds the range column and drops `source_payloads`. Then (2026-09-29) a label change alone writes nothing, and the one-time `ledger-repair.ts` (R6.4c) rebuilds the ledger from what the fixed writers would have kept, which returns the disk at commit |
| A failed regime save cancels the session | The driver catches it and publishes the brief with the last saved regime (`30761568`) |
| `swarm session failed` after every session with an outside member | Format checks grade only the takes the driver ran |
| The soak gate graded production wrongly (memos not takes, adopted sessions invisible, every known issue fatal) and could not see sessions stopping | `prod:gate` rewritten (`b9629cec`, then the per-release grading): published-in-window sessions, real takes, a liveness check, known issues graded against the release that fixed them |
| The twin rehearsal restores a slim dump that has **no** ledger rows | R4 restores a **full** dump and times `0080` on production's real volume |

## 1. Release identity

| Item | Value |
|---|---|
| From | `v0.5.1` (`3ac99f9c`), running on `rm-frontend-prod-1` |
| To | `v0.5.2-rc.N` → `v0.5.2`, cut from `releases-0.5.x` |
| Migrations | **One, and not reversible:** `0080_analytics_ledger_compaction.sql`. Schema only: the vintage run column and its index, and drops `source_payloads`. Seconds, at boot. |
| Ledger repair | **One-time script, not reversible:** `backend/scripts/upgrades/0.5.1-to-0.5.2/ledger-repair.ts`, run by hand after the boot, in a maintenance window with the api, website, producer and workers all stopped (R6.4c). One transaction: replays every series, keeps only what the fixed writers would have written (a label change alone is not a change; irregular chains re-linked by knowledge time), re-points every vintage, rebuilds `source_value_versions`, `analytics_vintage_members` and `analytics_overwrite_events` by `TRUNCATE` and re-insert, recomputes vintage manifests, raises if any vintage's member count or any chain's shape would change, re-arms every guard. No `VACUUM FULL`. **The site is down for the repair**: it holds the ledger tables locked, and any api read that arrives waits on them until the api's 5-minute statement timeout (the R4.4 rehearsal of 2026-09-29 logged four, an issue 1035 symptom). |
| Rollback | **Code alone cannot go back.** v0.5.1's writer inserts into `source_payloads`, which `0080` drops, and the repair deletes rows. Going back needs a database restore (R9). |

### 1.1 Decisions (owner)

| ID | Question | Decision |
|---|---|---|
| E1 | The cutover window: the boot, then the ledger repair (writers stopped, ledger reads waiting) | Sized from R4.3h's measured time on the full dump; owner picks the slot |
| E2 | Issue 1035's symptoms (API 502s under load, dead parity sweeps, failed regime saves) after v0.5.2 | v0.5.2 claims to fix them, so their rules carry `issue: "1035"` with `fixedIn: "0.5.2"`, and a recurrence **fails** the soak |
| E3 | `judge-agent.ts` spool default in `/tmp` | Not in v0.5.2: the file exists only on `main` (PR 1014); fixed there |

### 1.2 What else v0.5.2 changes

- **No market-data refresh at startup** (owner, 2026-09-28). The standing boot no longer runs the regime producer and waits for it; the regime comes from the producer's own schedule (every 3 h). On 2026-09-25 the startup refresh timed out and tore production down.
- **The producer can hold at most 2 of the api's 10 database connections** (`ANALYTICS_CONCURRENCY`). Its write bursts used to take the whole pool and turn every public request into a 502 for minutes.
- **The judge is not counted as an absent analyst** (quorum fallback filters `role = 'member'`): sessions publish "7 of 7", not "7 of 8".
- **`verify:live` loads each published session by id**, so R7.3 no longer fails when a subject has two sessions on one date.

### 1.3 Telemetry — proving these changes, not just installing them

Every check below existed in the schema or the logs already; none needed new
columns. R2 (baseline) records each one **before** the cutover so R7/R8 have
something to compare against — a step with no "before" number cannot show a
"before → after" improvement, only a snapshot. R4 runs the same checks on the
twin so the rehearsal states what a healthy v0.5.2 boot actually looks like,
not only that it boots.

| What must be true | How R2/R4/R7/R8 check it |
|---|---|
| The ledger writer stops recording duplicates and float noise | R2.13/R4.3c: `revision_kind` counts on rows written in the last 24 h. `unchanged` should be a large share pre-cutover (the v0.5.1 defect) and fall to near zero for rows written after T0 |
| The regime keeps refreshing on the producer's own 3 h schedule, with no startup run | R2.14/R4.3d: producer log `[analytics] regime asof` lines, spaced ~3 h apart, none immediately followed by `[analytics-producer] fatal:` |
| The parity sweep and producer runs get faster after `0080` | R2.15/R4.3e: job duration (p50, max) by kind from `jobs.created_at`/`updated_at` |
| No 502s under load once the pool is no longer starved | R2.16/R4.3f: public 5xx responses counted from the website-server container log, by route |
| A published session's quorum no longer counts the judge | R2.17/R4.3g: `swarm_recommendation->'quorum'->>'active'` on the last several published sessions, against the active-analyst count |

**A known gap, not closed here.** `ANALYTICS_CONCURRENCY`'s limiter (`createLimiter`
in `backend/src/api/routes/analytics.ts`) logs nothing when a producer request
waits for a slot or how many are queued — the only telemetry it produces is
its *effect* (public 5xx counts above staying low). If those still climb during
a regime run after v0.5.2, the cap's own queue depth cannot be read from a log;
it can only be inferred from `pg_stat_activity` at the moment (R6.4a). Decision
E4 below is whether that gap needs closing before v0.5.2, or after.

| ID | Question | Decision |
|---|---|---|
| E4 | `createLimiter` logs no wait time or queue depth | Open — owner to decide: ship v0.5.2 without it (infer from 5xx counts and `pg_stat_activity`), or add logging first |

## R1. Code readiness (workstation)

As v0.5.1 R1, except:

| Step | Command | Pass |
|---|---|---|
| R1.3 | `git diff --name-only v0.5.1 "$RC_SHA" -- backend/migrations` | **exactly** `0080_analytics_ledger_compaction.sql` |
| R1.4 | `git diff --stat v0.5.1 "$RC_SHA" -- docker-compose.yml` | empty |
| R1.8 | backend tests, including `tests/analytics-ledger-repair.test.ts` and `tests/analytics-ledger-vintage-repair.test.ts` (0080 + the repair script, against the fixed writers row for row) | 0 fail |

## R2. Production baseline (read-only, `rm-frontend-prod-1`)

As v0.5.1 R2 (scratch clone at `RC_SHA`, `prod:gate --mode baseline`, triage every finding), plus:

| Step | Command | Pass | Record |
|---|---|---|---|
| R2.11 | Row counts and sizes of the three ledger tables and `source_payloads` (`pg_total_relation_size`, `count(*)` or `reltuples`) | recorded | the numbers R7.4 compares against |
| R2.12 | Database size vs the 30 GB disk | free space ≥ 2 GB (the repair's scratch tables; the old rows are freed at its commit) | GB |
| R2.13 | `SELECT revision_kind, count(*) FROM source_value_versions WHERE knowledge_time >= now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC` (through the api, read-only) | recorded — the `unchanged` share is v0.5.1's defect; R7/R8 compare rows written **after T0** against this | counts by kind |
| R2.14 | `docker logs --since 48h rm_prod-analytics-producer-1 2>&1 \| grep -aE '\[analytics\] regime asof\|regime failed\|\[analytics-producer\] fatal:'` | recorded — successful runs roughly every 3 h (`PRODUCER_REGIME_CRON`), and every `fatal:`/`failed` line, as the pre-cutover rate | the run/failure list |
| R2.15 | `SELECT kind, count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM updated_at - created_at)) AS p50_s, max(extract(epoch FROM updated_at - created_at)) AS max_s FROM jobs WHERE status = 'succeeded' AND created_at >= now() - interval '24 hours' GROUP BY kind ORDER BY 1` | recorded, `analytics.parity_sweep` and the producer's own job kinds especially | p50/max seconds by kind |
| R2.16 | `docker logs --since 24h rm_prod-website-server-1 2>&1 \| grep -acE '" 5[0-9][0-9] '` (count), then `\| grep -aoE '"(GET\|POST\|HEAD) [^"]*" 5[0-9][0-9]'` (by route) | recorded — this is the 502 burst v0.5.1 could not avoid | count and top routes |
| R2.17 | `SELECT id, subject_id, (swarm_recommendation->'quorum'->>'active')::int AS quorum_active FROM swarm_sessions WHERE state = 'published' ORDER BY published_at DESC LIMIT 8` against `SELECT count(*) FROM swarm_members WHERE status = 'active' AND role = 'member'` | recorded — v0.5.1's rows show `quorum_active` one higher than the analyst count (the judge counted in) | the rows and the analyst count |

## R3. Backup (stage-2, against the replica)

As v0.5.1 R3, with `backend/scripts/upgrades/0.5.1-to-0.5.2/restore-check.ts` for R3.3 ("DUMP SAFE FOR 0.5.2": v0.5.1's migrations recorded, exactly `0080` pending). **Take R3 as close to R6 as possible**: it is the only way back, and everything production writes after it is lost on a restore (R9).

## R4. Twin rehearsal (stage-2) — on a **full** dump

| Step | Command | Pass | Record |
|---|---|---|---|
| R4.1 | Wipe (as v0.5.1) | 0 containers, 0 volumes | — |
| R4.2 | `git checkout --detach "$RC_SHA"`; installs | HEAD = `RC_SHA` | HEAD |
| R4.3 | In tmux: `bun smoke:twin -- --no-tui --full-dump 2>&1 \| while IFS= read -r l; do printf '%s %s\n' "$(date -u +%T)" "$l"; done \| tee ~/twin-$RC_SHA.log` | READY | READY time |
| R4.3a | `grep -E 'migrated: 00' ~/twin-$RC_SHA.log` | `migrated: 0080_analytics_ledger_compaction.sql`; no error | start and end times of 0080 |
| R4.3h | **The ledger repair, as R6.4c runs it**, from `~/robotmoney-frontend` (see R6.4c for the commands) with `STATE=.agents/smoke-state.json` and `--step R4.3h.ledger-repair` | `LEDGER REPAIRED`; guards armed; exit 0. The repair proves, inside its transaction, that it makes no `raw_indicator_history` row disagree with the ledger that agreed before; rows that already disagreed are listed in its report |  **the per-step seconds it prints: this is E1's window** |
| R4.3b | Ledger sizes and counts after the repair (as R2.11, on the twin) | far below R2.11, near one version per point; every vintage's `member_count` unchanged (the repair raises otherwise) | the numbers |
| R4.3c | R2.13's query, on the twin, for rows written since READY | `unchanged` at or near 0 for post-boot writes — this is what R7/R8's post-T0 comparison expects to see in production | counts by kind |
| R4.3d | R2.14's log grep, on the twin, for the run(s) the twin's own producer makes during R4.4 | at least one `regime asof` line, no `fatal:` after it | the lines |
| R4.3e | R2.15's query, on the twin | p50/max seconds by kind — the number R7/R8 expect production's post-`0080` runs to approach | seconds by kind |
| R4.3f | R2.16's grep, on the twin, across R4.4's two sessions | 0 (the twin's producer runs are small; a nonzero count here means the cap or the writer fix did not do what R1 tested) | count |
| R4.3g | R2.17's query, on the twin, for the two sessions R4.4 published | `quorum_active` equals the twin's active-analyst count, judge excluded | the rows |
| R4.4 | `bun run twin:gate -- --driver-log ~/twin-$RC_SHA.log --report ~/twin-gate-reports/R4.4-$RC_SHA.md --wait 40 --sessions 2 --min-attendance 1` | exit 0 | the report |
| R4.6–R4.9 | Browser pass, judgements API, NULL-judge fidelity, teardown (as v0.5.1) | as v0.5.1 | as v0.5.1 |

## R5. Go / no-go and RC tag

As v0.5.1 R5. The owner's go names the cutover slot from R4.3a's measured window.

## R6. Production cutover

As v0.5.1 R6 (pre-cut session list R6.2a, stop the driver, check out the tag, boot `smoke:archive` in tmux with `--no-tui`), with:

- **R6.4**: timestamp the boot log the same way R4.3 does (`… \| while IFS= read -r l; do printf '%s %s\n' "$(date -u +%T)" "$l"; done \| tee /root/smoke-archive-v0.5.2.log`), not a bare `tee`. The boot applies `0080` (seconds) and comes up READY.
- **R6.4c — the ledger repair (once).** From `/root/robotmoney-frontend` (twin: `~/robotmoney-frontend`), with `STATE=.agents/smoke-state.json` and `RM_BACKUP_DIR` the R3 backup (its receipts folder gets this step's receipt). Stop everything that touches the ledger — the api and website too, not only the writers — run the repair, start them again. On the twin, also pause the `smoke:twin` driver first (`kill -STOP` its `bun` process) and resume it after (`kill -CONT`), or it keeps starting sessions against the stopped stack and the gate counts them as failures:

  ```bash
  PROJECT=$(bun -e "console.log(require('./$STATE').project)")
  docker compose -p "$PROJECT" stop website-server api analytics-producer worker-analytics worker-research worker-swarm
  bun backend/scripts/upgrades/0.5.1-to-0.5.2/ledger-repair.ts --emit-receipt --step R6.4c.ledger-repair --backup-dir "$RM_BACKUP_DIR" \
    --database-url "$(grep -m1 '^MIGRATE_DATABASE_URL=' .env | cut -d= -f2-)" 2>&1 | tee /root/ledger-repair-v0.5.2.log
  docker compose -p "$PROJECT" start api website-server analytics-producer worker-analytics worker-research worker-swarm
  ```

  On the twin the URL is the smoke-twin's own, which the state file stores redacted on purpose; read it from the running api: `--database-url "$(docker exec "$PROJECT-api-1" printenv DATABASE_URL)"`. Pass: it ends `LEDGER REPAIRED` and exits 0. It prints each series as it goes and the seconds of each step. A failure rolls everything back and changes nothing: fix the cause and run it again. `--dry-run` does all of it, proofs included, and rolls back.
- **R6.4a — watching the repair while it runs.** From a second shell: `psql "$(grep -m1 '^MIGRATE_DATABASE_URL=' .env | cut -d= -f2-)" -Atc "SELECT pid, state, wait_event_type, wait_event, now() - query_start AS running_for, left(query, 80) FROM pg_stat_activity WHERE query ILIKE '%ledger_repair%' OR query ILIKE '%source_value_versions%'"`. Its lock waits at most 30 s for a writer that is still running, then fails without changing anything.
- **R6.5**: `schema_migrations` gains exactly `0080_analytics_ledger_compaction.sql` (76 rows); `source_payloads` no longer exists; both guards report armed in the boot log and again at the end of R6.4c.

## R7. Immediate postflight

As v0.5.1 R7, with the gate run as:

`bun run --cwd /root/rm-gate-$RC_SHA prod:gate -- --mode post-release --release v0.5.2 --since "$T0" --defer-sessions --db-capacity-gb 30 --state-file /root/robotmoney-frontend/.agents/smoke-state.json --driver-log /root/smoke-archive-v0.5.2.log --report /root/prod-gate-reports/R7-post-$RC_SHA.md`

| Step | Check | Pass |
|---|---|---|
| R7.4 | Database size and the three tables' counts vs R2.11 | the drop R4.3b predicted |
| R7.5 | R2.13's query, restricted to `knowledge_time >= '$T0'` | `unchanged` at or near 0 — the R4.3c number, not the R2.13 baseline |
| R7.6 | R2.16's grep, `--since "$T0"` | far below R2.13's pre-cutover count; 0 is the target |
| R7.7 | R2.17's query, for the first session published after T0 | `quorum_active` equals the active-analyst count |

## R8. Soak (T0 → T0 + 24 h)

The driver runs one session at a time with 6 h windows, so four subjects need about 24 h. Gate every 6 h with `--defer-sessions`; at T0 + 24 h run it **without** it:

`… prod:gate -- --mode post-release --release v0.5.2 --since "$T0" --liveness-hours 12 …`

Pass: every subject published a judged session with a receipt in the window; no gap over 12 h; no dead job whose cause is a regression of v0.5.2 or earlier (the parity sweep included); no issue 1035 symptom (a rule with `fixedIn: "0.5.2"`) in any log; R7.5/R7.6/R7.7's checks re-run and still hold, with R2.15's job-duration query re-run once and compared against the R2.15 baseline (regime and parity-sweep runs should be back near their pre-2026-09-25 durations, not just "not dead").

## R9. Rollback — needs a database restore

Trigger as v0.5.1 R9. Because neither `0080` nor the ledger repair is reversible:

1. Stop the driver (as R6.3).
2. Restore the database: the managed cluster's point-in-time restore to just before R6.4 (preferred: it loses nothing written before the cutover), or R3's full dump restored from stage-2 (loses everything written after R3).
3. Boot v0.5.1 exactly as v0.5.1 R6.4 did, and run R7.1 with `--release v0.5.1`.

## R10. Completion

1. Tag `v0.5.2` on the rc that passed R8.
2. Merge `releases-0.5.x` into `main` with a real merge commit. PRs 1046 and 1051 came from `main`, so their changes merge back without conflict.
3. The rollout report: every step's evidence and every gate report.
