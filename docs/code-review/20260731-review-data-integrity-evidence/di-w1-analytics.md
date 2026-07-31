# Data-Integrity Review W1 — Analytics Pipeline (regime classifier + research signals)

Repo: robotmoney-frontend @ 06b260f0 (worktree adhoc-20260731-014957-data-integrity-review)
Scope: field-level lineage for the analytics pipeline; synthetic-data reachability; silent degradation/missing-data paths.
All paths below are relative to the worktree root unless absolute.

---

## 1. Lineage map (authority → UI)

### 1.1 Sources (extract) — all 26 indicators are REAL keyless fetchers

Registry: `backend/src/analytics/analyze/indicators.ts:31-462` — 26 entries (8 macro, 10 onchain, 8 factor;
factor is data-only, `PANELS = ["macro","onchain"]` at `indicators.ts:464`).

Dispatch: `backend/src/analytics/extract/sources.ts:59-91` (`fetchOne`) maps every `source` tag to a concrete
HTTP client. **Observed fact: none are stubbed, seeded, or hardcoded**:

| source tag | client | endpoint | evidence |
|---|---|---|---|
| fred | `extract/fred.ts:39-42` | fred.stlouisfed.org CSV, `cosd=2010-01-01` | real parser, "." → dropped |
| yahoo | `extract/yahoo.ts:44-54` | query2.finance.yahoo.com v8 chart | adjclose→close fallback, NaN dropped |
| defillama_tvl / _stables | `extract/defillama.ts:27-34` | api.llama.fi / stablecoins.llama.fi | non-finite dropped |
| blockchain_com | `extract/blockchain-com.ts:27-33` | api.blockchain.info charts | timespan=all |
| coinmetrics | `extract/coinmetrics.ts:38-55` | community-api.coinmetrics.io v4 | paginated (≤50 pages) |
| geckoterminal_newpools | `extract/geckoterminal.ts:162-193` | api.geckoterminal.com new_pools | single {today,count} point; bounded 429 retry; page-1 failure THROWS (no zero fabrication, :176-186) |
| shiller_cape | `extract/shiller.ts:122-148` | multpl.com scrape + datahub CSV, merged | throws only when BOTH fail |
| EDGAR (MNA, research-only) | `extract/edgar.ts`, `edgar-incremental-refresh.ts` | SEC EDGAR full-text search | incremental plan vs persisted floor, hard deadline |

Per-indicator failure semantics (verified in code, matching the index.ts claim):
- `sources.ts:96-118` (`fetchAll`): a throwing/empty fetcher → `[]` + `logger.error` + an `x EMPTY` line in the
  per-run fetch summary.
- `backend/src/analytics/index.ts:167-190`: `mergeSeries(prior, fetched)`; `fetched.length===0 && prior.length>0`
  → warn "using persisted N rows (real floor, no synthetic fallback)" + telemetry warning; `merged.length===0` →
  warn "NO history at all — excluded from composite (all-NaN → weight 0)" + telemetry warning; aggregate counts at
  :183-184; telemetry stage status flips to `warn` (:185-190).
- Exclusion mechanics confirmed: `transform/math.ts:201-247` `inverseCorrelationWeights` gives weight 0 below
  `minValidObs=60` finite obs; `rollingPercentileRank` (math.ts:176-195) emits NaN for all-NaN input.

**"Loud" is only as loud as container stdout + the telemetry table** — see finding DI-005.

### 1.2 Source selection — seededProvider reachability

- The ONE knob: `ANALYTICS_SOURCE` — `backend/src/analytics/index.ts:69-76` `resolveAnalyticsSource()`:
  unset/""/"live" → `liveDataSource`; "hermetic" → `hermeticDataSource`; anything else THROWS (fail-closed).
- `hermeticDataSource` (`access/hermetic-source.ts:37-79`) generates every series from
  `seededProvider.getSeries` — a deterministic LCG mean-reverting walk (`access/provider.ts:24-46`).
- Callers of the hermetic source outside tests: only `backend/src/demo/e2e.ts:92` (CI e2e driver, explicit
  parameter) and the env knob above.
