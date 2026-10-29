# Analytics and analyst SDK refactor: code review

Code and test evidence: `main` at `22962262`, inspected 2026-10-29. That tree carries SDK 0.4.0 (issue 1513, PR 1525, `46ed255d`) and the platform data pipeline (issue 1514, PR 1524, `22962262`). Method: the `review-product` skill over the code that implements the requirements, and the `review-data-integrity` skill over the archive, vintage and replay code, merged into this one file. Findings are observed facts with `path:line` evidence. Where a finding names a cause or an impact beyond what was run, that is reviewer inference and says so.

Specs under review:

- [`docs/technical/analytics-requirements.md`](../../technical/analytics-requirements.md)
- [`docs/technical/analyst-sdk-requirements.md`](../../technical/analyst-sdk-requirements.md)
- [`docs/definitions.md`](../../definitions.md)
- [`docs/decisions.md`](../../decisions.md) D57, D58, D72 to D79
- [`docs/technical/regime-engine.md`](../../technical/regime-engine.md)

Code read: `backend/src/analytics/**` (the orchestrator `index.ts`, `source-ledger.ts`, `source-tolerance.ts`, `store/source-ledger-store.ts`, `store/raw-history-store.ts`, `store/run-ledger-store.ts`, `store/public-archive-store.ts`, `access/data-source.ts`, `extract/**`), `packages/analyst-sdk/src/**`, `packages/analyst-sdk/bin/**`, `packages/analyst-sdk/tests/**`, the archive routes in `backend/src/api/routes/public-analytics.ts`, `backend/src/api/public-analytics-limits.ts`, `website-server/nginx.conf`, and the replay tests `backend/tests/regime-replay-archive.test.ts`, `backend/tests/regime-replay-published.test.ts`, `backend/tests/analytics-offline-replay.test.ts`, `backend/tests/analyst-sdk-vintage-roundtrip.test.ts` with their helper `backend/tests/support/published-replay.ts`. CI wiring: `.github/workflows/backend.yml`.

The prior review of the same area is [`20261021-review-product-analytics-sdk`](../20261021-review-product-analytics-sdk/review.md). Its ids are kept where a finding is still open (section 6). The requirements-versus-canon review of the same tree is `20261029-review-docs-analytics-sdk-requirements` (issue 1459). Doc wording findings belong there and are not repeated here.

Finding ids: `AN-` is the backend analytics run pipeline, `ARC-` is the public archive (store, routes and SDK reader), `SDK-` is the analyst SDK, `TEST-` is a test or CI gap. New ids continue the numbering of the 2026-10-21 review.

Resolutions: every finding needs a code change or an owner decision, or it sits in a file that open PR 1526 (issue 1477) or PR 1530 (issue 1459) also edits. This PR edits neither. Each finding is therefore `recorded: issue 1460 comment`: it is posted on issue 1460. Issue 1460 asked for `filed` (a new issue); the loop that ran this review does not file issues, so `recorded` replaces it.

## 1. Verdict

The refactor delivers what the 2026-10-21 review found missing. The archive routes, load protection, the public backtest functions, the provenance envelope, the strict loader, the committed-input handoff and D78 exact arithmetic all exist and are tested. Of the 2026-10-21 findings in this scope, 26 are fixed (API-1 apart from revisions) and 7 remain open or partly open (section 6).

The open risk is replay fidelity, the property the release tag waits for:

- **The run computes from one table and freezes another.** The regime run computes from `raw_indicator_history` read back after its write. It freezes its vintage later from the ledger heads in `source_value_versions`, at a cutoff taken from the producer's wall clock, outside the insert transaction (AN-16, AN-17). So the answer to issue 1460's question is no: a run does not read its inputs and freeze its vintage from the same committed snapshot.
- **Source-only input silently drops the eight ratio indicators.** The loader rejects ratio rows, and nothing computes a ratio from its legs. No error is raised (SDK-10, the open part of AN-4).
- **The CI replay checks two fields.** The in-database replay that CI executes asserts the label and the composite only (TEST-4). The full-record archive replay runs only locally, and it fails today on runs published before D78 reached production (TEST-5).
- **Archive edge cases.** An API-only local copy returns empty revised tables without an error (ARC-1). The SDK refuses parts between 64 MiB and the 90 MB the spec allows (ARC-2). The store writes an over-cap part for an oversized row instead of failing (ARC-3).

