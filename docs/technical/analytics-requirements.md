# Analytics requirements

Owner: Lucas. Code: `packages/analyst-sdk` (shared), `backend/src/analytics/` (re-exports and the backend run). Terms are defined in [`../definitions.md`](../definitions.md): source data, calculated indicators, report and archive. The client side is in [`analyst-sdk-requirements.md`](analyst-sdk-requirements.md).

## 1. Scope

This document specifies the analytics module. It turns source data into calculated indicators, the calculated indicators into the regime, and the regime into backtests. The regime is one word per day: `risk_on`, `neutral` or `risk_off`. It says whether markets reward risk or punish it.

Two consumers use the module: the backend analytics run and the analyst SDK clients. The code is shared (D57). The backend files are one-line re-exports of the package.

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

### 4.1 Input report

The input is a report of source data. It is a CSV with exactly the header `date,indicator,value,source`. The same rows as JSON give byte-identical output. Indicators the registry does not know are ignored. Registry indicators with no rows count as missing and carry no weight. The source data `SPX` and `ETH` (price levels) and `TBILL3M` (a rate) fill the correlations and the backtest. Without them those sections are `null`.

### 4.2 Ratios are calculated

The input holds source data only. A ratio of two source series is a calculated indicator, so the input holds both legs. The regime run calculates the ratio.

