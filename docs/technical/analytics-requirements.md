# Analytics requirements

Owner: Lucas. Code: `packages/analyst-sdk` (shared), `backend/src/analytics/` (re-exports and the backend run). Terms are defined in [`../definitions.md`](../definitions.md): source data, calculated indicators, report and archive. The client side is in [`analyst-sdk-requirements.md`](analyst-sdk-requirements.md).

## 1. Scope

This document specifies the analytics module. It turns source data into calculated indicators, the calculated indicators into the regime, and the regime into backtests. The regime is one word per day: `risk_on`, `neutral` or `risk_off`. It says whether markets reward risk or punish it.

Two consumers use the module: the backend analytics run and the analyst SDK clients. The code is shared (D57). The backend's compute files are one-line re-exports of the package. The backend's source-client files re-export the package's clients and add the backend's cache, fetch ledger and host adapters. No backend file changes a computed number.

Non-goals:

- Changing any regime, correlation, research-signal or backtest calculation methodology, including correcting numerical edge cases as part of the refactor.
- Optimizers, return forecasts, intraday data and live trading.
- A user interface. Output is JSON and CSV.
- Scoring a swarm member's submission. That is a backend feature.

## 2. Principles

- **Pure.** The computation calls no network, reads no database and reads no environment.
- **HTTP only during extract.** Extract is the acquisition stage: it collects provider data or downloads archived data before computation starts. After extract, input preparation, alignment, transforms, ratio calculation, regime calculation, research signals, allocation policies, backtesting, statistics and report generation make no outbound HTTP requests. This applies to their callbacks, adapters and transitive dependencies, including when inputs are missing. SDK provider requests go only through `src/extract/http.ts`; csvb archive requests belong to the acquisition stage. A local input run does not start or invoke acquisition.
- **Committed inputs.** Source-update jitter handling belongs to ingestion. After the update commits, extract supplies the exact committed values and versions to every downstream consumer. Fresh provider values discarded as jitter never enter calculation. Backend, archives and SDK use the same committed observations for a run.
- **JSON in, JSON out.** Every function takes plain data and returns plain data.
- **Same inputs, same bytes.** Given identical effective input observations, dates, schedules and options, backend and SDK produce byte-identical report payloads, both before and after the refactor.
- **One source of truth.** The backend runs the package's source files.
- **One calculation contract.** This refactor exposes and generalizes the established shared computation without changing its methodology. There is no alternate methodology selector and no backend-only calculation retained to produce different numbers. Existing reports preserve every value, date, label, null, field and serialized byte, including field ordering and number formatting. New inputs and APIs use these same rules; input mappings and preparation preserve the observations each existing calculation receives. Provenance is separate from the original report payload.
- **No retroactive change.** Stored rows, published reports, vintages and existing archives keep their bytes and meaning. Nothing is renamed, rewritten, re-chunked or backfilled (D74 clarification, 2026-10-22).

## 3. Components

| Area | Where | What it does |
| ---- | ----- | ------------ |
| Regime | `src/analyze/compute.ts` | Calculated indicators (percentiles, panel indices, composite) and the label, from prepared source data. |
| Indicator registry | `src/analyze/indicators.ts` | 26 indicators in three panels: macro (8), onchain (10), factor (8). The composite uses the macro and onchain panels (`PANELS`). The factor panel is display-only. |
| Correlations and backtest | `src/analyze/correlations.ts`, `backtest.ts` | Correlations, and the backtest (section 5). |
| Research signals | `src/analyze/research-signals.ts` | Channel divergence and late cycle. |
| Weighting comparison | `src/analyze/weighting-comparison.ts` | Weighting methods compared across market phases. |
| Transforms | `src/transform/` | Series math and the transforms that turn source data into calculated indicators. |
| Input loader | `src/input/load.ts` | CSV or JSON of source data. |
| Run entry | `src/run.ts`, `src/prepare.ts` | `runRegime`, and `prepareRegimeInputs`, the same function production calls. |
| Source clients | `src/extract/` | Keyless clients that fetch source data from FRED, Yahoo, DefiLlama, blockchain.com, Coin Metrics, Shiller and EDGAR. The backend uses them to fill its database. They are the only code in the package that touches the network, and only through `src/extract/http.ts`. |

