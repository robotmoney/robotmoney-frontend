# @robotmoney/analyst-sdk

Pure regime analytics for Robot Money. Give it source data, get back the
regime label, per-indicator ranks and weights, correlations and the backtest. The
computation never calls the network, never reads a database and never reads the
environment. Only the optional source clients in `src/extract/` fetch.
The backend runs this same code (`backend/src/analytics/` re-exports it). See decision
D57 in `docs/decisions.md`.

The refactor preserves one shared calculation: identical effective inputs and report options produce byte-identical report payloads in the backend and SDK. This includes every backtest statistic, date, null, field order and number formatting. A separate backend compatibility engine is outside its scope.

Numerical methodology (decision D78 in `docs/decisions.md`): every sum, mean, variance, dot product, correlation and compounding product is computed in error-free (compensated) arithmetic and rounded once, so on real data it is the correctly rounded exact value of the inputs (`src/transform/exact.ts`). This changed published numbers in their last bits, up to 9e-12 relative where a result is near zero, and changed no label, percentile rank, sign or displayed value on any fixture. A payload published before it therefore replays up to rounding, not byte for byte: same structure, labels and nulls, numbers within rounding. Payloads computed by this code replay byte for byte. Provider collection and archive downloads finish during extract; all later stages run from supplied data without HTTP, including on missing inputs.

What this package is specified to do: [`docs/technical/analytics-requirements.md`](../../docs/technical/analytics-requirements.md) (the module the backend and the SDK share) and [`docs/technical/analyst-sdk-requirements.md`](../../docs/technical/analyst-sdk-requirements.md) (the client side). Terms (source data, calculated indicators, report, archive) are defined in [`docs/definitions.md`](../../docs/definitions.md).

What reproduces, and how exactly. The compute core (`compute.ts`, `math.ts`,
`transforms.ts`, `indicators.ts`, `backtest.ts`, `correlations.ts`) lives here; the
backend files are one-line re-exports of these, so the backend runs the same source
files. On the audited run (ledger run 390, 3066 of 3066 days, 5232 of 5232 correlation
and backtest leaves) the composite, the panel indices, the percentiles, the labels, the
correlations and the backtest reproduced bit-exactly from the persisted inputs under the arithmetic of the time; since D78 the same inputs give the same labels and numbers that differ only in their last bits. The
Yahoo-sourced indicators are the exception and can drift on another run: they are
persisted only to a relative tolerance (1e-6 for float32 series, 5e-6 for ratios of
two series; decision D56, `backend/src/analytics/source-tolerance.ts`). Runs before
issue 1421 computed from the freshly fetched values, so a replay of such a run can
differ, by an amount that is not bounded by that tolerance. Since issue 1421 a run
computes from the committed (stored) values, so its replay reproduces it. The tolerance applies to `VIX`, `SPX_TREND`, `ETH_TREND` (float32) and
`COPPER_GOLD`, `IWM_SPY`, `BTC_ETH`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY`,
`XLP_XLY` (ratios) in the registry, and to the `backtest:^GSPC` and `backtest:ETH-USD`
price series. Observed on one audited run: `factor_index` differed on some days by up
to 1.4e-4 (30 to 100 times the tolerance, amplified through ranking and weights), and
the last-day weights differed by up to 1.2e-6. The size of the drift on another run is
unknown. The fetched values are not stored, so that
cause is an inference, not a measurement. See the quickstart and "What changes after publication, and why" below.

## Get the source

Only this directory is needed. A shallow, sparse clone fetches just that.

A released version is a tag `analyst-sdk-vA.B.C` (decision D77 in
`docs/decisions.md`, accepted). Each minor version ships from its own `analyst-sdk/releases-A.B.x` branch.
To get a released version, clone its tag:

```sh
git clone --branch analyst-sdk-vA.B.C --depth 1 --filter=blob:none --sparse https://github.com/robotmoney/robotmoney-frontend.git
cd robotmoney-frontend
git sparse-checkout set packages/analyst-sdk
cd packages/analyst-sdk
bun install
```

For the latest code, clone `main`:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/robotmoney/robotmoney-frontend.git
cd robotmoney-frontend
git sparse-checkout set packages/analyst-sdk
cd packages/analyst-sdk
bun install
```

