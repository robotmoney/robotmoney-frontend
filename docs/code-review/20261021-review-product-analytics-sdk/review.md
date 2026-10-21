# Analytics and analyst SDK: requirements against implementation

Date: 2026-10-21. Pinned at `adhoc/20261021-190454-analyst-sdk-spec` @ `71ba4092` (equal to `origin/main` plus the spec commit).

Specs under review:

- [`docs/technical/analytics-requirements.md`](../../technical/analytics-requirements.md)
- [`docs/technical/analyst-sdk-requirements.md`](../../technical/analyst-sdk-requirements.md)
- [`docs/definitions.md`](../../definitions.md)

Code read: `packages/analyst-sdk/**`, `backend/src/analytics/**`, `backend/src/api/routes/public-analytics.ts` and its helpers, `backend/src/db/client.ts`, `website-server/nginx.conf`, `docker-compose.yml`, `frontend/public/openapi.json`. The csvb source came from robotmoney/csv-backups (last pushed 2026-10-19) through `gh api`, because the local `~/csv-backups` checkout is empty.

Finding ids: `AN-` is the analytics module, `API-` is the public API and server, `SDK-` is the client side, `DOC-` is a spec or doc error.

## 1. Verdict

The regime computation meets the spec. The registry, the loader, `asof`, the forward-fill cap, the golden report, determinism and purity all hold.

Most other parts of the two specs describe a system that does not exist yet:

- **No archive API.** No archive routes and no `backup.json` listing exist, and no watermarks are served. The four routes still serve JSON pages, as D58 describes.
- **No load protection.** None of the §4.7 protections are built.
- **No way to fill a local copy.** There is no download client, no API fill, no `csvb inputs` and no input manifest.
- **No backtest API.** `simulatePortfolio`, `periodStats` and `scheduleFromLabels` do not exist.
- **Ratios, not legs.** Ratio indicators are computed when the data is fetched. Everywhere after that they are read as single values, not as two legs.

The specs are written in the present tense ("the API serves archives"). A reader cannot tell which parts are target state.

## 2. Test runs

| Check | Result |
| ----- | ------ |
| `bun test` in `packages/analyst-sdk` | 31 pass, 0 fail, `fetch` replaced by a thrower |
| `bunx tsc --noEmit` | Clean after `bun install`. It fails with `TS2688 bun-types` in a worktree without `node_modules`. |
| `scripts/tests/unit/analyst-sdk-purity.test.ts` | 37 pass, 0 fail |
| Sparse clone of `packages/analyst-sdk`, then `bun install` and `bun run regime` | Works. The CSV and JSON outputs are byte-identical to `tests/golden/regime-report.json`. |
| Two CLI runs on the same input | Same sha256 |

## 3. Missing features

