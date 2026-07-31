# Data-Integrity Review — W3 Runtime Evidence (rm_demo_stack_d2b89936a0)

Collected 2026-07-31 ~01:52–01:58 UTC against the live stack. All DB access was
SELECT-only via `docker exec … psql`. Worktree read at commit 06b260f0.

## 1. Environment identity

Containers (`docker ps`, project `rm_demo_stack_d2b89936a0`, all Up ~6h):

| container | image | ports |
|---|---|---|
| api-1 | rm_demo_stack_d2b89936a0-api | **0.0.0.0:48787→8787** |
| worker-committee-1 / worker-analytics-1 / worker-research-1 | (stack images) | — |
| postgres-1 | postgres:17-alpine (healthy) | 0.0.0.0:33701→5432 |

`ss -ltnp` confirms host :48787 is bound, and docker maps it to this stack's
api-1. So stage.robotmoney-labs.dev (cloudflared → localhost:48787) serves THIS
stack.

Compose labels on api-1:
`config_files = docker-compose.yml,docker-compose.demo.yml,docker-compose.stage.yml`
(working_dir = the principal checkout). So this is the demo+stage overlay stack.

Env (values of `*_TOKEN` redacted; both ANALYTICS_TOKEN and ADMIN_TOKEN are SET):

- All four app containers: `RM_ENV=demo`, `DEMO_MODE=1`, **`ANALYTICS_SOURCE=live`**,
  `ANALYTICS_FLOOR_SEED=1`, `BASE_RPC_SOURCE=live`, `DATABASE_URL=postgres://…@postgres:5432/robotmoney`.
- api-1 additionally: `RM_ALLOW_INSECURE=1`, `STATIC_DIR=/srv/frontend`,
  `COMMITTEE_SCHEDULES_ENABLED=0`, committee crons set.
- Workers: `WORKER_LANE=analytics|research|committee`, `ANALYTICS_API_URL=http://api:8787`.
- `COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_URL` / `_TOKEN` are **empty** (matters below).
- `FLOOR_SEED_PATH`, `FETCH_CACHE_DIR`, `PROJECTS_SOURCE`, `BASE_RPC_URL`, `WORKER_DATABASE_URL` empty.

**Identity verdict:** demo-mode stack, but the analytics pipeline fetches LIVE
market/on-chain data (`ANALYTICS_SOURCE=live`); it is not a hermetic/synthetic
fixture stack.

## 2. Database census

53 public tables (full `pg_tables` list captured during review). Key tables:

### raw_indicator_history — 134,980 rows, 27 distinct indicators, 1871-02-01 → 2026-07-31

Per-indicator freshness (days_behind = vs freshest indicator, query:
`SELECT indicator, count(*), min(date), max(date), (SELECT max(date) FROM raw_indicator_history)-max(date) FROM raw_indicator_history GROUP BY indicator`):

| indicator | rows | first | last | days behind |
|---|---|---|---|---|
| DXY | 5106 | 2010-01-04 | 2026-07-24 | 7 |
| ICSA | 3519 | 2010-01-02 | 2026-07-25 | 6 |
| BTC_ACTIVE | 6395 | 2009-01-03 | 2026-07-29 | 2 |
| BTC_MVRV | 3132 | 2018-01-01 | 2026-07-29 | 2 |
| DFII10 | 5124 | 2010-01-04 | 2026-07-29 | 2 |
| HY_OAS | 1149 | 2023-05-30 | 2026-07-29 | 2 |
| 16 more (DEFI_TVL, VIX, SPX_TREND, SHILLER_CAPE, T10Y2Y, …) | — | — | 2026-07-30 | 1 |
| BTC_ETH, COPPER_GOLD, ETH_TREND, MNA (monthly, 199 rows), NEW_TOKENS (32 rows since 2026-05-31) | — | — | 2026-07-31 | 0 |