Requires [bun](https://bun.sh) 1.2 or newer.

## Quickstart: rerun a published run

Three stages, in order. Only the first one touches the network. From then on the
SDK reads local files: preparation, the regime run, the backtest and the report make
no HTTP request, and a missing input is an error, never a download.

**1. Get a local copy (acquisition).** A local copy is a directory of format 1 backups
(`csv/<backup id>/backup.json` plus the gzipped archives it lists), the layout csvb
writes into robotmoney/csv-backups and the public archive routes serve (see "Archives
(format 1)"). The archive tool, csvb, lives beside this package in `packages/csvb` and
will own these fills (`csvb backup --source api`; its download client is follow-up issue
1436). Until then the API-only fill is these shell commands
(`curl`, `jq`, `gunzip`, `sha256sum`): list the sealed backups, and for each backup not yet in
the copy fetch every archive its record lists, check each one's `sha256_raw` (the hash of its uncompressed bytes, so any gzip encoder's output verifies), and write
the record last, so an interrupted backup is fetched again and never half-kept. `curl
--retry` waits out a `429` or `503` with its `Retry-After`.

<!-- readme-test: acquire -->
```sh
API="${API:-https://robotmoney.network/api/public/analytics}"
fill() {
  mkdir -p "$1/csv"
  curl -fsS --retry 8 "$API/archive/backups?limit=1000" | jq -r '.backups[].record' | while read -r rec; do
    case "$rec" in ''|.|*/|/*|*..*|*[!A-Za-z0-9._/-]*) echo "bad path" >&2; exit 1;; esac
    [ -f "$1/$rec" ] && continue
    curl -fsS --retry 8 "$API/archive/$rec" -o "$1/$rec.part" --create-dirs
    jq -r '.append_only[].files[] | "\(.sha256_raw)  \(.bytes_raw)  \(.path)"' "$1/$rec.part" | while read -r sum raw path; do
      case "$raw" in ''|*[!0-9]*) echo "bad bytes_raw" >&2; exit 1;; esac
      [ "$raw" -le 67108864 ] || { echo "bytes_raw over 64 MiB" >&2; exit 1; }
      case "$path" in ''|.|*/|/*|*..*|*[!A-Za-z0-9._/-]*) echo "bad path" >&2; exit 1;; esac
      curl -fsS --retry 8 "$API/archive/$path" -o "$1/$path" --create-dirs
      # Read at most bytes_raw + 1 inflated bytes, so a hostile gzip cannot fill the disk.
      gunzip -c "$1/$path" 2>/dev/null | head -c $((raw+1)) > "$1/$path.raw" || true
      got="$(wc -c < "$1/$path.raw")"; hash="$(sha256sum < "$1/$path.raw" | cut -d' ' -f1)"; rm -f "$1/$path.raw"
      [ "$got" = "$raw" ] && [ "$hash" = "$sum" ] || { echo "corrupt: $path" >&2; exit 1; }
    done || return 1
    mv "$1/$rec.part" "$1/$rec"
  done
}
fill api-copy
```

That is the API-only fill, the path for outside analysts. Holders of read access to
the private robotmoney/csv-backups repo can start from a clone of its backups instead
and fetch only the increment: the same `fill` skips every backup the copy already
holds. Here the first recorded backup stands in for the clone:

<!-- readme-test: acquire -->
```sh
mkdir -p repo-copy/csv
cp -R tests/fixtures/archive/api-recorded/csv/2001-01-02T000000Z repo-copy/csv/
fill repo-copy
```

The repo and the public routes cut the same backups through one format module (D80): one
backup per UTC day. The repo's older backups are named by their snapshot time and end at
the legacy junction backup `2026-10-28T180400Z`, which the routes serve too, so an
increment fetched from the API continues a clone of the repo from there. Both fills give
the same local copy for the same backup id.
`tests/fixtures/archive/api-recorded/` is a recording of what the real archive routes
serve for two synthetic regime runs (`backend/tests/analyst-sdk-public-archive-recording.test.ts`
keeps it equal to the routes), and the package's tests replay it as a local API, so
every command here runs as written with no private access.

**2. Write the run's input.** `bun run inputs` reads the local copy, checks that every
file its backup records list is present and matches its recorded SHA-256 and row count,
finds the run's frozen vintage and writes exactly those source values:

<!-- readme-test: run -->
```sh
bun run inputs --archive api-copy --run 0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2 --out api-fill
bun run inputs --archive repo-copy --run 0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2 --out repo-fill
cmp api-fill/inputs.csv repo-fill/inputs.csv
cmp api-fill/inputs.manifest.json repo-fill/inputs.manifest.json
```

Each `--out` folder gets `inputs.csv` (or `inputs.json` with `--json`) and its sidecar
`inputs.manifest.json`: the backup id, the run key, the as-of date, the acquisition
source of that backup (`api` or `db`), the row count and SHA-256 of the input file, the
run's methodology and the exact code revision the run recorded. `--as-of <backup id>`
reads the copy as of an older backup. The command refuses an incomplete copy (a listed
file missing, a backup missing from the chain), a corrupt one (a hash or row count that
does not match, a listed path outside its backup), a vintage whose members are not all
in the copy, and an existing output.

**3. Run it.** A published run's vintage holds stored ratio values, so its input is in
the historical replay contract and needs `--replay`. Pass the run's as-of date:

<!-- readme-test: run -->
```sh
bun run regime api-fill/inputs.csv --replay --asof 2026-08-15
bun run regime api-fill/inputs.csv --replay --asof 2026-08-15 --provenance
```

The first prints the report. The second prints the same report inside a provenance
envelope, `{"pinned": true, "manifest": {...}, "report": {...}}`, after checking that the
sidecar describes this exact file. An input with no sidecar still runs; its envelope is
`{"pinned": false, "report": {...}}`:

<!-- readme-test: run -->
```sh
bun run regime tests/fixtures/raw-indicator-history.csv --provenance
```

A relative path resolves from the folder you ran the command in, also under `bun run`.

## Read a local copy in code

`bun run inputs` is one use of the archive reader, which the package exports
(`src/archive/local-copy.ts`). `openArchive(files, asOf?)` opens a local copy as of a
backup id (or its newest backup) and returns a `LocalCopy`, after the same checks the
command makes: backup selection, the watermark chain, the bounded inflate, the SHA-256 of
every listed file and the row count of every file it reads. It is pure: `files` is an
`ArchiveFiles`, `{ root, backupDirs(): string[] | null, read(path): Uint8Array | null }`,
over paths relative to the copy with `/` separators (`root` only names the copy in
messages). On disk, `openLocalCopy(dir, asOf?)` in `bin/local-copy.ts` wraps it with the
node:fs reader `diskArchiveFiles(dir)`.

```ts
import { openLocalCopy } from "./bin/local-copy.ts";
import { collectRunInputs } from "./src/index.ts";

const copy = openLocalCopy("api-copy");
const run = collectRunInputs(copy, "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2"); // one run's frozen vintage
const { header, rows } = copy.revisedTable("raw_indicator_history");
const prices = copy.latestValues(["backtest:^GSPC", "backtest:ETH-USD", "backtest:DTB3"]);
```

- `copy.revisedTable(table)` is a revised table (`regime_snapshots`,
  `raw_indicator_history`, `asset_prices`) as of the copy's as-of backup: every selected
  backup's `revisions/<table>.csv.gz` applied in backup order (an upsert or a delete by
  the key columns its record names), without the `_backup` and `_op` columns, rows sorted
  by key column by column. A NULL stays `null`. A backup record whose revision names no
  key, an empty key or a key column that is not a non-empty string is refused when the
  copy opens.
- `copy.latestValues(sourceKeys)` is the newest `source_value_versions` value per storage
  key and market date (the highest id, compared as a BigInt), each tagged with the input
  id it is read under (`SPX`, `ETH`, `TBILL3M` for the three above), sorted by market date
  then storage key. A key no input id is read under is refused. These are the newest
  values, not a run's vintage: a published run's inputs come from `collectRunInputs`.
- `copy.tables`, `copy.versions()`, `copy.files(table)` and `copy.readRows(file)` are the
  run-ledger tables, the `source_value_versions` rows and any listed data file.

## Input files

Three contracts. Each has a CSV form and an equivalent JSON form (an array of objects
with the same keys); the same rows give byte-identical output.

