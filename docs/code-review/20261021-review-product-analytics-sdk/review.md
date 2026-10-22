# Analytics and analyst SDK: requirements against implementation

Code and test evidence: `71ba4092`, inspected 2026-10-21. Findings below compare that implementation with the linked specifications. Test results describe that inspected code; they are not a fresh test run. Local source inspection supports the compatibility findings below. External csvb findings rely on the earlier inspection and require verification against its current revision before implementation planning treats them as current facts.

Specs under review:

- [`docs/technical/analytics-requirements.md`](../../technical/analytics-requirements.md)
- [`docs/technical/analyst-sdk-requirements.md`](../../technical/analyst-sdk-requirements.md)
- [`docs/definitions.md`](../../definitions.md)

Code read: `packages/analyst-sdk/**`, `backend/src/analytics/**`, `backend/src/api/routes/public-analytics.ts` and its helpers, `backend/src/db/client.ts`, `website-server/nginx.conf`, `docker-compose.yml`, `frontend/public/openapi.json`. The csvb source came from robotmoney/csv-backups (last pushed 2026-10-19) through `gh api`, because the local `~/csv-backups` checkout is empty.

Finding ids: `AN-` is the analytics module, `API-` is the public API and server, `SDK-` is the client side, `DOC-` is a spec or doc error.

## 1. Verdict

The existing regime computation is the compatibility baseline. The registry, `asof`, the forward-fill cap, the golden report, determinism and computation purity are supported by the inspected evidence. Input validation, canonical ids and complete published-report replay still have gaps. Identical effective input observations and options must produce byte-identical report payloads through backend and SDK before and after the refactor, including values, dates, nulls, field order and number formatting.

Most other parts of the two specs describe a system that does not exist yet:

- **No archive API.** No archive routes and no `backup.json` listing exist, and no watermarks are served. The four routes still serve JSON pages, as D58 describes.
- **Incomplete load protection.** The required concurrency gate, public-query timeout, weighted and byte budgets, and edge cache are absent. Flat rate limiting and list caching exist.
- **No supported public fill.** csvb has database backups, but no archive download client, API fill or `csvb inputs`. The SDK has no input manifest or provenance envelope.
- **No backtest API.** `simulatePortfolio`, `periodStats` and `scheduleFromLabels` do not exist.
- **Ratios, not legs.** Ratio indicators are computed when the data is fetched. Everywhere after that they are read as single values, not as two legs.

