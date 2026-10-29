# Definitions

These terms are used across the project: the backend, the analyst SDK, the public API and the docs. Each term has one meaning. The first four name the data. The rest support them.

## Source data

Datapoints that come from external sources. Prices, rates and ratios that an external party publishes are examples.

- An external party can revise source data. We never revise it ourselves.
- When we store source data, a changed value is a new version of the value. It is never an edit.
- Source data is stored as the source gives it. We do not combine or adjust it before storing.
- Each source series has one id, `<provider>:<symbol>` (for example `yahoo:^GSPC` or `fred:DTB3`). Computation, SDK inputs and new public API contracts use that id. Existing storage keys may remain behind a shared boundary mapping that preserves historical references. The id never names the code that reads it.
- Examples: a daily close from Yahoo, a rate from FRED, a total value locked from DefiLlama.

## Calculated indicators

Datapoints that we create. We may store them, or keep them in memory at run time.

- They are adjusted prices, levels, percentages, ratios we build, backtested prices, indexes and similar values.
- They depend on source data and on our code. A change in either can change them.
- Examples: copper divided by gold (two source prices that we divide), a 50 to 200 day trend ratio, a 90 day percent change, a percentile rank, a panel index, the composite, a backtested portfolio value.

## Report

A time series of values.

- A report is a collection of source data, of calculated indicators, or of both.
- Examples: the history of one source series is a report. The regime snapshots are a mixed report.

## Archive

A specific file artifact. It collects reports in one CSV file.

- An archive is write-once. Its checksum names it.
- An archive file is usually gzipped.
- Example: `raw_indicator_history.csv.gz`.

## Backtest terms

| Term | Meaning |
| ---- | ------- |
| Weights | The share of a portfolio held in each asset, cash included. The shares sum to 1. |
| Weight schedule | The weights in force for each date. |
| Backtest | A replay of a weight schedule over past source data. |
| Value series | The result of a backtest: the portfolio value for each day. A calculated indicator (a backtested price). |
| Period statistics | Growth, volatility, drawdown and Sharpe over a date range, using the established values, original pre-cost returns and date conventions. A window and a market phase are both date ranges. |
| Turnover | The share of the portfolio that a trade moves: the sum of absolute weight changes, halved. |
| Buy-and-hold | A schedule with one entry and no trades. The weights drift with prices. |
| Constant mix | A schedule that holds fixed weights by trading back to them whenever they drift. |

These descriptive terms do not change existing reference calculations. In particular, `blend_hodl` retains its historical key and fixed-target daily behavior. This refactor does not add a drifting-holdings simulator.

Choosing the weights is not part of a backtest. A backtest takes a weight schedule as input.

## Related terms

These terms support the four above.

| Term | Meaning |
| ---- | ------- |
| Backup | A directory of archives written at one moment, named by that moment (the backup id). Its `backup.json` describes it. |
| Format 1 | The layout of a backup, as csvb (`packages/csvb`) and the public archive routes write it through one module (D72, D80). A backup is cut at each UTC day boundary; earlier snapshot-time backups stay valid. |
| Version | One collected value of source data, with the time we observed it. A revision by the external party adds a version. It never edits one. |
| Published report | The report one analytics run created. It is kept byte for byte and never changes. |
| Vintage | The record of one run: the source data versions it read and the report it published. A later run adds a vintage. The sequence of vintages is the revision history of the reports. |
| Source id | The canonical code and public contract name of a source series, `<provider>:<symbol>`, for example `yahoo:^GSPC`. |
| Leg | One of the two source series a ratio divides. |
| Methodology | The identified calculation rules used by a run. Replay also records the exact code revision. This refactor preserves one shared calculation: identical inputs and options produce byte-identical report payloads in backend and SDK before and after it. Methodology metadata records provenance and does not select alternative calculation rules. |
| Run | One execution of the analytics module, named by its run key. It reads one vintage of source data and publishes one report. |
| As-of | The last date a run may use. Source data dated later is ignored. |
| Supported series | A source series the platform collects. It reaches an analyst through the local copy (a csv-backups clone or the API fill) or the public API, already cleaned and in the input file format. |
| Supplementary series | A source series an analyst collects outside the platform, for an asset or a date range the platform does not carry. It is source data under the same rules, stored in the supplementary directory with a manifest. The SDK's `fetch` command fetches the common providers (Yahoo, FRED). |
| Supplementary directory | The directory on an analyst's machine that holds supplementary series, one file per source id. It is never the local copy and never inside or around it. |
| Local copy | The backups on an analyst's machine. It holds supported series only. |
| Fill | A way to bring the local copy up to date: from the csv-backups repo (data only), from the API or from the database with csvb. A repo clone and an API increment join at the legacy junction backup (D80). A fill never writes supplementary series. |
| Watermark | The last id or time the local copy holds for one table. A fill fetches only what is past it. |
| Input file | A report of source data for one run, written from the local copy. The analyst SDK computes from it. |
| Manifest | The sidecar of an input file. It names the backup, the run, the as-of date, the fill, the row count, the input file's checksum, the methodology id and exact code revision. |

## Terms these definitions replace

| Old term | Where it appears | Use instead |
| -------- | ---------------- | ----------- |
| raw indicator history, raw value, pre-transform value | SDK README, `raw_indicator_history` | source data |
| floor, persisted-real floor | `regime-engine.md` | stored source data |
| transformed value, percentile, aligned value | `regime-engine.md` | calculated indicator |
| indicator (the series) | registry, code | source data when it is the input, calculated indicator when it is a result |
| ledger key, extras, `SPX`, `ETH`, `TBILL3M`, `backtest:` keys | `LEDGER_EXTRA_KEYS`, ledger | the source id, for example `yahoo:^GSPC` |
| frozen run output, report snapshot, output snapshot | `analytics_output_snapshots`, issue 1182, section 4.8 | published report |
| blend hodl | `computeBacktest` (`blend_hodl`) | constant mix |

The name `raw_...` denotes source data in new contracts. Historical storage names do not reclassify calculated values as source data.

## Ratios

A ratio of two source series is a calculated indicator. We build it, so we store the two source series and calculate the ratio from them.

`COPPER_GOLD`, `IWM_SPY`, `BTC_ETH`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY` and `XLP_XLY` are calculated indicators. Each has two source series as inputs. A ratio that an external party publishes as one series is source data.

Historical stored ratios remain calculated indicators. They are preserved as original replay inputs with provenance when the original legs are unavailable. New source collection stores the legs; historical replay never substitutes newly downloaded data.
