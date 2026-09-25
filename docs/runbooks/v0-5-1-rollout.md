# v0.5.1 production rollout — PROPOSED

> **Status: proposal (2026-09-25), not yet adopted. D1, D2, D6 decided 2026-09-25.** Steps marked **[TO BUILD]**
> name tooling that does not exist yet; every other command exists on
> `qa/v0.5.1-website-picks`. This runbook follows
> `docs/technical/release-runbooks.md` (policy) and
> `docs/runbooks/rollout-procedure.md` (mechanics), and corrects the places
> where the v0.5.0 rollout was abstract or blind.

## 0. Why this runbook is stricter than v0.5.0's

The v0.5.0 rollout passed every gate and production still could not close a
swarm session. Each gap below is a thing that happened, and each has a step in
this runbook that closes it.

| v0.5.0 gap | What it hid | Closed by |
|---|---|---|
| The twin rehearsal had no verdict. `smoke:twin` prints READY and only *logs* a failed session. | Sessions that never published. | R4.4 `twin:gate` |
| Rehearsal swarm checks counted published sessions. | A restored production database already holds hundreds. | R4.4 grades only sessions convened after the boot started. |
| Nothing read container logs. | Four refused api boots (2026-09-24 14:27), dead jobs, shared-memory exhaustion. | R4.4, R7.2, R8.1 log scans |
| Nothing queried `jobs` for `dead` rows. | 288 dead `wallet.backfill_window`, 24 dead `analytics.parity_sweep`, dead `swarm.judge`. | R2.3, R4.4, R7.3, R8.1 |
| The twin's driver sets its own judge model at boot. | Production's `swarm_judge_config.model` is **NULL**; every judging refuses `model_unconfigured`. | R2.2 reads production's config directly; migration `0063` sets it; R6.5 verifies. |
| Twin workers connect as the twin's superuser. | Production's `rm_worker` lacks grants (`permission denied for table wallet_backfill_state`). | R2.4 checks production grants; migration `0061` grants them; R6.5 verifies. |
| §6 "deploy in provider order" named no command. | The real deploy is `smoke:archive` in a root tmux session on `rm-frontend-prod-1`. | R6 names every command. |
| `BOOT_STATUS=$?` after `smoke:archive`. | `smoke:archive` never exits on success (it is the session driver), so `$?` only ever reports a crash. | R6.4 uses readiness + R7 instead. |
| Rollback used `bun smoke -- --external-pg`. | `--external-pg` is not a known flag in v0.5.0; the command fails immediately. | R9 uses `smoke:archive`. |
| Post-deploy looked for ~minutes. | Production runs a **6 h interval and 6 h window** per subject; a new session cannot publish in under ~6 h. | R8 is an overnight soak with a verdict. |
| The gates failed only on a fixed list of known-bad log patterns. | A day of read-only transactions, a full disk, dead parity sweeps: none was on the list, so nothing failed until the owner asked for an inventory by hand (2026-09-25). | Default-deny inventory: every distinct error of every log must match a committed classification with a written reason, or the gate fails (`scripts/lib/gate/`). |
| No step read a production log, before or after. | Production was failing for a day before the upgrade was even planned. | `prod:gate` baseline (R2.4) before anything changes, and post-release (R7, R8) after. Every run writes a report. |

## 1. Release identity