**Missing-indicator list: NONE.** No indicator has zero rows; none is >7d
stale. ICSA is a weekly series and DXY's source publishes with lag — 6–7d is
normal shape for them. NEW_TOKENS is simply a new indicator (first row
2026-05-31).

### regime_snapshots — 3,140 rows, 2018-05-15 → **2026-12-18** (grew to 2026-12-19 during review)

- Single version `v3`.
- **140 rows have dates AFTER today** (`SELECT count(*) … WHERE date > CURRENT_DATE`),
  a contiguous daily run 2026-08-01 → 2026-12-18+, all `regime=neutral`,
  composite drifting ~0.48–0.49. One new future row is added per demo session.
- A genuine row for real today (2026-07-31) exists (written by worker-lane
  regime.classify, log: `regime asof 2026-07-31: composite=0.4829… (3000 rows)`).

### research_signals — 4 rows, 2 keys (channel-divergence, late-cycle-signals), dates 2026-07-30 and 2026-07-31. Fresh.

### Empty tables

- `analytics_runs`, `analytics_stage_runs`, `analytics_artifacts` — 0 rows.
  Referenced only by migrations (0009_analytics_v2.sql, 0017, 0018) and tests,
  **not by any backend/src code** → legacy/retired tables; empty by design.
- `regime_indicators` — 0 rows; same situation (raw_indicator_history is the
  live store).

### Projects / committee / samplers

| table | rows | latest |
|---|---|---|
| projects | 11 | updated_at 2026-07-30 19:49 (boot seed) |
| committee_sessions | 282→284 | dates **2026-07-30 → 2026-12-19/20** (see §6) |
| committee_members | 9 | — |
| committee_memos | 2175 | — |
| committee_briefs | 282 | — |
| committee_recommendations | 2174 | — |
| committee_subject_snapshots | 286 | date **2026-12-20** (future) |
| research_pipeline_runs | 283→284 | 2026-07-31 01:53 — ALL kind=regime, source=live, **job_id NULL on all 284** |
| research_pipeline_stages | 1988 | (≈7 per run) |
| research_pipeline_warnings | 1 | see §4 |
| wallet_balance_samples | 658 | 2026-07-31 01:03 |
| vault_share_price_history | 7 | 2026-07-31 01:00 |
| daily_tvl_snapshots 5, buyback_swaps 10, lobster_coins 8, openclaw_agents 11, tracked_wallets 15, audit_log 2224 | — | — |

## 3. Queue / job health

`SELECT kind, status, count(*), max(updated_at) FROM jobs GROUP BY kind, status`
(DB now() = 2026-07-31 01:52:39, i.e. all timestamps below are minutes old):

- **Every job kind succeeded recently**: committee.* lifecycle (~281–282 each,
  last 01:52), regime.classify 7× (last success 01:07), research.refresh 8×
  (last 01:37), projects.refresh_coins 6× (01:10), projects.fetch_vaults /
  refresh_wallets / snapshot_daily / sync_revenue 1× each (00:20–01:50),
  vault.sample_* 7× (01:00), wallet.sample_* 7× (01:03), buybacks.refresh 1× (00:15).
- **Only failures: 5 × committee.send_activation_notification, status=dead**,
  last_error: `missing required env var: COMMITTEE_NOTIFICATION_EMAIL_TRANSPORT_URL`
  (that env var is deliberately empty in this demo stack). No pending/running/failed backlog.
- `job_runs` last-success-per-kind matches (18 kinds, all succeeded within the
  last ~2h except the notification kind which has never succeeded).

## 4. Worker logs

worker-analytics (repeating cycle, every run):

```
[extract] fetch summary:
  ok       DXY            rows=  4123 last=2026-07-24
  ok       ICSA           rows=   865 last=2026-07-25
  ... (all 27 indicators "ok") ...
[analytics] regime asof 2026-07-31: composite=0.48429755042100253 regime=neutral (3000 rows)
[analytics] telemetry submission reported failure: telemetry POST /api/analytics/telemetry failed: HTTP 400 — {"error":"run.jobId must be an integer or null"}
[analytics] floor seed: no-op — floor already warm (72485 rows present)
```

