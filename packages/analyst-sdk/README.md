# @robotmoney/analyst-sdk

Pure regime analytics for Robot Money. Give it a raw indicator history, get back the
regime label, per-indicator ranks and weights, correlations and the backtest. It
never calls the network, never reads a database and never reads the environment.
The backend runs this same code (`backend/src/analytics/` re-exports it). See decision
D57 in `docs/decisions.md`.

What reproduces, and how exactly. The compute core (`compute.ts`, `math.ts`,
`transforms.ts`, `indicators.ts`, `backtest.ts`, `correlations.ts`) lives here; the
backend files are one-line re-exports of these, so the backend runs the same source
files. On the audited run (ledger run 390, 3066 of 3066 days, 5232 of 5232 correlation
and backtest leaves) the composite, the panel indices, the percentiles, the labels, the
correlations and the backtest reproduced bit-exactly from the persisted inputs. The
Yahoo-sourced indicators are the exception and can drift on another run: they are
persisted only to a relative tolerance (1e-6 for float32 series, 5e-6 for ratios of
two series; decision D56, `backend/src/analytics/source-tolerance.ts`), while a run
computes from the freshly fetched values. A replay can therefore differ, by an
amount that is not bounded by that tolerance. The tolerance applies to `VIX`, `SPX_TREND`, `ETH_TREND` (float32) and
`COPPER_GOLD`, `IWM_SPY`, `BTC_ETH`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY`,
`XLP_XLY` (ratios) in the registry, and to the `backtest:^GSPC` and `backtest:ETH-USD`
price series. Observed on one audited run: `factor_index` differed on some days by up
to 1.4e-4 (30 to 100 times the tolerance, amplified through ranking and weights), and
the last-day weights differed by up to 1.2e-6. The size of the drift on another run is
unknown. The fetched values are not stored, so that
cause is an inference, not a measurement. See "Reproducing a published run" and
"What changes after publication, and why" below.

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
bun run regime my-history.csv --asof 2026-10-05                    # last day of the date axis
bun run regime my-history.csv --factor                            # also report the factor panel
bun test                                                            # package tests, fetch is a thrower
bunx tsc --noEmit                                                   # typecheck
```

The default report is checked against `tests/golden/regime-report.json`.

Options (CLI flag, or the `runRegime(raw, opts)` field):

| option | meaning |
| ------ | ------- |
| `--start D` / `start` | first day of the date axis. Default `2018-01-01`. |
| `--asof D` / `asof` | last day of the date axis, `YYYY-MM-DD`. Input rows dated after it are ignored. Default: the newest date in the input. |
| `--factor` / `factor: true` | also run production's second `computeRegime` call (macro, onchain, factor) and report `factor` (`index`, `percentile`, `regime`, `weights` for the last day, plus a per-day `series` with `--full`). The factor panel is display-only in production, so `composite`, `compositePercentile` and the labels stay the two-panel ones and match the published table. |
| validation | invalid values throw a `RangeError` (the CLI exits 2): `asof` and `start` must be real `YYYY-MM-DD` dates, `asof` must not be before `start`, or before every input row (an `asof` later than the newest row is fine: values are forward-filled, as in production). `--start` and `--asof` need a value, and an unknown flag (such as the former `--panels`) or option field exits 2 or throws rather than being ignored. |