| contract | CSV header | use |
| -------- | ---------- | --- |
| source | `date,series,value` | source data you collected yourself; `series` is a source id (`<provider>:<symbol>`, D74) |
| historical replay | `date,series,value,kind` | a published run's frozen inputs (`bun run inputs` writes it); needs `--replay` |
| legacy raw history | `date,indicator,value,source` | the earlier format, kept as an adapter; the committed fixture uses it |

```csv
date,series,value
2024-01-02,yahoo:^VIX,13.2
2024-01-02,coinmetrics:btc.CapMVRVCur,1.84
```

| column | meaning |
| ------ | ------- |
| `date` | a real calendar date, `YYYY-MM-DD` |
| `series` | source form: a source id, which `src/series-ids.ts` maps to the ids the run reads (`yahoo:^GSPC` feeds `SPX_TREND` and the correlations' and backtest's `SPX`). Replay form: any name the mapping reads, an input id (`VIX`, `SPX`), a storage key or a source id. Legacy form: the `indicator` column, an input id |
| `value` | the raw, pre-transform value: a plain decimal with an optional sign and exponent |
| `kind` | replay only: `source`, or `calculated` for a stored ratio value |

Rules, for every contract:

- A header that is not exactly one of the three raises `CsvHeaderError`. A date that is
  not a real calendar date (`2026-02-30`), or a value that is not a plain decimal (hex
  `0x10`, padding ` 1`, `NaN`, `Infinity`), raises `InputRowError` naming the row.
- If a `(series, date)` pair repeats, the last row wins.
- Series the run does not read are ignored (the model portfolio inputs, for example). They do not set the date axis. An input
  with no series the run reads is an error, and so is one where no composite panel has
  an observation on or before the as-of day (`CoverageError`).
- Registry indicators with no rows count as missing and carry no weight.
- Correlations need `SPX` and `ETH`; the backtest also needs `TBILL3M`. Without them
  those sections are `null`.

**Calculated ratios.** Eight indicators are ratios of two Yahoo series (`COPPER_GOLD`,
`IWM_SPY`, `BTC_ETH`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY`, `XLP_XLY`). Their
stored values are calculations, not source data. The source contract rejects a row for
one of them, by its id or its storage key (`CalculatedRowError`). The replay contract
carries them as kind `calculated`, exactly as stored; their legs are never invented.
A source input carries both legs instead (for example `yahoo:HG=F` and `yahoo:GC=F`),
and the run calculates the ratio with `mergeRatioSeries`. One leg alone, with no stored
ratio, throws `MissingRatioLegError` naming the ratio and the missing leg. A stored ratio,
when present, is used unchanged.

A real example lives in `tests/fixtures/raw-indicator-history.csv` (and `.json`).

## Run

```sh
bun run regime tests/fixtures/raw-indicator-history.csv            # JSON report on stdout
bun run regime tests/fixtures/raw-indicator-history.json --full    # adds the per-day series
bun run regime my-history.csv --start 2018-01-01                   # first day of the date axis
bun run regime my-history.csv --asof 2026-10-05                    # last day of the date axis
bun run regime my-history.csv --factor                             # also report the factor panel
bun test                                                           # package tests, every HTTP client is a thrower
bunx tsc --noEmit                                                  # typecheck
```

The default report is checked against `tests/golden/regime-report.json`.

Options (CLI flag, or the `runRegime(raw, opts)` field):

| option | meaning |
| ------ | ------- |
| `--start D` / `start` | first day of the date axis. Default `2018-01-01`. |
| `--asof D` / `asof` | last day of the date axis, `YYYY-MM-DD`. Input rows dated after it are ignored. Default: the newest date of any series the run reads. |
| `--factor` / `factor: true` | also run production's second `computeRegime` call (macro, onchain, factor) and report `factor` (`index`, `percentile`, `regime`, `weights` for the last day, plus a per-day `series` with `--full`). The factor panel is display-only in production, so `composite`, `compositePercentile` and the labels stay the two-panel ones and match the published table. |
| `--replay` | accept the historical replay contract (`parseInput(text, { replay: true })`). |
| required data | at least one composite panel (macro, on-chain) needs a registry indicator with a row on or before the as-of day, or `runRegime` throws the named `CoverageError` (the CLI exits 1). It never fetches to fill the gap. Optional inputs give a missing result instead: without `SPX` and `ETH`, `correlations` and `backtest` are `null`; without `TBILL3M`, `backtest` is `null`; without factor indicators, the `factor` figures are `null`. |
| `--provenance` | print `{pinned, manifest, report}` instead of the bare report; see the quickstart. The report inside is unchanged. |
| validation | the CLI exits 2 on a usage error: a second input file, an option given twice, an unknown option (such as the former `--panels`), an option missing its value, an invalid `start`/`asof` (real `YYYY-MM-DD` dates, `asof` not before `start` or every input row), a `start` after every input row. It exits 1 on a runtime failure: an unreadable or malformed input, a manifest that does not match its input. `runRegime` throws a `RangeError` for the same option errors. |

`runRegime` builds its inputs with `prepareRegimeInputs`, the same function production
calls, so the as-of cut for indicator rows, forward-fill and the 120-day cap
(`MAX_FORWARD_FILL_DAYS`) behave as in production. `SPX`, `ETH` and `TBILL3M` rows
dated after the as-of day are cut in both places too (`cutAtAsof`, section 8.1). Their semantics are in [`docs/technical/regime-engine.md` section 8.1](../../docs/technical/regime-engine.md#81-run-semantics-as-of-forward-fill-replay). Both names are exported
from `src/index.ts`.

From code:

```ts
import { parseInput, runRegime, buildReport } from "./src/index.ts";

const input = parseInput(await Bun.file("my-history.csv").text());
const report = buildReport(runRegime(input.history));

// cut the axis at a day, and compute the factor panel too
const asOf = buildReport(runRegime(input.history, { asof: "2026-10-05", factor: true }));
```

### Current-month values (MNA)

The current month's value of a monthly series such as `MNA` (EDGAR filing counts) is
stored at its month-end date and updated through the month. A source data report can
therefore hold a row dated after today (for example `2026-10-31` on 2026-10-05).
Without a cut, the date axis would end there. Use `--asof` (or `runRegime`'s `asof`)
to cut it at the day you mean.

## Supplementary series: data the platform does not carry

The SDK works with two kinds of source data (decision D79 in `docs/decisions.md`;
analyst SDK requirements section 4):

- **Supported series** are the ones the platform collects. The public API and the
  csv-backups repo serve them cleaned and versioned, and they reach you through the
  local copy (the quickstart above). Use them as they come.
- **Supplementary series** are everything else: an asset the platform does not
  collect, or an earlier start than it holds. You fetch them yourself and keep them
  in a **supplementary directory**, one file per series, in a format the SDK reads.

Keep the supplementary directory apart from the local copy: not the same folder, not
inside it, not around it. The SDK refuses one that is.

**Fetch.** The SDK ships fetchers for Yahoo and FRED, so you do not need to write
your own:

```sh
bun run fetch --into my-series yahoo:GC=F yahoo:SOL-USD fred:DTB3
bun run fetch --into my-series --start 2010-01-01 --end 2024-12-31 --replace yahoo:SPY
```

`--start` defaults to 2016-01-01 and `--end` to today. Each series lands at
`<dir>/<provider>/<symbol>.csv` with the symbol percent-encoded (`yahoo:GC=F` is
`yahoo/GC%3DF.csv`). An existing series is kept unless you pass `--replace`. A series
that fails is reported, and the rest are still fetched.

**Format.** Each file is a source input file (`date,series,value`, one source id,
dates strictly ascending), so the input loaders read it as they read any source input. Beside it,
`<symbol>.manifest.json` records what the values are (`field`: Yahoo's adjusted close,
FRED's value), the row count, the date range, the file's SHA-256, and when and how it
was fetched:

```json
{
  "format": 1,
  "series": "yahoo:GC=F",
  "field": "adjusted close (the close where Yahoo gives no adjusted close)",
  "row_count": 2717,
  "first_date": "2016-01-04",
  "last_date": "2026-10-27",
  "sha256": "…",
  "fetched_at": "2026-10-28T12:00:00.000Z",
  "fetched_by": "analyst-sdk 0.3.1 fetch, https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?…"
}
```

**Read.** `openSupplementary(files).read("yahoo:GC=F")` (`src/input/supplementary.ts`)
returns the points and the manifest, after checking the file against its manifest's
series, SHA-256, row count and date range; `.list()` lists the source ids. It is pure:
`files` is a `SupplementaryFiles`, `{ read(path): Uint8Array | null, list(): string[] }`
over paths relative to the directory, the same `read` shape as the archive reader's
`ArchiveFiles`. On disk, `readSupplementary(dir, id)` and `listSupplementary(dir)`
(`bin/supplementary-dir.ts`) wrap it with the node:fs reader `supplementaryFiles(dir)`. A series from another provider goes in with
`writeSupplementary(dir, id, points, { field, fetched_at, fetched_by })`. The format
itself is `src/input/supplementary.ts`, and `fetchSupplementary(id, { start, end })`
(`src/extract/supplementary.ts`) is the fetch without the write.

The SDK never merges the two directories. If a supported series and a supplementary
series share a source id, your code picks the directory it reads. A result computed
from a supplementary series is your own analysis: it has no vintage and is not a
published report, and its manifest is its provenance.

## Backtest your own portfolio

The backtest the report carries is one shared calculation, exposed for any assets and
weights you have prices for. It does not choose weights; it takes them.

```ts
import { simulatePortfolio, periodStats, scheduleFromLabels, PORTFOLIO_SPECS } from "./src/index.ts";

// Target weights per date (null: no applicable weights, the date is skipped with its
// market move). Nonnegative, finite, summing to 1; `cash` earns the cash rate.
const schedule = dateAxis.map(() => ({ "yahoo:GLD": 0.4, "yahoo:SPY": 0.4, cash: 0.2 }));
const sim = simulatePortfolio(dateAxis, schedule, { "yahoo:GLD": gld, "yahoo:SPY": spy }, tbillPercent, { costBps: 10 });
const full = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, trades: sim.trades });
const year = periodStats(sim.values, "2025-01-01", "2025-12-31", { returns: sim.returns, trades: sim.trades });

