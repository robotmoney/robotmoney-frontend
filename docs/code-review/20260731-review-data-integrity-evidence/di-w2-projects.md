# Data-integrity review W2 — Projects pipeline, samplers, static/fixture data

Worktree: `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260731-014957-data-integrity-review` @ 06b260f0.
All paths below are relative to that worktree unless absolute.

## 1. Lineage map (authoritative write → derived read)

### Projects pipeline
- **Source selection** — `backend/src/projects/access/select.ts:13-30`. Fixture source is default; `PROJECTS_SOURCE=live` opts into live; `RM_ENV=ephemeral` is force-fixture; `RM_ENV=prod` without the flag **throws** ("refusing to serve fixture data as production"). [Observed]
- **Fixture source** — `access/fixture-source.ts` serves `fixtures/dataset.ts` verbatim (deep-cloned). Test/demo/CI only by selection. [Observed]
- **Live source** — `access/live-source.ts`: CoinGecko `/coins/markets` (:73-82), DexScreener `/tokens` (:84-88), Base RPC ERC-4626 (:90-98). **But `discoverProjects()` (:69-71) returns `structuredClone(DISCOVERY_DATASET)` — the fixture file — even in live mode.** [Observed]
- **Writes** — `backend/src/worker/handlers/projects.ts`:
  - `projects.discover` (:51-121) upserts `projects` (on `slug`), `openclaw_agents` (on `(project_id,name)`), `lobster_coins` (on `(project_id,name)`), `tracked_wallets` (on `(project_id,label)`), `agent_vaults` (on `(project_id,name)`). Uniqueness keys exist: `backend/migrations/0013_projects.sql:18`, `0014_projects_pipelines.sql:74-77`.
  - `projects.refresh_coins` (:124-164) → `lobster_coins.price_usd/market_cap/fdv/volume_24h`.
  - `projects.refresh_wallets` (:167-191) → `tracked_wallets.balance_usd/last_tx_at`.
  - `projects.sync_revenue` (:194-229) → `agent_revenue_daily` (unique `(agent_id,revenue_date,source)`, 0013:100). x402 leg rolls up **already-persisted** `daily_agent_snapshots.x402_volume_usd`.
  - `projects.snapshot_daily` (:234-290) → `daily_coin_snapshots`/`daily_agent_snapshots`/`daily_wallet_snapshots`/`daily_tvl_snapshots` (unique `(entity_id,snapshot_date)`, 0013:112, 0014:90/101/112).
  - `projects.fetch_vaults` (:293-323) → `agent_vaults.tvl_usd` + `daily_tvl_snapshots`.
  - `projects.recompute_coverage` (:330-397) → `projects.data_coverage_score` + four sub-scores, from facet columns + snapshot-history counts.
  - Failure semantics: extract-before-write, degrade-to-persisted with loud log (:44-48). [Observed]
- **Schedules** — `backend/src/db/seed.ts:73-79`: discover 02:00, refresh_coins :10 hourly, refresh_wallets/fetch_vaults 6-hourly, snapshot_daily 00:40, sync_revenue 01:50, recompute_coverage 03:00 — `enabled: true` in **every** environment including demo. [Observed]
- **Read path** — `GET /api/projects` (`backend/src/api/routes/projects.ts:15-17`) → `backend/src/projects/projections.ts:30-198`: MIN_SCORE=55 gate (:13,:35), facets, `revenue30d` from `agent_revenue_daily` (:56-59,:126-131), 30d sparkline from `daily_coin_snapshots` ordered by date (:61-65,:133-137). Frontend `frontend/public/assets/js/app/alpine/views/projects.js` renders the DTO; `sparkSvg` (:117-131) draws exactly the API values — **the #295 sparkline is real sampled history, nothing synthesized client-side**. [Observed]
- **Demo seed** — `backend/src/projects/demo-seed.ts`, invoked only when `DEMO_SEED_PROJECTS=1` (`backend/src/db/seed.ts:293-295`), set only by `scripts/lib/demo-main.ts:1278`. Deterministic sine-wiggle values, clearly demo-bounded at seed time. [Observed]