## 4. Source data

### 4.1 Source ids

Every source series has one id, `<provider>:<symbol>`, for example `yahoo:^GSPC`, `fred:DTB3` or `yahoo:HG=F`. Computation, SDK input reports and new public API contracts use that id. No id names the code that reads it. Existing database keys and historical archive keys may remain unchanged. One shared mapping at the storage boundary translates them to canonical source ids; existing writes use the reverse mapping where needed. The mapping preserves values, dates, ordering, provenance and vintage membership. The mapping is per consumer: each consumer keeps reading the storage keys it reads today. Two storage keys may hold different streams for one source id, for example `raw_indicator_history:SPX_TREND` and `backtest:^GSPC` for `yahoo:^GSPC`. They are never merged, and the storage key travels with each observation as provenance. A mapping is ambiguous, and rejected, when one consumer would read two storage keys for one source id. Historical references and immutable archives are never rewritten merely to rename a series.

The indicator registry names the source ids each indicator reads. The correlations and the backtest name the source ids they read: `yahoo:^GSPC` and `yahoo:ETH-USD` (price levels) and `fred:DTB3` (a rate).

### 4.2 Input report

The input is a report of source data. It is a CSV with exactly the header `date,series,value`, where `series` is a source id. The same rows as JSON give byte-identical output.

- **Dates.** A date is a real calendar date in `YYYY-MM-DD` form. Any other date rejects the file.
- **Values.** A value is a plain decimal number, with an optional sign and exponent. Hex, padding and non-finite values reject the file.
- **Unread series.** Source ids that no indicator, correlation or backtest reads are ignored. They do not set the date axis.
- **Date axis.** Without `asof`, the run ends on the latest date of any series the run reads.
- **Input coverage.** Extract supplies every source series required by the requested workflow and date range before downstream work begins. Coverage includes ratio legs, asset prices, lending yields, benchmark rates and research inputs wherever the workflow uses them. Missing data is an acquisition or input-coverage gap; downstream code never repairs it with an HTTP request. Required missing inputs cause an explicit error naming the missing series and affected range. Optional missing inputs follow the documented missing-result rules below.
- **Missing series.** An indicator with no rows for a source id it reads counts as missing and carries no weight.
- **Correlations and backtest.** The correlations need `yahoo:^GSPC` and `yahoo:ETH-USD`. The backtest also needs `fred:DTB3`. A section whose series are missing is `null`.

### 4.3 Ratios are calculated

The input holds source data only. A ratio of two source series is a calculated indicator, so the input holds both legs. The regime run calculates the ratio.

