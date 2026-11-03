# Analytics and analyst SDK requirements: canon docs against the implementation

Code and doc evidence: `main` at `22962262` (after SDK 0.4.0, PR 1525, and the platform pipeline, PR 1524), inspected 2026-10-29. Method: the `review-docs` skill. Each normative statement of the specs below was mapped to code and tests, and each public capability of the package and the public API was mapped back to a spec. Findings are observed facts with `path:line` evidence. Where a finding names an owner, that is reviewer inference.

Specs under review:

- [`docs/technical/analytics-requirements.md`](../../technical/analytics-requirements.md)
- [`docs/technical/analyst-sdk-requirements.md`](../../technical/analyst-sdk-requirements.md)
- [`docs/definitions.md`](../../definitions.md)
- [`docs/decisions.md`](../../decisions.md) D57, D58, D72 to D79, and the D56, D74 and D75 amendments
- [`docs/technical/regime-engine.md`](../../technical/regime-engine.md) sections 1 to 5, 8, 8.1, 8.2 and 9
- [`packages/analyst-sdk/README.md`](../../../packages/analyst-sdk/README.md)

Code read: `packages/analyst-sdk/src/**`, `packages/analyst-sdk/bin/**`, `packages/analyst-sdk/package.json`, `packages/analyst-sdk/tests/` (file list and the tests the specs name), `backend/src/analytics/analyze/*`, `backend/src/analytics/transform/*`, `backend/src/api/routes/public-analytics.ts`, `backend/src/api/public-analytics-limits.ts`, `contract/src/routes.js`, `website-server/nginx.conf`.

Finding ids: `DOC-` is a finding in a requirements doc, a definition or a decision. `RE-` is a finding in `regime-engine.md`.

Resolutions: `fixed: <path>` means this PR corrects that file. `recorded: issue 1459 comment` means the finding is posted on issue 1459. Every recorded finding falls in one of two groups. Some need a code change or an owner decision. The rest sit in a file that open PR 1526 (issue 1477, csvb moves into `packages/csvb`) also rewrites: `analytics-requirements.md`, `analyst-sdk-requirements.md`, `definitions.md`, `decisions.md` and the SDK README. This PR does not edit those files, so it cannot conflict with 1526.

## 1. Verdict

The specs describe the shipped regime computation, the D78 arithmetic, the supplementary series of D79, the archive reader and the public API load limits accurately. Every test file that the two success-criteria tables name in this repo exists. The SDK suite, its typecheck and the purity test pass (section 2).

The drift is in what the specs leave out or still describe as planned:

- **Public API filters.** The spec says `raw-history`, `asset-prices` and `source-versions` filter by source id. The code filters by storage key, under other parameter names (DOC-1).
- **D74 amendment.** The growth indicators now read the DEFI_TVL and STABLES keys. The analytics requirements still say every consumer keeps its keys (DOC-2). `regime-engine.md` said the same and is fixed here (RE-2).
- **Optimizers and drift.** The SDK ships certified optimizers and `simulateDrift`. A non-goal and a definition say it does not (DOC-4, DOC-5).
- **The `inputs` command.** The SDK requirements name `csvb inputs`. The SDK's own `bun run inputs` does that job (DOC-8).
- **Stale paths in regime-engine.md.** Its compute paths point at backend files that are now one-line re-exports, and its line numbers drifted (RE-1, fixed).

No finding is release-integrity or assertion-integrity harm. The highest severity is medium.

## 2. Test runs

| Check | Result |
| ----- | ------ |
| `bun test` in `packages/analyst-sdk` | 488 pass, 0 fail across 30 files, `fetch` replaced by a thrower (`tests/no-network.ts` preload) |
| `bunx tsc --noEmit` in `packages/analyst-sdk` | Clean |
| `bun test scripts/tests/unit/analyst-sdk-purity.test.ts` | 55 pass, 0 fail |

Backend tests that need Postgres were not run here. Their files exist. CI runs them in the `backend` workflow.

## 3. Findings