- `analyze/tool.ts:59` (`Registry.run(..., provider = seededProvider)`) — **no non-test caller found in
  backend/src**; legacy hermetic-test scaffolding only.
- Guard tests: `backend/tests/prod-honesty.test.ts:27-123` prove (static) the live data-source import graph never
  references `seededProvider` and (behavioral spy) 0 calls on a live-path run; `tests/hermetic-source.test.ts:87-115`
  pins the knob semantics including the typo-refusal.

**Demo / stage stacks run LIVE data BY DESIGN (not synthetic):**
- `scripts/lib/demo-env.ts:1-23,63` — "Issue #147 removed DEMO_HERMETIC... every `bun run demo` invocation, local
  or CI, resolves live external providers"; `analyticsSource = env.ANALYTICS_SOURCE || "live"`,
  `ANALYTICS_FLOOR_SEED || "1"`.
- `docker-compose.demo.yml:36-49` documents the same; `docker-compose.stage.yml` only pins port 48787 (the
  stage.robotmoney-labs.dev tunnel origin) — no data-path overrides.
- `--stage` only changes cadence: `scripts/lib/demo-schedule.ts:110-111` — research `0 */3 * * *`, regime
  `30 */3 * * *` (regime/research every 3 h).
- Cold-boot seeds are REAL history, not synthetic: `extract/floor-seed.ts:18-21` parses the vendored
  `backend/tests/fixtures/regime/raw-indicator-history.csv.gz`; spot-checks against known reality pass
  (VIX 2020-03-16 = 82.69 — the actual record close; T10Y2Y early-Oct-2022 = −0.39..−0.48, the real inversion).
  Floor covers 2018-01-01..2026-06-29, ~3.1k rows/indicator. EDGAR/MNA seed is a separately vendored real
  artifact (`edgar-mna-seed.csv.gz` + manifest; regeneration only by explicit operator command,
  `extract/edgar-seed-generator.ts:1-6`, refuses partial history :36-56).

So: **the stage site serves live-fetched real data merged over a vendored real floor.** The retired
hermetic-demo design survives only in stale comments (see DI-007) — likely fuel for the "faked" perception.

### 1.3 Persistence + merge (authoritative state)

- Authority: Postgres `raw_indicator_history` (PK `(date,indicator)`, `backend/migrations/0009_analytics_v2.sql:29-36`),
  `regime_snapshots` (PK date; 0002 + 0009/0010/0011 extensions), `research_signals` (`(signal_key,date)`).
  **No provenance/source column on any of them** (see DI-001).
- Merge: `transform/math.ts:325-345` `mergeSeries` — union by date, prior floor never deleted, **fetched wins on
  overlap**, non-finite dropped, sorted/deduped. Write-back: `store/raw-history-store.ts:41-63` upsert
  `ON CONFLICT (date,indicator) DO UPDATE` (chunked 5k rows). So the floor is append-only against deletion but
  NOT against overwrite — the corruption vector in DI-001.
- Seed ingestion is the opposite semantics (gap-fill, existing rows win): `store/floor-seed.ts:21-42`; idempotent;
  cannot repair a contaminated row (`edgar-seed-loader.ts:35-59` counts such rows as "rejected ... correctly left standing").
- Orchestrator persists through the `AnalyticsPersistence` port only (`analytics/index.ts:104-127`); producer uses
  the authenticated HTTP client `analytics/api-client.ts:53-92` (single POST of the whole merged floor — no
  partial-chunk client sequence; server cap 500k points vs ~81k current).
- EDGAR last-good invariant: degraded incremental refresh → floor returned UNCHANGED and
  `late-cycle-signals` publication skipped (`access/data-source.ts:130-143`, `index.ts:314-327`) — covered by
  `tests/research-last-good.test.ts` (AC5/AC7) over the real API boundary + real ephemeral Postgres.

### 1.4 Ingestion boundary (API)