The specifications define required behavior. Implementation gaps and work ordering belong in this review and the implementation plan. The public simulation and statistics APIs expose the existing shared calculation. Changes to numerical methodology are outside this refactor; alternate-methodology selection and a backend-only engine for old results are not requirements. Extract is the only stage allowed to make outbound HTTP requests, including provider collection and archive downloads. Every downstream stage and its callbacks must run from supplied data; missing coverage must never trigger acquisition.

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
| API-2 | high | analytics §4.8 | No concurrency gate. Public reads share the 10-connection pool with no cap, and nothing answers 503 + `Retry-After`. | `backend/src/db/client.ts:21`. There is no gate in `public-analytics.ts`. |
| API-3 | high | analytics §4.8 | The limit is a flat 100 requests a minute. It has no 1/10 cost weights and no 50 MB/min byte budget. | `public-analytics.ts:50-51,64`, `backend/src/api/rate-limit.ts:66-77` |
| API-4 | high | analytics §4.8 | No edge cache: no `proxy_cache`, no lock, no 256 MB bound, no `X-Cache-Status`. | `website-server/nginx.conf:149-160` |
| API-5 | high | analytics §4.1, §4.4 | Collected source versions are not publicly served with values and observed times. Vintage members expose only ids. This includes the correlation and backtest series stored under `backtest:*` keys. The new contracts require canonical ids through a shared mapping, without renaming stored keys. | `public-analytics.ts:167-171`, `backend/src/analytics/access/data-source.ts:196-201` |
| API-6 | high | analytics §4.4 | Revisions of `asset_prices` are never captured. The upsert overwrites in place, so overwrite-events cannot serve them. | `backend/migrations/0056_analytics_overwrite_events.sql:65-69`, `backend/src/ops/asset-prices.ts:83` |
| SDK-1 | high | sdk §5 | csvb has no archive download client. The SDK must consume prepared inputs; it must not own archive downloads or import csvb. The required pacing, retry, checksum and resume rules are missing. Archive routes are also a dependency (API-1). | grep for `Retry-After`, `max-requests`, `jitter`, `checksum`. csvb subcommands are listed at `csvb src/cli.ts:70-195`. |
| SDK-2 | high | sdk §3 | Neither the default fill (repo clone, then an API resume from watermarks) nor the API-only fill exists. `csvb backup` reads only Postgres. Outside analysts have no supported path. | `csvb src/backup.ts:22,302-353` |
| SDK-3 | high | sdk §4 | `csvb inputs --archive --run` does not exist. The closest is `csvb audit replay`, which builds inputs in memory and writes no file. Input generation must preserve canonical mappings, original values and vintage membership, including historical ratio replay inputs. | `csvb src/audit/replay.ts:119` |
| SDK-4 | high | sdk §4, §6, §7; analytics §6 | No input sidecar or provenance envelope exists. The CLI does not expose input hashes, vintage, methodology and exact code revision for replay. Add provenance around the report while preserving its existing payload and report-only output. | `packages/analyst-sdk/bin/regime.ts:35-38`, `backend/src/analytics/run-ledger.ts:105-159` |
| AN-1 | high | analytics §5.3 | `simulatePortfolio(dateAxis, schedule, prices, cashRate, options)` does not exist. The only simulator is the private `simulate()`, which is tied to regime labels, `eth`/`sp500` and `tbill3m`. It has no `costBps` option and returns no `cost`. Support for arbitrary supplied assets (§5.2) is missing. The public simulator must preserve established target-weight returns, costs and missing-label behavior and produce byte-identical existing reports through backend and SDK. | `src/analyze/backtest.ts:20,61-74,103-106,195` |
| AN-2 | high | analytics §5.2, §5.4 | `periodStats(valueSeries, from, to, options)` does not exist. It must preserve existing statistics, including zero Sharpe, pre-cost daily returns and split-date conventions. A net value series alone cannot reproduce the existing Sharpe; the public API must retain and accept the original return and boundary evidence. | `backtest.ts:255-275` |
| AN-3 | high | analytics §5.5 | `scheduleFromLabels(labels, table)` does not exist. The reference portfolios are data (`PORTFOLIO_SPECS`), but they cannot run through a public simulator. Parity checks must cover daily values, all statistics and serialized report bytes. | `backtest.ts:31-59` |
| API-16 | high | analytics §4.4 | Published reports exist, immutable and checksummed, but are available only behind the analytics-provider bearer token. No public route serves prior reports or links each vintage to its published report. | `backend/src/api/routes/analytics.ts:665-670,839-856`, `contract/src/routes.js:443`, `backend/schema/snapshot.sql:929-941` |
| AN-12 | high | analytics §4.1; sdk §4 | Code uses separate provider, ledger and SDK names. csvb copies `LEDGER_EXTRA_KEYS`, so translation can drift. One shared boundary mapping must preserve values, dates, ordering and vintage membership and reject ambiguous mappings. The same provider series can occur under multiple keys, such as `raw_indicator_history:SPX_TREND` and `backtest:^GSPC`, with distinct observations and persistence histories. Historical replay must preserve those distinctions rather than silently choosing or merging values. Existing database keys may remain. | `packages/analyst-sdk/src/extras.ts:14-18`, `backend/src/analytics/source-tolerance.ts:55-105`; csvb copies the map |
| AN-13 | high | analytics §2, §4.2; sdk §2, §4 | Supported workflows require all necessary source data before execution. Ratio legs, asset prices, lending yields, benchmarks and research inputs belong in extract coverage, rather than being fetched by preparation or simulation. Existing preparation uses precomputed ratio inputs; public version and archive coverage is incomplete (AN-4, API-1, API-5). Establish per-workflow coverage and verify downstream stages and callbacks never call HTTP or acquisition clients, especially on missing inputs. This is a coverage and enforcement gap, not evidence that the existing pure computation currently performs HTTP. | `packages/analyst-sdk/src/prepare.ts`, `src/run.ts`, `src/analyze/backtest.ts`; API-1, API-5; purity checks in `scripts/tests/unit/analyst-sdk-purity.test.ts` |
| AN-15 | high | analytics §2, §6; sdk §4 | Database writers suppress within-tolerance jitter, but the backend computes from fresh in-memory data. `captureSourceAcquisition` persists evidence and returns the original result; the orchestrator saves `merged`, then passes that same array to preparation rather than reloading retained values. Thus a fresh value ignored by storage can still affect the report. Extract must hand off the exact committed values and versions used by all downstream consumers. Before changing this handoff, compare pinned existing reports: any numerical difference is a conflict with byte-identical refactor parity, not an acceptable tolerance. Preserve original effective inputs as evidence and resolve that conflict explicitly before cutover. | `backend/src/analytics/source-ledger.ts:150-159`, `backend/src/analytics/store/source-ledger-store.ts:28-32`, `backend/src/analytics/store/raw-history-store.ts:125`, `backend/src/analytics/index.ts:238-285` |

