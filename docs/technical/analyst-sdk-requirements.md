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

- **Pure computation.** `src/` calls no network, reads no database and reads no environment. Tests run with `fetch` replaced by a thrower.
- **Files only at the edge.** The command line is the only place that reads or writes a file.
- **Install alone.** The package installs from a sparse clone of its own directory.
- **No archive import.** The SDK never imports the archive tool. The archive tool may import the SDK.

## 3. The local copy

The local copy is a set of backups on the analyst's machine, in the archive format of [analytics requirements section 4.4](analytics-requirements.md).

**Default fill, for holders of repo access.** The recommended path has two steps:

1. Download the backups from the robotmoney/csv-backups repo. A clone brings every backup up to the newest one.
2. Resume from the checkpoint. The tool reads the newest backup's watermarks and fetches only what is newer, as archives from the public API.

The default exists so an analyst gets up and running faster. The repo gives the bulk in one transfer, with no long run of paced API requests. The API gives the increment, so a second run costs only what changed. A past state is pinned by naming a backup id.

**Other fills:**

| Fill | When | How |
| ---- | ---- | --- |
| API only | No access to the repo. This is the path for outside analysts. | Fetch every archive from the public API, within the client rules in section 5. |
| Replica | Operators only. | `csvb backup --source db`. |
| Original sources | To audit the API. | The source clients in `src/extract/` fetch source data directly and return it to the caller. They write no archives. |

The SDK does not fetch from the original sources by default. The API serves source data that the backend has already cleaned.

**Access.** The csv-backups repo is private and holds production data. Only holders of read access use the default fill. Everyone else uses the API-only fill. The two fills produce the same local copy.

## 4. The input file

The SDK computes from a derived report of source data, not from the archives.

- **Format.** A CSV with exactly the header `date,indicator,value,source`, or the same rows as JSON. The rules are in [analytics requirements section 4.1](analytics-requirements.md).
- **Content.** `csvb inputs --archive <dir> --run <run_key>` writes the source data in a run's vintage. `SPX`, `ETH` and `TBILL3M` are rows in the same file. The mapping from ledger keys to SDK ids (`backtest:^GSPC` to `SPX`, `backtest:ETH-USD` to `ETH`, `backtest:DTB3` to `TBILL3M`) lives in `LEDGER_EXTRA_KEYS`.
- **Legs.** A ratio indicator is two rows of source data, one per leg ([section 4.2 of the analytics requirements](analytics-requirements.md)).
- **Manifest.** The input file gets a sidecar `inputs.manifest.json`. It records the backup id, the run key, the as-of date, the source (`api` or `db`), the row count and the sha256 of the input file. The command line reads it at the edge and copies it into the output. The computation does not read it.
- **Why the file is derived.** It is cheap to regenerate from the backups, and the backups are the record. A file without a manifest still runs. Its output says the source data is not pinned.

## 5. Download client

The download client is a polite, resumable reader. It fetches archives under the server limits in [analytics requirements section 4.7](analytics-requirements.md).

- **One at a time.** One request in flight, at most 1 request a second.
- **Retries.** Honour `Retry-After` exactly on 429 and 503. Otherwise back off with full jitter from 1 to 60 seconds, at most 5 retries per request. Do not retry any other 4xx.
- **Identity.** Send a `User-Agent` that names the tool and its version.
- **Estimate first.** Print the number of requests before the first one. Refuse a plan over `--max-requests` (default 500).
- **Resumable.** An interrupted download adds no partial archive. The next run starts from the last committed watermark.
- **Verified.** Each archive is checked against its served checksum before it joins the local copy.

## 6. Command line

`bun run regime <input-file>` reads one file and prints the regime report as JSON. It takes `--start`, `--asof`, `--factor` and `--full`. The package README documents the options. A run with `--asof` replays the regime as of that day.

## 7. Success criteria and tests

- From a clean sparse clone, `bun install` and `bun run regime <file>` return a regime report.
- The default report matches `tests/golden/regime-report.json`.
- `bun test` passes with `fetch` replaced by a thrower.
- `bunx tsc --noEmit` is clean.
- An API-only fill and a repo fill give the same local copy for the same backup id.
- The download client never has two requests in flight, waits `Retry-After`, stays inside the retry bounds, and adds no partial archive when interrupted.
- Two runs on the same input file give the same output, and the output names the manifest.

## 8. Open decisions

None beyond those in the analytics requirements.

## 9. References

- [`../definitions.md`](../definitions.md)
- [`analytics-requirements.md`](analytics-requirements.md)
- `packages/analyst-sdk/README.md`
- Decisions D57 (the package as a shared seam), D58 (data terms), D71 (archive format 1)