`backend/src/api/routes/analytics.ts` — verified: whole-payload validation BEFORE any transaction
(caps :49-55; strict ISO dates :58-62; **non-finite REJECTED not skipped** :86-94; duplicate (indicator,date)
rejected :91; unknown fields stripped by explicit row rebuild :123-147); each write in ONE transaction
(:337,:344,:351,:358,:388); idempotent natural keys. A partial batch cannot land: any invalid element 400s the
entire request with zero row changes. Rejects are observable to the producer as a thrown HTTP error
(`api-client.ts:58-68`). Auth is strictly ANALYTICS_TOKEN (:311-320); `POST /api/committee/regime` reuses the
same parser behind the same provider role (:150-167, committee.ts:192-202). **No silent-drop path found.**

### 1.5 Read path → frontend

- `GET /api/dashboards/regime-snapshots?range` → `report/projections.ts:25-37`: last N rows, chronological, plus
  `staleness` from `computeRegimeStaleness` (`report/regime-projection.ts:109-133`, threshold 3 days on the newest
  snapshot DATE). Frontend `frontend/public/assets/js/app/alpine/views/regime.js:28-76` renders a loud banner
  (`frontend/public/views/regime.html:24-31`) when `staleness.stale`.
- `GET /api/dashboards/research-signals/:key` → `projections.ts:12-18`: latest row, **no staleness field**;
  frontend `views/research.js:14-24` reads only `payload` (ignores the row `date`). Channel-divergence page prints
  `payload.asof` as text (`views/research/channel-divergence.html:25-26`); the late-cycle page shows **no data
  date at all** (grep: no asof binding in `late-cycle-signals.html`). See DI-004.
- Fill semantics: axis 2018-01-01..asof (`index.ts:47,199`), `alignDailyForwardFill` (math.ts:278-290; NaN before
  first obs, then indefinite carry-forward) / `alignDailyZeroFill` (math.ts:293-309; registry currently has no
  zero_fill user). Rows without a classifiable regime are skipped, not zero-filled (`index.ts:390`). The rich
  latest-row indicators carry `raw_value`/`raw_date` (`index.ts:460-461`) — the only per-indicator freshness
  signal that reaches the UI ("Last" column, regime.html:118).
- `transform/grid.ts:13` `shapeDaily` — comment says "fall back to seeded" but the function has **no caller** in
  src (dead code + stale comment; DI-007).

### 1.6 Scheduling

Independent producer (`backend/src/producer/index.ts`): no DATABASE_URL, REST-only submission
(docker-compose.yml:198-216), crons default 22:30/23:00 UTC, stage overrides every 3 h. Demo boot runs floor seed,
`producer seed` (EDGAR ingest + immediate research), and one regime classify (`scripts/lib/demo-main.ts:1286-1293,1538`).
Legacy worker lane still routes any residual queue rows through the same `resolveAnalyticsSource()`
(`backend/src/worker/handlers/analytics.ts:22`).

### 1.7 Test honesty (spot-audit)

- Deterministic suites inject fixture sources but tie results to committed GOLDEN outputs of the original
  pipeline: `tests/regime-fidelity.test.ts:1-31` (TS port byte-identical to original JS over 2968 rows; vintage
  drift bound documented), `tests/analytics-suite.test.ts:1-13` (real orchestrator + real ephemeral Postgres,
  fixture source; asserts the re-run-with-empty-fetch never erases the floor). Preload loud-fails when Postgres is
  absent ("never skips").
- Live-network coverage is a nightly, not a silent skip: `tests/fetchers-live.test.ts:30-46` gates on
  RUN_LIVE_FETCHERS=1 and THROWS at module load if `EXPECT_LIVE=1` while the gate is off (anti-false-green guard),
  announced by `.github/workflows/nightly-fetchers.yml`.
- Boundary honesty: `tests/prod-honesty.test.ts` (seeded unreachable), `tests/producer-boundary.test.ts`,
  `tests/analytics-api-boundary.test.ts`, `tests/research-last-good.test.ts` (only outbound SEC/Yahoo/FRED HTTP faked).
- **No silent resource-missing skips found in the analytics test set.**

---

## 2. Findings

