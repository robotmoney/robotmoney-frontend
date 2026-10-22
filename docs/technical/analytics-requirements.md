# Analytics requirements

Owner: Lucas. Code: `packages/analyst-sdk` (shared), `backend/src/analytics/` (re-exports and the backend run). Terms are defined in [`../definitions.md`](../definitions.md): source data, calculated indicators, report and archive. The client side is in [`analyst-sdk-requirements.md`](analyst-sdk-requirements.md).

## 1. Scope

This document specifies the analytics module. It turns source data into calculated indicators, the calculated indicators into the regime, and the regime into backtests. The regime is one word per day: `risk_on`, `neutral` or `risk_off`. It says whether markets reward risk or punish it.

Two consumers use the module: the backend analytics run and the analyst SDK clients. The code is shared (D57). The backend's compute files are one-line re-exports of the package. The backend's source-client files re-export the package's clients and add the backend's cache, fetch ledger and host adapters. No backend file changes a computed number.

Non-goals:

- Changing how the regime is computed.
- Optimizers, return forecasts, intraday data and live trading.
- A user interface. Output is JSON and CSV.
- Scoring a swarm member's submission. That is a backend feature.

## 2. Principles

- **Pure.** The computation calls no network, reads no database and reads no environment. The purity test in `scripts/tests/unit/analyst-sdk-purity.test.ts` enforces it.
- **JSON in, JSON out.** Every function takes plain data and returns plain data.
- **Same inputs, same numbers.** Two runs on the same inputs give the same output.
- **One source of truth.** The backend runs the package's source files.
- **Report compatibility.** A structural refactor preserves the complete report for identical pinned inputs and methodology: values, dates, labels, nulls and output shape. A numerical change requires a separately identified methodology and explicit approval before production adopts it. All capabilities in this specification remain in scope.

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

Every source series has one id, `<provider>:<symbol>`, for example `yahoo:^GSPC`, `fred:DTB3` or `yahoo:HG=F`. Computation, SDK input reports and new public API contracts use that id. No id names the code that reads it. Existing database keys and historical archive keys may remain unchanged. One shared mapping at the storage boundary translates them to canonical source ids; existing writes use the reverse mapping where needed. The mapping preserves values, dates, ordering, provenance and vintage membership. Ambiguous mappings are rejected. Historical references and immutable archives are never rewritten merely to rename a series.

The indicator registry names the source ids each indicator reads. The correlations and the backtest name the source ids they read: `yahoo:^GSPC` and `yahoo:ETH-USD` (price levels) and `fred:DTB3` (a rate).

### 4.2 Input report

The input is a report of source data. It is a CSV with exactly the header `date,series,value`, where `series` is a source id. The same rows as JSON give byte-identical output.

- **Dates.** A date is a real calendar date in `YYYY-MM-DD` form. Any other date rejects the file.
- **Values.** A value is a plain decimal number, with an optional sign and exponent. Hex, padding and non-finite values reject the file.
- **Unread series.** Source ids that no indicator, correlation or backtest reads are ignored. They do not set the date axis.
- **Date axis.** Without `asof`, the run ends on the latest date of any series the run reads.
- **Missing series.** An indicator with no rows for a source id it reads counts as missing and carries no weight.
- **Correlations and backtest.** The correlations need `yahoo:^GSPC` and `yahoo:ETH-USD`. The backtest also needs `fred:DTB3`. A section whose series are missing is `null`.

### 4.3 Ratios are calculated

The input holds source data only. A ratio of two source series is a calculated indicator, so the input holds both legs. The regime run calculates the ratio.

