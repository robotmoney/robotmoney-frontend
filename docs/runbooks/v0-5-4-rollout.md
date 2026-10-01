# v0.5.4 production rollout — a backend and driver patch, no migration

> **Status: proposal (2026-10-01), not yet rehearsed or adopted.** It follows `docs/technical/release-runbooks.md`
> (policy) and `docs/runbooks/rollout-procedure.md` (mechanics), and reuses `v0-5-1-rollout.md` and
> `v0-5-2-rollout.md` where a step is the same. Where it says "as v0.5.1 R6.3", run that step as written there.
> The tracking issue for what this patch does not explain is 1078.

## 0. Why v0.5.4, and why it is not v0.5.3 again

v0.5.3 changed only website files, so it deployed with `site:redeploy` and no container moved. v0.5.4 changes **the api,
the workers, the analytics producer and the host driver**, so it needs the full cutover: the containers are rebuilt and
recreated, and the driver on `rm-frontend-prod-1` is replaced. It changes **no migration and no data**: nothing in it
touches the schema, so there is no database restore in its rollback and no database backup is required to take it.

Each change below is a thing that was seen in production on 2026-09-28 to 09-30:

| Change | Seen as | Issue / PR |
|---|---|---|
| A session shows the day it opened (`openedAt`, read from its first brief revision), not the day its row was created | Sessions completing on 09-30 were dated 09-28; a reader saw "nothing completed since 09-28" | PR 1057 |
| The driver refreshes the regime for today, not for the session's creation day | Four adopted sessions were briefed on 09-29 and 09-30 with the 09-28 regime | issue 1058, PR 1059 |
| The buyback scan halves an `eth_getLogs` range the provider refuses (HTTP 413) | `indexBuybacks` failed 5 times in 30 h and left buyback data where it was | issue 1061, PR 1072 |
| The api's request limit is an explicit 10 s (Bun's default, now a decision, deliberately not raised) and a request over 5 s is logged as a defect | One stalled request became a 502 (21:40:16 UTC 09-30) with no path or duration in the log | issue 1060, PR 1075 |
| GeckoTerminal calls use the paid CoinGecko key (Basic plan) and the ledger redacts it | The keyless host (about 10 calls a minute per IP) 429s the `new_pools` sweep every cycle | issue 1062, PR 1077 |

## 1. Release identity