### DI-001 · DATA_INTEGRITY_PROVENANCE · high · confidence: high
**No provenance column + overwrite-on-overlap = one wrong env var permanently contaminates the real floor.**
Observed: `raw_indicator_history`/`regime_snapshots` store no source/provenance (0009_analytics_v2.sql:29-36);
`mergeSeries` is fetched-wins (math.ts:336-341) and the store upserts `DO UPDATE` (raw-history-store.ts:59-61,
regime-store.ts:53-74). The hermetic source writes through the exact same port.
Minimal corrupting sequence: any process holding the analytics credential runs `runAnalytics` with
`ANALYTICS_SOURCE=hermetic` (or `bun run src/demo/e2e.ts` — `demo/e2e.ts:92` — with a live DATABASE_URL): seeded
walks are merged OVER every overlapping real floor date and all ~3.1k snapshot rows are overwritten. Nothing marks
the rows; the seed/repopulate path cannot repair them (floor-seed.ts:21-42 and edgar-seed-loader.ts:44-52 both
leave differing existing values standing).
Authoritative repair state: vendored real fixtures (`tests/fixtures/regime/raw-indicator-history.csv.gz`,
`edgar-mna-seed.csv.gz`) + full live refetch, after manually deleting contaminated (date,indicator) ranges.
Recommendation: add a `source` (live|seed|hermetic) column or run-id FK to floor rows; make the API boundary
refuse `hermetic`-labelled submissions outside ephemeral envs; give demo/e2e a dedicated DB guard.

### DI-002 · DATA_INTEGRITY_FAKED_DATA (reachability, not an active leak) · medium · confidence: high
Synthetic data CAN reach a live surface through exactly one knob: `ANALYTICS_SOURCE=hermetic`
(index.ts:69-76), which demo-env passes through from the invoking shell (demo-env.ts:63,
docker-compose.demo.yml:49,93; docker-compose.yml:209). A stage boot from a shell exporting it would serve
deterministic fake series with **zero UI indication** — the `source` label lands only in telemetry rows
(index.ts:133,362) and container logs (hermetic-source.ts:41-44 warns). Verified NOT the case by default: unset →
live everywhere live-facing. Recommendation: surface pipeline `source` on the regime/research DTOs and render a
badge; alert when telemetry `source != "live"` outside CI.

### DI-003 · DATA_INTEGRITY_STALE_READ (staleness masking) · high · confidence: high
The regime staleness contract measures the wrong thing for fetch failure. Every run forward-fills the axis to
`asof=today` (index.ts:199-207), so snapshot dates are always fresh as long as the producer RUNS;
`computeRegimeStaleness` (regime-projection.ts:121-133) looks only at the newest snapshot date. If some or ALL
fetchers fail (each degrades to `[]` — data-source.ts:96-105, sources.ts:102-108 — then to the persisted floor,
then forward-fill), the UI shows a current-dated, fresh-looking chart whose tail is frozen carry-forward, and the
staleness banner NEVER fires. Only the per-indicator `raw_date` in the latest row (index.ts:461) reveals it, with
no highlighting when it lags. This is the classic "plausible-but-fake-looking" surface and the most likely
mechanical cause of "expected data missing".
Recommendation: extend staleness to max(`raw_date`) per panel (e.g. flag any indicator whose last real
observation lags > N days; flag the composite when >k indicators are lagging), and color stale `Last` cells.

### DI-004 · DATA_INTEGRITY_STALE_READ (research signals) · medium · confidence: high
`fetchLatestResearchSignal` (projections.ts:12-18) returns the newest row with no freshness contract; the frontend
never reads the row `date` (research.js:14-24). Channel-divergence prints `payload.asof` inline
(channel-divergence.html:25-26); the late-cycle page displays no data date at all. A stopped producer or a
perpetually-degraded EDGAR refresh (which correctly skips publishing — index.ts:314-327) serves an arbitrarily old
signal indistinguishable from current. Recommendation: mirror the regime staleness object on this endpoint + banner.

### DI-005 · DATA_INTEGRITY_SILENT_DEGRADATION (observability of "loud") · medium · confidence: high
The claimed "loud log" on fetch failure is real but weak: console warn/error lines (sources.ts:106,113-117,
index.ts:174-184) + telemetry warnings/`degraded` status persisted via `research_pipeline_runs`
(telemetry.ts, 0018_research_telemetry.sql), visible only on the admin surface. No alerting, no public-UI
signal, and telemetry submission is itself best-effort-never-throws (index.ts:353-370). Forward-fill has no cap:
an indicator dead for a year still contributes ranks from its last value at full weight (weights only zero out
below 60 finite obs over the whole axis — math.ts:206-211 — which forward-fill guarantees never happens after the
first observation). Recommendation: alert on telemetry `degraded`; cap forward-fill contribution or decay weight
with observation age.