### Samplers (non-analytics)
- `wallet.sample_balances` / `wallet.sample_sleeves` / `vault.sample_share_price` / `vault.sample_adapters` (`backend/src/worker/handlers/index.ts:30-35`) sample the **real** Base chain + keyless prices on worker schedule; per-row provenance `live|stub|stale|seed` (docs/architecture.md §10.1, ~:1214-1241). Demo mode (#210) only changes **cadence** (hourly rows `seed.ts:117-120`, per-minute baseline disabled under DEMO_MODE) — it does **not** synthesize values. `BASE_RPC_SOURCE`/`PRICE_SOURCE=stub` are explicit env opt-ins with fail-closed resolution (`backend/src/config.ts`), not silently reachable. [Observed]

### Committee / static data
- `frontend/public/data/committee/**` is the only baked data dir under `frontend/public`. Served by `backend/src/api/static.ts:44` with `Cache-Control: public, max-age=300` (post-5b9245d; shell no-cache :4). [Observed]
- Committee UI (`frontend/public/assets/js/app/alpine/static-views.js`) is **API-first, archive-fallback**: archive used only for sessions dated `< "2026-07-01"` (`archivePreferred` :37-39) or when the API is unreachable (:866-894, :1233-1238), sets `this.source = "archive"`, and `session.html:308` gates permalink receipts on `source === 'api'`. DB (via `backend/src/committee` stores) is authoritative for everything current. [Observed]
- `frontend/public/data/committee/briefs/today/*.json` is referenced by **no JS**; only `frontend/public/views/docs/investment-committee/how-it-works.html:107` claims it is the render path. Stale doc / dead baked files, not a live-data lie in the UI. [Observed]
- Blog pages carry baked numbers with `asof` labels; `views/blog/regime-conservative-aggressive.html:3` claims render-time compute from `public/data/regime-snapshot.json`, which does not exist — stale comment only. [Observed]

## 2. Findings

### DI-W2-001 — DATA_INTEGRITY_FAKED_DATA — fixture metrics on the PROD live path (fabricated x402 revenue)
- **Severity: CRITICAL. Confidence: high** (code path observed; whether prod currently runs `PROJECTS_SOURCE=live` is deployment state, but `.env.example`, `docs/runbooks/deployment.md` and `docker-compose.yml:128-130` mandate it — the pipelines throw otherwise).
- **Evidence:** `live-source.ts:69-71` serves `DISCOVERY_DATASET` from `fixtures/dataset.ts` in live mode. That dataset is not identity-only: it carries **metric literals** — `x402_score: 98, x402_txn_count: 128_400, x402_resources_count: 42, x402_volume_usd: 15_000, productivity_score: 72/80/88, source_confidence: "high"` (`dataset.ts:26-32, 58-65, 79-94`) and synthetic addresses (`0xgame000…coin`, `0xvault000…aaa`, `0xwallet000…`). `discover` upserts all of it (`handlers/projects.ts:81-93`) with `enriched_at = now()`.
- **Corrupting sequence (minimal, prod):**
  1. Deploy with `PROJECTS_SOURCE=live`.
  2. 02:00 `projects.discover` → `openclaw_agents.x402_volume_usd = 15000` (fixture literal), `source_confidence='high'`, `enriched_at=now()`.
  3. 00:40 `projects.snapshot_daily` → `daily_agent_snapshots.x402_volume_usd = 15000` (handlers/projects.ts:254-268).
  4. 01:50 `projects.sync_revenue` → `agent_revenue_daily (source='x402', revenue_usd=15000)` for every snapshot day (:218-228). Repeats daily, forever, flat.
  5. `GET /api/projects` → `revenue30d ≈ $450,000` and an "X402" facet pill (`projections.ts:109-115, 126-131, 179`) rendered as live data.
- **Impact:** prod UI presents a hardcoded literal as live revenue/metrics; growth of `agent_revenue_daily` fabricates a time series that never existed. Directly contradicts the stated invariant "nothing fabricated on the prod path" (`select.ts:21-23`) and "Nothing on the path is fabricated" (`handlers/projects.ts:16`). Also seeds unresolvable synthetic addresses into prod facet tables (feeds DI-W2-005).
- **Authoritative state / repair:** delete `agent_revenue_daily` rows with `source='x402'` whose agents' `x402_volume_usd` equals the dataset literals; null the metric columns (`x402_*`, `productivity_score`, `source_confidence`, `enriched_at`) on agents originating from `dataset.ts`; delete `daily_agent_snapshots` rows carrying the literal. Fix: live `discoverProjects()` must serve identity + facet keys **only** (strip metric fields from `DiscoveredAgent` on the live path, or split the roster into identity-only seed vs test-only metrics), until a real x402 metrics fetcher exists.

### DI-W2-002 — DATA_INTEGRITY_DERIVED_STATE_CLOBBER — scheduled jobs overwrite the demo-seeded directory; projects vanish below MIN_SCORE
- **Severity: HIGH (likely the reported "expected data missing from the UI" on the standing demo/stage). Confidence: high on mechanism (observed), medium on exact per-project scores (computed by hand, inference).**
- **Evidence:** the `projects.*` schedules are enabled in demo too (`seed.ts:73-79`; nothing in `FAST_DEMO_SCHEDULES`/`SLOW_DEMO_SAMPLER_SCHEDULES` disables them). The seed comment claims only that "a **short** demo run never races DEMO_SEED_PROJECTS" (`seed.ts:66-69`) — the standing stage demo runs for days, so 02:00/03:00 jobs fire.
  - `projects.recompute_coverage` runs **unscoped** and overwrites `data_coverage_score` for ALL projects (`handlers/projects.ts:330-397`) from facet columns the demo seed never populates: no `price_usd`, `coingecko_id`, `contract_address` on coins (`demo-seed.ts:363-366`), no `address`/`last_tx_at` on wallets (:378-380), no `tvl_usd`/`yield_apy`/`vault_address` on vaults (:385), no `cumulative_revenue_usd`/`enriched_at` on agents (:345-349). Seeded scores 58–95 (`demo-seed.ts:83-277`) are replaced by recomputed scores; hand-computation puts luna (~54), ai16z (~54), x402rs (~54), degenspartan (~54) and — in the first week, before 7-day snapshot history accrues — bankr (~53) and olas below the `MIN_SCORE = 55` gate (`projections.ts:13,35`). Those rows silently disappear from `/projects`.
  - `projects.discover` (fixture source in demo — `PROJECTS_SOURCE` unset) upserts the 3 fixture slugs that **collide** with demo slugs (`virtuals-protocol`, `aixbt`, `coinbase-x402-facilitator`): overwrites description and sets `logo_url` to the fake `https://cdn.example/*.png` (`dataset.ts:23,56,77` via `handlers/projects.ts:74-77`) → broken logos in the demo UI; injects the fixture x402/productivity metrics into demo agents (same names → conflict-update), after which sync_revenue overwrites the seeded wiggled x402 revenue with flat 15000/day.
- **Corrupting sequence (minimal):** `bun demo` seed → let the stack pass 02:00 and 03:00 UTC → reload `/projects`.
- **Impact:** demo/stage directory shrinks (~11 → ~6-7 rows), remaining rows show clobbered scores, broken logo URLs, and flat fabricated revenue for the colliding slugs. Sparklines decay per DI-W2-003.
- **Authoritative state / repair:** re-running the demo seed restores identity rows and scores (until the next 03:00). Durable fix: under `DEMO_SEED_PROJECTS`/`DEMO_MODE` either disable the `projects.*` schedule rows (as done for other demo cadence rows, `seed.ts` FAST_DEMO pattern) or make the demo seed populate every column `recompute_coverage` reads; and remove the slug collision between `fixtures/dataset.ts` and `demo-seed.ts` (or make discover skip projects it did not create).
- **Test gap:** `backend/tests/api/projects-demo-seed.test.ts:28-32` asserts scores ≥55 **at seed time only**; no test executes seed → discover → recompute → fetchProjects.

### DI-W2-003 — DATA_INTEGRITY_SENTINEL_ZERO — snapshot_daily freezes NULL metrics as 0 into history tables
- **Severity: MEDIUM. Confidence: high (observed).**
- **Evidence:** `coinSnapshotRow` (`transforms.ts:174-185`) and the agent/wallet/vault snapshot mapping (`handlers/projects.ts:257-262, 274, 283`) coerce `Number(null) || 0` → 0 and write the row anyway. Any coin never refreshed (no `coingecko_id`/`contract_address`; DexScreener `skipped` below the $1k liquidity floor, `transforms.ts:80`; or refresh degraded) gets a **0-price snapshot appended daily**.
- **Impact:** the #295 sparkline (min/max normalized, `projects.js:117-131`) renders a plunge to zero — data that looks corrupt because it is; the fake rows also count toward the `h_coin/h_wallet` 7-row history bonus in coverage (`handlers/projects.ts:353-355`), i.e. fabricated zeros *raise* the "activity" evidence. On the standing demo every seeded coin except the 3 colliding slugs is in this state.
- **Repair:** delete snapshot rows where the underlying facet column was NULL at snapshot time (identifiable as `price_usd=0` runs); fix by skipping rows whose source column is NULL instead of coercing to 0.

### DI-W2-004 — DATA_INTEGRITY_MISSING_WRITER — coverage reads columns nothing writes; live wallet balances unimplemented
- **Severity: MEDIUM. Confidence: high (observed).**
- **Evidence:** `cumulative_revenue_usd` (read at `handlers/projects.ts:341`) and `yield_apy` (:351) exist in schema (`0014:33,52`) but have **zero writers** in `backend/src` — `agent_revenue_daily` is never rolled up into the cumulative column, so `revenueSignal` can only ever fire via `x402_txn_count` and `hasApy` is permanently false: systematic under-scoring of coverage (interacts with the MIN_SCORE cliff in DI-W2-002). Separately, `liveProjectsDataSource.walletBalanceUsd` **always throws** (`live-source.ts:100-105`, documented deferral) → in prod `tracked_wallets.balance_usd` stays NULL forever, and the projection renders `walletTotalUsd` as `0` (`projections.ts:147`, `?? 0`) — missing data presented as a zero balance.
- **Repair:** either write the columns (roll up `agent_revenue_daily`; port the Alchemy balance fetch) or stop scoring/rendering them as if populated (distinguish "unknown" from 0 in the DTO).

### DI-W2-005 — DATA_INTEGRITY_FAIL_TOGETHER_STALENESS — one bad address degrades a whole refresh run
- **Severity: MEDIUM (prod, contingent on DI-W2-001's synthetic addresses reaching prod). Confidence: medium (depends on provider behavior for garbage addresses — inference).**
- **Evidence:** `refresh_coins` extracts all coins in one try/catch (`handlers/projects.ts:136-153`); a thrown `dexscreener 4xx` for the synthetic `0xgame…coin` address discards the already-fetched CoinGecko updates and degrades the entire run — repeatably, every hour. Same fail-together shape in `refresh_wallets` (:175-183) and `fetch_vaults` (:303-311, where the synthetic `0xvault…aaa` cannot be a valid RPC target). If DexScreener instead returns `{pairs:null}` with 200, the coin is skipped harmlessly.
- **Impact:** prod coin prices/TVL may never populate while the handler reports "degraded" hourly — permanent staleness caused by fixture-seeded facet rows.
- **Repair:** per-item degrade (record per-coin status, persist successful updates); remove synthetic addresses from anything the live path can seed (subsumed by DI-W2-001's fix).

### DI-W2-006 — DATA_INTEGRITY_COVERAGE_GAP (test honesty) — no prod-honesty guard for the projects live path
- **Severity: MEDIUM. Confidence: high.**
- **Evidence:** `backend/tests/prod-honesty.test.ts` proves the **analytics** live import graph never reaches seeded data (static walk + behavioral spy). No equivalent exists for projects: `live-source.ts:16` imports `fixtures/dataset.ts` and no test objects — exactly the class of regression the analytics guard exists to catch, and it would fail today if ported. Otherwise the suite is honest: fidelity replay asserts transform === vendored legacy ground truth (`ground-truth.ts` header, tests/projects-pipelines-fidelity.test.ts), worker pipeline tests run against real ephemeral Postgres (worker-projects-pipelines.test.ts:1-7), hermeticity is tested (projects-hermeticity.test.ts), and the nightly live suite has a loud-skip + EXPECT_LIVE drift guard (projects-fetchers-live.test.ts:16-45) — no silent skips found in scope.
- **Repair:** add an import-graph/behavioral assertion that the projects live path serves no fixture-derived **values** (identity-only seed would need an explicit carve-out).

### Minor (no finding class)
- `frontend/public/data/committee/briefs/today/*` baked but unread; `how-it-works.html:107` documents it as the render path — stale doc.
- `views/blog/regime-conservative-aggressive.html:3` claims render-time compute from a nonexistent `public/data/regime-snapshot.json` — stale comment; page numbers are baked and dated.
- Cache interaction with 5b9245d: API JSON is uncached; static archive JSON gets `max-age=300` — worst case 5-minute-stale archive files, immaterial.

## 3. Verdicts on the four scope questions
1. **Is fixture data on a live path?** YES — `fixtures/dataset.ts` is imported and served by the **live** source's `discoverProjects()` (identity *and metric literals*), and its metrics compound into prod revenue history (DI-W2-001). `ground-truth.ts` itself is test-only (imported only by fidelity tests). The fixture source proper is correctly unreachable in prod (`select.ts` fail-closed) — confirmed.
2. **Frontend baked data as live?** No — only `/data/committee`, used API-first with a labeled, date-bounded archive fallback. Dead `briefs/today` files are the only wart.
3. **Sparkline** — computed from real `daily_coin_snapshots` history; corrupted by sentinel zeros (DI-W2-003), not synthesized.
4. **Demo samplers** — real chain/price sampling at reduced cadence; synthetic values are confined to `demo-seed.ts` behind `DEMO_SEED_PROJECTS` — but the scheduled pipeline then corrupts that seeded state on any standing demo (DI-W2-002).