## 4. Divergent from the spec

| Id | Severity | Spec | Finding | Evidence |
| -- | -------- | ---- | ------- | -------- |
| AN-4 | high | analytics §4.1–4.3, §6; sdk §4 | Ratio legs are one instance of the broader input-coverage requirement in AN-13. Ratio extraction stores a calculated series, and new collection does not preserve both legs. Preparation has no ratio case. Add collection and preparation from legs with pinned parity checks for alignment and precision. Retain historical ratio values and references as calculated replay inputs; do not reconstruct them from new downloads. | `src/extract/sources.ts:66-88`, `src/prepare.ts:45`, `src/transform/transforms.ts:11,44`, `backend/src/analytics/source-tolerance.ts:67-82` |
| API-8 | high | analytics §4.8 | The statement timeout is pool-wide, 5 minutes rather than 5 seconds. | `backend/src/db/client.ts:15` |
| API-9 | medium | analytics §4.8 | Gzip runs on the event loop (`Bun.gzipSync`). An overwrite-events page can be about 8 MB of JSON. | `public-analytics.ts:62,526` |
| API-10 | medium | analytics §4.8 | The ETag is a weak hash of the body, computed after the full query, so a 304 still pays for the whole read. No route sends `immutable` or `max-age=31536000`. List `max-age=300` matches. | `public-analytics.ts:494-496,514-523`, `contract/src/public-analytics.js` |
| API-11 | medium | analytics §4.8 | The rate limit keys on `CF-Connecting-IP`, not `X-Client-IP`. nginx decides trust from a hard-coded Cloudflare range table, which is a CDN rule. | `backend/src/api/client-ip.ts:59-60`, `backend/src/api/index.ts:169`, `nginx.conf:42-75` |
| SDK-6 | low | sdk §5 | The User-Agent is the hard-coded `robotmoney-regime/1.0`, while the package is `0.1.0`. Yahoo and Shiller send a browser string instead. | `src/extract/http.ts:12`, `yahoo.ts:51`, `shiller.ts:114` |

## 5. Compatibility constraints

These established behaviors are the single shared calculation contract. They are preserved in backend and SDK before and after refactoring, including cases previously identified as defects. Correcting them is outside this work.

| Id | Behavior to preserve | Evidence |
| -- | -------------------- | -------- |
| AN-5 | `blend_hodl` applies fixed target weights daily without charging for daily resets. Retain its historical key and values. | `backtest.ts:215,222-229` |
| AN-6 | Strategies start at the first labelled date; baselines start at the first priced date. | `backtest.ts:160-165` |
| AN-9 | An unlabelled day is skipped, including its market move. | `backtest.ts:216,225-226`; inspected snippet with labels `[on, null, on, on]` |
| AN-10 | Out-of-sample CAGR uses the first point after the split for its starting value, with duration counted from the split. | `backtest.ts:270,275` |
| AN-14 | Sharpe uses pre-cost daily returns, while net values include transaction costs. A public statistics API must preserve the original return observations rather than derive different returns from net values. | `packages/analyst-sdk/src/analyze/backtest.ts:220-259`; analytics §5.3–§5.4 |