### DI-006 · DATA_INTEGRITY_MISSING_DATA (cold-boot floor gaps) · low-medium · confidence: high (observed in fixture)
The vendored floor contains 25 of 26 registry ids — **no BTC_MVRV rows at all** (fixture predates the #127
Coinmetrics repoint; confirmed by `zcat | awk` count = 0 and regime-fidelity.test.ts:11-14) — and no MNA (separate
EDGAR seed, loaded only by `producer seed`). NEW_TOKENS floor is only 30 days; HY_OAS 1127 rows; floor ends
2026-06-29. Consequences on a cold live boot: BTC_MVRV's history depends entirely on the live Coinmetrics fetch —
if that leg fails, BTC_MVRV is silently excluded (weight 0) and the onchain panel is a 9-indicator panel with no
UI difference beyond a blank row. If the demo boot skips `producer seed`, late-cycle MNA is empty pre-2024.
Recommendation: regenerate the vendored floor to include BTC_MVRV; assert at boot that every registry id has
either floor or fetched coverage, and surface the excluded set on the admin surface.

### DI-007 · DATA_INTEGRITY_PROVENANCE (stale honesty documentation) · low · confidence: high
Three places still describe the RETIRED synthetic-demo design and directly feed the "faked pipeline" perception:
`access/hermetic-source.ts:3-9` ("the demo spec forbids the demo reaching out ... the seeded provider must supply
deterministic data ... the CI `e2e` job select THIS source (ANALYTICS_SOURCE=hermetic, or the demo ...)") —
contradicted by demo-env.ts:5-10 (issue #147/#163: demo is ALWAYS live); `transform/grid.ts:10-12` "fall back to
seeded" (function has no caller); `extract/http.ts:2-3` "fall back to seeded / persisted". Also a UI methodology
contradiction: `views/regime.html:248` says composite = "arithmetic mean of all three panel indices" while
:230 and the code (indicators.ts:464 `PANELS=[macro,onchain]`; index.ts:211) use the 2-panel mean.
Recommendation: fix the comments and the :248 bullet.

### DI-008 · info · Ingestion boundary and merge are sound
No path found where a partial batch drops rows silently; validation is whole-batch-reject with single-transaction
writes and idempotent keys (api/routes/analytics.ts:332-390). The suite/fidelity/live-drift test stack is honest
(no silent skips; anti-false-green guard in fetchers-live.test.ts:40-46).

---

## 3. Verdict on the product owner's hypothesis

- **Not faked**: every live surface (prod default, `bun run demo`, the standing `--stage` stack behind
  stage.robotmoney-labs.dev) resolves `ANALYTICS_SOURCE=live` → real keyless fetchers over a vendored REAL floor
  (spot-verified against historical market facts). seededProvider is provably unreachable on that path
  (prod-honesty static + behavioral tests).
- **Most likely explanation for "missing expected data"**: DI-003/DI-005 — one or more upstream fetchers failing
  (Yahoo throttling of the keyless v8 endpoint is the usual suspect; DEMO_MODE additionally serves 1h-cached
  bodies, fetch-cache.ts:36-42) silently degrades those indicators to the persisted floor, which forward-fill
  stretches to today. The charts then look current while the affected series' tails are frozen — recent expected
  movements never appear, and nothing on /regime or /research flags it (regime staleness only fires when the
  producer stops entirely). Secondary contributors: research pages with no/weak data-date display (DI-004) and
  stale "demo is seeded" comments (DI-007) that make the pipeline read as synthetic on inspection.
- Fastest confirmation on the affected deployment: compare `raw_date` per indicator on the latest snapshot row
  (`SELECT indicators FROM regime_snapshots ORDER BY date DESC LIMIT 1`) against today, and read the latest
  telemetry run's warnings (`research_pipeline_runs`) for "fetch returned 0 rows" lines.