Eight indicators are ratios of two Yahoo series: `COPPER_GOLD`, `IWM_SPY`, `BTC_ETH`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY` and `XLP_XLY`. For each of them:

- each leg is its own source data, with its own source id (for example `yahoo:HG=F` and `yahoo:GC=F`),
- the transform step calculates the ratio on the dates both legs share, and skips any date where either leg is not a finite number or the denominator is 0,
- a missing leg is a missing input.

A row keyed by a ratio id is a calculated value, not source data. The loader rejects it. New source collections store and serve the legs. Historical stored ratios remain calculated indicators and are retained as original replay inputs with their provenance; they are never relabelled as source data or reconstructed from newly downloaded legs. The historical replay path accepts those inputs under the recorded methodology, separately from the source-only input contract.

Ratio calculation preserves the established operation order and precision, without additional rounding. Before changing production to calculation from legs, comparison against pinned original inputs must demonstrate identical ratios and complete reports. A difference in alignment, missing values, collection time or precision blocks the refactor cutover; it cannot be accepted by selecting another methodology or widening a tolerance. Missing historical legs are recorded as unavailable.

### 4.4 The public API

A free, tokenless, read-only JSON API under `/api/public/analytics/` serves the record as it was at each point in time. Every route is GET only.

The API serves two things, each with its revisions:

- **Source data as collected.** Each value is served as the external party published it when we collected it, with the time we observed it. A later revision is a new version next to the old one. It never replaces the old one.
- **Reports as published.** Each analytics run publishes its report once. The API serves that report byte for byte as the run created it. A later run that changes a past day publishes a new report. It does not edit the earlier one.

A vintage ties the two together: it names the source data versions a run read and the report the run published. The sequence of vintages is the revision history of the reports.

The routes are:

| Route | Serves |
| ----- | ------ |
| `raw-history` | Source data, current values, for every source id: indicator inputs, ratio legs, research inputs and the series the correlations and the backtest read. Filters: `series` (a source id), `from`, `to`. |
| `asset-prices` | Source data: daily asset closes in USD, current values. Filters: `series` (a source id), `from`, `to`. |
| `source-versions` | Every collected version of source data, with its observed time. Filters: `series` (a source id), `from`, `to`, `asof` (the versions in force at that time). |
| `vintages` | One entry per run: run, methodology, cutoffs, digest, the source data versions it read (members), and its published report. |
| `reports` | A run's published report, byte for byte, with its checksum. Filters: `run` or `vintage`. |
| `overwrite-events` | Every recorded revision of a stored row, source data and reports alike. |

The API never recomputes a calculated indicator. Calculated indicators reach the API only inside a published report. The current regime view stays at `/api/dashboards/regime-snapshots?include=backtest`.

### 4.5 Archive format

There is one archive format: format 1, the layout robotmoney/csv-backups writes (decision D72). The module adds no second format.

- **Backups.** One directory per backup, named by the snapshot time (`csv/<backup id>/`). Each holds `backup.json` and archives.
- **Write-once.** A backup only adds archives. Nothing is overwritten.
- **Two kinds of archive.** Data archives only gain rows. They hold every observed version of source data (`source_value_versions`), the run ledger, the vintages and the published reports (`analytics_output_snapshots`). Revision archives hold the rows that are new or changed since the last backup, with `_backup` and `_op` columns. They cover `raw_indicator_history`, `asset_prices` and `regime_snapshots`. The state at any backup is the replay of the revision archives up to it.
- **Pinning.** A backup id names an exact state. `csvb resolve --as-of <id>` returns a report as of that backup.
- **Provenance.** `backup.json` records `source` (`db` or `api`) and `consistency` (`snapshot` or `paged`).
- **Location.** Backups live outside this repo. The tool refuses a backup directory inside a checkout of this repo.
- **Access.** The csv-backups repo is private and holds production data.

### 4.6 The API serves archives

The API serves archives in format 1. A client downloads archives and writes them into its local copy unchanged. It does not rebuild them from JSON pages.

- **Data archives.** Served as `<table>.<start>_<end>.csv.gz`, with the same columns and the same COPY CSV text as a backup.
- **Revision archives.** Served with the `_backup` and `_op` columns.
- **Backups.** Archives are grouped by backup id, and a `backup.json` describes each backup. A client lists the backups, then fetches only the archives past its watermark.
- **Same bytes.** The API and the replica produce byte-identical archives for the same state.
- **Coverage.** Every report in a backup is served with full history. That includes the source data the correlations and the backtest read (`yahoo:^GSPC`, `yahoo:ETH-USD` and `fred:DTB3`).

Model portfolio inputs (asset prices, lending yields and the T-bill rate) are source data under sections 4.1 and 4.2. Their versions are recorded in the existing `source_value_versions` table under their source ids. Any workflow using them receives them as supplied data and follows the same extract-only HTTP boundary; their absence never authorizes a downstream request.

### 4.7 Chunking

Archives are the unit of transfer. A chunk is one archive.

- **Size.** An archive is at most 90 MB, as the csv-backups tool writes it (`--part-mb`, default 64), because GitHub rejects files over 100 MB.
- **Naming.** A data archive is named by the earliest and latest row time it holds. A client picks archives by name, without opening them.
- **Write-once.** A served archive never changes. Its checksum is its identity.
- **Watermarks.** A client holds, per table, the last id or time it has. It asks only for archives past that point, so a second run costs only what changed.
- **Lists.** Listing the backups and their archives is a small request. Archive bodies are separate requests.

### 4.8 Server load protection

Public traffic must never starve the site. These limits apply to every public analytics route, archive routes included (decision D73).

- **Concurrency gate.** At most 2 public-analytics queries run at once, process-wide. Beyond that the API answers 503 with `Retry-After`. Public traffic holds at most 2 of the 10 pool connections.
- **Statement timeout.** Every public query runs with a 5 second timeout. A timed-out query answers 503 with `Retry-After`, never 500, and frees its connection.
- **Cost-weighted rate limit.** 100 tokens a minute per client ip. A list request costs 1. A heavy request costs 10: an archive of a large table, or a frozen run output.
- **Byte budget.** 50 MB served a minute per client ip. An archive request is admitted when the client has any budget left. The full archive is charged and the budget may go negative; later requests answer 429 with `Retry-After` until it recovers. Existing archives are never re-chunked to fit the budget.
- **Async compression.** Gzip runs off the event loop, so a large response cannot stall other routes.
- **Caching.** A served archive is immutable. Its ETag is its checksum, read by a metadata query before any bytes. A matching `If-None-Match` answers 304 without reading the archive. A 200 carries `Cache-Control: public, max-age=31536000, immutable`. Lists carry `max-age=300`.
- **Edge cache.** The web server caches `GET /api/public/analytics/*` with a lock, so concurrent misses reach the API once. The cache is bounded (256 MB) and sets `X-Cache-Status`.
- **Vendor-neutral client identity.** The rate limit keys on `X-Client-IP`, which the web server sets from its resolved address. The web server drops any `X-Client-IP` the caller sent. No CDN rule is involved.
- **One way in.** Only the web server can reach the api port. The api publishes no port on a public interface, so no caller can set its own client identity.

### 4.9 Data terms

Yahoo-sourced rows are served like every other row (D58). Check each provider's terms before you republish what you download.

## 5. Backtest

### 5.1 Purpose

The backtest replays a portfolio over past source data. It answers: what would the portfolio have been worth if it had held these weights on these dates? The result is a value series, which is a calculated indicator, plus period statistics.

The backtest does not choose weights. It takes them as input.

### 5.2 Calculation rules and weights

The backend and SDK run one shared backtest calculation. Generalizing the API preserves the established production results byte for byte. The following behaviors are part of that contract, including numerical edge cases.

- **Weights.** Nonnegative shares per asset id, cash included, summing to 1. An asset id is any source id with supplied prices; the module has no fixed asset list.
- **Schedule.** Supplies the target weights for each date. Reference schedules preserve the existing label-to-weight mapping and dates with missing labels.
- **Returns.** Each active day's asset return uses the previous active target weights and that day's price change against the preceding calendar date. Target weights are reapplied in daily return calculations; holding drift is not carried between dates.
- **Missing weights.** A date with no applicable weights is skipped, including that day's market move. It does not acquire data or introduce a new hold-through-gap rule.
- **Trading costs.** A change in target weights at the close deducts one-sided turnover times the cost rate. Turnover is the sum of absolute target-weight changes, halved. Unchanged target weights incur no cost. Preserve the established operation order.
- **Cash.** Uses the previous calendar day's annual yield in percent, converted with `(1 + yield / 100) ** (1 / 365) - 1`. Missing earlier yields earn zero.
- **Prices.** Gaps are forward-filled using the existing rules. The existing treatment of invalid or nonpositive prices is preserved.
- **Start.** Values start at 1. Reference baselines begin on their first priced date; strategies begin on their first applicable labelled date. Preserve each path's original dates and normalization.

### 5.3 Simulator

`simulatePortfolio(dateAxis, schedule, prices, cashRate, options)` exposes the shared simulation for supplied schedules and assets, using section 5.2 without a methodology option.

| Input | Meaning |
| ----- | ------- |
| `dateAxis` | The days to replay. |
| `schedule` | Applicable target weights per date. |
| `prices` | Supplied daily price levels per asset id. |
| `cashRate` | Supplied annual cash yield in percent. |
| `options.costBps` | Cost per unit of one-sided turnover. Default 10 basis points, matching existing reports. |

The result includes the daily value series, trade count, cost evidence and the pre-cost daily returns needed by period statistics. Additional simulation evidence is exposed separately from the existing report payload. The established report fields and serialization remain byte-identical.

Weights set at today's close apply to later returns; changing today's target can change today's cost, but cannot change today's pre-cost return or earlier values. Computation reads no file and makes no HTTP request.

### 5.4 Period statistics

`periodStats(valueSeries, from, to, options)` uses the same statistics calculation as production. `options` supplies the simulator's original pre-cost daily returns and date-boundary evidence where required; there is no methodology selector. A net value series alone cannot reproduce existing Sharpe, because values include trading costs and the daily returns used for Sharpe do not.

- Total return and annualized growth use the established values, operation order and elapsed-time conventions. CAGR uses years of 365.25 days.
- Volatility and Sharpe use the original pre-cost return observations and sample standard deviation. Sharpe is annualized over 365 days with no risk-free subtraction and returns 0 when standard deviation is zero.
- Maximum drawdown uses the established net values and peak calculation.
- In-sample and out-of-sample statistics preserve the existing boundary conventions. Out-of-sample growth uses the first value after the split date and elapsed time from the split date.
- Empty, short and non-finite cases preserve existing zero/null behavior; the refactor does not standardize them to new defaults.

Windows and market phases are supplied date ranges. Additional statistics must not alter existing fields. Full-range values and every existing split statistic must exactly reproduce the established output through both backend and SDK entry points.

### 5.5 Reference portfolios

The reference portfolios are data: `eth`, `sp500` and `mixed`, with their existing regime weight tables and baselines, plus the all-cash baseline. Single-asset hold baselines retain their existing behavior. The mixed baseline retains the `blend_hodl` key and its existing fixed-target daily calculation without charging for daily resets; its descriptive meaning is constant mix.

`scheduleFromLabels(labels, table)` preserves the established label-to-weight mapping, including missing labels. Running those schedules through `simulatePortfolio` and `periodStats` gives the same daily values, statistics and serialized reference report as `computeBacktest`. Baselines and strategies retain their original respective start dates.

### 5.6 Consumers

- **Backend.** It runs the reference portfolios on every analytics run. It stores the result on the latest snapshot row.
- **SDK clients.** They pass any schedule and any assets they have prices for.

### 5.7 Outside this module

- Choosing weights: rules, signals, bands, tilts and optimizers.
- Sourcing prices for assets.
- The command line and any file format.

## 6. Reproducibility

- **As-of runs.** `runRegime` takes `asof`. Source data dated after it is ignored. Missing values are forward-filled, capped at `MAX_FORWARD_FILL_DAYS` (120). Semantics are in `regime-engine.md` section 8.1.
- **Pinned source data.** A run is only reproducible against pinned source data. An unpinned read can differ from a published run, because external parties revise source data.
- **Run manifest.** A run records the input files it used and their hashes, its vintage id, methodology id and exact code revision. The code revision is the image's baked git commit (`RM_BUILD_COMMIT`), the value `/version` reports (AC-ID-03). Package and runtime versions are never part of it. An image built without a commit records `unavailable: RM_BUILD_COMMIT is unset or blank`. Historical runs retain their recorded identity, including the earlier `pkg:<version>+bun:<runtime>` label (issue 1442); any supplemental replay metadata is stored separately from immutable reports.
- **Compatibility evidence.** Representative published runs across market regimes, dates and missing-data patterns provide pinned inputs and complete expected outputs. Comparisons cover indicators, panel indices, composites, labels, correlations, daily portfolio values and every statistic. Identical inputs and report options must produce byte-identical serialized reports through the pre-refactor backend, pre-refactor SDK, refactored backend and refactored SDK. Changes to floating-point operation order, serialization, null handling or dates are regressions even when differences are small. Report comparison is byte for byte; no numerical tolerance applies.
- **Replay.** The ledger starts on 2026-09-21. A published run is replayed from the source data in force at its vintage cutoff, not from the current table.
- **Source updates.** Ingestion applies D56 when deciding whether a provider value changes the stored record. Once committed, values are used exactly throughout preparation, calculation, archives and SDK inputs. No source-specific tolerance applies to downstream calculations or report comparison.
- **What changes after publication.** The current table is not the record. Source data lags and restatements by external parties, and the final-day weight refresh, can move a calculated indicator. Labels amplify small composite changes.

## 7. Success criteria and tests

Package paths are relative to `packages/analyst-sdk/`.

| Criterion | Test |
| --------- | ---- |
| The default regime report matches `tests/golden/regime-report.json`. | `tests/regime.test.ts` |
| `bun test` passes with `fetch` replaced by a thrower. | `tests/no-network.ts` (preload) |
| `bunx tsc --noEmit` is clean. | the package `typecheck` script |
| After extract, all requested downstream stages complete from supplied data with HTTP disabled, including injected callbacks and dependencies. Missing required inputs fail explicitly and optional missing inputs return their documented missing results, with no acquisition fallback. | `tests/no-network.ts` (preload), `tests/input-rule.test.ts`, `scripts/tests/unit/analyst-sdk-purity.test.ts` |
| The computation reads no network, database or environment. Static checks forbid downstream imports of acquisition clients and HTTP APIs, not only direct calls to `fetch`; SDK provider HTTP goes through `src/extract/http.ts`. | `scripts/tests/unit/analyst-sdk-purity.test.ts` |
| The input rules of section 4.2 hold: bad dates and values reject the file, unread series are ignored and set no date axis, missing series give `null` sections. | `tests/input-rule.test.ts` |
| The source-only loader calculates ratios from legs and rejects ratio-id rows; historical replay preserves original ratio inputs. | `tests/prepare.test.ts` |
| Every exported function has a test. | `tests/*.test.ts` |
| Reference portfolios give byte-identical reports and identical daily values through the pre-refactor and refactored backend and SDK, including `simulatePortfolio` and `computeBacktest`. | `tests/backtest.test.ts` |
| Complete serialized reports for representative pinned production inputs match byte for byte across backend and SDK before and after refactoring, including field order, formatting and nulls. | `backend/tests/regime-replay-published.test.ts` |
| Storage key translation preserves values, dates, ordering and vintage membership; each consumer reads the same storage keys as before; two streams for one source id stay separate; ambiguous mappings reject. | `tests/input-rule.test.ts` |
| Historical ratio inputs replay unchanged; calculation from pinned legs preserves ratios before production adoption. | `tests/prepare.test.ts` |
| Changing a date's weights does not change earlier values or that date's pre-cost return; its close-of-day cost follows the established rules. | `tests/backtest.test.ts` |
| A date with no applicable weights preserves the established skip behavior and daily return observations. | `tests/backtest.test.ts` |
| Reference baselines retain their existing target-weight behavior, keys and start dates without introducing holding drift. | `tests/backtest.test.ts` |
| `periodStats` with original pre-cost returns and boundary evidence reproduces existing full-range and split statistics, including Sharpe on a path with costs. | `tests/backtest.test.ts` |
| A replay with the original effective inputs reproduces the complete published report byte for byte. The run uses the exact committed input versions; source-update jitter handling provides no replay exception. | `backend/tests/regime-replay-published.test.ts` |
| As-of regime labels match the published record from 2026-09-21 (issue 1182). | `backend/tests/regime-replay-published.test.ts` |
| The API and the replica write byte-identical archives for the same state. | `backend/tests/api/public-analytics-archives.test.ts` |
| A report served for a run is byte-identical on every request, and its checksum matches the stored one. | `backend/tests/api/public-analytics.test.ts` |
| Source data served with `asof` equals the versions collected up to that time, and a later revision does not change it. | `backend/tests/api/public-analytics.test.ts` |
| Every vintage names its members and its published report, and both can be fetched. | `backend/tests/api/public-analytics.test.ts` |
| A vintage's build identity is the image's commit, the same across runtime versions, and `unavailable` without one; earlier vintages keep their rows. | `backend/tests/analytics-build-identity.test.ts` |
| Each limit of section 4.8 holds, and a timed-out query answers 503. | `backend/tests/api/public-analytics-limits.test.ts` |

## 8. Open decisions

None.

## 9. References

- [`../definitions.md`](../definitions.md)
- [`analyst-sdk-requirements.md`](analyst-sdk-requirements.md)
- `packages/analyst-sdk/README.md`
- Decisions D56 (persistence tolerance), D57 (the package as a shared seam), D58 (data terms), D72 (archive format 1), D73 (the public analytics API serves the record), D74 (one source id)
- `docs/technical/regime-engine.md` section 8.1
- `docs/technical/research-signals.md`
- Issue 1095 (the SDK and the four routes)
- Issue 1182 (frozen publications)