Daily returns use previous target weights without carrying holding drift. Zero-volatility Sharpe is 0, with no risk-free subtraction. Cash earns zero before the first yield row. These conventions are shared, not selectable methodology alternatives. Serving research inputs and calculated report revisions is required public-API behavior.

## 6. Bugs

| Id | Severity | Finding | Evidence | Verified |
| -- | -------- | ------- | -------- | -------- |
| API-13 | high | A query that times out answers 500, not 503. SQLSTATE 57014 is neither class 22 (mapped to 400) nor class 08 (mapped to 503). | `public-analytics.ts:558-560`, `client.ts:134-139`, `api/index.ts:189-190` | read |
| API-14 | medium | A caller can pick its own rate-limit bucket. The api publishes `8787` on every interface with `TRUST_PROXY=1`, so a caller who reaches it sets `CF-Connecting-IP`. nginx also trusts that header from any private-range peer. The comment that the port "is never published" is false. Prod exposure depends on the DigitalOcean firewall, which was not checked. | `docker-compose.yml:310,405`, `nginx.conf:46-48,72-75`, `client-ip.ts:17-19`. A test shows the behaviour: `backend/tests/api/public-analytics.test.ts:621-633`. | read |
| AN-8 | medium | An unknown indicator is not ignored. With no `asof`, the newest row of any key sets the end of the date axis. A stray `FOO` row dated 2027-06-01 moves asof to that date and makes the composite NaN and the label null. | `src/run.ts:85-89` | snippet |
| AN-11 | low | `mergeRatioSeries` skips zero or non-finite denominators but not a NaN numerator, which gives a NaN ratio row. | `src/extract/sources.ts:83-88` | read |
| SDK-7 | low | The loader accepts impossible dates such as `2026-02-30` (regex check only). It also accepts loose numbers: `0x10` is read as 16 and ` 1e1 ` as 10. | `src/input/load.ts:52,55,57` | run |
| SDK-8 | low | The CLI silently accepts bad arguments: a second file, a repeated `--asof`, a `--start` after every row (exit 0 with a 1-day axis), or an input with no registry indicators (exit 0, all null). | `bin/regime.ts:11-30`, `src/run.ts:68-81` | run |
| SDK-9 | low | Relative input paths resolve against the package root, because `bun run` changes directory. From `tests/`, `bun run regime fixtures/…` fails with ENOENT. | `bin/regime.ts` | run |
| API-15 | low | The overwrite-events byte budget counts UTF-16 code units, not bytes. | `public-analytics.ts:469` | read |

## 7. Documentation and contract gaps

| Id | Severity | Finding | Evidence |
| -- | -------- | ------- | -------- |
| DOC-4 | medium | The README documents operator SQL replay but does not describe the required public local-copy, csvb input-generation and provenance workflow. Its input example also uses `date,indicator,value,source`, whereas the target SDK contract is `date,series,value`. Keep user instructions aligned with supported commands as those capabilities ship. | `packages/analyst-sdk/README.md`, sdk §3–§6 |
| DOC-6 | low | The OpenAPI lists only `200` for the four routes: no 304, 400, 405, 429 or 503. | `frontend/public/openapi.json` |
| DOC-9 | medium | The historical replay path accepts stored ratio inputs separately from the source-only contract, but its file format, invocation and validation rules are not specified. Define these before implementing `csvb inputs --run` for historical runs. | analytics §4.3; sdk §4 |
| DOC-10 | medium | The provenance envelope preserves report-only output, but the CLI does not specify how callers select the envelope or how manifest metadata is validated. Define option names, defaults and validation without a methodology selector or changes to the report payload. | sdk §4, §6 |
| DOC-12 | high | Canonical source identity does not uniquely identify a historical observation stream. Multiple stored keys for the same provider series can contain different values for the same date. Define how canonical inputs retain each run's original observations and consumer assignments, and how conflicts are handled. Rejecting ambiguity alone does not provide a usable replay path. | `backend/src/analytics/source-tolerance.ts:55-105`; analytics §4.1, §6; AN-12 |
| DOC-13 | medium | Archives may be up to 90 MB while the per-client budget is 50 MB per minute. Define how an archive larger than one minute's budget can be downloaded: paced streaming across minutes, a smaller transfer unit, or another explicit policy. Specify accounting and retry behavior so a valid archive cannot be permanently rejected. | analytics §4.7–§4.8; sdk §5 |

