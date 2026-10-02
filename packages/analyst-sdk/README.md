# @robotmoney/analyst-sdk

Pure regime analytics for Robot Money. Give it a raw indicator history, get back the
regime label, per-indicator ranks and weights, correlations and the backtest. It
never calls the network, never reads a database and never reads the environment.
The backend runs this same code (`backend/src/analytics/` re-exports it), so what you
audit here is what production computes. See decision D57 in `docs/decisions.md`.

## Get the source

Only this directory is needed. A shallow, sparse clone fetches just that:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/robotmoney/robotmoney-frontend.git
cd robotmoney-frontend
git sparse-checkout set packages/analyst-sdk
cd packages/analyst-sdk
bun install
```

Requires [bun](https://bun.sh) 1.2 or newer.

## Input: raw indicator history

A CSV with exactly this header, in this order:

```csv
date,indicator,value,source
2024-01-02,VIX,13.2,fred
2024-01-02,BTC_MVRV,1.84,coinmetrics
```

| column      | meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `date`      | `YYYY-MM-DD`                                                                   |
| `indicator` | an indicator id from the registry in `src/analyze/indicators.ts` (for example `VIX`) |
| `value`     | the raw, pre-transform value, a finite number                                  |
| `source`    | where the value came from (free text, kept for provenance, not used in compute) |

Rules:

- A header that is not exactly `date,indicator,value,source` raises `CsvHeaderError`.
  A bad date or value raises `InputRowError` naming the row.
- If an `(indicator, date)` pair repeats, the last row wins.
- Indicators the registry does not know are ignored. Registry indicators with no
  rows count as missing and carry no weight.
- Correlations and the backtest need price levels. Add indicators named `SPX`, `ETH`
  (both) and `TBILL3M` (for the backtest) and those sections are filled. Without
  them they are `null`.

The same rows as JSON work too: an array of `{ "date", "indicator", "value", "source" }`
objects. CSV and JSON of the same rows give byte-identical output.

A real example lives in `tests/fixtures/raw-indicator-history.csv` (and `.json`).

## Run

```sh
bun run regime tests/fixtures/raw-indicator-history.csv            # JSON report on stdout
bun run regime tests/fixtures/raw-indicator-history.json --full    # adds the per-day series
bun run regime my-history.csv --start 2018-01-01                   # first day of the date axis
bun test                                                            # package tests, fetch is a thrower
bunx tsc --noEmit                                                   # typecheck
```

The default report is checked against `tests/golden/regime-report.json`.

From code:

```ts
import { parseRawHistory, toHistory, runRegime, buildReport } from "./src/index.ts";

const rows = parseRawHistory(await Bun.file("my-history.csv").text());
const report = buildReport(runRegime(toHistory(rows)));
```

## Public data API

Not part of this package. The SDK works on any CSV and never needs the API. Raw
history, asset prices, vintages and revisions will be readable from a tokenless
read-only JSON API under `/api/public/analytics/`, and regime outputs from
`GET /api/dashboards/regime-snapshots?include=backtest`. This section gets the
endpoint list, curl examples and per-source data terms when that API lands.

## Layout

```
src/analyze/     regime, backtest, correlations, indicator registry
src/transform/   series math, alignment, transforms
src/input/       CSV and JSON loader
src/run.ts       raw history in, regime report out
bin/regime.ts    the `bun run regime` entry (reads one file; the only I/O)
```

`src/` stays pure: no `node:fs`, `postgres`, `bun:sqlite`, no `process.env`, nothing
from the backend. `scripts/tests/unit/analyst-sdk-purity.test.ts` in the repository
root enforces it.
