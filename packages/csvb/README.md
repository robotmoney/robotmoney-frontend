# @robotmoney/csvb

csvb makes and reads the format 1 backups of the Robot Money regime and analytics tables (decisions D72 and D80).
The tool lives here, in robotmoney-frontend. The data lives in a checkout of the private robotmoney/csv-backups
repo, which holds backups and nothing else. Every command takes that checkout with `--repo`. csvb refuses to write
backups inside a robotmoney-frontend checkout.

Format 1 is defined once, in `packages/analyst-sdk/src/archive/format1.ts`: the record, file names, COPY CSV text,
part splitting, the table catalog and the backup cut rule. csvb, the public archive routes and the SDK's reader all
use it. The SDK never imports csvb; csvb imports the SDK (a path dependency on `../analyst-sdk`).

## The one rule

**Files in a backup repo are write-once. A backup only ever adds files.** Nothing is overwritten. Anything the
database rewrites in place is stored as a *revision* (a new file), and the tool finds the version you ask for.

## Layout of a backup repo

```
csv/<backup id>/                  one directory per backup; self-contained, written once, never touched again
    backup.json                   the record: what this backup added, watermarks, database totals, anomalies
    data/                         rows this backup added to the append-only tables
        <table>.<start>_<end>.csv.gz        <start> and <end> are the earliest and latest row time in the file (UTC)
        <table>.late.<start>_<end>.csv.gz   rows that committed late (see Anomalies)
    revisions/                    rows of the revised tables that are new or changed since the previous backup
        <table>.csv.gz
reports/                          generated audit reports; gitignored in robotmoney/csv-backups, never committed
```

**File names.** A data file is named `<table>.<start>_<end>.csv.gz`, where `<start>` and `<end>` are the earliest and
latest time of its rows, in UTC to the second (`YYYY-MM-DDTHHMMSSZ`). Which time counts is per table (`created_at`,
`recorded_at`, `knowledge_time`, `observed_at`; for `analytics_vintage_members`, which carries none, the time of its
vintage) and is recorded in `backup.json`. If two files of one table in one backup cover the same period, the second
gets `-2` before `.csv.gz`. The id range of each file is in `backup.json`, not in the name.

## Backup ids: the day cut and the legacy junction

A **backup id** is a UTC day boundary, `YYYY-MM-DDT000000Z`. csvb and the public archive routes cut by the same rule.
A boundary is cut once it is an hour in the past. Per append-only table, its watermark is the largest id below the
first row stamped at or after the boundary. Vintage members follow their vintage, so one vintage's members are never
split between backups. A run that finds several sealed boundaries since the repo's newest backup writes one backup
per boundary, all from one snapshot. A revised table's state is recorded in the newest of them, because its past
states are not in the database.

Before the day cut, csvb named a backup by its replica snapshot time. Those backups stay in robotmoney/csv-backups byte
for byte, and `csvb verify` keeps verifying them. Their ids are a closed list in
`packages/analyst-sdk/src/archive/format1-legacy.ts`. The newest, `2026-10-28T180400Z`, is the **junction**. The API
serves it too, with the same watermarks, between its day cuts. Both writers cut the next day from it, so a clone of
the repo plus an API increment join there. csvb continues only from the junction or from a day-cut backup.

## Two kinds of table

**Append-only** tables only ever gain rows. Each backup adds only rows whose `id` is above the highest id already held.

| table | what it is |
|---|---|
| `analytics_output_snapshots` | **what was actually published**: each run's frozen output (JSON text in `payload_json`, with `payload_sha256`, the SHA-256 of the stored bytes) |
| `analytics_report_snapshots` | one frozen report per run |
| `source_value_versions` | every value the pipeline ever observed, with its revision lineage |
| `analytics_ledger_runs`, `analytics_ledger_run_events`, `analytics_ledger_methodology_versions` | the run ledger |
| `analytics_data_vintages`, `analytics_vintage_members` | frozen input sets for each run |
| `analytics_overwrite_events` | every in-place change the database made to a stored row, with the row before and after |
| `analytics_parity_observations` | legacy-versus-ledger comparisons |

