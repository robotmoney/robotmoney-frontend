# Definitions

These terms are used across the project: the backend, the analyst SDK, the public API and the docs. Each term has one meaning. The first four name the data. The rest support them.

## Source data

Datapoints that come from external sources. Prices, rates and ratios that an external party publishes are examples.

- An external party can revise source data. We never revise it ourselves.
- When we store source data, a changed value is a new version of the value. It is never an edit.
- Source data is stored as the source gives it. We do not combine or adjust it before storing.
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
| Period statistics | Growth, volatility, drawdown and Sharpe ratio of a value series over a date range. A window and a market phase are both date ranges. |

Choosing the weights is not part of a backtest. A backtest takes a weight schedule as input.

## Related terms

These terms support the four above.

| Term | Meaning |
| ---- | ------- |
| Backup | A directory of archives written at one moment, named by that moment (the backup id). Its `backup.json` describes it. |
| Format 1 | The layout of a backup, as robotmoney/csv-backups writes it. |

## Terms these definitions replace

| Old term | Where it appears | Use instead |
| -------- | ---------------- | ----------- |
| raw indicator history, raw value, pre-transform value | SDK README, `raw_indicator_history` | source data |
| floor, persisted-real floor | `regime-engine.md` | stored source data |
| transformed value, percentile, aligned value | `regime-engine.md` | calculated indicator |
| indicator (the series) | registry, code | source data when it is the input, calculated indicator when it is a result |

A table or a field called `raw_...` holds source data.

## Ratios

A ratio of two source series is a calculated indicator. We build it, so we store the two source series and calculate the ratio from them.

`COPPER_GOLD`, `IWM_SPY`, `BTC_ETH`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY` and `XLP_XLY` are calculated indicators. Each has two source series as inputs. A ratio that an external party publishes as one series is source data.