| Id | Severity | Spec | Finding | Evidence |
| -- | -------- | ---- | ------- | -------- |
| API-1 | high | analytics §4.5, §4.6, §7 | No archive routes exist: no `<table>.<start>_<end>.csv.gz`, no revision archives with `_backup`/`_op`, no backup listing, no watermarks. The "byte-identical to the replica" criterion has no code. | `public-analytics.ts:532-537` (four JSON handlers only). Body is `JSON.stringify` (`:515`). |
| API-2 | high | analytics §4.7 | No concurrency gate. Public reads share the 10-connection pool with no cap, and nothing answers 503 + `Retry-After`. | `backend/src/db/client.ts:21`. There is no gate in `public-analytics.ts`. |
| API-3 | high | analytics §4.7 | The limit is a flat 100 requests a minute. It has no 1/10 cost weights and no 50 MB/min byte budget. | `public-analytics.ts:50-51,64`, `backend/src/api/rate-limit.ts:66-77` |
| API-4 | high | analytics §4.7 | No edge cache: no `proxy_cache`, no lock, no 256 MB bound, no `X-Cache-Status`. | `website-server/nginx.conf:149-160` |
| API-5 | high | analytics §4.5 | `SPX`, `ETH` and `TBILL3M` are not served. They live in `source_value_versions` as `backtest:*` keys. The API exposes only their ids, through vintage members. `asset_prices` holds fund pricing, not these series. | `backend/src/analytics/access/data-source.ts:196-201`, `public-analytics.ts:167-171`, `backend/migrations/0046_asset_prices.sql:15-18` |
| API-6 | medium | analytics §4.4 | Revisions of `asset_prices` are never captured. The upsert overwrites in place, so overwrite-events cannot serve them. | `backend/migrations/0056_analytics_overwrite_events.sql:65-69`, `backend/src/ops/asset-prices.ts:83` |
| SDK-1 | high | sdk §5 | No download client exists in the SDK, in this repo or in csvb. None of the §5 rules exist. It also has no archive routes to call (API-1). | grep for `Retry-After`, `max-requests`, `jitter`, `checksum`. csvb subcommands are listed at `csvb src/cli.ts:70-195`. |
| SDK-2 | high | sdk §3 | Neither the default fill (repo clone, then an API resume from watermarks) nor the API-only fill exists. `csvb backup` reads only Postgres. Outside analysts have no supported path. | `csvb src/backup.ts:22,302-353` |
| SDK-3 | high | sdk §4 | `csvb inputs --archive --run` does not exist. The closest is `csvb audit replay`, which builds inputs in memory and writes no file. | `csvb src/audit/replay.ts:119` |
| SDK-4 | high | sdk §4, §7; analytics §6 | No `inputs.manifest.json`. The CLI reads no sidecar, copies no manifest and never says "not pinned". The SDK run records no input hashes or vintage id. Only the backend builds a run manifest. | `packages/analyst-sdk/bin/regime.ts:35-38`. Only manifest builder: `backend/src/analytics/run-ledger.ts:105-159`. |
| SDK-5 | medium | sdk §3 | `csvb backup --source db` is not a valid command: `backup` takes no `--source` flag, and unknown flags are rejected. The database backup itself works. | `csvb src/cli.ts:4-5,58` |
| AN-1 | high | analytics §5.3 | `simulatePortfolio(dateAxis, schedule, prices, cashRate, options)` does not exist. The only simulator is the private `simulate()`, which is tied to regime labels, `eth`/`sp500` and `tbill3m`. It has no `costBps` option and returns no `cost`. "Any assets" (§5.2) is not met. | `src/analyze/backtest.ts:20,61-74,103-106,195` |
| AN-2 | high | analytics §5.4 | `periodStats(valueSeries, from, to)` does not exist. Drawdown and Sharpe are computed only over the full run. The "fewer than two days gives nulls" rule is absent: `simulate` returns `sharpe: 0`. | `backtest.ts:255-259` |
| AN-3 | high | analytics §5.5 | `scheduleFromLabels(labels, table)` does not exist. The reference portfolios are data (`PORTFOLIO_SPECS`), but they cannot run through a public simulator. | `backtest.ts:31-59` |

## 4. Divergent from the spec