| Item | Value |
|---|---|
| Branch | `releases-0.5.x` |
| From | `v0.5.3` (`cb82726f`), the website-only release now in production |
| RC tag | `v0.5.4-rc.N` on `RC_SHA` |
| Final tag | `v0.5.4`, tagged when R7 passes (before any watch) |
| Prior production state | backend, workers, producer and driver at `becb6897` (v0.5.2); website at `cb82726f` (v0.5.3) |
| Rollback target | `v0.5.3` (its backend is v0.5.2's), **no database restore** |
| Window | a few minutes of api and website outage while the containers are recreated; the driver is down for the same time |

### 1.1 Decisions (owner), before R1

| # | Decision | Needed |
|---|---|---|
| D1 | Is `COINGECKO_API_KEY` set in `/root/.env` for this release? Without it, the Gecko change is inert (everything stays keyless) and the release is still correct. With it, R7.8 must pass. The key is an owner step: this runbook never reads or prints it | yes / no, and the time |
| D2 | A cutover window. The api and the website are down for the recreate (R6.4) | time |

### 1.2 The read-only query helper

Database checks run through the api container, which already holds the connection, so no credential is read or printed.
Define it once per shell (`C` is the api container: `rm_prod-api-1` on production, `$PROJECT-api-1` on the twin):

```bash
q() { docker exec "$C" bun -e 'import postgres from "postgres"; const sql = postgres(process.env.DATABASE_URL, { max: 1 }); const rows = await sql.unsafe(process.argv[1]); console.log(JSON.stringify(rows)); process.exit(0)' "$1"; }
# q "SELECT count(*) FROM swarm_sessions"
```

Only `SELECT` statements are used in this runbook.

## R1. Code readiness (workstation)

| Step | Command | Pass | Record |
|---|---|---|---|
| R1.1 | `git fetch origin --tags && git switch releases-0.5.x && git merge --ff-only origin/releases-0.5.x`; `RC_SHA=$(git rev-parse HEAD); echo $RC_SHA` | fast-forward only | `RC_SHA` |
| R1.2 | `git tag --points-at HEAD -l 'v0.5.4-rc.*'` | empty | — |
| R1.3 | `git diff --name-only v0.5.3 "$RC_SHA" -- backend/migrations` | **empty.** If it is not, this is not a patch: stop and use v0.5.2's runbook | output |
| R1.4 | `git diff --stat v0.5.3 "$RC_SHA" -- docker-compose.yml docker-compose.smoke.yml` | exactly the `COINGECKO_API_KEY:` lines on the worker lanes and `analytics-producer` (10 lines) | diffstat |
| R1.5 | `bun install --force && bun install --force --cwd backend` | exit 0 | — |
| R1.6 | `bun run typecheck && (cd backend && bun run typecheck)` | 0 errors | — |
| R1.7 | `bun run test:unit && bun run --cwd frontend test && bun run --cwd contract test` | 0 fail | pass counts |
| R1.8 | `cd backend && bun test --timeout=30000` | 0 fail, including `tests/gecko-endpoint.test.ts`, `tests/api-request-timing.test.ts`, `tests/buyback-logs-batching.test.ts`, `tests/swarm-session-list-subject.test.ts`, `tests/no-new-vendor.test.ts` | pass count |
| R1.9 | `bun run --cwd frontend assemble` | "prerendered 38 routes" | route count |
| R1.10 | `gh api repos/robotmoney/robotmoney-frontend/commits/$RC_SHA/check-runs --jq '.check_runs[]\|"\(.conclusion) \(.name)"'` | every required job `success` | list |
| R1.11 | Each PR in section 0 is merged to `main` and cherry-picked here: `git log --oneline v0.5.3..$RC_SHA \| grep -E '#(1057\|1058\|1060\|1061\|1062)'` | five lines | list |

## R2. Production baseline (read-only, `rm-frontend-prod-1`)

Run from a scratch clone at `RC_SHA`, never from the live checkout, which sits under the running host driver.

| Step | Command | Pass | Record |
|---|---|---|---|
| R2.1 | `git -C /root/robotmoney-frontend describe --tags; docker ps --format '{{.Names}} {{.Status}}'; curl -s https://robotmoney.network/version.json` | `v0.5.2-rc.2` (`becb6897`); six containers healthy; the site is `cb82726` | all three |
| R2.2 | `bun run --cwd /root/rm-gate-$RC_SHA prod:gate -- --mode baseline --state-file /root/robotmoney-frontend/.agents/smoke-state.json --report /root/prod-gate-reports/R2-$RC_SHA.md` | triage every finding; none new | the report |
| R2.3 | `docker logs --since 24h rm_prod-website-server-1 2>&1 \| grep -aEc '" 5[0-9][0-9] '` | recorded: the pre-cutover 5xx count (R7.6 compares) | count |
| R2.4 | `docker logs --since 24h rm_prod-api-1 2>&1 \| grep -ac 'timed out after 10 seconds'` | recorded: the 10 s cut-offs this release replaces | count |
| R2.5 | `docker logs --since 24h rm_prod-worker-analytics-1 2>&1 \| grep -ac 'Base RPC HTTP 413'` | recorded (R7.7 expects 0, or a split line after each) | count |
| R2.6 | `docker logs --since 24h rm_prod-analytics-producer-1 2>&1 \| grep -ac 'HTTP 429'` | recorded: the throttled `new_pools` retries (R7.8) | count |
| R2.7 | Every session in `scheduled` or `collecting`: `C=rm_prod-api-1; q "SELECT id, subject_id, state, window_closes_at FROM swarm_sessions WHERE state IN ('scheduled','collecting') ORDER BY convened_at"` (and R2.2's report lists them) | listed. A `collecting` session is interrupted by the driver restart: wait for it to publish, or record an owner waiver | the rows |
| R2.8 | `df -h /` and `docker system df` | free ≥ 10 GB (the rebuild adds images) | GB |
| R2.9 | `tmux ls; tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}'` | the pane running `bun smoke:archive` is identified. An idle `claude` session in pane `0:1.0` is noted and left alone | output |
| R2.10 | `ls /root/site-backups` and the newest database backup under `/root` | the latest website backup (rollback of the website half) exists | paths |

## R3. Backup

No database backup is required: nothing in this release writes the schema or any row in a new shape (R1.3). The website
half is backed up by `site:redeploy` (R6.7). If R1.3 fails, stop.

## R4. Rehearsal on stage-2 (`rm-frontend-stage-2`), on the repaired production backup

The rehearsal must prove the five changes on a stack booted from production's own data, and that sessions still publish.
A twin runs accelerated sessions (2 to 6 minute windows) and **spends inference credit on every one**: tear it down (R4.12).

| Step | Command (on stage-2, `~/robotmoney-frontend`) | Pass | Record |
|---|---|---|---|
| R4.1 | Wipe: `bun run smoke:down; docker rm -fv $(docker ps -aq); bun run smoke:clean` | 0 containers, 0 volumes | — |
| R4.2 | `git fetch origin --tags && git checkout --detach "$RC_SHA" && bun install --force && bun install --force --cwd backend` | HEAD = `RC_SHA` | HEAD |
| R4.3 | In tmux: `bun smoke:twin -- --reuse --backup-dir ~/rm-backup-v052-repaired --no-tui 2>&1 \| while IFS= read -r l; do printf '%s %s\n' "$(date -u +%T)" "$l"; done \| tee ~/twin-$RC_SHA.log` | `READY`; `131 checks · 0 failed` | READY time = T0 |
| R4.3a | `grep -E 'migrated: 00' ~/twin-$RC_SHA.log` | **no** `migrated:` line for a new migration (the backup already has all 79) | lines |
| R4.4 | `bun run twin:gate -- --driver-log ~/twin-$RC_SHA.log --report ~/twin-gate-reports/R4.4-$RC_SHA.md --wait 40 --sessions 2 --min-attendance 1` | exit 0: two sessions publish, a take from every active analyst, an applied judgement and a receipt, no dead job, no container restart | the report |
| R4.5 | **The opened-at change.** `curl -s "http://127.0.0.1:48787/api/swarm/sessions?limit=5"` and the detail of the newest published session | every published session carries `openedAt` (an ISO instant), never null; for a session convened after T0 it is within a minute of its brief and **after** `generatedAt` when the row waited; `date` is unchanged | the JSON |
| R4.5a | Browser pass on the twin's site (`/swarm`, a published session, `/vault/rmusdc`): the index row, the "Latest session" fact and the session header show the `openedAt` day and time (UTC) | the day matches `openedAt`, not `date`, for an adopted session | screenshots |
| R4.6 | **The regime day.** `grep -E 'regime asof' ~/twin-$RC_SHA.log` | every line reads **today's UTC date**, including the lines for sessions the twin adopted from the backup (those were convened on an earlier day) | lines |
| R4.7 | **The api limit and the slow-request log.** The limit is 10 s on purpose: a request over 5 s means work that does not belong on the request path. Every `[api] slow request` line is a finding to record (issue 1079 is the known one: `POST /api/analytics/source-acquisitions`). `docker logs "$PROJECT-api-1" 2>&1 \| grep -aE '\[api\] (slow request\|request ran past)\|timed out after'` and `grep -n 'idleTimeout' backend/src/api/index.ts` | no `timed out after`; each `[api] slow request` line is listed with its path and duration (the acquisitions route is expected until issue 1079 ships); `idleTimeout: API_IDLE_TIMEOUT_SECONDS` | lines |
| R4.8 | **Buyback.** `docker logs "$PROJECT-worker-analytics-1" 2>&1 \| grep -aE 'Base RPC HTTP 413\|eth_getLogs .* answered HTTP 413\|live index failed'` | no `live index failed`. A `413` is followed by a `reading … separately` line | lines |
| R4.9 | **Gecko, keyless (the default on stage-2).** `docker logs "$PROJECT-analytics-producer-1" 2>&1 \| grep -aE '\[gecko\]'` | `new_pools via free tier (api.geckoterminal.com)`. If the owner exported `COINGECKO_API_KEY` on stage-2, R4.9a replaces this | lines |
| R4.9a | **Gecko, keyed (only if the key is set on stage-2).** The same grep, and `grep -aE 'HTTP 429\|answered HTTP 40[13]'` on the producer and analytics-worker logs | `new_pools via pro tier (pro-api.coingecko.com)`; 0 lines for the second grep | lines |
| R4.10 | **The key never reaches the ledger or the api.** `q "SELECT count(*)::int AS n FROM source_fetches WHERE request_identity::text ~* 'x-cg-pro-api-key' AND request_identity::text !~ 'REDACTED'"` (0 even when no key is set), and `docker compose -p "$PROJECT" config --format json \| python3 -c "import json,sys; c=json.load(sys.stdin); print(sorted(k for k,v in c['services'].items() if 'COINGECKO_API_KEY' in (v.get('environment') or {})))"` | `n` is 0; the list is exactly `['analytics-producer', 'worker-analytics', 'worker-research', 'worker-swarm']` (the api and the website have none) | both |
| R4.11 | The website checks R7 will run, run here first: the browser module pass (`/`, `/vaults`, `/vault/rmusdc`, `/swarm`, `/regime`, `/changelog` against the twin site: 0 module requests without the stamp, 0 failed, 0 page errors) and `bun run verify:live --tier readonly` on stage-2, which reads the twin from `.agents/smoke-state.json` (or pass `--base http://127.0.0.1:48787`). The browser pass can also run from a workstation against `https://stage.robotmoney-labs.dev`, which serves the twin | modules all carry one stamp; `verify:live` has no blocking condition. A session from the dump that was `collecting` past its window at the dump instant is reported as wedged until the twin closes it: re-run after R4.4 and record both | output |
| R4.12 | Tear down within 30 minutes: stop the `smoke:twin` process (`tmux kill-session -t twin`), then R4.1's wipe | 0 containers, 0 volumes | time |

## R5. Go / no-go and RC tag

| Step | Action | Pass |
|---|---|---|
| R5.1 | The owner reviews R1 and R4 and decides D1 and D2. The R4.4 report must be for the **same** `RC_SHA` that R5.2 tags; a later commit means R4 again unless it changes only `docs/` | written "go" with name and time |
| R5.2 | `git tag -a v0.5.4-rc.N "$RC_SHA" -m 'v0.5.4-rc.N' && git push origin v0.5.4-rc.N` | tag points at `RC_SHA` |

## R6. Production cutover (`rm-frontend-prod-1`, root)

The driver is production's scheduler. While it is down no session opens or closes, and open sessions keep their rows
(`scheduled` and `collecting` are database state), so the window loses no data. Run from the live checkout only for the
steps that must; clones for everything else.

| Step | Command | Pass | Record |
|---|---|---|---|
| R6.1 | Announce the window. Confirm R5's tag. `D=/root/rm-site-$RC_SHA; git clone -q --depth 50 --branch releases-0.5.x "$(git -C /root/robotmoney-frontend remote get-url origin)" $D && git -C $D checkout -q "$RC_SHA" && bun install --frozen-lockfile --cwd $D && bun install --frozen-lockfile --cwd $D/backend` | `git -C $D rev-parse HEAD` = `RC_SHA` | path |
| R6.2 | If D1 is yes: `grep -cE '^COINGECKO_API_KEY=.' /root/.env /root/robotmoney-frontend/.env` (counts only; never `cat`) | one file has `1` | count |
| R6.3 | Stop the driver: `tmux attach -t driver`; Ctrl-C the `smoke:archive`; then `cd /root/robotmoney-frontend && bun run smoke:down && docker compose ls` | `rm_prod` gone, 0 `rm_prod` containers. (Ctrl-C alone leaves the containers up; `smoke:down` is required.) `T0=$(date -u +%FT%TZ)` | output |
| R6.4 | `cd /root/robotmoney-frontend && git status --porcelain` (nothing tracked); `git fetch origin --tags && git checkout v0.5.4-rc.N && git rev-parse HEAD` (= `RC_SHA`); `bun install --force && bun install --force --cwd backend`; `echo "CI=[$CI]"` (empty); then in tmux: `SMOKE_PROJECT=rm_prod bun run smoke:archive -- --no-tui 2>&1 \| while IFS= read -r l; do printf '%s %s\n' "$(date -u +%T)" "$l"; done \| tee /root/smoke-archive-v0.5.4.log` | `READY` printed; **no** `migrated:` line; the boot guards report armed | READY time |
| R6.5 | `docker ps --format '{{.Names}} {{.Status}}'; docker exec rm_prod-worker-swarm-1 sh -c 'test -n "$OPENCODE_API_KEY" && echo key-set'` | six services Up and healthy; `key-set`. If D1: `docker exec rm_prod-analytics-producer-1 sh -c 'test -n "$COINGECKO_API_KEY" && echo key-set'` prints `key-set`, and the same on `rm_prod-worker-analytics-1` | output |
| R6.6 | `q "SELECT name FROM schema_migrations ORDER BY name"` diffed against the same query run in R2 | identical (no migration ran) | diff |
| R6.7 | The website half, from the R6.1 clone: `cd $D && bun scripts/redeploy-website.ts --live /root/robotmoney-frontend --public https://robotmoney.network --dry-run`, then without `--dry-run`. (The boot may already have published the new SPA: `curl -s https://robotmoney.network/version.json` first, and skip if it already reads `RC_SHA`'s first 8 characters.) | `DONE`; every one of 38 routes 200; `version.json` = `RC_SHA` | receipt |
| R6.8 | `curl -s https://robotmoney.network/ \| grep -o 'assets/js/app/main.js[^"]*'` | `?v=` and 8 hex characters | output |

## R7. Immediate postflight (T0 → T0 + 30 min)

| Step | Check | Pass |
|---|---|---|
| R7.1 | `cd /root/robotmoney-frontend && bun run prod:gate -- --mode post-release --release v0.5.4 --since "$T0" --defer-sessions --db-capacity-gb 30 --state-file .agents/smoke-state.json --driver-log /root/smoke-archive-v0.5.4.log --report /root/prod-gate-reports/R7-post-$RC_SHA.md` | exit 0: containers up and never restarted, the database writable, no dead job since T0, every distinct error since T0 classified |
| R7.2 | `bun run verify:live --tier readonly --emit-receipt=P8.verify-prod-v0.5.4` | exit 0; the two higher-tier `skipped` warnings only |
| R7.3 | Ten public pages 200 (`/`, `/vaults`, `/vault/rmusdc`, `/swarm`, `/deposit`, `/changelog`, `/skills`, `/regime`, `/regime/indicators`, `/smart-contract-risks`), then the browser module pass on six of them | 0 failed, 0 unstamped, 0 page errors |
| R7.4 | `curl -s "https://robotmoney.network/api/swarm/sessions?limit=8"` | every published session carries `openedAt`; the sessions still `collecting` carry it too if their brief went out |
| R7.5 | The first session the new driver opens or adopts: `grep -E 'regime asof' /root/smoke-archive-v0.5.4.log` | the line's date is **T0's UTC date** (or later), not the creation day of an adopted row |
| R7.6 | `docker logs --since "$T0" rm_prod-website-server-1 2>&1 \| grep -aEc '" 5[0-9][0-9] '`, and `docker logs --since "$T0" rm_prod-api-1 2>&1 \| grep -aE 'timed out after\|\[api\] request ran past'` | the count is no higher than R2.3's rate; the second grep is empty |
| R7.7 | `docker logs --since "$T0" rm_prod-worker-analytics-1 2>&1 \| grep -aE 'Base RPC HTTP 413\|live index failed'` | no `live index failed` |
| R7.8 | If D1: `docker logs --since "$T0" rm_prod-analytics-producer-1 2>&1 \| grep -aE '\[gecko\]\|HTTP 429'` | `new_pools via pro tier`; no `HTTP 429`; no `answered HTTP 40[13]`. If D1 is no: `via free tier` and the 429s may remain (recorded, not a failure) |
| R7.9 | If D1: `C=rm_prod-api-1; q "SELECT count(*)::int AS n FROM source_fetches WHERE request_identity::text ~* 'x-cg-pro-api-key' AND request_identity::text !~ 'REDACTED'"` | `n` is 0 |
| R7.10 | **Tag now.** `git tag -a v0.5.4 "$RC_SHA" -m v0.5.4 && git push origin v0.5.4` (a release is tagged when its post-deploy checks pass, before any watch) | tag pushed |

## R8. Watch (T0 → T0 + 8 h)

Production opens one session per subject every 6 h with a 6 h window, so the first session this driver opens publishes at
about T0 + 6 h. The watch runs **unattended**, so it cannot be skipped (issue 1078 item 8). In a second tmux window:

`for m in 15 30 60 120 240 420; do sleep $((m*60 - $(date +%s) + $(date -d "$T0" +%s))); bun run prod:gate -- --mode post-release --release v0.5.4 --since "$T0" --defer-sessions --db-capacity-gb 30 --state-file /root/robotmoney-frontend/.agents/smoke-state.json --driver-log /root/smoke-archive-v0.5.4.log --report /root/prod-gate-reports/R8-${m}m-$RC_SHA.md; done`

| Step | When | Check | Pass |
|---|---|---|---|
| R8.1 | each pulse | the gate's exit code, R7.6, R7.7, R7.8 | exit 0; the same six containers, never restarted |
| R8.2 | T0 + 8 h | the gate **without** `--defer-sessions` | exit 0: every subject published a session convened after T0 or adopted and briefed after T0, with takes ≥ half the analysts and a judgement; each session's `openedAt` is after its row's `generatedAt` and within its window; the driver log's `regime asof` is the day it ran |
| R8.3 | T0 + 8 h | every session R2.7 listed was adopted and published, or is explained in writing | per-session line |

A failure here is a rollback (R9) only if readers' pages are broken or sessions do not publish; otherwise it is a
follow-up in issue 1078 or its own issue.

## R9. Rollback — no database restore

Nothing migrated, so going back is code only.

1. `tmux attach -t driver`; Ctrl-C the `smoke:archive`; `cd /root/robotmoney-frontend && bun run smoke:down`.
2. `git checkout v0.5.3 && bun install --force && bun install --force --cwd backend`.
3. In tmux: `SMOKE_PROJECT=rm_prod bun run smoke:archive -- --no-tui 2>&1 | tee /root/smoke-archive-v0.5.3-rollback.log` (`READY`).
4. The website is already at `cb82726f` if R6.7 was skipped; otherwise `bun scripts/redeploy-website.ts --live /root/robotmoney-frontend --rollback /root/site-backups/<the directory R6.7 printed>`.
5. Pass: `docker ps` shows six healthy services; `version.json` is `cb82726`; `schema_migrations` is unchanged.

Sessions convened or briefed under v0.5.4 stay as they are: `openedAt` is computed when read, so the older api simply
does not return it, and the older site shows `date` as it did before.

## R10. Completion

1. `v0.5.4` is tagged at R7.10.
2. Write the rollout report: every step's evidence, R4's output, R6's receipt, R7 and R8's gate reports.
3. Update issue 1078: tick or split each item this release touched (items 1, 2, 3, 4 and 12 especially).
4. The merge of `releases-0.5.x` into `main` is tracked in issue 1063.

## Appendix A. Rehearsal record

### 2026-10-01, stage-2, commit `0706bef7` (release tip before the session-page date fix): the gate FAILED, 6 of 20 checks

Twin booted READY at 01:58:45 on the repaired v0.5.2 backup, `131 checks · 0 failed`, **no migration applied** (R4.3a). `twin:gate`
ran 40 minutes, finished 02:39:40, and failed. No waiver was applied, and none of the failures is attributable to the five changes in
section 0. Each is classified here so the owner can decide (R5.1); this release is **not yet cleared by the gate**.

| Gate check | Result | Cause |
|---|---|---|
| Every subject published a judged, attended session | FAIL | `robotmoney-treasury` session `16113cf1`: **a dump artifact.** The backup (09-29 19:00) holds it `collecting` with its window closed at 18:32. The twin adopts it, publishes it with **0 of 7 takes** and cannot judge it (`no_takes`). v0.5.1's runbook records that a twin cannot rehearse adopting a `collecting` session. Allocation, vault and woon published 7 of 7 with a judgement and a receipt |
| The driver logged every subject as published with `judge=enforce` | FAIL | treasury (the artifact) and **vault: `model_timeout`**. The judge model (`opencode/deepseek-v4-flash`) ran past the driver's 420 s wait, so the driver published with `judge=none`. The database shows the vault session judged and receipted afterwards. Inference latency, not code |
| No job created after T0 is dead | FAIL | 1 dead `swarm.judge`: the treasury `no_takes` session |
| Every distinct error is classified | FAIL | `analytics.parity_sweep` "Unable to connect" ×2 at 01:58:33, **before the api was ready** (boot race); `swarm.judge` `no_takes` and `model_timeout` lines (the two above) |
| Log scan: worker-swarm | FAIL | the one `DEAD` line (treasury) |
| Log scan: driver | FAIL | `NO judgement row was recorded` ×2, `JudgeUnavailable` ×2, `swarm session failed` ×1: treasury and vault, as above |
| Containers running, healthy, never restarted | PASS | 6 of 6, 0 restarts |
| Log scans: producer, website, api, research, analytics worker, restore, seven members | PASS | |

**The five changes, observed on this twin** (checked directly, not by the gate):

| Change | Observed |
|---|---|
| Session date (`openedAt`) | the API returns it for every session that has a brief: treasury created 09-28 00:40, opened 09-29 18:26; allocation opened 10-01 02:01; `scheduled` and unbriefed sessions return null |
| Regime day | every `regime asof` line reads `2026-10-01`, including for the sessions adopted from 09-28 |
| Buyback 413 | the real provider answered 413 and the scan split 66 times; `live index failed` 0 (production: 5 failures in 30 h) |
| api limit | 10 s, 0 `timed out after` lines; the slow-request log works and names every slow route (below) |
| Gecko key | **not exercised on stage** (no key on stage-2; the producer's sweep had not run). Exercised by the e2e job in CI on PR 1077: `[gecko] new_pools via pro tier`, no 429. The ledger holds no unredacted key header (0 rows) |

**What the new slow-request log found** (16 lines in the first minutes, all over 5 s): `POST /api/analytics/source-acquisitions`,
`/api/swarm/register`, `/api/analytics/vintages`, `/api/analytics/run-packages`, `/api/analytics/telemetry`; and later **11 requests to
`POST /api/analytics/parity-sweep` that took 17 to 25 s and were cut off at the 10 s limit** (the worker's 35 queued sweeps from the
dump ran back to back). Production's hourly sweeps succeeded 48 of 48 in the last 48 h, so production is not affected today. Each of these is
work on the request path (issue 1079). The gate did not flag the cut-offs: `twin:gate` treats the `[api] request ran past the limit` line as
neither an error nor a warning (issue 1078).

**Site check, after `site:redeploy` of `634d9e1a` onto the twin** (the session-page fix, issue 1081): `https://stage.robotmoney-labs.dev/swarm/sessions/12a04ae6-…` reads
"October 1, 2026 · 02:11 UTC" with the breadcrumb and title on Oct 1; `/swarm` lists sessions newest-opened first (Oct 1 02:24, 02:11, 02:01, then Sep 29 18:26);
the subject page's newest row reads Oct 1. The browser module pass (88 modules, one stamp, 0 failed, 0 page errors) passed on `0b2154c5`. `verify:live`
works against stage (it reads `.agents/smoke-state.json`); its one blocking finding was the same treasury artifact.

**What the owner decides (R5.1):**
1. Waive the treasury artifact (D4, a recorded waiver with this explanation) **or** take a fresh backup so no session is `collecting` past its window, and rerun R4.
2. The vault `model_timeout`: rerun (inference latency), or accept with the database proof that it was judged.
3. The rehearsal ran on `0706bef7`; the tip is now `634d9e1a` (frontend only: the session-page fix, checked above by `site:redeploy` on the twin). R5.1 asks for the **same** commit: decide whether the frontend-only difference needs the full gate again.

The twin was torn down at 02:42 (0 containers, 0 volumes). The gate report is `~/twin-gate-reports/R4.4-0706bef7.md` on stage-2.