Eight indicators are ratios of two Yahoo series: `COPPER_GOLD`, `IWM_SPY`, `BTC_ETH`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY` and `XLP_XLY`. For each of them:

- each leg is its own source data (for example `HG=F` and `GC=F`),
- the transform step calculates the ratio on the dates both legs share, and skips any date where the denominator is 0,
- a missing leg is a missing input.

The archives follow the same rule.

### 4.3 The public API

A free, tokenless, read-only JSON API serves source data and its revisions under `/api/public/analytics/`. Every route is GET only. The routes are:

| Route | Serves |
| ----- | ------ |
| `raw-history` | Source data for the 26 indicators. Filters: `indicator`, `from`, `to`. |
| `asset-prices` | Source data: daily asset closes in USD. Filters: `symbol`, `from`, `to`. |
| `vintages` | Frozen sets of source data for each run: run, methodology, cutoffs, digest, members. |
| `overwrite-events` | Every recorded revision of a stored row. |

Calculated indicators are not here. The regime outputs come from `/api/dashboards/regime-snapshots?include=backtest`.

### 4.4 Archive format

There is one archive format: format 1, the layout robotmoney/csv-backups writes (decision D71). The module adds no second format.

- **Backups.** One directory per backup, named by the snapshot time (`csv/<backup id>/`). Each holds `backup.json` and archives.
- **Write-once.** A backup only adds archives. Nothing is overwritten.
- **Two kinds of archive.** Data archives only gain rows. They hold every observed version of source data (`source_value_versions`), the run ledger and the vintages. Revision archives hold the rows that are new or changed since the last backup, with `_backup` and `_op` columns. They cover `raw_indicator_history`, `asset_prices` and `regime_snapshots`. The state at any backup is the replay of the revision archives up to it.
- **Pinning.** A backup id names an exact state. `csvb resolve --as-of <id>` returns a report as of that backup.
- **Provenance.** `backup.json` records `source` (`db` or `api`) and `consistency` (`snapshot` or `paged`).
- **Location.** Backups live outside this repo. The tool refuses a backup directory inside a checkout of this repo.
- **Access.** The csv-backups repo is private and holds production data.

### 4.5 The API serves archives

The API serves archives in format 1. A client downloads archives and writes them into its local copy unchanged. It does not rebuild them from JSON pages.

- **Data archives.** Served as `<table>.<start>_<end>.csv.gz`, with the same columns and the same COPY CSV text as a backup.
- **Revision archives.** Served with the `_backup` and `_op` columns.
- **Backups.** Archives are grouped by backup id, and a `backup.json` describes each backup. A client lists the backups, then fetches only the archives past its watermark.
- **Same bytes.** The API and the replica produce byte-identical archives for the same state.
- **Coverage.** Every report in a backup is served with full history. That includes the source data the correlations and the backtest read (`SPX`, `ETH` and `TBILL3M`).

Model portfolio inputs (eight years of asset prices, lending yields and the T-bill rate) are out of scope for this document.

### 4.6 Chunking

Archives are the unit of transfer. A chunk is one archive.

- **Size.** An archive is at most 90 MB, as the csv-backups tool writes it (`--part-mb`, default 64), because GitHub rejects files over 100 MB.
- **Naming.** A data archive is named by the earliest and latest row time it holds. A client picks archives by name, without opening them.
- **Write-once.** A served archive never changes. Its checksum is its identity.
- **Watermarks.** A client holds, per table, the last id or time it has. It asks only for archives past that point, so a second run costs only what changed.
- **Lists.** Listing the backups and their archives is a small request. Archive bodies are separate requests.

### 4.7 Server load protection

Public traffic must never starve the site. These limits apply to every public analytics route, archive routes included.

- **Concurrency gate.** At most 2 public-analytics queries run at once, process-wide. Beyond that the API answers 503 with `Retry-After`. Public traffic holds at most 2 of the 10 pool connections.
- **Statement timeout.** Every public query runs with a 5 second timeout. A timed-out query answers 503 and frees its connection.
- **Cost-weighted rate limit.** 100 tokens a minute per client ip. A list request costs 1. A heavy request costs 10: an archive of a large table, or a frozen run output.
- **Byte budget.** 50 MB served a minute per client ip.
- **Async compression.** Gzip runs off the event loop, so a large response cannot stall other routes.
- **Caching.** A served archive is immutable. Its ETag is its checksum, read by a metadata query before any bytes. A matching `If-None-Match` answers 304 without reading the archive. A 200 carries `Cache-Control: public, max-age=31536000, immutable`. Lists carry `max-age=300`.
- **Edge cache.** The web server caches `GET /api/public/analytics/*` with a lock, so concurrent misses reach the API once. The cache is bounded (256 MB) and sets `X-Cache-Status`.
- **Vendor-neutral client identity.** The rate limit keys on `X-Client-IP`, which the web server sets from its resolved address. No CDN rule is involved.

### 4.8 Data terms

Yahoo-sourced rows are served like every other row (D58). Check each provider's terms before you republish what you download.

## 5. Backtest

### 5.1 Purpose

The backtest replays a portfolio over past source data. It answers: what would the portfolio have been worth if it had held these weights on these dates? The result is a value series, which is a calculated indicator, plus period statistics.

The backtest does not choose weights. It takes them as input.

### 5.2 Weights and schedule

- **Weights.** A list of shares of the portfolio, one per asset id. Cash is an entry. No share is negative. The shares sum to 1.
- **Weight schedule.** The weights in force for each date.
- **Any assets.** An asset id is any key that has a price series in the input. The module has no list of assets.

### 5.3 Simulator

`simulatePortfolio(dateAxis, schedule, prices, cashRate, options)` returns the value series.

| Input | Meaning |
| ----- | ------- |
| `dateAxis` | The days to replay. |
| `schedule` | Weights for each date. |
| `prices` | A report of source data for each asset id: daily price levels. |
| `cashRate` | A report of source data: the annual cash yield in percent. |
| `options.costBps` | Cost per unit of one-sided turnover. Default 10 basis points. |

| Output | Meaning |
| ------ | ------- |
| value series | The portfolio value for each day. It starts at 1. |
| trades | The number of dates on which the weights changed. |
| cost | The total cost as a fraction of value. |

Rules:

- **No peeking.** Weights set for a date earn from the next day. A day's return uses the previous day's weights.
- **Cost.** When the weights change at a day's close, the portfolio pays the cost on one-sided turnover: the sum of absolute weight changes, halved.
- **Cash.** Cash earns the previous day's annual yield, compounded daily.
- **Start.** The series starts on the first date on which every asset in the schedule has a price.
- **Gaps.** A price gap is filled forward from the last price. A date with no weights is skipped.
- **Pure.** The same inputs give the same output. The module reads no file and no network.

### 5.4 Period statistics

`periodStats(valueSeries, from, to)` returns, for any date range:

- total return,
- annualised growth,
- volatility,
- maximum drawdown inside the range,
- Sharpe ratio: the mean daily return over its standard deviation, annualised over 365 days, as `computeBacktest` reports it.

A trailing window and a market phase are the same call with different dates. The list of windows and phases is input, not part of the module. A range of fewer than two days returns nulls.

### 5.5 Reference portfolios

The reference portfolios are data:

- `eth`, `sp500` and `mixed`, each with a weights table per regime label,
- the buy-and-hold baselines and the all-cash baseline.

`scheduleFromLabels(labels, table)` turns a regime label report and a weights table into a weight schedule. The reference portfolios run through `simulatePortfolio` and give the same value series as `computeBacktest`.

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
- **Run manifest.** A run records the input files it used and their hashes, and the run's vintage id.
- **Replay.** The ledger starts on 2026-09-21. A published run is replayed from the source data in force at its vintage cutoff, not from the current table.
- **Known drift.** Yahoo-sourced source data is persisted to a relative tolerance (D56). A replay can differ on those series. The README documents the observed drift.
- **What changes after publication.** The current table is not the record. Source data lags and restatements by external parties, and the final-day weight refresh, can move a calculated indicator. Labels amplify small composite changes.

## 7. Success criteria and tests

- The default regime report matches `tests/golden/regime-report.json`.
- `bun test` passes with `fetch` replaced by a thrower.
- `bunx tsc --noEmit` is clean.
- A replay of a published run reproduces the composite, panel indices, labels, correlations and backtest. The Yahoo-sourced series are the stated exception.
- Every function has a test.
- The reference portfolios give the same value series through `simulatePortfolio` as through `computeBacktest`.
- The no-peeking rule has a test: changing a date's weights does not change the value series up to and including that date.
- A schedule that never changes gives the same series as a buy-and-hold simulation.
- `periodStats` over the full range matches the simulator's own totals.
- The API and the replica write byte-identical archives for the same state.
- As-of regime labels match the published record from 2026-09-21 (issue 1182).

## 8. Open decisions

None.

## 9. References

- [`../definitions.md`](../definitions.md)
- [`analyst-sdk-requirements.md`](analyst-sdk-requirements.md)
- `packages/analyst-sdk/README.md`
- Decisions D56 (persistence tolerance), D57 (the package as a shared seam), D58 (data terms), D71 (archive format 1)
- `docs/technical/regime-engine.md` section 8.1
- `docs/technical/research-signals.md`
- Issue 1095 (the SDK and the four routes)
- Issue 1182 (frozen publications)
