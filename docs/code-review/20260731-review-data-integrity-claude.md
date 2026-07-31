# Data-Integrity Review Report (2026-07-31)

**Repository:** `git@github.com:robotmoney/robotmoney-frontend.git`  
**Branch:** `adhoc/20260731-014957-data-integrity-review`  
**Commit:** `06b260f000e5ce5ac356e93da70727a0340bcae8`  
**Review Type:** `review-data-integrity`  
**Reviewed Date:** 2026-07-31  

---

## 1. Executive Summary & Verdict

### Overall Verdict
- **Analytics Pipeline is Live and Honest**: All 27 indicators fetch real market/onchain/macro data live over a vendored real floor. `seededProvider` is provably unreachable on the live path. However, analytics can silently freeze behind forward-fill without triggering staleness warnings.
- **Projects Live Path Serves Metric Literals (CRITICAL)**: `liveProjectsDataSource.discoverProjects()` returns hardcoded dataset metric literals ($15,000/day x402 volume, fixed productivity scores, synthetic addresses) even when `PROJECTS_SOURCE=live`. Daily job chains compound this literal into `agent_revenue_daily`, fabricating ~$450,000 in 30-day revenue that never existed.
- **Stage Missing-Data Root Cause Identified (Issue #345 Resolved)**: On stage (`rm_demo_stack_d2b89936a0`), ~140 future-dated demo-session regime snapshots shadow all real current rows in every newest-N projection window (e.g. `range=30`). Genuine 2026-07-31 data sits ~141 rows deep while the UI displays Dec-2026 future neutral readings.
- **Worker Telemetry Drop**: A type-mismatch bug (`jobId` string vs integer validation) causes all worker-lane telemetry submissions to fail with HTTP 400, leaving worker lineage unrecorded.

---

## 2. Scope & Methodology

### 2.1 Audit Scope
1. `backend/src/analytics/**` (extract, transform, store, report, index)
2. `backend/src/projects/**` (access, fixtures, transforms, projections, demo-seed)
3. `backend/src/worker/handlers/**` and samplers
4. `backend/src/api/routes/analytics.ts` and dashboard projection read paths
5. Frontend regime/performance/research/projects/committee views
6. Live demo stack runtime evidence (`rm_demo_stack_d2b89936a0`, `stage.robotmoney-labs.dev` origin)

### 2.2 Methodology
The audit combined static AST/import-graph inspection, behavioral spy testing, contract verification against schemas/migrations, and runtime SELECT-only PostgreSQL & API spot-checks on the live demo/stage stack. Three concurrent worker streams analyzed:
- **W1**: Analytics pipeline lineage, keyless sources, and degradation paths (`docs/code-review/20260731-review-data-integrity-evidence/di-w1-analytics.md`)
- **W2**: Projects pipeline, samplers, static/fixture data, and coverage scoring (`docs/code-review/20260731-review-data-integrity-evidence/di-w2-projects.md`)
- **W3**: Stage runtime census, job health, worker logs, and DB state (`docs/code-review/20260731-review-data-integrity-evidence/di-w3-runtime.md`)

---

## 3. Scope Questions & Invariant Verdicts

1. **Is fixture data reachable on a live path?**
   - **Analytics**: NO. `seededProvider` is provably unreachable on the live path (`prod-honesty.test.ts`).
   - **Projects**: YES (CRITICAL). `live-source.ts:69-71` returns `DISCOVERY_DATASET` (carrying metric literals) on the live path, causing fabricated x402 revenue compounding.
2. **Does the frontend serve baked data as live?**
   - NO. `/public/data/committee` is used API-first with labeled, date-bounded archive fallback. Dead unread `briefs/today` files exist but are not rendered.
3. **Are project sparklines real history or client-side mock?**
   - Real sampled history from `daily_coin_snapshots`. However, corrupted by sentinel zeros when unrefreshed (DI-012).
4. **Do samplers synthesize values in demo mode?**
   - NO. Base RPC and price samplers fetch real chain state; demo mode only reduces sampling frequency.

---

## 4. Findings Summary Table

| ID | Classification | Severity | Owner | Summary |
|---|---|---|---|---|
| `review-data-integrity-001` | `DATA_INTEGRITY_PROVENANCE` | High | Code | No source column on raw/regime tables; `mergeSeries` overwrite permanent on contamination. |
| `review-data-integrity-002` | `DATA_INTEGRITY_PROVENANCE` | Low | Code | Stale comments claiming demo is seeded & regime composite methodology mismatch in UI. |
| `review-data-integrity-003` | `DATA_INTEGRITY_MISSING_DATA` | Low | Data | Vendored floor missing `BTC_MVRV` rows; relies entirely on live Coinmetrics fetch on cold boot. |
| `review-data-integrity-004` | `DATA_INTEGRITY_SILENT_DEGRADATION` | Medium | Code | Fetch failures degrade silently to persisted floor with no public UI indication or weight decay. |
| `review-data-integrity-005` | `DATA_INTEGRITY_FAKED_DATA` | Medium | Code | `ANALYTICS_SOURCE=hermetic` env knob reachable without UI provenance badge (not active on stage). |
| `review-data-integrity-006` | `DATA_INTEGRITY_STALE_READ` | High | Code | Staleness check only verifies producer run date; forward-filled dead indicators mask freeze. |
| `review-data-integrity-007` | `DATA_INTEGRITY_STALE_READ` | Medium | Code | Research signals lack staleness metadata and signal dates are hidden/absent in research UI. |
| `review-data-integrity-008` | `DATA_INTEGRITY_PROVENANCE` | High | Code | **Stage root cause**: Demo virtual-date committee sessions write future snapshots, shadowing real rows. |
| `review-data-integrity-009` | `DATA_INTEGRITY_MISSING_DATA` | Medium | Code | Worker-lane telemetry POSTs fail HTTP 400 due to string `jobId` from postgres.js. |
| `review-data-integrity-010` | `DATA_INTEGRITY_DERIVED_STATE_CLOBBER` | High | Code | Scheduled project jobs run in demo, recalculating incomplete scores & hiding projects below score 55. |
| `review-data-integrity-011` | `DATA_INTEGRITY_FAKED_DATA` | Critical | Code | **Prod path defect**: Live projects discover serves fixture metric literals ($15k/day x402 revenue). |
| `review-data-integrity-012` | `DATA_INTEGRITY_SENTINEL_ZERO` | Medium | Code | Unrefreshed coins/wallets/vaults coerced to 0 in snapshots, causing sparkline zero-plunges. |
| `review-data-integrity-013` | `DATA_INTEGRITY_FAIL_TOGETHER_STALENESS` | Medium | Code | Single bad fixture address throwing in project refresh fails the entire batch. |
| `review-data-integrity-014` | `DATA_INTEGRITY_MISSING_WRITER` | Medium | Code | Coverage scoring checks `cumulative_revenue_usd` & `yield_apy` which have zero backend writers. |
| `review-data-integrity-015` | `TEST_COVERAGE_MISSING` | Medium | Tests | Missing `prod-honesty` guard for projects pipeline equivalent to analytics. |

---

## 5. Detailed Findings

### review-data-integrity-001 (DATA_INTEGRITY_PROVENANCE)
- **Severity**: High | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/migrations/0009_analytics_v2.sql:29-36`, `backend/src/analytics/transform/math.ts:336-341`, `backend/src/analytics/store/raw-history-store.ts:59-61`
- **Impact**: Neither `raw_indicator_history` nor `regime_snapshots` store a source/provenance column. `mergeSeries` is fetched-wins on overlap and upserts via `ON CONFLICT DO UPDATE`. Running with `ANALYTICS_SOURCE=hermetic` against a live DB overwrites ~3.1k real rows permanently.
- **Recommendation**: Add a `source` (`live|seed|hermetic`) column; refuse `hermetic` submissions outside ephemeral environments.

### review-data-integrity-002 (DATA_INTEGRITY_PROVENANCE)
- **Severity**: Low | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/analytics/access/hermetic-source.ts:3-9`, `scripts/lib/demo-env.ts:5-10`, `frontend/public/views/regime.html:248`
- **Impact**: Stale code comments state that demo mode forbids live fetches (retired design). `regime.html` claims composite is a 3-panel mean, whereas code computes a 2-panel mean (`PANELS = ["macro", "onchain"]`).
- **Recommendation**: Update stale comments to reflect live-only demo reality; fix composite description in `regime.html`.

### review-data-integrity-003 (DATA_INTEGRITY_MISSING_DATA)
- **Severity**: Low | **Confidence**: High | **Owner**: Data
- **Evidence**: `backend/src/analytics/extract/floor-seed.ts:18-21`, `backend/tests/fixtures/regime/raw-indicator-history.csv.gz`
- **Impact**: The vendored cold-boot floor lacks `BTC_MVRV` rows entirely (fixture predates Coinmetrics repoint). On cold boot without network access, `BTC_MVRV` is excluded with weight 0 without explicit notice.
- **Recommendation**: Regenerate vendored floor gzip to include `BTC_MVRV`.

### review-data-integrity-004 (DATA_INTEGRITY_SILENT_DEGRADATION)
- **Severity**: Medium | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/analytics/extract/sources.ts:96-118`, `backend/src/analytics/index.ts:167-190`, `backend/src/analytics/transform/math.ts:206-211`
- **Impact**: Failed indicator fetches degrade to the persisted floor with stdout logging only. Forward-fill carries last values indefinitely without decaying indicator weight or alerting public UI.
- **Recommendation**: Alert on degraded telemetry; cap forward-fill contribution or decay weights over time.

### review-data-integrity-005 (DATA_INTEGRITY_FAKED_DATA)
- **Severity**: Medium | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/analytics/index.ts:69-76`, `scripts/lib/demo-env.ts:63`, `docker-compose.yml:209`
- **Impact**: `ANALYTICS_SOURCE=hermetic` allows serving synthetic LCG walks if explicitly set in shell env. Unset defaults safely to `live`.
- **Recommendation**: Expose `source` in API DTOs and show a UI badge if non-live.

### review-data-integrity-006 (DATA_INTEGRITY_STALE_READ)
- **Severity**: High | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/analytics/index.ts:199-207`, `backend/src/analytics/report/regime-projection.ts:121-133`
- **Impact**: The regime staleness banner checks producer run date, not underlying data freshness. Because runs forward-fill to `today`, the UI appears fresh even if upstream data fetchers fail completely.
- **Recommendation**: Extend staleness checking to `max(raw_date)` per panel and highlight stale raw dates.

### review-data-integrity-007 (DATA_INTEGRITY_STALE_READ)
- **Severity**: Medium | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/analytics/report/projections.ts:12-18`, `frontend/public/assets/js/app/alpine/views/research.js:14-24`
- **Impact**: Research signal endpoints omit staleness metadata. UI does not highlight signal date or display `asof` on late-cycle views.
- **Recommendation**: Add staleness DTO to research signal endpoint and display data dates in UI.

### review-data-integrity-008 (DATA_INTEGRITY_PROVENANCE)
- **Severity**: High | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/analytics/report/projections.ts:25-37`, `scripts/lib/committee/session.ts:294-297`, `runtime (rm_demo_stack_d2b89936a0)`
- **Impact**: **Root Cause of Stage Missing Data**: Demo virtual-date committee sessions write future-dated regime snapshots into `regime_snapshots` (140+ future rows). `fetchRegimeSnapshots` orders by `date DESC LIMIT N` without `date <= CURRENT_DATE`, causing newest-N queries to return future synthetic neutral readings and hide current 2026-07-31 data.
- **Recommendation**: Filter `fetchRegimeSnapshots` with `date <= CURRENT_DATE`; isolate demo session snapshot writes from shared production/stage tables; clean future rows from stage DB.

### review-data-integrity-009 (DATA_INTEGRITY_MISSING_DATA)
- **Severity**: Medium | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/api/routes/analytics.ts:254`, `backend/src/worker/loop.ts:112`
- **Impact**: `postgres.js` returns `job.id` as a string, but `analytics.ts` validates `jobId` as an integer. All worker-lane telemetry POSTs fail with HTTP 400, losing worker telemetry lineage in `research_pipeline_runs`.
- **Recommendation**: Coerce `jobId` string to integer at API boundary or parse `job.id` as number.

### review-data-integrity-010 (DATA_INTEGRITY_DERIVED_STATE_CLOBBER)
- **Severity**: High | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/db/seed.ts:73-79`, `backend/src/worker/handlers/projects.ts:330-397`, `backend/src/projects/projections.ts:13,35`
- **Impact**: `projects.*` cron schedules run in demo mode. Unscoped `recompute_coverage` calculates scores based on missing fields, dropping projects below score 55 and hiding them from `/projects`. Slug collisions with `dataset.ts` overwrite logos with broken `cdn.example` URLs.
- **Recommendation**: Disable `projects.*` worker schedules under `DEMO_SEED_PROJECTS` / `DEMO_MODE`; populate missing coverage fields in demo seed.

### review-data-integrity-011 (DATA_INTEGRITY_FAKED_DATA)
- **Severity**: Critical | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/projects/access/live-source.ts:69-71`, `backend/src/projects/fixtures/dataset.ts:26-32`, `backend/src/worker/handlers/projects.ts:81-93,218-228`
- **Impact**: **Critical Prod Defect**: `liveProjectsDataSource.discoverProjects()` returns fixture literals ($15k/day x402 volume, synthetic addresses) even on live path. `sync_revenue` rolls this into `agent_revenue_daily`, fabricating ~$450k 30-day revenue on prod UI.
- **Recommendation**: Strip metric literals from `live-source.ts` discovery; serve identity-only or real fetched metrics; purge fixture-originated revenue rows in DB.

### review-data-integrity-012 (DATA_INTEGRITY_SENTINEL_ZERO)
- **Severity**: Medium | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/projects/transforms.ts:174-185`, `backend/src/worker/handlers/projects.ts:257-262`
- **Impact**: Unrefreshed coins/wallets/vaults coerce `null` to `0` in daily snapshots, causing sparklines to show zero-plunges and improperly boosting activity coverage.
- **Recommendation**: Skip snapshot row insertion when underlying price/balance is NULL instead of coercing to 0.

### review-data-integrity-013 (DATA_INTEGRITY_FAIL_TOGETHER_STALENESS)
- **Severity**: Medium | **Confidence**: Medium | **Owner**: Code
- **Evidence**: `backend/src/worker/handlers/projects.ts:136-153`
- **Impact**: Single batch try-catch block causes an entire coin refresh to fail and discard fetched data if one bad fixture address throws HTTP 4xx.
- **Recommendation**: Handle errors per item rather than failing the whole batch.

### review-data-integrity-014 (DATA_INTEGRITY_MISSING_WRITER)
- **Severity**: Medium | **Confidence**: High | **Owner**: Code
- **Evidence**: `backend/src/worker/handlers/projects.ts:341,351`, `backend/migrations/0014_projects_pipelines.sql:33,52`
- **Impact**: Coverage score evaluates `cumulative_revenue_usd` and `yield_apy`, but no backend code writes to these columns. `walletBalanceUsd` live fetch is un-implemented, rendering $0 balance.
- **Recommendation**: Implement writers or exclude unpopulated fields from coverage scoring.

### review-data-integrity-015 (TEST_COVERAGE_MISSING)
- **Severity**: Medium | **Confidence**: High | **Owner**: Tests
- **Evidence**: `backend/tests/prod-honesty.test.ts:27-123`, `backend/src/projects/access/live-source.ts:16`
- **Impact**: `prod-honesty.test.ts` protects analytics from importing seeded providers, but no equivalent guard exists for projects, allowing DI-011 to go undetected.
- **Recommendation**: Add a `prod-honesty` test for the projects pipeline ensuring live source serves no fixture metric literals.

---

## 6. Clean Areas & Validated Correct Behaviors

- **Ingestion Boundary**: Strict validation before DB write; non-finite numbers rejected; single-transaction writes; idempotent natural keys (`backend/src/api/routes/analytics.ts:49-94,332-390`).
- **Analytics Live Path Honesty**: `seededProvider` unreachability proven statically & behaviorally (`backend/tests/prod-honesty.test.ts`).
- **Cold Boot Ground Truth**: Vendored floor is real historical data (verified against VIX & T10Y2Y market facts).
- **Committee & Research UI**: API-first with labeled archive fallback; no frontend baked data presented as live.
- **Sparklines**: Real sampled daily snapshot history, not client-side mocks.
- **Caching**: API JSON uncached, SPA shell uncached, static assets max-age=300 (post commit `5b9245d`).

---

## 7. Action Plan & Recommendations

1. **Fix Stage Missing Data (DI-008)**:
   - Add `WHERE date <= CURRENT_DATE` to `fetchRegimeSnapshots` in `projections.ts`.
   - Delete future-dated rows (`date > CURRENT_DATE`) from `regime_snapshots` on stage.
   - Stop demo virtual-date sessions from inserting snapshots into production regime tables.
2. **Fix Prod Fabricated Revenue (DI-011)**:
   - Modify `live-source.ts` to return identity-only discovery without fixture metric literals.
   - Delete `agent_revenue_daily` rows generated from $15,000/day fixture literals.
3. **Fix Telemetry Worker 400 (DI-009)**:
   - Parse `jobId` as an integer in `analytics.ts` endpoint validation.
4. **Fix Sentinel Zeros & Sparkline Plunges (DI-012)**:
   - Don't coerce `null` to `0` in snapshot handlers.
5. **Add Prod Honesty Test for Projects (DI-015)**:
   - Create AST & behavioral tests ensuring live project paths don't import dataset literals.

---

## 8. Limitations & Unreviewed Surfaces

- **Runtime Evidence**: Inspected `rm_demo_stack_d2b89936a0` (stage.robotmoney-labs.dev) via SELECT-only DB queries. Prod DB was not accessed.
- **Unreviewed Surfaces**: Buyback indexer logic, committee state machine details, wallet RPC numeric precision, and UI pages outside regime/research/projects/committee.