Eight indicators are ratios of two Yahoo series: `COPPER_GOLD`, `IWM_SPY`, `BTC_ETH`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY` and `XLP_XLY`. For each of them:

- each leg is its own source data, with its own source id (for example `yahoo:HG=F` and `yahoo:GC=F`),
- the transform step calculates the ratio on the dates both legs share, and skips any date where either leg is not a finite number or the denominator is 0,
- a missing leg is a missing input.

A row keyed by a ratio id is a calculated value, not source data. The loader rejects it. New source collections store and serve the legs. Historical stored ratios remain calculated indicators and are retained as original replay inputs with their provenance; they are never relabelled as source data or reconstructed from newly downloaded legs. The historical replay path accepts those inputs under the recorded methodology, separately from the source-only input contract.

Ratio calculation preserves the established operation order and precision, without additional rounding. Before changing production to calculation from legs, comparison against pinned original inputs must demonstrate identical ratios and complete reports. A difference in alignment, missing values, collection time or precision requires an explicit methodology change. Missing historical legs are recorded as unavailable.

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

Model portfolio inputs (eight years of asset prices, lending yields and the T-bill rate) are out of scope for this document.

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
- **Byte budget.** 50 MB served a minute per client ip.
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

### 5.2 Methodology and weights

The backtest identifies its methodology. Production report compatibility uses the established calculation rules: daily returns use the previous target weights without carrying holding drift; costs apply when target weights change; a date without a label is skipped; baselines start at their first priced date while strategies start at their first labelled date. The mixed baseline applies fixed weights daily without charging for that daily reset. Its meaning is constant mix, even where the historical output key is `blend_hodl`.

Historical statistics retain their original conventions, including a zero Sharpe for zero volatility and the out-of-sample starting value from the first point after the split date. Historical field names and shapes are preserved.

The simulator and period statistics below also support the specified drifting-holdings methodology and its date and null rules. Those rules define a distinct methodology. SDK callers select it explicitly; production adoption requires approval and does not reinterpret prior reports. Historical replay selects the recorded methodology and code revision.

### 5.2.1 Weights and schedule

- **Weights.** A list of shares of the portfolio, one per asset id. Cash is an entry. No share is negative. The shares sum to 1.
- **Weight schedule.** The weights in force for each date.
- **Any assets.** An asset id is any source id that has a price series in the input. The module has no list of assets.

### 5.3 Simulator

`simulatePortfolio(dateAxis, schedule, prices, cashRate, options)` returns the value series.

| Input | Meaning |
| ----- | ------- |
| `dateAxis` | The days to replay. |
| `schedule` | Weights for each date. |
| `prices` | A report of source data for each asset id: daily price levels. |
| `cashRate` | A report of source data: the annual cash yield in percent. |
| `options.methodology` | Identifies the compatibility or drifting-holdings rules. Production defaults to compatibility; drifting holdings require explicit selection. |
| `options.costBps` | Cost per unit of one-sided turnover. Default 10 basis points. |

| Output | Meaning |
| ------ | ------- |
| value series | The portfolio value for each day. It starts at 1. |
| trades | The number of dates on which the weights changed. |
| cost | The total cost as a fraction of value. |

The following rules describe the drifting-holdings methodology; compatibility follows section 5.2:

- **No peeking.** Weights set for a date earn from the next day. A day's return uses the previous day's weights.
- **Cost.** When the weights change at a day's close, the portfolio pays the cost on one-sided turnover: the sum of absolute weight changes, halved.
- **Cash.** Cash earns the previous day's annual yield, compounded over 365 days. Cash earns nothing on a day with no earlier yield row.
- **Start.** The series starts on the first date on which every asset in the schedule has a price and the schedule has weights.
- **Gaps.** A price gap is filled forward from the last price. A date with no weights keeps the previous weights, so the portfolio still earns that day's move and pays no cost.
- **Drift.** Between trades, each holding moves with its price, so the weights drift. A trade resets the weights to the schedule. Turnover is measured from the drifted weights to the new ones.
- **Pure.** The same inputs give the same output. The module reads no file and no network.

### 5.4 Period statistics

`periodStats(valueSeries, from, to, options)` uses the explicitly identified methodology, defaulting to compatibility. For the drifting-holdings methodology it returns, for any date range:

- total return,
- annualised growth,
- volatility,
- maximum drawdown inside the range,
- Sharpe ratio: the mean daily return over its standard deviation, annualised over 365 days, as `computeBacktest` reports it.

A trailing window and a market phase are the same call with different dates. The list of windows and phases is input, not part of the module. A range of fewer than two days returns nulls. A range with zero volatility returns a null Sharpe ratio.

An in-sample and out-of-sample split is a pair of `periodStats` calls on either side of the split date. The out-of-sample range starts on the split date, and its growth is measured from the value on that date.

### 5.5 Reference portfolios

The reference portfolios are data:

- `eth`, `sp500` and `mixed`, each with a weights table per regime label,
- the buy-and-hold baselines: a schedule with one entry on the start date and no trades after it,
- the constant-mix baseline: fixed weights, restored by a trade on every date the weights drift,
- the all-cash baseline.

Under the drifting-holdings methodology, every baseline starts on the start date of the strategies it is compared with, so their values and growth compare directly. Compatibility reports preserve their original start dates.

`scheduleFromLabels(labels, table)` turns a regime label report and a weights table into a weight schedule. The reference portfolios run through `simulatePortfolio`. Under the compatibility methodology they give the same value series and statistics as `computeBacktest`; the drifting-holdings methodology is checked against its own stated rules.

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
- **Run manifest.** A run records the input files it used and their hashes, its vintage id, methodology id and exact code revision. Historical runs retain their recorded identity; any supplemental replay metadata is stored separately from immutable reports.
- **Compatibility evidence.** Representative published runs across market regimes, dates and missing-data patterns provide pinned inputs and complete expected outputs. Comparisons cover indicators, panel indices, composites, labels, correlations, daily portfolio values and every statistic. Identical inputs under the same methodology must match exactly. The documented Yahoo persistence tolerance describes differences between collected and persisted inputs; it does not excuse differences introduced by a refactor on identical inputs.
- **Replay.** The ledger starts on 2026-09-21. A published run is replayed from the source data in force at its vintage cutoff, not from the current table.
- **Known drift.** Yahoo-sourced source data is persisted to a relative tolerance (D56). A replay can differ on those series. The README documents the observed drift.
- **What changes after publication.** The current table is not the record. Source data lags and restatements by external parties, and the final-day weight refresh, can move a calculated indicator. Labels amplify small composite changes.

## 7. Success criteria and tests

Package paths are relative to `packages/analyst-sdk/`.

| Criterion | Test |
| --------- | ---- |
| The default regime report matches `tests/golden/regime-report.json`. | `tests/regime.test.ts` |
| `bun test` passes with `fetch` replaced by a thrower. | `tests/no-network.ts` (preload) |
| `bunx tsc --noEmit` is clean. | the package `typecheck` script |
| The computation reads no network, database or environment. Only `src/extract/http.ts` calls `fetch`. | `scripts/tests/unit/analyst-sdk-purity.test.ts` |
| The input rules of section 4.2 hold: bad dates and values reject the file, unread series are ignored and set no date axis, missing series give `null` sections. | `tests/input-rule.test.ts` |
| The source-only loader calculates ratios from legs and rejects ratio-id rows; historical replay preserves original ratio inputs. | `tests/prepare.test.ts` |
| Every exported function has a test. | `tests/*.test.ts` |
| Under the compatibility methodology, reference portfolios give identical daily values and statistics through `simulatePortfolio` and `computeBacktest`. | `tests/backtest.test.ts` |
| Complete reports for representative pinned production inputs match the established methodology exactly, including nulls and output shape. | `backend/tests/regime-replay-published.test.ts` |
| Storage key translation preserves values, dates, ordering and vintage membership; ambiguous mappings reject. | `tests/input-rule.test.ts` |
| Historical ratio inputs replay unchanged; calculation from pinned legs preserves ratios before production adoption. | `tests/prepare.test.ts` |
| No peeking: changing a date's weights does not change the value series up to and including that date. | `tests/backtest.test.ts` |
| Under the drifting-holdings methodology, a date with no weights keeps the previous weights and earns that day's move. | `tests/backtest.test.ts` |
| Under the drifting-holdings methodology, a schedule with one entry and no trades gives the buy-and-hold series. | `tests/backtest.test.ts` |
| Under the same methodology, `periodStats` over the full range matches the simulator's own totals. | `tests/backtest.test.ts` |
| A replay of a published run reproduces the composite, panel indices, labels, correlations and backtest. The Yahoo-sourced series are the stated exception. | `backend/tests/regime-replay-published.test.ts` |
| As-of regime labels match the published record from 2026-09-21 (issue 1182). | `backend/tests/regime-replay-published.test.ts` |
| The API and the replica write byte-identical archives for the same state. | `backend/tests/api/public-analytics-archives.test.ts` |
| A report served for a run is byte-identical on every request, and its checksum matches the stored one. | `backend/tests/api/public-analytics.test.ts` |
| Source data served with `asof` equals the versions collected up to that time, and a later revision does not change it. | `backend/tests/api/public-analytics.test.ts` |
| Every vintage names its members and its published report, and both can be fetched. | `backend/tests/api/public-analytics.test.ts` |
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