| Id | Severity | Spec | Finding | Evidence |
| -- | -------- | ---- | ------- | -------- |
| AN-4 | high | analytics §4.2; sdk §4; definitions "Ratios" | The eight ratio indicators are divided at extract time and stored, served and read as one series. No legs exist anywhere: not in the fixture, the database or the API. `applyRatio` has no caller, and `applyTransform` has no ratio case. | `src/extract/sources.ts:66-74,83-88`, `src/prepare.ts:45`, `src/transform/transforms.ts:11,44`, `backend/src/analytics/source-tolerance.ts:67-82`. The fixture holds `COPPER_GOLD` with no `HG=F` or `GC=F`. |
| API-7 | high | analytics §4.3 | overwrite-events serves revisions of `regime_snapshots` and `research_signals`, which are calculated outputs. The spec says calculated indicators are not served. | `public-analytics.ts:425,465-466` |
| API-8 | high | analytics §4.7 | The statement timeout is pool-wide, 5 minutes rather than 5 seconds. | `backend/src/db/client.ts:15` |
| API-9 | medium | analytics §4.7 | Gzip runs on the event loop (`Bun.gzipSync`). An overwrite-events page can be about 8 MB of JSON. | `public-analytics.ts:62,526` |
| API-10 | medium | analytics §4.7 | The ETag is a weak hash of the body, computed after the full query, so a 304 still pays for the whole read. No route sends `immutable` or `max-age=31536000`. List `max-age=300` matches. | `public-analytics.ts:494-496,514-523`, `contract/src/public-analytics.js` |
| API-11 | medium | analytics §4.7 | The rate limit keys on `CF-Connecting-IP`, not `X-Client-IP`. nginx decides trust from a hard-coded Cloudflare range table, which is a CDN rule. | `backend/src/api/client-ip.ts:59-60`, `backend/src/api/index.ts:169`, `nginx.conf:42-75` |
| API-12 | low | analytics §4.3 | raw-history serves every key in `raw_indicator_history`, including the research input `MNA`, not only the 26 indicators. | `source-tolerance.ts:87` |
| AN-5 | medium | analytics §5.5 | `blend_hodl` is a constant-mix portfolio rebalanced daily at no cost, not buy-and-hold. With ETH going 100→200→100 and SPX flat, it ends at 1.125. A true 50/50 hold ends at 1.0. The single-asset baselines are correct. The spec must say which it means. That choice also sets the §7 criterion "a never-changing schedule equals buy-and-hold". | `backtest.ts:215,222-229` |
| AN-6 | low | analytics §5.3 | Strategies start on the first labelled date. Baselines start on the first priced date (fixture: 2022-05-03 against 2022-01-01). So `final_value` and `cagr` are not comparable across them. | `backtest.ts:160-165` |
| AN-7 | low | analytics §5.3 | Cash earns 0% before the first `TBILL3M` row, instead of being treated as missing. | `backtest.ts:95-101` |
| SDK-6 | low | sdk §5 | The User-Agent is the hard-coded `robotmoney-regime/1.0`, while the package is `0.1.0`. Yahoo and Shiller send a browser string instead. | `src/extract/http.ts:12`, `yahoo.ts:51`, `shiller.ts:114` |

## 5. Bugs

| Id | Severity | Finding | Evidence | Verified |
| -- | -------- | ------- | -------- | -------- |
| API-13 | high | A query that times out answers 500, not 503. SQLSTATE 57014 is neither class 22 (mapped to 400) nor class 08 (mapped to 503). | `public-analytics.ts:558-560`, `client.ts:134-139`, `api/index.ts:189-190` | read |
| API-14 | medium | A caller can pick its own rate-limit bucket. The api publishes `8787` on every interface with `TRUST_PROXY=1`, so a caller who reaches it sets `CF-Connecting-IP`. nginx also trusts that header from any private-range peer. The comment that the port "is never published" is false. Prod exposure depends on the DigitalOcean firewall, which was not checked. | `docker-compose.yml:310,405`, `nginx.conf:46-48,72-75`, `client-ip.ts:17-19`. A test shows the behaviour: `backend/tests/api/public-analytics.test.ts:621-633`. | read |
| AN-8 | medium | An unknown indicator is not ignored. With no `asof`, the newest row of any key sets the end of the date axis. A stray `FOO` row dated 2027-06-01 moves asof to that date and makes the composite NaN and the label null. | `src/run.ts:85-89` | snippet |
| AN-9 | medium | A day with no weights loses that day's market move. `continue` skips the day, and the next return compares day i-1 with day i. Labels `[on, null, on, on]` with ETH 100→200→200→200 end at 1.0, while hodl ends at 2.0. This is latent: the fixture has no null labels after 2022-05-03. | `backtest.ts:216,225-226` | snippet |
| AN-10 | low | `cagr_out_sample` is one day off. Its start value is the first point after 2024-01-31, but its span is counted from 2024-01-31. The file is a verbatim port, so a fix breaks the fidelity tests. | `backtest.ts:270,275` | read |
| AN-11 | low | `mergeRatioSeries` skips zero or non-finite denominators but not a NaN numerator, which gives a NaN ratio row. | `src/extract/sources.ts:83-88` | read |
| SDK-7 | low | The loader accepts impossible dates such as `2026-02-30` (regex check only). It also accepts loose numbers: `0x10` is read as 16 and ` 1e1 ` as 10. | `src/input/load.ts:52,55,57` | run |
| SDK-8 | low | The CLI silently accepts bad arguments: a second file, a repeated `--asof`, a `--start` after every row (exit 0 with a 1-day axis), or an input with no registry indicators (exit 0, all null). | `bin/regime.ts:11-30`, `src/run.ts:68-81` | run |
| SDK-9 | low | Relative input paths resolve against the package root, because `bun run` changes directory. From `tests/`, `bun run regime fixtures/…` fails with ENOENT. | `bin/regime.ts` | run |
| API-15 | low | The overwrite-events byte budget counts UTF-16 code units, not bytes. | `public-analytics.ts:469` | read |