Degradation events (loud, non-fatal, by design):

```
[geckoterminal] new_pools page 6: HTTP 429 — retrying in 0ms (attempt 1/5)
[geckoterminal] new_pools page 6 failed (… retry budget exhausted, degrading to last-persisted NEW_TOKENS) — partial 24h count from 5 page(s)
buyback-logs: BUYBACK_FROM_BLOCK is unset/0 — the live indexer will crawl from block 0 …
```

research_pipeline_warnings (1 row): `XLU_SPY: fetch returned 0 rows — using
persisted 7910 rows (real floor, no synthetic fallback)` (2026-07-30 22:00).

worker-research: `[edgar] MNA refresh: planned=2 new=0 revised=2 fetched=2
missing=0 rejected=0 status=updated` on every cycle, each followed by the same
**telemetry HTTP 400** line.

worker-committee: only the 5×5 retry/DEAD lines for
committee.send_activation_notification (missing transport URL). No auth
failures against /api/analytics/* anywhere; no other fetch failures.

### Telemetry 400 root cause (real bug, code evidence)

- `backend/src/api/routes/analytics.ts:254` —
  `if (v.jobId != null && (typeof v.jobId !== "number" || !Number.isInteger(v.jobId))) return invalid("run.jobId must be an integer or null");`
- `backend/src/worker/loop.ts:112` — `const output = await handler(job.payload, job.id);`
  and `job.id` comes from postgres.js (`backend/src/db/client.ts` — no custom
  type parsers), which returns `jobs.id BIGINT` as a **JS string**. So every
  worker-lane run submits `jobId: "1234"` → 400 → run never persisted.
- Consequence visible in data: `research_pipeline_runs` holds ONLY the 284
  producer-rail runs (submitted with `jobId` unset → null → passes validation);
  **zero worker-lane runs are recorded** despite 15 successful
  regime.classify/research.refresh jobs. Submission is best-effort
  (`submitTelemetrySafely`), so canonical rows still land — only the telemetry
  lineage is lost, and the admin research-runs surface under-reports.

## 5. API spot-checks (localhost:48787)

- `GET /api/dashboards/regime-snapshots?range=30` →
  `latest.date = "2026-12-19"`, `history = 2026-11-20 … 2026-12-19` (30 rows),
  `staleness = {asof: 2026-12-19, serverDate: 2026-07-31, ageDays: -141, stale: false}`.
  **The entire served window is future-dated**; the real 2026-07-31 snapshot is
  ~141 rows deep and invisible at any range ≤ ~141. The staleness guard passes
  because ageDays is negative (future is "not stale").
  Cause: `backend/src/analytics/report/projections.ts` fetchRegimeSnapshots does
  `ORDER BY date DESC LIMIT ${range}` with no `date <= current_date` bound.
- `GET /api/projects` → 11 projects, full facets (agent/x402/coin/wallet/vault),
  dataCoverageScore populated. Matches DB.
- `GET /api/dashboards/research-signals/channel-divergence` and
  `/late-cycle-signals` → both return date 2026-07-31 payloads. Matches DB.
- `GET /api/dashboards/vault-economics|wallet-balances|buybacks|token-metrics|allocation`
  → all 200 with non-trivial bodies (739b / 15,803b / 2,043b / 269b / 1,039b).
- `GET /api/committee/open-session` → live session, `date: "2026-12-20"` (future).
- Caching: `/` and `/regime` → `Cache-Control: no-cache` (per commit 5b9245d);
  static JS → `public, max-age=300`; API JSON → no cache-control header. **No
  staleness/cache mismatch** — API reflects DB exactly.

Frontend fetch wiring (`frontend/public/assets/js/app/alpine/views/`):
`regime.js:42` fetches `regime-snapshots` with `{range: 4000}` (gets everything,
so its "latest/asof" badge shows 2026-12-19); `projects.js:22` → `/api/projects`;
`research.js:16` → `/api/dashboards/research-signals/:key`. Views fetch the
right URLs; they render what the API serves.

## 6. Reconciliation / verdict inputs

**SOURCE — not missing.** All 27 indicators fetch "ok" live (FRED, market,
DeFiLlama, EDGAR, geckoterminal); worst lag 7d (DXY) / 6d (ICSA weekly). MNA is
monthly by design.

**STORE — not missing, but POLLUTED.** raw_indicator_history and
research_signals are complete and fresh. regime_snapshots contains ~140
(growing +1/session) future-dated rows. Mechanism (code evidence):

- `scripts/lib/demo-schedule.ts:194` —
  `sessionDateFor(nowMs, runs) = new Date(nowMs + runs*86_400_000)…` — each
  successive demo committee session gets a virtual date one day further in the
  future. Comment at :192: "the 2027-dated-session question belongs to
  **issue #345**" (known/tracked).
- `scripts/lib/committee/session.ts:294-297` — every session with
  sessionIndex>0 calls `runRegimeClassify(date, rail)` which launches the
  analytics-producer container (`bun run src/producer/index.ts regime <asof>`)
  with the **future session date as asof**; the producer submits real computed
  snapshots stamped with that future date through the authenticated analytics
  boundary into the SAME regime_snapshots table the real pipeline owns.
  284 sessions (2026-07-30 → 2026-12-20) ⇒ 284 producer runs ⇒ future rows.
- The stack runs the FAST demo cadence (~1 session/76s across 2 subjects; 282
  sessions in 6h), not the `--stage` realistic cadence added in commit 06b260f
  ("committee sessions every 6h under --stage") — this stack predates/ignores
  that flag, which is why 5 months of virtual dates accumulated in 6 hours.

**API — serves the store faithfully**, and that is exactly the problem:
`fetchRegimeSnapshots` picks newest-N by date, so the future synthetic rows
shadow the real current data on every regime/performance surface with a bounded
range, and the "latest" regime shown is a Dec-2026 synthetic neutral reading.
Secondary API-boundary defect: telemetry jobId string-vs-integer 400 (see §4)
empties the worker-run telemetry lineage.

**UI — renders what it is served.** Correct URLs, no client-side filtering bug
found; cache headers sane.

**Demo-synthetic by design?** Partially: RM_ENV=demo + DEMO_MODE=1, demo member
roster, seeded subject fixtures, and future-dated sessions are demo-by-design
(issue #345 known). But the indicator/analytics data itself is genuinely
live-fetched (`ANALYTICS_SOURCE=live`, live fetch logs, real FRED/EDGAR/DeFi
series) — the pipeline is neither corrupt nor faked. The "missing data" is real
current data being displaced in newest-N windows by demo-cadence future rows,
plus the telemetry-run surface being empty due to the jobId type bug.

## Appendix — queries run (all SELECT-only)

1. `SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN (…)`
2. counts/min/max over raw_indicator_history, regime_snapshots, research_signals
3. per-indicator `GROUP BY indicator` freshness (full table in §2)
4. `regime_snapshots WHERE date > '2026-07-25'` sample; `GROUP BY version`; `WHERE date > CURRENT_DATE` count
5. `regime_indicators` full select (0 rows) + `\d`
6. counts/latest over projects, committee_*, research_pipeline_*, analytics_*, jobs, job_runs
7. `jobs GROUP BY kind, status`; non-succeeded jobs with last_error
8. `job_runs GROUP BY kind` last success
9. `research_pipeline_runs GROUP BY kind, source`; job_id null/with counts; stage count
10. `committee_sessions` min/max/count and per-date tail
11. support-table census (§2 last table)