| Id | Severity | Spec | Finding | Evidence | Resolution |
| --- | --- | --- | --- | --- | --- |
| DOC-1 | medium | analytics-requirements 4.4 | INCONSISTENT. The route table says `raw-history` and `asset-prices` filter by `series`, a source id, and that `source-versions` filters by source id. The code reads `indicator` (a `raw_indicator_history` key) and `symbol` (an `asset_prices` symbol), and it matches `source-versions`' `series` against the storage `source_key`. A client that sends `series=yahoo:^GSPC` gets an unfiltered page from the first two routes and an empty page from the third. Owner: decision. Either the code reads source ids (D74 says new public contracts use them) or the spec names the storage-key filters. | `backend/src/api/routes/public-analytics.ts:456`, `:478`, `:697` | recorded: issue 1459 comment |
| DOC-2 | medium | analytics-requirements 4.1 | STALE. "The mapping is per consumer: each consumer keeps reading the storage keys it reads today." Since issue 1514, `indicator:DEFI_GROWTH` reads `raw_indicator_history:DEFI_TVL` and `indicator:STABLES_GROWTH` reads `raw_indicator_history:STABLES`. | `packages/analyst-sdk/src/series-ids.ts:101` (`STORED_UNDER`); `docs/decisions.md` D74 amendment (issue 1514) | recorded: issue 1459 comment |
| DOC-3 | low | decisions D74 amendment | UNRESOLVED_DECISION. The amendment's status line says `proposed`, while its text says the owner amended point 1 on 2026-10-28, and the code implements it. Its status needs the owner's acceptance. The amendment of D75 and the D56 edits are also `proposed`. This review leaves all three to the owner. | `docs/decisions.md` D74 "Amendment (issue 1514, owner 2026-10-28)"; `packages/analyst-sdk/src/series-ids.ts:96` | recorded: issue 1459 comment |
| DOC-4 | medium | definitions, Backtest terms | INCONSISTENT. "This refactor does not add a drifting-holdings simulator." The SDK exports `simulateDrift`, a drift-aware simulator, and analytics-requirements 5.3 specifies it. | `docs/definitions.md:51`; `packages/analyst-sdk/src/analyze/backtest.ts:354`; `packages/analyst-sdk/src/index.ts:9` | recorded: issue 1459 comment |
| DOC-5 | medium | analytics-requirements 1; analyst-sdk-requirements 1 | INCONSISTENT. The analytics requirements list "Optimizers" as a non-goal. The SDK requirements take every analytics non-goal as their own. The SDK ships certified optimizers and Markowitz sizing, which analytics-requirements 5.7, analyst-sdk-requirements 8 and the D78 amendment (issue 1513) all specify. | `docs/technical/analytics-requirements.md:14`; `docs/technical/analyst-sdk-requirements.md:22`; `packages/analyst-sdk/src/allocate/optimize.ts`; `packages/analyst-sdk/src/allocate/markowitz.ts`; `packages/analyst-sdk/src/index.ts:43-55` | recorded: issue 1459 comment |
| DOC-6 | low | analytics-requirements 3 | GAP_DOC. The Components table omits the archive reader (`src/archive/`), the allocation code (`src/allocate/`: universe, rules, signals, engine, optimizers, Markowitz), the inventory (`src/inventory.ts`), the coverage check (`src/coverage.ts`), the input manifest and supplementary format (`src/input/manifest.ts`, `src/input/supplementary.ts`) and the exact arithmetic and linear algebra (`src/transform/exact.ts`, `src/transform/linalg.ts`). | `packages/analyst-sdk/src/index.ts:15-55` | recorded: issue 1459 comment |
| DOC-7 | low | analyst-sdk-requirements 4; decisions D79 (5) | STALE. `--start` "defaults to 2016-01-01, the collection floor proposed for the platform". Issue 1514 merged that floor as `COLLECTION_START`, and analytics-requirements 4.1.1 specifies it. | `packages/analyst-sdk/src/inventory.ts:31`; `docs/technical/analyst-sdk-requirements.md:81` | recorded: issue 1459 comment |
| DOC-8 | medium | analyst-sdk-requirements 5, 8 | STALE. The spec says `csvb inputs --archive <dir> --run <run_key>` writes the input file, tested by csvb `tests/rerun-vintage.test.ts`. The SDK writes it with `bun run inputs --archive <dir> --run <run_key> [--as-of] [--out] [--json]`, tested by `tests/inputs.test.ts`, and the README documents that command. | `packages/analyst-sdk/bin/inputs.ts:1`; `packages/analyst-sdk/package.json:12`; `packages/analyst-sdk/tests/inputs.test.ts:70`; `packages/analyst-sdk/README.md:125` | recorded: issue 1459 comment |
| DOC-9 | low | analytics-requirements 4.2; analyst-sdk-requirements 5 | GAP_DOC. Both say the input is a CSV with exactly the header `date,series,value`. The loader also accepts the historical replay form `date,series,value,kind` (with `--replay`) and the legacy form `date,indicator,value,source`, and `bun run inputs` writes the replay form. | `packages/analyst-sdk/src/input/load.ts:43`, `:201`; `packages/analyst-sdk/README.md:204` | recorded: issue 1459 comment |
| DOC-10 | low | analyst-sdk-requirements 7 | GAP_DOC. The command line section lists `--start`, `--asof`, `--factor` and `--full`. `bun run regime` also takes `--replay` and `--provenance`. `bun run backtest` (one portfolio, gated by the Base asset universe) has no requirement. | `packages/analyst-sdk/bin/regime.ts:28`; `packages/analyst-sdk/bin/backtest.ts:1` | recorded: issue 1459 comment |
| DOC-11 | low | analytics-requirements 4.4 | GAP_DOC. The route table lists six routes. The API also serves `archive/backups` and `archive/<path>`, which section 4.6 describes without naming. | `contract/src/routes.js:388-389` | recorded: issue 1459 comment |
| DOC-12 | low | analytics-requirements 4.8 | INCONSISTENT. "A heavy request costs 10: an archive of a large table, or a frozen run output." The code charges 10 for every archive body, whatever its table. | `backend/src/api/routes/public-analytics.ts:964` | recorded: issue 1459 comment |
| RE-1 | low | regime-engine 1 to 5, 9 | STALE. The compute paths named `backend/src/analytics/analyze/*.ts` and `backend/src/analytics/transform/*.ts`, which are one-line re-exports of `packages/analyst-sdk/src/`. Thirteen line citations had drifted, for example `rollingPercentileRank` at `math.ts:176` (now 216) and `bucketFn` at `compute.ts:267` (now 266). | `backend/src/analytics/analyze/compute.ts:1`; `packages/analyst-sdk/src/transform/math.ts:216`; `packages/analyst-sdk/src/analyze/compute.ts:266` | fixed: docs/technical/regime-engine.md |
| RE-2 | medium | regime-engine 8.2 | STALE. "Each consumer reads the storage keys it read before" did not name the D74 amendment's exception for the two growth indicators. | `packages/analyst-sdk/src/series-ids.ts:101`; `packages/analyst-sdk/tests/input-rule.test.ts` | fixed: docs/technical/regime-engine.md |
| RE-3 | low | regime-engine 8.1 | STALE. The link to the SDK README used the anchor `#reproducing-a-published-run`, which no README heading produces. The section is now "Quickstart: rerun a published run". | `packages/analyst-sdk/README.md:64` | fixed: docs/technical/regime-engine.md |