Severity: 28 findings, 5 high, 13 medium, 6 low and 4 info, counting the 7 re-reported findings. No finding is an incident: nothing here shows a published report is wrong.

## 2. Test runs

| Check | Result |
| ----- | ------ |
| `bun test` in `packages/analyst-sdk` | 488 pass, 0 fail, 27,443 `expect()` calls across 30 files |
| `bunx tsc --noEmit` in `packages/analyst-sdk` | Clean |
| `bun test scripts/tests/unit/analyst-sdk-purity.test.ts` | 55 pass, 0 fail |
| Probe scripts against the SDK (not committed) | Source-only input with legs `yahoo:HG=F` and `yahoo:GC=F` gave 0 of 900 non-null `COPPER_GOLD` ranks; the stored ratio gave 871 of 900. `meanVarExact(S, [0.1, NaN], 4)` returned `[0.625, 0]`. `simulateDrift` weekly from 2024-01-01 to 2024-01-09 made no trade. |
| `regime-replay-archive.test.ts` | Not re-run. The local run of 2026-10-29 at `46ed255d`, through backup `2026-10-28T180400Z`, is on issue 1513: 452 runs, 0 label differences, 1 fail on 43 runs created after issue 1421 that differ from their published row in the last bits. Production `v0.7.0` lacks D78. |

The backend tests that need Postgres were not run here. CI runs them in the `backend` workflow, which checks per-file executed counts for the replay and offline-replay tests (`.github/workflows/backend.yml:241-249`).

## 3. Run pipeline and replay

| Id | Severity | Class | Finding | Evidence | Resolution |
| --- | --- | --- | --- | --- | --- |
| AN-16 | high | DATA_INTEGRITY_PROVENANCE | The regime run computes from the raw indicator floor it reads back after saving (`registry` from `loadRawHistory`). It freezes its vintage from the ledger heads in `source_value_versions`. The raw writer keeps its stored value when a new one is within the D56 tolerance, and some writes go to the raw table only (floor seed, EDGAR seed). The two can hold different values for one date. The run measures the registry mismatch and only logs it. Corrupting sequence: a seed writes S for a date, the ledger's first observation F is within tolerance of S, raw keeps S, the vintage freezes F, and the replay computes from F. Spec: analytics 2 "Committed inputs", 6 "Replay". Reviewer inference: on tied series a shift of this size can move ranks. Related: AN-15. | `backend/src/analytics/index.ts:321-325`, `:559-566`, `:740-747`; `backend/src/analytics/store/raw-history-store.ts:124-125`; `backend/src/analytics/store/run-ledger-store.ts:394-400` | recorded: issue 1460 comment |
| AN-17 | medium | DATA_INTEGRITY_STALE_READ | The vintage cutoff is the producer's `new Date()` at the end of the run, while `knowledge_time` is the database's `clock_timestamp()`. Members are selected before the insert transaction opens. A newer value another run commits between this run's read and its freeze lands in this run's vintage. A producer clock behind the database drops the run's own last acquisitions from its vintage. Spec: D74 clarification, extract supplies the exact stored values and versions. This answers the question on issue 1460 from the issue 1450 analysis: post-1421 runs are still exposed, now only by timing. | `backend/src/analytics/index.ts:562`; `backend/src/analytics/store/run-ledger-store.ts:457`, `:466`; `backend/migrations/0057_source_acquisition_ledger.sql:10` | recorded: issue 1460 comment |
| AN-18 | medium | DATA_INTEGRITY_FAIL_OPEN | `captureSourceAcquisition` returns the fresh provider values when the API's answer has no `committed` field. During a rolling upgrade with a producer newer than the API, jitter that ingestion rejected reaches the backtest extras and research inputs. Spec: analytics 2 "Committed inputs". | `backend/src/analytics/source-ledger.ts:182` | recorded: issue 1460 comment |
| AN-19 | medium | DATA_INTEGRITY_PRECISION | A ratio is computed from the fresh legs, then committed at a 5e-6 tolerance, while each leg is committed at 1e-6. A leg move of 3e-6 changes the leg's head but not the ratio's, so the stored legs stop reproducing the stored ratio. That blocks the cutover in analytics 4.3, which requires identical ratios from pinned legs. | `packages/analyst-sdk/src/extract/sources.ts:259-264`; `backend/src/analytics/source-tolerance.ts:44`, `:52` | recorded: issue 1460 comment |
| AN-20 | medium | DATA_INTEGRITY_SEMANTIC_DRIFT | Since the D74 amendment, the input generator keeps an old vintage's `DEFI_GROWTH` and `STABLES_GROWTH` rows under their storage key, an unread series, and replay feeds those indicators from `DEFI_TVL` and `STABLES`. The amendment proves equality on the heads of one backup. Before fetch-once, the two keys were fetched at different moments, so an older vintage version can differ from its twin. The offline-replay test checks a fixture where the two are equal. Confidence: medium; not checked against archive data. | `packages/analyst-sdk/src/archive/format1.ts:268-274`; `packages/analyst-sdk/src/series-ids.ts:101`; `backend/tests/analytics-offline-replay.test.ts:235` | recorded: issue 1460 comment |

