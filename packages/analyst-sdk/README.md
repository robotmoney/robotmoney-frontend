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

### Paging, caching, limits

- **Every list route** takes `limit` (default 100, at most 1000; a larger value is
  clamped, not refused) and `cursor`. A response has `schemaVersion`, `limit`,
  `rows` (`vintages` or `events` on those routes) and `nextCursor`. Pass `nextCursor`
  back as `cursor` until it is `null`. Paging is by key, so a row is never served
  twice. `overwrite-events` rows carry whole stored rows, so a page can hold fewer
  rows than `limit` and still have a `nextCursor`.
- **Vintage members** are listed with `include=members`, one vintage at a time (name it
  with `run_key` and `tool_id`). The same `limit` and `cursor` then page that vintage's
  members, one row per `source_value_versions` id. `member_count` is the frozen count
  before the withheld rows below are removed.
- **Caching**: `Cache-Control: public, max-age=300` and a weak `ETag`. Send it back as
  `If-None-Match` and an unchanged page is a `304`. A body over 256 KB is gzip-encoded
  when you send `Accept-Encoding: gzip` (curl: `--compressed`).
- **Rate limit**: 100 requests a minute per client ip, shared by the four routes. Past
  that the answer is `429` with `Retry-After` (seconds). The limit is per api process;
  one api replica runs today.
- **Errors** are `{"error": "..."}`: `400` for a bad parameter or cursor, `404` for a path
  that is not one of the four, `405`, `429`.

### Data terms

The rows are third-party data. What each source allows us to republish is recorded in
decision D58 in `docs/decisions.md`, and summarized here. Rows of a source marked
"withheld" are never served, whatever you ask for (the response says
`excludedProviders: ["yahoo"]`). Status "pending" means the terms page is linked and the
operator has not yet recorded a sign-off. Check the linked terms before you republish.

| source | feeds | terms | status |
| ------ | ----- | ----- | ------ |
| FRED | `T10Y2Y`, `DFII10`, `T5YIE`, `HY_OAS`, `DXY`, `ICSA` | https://fred.stlouisfed.org/docs/api/terms_of_use.html | pending; `HY_OAS` is third-party (ICE) content on FRED |
| DefiLlama | `DEFI_TVL`, `STABLES`, `DEFI_GROWTH`, `STABLES_GROWTH` | https://defillama.com/docs/api | pending |
| blockchain.com | `BTC_ACTIVE` | https://www.blockchain.com/legal/terms | pending |
| Coin Metrics community data | `ETH_ACTIVE`, `BTC_MVRV` | https://coinmetrics.io/community-network-data/ | pending |
| GeckoTerminal | `NEW_TOKENS`, `asset-prices` rows from `geckoterminal` | https://www.coingecko.com/en/api_terms | pending |
| Shiller / multpl.com | `SHILLER_CAPE` | http://www.econ.yale.edu/~shiller/data.htm | pending |
| SEC EDGAR | `MNA` | https://www.sec.gov/privacy#dissemination | public information |
| pinned prices | `asset-prices` rows from `pinned` (USDC and the strategy shares) | our own configuration | ours |
| Yahoo Finance | `VIX`, `COPPER_GOLD`, `SPX_TREND`, `IWM_SPY`, `BTC_ETH`, `ETH_TREND`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY`, `XLP_XLY` | n/a | **withheld**: no redistribution right is on record |

You can still rebuild the Yahoo-backed indicators yourself with the extractors in
`src/extract/`, from your own copy of the data.

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
