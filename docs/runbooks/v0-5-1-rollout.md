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
| R1.1 | `git fetch origin --tags && git switch releases-0.5.x && git merge --ff-only origin/qa/v0.5.1-website-picks && git push origin releases-0.5.x` | fast-forward only | new tip |
| R1.2 | `RC_SHA=$(git rev-parse HEAD); echo $RC_SHA; git tag --points-at HEAD -l 'v0.5.1-rc.*'` | tag list empty | `RC_SHA` |
| R1.3 | `git diff --name-only v0.5.0 "$RC_SHA" -- backend/migrations` | **exactly** `0061_rm_worker_wallet_backfill_grant.sql`, `0062_rm_readonly_sequence_select.sql`, `0063_swarm_judge_model_default.sql` | output |
| R1.4 | `git diff --stat v0.5.0 "$RC_SHA" -- docker-compose.yml` | only the analytics-producer `MIGRATE_DATABASE_URL` removal | diffstat |
| R1.5 | `bun install --force && bun install --force --cwd backend` | exit 0 | — |
| R1.6 | `bun run typecheck && (cd backend && bun run typecheck)` | 0 errors | — |
| R1.7 | `bun run test:unit && bun run --cwd frontend test && bun run --cwd contract test` | 0 fail | pass counts |
| R1.8 | `(cd backend && bun test --timeout=30000 --path-ignore-patterns='tests/geckoterminal-resilience.test.ts' --path-ignore-patterns='tests/token-prices-resilience.test.ts')` | 0 fail | pass count |
| R1.9 | `bun run --cwd frontend assemble` | "prerendered 38 routes" | route count |
| R1.10 | GitHub CI on `RC_SHA`: `gh api repos/robotmoney/robotmoney-frontend/commits/$RC_SHA/check-runs --jq '.check_runs[]\|"\(.conclusion) \(.name)"'` | every required job `success` (push to `releases-*` runs them) | list |

## R2. Production baseline (read-only, on `rm-frontend-prod-1`)

Run **before** anything changes, and keep the output: R8 compares against it.
Queries run as `rm_readonly` against the replica unless noted.
**[TO BUILD]** `backend/scripts/upgrades/0.5.0-to-0.5.1/preflight.ts --emit-receipt`
runs R2.1–R2.5 as one receipt; until it exists, run the SQL by hand.

| Step | Check | Pass / expected today | Record |
|---|---|---|---|
| R2.1 | `git -C /root/robotmoney-frontend describe --tags`; `docker compose ls`; `tmux ls` | `v0.5.0`; project `rm_prod`; tmux session `0` | all three |
| R2.2 | `SELECT mode, model, third_party_enabled FROM swarm_judge_config` | today: `enforce`, **NULL**, `false` (D1) | row |
| R2.3 | `SELECT kind, status, count(*) FROM jobs WHERE created_at > now() - interval '24 hours' GROUP BY 1,2` | record; today: dead wallet.backfill_window ×288, analytics.parity_sweep ×24, swarm.judge ×3 | full table |
| R2.4 | `SELECT has_table_privilege('rm_worker', t, 'INSERT') FROM unnest(array['wallet_backfill_state','chain_day_blocks','chain_address_floors']) t` | today: false (D2) | row |
| R2.5 | `SELECT subject_id, state, convened_at, published_at FROM swarm_sessions WHERE convened_at > now() - interval '72 hours' ORDER BY convened_at` plus takes per session (`count(DISTINCT member_id) FROM swarm_memos`) | record; list every session not `published` | table |
| R2.6 | `SELECT name FROM schema_migrations ORDER BY name` | 73 rows ending `0062_rm_readonly_sequence_select.sql` (applied out of band from the abandoned 0.5.x work; see D6); save as `baseline-migrations.txt` | file hash |
| R2.7 | `docker inspect rm_prod-api-1 --format '{{.RestartCount}} {{.State.StartedAt}}'`; `docker logs --since 24h rm_prod-api-1 2>&1 \| grep -cE 'REFUSING the boot\|— DEAD\|JudgeUnavailable'` | record | counts |
| R2.8 | `SELECT pg_size_pretty(pg_database_size(current_database()))` | record (6.5 GB on 2026-09-25) | size |

## R3. Backup

Unchanged from v0.5.0 §4.2, and it is a **full** dump — never `--twin-slim`.