**Revised** tables are rewritten in place by the database. Each backup adds one revision file holding only the rows
that are new or changed since the previous backup, plus a `delete` marker for rows that vanished. The state at any
backup is the replay of the revision files up to it.

| table | key |
|---|---|
| `regime_snapshots` | `date` |
| `raw_indicator_history` | `indicator, date` |
| `asset_prices` | `price_date, symbol, time_basis` |
| `analytics_read_mode` | `id` |

`regime_snapshots` is a *current view*, not a snapshot: every run recomputes the whole history and overwrites the
rows. **What was published on a given day is in `analytics_output_snapshots`**, frozen per run.

## Reading the backups

```
cd packages/csvb && bun install
bun run csvb list    --repo ~/csv-backups                                          # every backup, and what each added
bun run csvb resolve --repo ~/csv-backups --table regime_snapshots --as-of 2026-10-05   # the table as of a backup
bun run csvb history --repo ~/csv-backups --table regime_snapshots --where date=2026-09-26
bun run csvb diff    --repo ~/csv-backups --table raw_indicator_history --from 2026-10-05T1454Z --to latest
bun run csvb verify  --repo ~/csv-backups                                          # prove the repo is intact, from the files alone
```

`--as-of` takes `latest`, a backup id, a date (the newest backup that day or before), or a date and time.

## Auditing

```
bun run csvb audit runs      --repo ~/csv-backups   # run-ledger health: failure streaks, days with no successful run
bun run csvb audit drift     --repo ~/csv-backups   # how published figures moved after they were published
bun run csvb audit revisions --repo ~/csv-backups   # what the database revised in place, and how much
bun run csvb audit replay    --repo ~/csv-backups [--sdk DIR] [--reference-js DIR] [--run ID]
bun run csvb audit all       --repo ~/csv-backups
```

They read the backups, never the database, and write a report to `--out`, by default `<repo>/reports/<backup id>/`.
The replay rebuilds a run's exact inputs from its frozen vintage and runs the analyst SDK; `--sdk` defaults to
`../analyst-sdk`, the package beside this one.

## Making a backup

```
cd packages/csvb && bun install
bun run csvb backup --repo ~/csv-backups     # reads ~/.env, connects as rm_readonly to the read replica
bun run csvb verify --repo ~/csv-backups
cd ~/csv-backups && git add -A && git commit -m "backup <id>" && git push
```

The connection comes from `~/.env`: the `host`, `port`, `database` and `sslmode` tokens and the `rm_readonly`
password line. A file that also holds an `rm_owner` or `doadmin` line is refused. The password is never printed.
`RM_REPLICA_URL` overrides the file.

The backup refuses a server that is not a replica. It reads in one READ ONLY, REPEATABLE READ transaction, pages by id
with a statement timeout, retries a failed page smaller without poisoning the snapshot, pauses between pages, stops
after a time budget and rolls back cleanly on SIGINT or SIGTERM. Options: `--part-mb` (default 64, at most 90, since
GitHub rejects files over 100 MB), `--pause-ms`, `--max-seconds`, `--statement-timeout-s`, `--max-rss-mb`,
`--only table,table`, `--env-file`. The staged files are verified before they join the repo; `csvb finish` completes
a run interrupted after staging.

## Anomalies

A backup never stops because the database looks different from what the repo expects. It records the difference,
carries on, and exits with status 3.

- **Deleted rows:** rows the repo holds that the database no longer has. The repo keeps its copy.
- **Late rows:** rows with ids at or below the watermark that were not in the repo. They are captured in a `late.` file.

The tool stops, and adds nothing, when the server is not a replica, a column layout changed, a payload does not match
its hash, or the new files fail verification.

## Tests

`bun test` needs Docker: `tests/pg.ts` starts one named Postgres container per suite and removes exactly that
container. `.github/workflows/csvb.yml` runs the suite. `tests/fixtures/legacy/` is a synthetic chain of snapshot-time
backups (never production data), written once by csvb before the day cut (robotmoney/csv-backups `d60f710`) from the
rows of the SDK's synthetic `repo-plus-increment` archive fixture; `packages/analyst-sdk/tests/fixtures/archive/legacy-snapshot/`
is a copy of it. The byte parity between csvb and the archive routes is `backend/tests/csvb-api-archive-parity.test.ts`.
