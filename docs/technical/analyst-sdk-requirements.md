# Analyst SDK requirements

Owner: Lucas. Package: `packages/analyst-sdk`. Terms are defined in [`../definitions.md`](../definitions.md). The module the SDK exposes is specified in [`analytics-requirements.md`](analytics-requirements.md). This document specifies the client side: how an analyst gets source data onto their machine and runs the module on it.

## 1. Purpose and users

The analyst SDK lets anyone check the published regime and rebuild it. It is the analytics module (same code as the backend, D57) plus the tools to fetch source data and run it. An analyst runs it with Bun on their own machine.

Users:

- An outside analyst who wants to download the source data and rerun the regime.
- A member's agent that wants to call regime and backtest functions with JSON in and JSON out.

Non-goals:

- Anything listed as a non-goal in the analytics requirements.
- Running the backend, or writing to the production database.

## 2. Principles

- **One shared calculation.** Identical effective inputs and report options produce byte-identical report payloads in backend and SDK before and after the refactor. Existing operation order, dates, nulls, field order and number formatting are preserved. This refactor introduces no alternative calculation methodology or backend-only compatibility engine.
- **Pure computation.** The computation calls no network, reads no database and reads no environment. Only the source clients in `src/extract/` fetch, and only through `src/extract/http.ts`. Tests run with `fetch` replaced by a thrower.
- **Files only at the edge.** The command line is the only place that reads or writes a file.
- **Install alone.** The package installs from a sparse clone of its own directory.
- **No archive import.** The SDK never imports the archive tool. The archive tool may import the SDK.
- **The archive tool fetches.** csvb owns the local copy, every fill and the download client. Provider collection and archive downloads are extract-stage acquisition, completed before downstream execution. The SDK run reads supplied local inputs.
- **No HTTP after extract.** Preparation, transforms, regime and research calculations, allocation, backtesting and reporting, including callbacks and dependencies, make no HTTP requests. A run never downloads a missing series or invokes csvb or a source client. Missing required inputs fail explicitly; optional missing inputs produce the documented missing result.

## 3. The local copy

The local copy is a set of backups on the analyst's machine, in the archive format of [analytics requirements section 4.5](analytics-requirements.md). It holds every collected version of source data and every published report, with the vintages that link them. An analyst can therefore compare a rerun with the report the run published.

**Default fill, for holders of repo access.** The recommended path has two steps:

1. Download the backups from the robotmoney/csv-backups repo. A clone brings every backup up to the newest one.
2. Resume from the checkpoint with `csvb backup --source api`. The tool reads the newest backup's watermarks and fetches only what is newer, as archives from the public API.

The default exists so an analyst gets up and running faster. The repo gives the bulk in one transfer, with no long run of paced API requests. The API gives the increment, so a second run costs only what changed. A past state is pinned by naming a backup id.

**Other fills:**

| Fill | When | How |
| ---- | ---- | --- |
| API only | No access to the repo. This is the path for outside analysts. | `csvb backup --source api` into an empty directory fetches every archive from the public API, within the client rules in section 5. |
| Replica | Operators only. | `csvb backup`. Reading the database is the default source. |
| Original sources | To audit the API. | The source clients in `src/extract/` fetch source data directly and return it to the caller. They write no archives. |

SDK computation never fetches from original sources or the public API. An analyst invokes acquisition separately to collect or download the inputs before running computation. Optional source clients support that extract stage only. The API serves source data that the backend has already cleaned.

**Access.** The csv-backups repo is private and holds production data. Only holders of read access use the default fill. Everyone else uses the API-only fill. The two fills produce the same local copy.

## 4. The input file

The SDK computes from a derived report of source data, not from the archives.