| Item | Value |
|---|---|
| From | `v0.5.0` (`ec261867`), running on `rm-frontend-prod-1` (146.190.218.4) |
| To | `v0.5.1-rc.N` → `v0.5.1`, cut from `releases-0.5.x` |
| Source branch | `qa/v0.5.1-website-picks` fast-forwarded into `releases-0.5.x` (it is based on `v0.5.0`, so the merge is a fast-forward) |
| Migrations | **Three files, two of which run in production** (R1.3): `0061_rm_worker_wallet_backfill_grant` (D2, main's file verbatim), `0062_rm_readonly_sequence_select` (D6, already recorded in production, so it does **not** run there), `0063_swarm_judge_model_default` (D1). They run during the R6.4 boot, in the one-shot migrate container, as `MIGRATE_DATABASE_URL` (production: the `doadmin` line in `/root/robotmoney-frontend/.env`) under `SET LOCAL ROLE rm_owner`. No down path; R3's backup is mandatory. |
| Production process | `bun run smoke:archive` (`--smoke --static-port --db external`), cwd `/root/robotmoney-frontend`, root tmux session `0`, compose project `rm_prod` |
| Rehearsal host | `rm-frontend-stage-2` (142.93.246.99), ephemeral, served at `stage.robotmoney-labs.dev` |
| Production database | DigitalOcean managed Postgres 18; 6.5 GB on 2026-09-25 (issue 1035); read replica for captures |

### 1.1 What v0.5.1 changes

1. **Website** — PRs 1010, 1015, 1032, 1016, 1031, 1037, 1036, 1038 (swarm pages, vault pages, site nav, deposit page, changelog, empty states).
2. **Public judgement API** — PR 1017: `GET /api/swarm/sessions/:id/judgements`, `/api/swarm/judgements/:id`, `/api/swarm/members/:id/judgements`. Read-only; no schema change.
3. **Boot guards** — a read-only database session (SQLSTATE 25006, a managed-Postgres failover) is "unavailable", not "disarmed"; the analytics-ledger-guard step is back in prod-bootstrap.
4. **Deploy hygiene** — the analytics producer no longer receives `MIGRATE_DATABASE_URL`; `WORKER_DATABASE_URL` is forwarded only on `--db external` boots; the twin-roster verify check is real again.
5. **Rehearsal tooling** — slim twin dumps (`--twin-slim`, own directory), 1 GB `/dev/shm` for the restored Postgres, `bun run twin:gate`.
6. **Migrations** — `0061_rm_worker_wallet_backfill_grant` (worker grants), `0062_rm_readonly_sequence_select` (already in production), `0063_swarm_judge_model_default` (judge model).
7. **Found by running R4 on stage-2 (2026-09-25)** — each was a real defect the old rehearsal could not see:
   - the twin restores all four taxonomy roles and gives `rm_owner` production's ownership (a pending migration died on `role "rm_owner" does not exist`);
   - the driver never seats a judge-role member as an analyst (Themis was refused every take with 403);
   - the driver's judge wait outlives a full judge attempt and its retry (a fixed 120 s ceiling sat under the 180 s per-attempt timeout), and a judging that landed without a state transition is logged as judged;
   - the driver may read its own judge job by exact id with the automation token (it was a 403 on any host with a claimed admin credential, so every session waited out the whole ceiling);
   - the judge prompt states that a member holds one position per disagreement (the model repeated Zyfai and the parser, by design, refused the whole answer five times);
   - from the archived 0.5.x work (`ebbfc0bb`): closing a window no longer rolls back on an absence-telemetry failure (a stuck-`collecting` cause), a reschedule re-arms its lifecycle jobs, the API pool has statement and idle-in-transaction timeouts, member takes carry their proposed weights, and a demo boot runs `verify:live --tier readonly` (twin-only legs stay on the twin);
   - the session index returns `takeCount` (PR 1007), which the new swarm pages and the e2e browser test read.

### 1.2 Decisions required before R1 (owner)

Each is a production defect found on 2026-09-24/25. A "no" must be written
here with the reason, because R8 will fail on it.

| ID | Defect (evidence) | Proposed fix in this release | Decision |
|---|---|---|---|
| D1 | `swarm_judge_config` = `enforce` / `model NULL` → 3 dead `swarm.judge` (`model_unconfigured`) in 24 h; 1 session published in 48 h | **Decided 2026-09-25:** the judge uses the CI model, `opencode/deepseek-v4-flash`. Migration `0063` sets it only where the model is missing and never changes `mode` | ✅ |
| D2 | `rm_worker` lacks INSERT/UPDATE/DELETE on `wallet_backfill_state`, `chain_day_blocks` (and, before the archived 0062, `chain_address_floors`) → 288 dead `wallet.backfill_window` in 24 h | **Decided 2026-09-25:** migrate. Main's `0061_rm_worker_wallet_backfill_grant` carried verbatim (same name, so the later merge into main is a no-op for it) | ✅ |
| D3 | Member agents returned empty transcripts. **Cause found 2026-09-25:** the twin's OpenCode Zen account was empty (`Insufficient account funds`, HTTP 402, 1,065 member calls overnight). Production's key is a different account | **Resolved 2026-09-25:** credit added. The gate now treats HTTP 402 as fatal, and R4.9 tears the twin down after grading so it cannot drain the account | ✅ |
| D4 | `unsupported Unicode escape sequence` on parity-observation writes; 24 dead `analytics.parity_sweep` in 24 h. **Cause:** `parity.ts` keys raw_indicator_history rows as `indicator\u0000date`, and jsonb refuses `\u0000` | **Resolved 2026-09-25:** the evidence now stores U+241F instead of the NUL (commit 61ee2a0d, with a test). No waiver needed | ✅ |
| D5 | Production runs `RM_ENV=smoke`, so `config.ts`'s production-only credential checks never fire | Out of scope for 0.5.1 unless the owner says otherwise; record it | ☐ |
| D6 | Production's `schema_migrations` records `0062_rm_readonly_sequence_select.sql` (73 rows); v0.5.0 code had no `0062` file | **Decided 2026-09-25:** carry the archived file unchanged. Already recorded in production, so it does not run there; it makes code and database agree and gives a fresh environment the `rm_readonly` sequence grant | ✅ |

## 2. Roles and evidence

- **Operator** runs every command; **owner** signs R5 (go) and any override.
- Every step records: time (UTC), command, exit code, and the lines named in
  its *Record* column, in the rollout report (R10). A step with no recorded
  evidence did not happen.
- `STOP` means: do not continue, do not improvise; go to R9 if production was
  touched, otherwise fix and restart from R1.

## R1. Code readiness (workstation)

| Step | Command | Pass | Record |
|---|---|---|---|
| R1.0 | `git rev-parse origin/releases-0.5.x v0.5.0^{commit}` | both `ec261867…` (the branch was pruned back to v0.5.0 on 2026-09-24, so R1.1 is a fast-forward) | both |
| R1.1 | `git fetch origin --tags && git switch releases-0.5.x && git merge --ff-only origin/qa/v0.5.1-website-picks && git push origin releases-0.5.x` | fast-forward only | new tip |
| R1.2 | `RC_SHA=$(git rev-parse HEAD); echo $RC_SHA; git tag --points-at HEAD -l 'v0.5.1-rc.*'` | tag list empty | `RC_SHA` |
| R1.3 | `git diff --name-only v0.5.0 "$RC_SHA" -- backend/migrations` | **exactly** `0061_rm_worker_wallet_backfill_grant.sql`, `0062_rm_readonly_sequence_select.sql`, `0063_swarm_judge_model_default.sql` | output |
| R1.4 | `git diff --stat v0.5.0 "$RC_SHA" -- docker-compose.yml` | only two changes: the analytics producer loses `MIGRATE_DATABASE_URL`, and the other five `MIGRATE_DATABASE_URL:` lines gain the `:-` empty default | diffstat |
| R1.5 | `bun install --force && bun install --force --cwd backend` | exit 0 | — |
| R1.6 | `bun run typecheck && (cd backend && bun run typecheck)` | 0 errors | — |
| R1.7 | `bun run test:unit && bun run --cwd frontend test && bun run --cwd contract test` | 0 fail | pass counts |
| R1.8 | `(cd backend && bun test --timeout=30000 --path-ignore-patterns='tests/geckoterminal-resilience.test.ts' --path-ignore-patterns='tests/token-prices-resilience.test.ts')` | 0 fail | pass count |
| R1.9 | `bun run --cwd frontend assemble` | "prerendered 38 routes" | route count |
| R1.10 | GitHub CI on `RC_SHA`: `gh api repos/robotmoney/robotmoney-frontend/commits/$RC_SHA/check-runs --jq '.check_runs[]\|"\(.conclusion) \(.name)"'` | every required job `success` (push to `releases-*` runs them) | list |

## R2. Production baseline (read-only, on `rm-frontend-prod-1`)

Run **before** anything changes, and **within 24 h of R6**: a baseline older than that describes a different production (the d61cb535 baseline below predates the storage upsize). The point is to know what is broken now, so
that every problem is either fixed by this release, accepted in writing, or
blocks the cutover. Production's checkout is still v0.5.0, which has no
`prod:gate`, so the gate runs from a scratch clone of the release candidate
that reads the live stack's state file. It never writes: every query runs on
a session forced read-only.

| Step | Command (root, `rm-frontend-prod-1`) | Pass | Record |
|---|---|---|---|
| R2.1 | `git -C /root/robotmoney-frontend describe --tags`; `docker compose ls`; `tmux ls` | `v0.5.0`; project `rm_prod`; tmux session `0` | all three |
| R2.2 | `D=/root/rm-gate-$RC_SHA; git clone -q --depth 50 --branch releases-0.5.x "$(git -C /root/robotmoney-frontend remote get-url origin)" $D && git -C $D checkout -q "$RC_SHA" && bun install --frozen-lockfile --cwd $D` | HEAD = `RC_SHA` | path |
| R2.3 | Optional: `export CAP_GB=30` (the cluster's storage, 30 GB since 2026-09-25). Storage is managed outside this runbook; the gate only reports size and growth | — | `CAP_GB` |
| R2.4 | `bun run --cwd $D prod:gate -- --mode baseline --db-capacity-gb $CAP_GB --state-file /root/robotmoney-frontend/.agents/smoke-state.json --report /root/prod-gate-reports/R2-baseline-$RC_SHA.md` | **zero unclassified errors** (the inventory check lists none), and every FAIL or WARN is triaged in R2.5 | **the report** (`.md` + `.json`): containers, read-only state, database size (against `CAP_GB` when given) and growth since the previous report, report-only, judge config, dead jobs with classified causes, stuck sessions, and the full inventory of every distinct error and warning of every container |
| R2.5 | **Triage.** For every FAIL check, every known-issue group and every unclassified warning in the report, write one row in the rollout report: *fixed by this release* (name the commit or migration; its classification rule must be a `known-issue`, so the post-release gate fails if it is still there), *accepted* (a written reason and a name), or *blocks the cutover*. An **unclassified error** is added to `scripts/lib/gate/log-classifications.json` in a reviewed commit with its class and reason, or it blocks. | no row empty; no blocker open | the triage table |
| R2.6 | `SELECT name FROM schema_migrations ORDER BY name` | 73 rows ending `0062_rm_readonly_sequence_select.sql` (applied out of band from the abandoned 0.5.x work; see D6); save as `baseline-migrations.txt` | file hash |
| R2.7 | `SELECT has_table_privilege('rm_worker', t, 'INSERT') FROM unnest(array['wallet_backfill_state','chain_day_blocks','chain_address_floors']) t` | today: false (D2) | row |
| R2.8 | The migration login can act as the owner: `cd /root/robotmoney-frontend && psql "$(grep -m1 '^MIGRATE_DATABASE_URL=' .env \| cut -d= -f2-)" -Atc "SELECT pg_has_role(current_user, 'rm_owner', 'MEMBER')"` | `t` (0061 and 0063 run under `SET LOCAL ROLE rm_owner`; the twin proved the SQL, not production's login) | row |
| R2.9 | The judge's key is present and **funded**. Before 0063 production never called the judge model (a NULL model refuses first), so no production evidence exists that this key can pay for it. `K=$(grep -m1 '^OPENCODE_API_KEY=' /root/robotmoney-frontend/.env \| cut -d= -f2-); curl -s -o /dev/null -w '%{http_code}\n' https://opencode.ai/zen/v1/chat/completions -H "Authorization: Bearer $K" -H 'content-type: application/json' -d '{"model":"deepseek-v4-flash","max_tokens":1,"messages":[{"role":"user","content":"ok"}]}'; unset K` | `200`. A `401` or `402` blocks the cutover: after 0063 every judging would die on it | status code |
| R2.10 | Host disk for R3: `df -h /root` | free space ≥ 3 × the previous full dump (18 GB free on 2026-09-25) | free GB |

**Baseline record, 2026-09-25, commit d61cb535** (first run, without
`--db-capacity-gb`): FAIL on 4 checks — capacity not stated (7.98 GB), judge
`enforce` with no model, a treasury session stuck in `scheduled` for 26 h, and
24 dead parity sweeps whose stored error no rule classified (a rule was added).
The container check warned on restarts; the log inventory held 195 distinct
messages across 6 sources, none unclassified.

## R3. Backup

Unchanged from v0.5.0 §4.2, and it is a **full** dump — never `--twin-slim`.

| Step | Command | Pass | Record |
|---|---|---|---|
| R3.1 | `export RM_BACKUP_DIR=/root/rm-backup-v051-$(date -u +%Y%m%dT%H%M%SZ)` (outside the checkout) | — | path |
| R3.2 | `bun run smoke:capture` | exit 0; expect ~20 min at 6.5 GB | stamp, dump size |
| R3.3 | `bun backend/scripts/upgrades/0.4.0-to-0.5.0/restore-check.ts "$RM_BACKUP_DIR" --emit-receipt` **[TO BUILD: 0.5.0-to-0.5.1 copy]** | "DUMP SAFE" | receipt |
| R3.4 | Copy `$RM_BACKUP_DIR` (dump, globals, passphrase) off the host | two copies exist | locations |
| R3.5 | Record the time R3.2 finished. The managed cluster's point-in-time restore is the second way back, and it needs a timestamp from before R6.4's migrations | — | time (UTC) |

## R4. Twin rehearsal (stage-2)

The rehearsal must prove, on production data, that **spoofed member agents
file takes in accelerated sessions and that those sessions close** — for every
subject, with nothing dead and nothing in the logs.

| Step | Command (on `rm-frontend-stage-2`, `~/robotmoney-frontend`) | Pass | Record |
|---|---|---|---|
| R4.1 | Wipe: stop any `bun` process, `docker rm -f $(docker ps -aq)`, `docker volume rm $(docker volume ls -q)` (stage-2 is ephemeral) | 0 containers, 0 volumes | — |
| R4.2 | `git fetch origin && git checkout --detach "$RC_SHA" && bun install --force && bun install --force --cwd backend` | HEAD = `RC_SHA` | HEAD |
| R4.3 | In tmux: `bun smoke:twin -- --no-tui 2>&1 \| tee ~/twin-$RC_SHA.log` | "READY" printed; slim capture ~1 min | READY time = T0 |
| R4.3a | `grep -E 'migrated: 00' ~/twin-$RC_SHA.log` | `0061_rm_worker_wallet_backfill_grant.sql` and `0063_swarm_judge_model_default.sql` applied to the restored production data; `0062` skipped | lines |
| R4.4 | `bun run twin:gate -- --driver-log ~/twin-$RC_SHA.log --report ~/twin-gate-reports/R4.4-$RC_SHA.md --wait 120 --min-sessions 1 --min-attendance 0.5` (+ `--waive` only per D4) | **exit 0**. Database: every subject publishes ≥1 session convened after T0 with takes, an applied model/enforce judgement and a receipt; no dead job; no container restart. Logs: every subject's driver line reads `published: state=published, takes=N of M, judge=enforce` with N ≥ half of M, no line reads `judge=none`, no service or driver log holds a fatal pattern, **every distinct error in every log matches a committed classification (default deny), and no known issue this release fixes is still present** | **the report** (`.md` + `.json`): every check with its result, every session, every job, every container's state, and for EVERY log source — each container, the restored database, the driver log — the lines read and the counts of each fatal pattern, warn pattern, and error-like and warning-like line, with the most frequent error lines |
| R4.5 | Run R4.4 again at T0 + 2 h without `--wait`, with `--report ~/twin-gate-reports/R4.5-$RC_SHA.md` | exit 0: sessions keep closing with judges and nothing died since | the second report |
| R4.6 | Browser pass on `https://stage.robotmoney-labs.dev`: home, `/vaults`, `/vault/rmusdc`, `/vault/rmagent`, `/vault/rmproto`, `/vault/rmrwa`, `/swarm`, a published session, its judgement link, a member page with judgements, `/deposit`, `/changelog` | every page renders data; no console error | screenshots |
| R4.7 | `curl -s https://stage.robotmoney-labs.dev/api/swarm/sessions/<published-id>/judgements` for a session convened after T0 | 200 with ≥1 judgement | response |
| R4.8 | Judge fidelity: on the twin, set `swarm_judge_config.model` to NULL (production's value), run one session, confirm `twin:gate` **fails** with `JudgeUnavailable`; restore the model | the gate catches production's defect | output |
| R4.9 | Tear the twin down: stop the `smoke:twin` process, then R4.1's wipe | 0 containers. A twin left running spends inference credit on every session: on 2026-09-24 one ran overnight until the account returned HTTP 402 on 1,065 member calls | time |

**What R4 proves about the cutover handover, and what it does not.** The new
driver adopts a subject's open session instead of opening a second one
(`session.ts`, issue 570). On 2026-09-25 production's open sessions were all
`scheduled`, none `collecting`: treasury (convened 2026-09-24 15:17), woon
(12:17), allocation (13:47) and vault (16:47), each opened by a run whose
`publish_brief` never landed. The dump carried those four, and the twin's
round 1 adopted all four, published their briefs, collected 6–7 of 8 takes,
judged them under `enforce`, and published them. That is the handover
production will make, rehearsed on production's own rows. What no twin can
rehearse is adopting a `collecting` session: on a twin the driver skips an
adopted window by design, where production waits it out. The driver runs one
session at a time, so at most one session can be `collecting` at R6.3. R6.2a
checks for it.

R4.8 exists because the v0.5.0 rehearsal could not fail on the defect that
broke production. A rehearsal gate that has never been seen to fail is not
evidence.

**Rehearsal record, 2026-09-25, commit 5fba6cac:** `twin:gate --driver-log … --wait 75` PASS — every subject published a judged session convened after T0, 8 of 8 driver lines `judge=enforce`, no dead job, no restart, no fatal log line. R4.7: `/api/swarm/sessions/<id>/judgements` returned a model judgement by Themis. The twin's accelerated 2-minute window made up to three analysts late on some sessions (`HTTP 409: submission window closed`); production's window is 6 h, so `--min-attendance 0.5` is the right threshold for the twin and not a production concession.
R4.8 on the same twin: with `swarm_judge_config.model` set to NULL (production's pre-0.5.1 value) the next session failed the gate on nine independent signals — a dead `swarm.judge`, `JudgeUnavailable (model_unconfigured)`, `NO judgement row was recorded`, `judge=none` in the driver log, no judgement, no receipt, and `swarm session failed`. The gate can fail on the defect that broke production.

## R5. Go / no-go and RC tag

| Step | Action | Pass |
|---|---|---|
| R5.1 | Owner reviews R1–R4 evidence, the R2.5 triage table and the D1–D6 decisions. The R4.4 report must be for the **same** `RC_SHA` that R5.2 tags; a later commit means R4 again, unless `git diff --name-only <R4 sha> "$RC_SHA"` lists only `docs/` and `scripts/lib/gate/log-classifications.json` | written "go" with name and time |
| R5.2 | `git tag -a v0.5.1-rc.N "$RC_SHA" -m 'v0.5.1-rc.N' && git push origin v0.5.1-rc.N` | tag points at `RC_SHA` |

## R6. Production cutover (`rm-frontend-prod-1`, root)

Two migrations run during R6.4's boot (`0061`, `0063`); `0062` is already recorded
and is skipped. The window is short, but production's scheduler is the host
driver: while it is down, no session advances.

| Step | Command | Pass | Record |
|---|---|---|---|
| R6.1 | Announce the window; confirm R3 backup (it is the only way back from a migration) and R5 tag | — | time |
| R6.2 | Confirm both credentials without printing them: `grep -cE '^(MIGRATE_DATABASE_URL\|OPENCODE_API_KEY)=.' /root/robotmoney-frontend/.env` | `2`: the R6.4 boot migrates with the first, and the judge pays with the second (the driver forwards it; compose never reads `.env` itself) | count |
| R6.2a | The sessions R6.3 will interrupt: `bun run --cwd /root/rm-gate-$RC_SHA prod:gate -- --mode baseline --state-file /root/robotmoney-frontend/.agents/smoke-state.json --report /root/prod-gate-reports/R6-precut-$RC_SHA.md` and copy every session in `scheduled` or `collecting` into the rollout report | every open session listed, with its id, state and window close. Every one is `scheduled` (the rehearsed handover). If one is `collecting`, wait for it to publish before R6.3, or record an owner waiver: that branch has no rehearsal | the list |
| R6.3 | `tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}'` to find the pane running `bun` (on 2026-09-25: window `0:1` has two panes); `tmux attach -t 0`; Ctrl-C the running `smoke:archive` in that pane; wait for its teardown; then `cd /root/robotmoney-frontend && bun run smoke:status && docker compose ls` | `rm_prod` gone | output |
| R6.4 | `git status --porcelain` shows nothing tracked (only `?? .codex/` on 2026-09-25); `git fetch origin --tags && git checkout v0.5.1-rc.N && git rev-parse HEAD` (must equal `RC_SHA`); `bun install --force && bun install --force --cwd backend`; `echo "CI=[$CI]"` (must be empty); then, in tmux: `SMOKE_PROJECT=rm_prod bun run smoke:archive -- --no-tui 2>&1 \| tee /root/smoke-archive-v0.5.1.log`. `--no-tui` is required: without it there is no driver log, and R7/R8 cannot grade the driver (the v0.5.0 driver runs with its TUI, so no driver log exists today) | READY printed within 15 min; `GET /health` 200; production T0 = READY time. No READY in 15 min, or a migration error, is a STOP → R9 | T0, first 200 log lines |
| R6.5 | Migrations applied: `grep -E 'migrated: 00' /root/smoke-archive-v0.5.1.log`; then R2.7 again, and `SELECT mode, model, third_party_enabled FROM swarm_judge_config` | log shows `migrated: 0061_rm_worker_wallet_backfill_grant.sql` and `migrated: 0063_swarm_judge_model_default.sql` and **no** `0062`; judge = `enforce` / `opencode/deepseek-v4-flash` / `false`; R2.7 = all `true`; `docker exec rm_prod-worker-swarm-1 sh -c 'test -n "$OPENCODE_API_KEY" && echo key-set'` prints `key-set` | lines, rows |
| R6.6 | `bun run --cwd frontend assemble` only if the boot did not already publish the new SPA; `curl -s https://robotmoney.network/version.json` | commit = `RC_SHA` short | output |

## R7. Immediate postflight (T0 → T0 + 30 min)

From the deployed checkout, now `v0.5.1-rc.N`, which carries `prod:gate`.

| Step | Check | Pass |
|---|---|---|
| R7.1 | `cd /root/robotmoney-frontend && bun run prod:gate -- --mode post-release --since "$T0" --defer-sessions --db-capacity-gb $CAP_GB --driver-log /root/smoke-archive-v0.5.1.log --report /root/prod-gate-reports/R7-post-$RC_SHA.md` | **exit 0**: containers up and never restarted, the database writable, the judge configured, no dead job since T0, and every distinct error since T0 classified with **no known issue this release fixes still present** (read-only, disk-full, wallet grant, judge model, parity NUL, sweep timeout). Sessions are DEFERRED to R8.2 and say so in the report |
| R7.2 | `SELECT name FROM schema_migrations ORDER BY name` diffed against `baseline-migrations.txt` | exactly two added rows: `0061_rm_worker_wallet_backfill_grant.sql`, `0063_swarm_judge_model_default.sql` (75 total) |
| R7.3 | `bun run verify:live --tier readonly --emit-receipt=P8.verify-prod` | exit 0; a WARN is not a pass |
| R7.4 | Browser pass on `https://robotmoney.network`, same page list as R4.6 | renders |
| R7.5 | `curl -s https://robotmoney.network/api/swarm/sessions/<latest-published-id>/judgements` | 200 (an empty list is fine before the first new judgement) |

## R8. Soak (T0 → T0 + 8 h) — the release is not done until this passes

Production opens one session per subject every 6 h with a 6 h window, so the
first session convened after T0 publishes at about T0 + 6 h. The soak is the
only proof that production closes sessions on v0.5.1.

| Step | When | Check | Pass |
|---|---|---|---|
| R8.1 | every 2 h | R7.1 again, `--report /root/prod-gate-reports/R8-<hh>-$RC_SHA.md`. Run it unattended in a second tmux window: `for h in 2 4 6; do sleep 7200; bun run prod:gate -- <R7.1 args> --report /root/prod-gate-reports/R8-${h}h-$RC_SHA.md; done` | exit 0 each time. A FAIL is read at once, not at T0 + 8 h |
| R8.2 | T0 + 8 h | R7.1 **without `--defer-sessions`**, `--report /root/prod-gate-reports/R8-final-$RC_SHA.md` | **exit 0**, now including: every subject published ≥1 session convened after T0 with takes ≥ half the analysts, an applied model/enforce judgement and a receipt; the driver log shows `published: … judge=enforce` for every subject and no `judge=none` |
| R8.3 | T0 + 8 h | every R2.5 triage row marked *fixed by this release* is absent from the R8.2 report's inventory (the gate enforces this for `known-issue` rules; confirm by reading) | all confirmed |
| R8.4 | T0 + 8 h | every session R6.2a listed was **adopted** by the new driver and published with a judgement (`judge=enforce`), or is explained in writing; the stuck sessions in the R2.4 report are resolved or explained | per-session line |

## R9. Rollback

Trigger: any `STOP` in R6–R8 that is not a pure frontend problem. Concretely:
no READY within 15 min of R6.4; a migration error in the boot log; a container
restarting in a loop; an R7.1 or R8 FAIL whose cause this release introduced
(a new unclassified error, a dead `swarm.judge` for any reason other than a
provider outage). A FAIL on a known issue this release does not touch (issue
1035) is triaged, not rolled back.

```bash
# on rm-frontend-prod-1, in tmux session 0
# Ctrl-C the running smoke:archive, wait for teardown
cd /root/robotmoney-frontend
bun run smoke:status && docker compose ls         # rm_prod gone
git checkout v0.5.0 && git rev-parse HEAD         # ec261867...
bun install --force && bun install --force --cwd backend
echo "CI=[$CI]"                                   # must be empty
SMOKE_PROJECT=rm_prod bun run smoke:archive -- --no-tui 2>&1 | tee /root/smoke-archive-rollback.log
```

- v0.5.0 boots on the migrated database: `migrate()` skips recorded rows it has
  no file for, and `0061`/`0063` only add a grant and fill a config value.
  No restore is needed for a code rollback.
- Leave `0061`'s grants and `0063`'s judge model in place: they fix defects
  v0.5.0 has too. Restore R3's backup only if a migration itself is the cause.
- After rollback, run R7.1–R7.3 against the rollback boot, from the scratch clone (`/root/rm-gate-$RC_SHA`), since v0.5.0 has no `prod:gate`.
- v0.5.0's driver predates the judge fixes in 1.1 item 7, so after a rollback the judge runs, but the driver's own `judge=` lines are not trustworthy. Grade judging from `swarm_session_judgements`, not the driver log.
- Do not use `rollout-procedure.md`'s `bun smoke -- --external-pg` rollback:
  `--external-pg` is not a known flag in v0.5.0.

## R10. Completion

1. Tag `v0.5.1` on the same commit as the passing `v0.5.1-rc.N`.
2. Merge `releases-0.5.x` into `main` with a real merge commit (release-branch rule).
3. Write the rollout report: every step's evidence, D1–D6 outcomes, the R2.5 triage table, and every gate report attached verbatim — R2.4 (baseline), R4.4 and R4.5 (twin), R7.1, each R8.1 and R8.2 (production). A step whose check is not in a report did not happen.
4. Close the release issue; file issues for every waiver and every [TO BUILD]
   item not built.

## Appendix A. [TO BUILD] list, in priority order

1. ~~`prod:gate`~~ — built (`scripts/prod-gate.ts`), with the default-deny
   log inventory shared with `twin:gate` (`scripts/lib/gate/`).
2. `backend/scripts/upgrades/0.5.0-to-0.5.1/` — `release.ts` (this release's
   three migrations; the prior list is v0.5.0's plus the out-of-band `0062`), `steps.ts`, `preflight.ts` (R2), `postflight.ts` (R7.4–R7.5),
   `restore-check.ts`, and a step for R4.4 so `runbook.ts` can report status.
3. Fix `rollout-procedure.md`'s rollback command (`--external-pg`) and its
   `BOOT_STATUS=$?` guidance for a driver that never exits on success.