## 4. Public archive

| Id | Severity | Class | Finding | Evidence | Resolution |
| --- | --- | --- | --- | --- | --- |
| ARC-1 | medium | DATA_INTEGRITY_SILENT_EMPTY | An API backup always lists `revisions: {}` (an owner decision on issue 1422, recorded only in a code comment). `revisedTable` returns `{ header: [], rows: [] }` when no backup lists the table. After an API-only fill, `revisedTable("asset_prices")` returns no rows and no error. Spec: analytics 4.6 serves revision archives; sdk 3 says the two fills give the same local copy. | `backend/src/analytics/store/public-archive-store.ts:35-40`, `:916`; `packages/analyst-sdk/src/archive/local-copy.ts:159-197` | recorded: issue 1460 comment |
| ARC-2 | medium | IMPLEMENTATION_GAP | The SDK caps a part at 67108864 bytes and cites analytics 4.5, which states no number. Analytics 4.7 allows up to 90 MB, and csvb takes `--part-mb` up to 90. A repo backup written with parts above 64 MiB is refused whole, because `openArchive` inflates every listed file first. | `packages/analyst-sdk/src/archive/format1.ts:49-50`, `:65-70`; `packages/analyst-sdk/src/archive/local-copy.ts:142-153`; `docs/technical/analytics-requirements.md:138` | recorded: issue 1460 comment |
| ARC-3 | medium | DATA_INTEGRITY_BOUNDS | The archive store cuts a part only when it already holds a row, so a single row larger than the part size minus the header becomes one part with `bytes_raw` above the cap. Nothing fails at write time, and the SDK then refuses that backup. No backend test writes such a row. Real `analytics_output_snapshots` rows are about 1.1 MB today. The reader's boundary tests from issue 1464 exist; no fixture has an over-cap revision file. Reported on issue 1460 from the issue 1464 review. | `backend/src/analytics/store/public-archive-store.ts:862-864`; `backend/tests/api/public-analytics-archives.test.ts:541`; `packages/analyst-sdk/tests/inputs.test.ts:406-414` | recorded: issue 1460 comment |
| ARC-4 | medium | ARCHITECTURE_DRIFT | The default fill clones the repo and resumes from the API. The API derives its own midnight watermark chain from id 0, while csvb cuts at its snapshot times (for example `2026-10-28T180400Z`). The first API backup after the repo's newest then has a `watermark_before` that never equals the repo's `watermark_after`, and `selectBackups` throws "a backup is missing". It fails loudly. Spec: sdk 3; analytics 4.7 "only archives past that point". The csvb side was not read at its current revision; PR 1526 moves it into this repo. | `backend/src/analytics/store/public-archive-store.ts:9-21`, `:736-756`; `packages/analyst-sdk/src/archive/format1.ts:198-207` | recorded: issue 1460 comment |
| ARC-5 | info | DOCUMENTATION_GAP | A store comment says one vintage's members are never split between backups. `freezeVintage` takes no cross-run lock, so two concurrent freezes can interleave member ids. Nothing is lost: the reader unions members across backups and cross-checks the count. | `backend/src/analytics/store/public-archive-store.ts:284-287`; `backend/src/analytics/store/run-ledger-store.ts:440-492`; `packages/analyst-sdk/src/archive/format1.ts:334-346` | recorded: issue 1460 comment |