// The reference portfolios are data: a regime label series through a weight table.
const ethSchedule = scheduleFromLabels(labels, PORTFOLIO_SPECS.eth.weights);
```

The rules are the established ones, unchanged: a date's return uses the previous target
weights and that date's price change; a change of target weights at the close costs
one-sided turnover (half the sum of absolute weight changes) times `costBps` (default
10); cash earns the previous day's annual percent yield, `(1 + y / 100) ** (1 / 365) - 1`
(evaluated as `expm1(log1p(y / 100) / 365)`), and zero before the first yield; prices are
forward-filled; the simulation starts at the first date every supplied asset is priced,
then at the first date with weights. Equity compounds unrounded (D78): each daily value
is the exact product of the growth and cost factors so far, rounded once.
`sim` carries the net daily values, the pre-cost daily returns, each trade's turnover
and cost, and the start and end dates. `periodStats` uses the pre-cost returns for
the Sharpe (mean / sample sd, annualized over 365 days, no risk-free subtraction, 0 at
zero volatility, which since D78 includes any run of bit-identical returns), the net values for growth and drawdown, and years of 365.25 days; a
different window or `splitDate` never changes the full-range figures.
`computeBacktest` is exactly these three functions over the reference portfolios.

### Drift-aware simulation

`simulatePortfolio` resets the book to the target every day. `simulateDrift` takes the
same four inputs and lets holdings drift between rebalances:

```ts
import { simulateDrift, periodStats } from "./src/index.ts";