## 6. Spec and doc errors

| Id | Severity | Finding | Evidence |
| -- | -------- | ------- | -------- |
| DOC-1 | medium | Both specs cite D71 for "archive format 1". D71 is "Every judge judges; the winner is drawn at random". No decision records format 1. | `analytics-requirements.md:72,226`, `analyst-sdk-requirements.md:93`, `docs/decisions.md:5772` |
| DOC-2 | medium | D58 still specifies the old design: a flat 100/min limit, a weak ETag, max-age 300, `CF-Connecting-IP`. The new §4.7 contradicts it, and nothing supersedes it. | `docs/decisions.md` D58 |
| DOC-3 | medium | SDK §2 says "`src/` calls no network". SDK §3 and the code have `src/extract/` fetch through `http.ts`. The README repeats the contradiction. Proposed wording: "the computation calls no network; only `src/extract` fetches, through `src/extract/http.ts`". | `analyst-sdk-requirements.md` §2, `src/extract/http.ts:45-46` |
| DOC-4 | medium | The README section "Reproducing a published run" tells analysts to query production tables with SQL. It never mentions the local copy, csvb or the manifest. | `packages/analyst-sdk/README.md` |
| DOC-5 | low | "The backend files are one-line re-exports" is true for the compute files only. `extract/http.ts` and `extract/sources.ts` add backend wiring. `analyze/regime.ts` stays in the backend by design. | `backend/src/analytics/extract/*` |
| DOC-6 | low | The OpenAPI lists only `200` for the four routes: no 304, 400, 405, 429 or 503. | `frontend/public/openapi.json` |
| DOC-7 | low | The README sample row `2024-01-02,VIX,13.2,fred` names the wrong source. VIX comes from Yahoo `^VIX`. | `packages/analyst-sdk/README.md` |
| DOC-8 | low | Analytics §4.1 says correlations and the backtest are null without `SPX`, `ETH` and `TBILL3M`. In fact, with only `TBILL3M` missing, correlations are present and the backtest is null. | snippet |

## 7. Test gaps

Each criterion below has no test:

- **Analytics §7, backtest:** no-peeking; a never-changing schedule against buy-and-hold; `periodStats` against the simulator totals; `simulatePortfolio` against `computeBacktest`. The functions under test do not exist (AN-1 to AN-3). The no-peeking rule itself is coded correctly inside `simulate`.
- **Analytics §7, replay:** a replay of a published run, and as-of labels against the published record from 2026-09-21 (issue 1182). The fidelity tests compare against the original JS port, not the published record.
- **Analytics §7, archives:** API and replica archives being byte-identical. Every §4.7 protection.
- **Analytics §4.1:** unknown indicators being ignored (AN-8 shows they are not), and the sections being null without the extras.
- **Analytics §7, "every function has a test":** `applyRatio`, `ratioByDate`, `shapeDaily`, `combineConservativeN` and `combineAggressiveN` have no package test.
- **SDK §7:** the sparse-clone install, the API fill against the repo fill, the download client and the output naming the manifest. The test "the CLI report reproduces the golden output" (`tests/regime.test.ts:43-45`) never runs the CLI. A hand run confirms the CLI matches.
- **Purity:** the purity test does not forbid `fetch` outside `extract/http.ts`. It does not forbid a csvb import either. The shim test checks two backend files only (`analyst-sdk-purity.test.ts:109-127,189-193`).

## 8. Confirmed met