## 5. Analyst SDK

| Id | Severity | Class | Finding | Evidence | Resolution |
| --- | --- | --- | --- | --- | --- |
| SDK-10 | high | IMPLEMENTATION_GAP | A source-only run silently drops all eight ratio indicators. The loader rejects ratio-id rows, as analytics 4.3 says, but no code computes the ratio from its legs: `RATIO_LEG_MAPPING` and `ratioByDate` have no caller. The macro panel and the composite are computed without them, and no error names the missing series. Spec: analytics 4.3 "the regime run calculates the ratio", 4.2 "Required missing inputs cause an explicit error". The success-criteria row for `tests/prepare.test.ts` has no test. Related: AN-4. | `packages/analyst-sdk/src/series-ids.ts:175`; `packages/analyst-sdk/src/transform/grid.ts:30`; probe in section 2 | recorded: issue 1460 comment |
| SDK-11 | medium | IMPLEMENTATION_GAP | The certified optimizers accept NaN and return a "certified" answer. The off-support KKT checks compare with `<` and `>`, which are false for NaN, so the check passes. `markowitzSchedule` does not check what a custom `cov` callback returns. Spec: D78 amendment (issue 1513) "Every solver returns a certified optimum or throws". `tests/optimizers.test.ts` tests NaN only in ERC budgets. | `packages/analyst-sdk/src/allocate/optimize.ts:212`, `:265`; `packages/analyst-sdk/src/allocate/markowitz.ts:472`; probe in section 2 | recorded: issue 1460 comment |
| SDK-12 | medium | IMPLEMENTATION_GAP | `simulateDrift` misses rebalances on a sparse date axis. The weekly rule `weekdayOf(cur) < weekdayOf(prev)` never fires across a gap of 7 days or more, and the quarterly rule misses a gap that skips the quarter's first month (02-28 to 05-01). `markowitz.ts` uses a correct `weekStart` and `quarterOf`. Spec: analytics 5.3 "first date of a new Monday-to-Sunday week". The sparse-axis test covers weekday gaps only. | `packages/analyst-sdk/src/analyze/backtest.ts:318-330`; `packages/analyst-sdk/tests/backtest-drift.test.ts:135` | recorded: issue 1460 comment |
| SDK-13 | low | IMPLEMENTATION_GAP | `markowitzSchedule({ rule: "tangency", lambda: 99 })` is accepted and `lambda` is unused. The module says an unknown or invalid option throws. | `packages/analyst-sdk/src/allocate/markowitz.ts:436`, `:442` | recorded: issue 1460 comment |
| SDK-14 | low | DATA_INTEGRITY_VALIDATION | A revision row whose `_op` is anything but `delete`, or a file with no `_op` column, is applied as an upsert. A malformed revisions file silently resurrects deleted rows. Spec: sdk 3 "Revised table". | `packages/analyst-sdk/src/archive/local-copy.ts:175` | recorded: issue 1460 comment |
| SDK-15 | low | IMPLEMENTATION_GAP | `assertSupplementaryDir` checks the directory, its `csv` folder and its parents. It misses a local copy nested deeper, such as `dir/x/csv/<id>/backup.json`. Spec: sdk 4; D79 (3). | `packages/analyst-sdk/bin/supplementary-dir.ts:41-44` | recorded: issue 1460 comment |
| SDK-16 | info | UNRESOLVED_DECISION | The SDK 0.4.0 commit leaves `package.json` at `0.3.1`, so supplementary manifests record `fetched_by` 0.3.1. A version commit (as for 0.3.0, `01059201`) is needed before the `analyst-sdk-v0.4.0` tag. | `packages/analyst-sdk/package.json:3` | recorded: issue 1460 comment |
| SDK-17 | info | DOCUMENTATION_GAP | Two medians: the research payload's `median_full_history` takes the upper middle value; the exported `median` interpolates at q(n-1). Neither rule is stated in a spec. | `packages/analyst-sdk/src/analyze/research-signals.ts:234`; `packages/analyst-sdk/src/transform/exact.ts` | recorded: issue 1460 comment |

## 6. Prior findings still open