## 4. Confirmed behavior

- **Shared seam (D57).** Every `backend/src/analytics/analyze/*.ts` and `transform/*.ts` file is a one-line re-export of the package, apart from the dead `analyze/regime.ts` that regime-engine section 7 names.
- **Registry.** There are 26 indicators: 8 macro, 10 onchain and 8 factor, with `PANELS = ["macro", "onchain"]` (`packages/analyst-sdk/src/analyze/indicators.ts:464`).
- **Collection floor.** `COLLECTION_START` is `2016-01-01`, and both inventories exist (`packages/analyst-sdk/inventory/`).
- **Load limits (D73).** The public API has a gate of 2, a 5 s statement timeout, 100 weighted tokens a minute and a byte budget (`backend/src/api/public-analytics-limits.ts`). Its edge cache is 256 MB, and the web server sets `X-Client-IP` (`website-server/nginx.conf:83`, `:179`).
- **Supplementary series (D79).** `openSupplementary`, `fetchSupplementary`, `readSupplementary` and `writeSupplementary` sit where analyst-sdk-requirements 4 says they do. `bun run fetch` defaults `--start` to 2016-01-01.
- **Tuning principle.** The building blocks named in analyst-sdk-requirements 2 are exported from `src/index.ts`.
- **Constants.** The weight, smoothing and window constants in regime-engine sections 4 and 5 match the code.

## 5. Review boundary

- csvb lives in robotmoney/csv-backups on `main`. Its rows in the success-criteria tables (`tests/fill-parity.test.ts`, `tests/download-client.test.ts`, `tests/rerun-vintage.test.ts`), `csvb resolve` and the download client of analyst-sdk-requirements 6 were not checked against code. PR 1526 moves csvb into `packages/csvb`, so a review after it merges should cover them.
- `regime-engine.md` sections 10 and 11 are audit history and remediation design. Their line citations were not re-pinned.
- The backend tests that need Postgres were not run locally.
- No production data was read.