`runRegime` builds its inputs with `prepareRegimeInputs`, the same function production
calls, so the as-of cut for indicator rows, forward-fill and the 120-day cap
(`MAX_FORWARD_FILL_DAYS`) behave as in production. `SPX`, `ETH` and `TBILL3M` rows
dated after the as-of day are cut in both places too (`cutAtAsof`, section 8.1). Their semantics are in [`docs/technical/regime-engine.md` section 8.1](../../docs/technical/regime-engine.md#81-run-semantics-as-of-forward-fill-replay). Both names are exported
from `src/index.ts`.

From code:

```ts
import {
  parseRawHistory,
  toHistory,
  runRegime,
  buildReport,
  forwardFillAge,
  MAX_FORWARD_FILL_DAYS,
} from "./src/index.ts";

const rows = parseRawHistory(await Bun.file("my-history.csv").text());
const report = buildReport(runRegime(toHistory(rows)));

// cut the axis at a day, and compute the factor panel too
const asOf = buildReport(
  runRegime(toHistory(rows), { asof: "2026-10-05", factor: true }),
);
```

### Current-month values (MNA)

The current month's value of a monthly series such as `MNA` (EDGAR filing counts) is
stored at its month-end date and updated through the month. A raw history can
therefore hold a row dated after today (for example `2026-10-31` on 2026-10-05).
Without a cut, the date axis would end there. Use `--asof` (or `runRegime`'s `asof`)
to cut it at the day you mean.

## Reproducing a published run

Each regime run is recorded in the immutable run ledger. To check a published figure,
replay that run's inputs, not the current table.

1. Take the run's payload from `analytics_output_snapshots` (columns `run_id`,
   `artifact_kind`, `payload_bytes` (bytea), `checksum`; `payload_json` exists only in
   the CSV export), joined to `analytics_ledger_runs` on `run_id` with
   `tool_id = 'regime'` and `artifact_kind = 'regime_snapshots'`.
   Do not use `regime_snapshots`: that is a current view (next section). The ledger
   starts on 2026-09-21 (migrations 0058/0059). Before that there is no record of
   published payloads or revisions.
2. Rebuild the inputs from `source_value_versions`: the rows with
   `knowledge_time <=` the run's vintage cutoff
   (`analytics_data_vintages.knowledge_time_cutoff`, not the run's start: the cutoff
   falls after the run row is created, and revisions are written in between), newest
   revision per `source_key` and `market_date`. `analytics_vintage_members` lists the
   exact ids. In SQL shape:

   ```sql
   SELECT DISTINCT ON (source_key, market_date) source_key, market_date, value
   FROM source_value_versions
   WHERE knowledge_time <= :knowledge_time_cutoff
   ORDER BY source_key, market_date, knowledge_time DESC, id DESC;
   ```

   The keys are `raw_indicator_history:<ID>` for each indicator, and
   `backtest:^GSPC`, `backtest:ETH-USD` and `backtest:DTB3` for the `SPX`, `ETH` and
   `TBILL3M` price series.
3. Write them in the input format above and run with `--asof` set to the run's as-of
   date (and `--factor` if you want to check the factor figures):

   ```sh
   bun run regime run-inputs.csv --asof 2026-10-05 --full
   ```

The composite, panel indices, percentiles, labels, correlations and backtest then match
the payload on the audited run (390); the Yahoo-sourced series are the exception, as
above.

## What changes after publication, and why

`regime_snapshots` is a current view. The ledger is the record. A figure you saw on day
D can differ from the same day's figure in the table today, with no change to the
compute code: full-history recompute on every run, FRED publication lag, DefiLlama
restating deep history, and the forced weight refresh on the final axis day. Labels
amplify small composite changes, so a restatement that barely moves the composite can
flip a historical label. The mechanisms and the persistence tolerance are described in
[`docs/technical/regime-engine.md` section 8.1](../../docs/technical/regime-engine.md#81-run-semantics-as-of-forward-fill-replay).

Worked case, as-of 2026-09-26. When shown, the `DXY` value had been forward-filled from
2026-09-18 and `HY_OAS` from 2026-09-24. The real values arrived on 2026-09-28 and the
`HY_OAS` percentile moved from 0.755 to 0.574 and the `DXY` percentile from 0.822 to
0.677. The composite moved from 0.6176 to 0.5482, its percentile from 0.878 to 0.636,
which is below the 0.67 `risk_on` bucket, and the label changed from `risk_on` to
`neutral`. No compute code changed. The ledger payload of the original run still shows
`risk_on`.

## Public data API

Optional, and independent of the SDK: the SDK never calls the network and the API
never needs the SDK. A free, tokenless, read-only JSON API serves the raw inputs
under `/api/public/analytics/`. Every route is GET only (any other method is a
`405`), needs no `Authorization` header (a token changes nothing), and answers
cross-origin requests (`Access-Control-Allow-Origin: *`). The routes, in the contract
as `ROUTES.publicAnalytics` and with a JSON schema per route in
`contract/src/schemas/`:

| route | serves | filters |
| ----- | ------ | ------- |
| `/api/public/analytics/raw-history` | raw indicator history, `date,indicator,value,source` | `indicator`, `from`, `to` |
| `/api/public/analytics/asset-prices` | daily asset closes in USD | `symbol`, `from`, `to` |
| `/api/public/analytics/vintages` | frozen data vintages: run, methodology, cutoffs, digest, members | `run_key`, `tool_id`, `include=members` |
| `/api/public/analytics/overwrite-events` | every recorded revision of a stored row | `table_name` |

```sh
API=https://robotmoney.network

# raw indicator history for one indicator, from a date (the SDK's CSV is this, as columns)
curl -s "$API/api/public/analytics/raw-history?indicator=T10Y2Y&from=2024-01-01&limit=5"

# asset prices
curl -s "$API/api/public/analytics/asset-prices?symbol=ROBOTMONEY&from=2026-03-01&limit=5"

# data vintages, oldest first, by id; one vintage with its members expanded
curl -s "$API/api/public/analytics/vintages?limit=5"
curl -s "$API/api/public/analytics/vintages?run_key=<run_key>&tool_id=<tool_id>&include=members&limit=1000"

# revisions: what a row was before it was overwritten, and what it became
curl -s "$API/api/public/analytics/overwrite-events?table_name=raw_indicator_history&limit=5"

# regime outputs are NOT here: they stay on the dashboards endpoint
curl -s --compressed "$API/api/dashboards/regime-snapshots?include=backtest"
```

Regime outputs and correlations are not duplicated under `/api/public/analytics/`.
Read them from `GET /api/dashboards/regime-snapshots?include=backtest`. Its response
carries `source`, either `regime_snapshots` (the current-view table) or `ledger` (the
immutable run ledger), which says which read path produced it.

When you count published regime runs in `analytics_output_snapshots`, filter on
`analytics_ledger_runs.tool_id = 'regime'` (join on `run_id`; `tool_id` is not a column
of `analytics_output_snapshots`). Artifacts named `regime_snapshots` are empty for research runs
(98 of 239 in the audited export), so counting them overcounts.

### Paging, caching, limits

- **Every list route** takes `limit` (default 100, at most 1000; a larger value is
  clamped, not refused) and `cursor`. A response has `schemaVersion`, `limit`,
  `rows` (`vintages` or `events` on those routes) and `nextCursor`. Pass `nextCursor`
  back as `cursor` until it is `null`. Paging is by key, so a row is never served
  twice. `overwrite-events` rows carry whole stored rows, so a page can hold fewer
  rows than `limit` and still have a `nextCursor`.
- **Vintage members** are listed with `include=members`, one vintage at a time (name it
  with `run_key` and `tool_id`). The same `limit` and `cursor` then page that vintage's
  members, one row per `source_value_versions` id.
- **Caching**: `Cache-Control: public, max-age=300` and a weak `ETag`. Send it back as
  `If-None-Match` and an unchanged page is a `304`. A body over 256 KB is gzip-encoded
  when you send `Accept-Encoding: gzip` (curl: `--compressed`).
- **Rate limit**: 100 requests a minute per client ip, shared by the four routes. Past
  that the answer is `429` with `Retry-After` (seconds). The limit is per api process;
  one api replica runs today.
- **Errors** are `{"error": "..."}`: `400` for a bad parameter or cursor, `404` for a path
  that is not one of the four, `405`, `429`.

### Data terms

Yahoo-sourced rows are served like every other row. The repo operator signed off on that
on 2026-10-02, and recorded it in decision D58 in `docs/decisions.md`. The implementer did
not review any provider's terms of use, and the operator accepts responsibility for serving
the data. Check each provider's terms before you republish what you download.

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

## Rebuilding inputs from raw sources (optional)

`src/extract/` holds the keyless source clients (FRED, Yahoo, DefiLlama, blockchain.com, Coin Metrics, Shiller, EDGAR) and the indicator-to-fetch map. They are the only SDK code that touches the network, and only through `src/extract/http.ts`. Pass your own `fetch` with `configureHttp({ fetch })`. Add `cache` and `recordFetch` hooks to wrap each GET. With no hooks they use `globalThis.fetch` directly. The geckoterminal source needs a host adapter (`SourceExtensions`) and throws without one.
