# Analyst SDK requirements

Owner: Lucas. Package: `packages/analyst-sdk`. Terms are defined in [`../definitions.md`](../definitions.md). The module the SDK exposes is specified in [`analytics-requirements.md`](analytics-requirements.md). This document specifies the client side: how an analyst gets source data onto their machine and runs the module on it.

## 1. Purpose and users

The analyst SDK lets anyone check the published regime and rebuild it, and build their own analysis on the same calculations. It is the analytics module (same code as the backend, D57) plus the tools to fetch source data and run it. An analyst runs it with Bun on their own machine.

It works with two kinds of source data ([D79](../decisions.md#d79)):

- **Supported series.** The platform collects these. The public API and the csv-backups repo serve them cleaned, versioned and in the input file format, so an analyst can use them with no extra work (section 3).
- **Supplementary series.** The platform cannot cover the full history of every asset an analyst may want. For anything else, the SDK gives the analyst a format to store series they fetch themselves, so those series work in the same calculations. It also ships fetchers for common providers (Yahoo and FRED), so the analyst does not have to write their own (section 4).

Users:

- An outside analyst who wants to download the source data and rerun the regime.
- A member's agent that wants to call regime and backtest functions with JSON in and JSON out.
- An analyst who studies assets or dates the platform does not carry, with the SDK's calculations.

Non-goals:

- Anything listed as a non-goal in the analytics requirements.
- Running the backend, or writing to the production database.

## 2. Principles

- **One shared calculation.** Identical effective inputs and report options produce byte-identical report payloads in backend and SDK, and a payload published before D78 replays up to rounding: the same structure, field order, labels and nulls, with numbers that differ only in their last bits. Existing dates, nulls, field order and number formatting are preserved. This refactor introduces no alternative calculation methodology or backend-only compatibility engine; the compensated arithmetic of D78 is a separate, deliberate change.
- **Pure computation.** The computation calls no network, reads no database and reads no environment. Only the source clients in `src/extract/` fetch, and only through `src/extract/http.ts`. Tests run with `fetch` replaced by a thrower.
- **Files only at the edge.** The command line is the only place that reads or writes a file.
- **Install alone.** The package installs from a sparse clone of its own directory.
- **No archive import.** The SDK never imports the archive tool. The archive tool may import the SDK.
- **The archive tool fetches supported series.** csvb (`packages/csvb`) owns the local copy, every fill and the download client. The SDK's `fetch` command owns the supplementary directory: it fetches with the source clients in `src/extract/` and writes nowhere else. Provider collection, archive downloads and supplementary fetches are extract-stage acquisition, completed before downstream execution. The SDK run reads supplied local inputs.
- **Two directories.** Supported series live in the local copy. Supplementary series live in the supplementary directory. The two are separate directories, and neither is inside the other. Nothing writes a supplementary series into the local copy, and a fill never writes into the supplementary directory.
- **No HTTP after extract.** Preparation, transforms, regime and research calculations, allocation, backtesting and reporting, including callbacks and dependencies, make no HTTP requests. A run never downloads a missing series or invokes csvb or a source client. Missing required inputs fail explicitly; optional missing inputs produce the documented missing result.
- **Clients can tune every analysis.** Constants are options with defaults: each is an optional field of one options object whose default is today's value, and an unknown option key throws `RangeError` naming the key. Strategy steps are callbacks: expected returns, covariance, solver, the mapping onto holdings, the re-optimisation dates and the simulator are functions a client passes. Building blocks are exported: the solvers, the covariance, the schedule, the simulators and the statistics are exported from the package entry and return plain data, so a client composes its own analysis from them or extends the SDK's types.

## 3. The local copy

The local copy is a set of backups on the analyst's machine, in the archive format of [analytics requirements section 4.5](analytics-requirements.md). It holds every collected version of source data and every published report, with the vintages that link them. An analyst can therefore compare a rerun with the report the run published.

**Default fill, for holders of repo access.** The recommended path has two steps:

1. Download the backups from the robotmoney/csv-backups repo. It holds data only; csvb lives in `packages/csvb` of this repo. A clone brings every backup up to the newest one.
2. Resume from the checkpoint with `csvb backup --source api`. The tool reads the newest backup's watermarks and fetches only what is newer, as archives from the public API.

The two steps join: the repo's snapshot-time chain and the API's day-cut chain meet at the legacy junction backup, and both writers cut the same day-cut backups after it (D80). The default exists so an analyst gets up and running faster. The repo gives the bulk in one transfer, with no long run of paced API requests. The API gives the increment, so a second run costs only what changed. A past state is pinned by naming a backup id.

**Other fills:**

| Fill | When | How |
| ---- | ---- | --- |
| API only | No access to the repo. This is the path for outside analysts. | `csvb backup --source api` into an empty directory fetches every archive from the public API, within the client rules in section 6. |
| Replica | Operators only. | `csvb backup`. Reading the database is the default source. |
| Original sources | To audit the API. | The source clients in `src/extract/` fetch source data directly and return it to the caller. They write no archives. |

SDK computation never fetches from original sources or the public API. An analyst invokes acquisition separately to collect or download the inputs before running computation. Optional source clients support that extract stage only. The API serves source data that the backend has already cleaned.

**Access.** The csv-backups repo is private and holds production data. Only holders of read access use the default fill. Everyone else uses the API-only fill. The two fills produce the same local copy.

**Reading the local copy.** The SDK exports one reader for the local copy. It takes the copy's files through an injected reader, so the reader itself touches no filesystem (section 2). It opens the copy as of a backup id, or as of the newest backup. Before it returns anything, it checks the backup selection, the watermark chain, each file's inflated size, the SHA-256 of every listed file and the row count of every file it reads. A client reads three things from an open copy:

- **A run's inputs.** The values in the run's frozen vintage, the input file of section 5.
- **A revised table as of the backup.** These tables are `regime_snapshots`, `raw_indicator_history` and `asset_prices`. The reader applies every selected backup's revisions file in backup order. Each change upserts or deletes the row named by the key columns in the backup record. Deleted rows are gone, the `_backup` and `_op` columns are dropped, and rows sort by key column by column. A backup record whose revision names no key, an empty key or a key column that is not a non-empty string is refused when the copy opens.
- **The latest values of chosen storage keys.** For each storage key and market date, the reader returns the version with the highest id, comparing ids as integers of any size. Each value is tagged with the input id it is read under. A key no input id is read under is refused. These are the newest values, not a run's vintage, so they do not reproduce a published run.

The SDK never writes flat copies of revised tables to disk.

## 4. Supplementary series

A supplementary series is source data an analyst collects outside the platform, for an asset or a date range the platform does not carry. The source data rules of [analytics requirements sections 4.1 and 4.2](analytics-requirements.md) apply: one source id, `<provider>:<symbol>` (D74), and values stored as the provider gives them.

**The supplementary directory.** One directory on the analyst's machine holds every supplementary series. The analyst chooses its path. It is never the local copy, never inside it and never around it. The SDK refuses a directory that is, contains or lies inside a format 1 local copy. Keeping the two apart means a supplementary series can never be mistaken for a supported one, and a fill can never overwrite one.

**Format.** One series per file:

- **Path.** `<dir>/<provider>/<symbol>.csv`, with the symbol percent-encoded (`yahoo:GC=F` is `yahoo/GC%3DF.csv`, `yahoo:^GSPC` is `yahoo/%5EGSPC.csv`).
- **File.** The source input contract: the header `date,series,value`, the series' source id on every row, real calendar dates strictly ascending, plain decimal values. A file is therefore also a valid input file.
- **Manifest.** Beside each file, `<symbol>.manifest.json` records the source id, what the values are (`field`, for example the adjusted close), the row count, the first and last date, the SHA-256 of the file, when it was fetched (`fetched_at`) and by what (`fetched_by`: tool, version, endpoint). A reader checks the file against its manifest and refuses a mismatch.
- **Code.** `src/input/supplementary.ts` is the format and the pure reader `openSupplementary(files)`, which reads through an injected `SupplementaryFiles`. `bin/supplementary-dir.ts` supplies the node:fs `SupplementaryFiles` and writes the directory.

**Fetchers.** `bun run fetch --into <dir> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--replace] <source id>...` fetches each series with the SDK's source client for its provider and writes it with its manifest. Yahoo (`yahoo:<symbol>`, the adjusted close) and FRED (`fred:<series>`) are supported. `--start` defaults to 2016-01-01, the collection floor proposed for the platform. `--end` defaults to today. The command checks every id before the first request, writes each file beside its target and renames it into place, keeps an existing series unless `--replace` is given, and reports each series that fails while it still fetches the rest. The fetch follows the client rules of the source clients (`src/extract/http.ts`). `fetchSupplementary(id, { start, end })` in `src/extract/supplementary.ts` is the same fetch for code, and it writes nothing.

**Other sources.** An analyst may store a series from any provider in the same format, by writing the file and its manifest with `writeSupplementary`. The provider name is lowercase letters, digits and dashes.

**Reading.** Code reads a supplementary series by source id from the supplementary directory (`openSupplementary(files).read(id)`, or `readSupplementary(dir, id)` on disk). The SDK has no merged view of the two directories. When a supported series and a supplementary series share a source id, the reading code names the directory it reads. Nothing substitutes one for the other.

**Not the record.** A supplementary series has no vintage and no platform provenance. A report computed from one is not a published report and cannot be checked against the platform's record. Its manifest is the only provenance, and it travels with the analyst's results.

## 5. The input file

The SDK computes from a derived report of source data, not from the archives.

- **Format.** A CSV with exactly the header `date,series,value`, or the same rows as JSON. Each `series` is a source id. Dates are real calendar dates and values are plain decimals. The rules are in [analytics requirements sections 4.1 and 4.2](analytics-requirements.md).
- **Content.** `csvb inputs --archive <dir> --run <run_key>` writes the source data in a run's vintage, under canonical source ids, using the shared storage mapping when archives carry historical keys. Historical replay also preserves original calculated ratio inputs through the replay contract defined in the analytics requirements; it does not invent missing legs. The series the correlations and the backtest read are rows in the same file.
- **Committed values.** Input generation copies the exact committed values and versions for the run. Source-update jitter filtering is completed during ingestion; no tolerance, rounding or substitution is applied to downloaded inputs, calculations or report comparisons.
- **Coverage.** The supplied inputs cover the requested date range and all required source series, including ratio legs, prices, yields, benchmarks and research inputs used by the workflow. Report missing required coverage explicitly before the dependent calculation; never fetch it during a run.
- **Legs.** A ratio indicator is two rows of source data, one per leg ([section 4.3 of the analytics requirements](analytics-requirements.md)).
- **Manifest.** The input file gets a sidecar `inputs.manifest.json`. It records the backup id, the run key, the as-of date, the source (`api` or `db`), the row count, the sha256 of the input file, the methodology id and exact code revision. The command line reads it at the edge and uses the recorded identity as provenance, not as a choice between different backend and SDK calculations. The computation does not read the sidecar. Provenance accompanies the report in an explicit envelope; the original report payload retains its shape.
- **Why the file is derived.** It is cheap to regenerate from the backups, and the backups are the record. A file without a manifest still runs. Its provenance envelope says the source data is not pinned.

## 6. Download client

The download client is a polite, resumable reader. It fetches archives under the server limits in [analytics requirements section 4.8](analytics-requirements.md).

- **One at a time.** One request in flight, at most 1 request a second.
- **Retries.** Honour `Retry-After` exactly on 429 and 503. Otherwise back off with full jitter from 1 to 60 seconds, at most 5 retries per request. Do not retry any other 4xx.
- **Identity.** Send a `User-Agent` that names the tool and its version. The version is read from the tool's `package.json`. The SDK's source clients follow the same rule with the SDK's version. A released SDK version is tagged `analyst-sdk-vA.B.C` on its own release line (accepted in [D77](../decisions.md#d77)).
- **Estimate first.** Print the number of requests before the first one. Refuse a plan over `--max-requests` (default 500).
- **Resumable.** An interrupted download adds no partial archive. The next run starts from the last committed watermark.
- **Verified.** Each archive is checked against its served checksum before it joins the local copy.

## 7. Command line

`bun run regime <input-file>` reads one file and prints the regime report as JSON. It takes `--start`, `--asof`, `--factor` and `--full`. The package README documents the options. A run with `--asof` replays the regime as of that day.

- **Paths.** A relative path resolves from the folder the analyst ran the command in.
- **Bad arguments.** The command exits non-zero with a message on any of these: a second input file, a repeated option, an unknown option, a `--start` after every input row, or an input with no series the run reads.
- **Pinning.** An explicit provenance output envelope carries the report and its `manifest`. With no manifest the envelope carries `pinned: false`. The existing report-only output retains its shape.
- **Calculation identity.** Replay records the original methodology and code revision for audit. Backend and SDK use the same shared calculation; no methodology-selection option is introduced by this refactor. With identical pinned inputs and options, replay through the refactored module preserves a serialized report computed with the D78 arithmetic byte for byte, and a payload published before D78 replays up to rounding with the same labels, nulls and fields.

## 8. Success criteria and tests

Package paths are relative to `packages/analyst-sdk/`. csvb paths are relative to `packages/csvb/`.

| Criterion | Test |
| --------- | ---- |
| From a clean sparse clone, `bun install` and `bun run regime <file>` return a regime report. | `scripts/tests/unit/analyst-sdk-sparse-install.test.ts` |
| The command line, run as a process, prints the report in `tests/golden/regime-report.json`. | `tests/cli.test.ts` |
| The command line rejects bad arguments and resolves relative paths from the caller's folder. | `tests/cli.test.ts` |
| Two runs on the same input file give the same output, and the provenance envelope names the manifest or says `pinned: false`, without changing the report payload. | `tests/cli.test.ts` |
| `bun test` passes with `fetch` replaced by a thrower. | `tests/no-network.ts` (preload) |
| `bunx tsc --noEmit` is clean. | the package `typecheck` script |
| A supplied-input workflow completes after extract with HTTP disabled across all downstream stages and callbacks. Missing inputs cause explicit errors or documented missing results without fetching. | `tests/no-network.ts` (preload), `tests/input-rule.test.ts`, `tests/cli.test.ts` |
| The SDK never imports csvb, downstream modules never import acquisition clients or HTTP APIs, and SDK provider requests go only through `src/extract/http.ts`. | `scripts/tests/unit/analyst-sdk-purity.test.ts` |
| A supplementary series round-trips through its file to the same doubles, its manifest pins the file's bytes, its path encodes the source id reversibly, and an existing series is kept unless replaced. | `tests/supplementary.test.ts` |
| The supplementary directory is refused when it is, contains or lies inside a local copy, by the library and by `bun run fetch`. | `tests/supplementary.test.ts` |
| `fetchSupplementary` fetches Yahoo and FRED through `src/extract/http.ts`, cuts to the window, and fails on an empty window or a provider with no client. `bun run fetch` rejects bad arguments before its first request. | `tests/supplementary.test.ts` |
| Each covariance entry is the correctly rounded exact sample covariance of the doubles, also near 1e160 and 1e-155; each correlation is the exact Pearson value; the refined solve returns the correctly rounded exact solution or throws `UnsupportedError` when the matrix is singular, non-square, non-finite or too ill-conditioned for one certain digit. | `tests/linalg.test.ts` |
| The optimizers (budgeted ERC, minimum variance, mean-variance with a slack or binding budget, maximum Sharpe) return a certified optimum at rounding-size residual, no 0.001 grid point beats them, ties break to the lower index, and each residual scores an infeasible point at least at its infeasibility; otherwise they throw `UnsupportedError`. | `tests/optimizers.test.ts` |
| The shrunk covariance keeps the diagonal bit for bit, multiplies each off-diagonal entry by `1 - s`, and annualizes the exact covariance by `periodsPerYear`. | `tests/optimizers.test.ts` |
| Markowitz sizing returns certified tangency and mean-variance books from closes; the schedule re-optimises on the first axis date of each month from the history strictly before it, never sees a later return, and its backtest equals `simulatePortfolio` (or `simulateDrift`) and `periodStats` run on its own schedule. | `tests/markowitz.test.ts` |
| Every backtest option (simulator, expansion, re-optimisation dates, covariance and lookback, solver, and each constant) changes the result as named, defaults to today's value, and an unknown option key throws `RangeError` naming it; the building blocks are exported from the package entry. | `tests/markowitz.test.ts`, `tests/exports.test.ts` |
| The schedule callbacks carry what they read: `cov(history, context)` and `solve(mu, S, rf, context)` get `RebalanceContext` (`date`, `historyDates`, `trailing(n)`), `mu` gets `rf`, `expand(weights, date, rebalance)` runs once per axis date in ascending order with a copy of the re-optimisation in force, and each rebalance records `vol`; callbacks with the old arities give the default results; `dot2` and `twoProd` follow IEEE arithmetic on an infinite factor. | `tests/markowitz.test.ts`, `tests/exact-numerics.test.ts` |
| An API-only fill and a repo fill give the same local copy for the same backup id. | csvb `tests/fill-parity.test.ts` |
| The download client never has two requests in flight, waits `Retry-After`, stays inside the retry bounds, and adds no partial archive when interrupted. | csvb `tests/download-client.test.ts` |
| Canonical input generation preserves stored values, dates and vintage membership, including historical replay inputs. | csvb `tests/rerun-vintage.test.ts` |
| Identical pinned inputs and options produce byte-identical report payloads through backend and SDK, and payloads published before D78 replay up to rounding, including all backtest statistics; daily simulation values also match. | `tests/regime.test.ts`, `tests/backtest.test.ts` |
| A rerun with the original effective inputs produces the published report byte for byte when it was computed with the D78 arithmetic, and up to rounding when it was published before D78. Backend and SDK use the same committed observations; ingestion tolerances provide no downstream exception. | csvb `tests/rerun-vintage.test.ts` |

## 9. Open decisions

None beyond those in the analytics requirements.

## 10. References

- [`../definitions.md`](../definitions.md)
- [`analytics-requirements.md`](analytics-requirements.md)
- `packages/analyst-sdk/README.md`
- Decisions D57 (the package as a shared seam), D58 (data terms), D72 (archive format 1), D73 (the public analytics API serves the record), D74 (one source id), D79 (supported and supplementary series, two directories)