## 8. Test gaps

The inspected test evidence does not establish the following acceptance criteria:

- **Analytics §7, backtest:** public simulator daily values, original pre-cost returns and all statistics against `computeBacktest`; established target-weight behavior, missing-label skips, baseline dates and split statistics. The public functions do not exist (AN-1 to AN-3). Changing today's target must preserve earlier values and today's pre-cost return, while today's close-of-day cost follows the established rules.
- **Analytics §6–§7, report parity:** representative pinned published runs across dates, market regimes and missing-data patterns. Compare complete serialized report payloads byte for byte across the pre-refactor backend, pre-refactor SDK, refactored backend and refactored SDK for identical effective inputs and options. Include field order and number formatting as well as indicators, panels, labels, correlations, statistics and nulls. Compare daily simulation evidence separately. Existing fidelity tests compare with the JS port, not the full published record. `backend/tests/analytics-offline-replay.test.ts` already verifies frozen-vintage reload and fingerprint verification with network and data-source access disabled; it does not establish complete published regime-report reproduction through the analyst workflow. Report comparison permits no numerical tolerance; source-update jitter filtering is an ingestion concern.
- **Committed-input handoff:** verify that extract returns the retained committed values even when a provider emits within-tolerance jitter. Backend, archive inputs and SDK must receive identical observations. Compare the change against pinned existing reports and report any conflict with byte-identical preservation (AN-15); do not hide it behind a numeric tolerance.
- **Storage and ratios:** shared mapping preserves original values, dates, ordering and vintage membership, handles multiple observation streams for one canonical series, rejects ambiguity, and preserves historical references. Historical ratio replay uses original stored values; new ratio preparation from pinned legs preserves alignment, operation order and precision before production adoption.
- **Analytics §7, archives:** API and replica archives being byte-identical. Every §4.8 protection, including completion and retry of an archive larger than one minute's byte budget.
- **Compatibility statistics:** a rebalance with nonzero cost preserves the existing pre-cost daily-return Sharpe while portfolio values include costs. A net value series alone cannot establish this.
- **Shared execution:** backend and SDK invoke the same computation and serialization. Provenance records methodology and code identity without selecting different calculations or routing old results through a backend-only engine.
- **Analytics §4.2:** unknown indicators being ignored (AN-8 shows they are not), and the sections being null without the extras.
- **Analytics §7, "every function has a test":** `applyRatio`, `ratioByDate`, `shapeDaily`, `combineConservativeN` and `combineAggressiveN` have no package test.
- **SDK §7:** the sparse-clone install, the API fill against the repo fill, csvb download pacing, retries, checksums and resume, plus methodology/code provenance in an envelope that preserves the report payload. The test "the CLI report reproduces the golden output" (`tests/regime.test.ts:43-45`) never runs the CLI. A hand run confirms the CLI matches.
- **Extract boundary:** run every supported downstream path from supplied inputs with outbound HTTP disabled, including preparation, transforms, regime, research, allocation callbacks, backtests, statistics and reporting. Remove required series and verify explicit coverage errors; remove optional series and verify documented missing results. Neither path may invoke acquisition. This requirement covers all HTTP clients and transitive dependencies, not only `fetch`.
- **Purity:** the purity test does not forbid `fetch` outside `extract/http.ts`. It does not forbid a csvb import or downstream imports of acquisition clients either. The shim test checks two backend files only (`analyst-sdk-purity.test.ts:109-127,189-193`).

## 9. Confirmed behavior