| Step | Command | Pass | Record |
|---|---|---|---|
| R3.1 | `export RM_BACKUP_DIR=/root/rm-backup-v051-$(date -u +%Y%m%dT%H%M%SZ)` (outside the checkout) | — | path |
| R3.2 | `bun run smoke:capture` | exit 0; expect ~20 min at 6.5 GB | stamp, dump size |
| R3.3 | `bun backend/scripts/upgrades/0.4.0-to-0.5.0/restore-check.ts "$RM_BACKUP_DIR" --emit-receipt` **[TO BUILD: 0.5.0-to-0.5.1 copy]** | "DUMP SAFE" | receipt |
| R3.4 | Copy `$RM_BACKUP_DIR` (dump, globals, passphrase) off the host | two copies exist | locations |

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
| R4.4 | `bun run twin:gate -- --driver-log ~/twin-$RC_SHA.log --wait 75 --min-sessions 1 --min-attendance 0.5` (+ `--waive` only per D4) | **exit 0**. Database: every subject publishes ≥1 session convened after T0 with takes, an applied model/enforce judgement and a receipt; no dead job; no container restart. Logs: every subject's driver line reads `published: state=published, takes=N of M, judge=enforce` with N ≥ half of M, no line reads `judge=none`, and no service or driver log holds a fatal pattern (boot refusal, dead job, `JudgeUnavailable`, expired judge wait, `swarm session failed`, `Insufficient account funds`/HTTP 402, DNS, out-of-memory) | full gate output |
| R4.5 | Run R4.4 again at T0 + 2 h without `--wait` | exit 0: sessions keep closing with judges and nothing died since | output |
| R4.6 | Browser pass on `https://stage.robotmoney-labs.dev`: home, `/vaults`, `/vault/rmusdc`, `/vault/rmagent`, `/vault/rmproto`, `/vault/rmrwa`, `/swarm`, a published session, its judgement link, a member page with judgements, `/deposit`, `/changelog` | every page renders data; no console error | screenshots |
| R4.7 | `curl -s https://stage.robotmoney-labs.dev/api/swarm/sessions/<published-id>/judgements` for a session convened after T0 | 200 with ≥1 judgement | response |
| R4.8 | Judge fidelity: on the twin, set `swarm_judge_config.model` to NULL (production's value), run one session, confirm `twin:gate` **fails** with `JudgeUnavailable`; restore the model | the gate catches production's defect | output |
| R4.9 | Tear the twin down: stop the `smoke:twin` process, then R4.1's wipe | 0 containers. A twin left running spends inference credit on every session: on 2026-09-24 one ran overnight until the account returned HTTP 402 on 1,065 member calls | time |

R4.8 exists because the v0.5.0 rehearsal could not fail on the defect that
broke production. A rehearsal gate that has never been seen to fail is not
evidence.

## R5. Go / no-go and RC tag

| Step | Action | Pass |
|---|---|---|
| R5.1 | Owner reviews R1–R4 evidence and the D1–D5 decisions | written "go" with name and time |
| R5.2 | `git tag -a v0.5.1-rc.N "$RC_SHA" -m 'v0.5.1-rc.N' && git push origin v0.5.1-rc.N` | tag points at `RC_SHA` |

## R6. Production cutover (`rm-frontend-prod-1`, root)

Two migrations run during R6.4's boot (`0061`, `0063`); `0062` is already recorded
and is skipped. The window is short, but production's scheduler is the host
driver: while it is down, no session advances.

| Step | Command | Pass | Record |
|---|---|---|---|
| R6.1 | Announce the window; confirm R3 backup (it is the only way back from a migration) and R5 tag | — | time |
| R6.2 | Confirm the migration credential without printing it: `grep -c '^MIGRATE_DATABASE_URL=.' /root/robotmoney-frontend/.env` | `1` (the R6.4 boot migrates with it) | count |
| R6.3 | `tmux attach -t 0`; Ctrl-C the running `smoke:archive`; wait for its teardown; then `cd /root/robotmoney-frontend && bun run smoke:status && docker compose ls` | `rm_prod` gone | output |
| R6.4 | `git fetch origin --tags && git checkout v0.5.1-rc.N && git rev-parse HEAD` (must equal `RC_SHA`); `bun install --force && bun install --force --cwd backend`; `echo "CI=[$CI]"` (must be empty); then, in tmux: `SMOKE_PROJECT=rm_prod bun run smoke:archive -- --no-tui 2>&1 \| tee /root/smoke-archive-v0.5.1.log` | READY printed; `GET /health` 200; production T0 = READY time | T0, first 200 log lines |
| R6.5 | Migrations applied: `grep -E 'migrated: 00' /root/smoke-archive-v0.5.1.log`; then R2.2 and R2.4 again | log shows `migrated: 0061_rm_worker_wallet_backfill_grant.sql` and `migrated: 0063_swarm_judge_model_default.sql` and **no** `0062`; R2.2 = `enforce` / `opencode/deepseek-v4-flash` / `false`; R2.4 = all `true` | lines, rows |
| R6.6 | `bun run --cwd frontend assemble` only if the boot did not already publish the new SPA; `curl -s https://robotmoney.network/version.json` | commit = `RC_SHA` short | output |

## R7. Immediate postflight (T0 → T0 + 30 min)

**[TO BUILD]** `bun run prod:gate` — `twin:gate` pointed at production:
the same session/jobs/containers/logs checks, reading through `rm_readonly`
and `docker logs`, with `--since T0`. Until it exists, run the SQL below.

| Step | Check | Pass |
|---|---|---|
| R7.1 | Every `rm_prod-*` container running, healthy, `RestartCount` 0 | all |
| R7.2 | `docker logs --since "$T0"` on every `rm_prod-*` container **and** `/root/smoke-archive-v0.5.1.log` (the driver): zero lines matching `REFUSING the boot`, `— DEAD`, `JudgeUnavailable`, `EXPIRED (mode=`, `swarm session failed`, `Insufficient account funds`, `HTTP 402`, `No space left on device`, `getaddrinfo`, `out of memory`, `unsupported Unicode escape sequence` (unless waived by D4) | zero |
| R7.3 | `SELECT kind, count(*) FROM jobs WHERE status='dead' AND created_at >= '$T0' GROUP BY kind` | no rows |
| R7.4 | `SELECT name FROM schema_migrations ORDER BY name` diffed against `baseline-migrations.txt` | exactly two added rows: `0061_rm_worker_wallet_backfill_grant.sql`, `0063_swarm_judge_model_default.sql` (75 total) | diff |
| R7.5 | `bun backend/scripts/upgrades/0.4.0-to-0.5.0/postflight.ts --emit-receipt=P8.postflight-prod` **[TO BUILD: 0.5.0-to-0.5.1 copy]** | all checks ok |
| R7.6 | `bun run verify:live --tier readonly --emit-receipt=P8.verify-prod` | exit 0; a WARN is not a pass |
| R7.7 | Browser pass on `https://robotmoney.network`, same page list as R4.6 | renders |
| R7.8 | `curl -s https://robotmoney.network/api/swarm/sessions/<latest-published-id>/judgements` | 200 (empty list is fine before the first new judgement) |

## R8. Soak (T0 → T0 + 8 h) — the release is not done until this passes

Production opens one session per subject every 6 h with a 6 h window, so the
first session convened after T0 publishes at about T0 + 6 h. The soak is the
only proof that production closes sessions on v0.5.1.

| Step | When | Check | Pass |
|---|---|---|---|
| R8.1 | every 2 h | R7.1–R7.3 again | clean |
| R8.2 | T0 + 8 h | Database: every subject has ≥1 session with `convened_at >= T0` and `state = 'published'`, with takes ≥ the D3 threshold, an applied `model`/`enforce` judgement, and a consensus receipt. Logs: `grep -E '\] published: ' /root/smoke-archive-v0.5.1.log` shows, for every subject, a line ending `judge=enforce` with takes ≥ half the roster, and no line ending `judge=none` | all four subjects, both sources |
| R8.3 | T0 + 8 h | no session convened after T0 older than 7 h is still `scheduled`/`collecting`/`window_closed` | none |
| R8.4 | T0 + 8 h | the stuck sessions recorded in R2.5 are resolved or explained | written |
| R8.5 | T0 + 8 h | `SELECT count(*) FROM jobs WHERE status='dead' AND created_at >= '$T0'` | 0 |

## R9. Rollback

Trigger: any `STOP` in R6–R8 that is not a pure frontend problem.

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
- After rollback, run R7.1–R7.3 against the rollback boot.
- Do not use `rollout-procedure.md`'s `bun smoke -- --external-pg` rollback:
  `--external-pg` is not a known flag in v0.5.0.

## R10. Completion

1. Tag `v0.5.1` on the same commit as the passing `v0.5.1-rc.N`.
2. Merge `releases-0.5.x` into `main` with a real merge commit (release-branch rule).
3. Write the rollout report: every step's evidence, D1–D5 outcomes, R8 table.
4. Close the release issue; file issues for every waiver and every [TO BUILD]
   item not built.

## Appendix A. [TO BUILD] list, in priority order

1. `prod:gate` — `twin:gate`'s checks against production (R7, R8). Without it,
   R7/R8 are hand-run SQL, which is how v0.5.0's gaps survived.
2. `backend/scripts/upgrades/0.5.0-to-0.5.1/` — `release.ts` (this release's
   three migrations; the prior list is v0.5.0's plus the out-of-band `0062`), `steps.ts`, `preflight.ts` (R2), `postflight.ts` (R7.4–R7.5),
   `restore-check.ts`, and a step for R4.4 so `runbook.ts` can report status.
3. Fix `rollout-procedure.md`'s rollback command (`--external-pg`) and its
   `BOOT_STATUS=$?` guidance for a driver that never exits on success.