const drift = simulateDrift(dateAxis, schedule, prices, tbillPercent, { costBps: 10, freq: "monthly", band: 0.05 });
const stats = periodStats(drift.values, drift.startDate, drift.endDate, { returns: drift.returns, trades: drift.trades });
```

Inputs are checked exactly as for `simulatePortfolio`, and the run starts on the same date
with the holdings at the target and no cost. Each later date earns the drifted weights'
return, then each weight becomes `w (1 + r_k) / (1 + r_p)`, rounded once (D78). The book
rebalances to the day's target when the target changed since the last rebalance, when the
calendar rule fires against the previous axis date, or when any weight is more than `band`
from its target. `freq` is `"daily"` (the default), `"weekly"` (the first date of a new
Monday-to-Sunday week), `"monthly"` (a new month), `"quarterly"` (a new January, April,
July or October) or `"never"`; `band` defaults to none and `costBps` to 10. A rebalance
whose one-sided turnover exceeds 1e-9 costs turnover times `costBps / 10000` and is
recorded in `trades`. An unknown option key, a negative or non-finite `costBps` or `band`,
an unknown `freq`, or a day whose portfolio factor `1 + r_p` is not positive throws a
`RangeError` naming the field or the date. With `costBps: 0` and `freq: "daily"` the values
and returns equal `simulatePortfolio`'s bit for bit.

From the command line, one fixed-target portfolio (weights in percent of NAV, summing to
100; `cash` earns the input's `TBILL3M`, `fred:DTB3`):

```sh
bun run backtest my-portfolio.json my-prices.csv --from 2025-01-01 --to 2025-12-31 --cost-bps 10
```

`my-portfolio.json` is for example `{ "BTC": 10, "GOLD": 6, "cash": 84 }`. Each holding is
checked against the Base asset universe first (`--universe <path>` swaps in your own file)
and priced from the universe asset's `series` in the input. A holding outside the universe
or over a cap is refused (exit 2) unless `--allow-outside-universe` is set, in which case it
is priced from the input series named by the holding itself (`"yahoo:WIDGET": 5`). A
yield series (`defillama-yields:`) is not a price and is refused. Missing price coverage
exits 1 and names the series; the command never fetches. It prints the portfolio, the
universe check and the statistics; `--full` adds the daily values, returns and trades.

## Size and optimise a portfolio

The backtest takes weights; these functions choose them. Every solver returns a certified
optimum or throws `UnsupportedError`: there is no approximate fallback (D78). A NaN or
Infinity in the covariance, the excess returns or the risk aversion throws, and a
`markowitzSchedule` `cov` callback that returns one, or the wrong shape, throws `RangeError`.

```ts
import { markowitzSizing, markowitzBacktest, ercCertified, simulateDrift } from "./src/index.ts";

// Today's sizing from closes (Point[] per asset id): the dates every asset in `mu` is
// priced, from `from` to `end`, simple returns, a 20% shrunk annual covariance.
const today = markowitzSizing({
  closes: { SPX: spx, ETH: eth, GLD: gld },
  mu: { SPX: 0.075, ETH: 0.25, GLD: 0.055 }, // annual fractions, per asset
  rf: 0.04,
  lambdas: [2, 4, 8, 16],
  from: "2018-05-15",
});
today.tangency;        // { weights, cash, expReturn, vol, sharpe }, fully invested
today.byLambda[1].book; // mean-variance at lambda 4, the rest in cash

// A monthly re-optimised backtest: weights from the history strictly before each date.
const bt = markowitzBacktest({
  dateAxis, returns, assets: ["SPX", "ETH", "GLD"], cashRate: tbillPercent, prices,
  mu: (date, history) => myPointInTimePriors(date, history),
});
bt.schedule; bt.rebalances; bt.simulation; bt.stats;
```

**Solvers** (`src/allocate/optimize.ts`, on a covariance `S` and excess returns `ex`):

| Function | Problem |
|---|---|
| `ercCertified(S, budgets?)`, `ercExact` | budgeted equal risk contribution (damped Newton on `1/2 w'Sw - sum b ln w`); weights sum to 1; certified to a relative budget violation of at most `ERC_TOL` (4e-15) |
| `minVarExact(S)` | long-only minimum variance, fully invested |
| `meanVarExact(S, ex, lambda)` | `argmax ex'w - lambda/2 w'Sw`, `w >= 0`, `sum w <= 1`, the rest cash; all cash when no excess return is positive |
| `tangencyExact(S, ex)` | long-only maximum Sharpe, fully invested; the best single asset by `ex_i / sigma_i` when no excess return is positive |

The last three enumerate every support (`supports(n)`, `2^n - 1` of them) and check the KKT
conditions off it; ties go to the higher objective, then fewer assets, then the lower index.
`ercResidual`, `minVarResidual`, `meanVarResidual` and `sharpeResidual` grade any weights on
the same scale and add the point's infeasibility, so only a feasible optimum scores at rounding
size. Budgets are normalised to sum 1; a zero, negative or non-finite budget throws, naming its
index. Each support is solved by `solveRefined` (`src/transform/linalg.ts`): rows and columns
balanced by powers of two, LU with partial pivoting, refinement with compensated residuals
(`residual2`) to below half an ulp. It throws when the matrix is singular, when the balanced
condition number times eps is at least 1, or when refinement stalls above one rounding.

**Covariance** (`src/allocate/covariance.ts`): `annualCov(rows, periodsPerYear = 252)` is
`covarianceMatrix` of the columns (each entry the correctly rounded exact sample covariance)
times `periodsPerYear`; `shrinkToDiagonal(S, s = SHRINK)` multiplies each off-diagonal entry
by `1 - s` and keeps the diagonal bit for bit; `shrunkCov(rows, s, periodsPerYear)` is the two.
`SHRINK` is 0.2. `correlationMatrix` gives the sample correlations.

**Sizing** (`src/allocate/markowitz.ts`): `markowitzBooks({ returns, assets, rf, mu, lambdas })`
takes daily return rows (days x assets, so blended bucket returns work) and returns the
tangency book and one mean-variance book per lambda. A weight within `zeroTol` (1e-12) is
reported as 0; cash is `1 - sum w`, compensated; `expReturn` dots weights and cash with `mu`
and `rf`; `vol` is `sqrt(w'Sw)`; `sharpe` is `(expReturn - rf) / vol` as one compensated dot,
or null at zero volatility. `markowitzSizing` builds the rows from closes and adds `asof`,
`from`, `nObs` and `corr`. A missing asset, a non-finite `rf` or `mu`, a lambda that is not
positive and fewer than two common dates throw `RangeError`.