| Id | Severity | Finding now | Evidence | Resolution |
| --- | --- | --- | --- | --- |
| AN-4 | high | Ratio legs are stored (issue 1514), but preparation from legs does not exist. See SDK-10 and AN-19. | `packages/analyst-sdk/src/series-ids.ts:175` | recorded: issue 1460 comment |
| AN-11 | low | `mergeRatioSeries` still has no numerator check. Latent: the Yahoo parser drops NaN. | `packages/analyst-sdk/src/extract/sources.ts:138` | recorded: issue 1460 comment |
| SDK-6 | low | The User-Agent is still `robotmoney-regime/1.0`, not the package version. | `packages/analyst-sdk/src/extract/http.ts:12`; `yahoo.ts:51`; `shiller.ts:114` | recorded: issue 1460 comment |
| API-6 | high | `asset_prices` overwrites are still not captured as revisions. | `backend/src/ops/asset-prices.ts`; `backend/src/analytics/store/public-archive-store.ts:35-40` | recorded: issue 1460 comment |
| API-14 | medium | The api port is now bound to loopback. nginx still trusts `CF-Connecting-IP` from any private-range peer. | `docker-compose.yml:405`; `website-server/nginx.conf` | recorded: issue 1460 comment |
| API-15 | low | The overwrite-events byte budget still counts UTF-16 code units. | `backend/src/api/routes/public-analytics.ts:649` | recorded: issue 1460 comment |
| AN-15 | medium | Fixed for the registry and for acquisitions that return `committed`. The fail-open path remains (AN-18). | `backend/src/analytics/index.ts:321-326`; `backend/src/analytics/source-ledger.ts:182` | recorded: issue 1460 comment |

Fixed since 2026-10-21, with evidence: AN-1, AN-2, AN-3 (`backtest.ts:161,171,459`, `tests/backtest.test.ts`); AN-5, AN-6, AN-9, AN-10, AN-14 pinned (`tests/backtest.test.ts:211,267,282,308`); AN-8 (`src/run.ts:91-108`, `tests/input-rule.test.ts:281-290`); AN-12 (`src/series-ids.ts`); AN-13 (`src/coverage.ts`, purity import graph); SDK-4 (`bin/regime.ts --provenance`, `tests/cli.test.ts:114`); SDK-7 (`src/input/load.ts`); SDK-8 (`tests/cli.test.ts:56`); SDK-9 (`bin/args.ts:56-69`); API-1 apart from revisions; API-2, API-3, API-8 (`public-analytics-limits.ts`); API-4 (`nginx.conf`); API-5; API-9 (`public-analytics.ts:809-811`); API-10 (`:860,932`); API-11; API-13 (`:1011`); API-16.

## 7. Test gaps

| Id | Severity | Class | Finding | Evidence | Resolution |
| --- | --- | --- | --- | --- | --- |
| TEST-4 | high | TEST_ASSERTION_TOO_WEAK | The in-database replay that CI executes compares only the as-of label and the composite. Analytics 6 asks for complete report reproduction. Its fixture writes the old growth keys production no longer writes, and it cannot hold a raw-versus-ledger mismatch (AN-16). It can pass while every other field differs. | `backend/tests/regime-replay-published.test.ts:95-100`; `.github/workflows/backend.yml:247` | recorded: issue 1460 comment |
| TEST-5 | medium | TEST_NOT_IN_CI | The full-record archive replay skips without `RM_FORMAT1_ARCHIVE`, which no CI job sets; the owner chose a local run (issue 1513). Run locally, it fails: of the runs created after issue 1421, 41 are classed `mismatch` in the local report. Each one's first differing field moved only in the last bits, and every one also differs in `correlations` and `backtest`, so some value there exceeds the 1e-9 relative rule. Reviewer inference: near-zero values or the integer and sign rules in `numericDiff` turn last-bit drift into a "discrete" difference. The test has no rule for a pre-D78 publisher, and no exact rule for runs after a D78 release. | `backend/tests/regime-replay-archive.test.ts:52-57`, `:79`, `:146`; `packages/analyst-sdk/tests/support/numeric-diff.ts:50-55`; issue 1513 comment of 2026-10-29 | recorded: issue 1460 comment |
| TEST-6 | info | TEST_COVERAGE_GAP | The purity test forbids `fetch` and HTTP clients downstream of extract. It does not list `node:tls`, `node:dns`, `node:http2` or `node:dgram`. No downstream module imports them today. | `scripts/tests/unit/analyst-sdk-purity.test.ts` | recorded: issue 1460 comment |