- **Format.** A CSV with exactly the header `date,series,value`, or the same rows as JSON. Each `series` is a source id. Dates are real calendar dates and values are plain decimals. The rules are in [analytics requirements sections 4.1 and 4.2](analytics-requirements.md).
- **Content.** `csvb inputs --archive <dir> --run <run_key>` writes the source data in a run's vintage, under canonical source ids, using the shared storage mapping when archives carry historical keys. Historical replay also preserves original calculated ratio inputs through the replay contract defined in the analytics requirements; it does not invent missing legs. The series the correlations and the backtest read are rows in the same file.
- **Committed values.** Input generation copies the exact committed values and versions for the run. Source-update jitter filtering is completed during ingestion; no tolerance, rounding or substitution is applied to downloaded inputs, calculations or report comparisons.
- **Coverage.** The supplied inputs cover the requested date range and all required source series, including ratio legs, prices, yields, benchmarks and research inputs used by the workflow. Report missing required coverage explicitly before the dependent calculation; never fetch it during a run.
- **Legs.** A ratio indicator is two rows of source data, one per leg ([section 4.3 of the analytics requirements](analytics-requirements.md)).
- **Manifest.** The input file gets a sidecar `inputs.manifest.json`. It records the backup id, the run key, the as-of date, the source (`api` or `db`), the row count, the sha256 of the input file, the methodology id and exact code revision. The command line reads it at the edge and uses the recorded identity as provenance, not as a choice between different backend and SDK calculations. The computation does not read the sidecar. Provenance accompanies the report in an explicit envelope; the original report payload retains its shape.
- **Why the file is derived.** It is cheap to regenerate from the backups, and the backups are the record. A file without a manifest still runs. Its provenance envelope says the source data is not pinned.

## 5. Download client

The download client is a polite, resumable reader. It fetches archives under the server limits in [analytics requirements section 4.8](analytics-requirements.md).

- **One at a time.** One request in flight, at most 1 request a second.
- **Retries.** Honour `Retry-After` exactly on 429 and 503. Otherwise back off with full jitter from 1 to 60 seconds, at most 5 retries per request. Do not retry any other 4xx.
- **Identity.** Send a `User-Agent` that names the tool and its version. The version is read from the tool's `package.json`. The SDK's source clients follow the same rule with the SDK's version. A released SDK version is tagged `analyst-sdk-vA.B.C` on its own release line (proposed in [D77](../decisions.md#d77)).
- **Estimate first.** Print the number of requests before the first one. Refuse a plan over `--max-requests` (default 500).
- **Resumable.** An interrupted download adds no partial archive. The next run starts from the last committed watermark.
- **Verified.** Each archive is checked against its served checksum before it joins the local copy.

## 6. Command line

`bun run regime <input-file>` reads one file and prints the regime report as JSON. It takes `--start`, `--asof`, `--factor` and `--full`. The package README documents the options. A run with `--asof` replays the regime as of that day.

- **Paths.** A relative path resolves from the folder the analyst ran the command in.
- **Bad arguments.** The command exits non-zero with a message on any of these: a second input file, a repeated option, an unknown option, a `--start` after every input row, or an input with no series the run reads.
- **Pinning.** An explicit provenance output envelope carries the report and its `manifest`. With no manifest the envelope carries `pinned: false`. The existing report-only output retains its shape.
- **Calculation identity.** Replay records the original methodology and code revision for audit. Backend and SDK use the same shared calculation; no methodology-selection option is introduced by this refactor. With identical pinned inputs and options, replay through the refactored module preserves the original serialized report byte for byte.

## 7. Success criteria and tests

Package paths are relative to `packages/analyst-sdk/`. csvb paths are relative to the robotmoney/csv-backups repo.

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
| An API-only fill and a repo fill give the same local copy for the same backup id. | csvb `tests/fill-parity.test.ts` |
| The download client never has two requests in flight, waits `Retry-After`, stays inside the retry bounds, and adds no partial archive when interrupted. | csvb `tests/download-client.test.ts` |
| Canonical input generation preserves stored values, dates and vintage membership, including historical replay inputs. | csvb `tests/rerun-vintage.test.ts` |
| Identical pinned inputs and options produce byte-identical report payloads through backend and SDK before and after refactoring, including all backtest statistics; daily simulation values also match. | `tests/regime.test.ts`, `tests/backtest.test.ts` |
| A rerun with the original effective inputs produces the published report byte for byte. Backend and SDK use the same committed observations; ingestion tolerances provide no downstream exception. | csvb `tests/rerun-vintage.test.ts` |

## 8. Open decisions

None beyond those in the analytics requirements.

## 9. References

- [`../definitions.md`](../definitions.md)
- [`analytics-requirements.md`](analytics-requirements.md)
- `packages/analyst-sdk/README.md`
- Decisions D57 (the package as a shared seam), D58 (data terms), D72 (archive format 1), D73 (the public analytics API serves the record), D74 (one source id)