- **Registry:** 26 indicators: macro 8, onchain 10, factor 8. The composite uses `PANELS = ["macro","onchain"]`. The factor panel is display-only (`indicators.ts:464`).
- **Existing input handling:** the loader checks its existing header after stripping the BOM. CSV and JSON give byte-identical output. An indicator with no rows carries weight 0. This does not establish the new canonical `date,series,value` contract or stricter validation.
- **Reproducibility:** `asof` cuts rows and extras. `MAX_FORWARD_FILL_DAYS = 120` is applied and tested.
- **Backend replay infrastructure:** the run ledger and frozen vintages already carry methodology and build identity (`backend/src/analytics/index.ts:190-202`, `store/run-ledger-store.ts:410-483`). `backend/tests/analytics-offline-replay.test.ts` checks offline vintage reload and fingerprints. Remaining gaps concern the analyst workflow, provenance and complete byte-for-byte report parity across both consumers and both sides of the refactor.
- **Backtest rules inside `simulate`:**
  - no peeking,
  - a 10 bps cost on one-sided turnover, halved,
  - cash earns the previous day's yield, compounded over 365 days,
  - values start at 1; baselines begin at their first priced date and strategies at their first labelled date,
  - price gaps are filled forward,
  - Sharpe is mean/sd·√365 with sample sd.
- **Reference data:** `eth`, `sp500` and `mixed` weight tables, the single-asset hold baselines, the mixed constant-mix baseline and `stables_only` exist.
- **Purity and install:** `src/` reads no fs, env or database. Only `bin/regime.ts` reads a file. The SDK installs alone from a sparse clone and never imports csvb.
- **Extras mapping:** `LEDGER_EXTRA_KEYS` maps `^GSPC`, `ETH-USD` and `DTB3` to `SPX`, `ETH` and `TBILL3M` (`src/extras.ts:14-18`). csvb copies the map instead of importing it, so the two can drift.
- **CLI:** `--start`, `--asof`, `--factor` and `--full` work and are documented. The output is deterministic.
- **Public API:** four GET-only routes with the stated filters, 405 on any other method, correct keyset paging, `max-age=300` on lists, 429 with `Retry-After`, Yahoo rows served (D58), provider-terms note in the README.
- **csvb:** `csvb resolve --as-of` exists.

## 10. Recommended order

1. **Define the replay and provenance contracts.** Specify historical ratio replay inputs, provenance selection, conflicting observation streams and large-archive budget behavior (DOC-9, DOC-10, DOC-12, DOC-13). Keep implementation status in this review and the implementation plan.
2. **Establish the compatibility baseline and committed-input handoff.** Inspect AN-15 before assuming existing published runs used exactly the stored observations. Preserve the actual effective inputs and resolve any conflict between committed-input handoff and existing report bytes before cutover. Pin representative original inputs, methodology and code revisions, then require byte-identical serialized reports through backend and SDK before and after refactoring, along with identical daily backtest values. Preserve existing production reports and their immutable references.
3. **Implement canonical ids at boundaries.** Share the translation with csvb and verify values, ordering, provenance and vintage membership, including multiple historical observation streams for a single canonical series. Database renaming is not required (AN-12).
4. **Complete extract coverage and prepare ratio legs.** Inventory the source inputs required by each supported workflow, including prices, yields, benchmarks and research inputs (AN-13). Complete acquisition before downstream execution; disable HTTP in downstream acceptance checks and reject missing required coverage without fetching. Treat ratio legs as part of this broader coverage requirement. Preserve original stored ratios for historical replay. Demonstrate parity on pinned inputs before changing production preparation (AN-4).
5. **Expose the general backtest API.** Implement AN-1 to AN-3 using one shared calculation with byte-identical existing report output. Preserve AN-5, AN-6, AN-9, AN-10 and AN-14, including original pre-cost daily returns. Do not add another methodology or retain a separate backend calculation.
6. **Build public records and archives.** Serve source versions and immutable reports, capture future asset-price revisions, and provide format 1 listings, archives and watermarks (API-1, API-5, API-6, API-16). Never regenerate a published report in a read handler.
7. **Build the csvb and SDK workflow.** Add the verified download client and API fills, then input generation, manifests and provenance output (SDK-1 to SDK-4). Reuse the existing backend ledger and frozen-vintage infrastructure. Verify the current csvb implementation before assigning its gaps. Address validation, CLI arguments, paths and source-client identity in independent changes with compatibility checks.

Public-query timeouts, error classification, concurrency limits, trusted client identity and bounded caching protect the site independently of numerical refactoring. Address these separately before expanding public downloads (API-2 to API-4, API-8 to API-11, API-13 to API-15). The archive download client depends on archive routes; input generation and compatibility checks can be developed against pinned local backups.