## 8. Confirmed behavior

- **Committed handoff.** The registry is read back after the write, and acquisitions return committed ledger values. No source call happens after extract, and the network is poisoned in the committed-input test (`backend/src/analytics/index.ts:321-326`, `:384`; `backend/tests/analytics-offline-replay.test.ts`).
- **Ledger heads.** Heads are resolved under a per-key advisory lock inside the transaction. `DISTINCT ON` breaks ties on `id DESC` (`backend/src/analytics/store/source-ledger-store.ts:334`, `:405-442`; `store/run-ledger-store.ts:400`).
- **Vintage members.** Member ranges are exact, and a count mismatch fails the reload (`backend/src/analytics/store/run-ledger-store.ts:531-546`, `:600-605`). The archive members step takes members above the previous members watermark after the vintages step, so ranges are contiguous (`public-archive-store.ts:564`, `:586-597`).
- **Archive identity is content (issue 1444).** A file's identity is the SHA-256 of its raw bytes. That hash is the ETag, and the stream aborts if the body differs from its record. A 304 is answered from the record without reading the body. The listing is ascending with a lexical cursor (`public-archive-store.ts:717-723`, `:796-819`, `:993-1002`; `public-analytics.ts:889-890`, `:943-951`).
- **Archive text.** Times are UTC (`public-analytics-limits.ts:215`; `public-archive-store.ts:648-649`). `double precision` is served through `::text`, the shortest round-tripping form, and the CSV path copies that text unchanged (`format1.ts:409`, `:413`). NULL and empty string stay distinct (`public-archive-store.ts:638-639`; `format1.ts:104-127`).
- **Reader bounds (issue 1464).** `inflateBounded` refuses a file over its `bytes_raw` or over the cap. Tests cover 67108864 bytes passing and 67108865 failing (`packages/analyst-sdk/tests/inputs.test.ts:406-414`).
- **D78.** Every reduction D78 lists goes through `src/transform/exact.ts`. The remaining plain sums are the ones D78 leaves alone: input weight-sum checks, max-drawdown loops and the LU preconditioner, whose residuals are recomputed exactly. `quantile` matches a BigInt reference bit for bit (`packages/analyst-sdk/tests/exact-numerics.test.ts:405`).
- **SDK 0.4.0 features.** Each has behaviour-executing tests: `backtest-drift.test.ts`, `optimizers.test.ts`, `linalg.test.ts`, `markowitz.test.ts`, `supplementary.test.ts`, `local-copy.test.ts`.
- **Fetch-once and the floor.** The fetch memo serves one request per symbol and cuts each consumer at its own start. The 2016 collection floor does not change research output, because alignment uses exact dates on the 2018 axis (`research-signals.ts:176`; `transform/math.ts:325-331`).
- **Tests that need a database fail without one.** They throw instead of skipping, and CI checks per-file case counts (`backend/tests/support/clean-db.ts:53-58`; `.github/workflows/backend.yml:241-249`).
- **Determinism.** `Date.now`, `Math.random` and unordered reads do not feed report bytes. Build identity is recorded per run (`backend/src/analytics/index.ts:214`).

## 9. Unresolved decisions

- **Which state a run computes from (AN-16, AN-17).** Either the regime run computes from the ledger heads it freezes, in one transaction with a database-side cutoff, or the requirements say the raw table is authoritative for compute. Owner: decision.
- **Pre-D78 replay rule (TEST-5).** Whether the archive replay accepts rounding by platform version or by creation date, and from which release it requires exact equality. Owner: decision.
- **API revisions (ARC-1).** The owner decision on issue 1422 to serve no revisions is not in a canonical doc, and sdk 3 promises equal fills. Owner: decision, then a doc change in a file PR 1526 edits.

## 10. Review boundary

- The csvb side of the default fill (ARC-4) and the csvb success-criteria rows were not read at csvb's current revision. PR 1526 moves csvb into `packages/csvb`.
- The 24-minute archive replay was not re-run; its 2026-10-29 result on issue 1513 is used as evidence.
- The backend tests that need Postgres were not run locally.
- No production data was read.
- Severity describes impact, not engineering priority.