- **Registry:** 26 indicators: macro 8, onchain 10, factor 8. The composite uses `PANELS = ["macro","onchain"]`. The factor panel is display-only (`indicators.ts:464`).
- **Input format:** the loader checks the exact header after stripping the BOM. CSV and JSON give byte-identical output. An indicator with no rows carries weight 0.
- **Reproducibility:** `asof` cuts rows and extras. `MAX_FORWARD_FILL_DAYS = 120` is applied and tested.
- **Backtest rules inside `simulate`:**
  - no peeking,
  - a 10 bps cost on one-sided turnover, halved,
  - cash earns the previous day's yield, compounded over 365 days,
  - the series starts at 1 on the first date with every price,
  - price gaps are filled forward,
  - Sharpe is mean/sd·√365 with sample sd.
- **Reference data:** `eth`, `sp500` and `mixed` weight tables, the hodl baselines and `stables_only` exist.
- **Purity and install:** `src/` reads no fs, env or database. Only `bin/regime.ts` reads a file. The SDK installs alone from a sparse clone and never imports csvb.
- **Extras mapping:** `LEDGER_EXTRA_KEYS` maps `^GSPC`, `ETH-USD` and `DTB3` to `SPX`, `ETH` and `TBILL3M` (`src/extras.ts:14-18`). csvb copies the map instead of importing it, so the two can drift.
- **CLI:** `--start`, `--asof`, `--factor` and `--full` work and are documented. The output is deterministic.
- **Public API:** four GET-only routes with the stated filters, 405 on any other method, correct keyset paging, `max-age=300` on lists, 429 with `Retry-After`, Yahoo rows served (D58), provider-terms note in the README.
- **csvb:** `csvb resolve --as-of` exists.

## 9. Recommended order

1. **Fix the specs first.** Mark the target-state sections of both specs as not yet built. Record archive format 1 as its own decision, and fix the D71 citation (DOC-1). Supersede D58 with the §4.7 design (DOC-2). Reword SDK §2 (DOC-3). Say whether `blend_hodl` means buy-and-hold or constant mix (AN-5).
2. **Fix the production bugs.** A timeout should answer 503 (API-13), with a 5 second public timeout (API-8). Close the spoofable rate-limit key (API-14). These protect the live site today.
3. **Store ratio legs (AN-4).** This changes the extractor, the stored keys, the API and the input file at once. It needs its own migration plan.
4. **Expose the backtest API** (AN-1 to AN-3) with its §7 tests. Fix AN-8 and AN-9 in the same change.
5. **Build the archive routes and load protection** (API-1 to API-6), then the download client, the fills, `csvb inputs` and the manifest (SDK-1 to SDK-5). The client depends on the routes.

## Addendum, 2026-10-21: owner clarification on what the API serves

The owner stated the rule: the API serves source data as it was published at the time of collection, with its revisions. It also serves each prior report as it was created at the time, with its revisions (vintages). Analytics §4.3, §4.4, §7 and `docs/definitions.md` now say this. The findings above stand as written. This addendum changes how some of them read.

| Finding | Effect |
| ------- | ------ |
| API-7 | **Withdrawn.** Serving revisions of `regime_snapshots` and `research_signals` is required. Reports are part of the record. |
| API-5 | **Wider.** The gap is not only `SPX`, `ETH` and `TBILL3M`. No collected version of any source data is served with its value and observed time. `source_value_versions` holds them, and the API exposes only their ids through vintage members (`public-analytics.ts:167-171`). The spec now names a `source-versions` route with an `asof` filter. |
| API-6 | **Raised to high.** An `asset_prices` overwrite loses the value as collected, which the rule forbids. |
| AN-4 | **Unchanged.** A stored ratio is not source data as published. The legs are. |

New finding:

| Id | Severity | Spec | Finding | Evidence |
| -- | -------- | ---- | ------- | -------- |
| API-16 | high | analytics §4.3 | Published reports exist, immutable and checksummed, in `analytics_output_snapshots`. They are served only at `GET /api/analytics/reports?id=`, behind the analytics-provider bearer token. No public route serves a prior report, and the public `vintages` route does not link a vintage to its report. | `backend/src/api/routes/analytics.ts:665-670,839-856`, `contract/src/routes.js:443`, `backend/schema/snapshot.sql:929-941` |
