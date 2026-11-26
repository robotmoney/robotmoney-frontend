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
(format 1)"). The archive tool, csvb, lives beside this package in `packages/csvb`, and
`csvb backup --source api` fills a local copy from the public archive routes, with no
credentials. Add it to a sparse clone with `git sparse-checkout add packages/csvb contract`,
then run `bun install` in `packages/csvb`. csvb lists the sealed backups and, for each one the
copy lacks, fetches its record and every archive it lists. It checks each archive's size,
`sha256_raw` (the hash of its uncompressed bytes, so any gzip encoder's output verifies) and
row count, and moves a backup into the copy only once all of it verifies, so an interrupted
backup is fetched again and never half-kept. It paces itself to the public rate limits,
and it stops after `--max-requests` requests (default 500) with exit 3, so `fill` runs it
again until it is done (`packages/csvb/README.md`, "Making a backup"). csvb never writes
inside a robotmoney-frontend checkout, so the copies live in `$ARCHIVES`.

<!-- readme-test: acquire -->
```sh
API="${API:-https://robotmoney.network}"
CSVB="${CSVB:-bun run --cwd ../csvb csvb}"
ARCHIVES="${ARCHIVES:-$HOME/robotmoney-archives}"
fill() {
  local code=3
  while [ "$code" = 3 ]; do
    code=0
    $CSVB backup --source api --api "$API" --repo "$ARCHIVES/$1" || code=$?
  done
  return "$code"
}
fill api-copy
```

That is the API-only fill, the path for outside analysts. Holders of read access to
the private robotmoney/csv-backups repo can start from a clone of its backups instead
and fetch only the increment: the same `fill` skips every backup the copy already
holds. Here the first recorded backup stands in for the clone:

<!-- readme-test: acquire -->
```sh
mkdir -p "$ARCHIVES/repo-copy/csv"
cp -R tests/fixtures/archive/api-recorded/csv/2001-01-02T000000Z "$ARCHIVES/repo-copy/csv/"
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
bun run inputs --archive "$ARCHIVES/api-copy" --run 0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2 --out api-fill
bun run inputs --archive "$ARCHIVES/repo-copy" --run 0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2 --out repo-fill
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

**Or replay and compare in one command.** `bun run replay` does steps 2 and 3 and the
comparison together. It reads the run's methodology label, its vintage, the kept days its
report names and the rows it published under its line's artifact kind, then compares the
as-of row the SDK computes with the published one over the compared fields (`replayRun`,
`src/replay/replay.ts`):

```sh
bun run replay --archive <copy> --run <run_key> [--print-row] [--json] [--included macro,onchain] [--version <tag>]
```

`--print-row` prints the SDK's as-of row as JSON and compares nothing. `--json` prints
the result as one JSON object: the version, the line, the artifact kind, `match`, the
differing fields with their first difference, and both rows' SHA-256. `--included` sets
the panels the composite averages (default: the version's published panels). `--version`
replays under that version, not the run's label. The command exits 0 when the rows are
equal; 1 when they differ, a side is missing, a payload hash does not match, the label is
one this SDK does not compute, or the copy is corrupt or incomplete; and 2 for a usage
error: a missing `--run` or `--archive`, a bad option, or a run key that is not in the
copy. `tests/fixtures/archive/model-runs/` is a local copy written through the production
persistence, with one v4 run and three chained v5 runs (`facts.json` names them):

<!-- readme-test: run -->
```sh
bun run replay --archive tests/fixtures/archive/model-runs --run 442307ce-1ff7-409f-a1a4-6384c1ee905f
bun run replay --archive tests/fixtures/archive/model-runs --run 94115169-70cb-4320-9a60-8147554b87d6 --json
```

## Package entries

The package's `exports` map names four entries. A client imports them by package name:

| import | file | holds |
| ------ | ---- | ----- |
| `@robotmoney/analyst-sdk` | `src/index.ts` | every pure building block: the input loaders, `runRegime`, the model value (`MODELS`, `modelOf`), `runModel` and `stageCache`, `screen`, the backtest, the allocators, the report functions, and the replay and archive names below |
| `@robotmoney/analyst-sdk/replay` | `src/replay/index.ts` | `publishedRows` (the one row builder), `compareRows` and `COMPARED_FIELDS`, `numericDiff`, `replayRun` and `publicationCandidates` |
| `@robotmoney/analyst-sdk/archive` | `src/archive/index.ts` | format 1 (`format1.ts`, D80) and the pure reader over injected files (`openArchive`, `collectRunInputs`) |
| `@robotmoney/analyst-sdk/node` | `node/index.ts` | the node:fs edge: `openBackupsDir`, `diskArchiveFiles`, the supplementary directory (`readSupplementary`, `listSupplementary`, `writeSupplementary`, `supplementaryFiles`), `universeFromFile` and `sha256` |

The `.` entry never carries the `./node` names, so a client that only computes never loads
node:fs. `@robotmoney/analyst-sdk/src/*` resolves too, for csvb, which imports SDK modules by
deep path. Other paths in the package, such as `bin/` and `tests/`, do not resolve by name.
`bin/backups-dir.ts` and `bin/supplementary-dir.ts` are one-line re-exports of `node/`, kept
for callers that import them by file path.

<!-- readme-test: ts prelude=none -->
```ts
import { MODELS } from "@robotmoney/analyst-sdk";
import { replayRun } from "@robotmoney/analyst-sdk/replay";
import { openArchive } from "@robotmoney/analyst-sdk/archive";
import { diskArchiveFiles, openBackupsDir } from "@robotmoney/analyst-sdk/node";

// `bun run replay`, in code: the committed v4 run replays with an empty diff.
const copy = openBackupsDir("tests/fixtures/archive/model-runs");
const replay = replayRun(copy, "442307ce-1ff7-409f-a1a4-6384c1ee905f");
if (!replay.diff?.match) throw new Error(`the as-of rows differ: ${replay.problems.join("; ")}`);
const model = MODELS[replay.version!]; // the preset of the run's methodology label

// openBackupsDir is the pure reader over the node:fs files.
const same = openArchive(diskArchiveFiles("tests/fixtures/archive/model-runs"));
```

## Read the backups folder in code

`bun run inputs` is one use of the archive reader, which the package exports
(`src/archive/reader.ts`). The reader reads the csv-backups folder in place and copies
nothing. `openArchive(files, asOf?)` opens it as of a backup id (or its newest backup)
and returns an `Archive`. Opening reads and checks only the `backup.json` files: backup
selection, the watermark chain, revision keys and file paths. Each listed data or
revision file is read the first time a call needs it, and before any of its rows are
returned it is inflated within its `bytes_raw`, SHA-256 checked and row-counted. A file no
call needs is never read, and a missing or corrupt file fails the first call that reads
it. Every file is strict UTF-8 with no byte order mark. It is pure: `files` is an
`ArchiveFiles`, `{ root, backupDirs(): string[] | null, read(path): Uint8Array | null }`,
over paths relative to the folder with `/` separators (`root` only names the folder in
messages). On disk, `openBackupsDir(dir, asOf?)` from `@robotmoney/analyst-sdk/node`
(`node/backups-dir.ts`) wraps it with the node:fs reader `diskArchiveFiles(dir)`.

<!-- readme-test: ts prelude=none -->
```ts
import { openBackupsDir } from "@robotmoney/analyst-sdk/node";
import { collectRunInputs } from "@robotmoney/analyst-sdk";

const archive = openBackupsDir("api-copy");
const run = collectRunInputs(archive, "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2"); // one run's frozen vintage
const { header, rows } = archive.revisedTable("raw_indicator_history");
const prices = archive.latestValues(["backtest:^GSPC", "backtest:ETH-USD", "backtest:DTB3"]);
```

- `archive.revisedTable(table)` is a revised table (`regime_snapshots`,
  `raw_indicator_history`, `asset_prices`) as of the archive's as-of backup: every selected
  backup's `revisions/<table>.csv.gz` applied in backup order (an upsert or a delete by
  the key columns its record names), without the `_backup` and `_op` columns, rows sorted
  by key column by column. A NULL stays `null`. A backup record whose revision names no
  key, an empty key or a key column that is not a non-empty string is refused when the
  archive opens.
- `archive.latestValues(sourceKeys)` is the newest `source_value_versions` value per storage
  key and market date (the highest id, compared as a BigInt), each tagged with the input
  id it is read under (`SPX`, `ETH`, `TBILL3M` for the three above), sorted by market date
  then storage key. A key no input id is read under is refused, and so is a
  `market_instant` row of a requested key. These are the newest values, not a run's
  vintage: a published run's inputs come from `collectRunInputs`.
- A `source_value_versions` row with a missing or non-integer id, an empty `source_key`, an
  empty value, or not exactly one of `market_date` and `market_instant` throws an
  `ArchiveError` naming the file and the 1-based data row. `collectRunInputs` still counts
  `market_instant` members and other consumers' keys in `skipped`.
- `archive.table(name)`, `archive.versions()`, `archive.files(table)` and
  `archive.readRows(file)` are a table's rows (the run-ledger tables, for example), the
  `source_value_versions` rows and any listed data file. Parsed tables and versions are
  kept for the life of the `Archive`.

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
bun run regime my-history.csv --replay --methodology v3            # replay a run published under v3
bun run regime my-history.csv --methodology v5                     # the methodology published beside the main line
bun test                                                           # package tests, every HTTP client is a thrower
bunx tsc --noEmit                                                  # typecheck
```

The default report is checked against `tests/golden/regime-report.json`.

Options (CLI flag, or the `runRegime(raw, opts)` field):

| option | meaning |
| ------ | ------- |
| `--start D` / `start` | first day of the date axis. Default `2018-01-01`. |
| `--asof D` / `asof` | last day of the date axis, `YYYY-MM-DD`. Input rows dated after it are ignored. Default: the newest date of any series the run reads. |
| `dayRule` | what to do with a day that is not complete (see "Fill policy, day rule and day close"). Default `DAY_RULE`, `"score-newest"`: the day given, or the newest date, as above. `"require-complete"`: without `asof` the latest complete day; with an incomplete `asof`, `runRegime` returns `{ kind: "incomplete", asof, missing: [{ id, lastObserved }] }` and no figure. |
| `--factor` / `factor: true` | also report `factor`: the factor panel's `index`, `percentile`, `regime` and `weights` for the last day, plus a per-day `series` with `--full`. The composite averages every included panel, factor among them (D89), so `composite`, `compositePercentile` and the labels are the same with or without `--factor`. |
| `--panels P,P` / `panels` | the panels the composite averages, 1/n each: a non-empty list of distinct panels from `macro`, `onchain` and `factor`. Default `PANELS`, all three (D89). The frozen two-panel originals replay with `--panels macro,onchain`. |
| `--replay` | accept the historical replay contract (`parseInput(text, { replay: true })`). |
| `--methodology V` / `version` | the regime methodology version to compute, `v3`, `v4` or `v5`. Default `CURRENT_REGIME_VERSION` (`v4`). `v5` is the methodology published beside the main line (see "Methodology v5"); it walks every day forward from this input. `v4` cuts the regime label on the composite and each panel label on its panel index; `v3` cut them on the 3y rolling percentile of that series. A published run replays under the version it was stamped with, e.g. `--replay --methodology v3` for a run published before v4 (issue 1652, decision D84). `compositePercentile` and the panel percentiles are the same under both and are information only. |
| required data | at least one composite panel (macro, onchain, factor) needs a registry indicator with a row on or before the as-of day, or `runRegime` throws the named `CoverageError` (the CLI exits 1). It never fetches to fill the gap. Optional inputs give a missing result instead: without `SPX` and `ETH`, `correlations` and `backtest` are `null`; without `TBILL3M`, `backtest` is `null`; without factor indicators, the `factor` figures are `null`. |
| `lookback` (`computeRegime` only) | the rank, weight and percentile lookback windows, `{ rank, weight, percentile }`. Each window is `{ kind: "trailing", days: N }` (the trailing `N` days, `N` a positive integer) or `{ kind: "inception" }` (all history from day 0 of the date axis). Default `REGIME_LOOKBACK[version]`, the version's declared value: the trailing 1095 days for every window under both `v3` and `v4`. An invalid window throws `RangeError` naming it. `runRegime` and the CLI have no lookback option, so a published run always uses its version's declaration (issue 1659). |
| `--provenance` | print `{pinned, manifest, report}` instead of the bare report; see the quickstart. The report inside is unchanged. |
| validation | the CLI exits 2 on a usage error: a second input file, an option given twice, an unknown option, an option missing its value, an invalid `start`/`asof` (real `YYYY-MM-DD` dates, `asof` not before `start` or every input row), a `start` after every input row. It exits 1 on a runtime failure: an unreadable or malformed input, a manifest that does not match its input. `runRegime` throws a `RangeError` for the same option errors. |

`runRegime` builds its inputs with `prepareRegimeInputs`, the same function production
calls, so the as-of cut for indicator rows, each indicator's fill policy (forward-fill
and the 120-day `MAX_FORWARD_FILL_DAYS` horizon as declared) behave as in production. `SPX`, `ETH` and `TBILL3M` rows
dated after the as-of day are cut in both places too (`cutAtAsof`, section 8.1). Their semantics are in [`docs/technical/regime-engine.md` section 8.1](../../docs/technical/regime-engine.md#81-run-semantics-as-of-forward-fill-replay). Both names are exported
from `src/index.ts`.

From code:

<!-- readme-test: ts prelude=history-file -->
```ts
import { parseInput, runRegime, requireComplete, buildReport } from "./src/index.ts";

const input = parseInput(await Bun.file("my-history.csv").text());
const report = buildReport(requireComplete(runRegime(input.history)));

// cut the axis at a day, and compute the factor panel too
const run = runRegime(input.history, { asof: "2026-10-05", factor: true });
if (run.kind === "incomplete") console.error(run.missing); // [{ id, lastObserved }], no figure
else console.log(buildReport(run));
```

### Fill policy, day rule and day close

Three declared parameters (issue 1655). Each is declared at the value that reproduces
the figures the SDK computed before, so no report, golden or replay changes until an
analyst changes one.

**Fill policy.** Each indicator in `src/analyze/indicators.ts` carries a required
`fill` and a short `fillReason`. There is no default.

| `fill` | meaning |
| ------ | ------- |
| `{ kind: "none" }` | no fill: a day without a real observation is missing |
| `{ kind: "forward", maxAgeDays: N }` | the last real observation is carried for at most N days; an older day is missing |
| `{ kind: "forward", maxAgeDays: null }` | the last real observation is carried with no age limit (the backtest's price and cash-rate series, issue 1554) |
| `{ kind: "zero" }` | a gap is a real 0 |

Declared: every indicator is `{ kind: "forward", maxAgeDays: MAX_FORWARD_FILL_DAYS }`
(120), reason "Carried forward up to the former global cap". A missing or malformed
`fill` is a `FillPolicyError` that names the indicator before anything is computed.

**Day rule.** A day is complete when every indicator has a real observation on it or
a value its policy allows (a series that has not started does not count).
`latestCompleteDay(raw)` and `missingOnDay(raw, day)` answer both questions directly.
`DAY_RULE` (declared `"score-newest"`) keeps today's behaviour: the day given, or the
newest row. `"require-complete"` scores the latest complete day, and an explicit
incomplete day returns an `IncompleteDay` (`requireComplete(run)` turns it into an
`IncompleteDayError` naming the missing indicators).

**Day close.** `SOURCE_DAY_CLOSE` in `src/extract/sources.ts` declares, per source,
`"accept-partial"` (keep every served row, including the partial row for the run's UTC
date; declared for every source) or `"drop-unclosed"` (drop rows dated on or after the
run's UTC date; supported for `defillama_tvl`, `defillama_stables` and `coinmetrics`
only, checked when the module loads).

**Changing a value.** Each change lands in its own reviewed diff, which owns any
methodology version change and golden regeneration:

- a fill policy: edit the indicator's `fill` and `fillReason`. To try one without
  editing the registry, pass a copied indicator list to `prepareRegimeInputs`, as the
  research comparisons do;
- the day rule: edit `DAY_RULE`, or pass `dayRule` to `runRegime` to try it;
- a source's day close: edit its `SOURCE_DAY_CLOSE` entry; the extractors also take
  `{ dayClose, now }` directly.

<!-- readme-test: ts prelude=raw -->
```ts
import { INDICATORS, prepareRegimeInputs, computeRegime, runRegime } from "./src/index.ts";

const trial = INDICATORS.map((i) => (i.id === "VIX" ? { ...i, fill: { kind: "none" as const } } : i));
const prepared = prepareRegimeInputs(raw, { start: "2018-01-01", asof: "2026-08-14", indicators: trial });
// `carried` marks the forward-filled rows; computeRegime counts only the real rows of an exchange series (D93).
const composite = computeRegime(prepared.transformed, prepared.dateAxis, { indicators: trial, carried: prepared.carried }).composite;

const strict = runRegime(raw, { dayRule: "require-complete" }); // the latest complete day
```

`tests/fill-policy.test.ts` and `tests/complete-day.test.ts` show each change taking
effect against the declared values.

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
(`@robotmoney/analyst-sdk/node`, `node/supplementary-dir.ts`) wrap it with the node:fs reader
`supplementaryFiles(dir)`. A series from another provider goes in with
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

<!-- readme-test: ts prelude=portfolio -->
```ts
import { simulatePortfolio, periodStats, scheduleFromLabels, PORTFOLIO_SPECS } from "./src/index.ts";

// Target weights per date (null: no applicable weights, the date is skipped with its
// market move). Nonnegative, finite, summing to 1; `cash` earns the cash rate.
const schedule = dateAxis.map(() => ({ "yahoo:GLD": 0.4, "yahoo:SPY": 0.4, cash: 0.2 }));
const sim = simulatePortfolio(dateAxis, schedule, { "yahoo:GLD": gld, "yahoo:SPY": spy }, tbillPercent, { costBps: 10 });
const full = periodStats(sim.values, sim.startDate, sim.endDate, { returns: sim.returns, excess: sim.excess, trades: sim.trades });
const year = periodStats(sim.values, "2025-01-01", "2025-12-31", { returns: sim.returns, excess: sim.excess, trades: sim.trades });

// The reference portfolios are data: a regime label series through a weight table.
const ethSchedule = scheduleFromLabels(labels, PORTFOLIO_SPECS.eth.weights);

// Declare how each series fills a gap (issue 1554). A series with no entry uses
// DEFAULT_SIMULATOR_FILL: forward with no age limit, the former carry.
const bounded = simulatePortfolio(dateAxis, schedule, { "yahoo:GLD": gld, "yahoo:SPY": spy }, tbillPercent, {
  fill: {
    "yahoo:GLD": { kind: "forward", maxAgeDays: 4, reason: "Exchange days; a long weekend is 4 days" },
    "yahoo:SPY": { kind: "forward", maxAgeDays: 4, reason: "Exchange days; a long weekend is 4 days" },
    cash: { kind: "forward", maxAgeDays: 4, reason: "FRED business-daily" },
  },
});
```

**Labels.** `scheduleFromLabels(labels, table, { unknownLabel })` maps each label through
the table; a null label is a skipped day. A label with no own row in the table (a typo
such as `risk-on`) is refused with a `RangeError` naming the label and its index:
`UNKNOWN_LABEL_RULE` is `"refuse"`. Pass `{ unknownLabel: "skip" }` for the former
behaviour, a skipped day. `referenceStrategies({ regime, panelRegimes, panels? })`
returns the reference grid's label series (composite, each panel, `macro_inverted`,
`conservative`, `aggressive`), and `computeBacktest` takes the same shape, so published
label series need no `RegimeComputeResult`. `parsePlainDecimal` (with `PLAIN_DECIMAL`) is
the loader's value rule: a finite number or plain decimal string, anything else a
`RangeError` (`1e400`, blank, hex, padded, NaN, Infinity).

**Fill policies.** No series is filled without a declared policy, in the form of the
indicator fill policies above plus a `reason`. With no observation on a day, `none`
gives a missing value, `forward` N the latest observation from the last N days,
`forward` with `maxAgeDays: null` the latest one with no age limit, and `zero` gives 0.
A held day reads each asset with a nonzero weight on the previous and the current date,
and the cash rate (when cash is held) on the previous date; a value the policy does not
cover is a `RangeError` naming the series, the date and the policy, for example
`price "sp500" has no value on 2026-07-04 (fill forward 4 days)`. The cash rate earns
zero before its first observation. A `fill` key that names no series is refused. The
reference backtest's policies are `REFERENCE_FILL_POLICIES` (`spx`, `eth`, `tbill3m`,
each `forward` with no age limit); each reference portfolio ends on its latest complete
day under them, which with no age limit is the last axis date.

The rules are the established ones, unchanged: a date's return uses the previous target
weights and that date's price change; a change of target weights at the close costs
one-sided turnover (half the sum of absolute weight changes) times `costBps` (default
10); cash earns the previous day's annual percent yield, `(1 + y / 100) ** (1 / 365) - 1`
(evaluated as `expm1(log1p(y / 100) / 365)`), and zero before the first yield; prices and
the cash rate fill gaps only as their declared policies allow; the simulation starts at the first date every supplied asset is priced,
then at the first date with weights. Equity compounds unrounded (D78): each daily value
is the exact product of the growth and cost factors so far, rounded once.
`sim` carries the net daily values, the pre-cost daily returns, the post-cost daily
returns in excess of cash (`excess`), each trade's turnover and cost, and the start and end
dates. `periodStats` takes `returns` and `excess` both. Its Sharpe (mean / sample sd,
annualized over 365 days, 0 at zero volatility, which since D78 includes any run of
bit-identical returns) reads `excess` by default, or the pre-cost `returns` with no cash
subtraction under `sharpeBasis: "returns"` (see "Build your own regime model"). It uses the
net values for growth and drawdown, and years of 365.25 days; a
different window or `splitDate` never changes the full-range figures.
`computeBacktest` is exactly these three functions over the reference portfolios.

### Drift-aware simulation

`simulatePortfolio` resets the book to the target every day. `simulateDrift` takes the
same four inputs and lets holdings drift between rebalances:

<!-- readme-test: ts prelude=drift -->
```ts
import { simulateDrift, periodStats } from "./src/index.ts";

const drift = simulateDrift(dateAxis, schedule, prices, tbillPercent, { costBps: 10, freq: "monthly", band: 0.05 });
const stats = periodStats(drift.values, drift.startDate, drift.endDate, { returns: drift.returns, excess: drift.excess, trades: drift.trades });
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
and returns equal `simulatePortfolio`'s bit for bit. `fill` declares each series' fill
policy exactly as for `simulatePortfolio`.

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
exits 1 and names the series; the command never fetches. The command declares
`forward` with no age limit for every holding and the cash rate (`BACKTEST_FILL` in
`bin/backtest.ts`), the former carry, so its output is unchanged. It prints the portfolio, the
universe check and the statistics; `--full` adds the daily values, returns and trades.

## Size and optimise a portfolio

The backtest takes weights; these functions choose them. Every solver returns a certified
optimum or throws `UnsupportedError`: there is no approximate fallback (D78). A NaN or
Infinity in the covariance, the excess returns or the risk aversion throws, and a
`markowitzSchedule` `cov` callback that returns one, or the wrong shape, throws `RangeError`.

<!-- readme-test: ts prelude=markowitz -->
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
// mu is your point-in-time priors: `history` holds only the return rows dated before `date`.
const myPointInTimePriors = (_date: string, _history: number[][]) => ({ SPX: 0.075, ETH: 0.25, GLD: 0.055 });
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
| `mu(date, history, dates, rf)` | required | expected annual returns per asset (a record or an array), your point-in-time priors; `rf` is the rate the solver will use |
| `rule` | `"meanVar"` | `"meanVar"` (`meanVarExact` at `lambda`, the rest cash) or `"tangency"` |
| `solve(mu, S, rf, context)` | the rule | any solver: `(mu, S) => ercCertified(S)`, risk budgets, `minVarExact`, inverse volatility, naive; `context.date` lets a budget follow the date |
| `cov(history, context)` | `shrunkCov(history, shrink, periodsPerYear)` | any covariance estimate; `context.date`, `context.historyDates` and `context.trailing(n)` (the last `n` return rows before the date with their dates, past `lookback`) |
| `lookback` | expanding window | a rolling window of the last `lookback` rows |
| `reoptimise` | `"monthly"` | `"weekly"` (a new Monday-to-Sunday week), `"monthly"`, `"quarterly"` (a new calendar quarter), or `(date, prevDate) => boolean` (`prevDate` is null on the first axis date) |
| `expand(weights, date, rebalance)` | identity | maps optimizer weights (`cash` plus one key per asset) onto the day's priced holdings; null leaves the day unset. Called once per axis date in ascending order, so it may keep state. `rebalance` is a copy of the re-optimisation in force (`vol`, `rf`, `mu`, `nObs`, `weights`) |
| `expands` | none | `markowitzSchedule` only: a record of named `expand` rules. One solve per re-optimisation; the result adds `schedules[name]` per rule, and `schedule` holds the optimizer weights. Not with `expand`; `markowitzBacktest` refuses it |
| `simulate` | `simulatePortfolio` | `{ drift: { freq, band, costBps, fill } }` for `simulateDrift`, or any `(dateAxis, schedule, prices, cashRate) => SimulationResult` |
| `fill` | `DEFAULT_SIMULATOR_FILL` | `markowitzBacktest` only: the fill policy per holding and `cash`, passed to the built-in simulator; refused with a `simulate` function |
| `minObs`, `from`, `shrink`, `periodsPerYear`, `costBps`, `lambda`, `zeroTol`, `splitDate` | 252, every return, 0.2, 252, 10, 4, 1e-12, `BACKTEST_IN_SAMPLE_END` | |

Each `rebalances` entry records `date`, `rf`, `mu`, `nObs`, `vol` (sqrt(w' S w) of the optimizer weights on the covariance the solver saw, in the units of that covariance) and `weights`. `expand` output must pass the simulator's weight checks (nonnegative, summing to 1). A
solver that returns a negative or over-budget weight throws `RangeError`. `markowitzBooks`,
`markowitzSchedule`, `simulateDrift`, `periodStats` and every solver return plain data, so
you can also compose them yourself.

## Build your own regime model: rules, options and building blocks

Every choice below is an option with a default, and every default is what 0.8.0 does
(decision D95). A model that needs another rule states it; it copies no SDK code.

| Where | Option | Default | Other value |
| ----- | ------ | ------- | ----------- |
| `simulatePortfolio`, `simulateDrift`, `computeBacktest` | `cashBasis` | `"discount"`: the cash quote is a T-bill discount rate, converted with `discountToYield` | `"yield"`: the quote is compounded as a yearly yield |
| `periodStats`, `computeBacktest` | `sharpeBasis` | `"excess"`: post-cost returns minus cash (`excess`) | `"returns"`: the simulation's pre-cost daily returns with no cash subtraction (`returns`), the 0.7.0 rule |
| `computeBacktest` | `lagSessions`, `calendars` | 1, `REFERENCE_CALENDARS` | passed to every line of the grid; `calendars` is keyed `eth` and `sp500` |
| `runRegime` | `inSampleEnd` | `"current-version"`: `BACKTEST_IN_SAMPLE_END` | `"computed-version"`: the adoption date of `version` |
| `runRegime` | `storedOnlyRatio` | `"drop"`: the ratio gets weight 0 and is listed in `droppedRatios` | `"error"`: throws `StoredRatioOnlyError` |
| `prepareRegimeInputs`, `knowledgeTimeHistory`, `latestCompleteDay`, `missingOnDay`, `computeRegime`, `regimeLabels` | `rules` | the preset of `version` | any `RegimeRules` object |

`droppedRatios` names each ratio that is calculated from its legs (`ratioInput: "legs"`)
when the input carries only the stored ratio. Under v4 that is the six equity ratios of any
archive run before 2026-11-17.

A `RegimeRules` object states every engine rule: `knowledgeTime` (read each value from the
day it was published), `observationWindows` (an `exchange` series counts its own
observation days), `weightRefresh` (the refit calendar), `missingPanel` (`"nan"` or
`"rebase"`), `labelCut` (`"series"` or `"percentile"`), `lookback` and `adoptionDate`.
`REGIME_RULES.v3`, `REGIME_RULES.v4` and `REGIME_RULES.v5` are the presets.
`REGIME_RULES.v5` also states `compositeNormalisation` and `keptHistory` (see "Methodology v5"). An indicator's `calendar` is
checked only when `observationWindows` is true, and its `publication` only when
`knowledgeTime` is true.

<!-- readme-test: ts prelude=raw-asof -->
```ts
import { REGIME_RULES, computeRegime, fitPanelWeights, prepareRegimeInputs, weightedMeanOnDay, PANELS, INDICATORS } from "@robotmoney/analyst-sdk";

// v4 with one rule changed: average the panels that have an index.
const rules = { ...REGIME_RULES.v4, missingPanel: "rebase" as const };
const p = prepareRegimeInputs(raw, { start: "2018-01-01", asof, rules });
const run = computeRegime(p.transformed, p.dateAxis, { panels: PANELS, ages: p.ages, rules, carried: p.carried });

// One day's fit from scores computed once: the two functions computeRegime itself calls.
const macro = INDICATORS.filter((i) => i.panel === "macro");
const day = p.dateAxis.length - 1;
const weights = fitPanelWeights(run.signed, macro, day, { rules, carried: p.carried });
const index = weightedMeanOnDay(run.signed, weights, macro, day);
```

`computeCorrelations` reads only `{ composite, panelIndices, panels }` (`CorrelationInput`),
so those three fields are all it needs.

**Derived series.** `deriveSeries(declaration, inputs)` computes a series from supplementary
series as plain data. `op` is `"level"` (the input), `"ratio"` (`mergeRatioSeries` of two
inputs), `"rolling-sum-over-known-level"` (a sum of the last `periods` observations of a
flow over the latest level value that was public, with `summation: "plain"` for in-order
addition or `"compensated"`) or `"up-volume-share"` (the share of volume on up days over
`window` rows). Each takes a `publication` rule that dates the result; the rule
`{ kind: "calendar-days", days }` adds that many calendar days. A missing input throws
`DerivedSeriesError` naming it.

<!-- readme-test: ts prelude=vix-supplementary -->
```ts
import { deriveSeries } from "@robotmoney/analyst-sdk";

const vixTerm = deriveSeries(
  { op: "ratio", id: "VIX_TERM", numerator: "yahoo:^VIX3M", denominator: "yahoo:^VIX", publication: { kind: "calendar-days", days: 1 } },
  supplementary,
);
```

`bun run fetch --field adjclose|close|volume` (and `fetchSupplementary(id, window, { field })`)
picks the value of a Yahoo series. The default adjusted close stays `yahoo/<symbol>.csv`;
a close or volume is its own series, for example `yahoo:^GSPC.volume` in
`yahoo/%5EGSPC.volume.csv` with manifest field `volume`.

**Report functions.** The functions the platform shapes its published report with are in
the SDK as pure functions, and the backend runs the same copy: `selectPublications` (which
run a day shows, decision D83), `canonicalStringify` and `canonicalArtifactBytes` (the
stored artifact's canonical JSON), `rowToSnapshot`, `forHistory` and `shapeRegimeSnapshots`
(the regime-snapshots response from stored rows, typed `RegimeSnapshotRow`,
`RegimeSnapshot` and `RegimeHistoryPoint`), and `buildRichIndicators` and
`monthlySparkline` (the per-indicator rows).

`collectRunInputs` reads the `analytics_vintage_members` files one at a time through
`Archive.scanRows` and keeps only the rows of the run's vintage, so the whole table is
never held in memory.

### One model value: MODELS, modelOf and runModel

A methodology is one frozen `RegimeModel` value (issue 1765): `id`, `rules` (every engine
rule), `registry` (the scoring indicators), `derived` (the series it derives from raw
inputs), `history` (`"recompute"`: every day recomputed from the whole input; `"kept"`: each
day computed on its own day and kept), `panels` (`{ all, included }`), `seriesMapping` and
`storedUnder` (the storage keys it reads) and `backtest` (its reference backtest options).
`MODELS.v3`, `MODELS.v4` and `MODELS.v5` are the published presets. Each per-version table
above is a view of them: `REGIME_RULES.v4` is `MODELS.v4.rules` and
`REGIME_BACKTEST_RULES.v5` is `MODELS.v5.backtest`. `modelOf(tag)` returns the preset.
`modelOf(model)` checks a model of your own and returns it, or throws a `RangeError` naming
the bad field. Where a version is published (`REGIME_LINE`) is a platform fact, not a field.

`runModel(model, input, { asof })` is one run of one model. It prepares the input, then
scores, fits and combines (`STAGES`) through the model's history driver, then adds the
correlations and the backtest. Its input is the run input under the ids the model reads,
after the ratio step. `runRegime(raw, { model })` is `runModel` behind its option checks,
the input name resolution, the ratio step and the day rule. With a `stageCache()`, each
stage's value is stored under the input's digest and the stage's params, so a later run
that changes only a later stage recomputes only from there. `cache.hits` and
`cache.misses` count the lookups per stage. A run whose model id is not a published tag is
stamped `CURRENT_REGIME_VERSION`; pass `version` to stamp another.

<!-- readme-test: ts prelude=raw -->
```ts
import { MODELS, buildReport, modelOf, ratiosFromLegs, requireComplete, resolveInputHistory, runModel, runRegime, stageCache } from "@robotmoney/analyst-sdk";

const v4 = modelOf("v4"); // MODELS.v4 itself
// The run input: storage names resolved, then each ratio set from its legs (v4's ratio step).
const input = ratiosFromLegs(raw, resolveInputHistory(raw, v4.seriesMapping, v4.storedUnder));
const cache = stageCache();
const run = runModel(v4, input, { asof: "2026-08-14", cache });
const viaRunRegime = requireComplete(runRegime(raw, { asof: "2026-08-14" }));
if (JSON.stringify(buildReport(run)) !== JSON.stringify(buildReport(viaRunRegime))) throw new Error("runModel and runRegime differ");

// A research model: the preset with one rule changed, checked by modelOf.
const rebase = modelOf({ ...MODELS.v4, id: "v4-rebase", rules: { ...MODELS.v4.rules, missingPanel: "rebase" } });
const trial = runModel(rebase, input, { asof: "2026-08-14", cache });
cache.misses; // { prepare: 1, score: 1, fit: 1, combine: 2 }: the trial computed only its combine stage
```

### Research: screen a rule grid

`screen(input, model, grid, metric, { asof, cache })` runs the model once per variant of
the grid through `runModel`, with one shared stage cache, and ranks the variants by your
metric, highest first. Tied scores keep their grid order, and a NaN score ranks last. A
variant is a `RuleVariant`, a `Partial<RegimeRules>` merged over the model's rules one
level deep: a variant that sets `weightRefresh` sets the whole object. A variant key that
names no rule is a `RangeError`. A stage whose params no variant changes is computed once
for the whole grid, so a grid over the refit calendar and the label cut scores the
registry once. The runs share arrays with each other and with the cache: never write to a
run's result. A custom derived series (`op: "custom"`, `DerivedCustom`) is named in a
cache key by its declared `id` and `version`, never by its function, so bump its `version`
when you change its `fn`.

<!-- readme-test: ts prelude=v4-input -->
```ts
import { MODELS, screen, stageCache, type RuleVariant, type ScreenMetric } from "@robotmoney/analyst-sdk";

const v4 = MODELS.v4;
const grid: RuleVariant[] = [21, 63].map((intervalDays) => ({ weightRefresh: { ...v4.rules.weightRefresh, intervalDays } }));
// Your metric; here the mean of the finite composite values.
const meanComposite: ScreenMetric = (run) => {
  const finite = run.result.composite.filter(Number.isFinite);
  return finite.reduce((a, b) => a + b, 0) / finite.length;
};
const cache = stageCache();
const ranked = screen(input, v4, grid, meanComposite, { asof: "2026-08-14", cache });
const best = ranked[0]!; // { variant, model, run, score }
cache.misses.score; // 1: both variants read one score of the registry
```

### Methodology v5: a model published beside the main line

`v5` (issue 1753, decision D96) is a second regime methodology. The platform computes
and publishes it beside the served one. `CURRENT_REGIME_VERSION` stays `v4`, and
`REGIME_LINE` says which line a version is on: `v3` and `v4` `main`, `v5` `beside`.

- **Rules.** `REGIME_RULES.v5`: values read by period date, calendar-day windows that
  count carried days, weights refit every day, the composite mean taken over the panels
  present, and the composite ranked within every kept mean to date
  (`compositeNormalisation: "percentile"` with an `inception` percentile lookback). Each
  day is computed on the day and kept (`keptHistory: true`). Both fields are absent on
  the `v3` and `v4` presets.
- **Registry.** `REGIME_REGISTRY.v5` (`V5_INDICATORS`) has 30 indicators: `INDICATORS`
  with VIX scored in the factor panel, plus `FISCAL`, `VIX_TERM`, `SKEW` and
  `UPVOL_SHARE`. Each of the four is a `DerivedSeries` declaration (`V5_DERIVED_SERIES`).
  `INDICATORS` itself is unchanged.
- **Inputs.** The four read five raw series, named by `V5_INPUT_IDS`:
  `FED_SURPLUS_MONTHLY` (`fred:MTSDS133FMS`), `US_GDP` (`fred:GDP`), `CBOE_VIX3M`
  (`yahoo:^VIX3M`), `CBOE_SKEW` (`yahoo:^SKEW`) and `SPX_VOLUME` (`yahoo:^GSPC.volume`).
  An input may name each by its id, its storage key or its source id. `VIX_TERM` divides
  by the `VIX` series unless the input names `VIX_TERM_DENOMINATOR`. A missing series
  leaves its indicator missing with weight 0.
- **Kept record.** `computeKeptRegime(raw, { asof, start, kept })` is one run. With no
  kept day it walks forward from `start`, fitting each day on that day. With kept days it
  computes only `asof`. `keptRegimeRows` gives the rows the run publishes. The building
  blocks are exported too: `withDerivedSeries`, `scoreDays`, `fitDay`, `keptDayOf`,
  `walkForward` and `deriveKeptRecord`.
- **Backtest.** `REGIME_BACKTEST_RULES` holds the reference backtest options of each
  version. The `v3` and `v4` rows are `computeBacktest`'s defaults. The `v5` row is the
  rule set its golden was published with: `lagSessions` 0, `continuous` calendars,
  `cashBasis` `"yield"`, `sharpeBasis` `"returns"` and a split on 2024-01-31. Its
  results are hypothetical.
- **Preset.** `MODELS.v5` is all of this as one model value: `rules` is `REGIME_RULES.v5`,
  `registry` is `V5_INDICATORS`, `derived` is `V5_DERIVED_SERIES`, `history` is `"kept"`
  and `backtest` is `REGIME_BACKTEST_RULES.v5`. `runRegime(raw, { version: "v5" })`,
  `runRegime(raw, { model: "v5" })` and `runModel("v5", input, { asof, kept })` run it.

<!-- readme-test: ts prelude=v5-raw -->
```ts
import { MODELS, REGIME_BACKTEST_RULES, buildReport, requireComplete, runRegime } from "@robotmoney/analyst-sdk";

// A v5 run of one input: every day from the axis start, each computed from that day's inputs.
const run = requireComplete(runRegime(raw, { version: "v5" }));
const report = buildReport(run); // 30 indicators; compositePercentile is NaN (null in JSON)
REGIME_BACKTEST_RULES.v5; // { splitDate: "2024-01-31", lagSessions: 0, calendars: { eth: "continuous", sp500: "continuous" }, cashBasis: "yield", sharpeBasis: "returns" }
MODELS.v5.backtest === REGIME_BACKTEST_RULES.v5; // true: one value
```

`tests/regime-v5-golden.test.ts` reproduces the downstream golden of this model byte
for byte (3,124 days, SHA-256 `03b9633d...`) from the committed fixture
`tests/fixtures/lex-equity-golden/`. `scripts/lex-golden-fixture.ts` rebuilds the
fixture's `runs.json.gz` from a local csv-backups folder:

```sh
RM_CSV_BACKUPS_DIR=<a csv-backups checkout> bun run scripts/lex-golden-fixture.ts --check
```

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
                 (format1.ts), and the reader over injected files (reader.ts: openArchive,
                 revised tables, latest values)
src/analyze/kept-regime.ts  the kept record of a methodology that keeps its history (v5): score a day,
                 walk forward, derive the composite and the labels from kept days
src/model/       the model value: MODELS (the published presets), modelOf, each preset's storage
src/engine/      the staged engine: runModel, the stages (prepare, score, fit, combine), the
                 recompute and kept history drivers, and the stage cache (stageCache)
src/replay/      the one row builder (publishedRows), compareRows, replayRun (`./replay`)
src/research/    screen, a rule grid over one stage cache; legacy/ holds the frozen research comparisons
src/hash.ts      the SDK's one SHA-256
src/run.ts       source data in, regime report out: runRegime, runModel behind its option checks
src/coverage.ts  required-data check (CoverageError)
node/            the node:fs edge (`./node`): openBackupsDir and diskArchiveFiles (backups-dir.ts),
                 the supplementary directory's reader and writer (supplementary-dir.ts),
                 universeFromFile (universe-file.ts) and sha256 (hash.ts)
bin/regime.ts    the `bun run regime` entry (reads one file and its sidecar)
bin/inputs.ts    the `bun run inputs` entry (reads a local copy, writes one input and its sidecar)
bin/replay.ts    the `bun run replay` entry (replays one run of a local copy and compares its as-of row)
bin/backups-dir.ts, bin/supplementary-dir.ts  one-line re-exports of node/, kept for callers by file path
bin/backtest.ts  the `bun run backtest` entry (one portfolio, gated by the universe)
bin/fetch.ts     the `bun run fetch` entry (Yahoo and FRED series into a supplementary directory)
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