**Schedule and backtest.** `markowitzSchedule(options)` returns `{ schedule, rebalances }`;
`markowitzBacktest(options)` adds `simulation` and `stats` (periodStats over the
simulation's own start and end dates). On each re-optimisation date the history is the
return rows dated on or after `from` and strictly before the date; with fewer than `minObs`
rows the weights stay null. rf is the last `cashRate` value on or before the date divided by
100. The weights hold until the next re-optimisation.

Every step can be tuned. Options are one object; an unknown key throws `RangeError` naming it.

| Option | Default | |
|---|---|---|
| `mu(date, history, dates)` | required | expected annual returns per asset (a record or an array), your point-in-time priors |
| `rule` | `"meanVar"` | `"meanVar"` (`meanVarExact` at `lambda`, the rest cash) or `"tangency"` |
| `solve(mu, S, rf)` | the rule | any solver: `(mu, S) => ercCertified(S)`, risk budgets, `minVarExact`, inverse volatility, naive |
| `cov(history)` | `shrunkCov(history, shrink, periodsPerYear)` | any covariance estimate |
| `lookback` | expanding window | a rolling window of the last `lookback` rows |
| `reoptimise` | `"monthly"` | `"weekly"` (a new Monday-to-Sunday week), `"monthly"`, `"quarterly"` (a new calendar quarter), or `(date, prevDate) => boolean` (`prevDate` is null on the first axis date) |
| `expand(weights, date)` | identity | maps optimizer weights (`cash` plus one key per asset) onto the day's priced holdings; null leaves the day unset |
| `simulate` | `simulatePortfolio` | `{ drift: { freq, band, costBps } }` for `simulateDrift`, or any `(dateAxis, schedule, prices, cashRate) => SimulationResult` |
| `minObs`, `from`, `shrink`, `periodsPerYear`, `costBps`, `lambda`, `zeroTol`, `splitDate` | 252, every return, 0.2, 252, 10, 4, 1e-12, `BACKTEST_IN_SAMPLE_END` | |

`expand` output must pass the simulator's weight checks (nonnegative, summing to 1). A
solver that returns a negative or over-budget weight throws `RangeError`. `markowitzBooks`,
`markowitzSchedule`, `simulateDrift`, `periodStats` and every solver return plain data, so
you can also compose them yourself.

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
never needs the SDK. A free, tokenless, read-only JSON API serves source data and its revisions
under `/api/public/analytics/`. Every route is GET only (any other method is a
`405`), needs no `Authorization` header (a token changes nothing), and answers
cross-origin requests (`Access-Control-Allow-Origin: *`). The routes, in the contract
as `ROUTES.publicAnalytics` and with a JSON schema per route in
`contract/src/schemas/`:

| route | serves | filters |
| ----- | ------ | ------- |
| `/api/public/analytics/raw-history` | source data for the indicators, `date,indicator,value,source` | `indicator`, `from`, `to` |
| `/api/public/analytics/asset-prices` | daily asset closes in USD | `symbol`, `from`, `to` |
| `/api/public/analytics/vintages` | frozen data vintages: run, methodology, cutoffs, digest, members | `run_key`, `tool_id`, `include=members` |
| `/api/public/analytics/overwrite-events` | every recorded revision of a stored row | `table_name` |
| `/api/public/analytics/source-versions` | every collected version of source data, with the time it was observed | `series` (the storage key), `from`, `to`, `asof` (the versions in force then) |
| `/api/public/analytics/reports` | each run's published report: a list, or with `run` or `vintage` the report's exact bytes | `run`, `vintage` |
| `/api/public/analytics/archive/backups` | the sealed format 1 backups, oldest first | |
| `/api/public/analytics/archive/` | a backup's `backup.json` and every archive it lists, at `archive/` + the record's `path` | |

```sh
API=https://robotmoney.network

# source data for one indicator, from a date (the SDK's CSV is this, as columns)
curl -s "$API/api/public/analytics/raw-history?indicator=T10Y2Y&from=2024-01-01&limit=5"

# asset prices
curl -s "$API/api/public/analytics/asset-prices?symbol=ROBOTMONEY&from=2026-03-01&limit=5"

# data vintages, oldest first, by id; one vintage with its members expanded
curl -s "$API/api/public/analytics/vintages?limit=5"
curl -s "$API/api/public/analytics/vintages?run_key=<run_key>&tool_id=<tool_id>&include=members&limit=1000"

# revisions: what a row was before it was overwritten, and what it became
curl -s "$API/api/public/analytics/overwrite-events?table_name=raw_indicator_history&limit=5"

# every collected version of one series, and the versions in force at a time
curl -s "$API/api/public/analytics/source-versions?series=backtest:DTB3&limit=5"
curl -s "$API/api/public/analytics/source-versions?series=backtest:DTB3&asof=2026-10-01T00:00:00Z"

# published reports, then one run's report byte for byte (its ETag is its SHA-256)
curl -s "$API/api/public/analytics/reports?limit=5"
curl -s -o report.json "$API/api/public/analytics/reports?run=<run_key>"

# format 1 archives: the backups, one backup's record, and an archive it lists
curl -s "$API/api/public/analytics/archive/backups"
curl -s "$API/api/public/analytics/archive/csv/<backup id>/backup.json"
curl -s -o x.csv.gz "$API/api/public/analytics/archive/csv/<backup id>/data/<table>.<start>_<end>.csv.gz"

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
- **Immutable bodies**: a report and every archive file carry
  `Cache-Control: public, max-age=31536000, immutable` and a strong `ETag` that is their
  SHA-256 (also in `X-Content-SHA256`). A matching `If-None-Match` is a `304`, answered
  without reading the body.
- **Limits** (per client ip, per api process; one api replica runs today): 100 tokens a
  minute, where a list costs 1 and a report's bytes or an archive body cost 10; and
  50 MB a minute, where a request is admitted while any is left and an archive is charged
  in full. Past either the answer is `429` with `Retry-After` (seconds). At most two public
  queries run at once and each has a 5 s timeout; past that the answer is `503` with
  `Retry-After`.
- **Errors** are `{"error": "..."}`: `400` for a bad parameter or cursor, `404` for a path
  that is not a route, `405`, `429`, and `503` (busy, a timed-out query, or a backup record
  still being prepared).

### Archives (format 1)

The archive routes serve format 1, the layout csvb writes into robotmoney/csv-backups,
through the same module (`src/archive/format1.ts`; one writer, D80). A backup is one UTC
day: `<day>T000000Z` holds every row of the append-only tables (source data versions, the
run ledger, vintages and their members, published outputs and reports, recorded revisions)
stamped before that midnight and after the previous backup. A day is listed once it is an
hour past. The one exception is the legacy junction, `2026-10-28T180400Z`: the newest
backup csvb wrote before the day cut, served between the day cuts around it so the repo's
chain and the API's chain meet there. Its record, `backup.json`, lists each archive with its row count, id range,
watermarks and SHA-256s; an archive is `<table>.<start>_<end>.csv.gz`, at most 64 MB
uncompressed, the rows as Postgres COPY CSV text. A sealed backup never changes. List the
backups, fetch each record past your watermark, then each archive it lists, and check
`sha256_raw`, the SHA-256 of the archive's uncompressed bytes, before you keep it. Gzip is only a transport encoding, so decompress first and hash the result. The revised tables (`raw_indicator_history`,
`asset_prices`, `regime_snapshots`) have no revision archives here; read their current
values from the list routes above.

### Data terms

Yahoo-sourced rows are served like every other row. The repo operator signed off on that
on 2026-10-02, and recorded it in decision D58 in `docs/decisions.md`. The implementer did
not review any provider's terms of use, and the operator accepts responsibility for serving
the data. Check each provider's terms before you republish what you download.

## Layout

```
src/analyze/     regime, backtest, correlations, indicator registry
src/transform/   series math, alignment, transforms
src/input/       the input loaders, the manifest, the provenance envelope and the supplementary series format
src/archive/     reading a format 1 local copy: completeness, a run's vintage, the input file
                 (format1.ts), and the reader over injected files (local-copy.ts: openArchive,
                 revised tables, latest values)
src/run.ts       source data in, regime report out
src/coverage.ts  required-data check (CoverageError)
bin/regime.ts    the `bun run regime` entry (reads one file and its sidecar)
bin/inputs.ts    the `bun run inputs` entry (reads a local copy, writes one input and its sidecar)
bin/local-copy.ts  the node:fs side of the archive reader: openLocalCopy(dir, asOf)
bin/backtest.ts  the `bun run backtest` entry (one portfolio, gated by the universe)
bin/fetch.ts     the `bun run fetch` entry (Yahoo and FRED series into a supplementary directory)
bin/supplementary-dir.ts  the node:fs side of the supplementary directory: its reader, and writing
bin/check-universe.ts  the `bun run universe:check` entry
src/allocate/universe.ts  the Base asset universe: loadUniverse, checkHoldings
src/allocate/rules.ts     rule files: validateRuleFile, parseRuleFile (types.ts holds the format)
src/allocate/optimize.ts  the certified solvers: ERC and risk budgets, minimum variance, mean-variance, maximum Sharpe
src/allocate/covariance.ts  annualCov, shrinkToDiagonal, shrunkCov
src/allocate/markowitz.ts  Markowitz sizing, the point-in-time schedule and the Markowitz backtest
src/transform/linalg.ts   covarianceMatrix, correlationMatrix, solveRefined (dependency-free LU)
bin/check-rule.ts the `bun run rules:check` entry
universe/        base-universe.json (the shipped universe), groups.csv and series.csv (its export inputs)
rules/           the shipped rule files, all inside the universe
rules-outside-universe/  rule files that hold assets or weights outside it
```

`src/` stays pure: no `node:fs`, `postgres`, `bun:sqlite`, no `process.env`, nothing
from the backend, no csvb, and no HTTP outside `src/extract/http.ts`; nothing outside
`src/extract/` reaches an extractor, directly or through its imports.
`scripts/tests/unit/analyst-sdk-purity.test.ts` in the repository root enforces it.

`tests/fixtures/originals/` holds the report bytes captured from the pre-refactor code
(issue 1421; `manifest.json` names the commit, the commands and each file's sha256).
`tests/report-parity.test.ts` compares the current output with them value by value
(`tests/support/numeric-diff.ts`): any change of structure, field order, label, null or
integer, or any number moved by more than rounding, fails it. Byte equality ended with
the compensated arithmetic of D78. They are never regenerated from later code.

## The Base asset universe

`universe/base-universe.json` lists the assets a model portfolio may hold on Base: per asset its id (the name a rule file uses), name, sleeve, chain, contract, liquidity, yield, tier (`eligible`, `watchlist` or `speculative`), its own cap (`maxWeight`, percent of NAV) and its price or yield series (`<provider>:<symbol>`). The file holds the 55 assets of the Base Permissionless Asset Universe sheet. Rule files name the nine reference holdings by short ids (`USDC`, `SUSDS`, `SPARK`, `GT`, `STEAK`, `AAVE`, `COMP`, `GOLD`, `BTC`); every other asset is its sheet id in capitals (`AAVE_TOKEN` is the sheet's `aave` token). The group caps are data in the same file: Sky 35, Aave 35, Morpho 30, Morpho V2 12, one group per Morpho curator at 12 (Gauntlet, Steakhouse, SparkDAO, Moonwell), Compound 10, Bitcoin 10, US equity 10 and Gold 6.

A field the sheet leaves empty (contract, liquidity, yield) or that has no source (`series`) is `null`, and the asset's `unavailable` map says why: `"unavailable": { "yieldPct": "the sheet cell is empty" }`. The map has one entry per null field (`contract`, `liquidityUsd`, `yieldPct`, `series`) and none for a field that has a value. A contract that is not a `0x` address in the sheet (`various ...`, `market-specific`) loads as `null` with the sheet's words in the reason, never a made-up address. `series` is set only for the assets whose price or yield the model portfolio inputs read. `exported` is the date the file was built, `source` says from what.

`loadUniverse()` returns the shipped file; `loadUniverse(json)` validates a parsed file of your own. `checkHoldings({ risk_off: {...}, neutral: {...}, risk_on: {...} }, universe)` returns one finding per holding that is not in the universe or is over its own cap, and per group over its cap, each naming the state, the holding and the cap. An empty array means the holdings fit. `bun run universe:check <holdings.json> [--universe <path>] [--allow-outside-universe]` runs the check from the command line on a JSON map of state to holding weights. It prints one line per finding to stderr and exits 2 on findings unless `--allow-outside-universe` is set. `--universe <path>` swaps in your own universe file (read in `bin/`, since `src/` reads no files).

`bun run universe:export <assets.csv> [--groups groups.csv] [--series series.csv] [--exported YYYY-MM-DD]` rebuilds the file from a CSV export of the sheet (`universe/groups.csv` holds the group caps from the sheet's Notes column, `universe/series.csv` the source ids). The shipped file was built from the owner's export of 2026-10-26: `bun run universe:export tests/fixtures/base-universe-sheet.csv --groups universe/groups.csv --series universe/series.csv --exported 2026-10-26`.

## Rule files

A model portfolio is a JSON rule file, not code, so you can change one without touching the SDK. The shipped ones are in `rules/`. Every field is checked by `validateRuleFile(json)` (`src/allocate/rules.ts`), which returns a list of errors, each starting with the path of the field it is about (`states.neutral: weights sum to 99, not 100`). An empty list means the file is valid. `parseRuleFile(json)` returns the typed file or throws `RuleFileError` with every error. `bun run rules:check <rule.json> [--universe <path>] [--allow-outside-universe]` runs the same check from the command line and exits 2 on any error.

Caps are not in a rule file. They come from the universe (`universe/base-universe.json`, above): `validateRuleFile` checks every holding with `checkHoldings` against it. Pass `{ universe }` to use your own, or `{ allowOutsideUniverse: true }` to skip the check, like the CLI flag.

| Field | What it holds |
|---|---|
| `id`, `name`, `author` | Who wrote it and what it is. `id` is the file name without `.json`. |
| `date` | `YYYY-MM-DD`, when it was written. |
| `status` | `reference` (the model portfolio), `hypothesis` (a proposal) or `comparison` (a row to compare against). |
| `description` | Optional. |
| `drift` | When to trade back to the target: a holding has drifted when it is more than `max(points, relative × target)` away. `byHolding` overrides `points` for one holding. |
| `label` + `states` | One weight set per regime state. `label` picks the state: `composite`, `conservative` or `aggressive` (the panel votes), each needing `risk_off`, `neutral` and `risk_on`; or `fixed`, which holds only `neutral`, every week. Each state's weights are percent of NAV and sum to 100. |
| `engine` | Instead of `states`. `neutral` is the neutral portfolio (sums to 100). Each of `sleeves` tilts one risky holding by one `signal` (`composite`, `macro`, `onchain`, `indicator:<ID>`, `research:<id>`, `mean(...)`, `inverse(...)`; see `src/allocate/signals.ts`) inside its band `min`..`max`, which must contain the neutral weight, with z = (signal − 0.5) ÷ `scale`, and an optional `volTarget` (annualized percent). `buffer` is the cash holding. `dollarBook.instruments` are the holdings the yield program fills, highest `trailingDays` yield first. Every neutral holding is a sleeve, the buffer or an instrument. |

A file has `states` or `engine`, never both, and any other field is an error. A worked example, an engine rule: Bitcoin between 0 and 10% on the composite, gold between 2 and 6% on the inverse of the composite, 2% cash, the rest in the dollar book. Check it with `bun run rules:check example.json`.

```json
{
  "id": "example",
  "name": "Bitcoin and gold tilted by the composite",
  "author": "Your name",
  "date": "2026-10-23",
  "status": "hypothesis",
  "engine": {
    "neutral": { "USDC": 2, "SUSDS": 24, "SPARK": 11, "GT": 12, "STEAK": 7, "AAVE": 28, "COMP": 5, "GOLD": 6, "BTC": 5 },
    "sleeves": [
      { "holding": "BTC", "signal": "composite", "min": 0, "max": 10, "scale": 0.17 },
      { "holding": "GOLD", "signal": "inverse(composite)", "min": 2, "max": 6, "scale": 0.17 }
    ],
    "buffer": "USDC",
    "dollarBook": { "instruments": ["AAVE", "SUSDS", "GT", "SPARK", "STEAK", "COMP"], "trailingDays": 30 }
  },
  "drift": { "points": 2, "relative": 0.25, "byHolding": { "BTC": 3 } }
}
```

`rules/` holds the reference rule `R1` (the Base policy portfolio moved by the composite label), `R1-frozen` (the same portfolio held still), `R2` (the engine with Lex's two research previews on the Bitcoin sleeve) and the engine versions `E0` (sleeves held still, dollar book by yield) to `E3` (with Bitcoin volatility scaling). Every file in `rules/` fits the shipped universe. `rules-outside-universe/` holds the files that do not: the three alternative portfolios as fixed weights (`P-A1` with Coinbase stocks, `P-B` multi-chain, `P-C` with KYC) and the engine versions with Bitcoin up to 20% (`E1w` to `E3w`). They validate only with `--allow-outside-universe`.

## Rebuilding source data from the original sources (optional)

`src/extract/` holds the keyless source clients (FRED, Yahoo, DefiLlama, blockchain.com, Coin Metrics, Shiller, EDGAR) and the indicator-to-fetch map. They are the only SDK code that touches the network, and only through `src/extract/http.ts`. Pass your own `fetch` with `configureHttp({ fetch })`. Add `cache` and `recordFetch` hooks to wrap each GET. With no hooks they use `globalThis.fetch` directly. The geckoterminal source needs a host adapter (`SourceExtensions`) and throws without one.

### Model portfolio inputs

`inventory/model-portfolio.json` lists every source series the model portfolio workflow reads: asset prices (`yahoo:BTC-USD`, `yahoo:ETH-USD`, `yahoo:GLD`, `yahoo:USDC-USD`, `yahoo:^GSPC`), the lending supply rates (`defillama-yields:<pool>`, DefiLlama `apyBase`: Aave v3 USDC on Base and Ethereum, and the other Base universe pools) and the 3-month T-bill rate (`fred:DTB3`). Every Base universe asset with a `series` (`universe/base-universe.json`) has an entry. Each entry carries its source id, provider, units, requested start, real inception, any proxy with its provenance, any known limitation and the storage key it is recorded under. `loadInventory()` validates it and fails on a missing field. `extractInventorySeries(entry)` (`src/extract/model-portfolio.ts`) fetches one series: an empty response is `NoObservationsError`, a failed or malformed one is `SeriesExtractError`, and a late start is a coverage limitation. No row is invented and no proxy is spliced in. `requireCoverage(series, history, { from, to })` names each missing series and date range; it never fetches. Series the regime does not read do not set the regime's date axis, so carrying them in the same input changes no regime number. An input file may also use the source-data form: the header `date,series,value` (or JSON `{date, series, value}`), where `series` is a source id; dates must be real calendar dates and values plain decimal numbers.
