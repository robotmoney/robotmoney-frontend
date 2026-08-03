# A2 — Snapshot assembly, correlations & backtest: v0 → v1 procedure parity

Worker W2. Audit date 2026-08-03.

**Path roots** (all `path:line` below are relative to one of these):

- `V0` = `/drive2/home/lucas/robotmoney/robotmoney-site` (production today; READ-ONLY, never written during this audit)
- `V1` = `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260803-160300-v0-v1-mathematical-parity-audit`
- `P464` = `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260802-010943-regime-fidelity-independent-reference` (PR #464, READ-ONLY)

---

## Verdict

**NO — not certified identical.**

The *pure algorithm layer* (`computeCorrelations`, `computeBacktest`, `simulate`, and every helper)
is a faithful, numerically exact port — I independently reproduced it to 0 diffs at 1e-9 by running
v0's own JS. But the *assembly layer around it* diverges: v0 computes its published correlations and
backtest over a **frozen** regime history, v1 computes them over a **fresh full recompute**, and that
single difference moves v0's headline shipped backtest number by **−8.01%**
(`eth.composite.final_value` 13.73331688969207 → 12.633861326544146, transitions 56 → 58).

---

## How the top-line divergence was proven

Not inferred from reading — measured, by driving **v0's own unmodified modules**
(`V0/scripts/regime/compute.js`, `lib/utils.js`, `lib/transforms.js`, `lib/indicators.js`) over
**v0's own committed raw floor** (`V0/data/regime/raw-indicator-history.csv`) at `asof=2026-06-25`:

| Path | `eth.composite.final_value` | `transitions` | `n_days` |
|---|---|---|---|
| **v0 SHIPPED** (`V0/public/data/regime-snapshot.json`) | `13.73331688969207` | 56 | 2963 |
| v0 semantics reproduced (frozen-merge path) | `13.73331688969207` ✅ **exact, all 17 digits** | 56 | 2963 |
| v1 semantics (fresh recompute, no frozen merge) | `12.633861326544146` | 58 | 2963 |

The exact reproduction of v0's shipped constant confirms the model of v0's semantics is correct, and
therefore that the third row is a genuine v1 divergence and not a measurement artifact.

Underlying driver — frozen history vs. fresh recompute over 2,960 shared dates:

- composite regime-label rows differing: **9 (0.30%)** — e.g. `2020-05-25..28` frozen `risk_on` / fresh `neutral`; `2026-06-06,13,14,16` frozen `neutral` / fresh `risk_off`
- panel regime-label rows differing: **17 (0.57%)**
- `max |Δcomposite| = 0.072536`, `max |Δmacro| = 0.106396`, `max |Δonchain| = 0.085466`

Downstream, on identical extras:

| portfolio.strategy | frozen (v0) | fresh (v1) | rel Δ | transitions | sharpe |
|---|---|---|---|---|---|
| `eth.composite` | 13.7333 | 12.6339 | **8.01%** | 56 → 58 | 0.847 → 0.830 |
| `mixed.composite` | 7.4695 | 7.0777 | **5.24%** | 56 → 58 | 0.954 → 0.934 |
| `eth.conservative` | 5.9037 | 5.7952 | 1.84% | 122 → 124 | 0.713 → 0.708 |
| `eth.aggressive` | 5.3542 | 5.4064 | 0.97% | 131 → 133 | 0.664 → 0.666 |
| `mixed.conservative` | 3.4933 | 3.4297 | 1.82% | 122 → 124 | 0.765 → 0.756 |
| `mixed.aggressive` | 3.9919 | 4.0467 | 1.37% | 131 → 133 | 0.709 → 0.714 |

Correlations are far less sensitive (they consume index *levels* over ~2,960 points, so 9 label rows
wash out): `concurrent.composite.eth` ρ frozen `0.408731` vs fresh `0.408897`;
`forward.composite.eth_180d` ρ frozen `-0.047320` vs fresh `-0.047290`.

### Why the frozen values reach the backtest at all

`V0/scripts/regime/compute.js:128-136` assigns the **same array references**
(`out.macroIndex = panelIndices.macro`, `out.macroRegime = panelRegimes.macro`, …). So when
`mergeFrozenIntoResult` (`V0/scripts/regime/update.js:309-328`) overwrites `result.macroIndex[i]` /
`result.regime[i]`, it is simultaneously mutating `result.panelIndices.macro[i]` /
`result.panelRegimes.macro[i]` — exactly the arrays `computeCorrelations`
(`update.js:539-540`) and `computeBacktest` (`update.js:710-711`) read. The merge happens at
`update.js:131`, **before** `writeSnapshot` at `update.js:145` calls both at `update.js:457-458`.

### v0's doc/code mismatch (important context, not an excuse)

`V0/data/regime/regime-versions.json` describes v3 as *"the frozen-baseline lockout is removed. Every
cron run rewrites regime-history.csv with the freshly computed full history"* — which is what v1
implements. But `update.js` does **not** do that: `isHistoryAtVersion` (`update.js:235-244`) returns
true once the CSV carries the current tag (it does — all 2,960 rows are tagged `v3`), so
`update.js:129-133` takes the `mergeFrozenIntoResult` + `appendTodayToFrozenHistory` branch on every
run. The full-history rewrite at `update.js:128` fires only on the one-shot version-bump run.

So v1 matches v0's **stated intent** but not v0's **shipped output**. For an audit whose question is
"is v1 mathematically identical to v0", the shipped output is the answer, and it is not.

---

## Coverage table

### Pure algorithm layer — correlations

| v0 function/field | v1 counterpart | Grade | Note |
|---|---|---|---|
| `computeCorrelations` `update.js:531-583` | `backend/src/analytics/analyze/correlations.ts:41-90` | **IDENTICAL** | Same loop order, same pair-construction, same `{rho,n}` cells. Verified 0 numeric diffs. |
| Spearman (rank-then-Pearson) `update.js:607-612` | `correlations.ts:119-124` | **IDENTICAL** | Rank correlation, not Pearson-on-levels. Both. |
| `ranks` (fractional midrank, 1-based) `update.js:614-626` | `correlations.ts:127-139` | **IDENTICAL** | Tie handling identical (`(i+j)/2+1`). |
| `pearson` `update.js:628-641` | `correlations.ts:141-164` | **IDENTICAL** | `n<2 → NaN`; `denom>0` guard identical. |
| Min-sample threshold `pairs.length < 10 → NaN` `update.js:608` | `correlations.ts:120` | **IDENTICAL** | Same threshold, same NaN→null via `nullIfNaN`. |
| Pairwise-complete deletion (skip non-finite `x`, skip null price) `update.js:554-559` | `correlations.ts:61-66` | **IDENTICAL** | Both pairwise-complete, not listwise. `n` counts surviving pairs only. |
| Forward-return alignment `p0=lookup(d,-1)`, `p1=lookup(d+h,+1)` `update.js:557-558` | `correlations.ts:64-65` | **IDENTICAL** | No off-by-one: same asymmetric search direction (`p0` searches backward, `p1` forward). |
| Log return `Math.log(p1/p0)` `update.js:560` | `correlations.ts:67` | **IDENTICAL** | Log, not simple. |
| Horizons `[30,90,180]` **calendar** days, assets `['spx','eth']` `update.js:528-529` | `correlations.ts:18-19` | **IDENTICAL** | Calendar-day offsets via `addDaysIso`, not trading days. Both. |
| Concurrent = index vs `log(price)` level `update.js:568-579` | `correlations.ts:75-86` | **IDENTICAL** | Level, not return. Both. |
| `lookupPrice` bridging, `maxStep=7` `update.js:591-599` | `correlations.ts:98-111` | **EQUIVALENT** | v1 adds `v !== undefined &&` before `Number.isFinite(v)`; `Number.isFinite(undefined)` is already `false`, so no behavioural delta. |
| `addDaysIso` `update.js:601-605` | `correlations.ts:113-117` | **IDENTICAL** | UTC-anchored. |
| `toDateMap` `update.js:585-589` | `correlations.ts:92-96` | **IDENTICAL** | Last-write-wins on duplicate dates. Both. |

### Pure algorithm layer — backtest

| v0 function/field | v1 counterpart | Grade | Note |
|---|---|---|---|
| `computeBacktest` `update.js:695-770` | `backend/src/analytics/analyze/backtest.ts:89-142` | **IDENTICAL** | Verified 0 numeric diffs across 4,992 leaves. |
| `PORTFOLIO_SPECS` `update.js:665-693` | `backtest.ts:31-59` | **IDENTICAL** | Mechanically compared; byte-equal after whitespace normalization. |
| `BACKTEST_COST_PER_REBALANCE = 0.001` `update.js:662` | `backtest.ts:20` | **IDENTICAL** | |
| `BACKTEST_IN_SAMPLE_END = '2024-01-31'` `update.js:663` | `backtest.ts:21` | **IDENTICAL** | In-sample boundary identical; `pt.date <= splitDate` inclusive on both sides. |
| `simulate` `update.js:827-925` | `backtest.ts:195-301` | **IDENTICAL** | See per-formula rows below. |
| Rebalance timing (return on `lastWeights`, then cost) `update.js:844-865` | `backtest.ts:220-241` | **IDENTICAL** | No look-ahead on either side: day *i*'s return uses weights set at close of *i-1*; the new weight is applied only after. |
| T-bill cash leg `(1+r/100)^(1/365)-1` on `tbillDaily[i-1]` `update.js:845` | `backtest.ts:221` | **IDENTICAL** | 365 day-count, lagged one day. Both. |
| Asset return `p1/p0 - 1` (simple, close-to-close) `update.js:852` | `backtest.ts:228` | **IDENTICAL** | Simple, not log. Both. |
| Turnover cost `∑|Δw|/2 × 10bps` `update.js:820-825,860-864` | `backtest.ts:188-193,236-240` | **IDENTICAL** | One-sided turnover; `sameWeights` 1e-9 tolerance identical. |
| `cagr = equity^(1/years) - 1`, `years` on 365.25 `update.js:877-878` | `backtest.ts:253-254` | **IDENTICAL** | Note both measure `years` from `startDate` to `endDate` while `equity` compounds only over *active* days — same (mildly odd) convention on both sides. |
| `sharpe = (mean×365)/(sd×√365)` `update.js:879-883` | `backtest.ts:255-259` | **IDENTICAL** | Sample sd (`n-1`); annualization 365; **no risk-free subtraction** on either side. |
| `max_drawdown` running-peak `update.js:867-869` | `backtest.ts:243-245` | **IDENTICAL** | Peak seeded at 1; drawdown recorded pre-rebalance-cost ordering identical. |
| `cagr_in_sample` / `cagr_out_sample` `update.js:885-905` | `backtest.ts:261-281` | **EQUIVALENT** | v1 adds `cagrIs == null ? null : nullIfNaN(cagrIs)`; v0's `nullIfNaN(null)` already yields `null` (`Number.isFinite(null) === false`). Same output. |
| `n_days` = `dailyReturns.length` `update.js:919` | `backtest.ts:295` | **IDENTICAL** | Excludes the first active day. Both. |
| `transitions` counter `update.js:863` | `backtest.ts:239` | **IDENTICAL** | |
| Month-end downsampled `equity_curve` `update.js:907-909` | `backtest.ts:283-285` | **IDENTICAL** | Last obs per `YYYY-MM`, Map-insertion then lexicographic sort. |
| `combineConservativeN` `update.js:772-779` | `backtest.ts:144-149` | **IDENTICAL** | |
| `combineAggressiveN` `update.js:781-791` | `backtest.ts:151-158` | **IDENTICAL** | |
| `macro_inverted` `update.js:712-718` | `backtest.ts:111-117` | **IDENTICAL** | |
| `firstIndexWithAllAssets` `update.js:793-798` | `backtest.ts:160-165` | **IDENTICAL** | |
| `forwardFillDaily` `update.js:800-810` | `backtest.ts:167-178` | **EQUIVALENT** | `map.has()` → `get() !== undefined`; `Point.value` is `number`, so no stored-`undefined` case exists. |
| tbill forward-fill `update.js:696-702` | `backtest.ts:94-101` | **EQUIVALENT** | Same `has` → `get !== undefined` rewrite. |
| Weight selection for a bucket `update.js:839` | `backtest.ts:215` | **EQUIVALENT** | v1 adds a `regimeSeries` null-guard; at both call sites `weightsByBucket` and `regimeSeries` are always supplied together, so behaviour is unchanged. |
| `stripDailyFromSnapshot` `update.js:942-953` | `backtest.ts:305-316` | **IDENTICAL** | |
| `monthlySparkline` `update.js:494-518` | `backend/src/analytics/index.ts:501-521` | **IDENTICAL** | |
| Indicator registry + `ROLLING_WINDOW_DAYS=1095`, `COMPOSITE_BUCKETS{0.33,0.67}`, `PANELS` | `backend/src/analytics/analyze/indicators.ts` | **IDENTICAL** | 26 indicators, all `id:panel:sign:transform:align` tuples equal (mechanically diffed). |

### Assembly layer — where parity breaks

| v0 function/field | v1 counterpart | Grade | Note |
|---|---|---|---|
| `mergeFrozenIntoResult` `update.js:309-328`, called `update.js:131` | *(none)* | **MISSING** | **F1 — BLOCKS-PARITY.** No frozen merge anywhere in v1. |
| `loadFrozenHistory` `update.js:274-307` | *(none)* | **MISSING** | v1 never reads back prior snapshot rows before computing. |
| `appendTodayToFrozenHistory` (past rows immutable) `update.js:330-368` | `backend/src/analytics/store/regime-store.ts:53-75` (`ON CONFLICT (date) DO UPDATE`, all rows) | **DIVERGENT** | **F2 — BLOCKS-PARITY.** Every historical row is rewritten each run. |
| `isHistoryAtVersion` / one-shot version rewrite `update.js:121-133,235-272` | *(none)* — `CURRENT_REGIME_VERSION` is a constant, `analyze/regime-versions.ts:8` | **MISSING** | v1 has no version-gated relock concept; every run behaves like a version-bump run. |
| `fmt6` 6-dp quantization of the frozen record `update.js:370-372` | *(none)* | **MISSING** | v0's historical values round-trip through 6 dp; v1 keeps full float precision. Second-order vs F1. |
| `extras: {spx, eth}` sliced from first history date `update.js:449-455, 474-477` | *(none)* — `index.ts:428-455` never sets `extras` | **MISSING** | **F3.** Column exists (`regime-store.ts:52`) but the pipeline never writes it → `NULL` in production. |
| `bucket_thresholds` `update.js:466` | *(none)* — `index.ts:428-455` never sets `bucketThresholds` | **MISSING** | **F4.** Column exists, pipeline never writes it. |
| `rolling_window_days` `update.js:465` | *(no column, no field)* | **MISSING** | **F4.** |
| `generated_at` `update.js:464` | *(none)* | **MISSING** | Cosmetic. |
| eq snapshot: 3-panel `computeRegime` → its **own** correlations + backtest `update.js:150-152` | `index.ts:240-241` computes both from `r2` **only**; row declares `panels:["macro","onchain","factor"]` `index.ts:450` | **MISSING** | **F5.** No `factor` key in `correlations.forward`, no `factor` backtest strategy. Row is internally inconsistent (3-panel display, 2-panel backtest). |
| `writeBacktestCsv` → `data/regime/backtest-equity.csv` (full daily equity, all portfolios × strategies) `update.js:459, 927-940` | *(none)* — `_daily` stripped at `index.ts:241`, never persisted | **MISSING** | **F6.** |
| Indicator metadata `source_url`, `description`, `derivation`, `interpretation` `update.js:414-420` | `index.ts:478-495` omits all four | **MISSING** | **F7.** Non-numeric. |
| Indicator list filtered to the snapshot's own panels `update.js:406` | `index.ts:469` maps **all** `INDICATORS` | **EXTRA** | Deliberate (single 3-panel row design). Non-numeric. |
| *(no v0 equivalent)* | `ages` / `MAX_FORWARD_FILL_DAYS=120` capping — `analyze/compute.ts:69-80`, wired at `index.ts:222,227-228` | **EXTRA** | **F9 — conditional.** Measured **inert** on the current floor (0 label diffs, `Δcomposite = 0.000e+0`). |
| *(no v0 equivalent)* | `forward_fill_age_days`, `forward_fill_expired` `index.ts:492-493`; `source` provenance `index.ts:444` | **EXTRA** | Additive, non-numeric. |
| `history[]` embedded in one snapshot doc `update.js:434-447` | one `regime_snapshots` row per date; blobs on latest row only `index.ts:407-456` | **EQUIVALENT** | Same skip rule (`if (!result.regime[i]) continue` ↔ `if (!r2.regime[i]) continue`), different container. |

**Grade counts** — IDENTICAL 31 · EQUIVALENT 7 · DIVERGENT 1 · MISSING 11 · EXTRA 3.

---

## PR #464's "0 numeric diffs" claim

**Verdict: the claim is TRUE, and I verified it independently. But it certifies the algorithm port, not v0→v1 output parity.**

### Background: what it is fixing

On `main`, `backend/tests/backtest-correlations-fidelity.test.ts` carries a test named
*"reproduces the ORIGINAL JS reference byte-for-byte"* — but its own header (lines 32-39 in the `V1`
copy) admits the golden was regenerated by **the same TS pipeline under test** (PR #444, issue #400),
on the claim that the original JS generator was permanently unavailable. That test is a tautology and
its name is false. This is the prior false parity claim the audit brief refers to. PR #464 (issue
#447) fixes it.

### What I verified myself (not accepted on assertion)

1. **Provenance is real.** `P464/backend/scripts/vendor/regime-reference-js/README.md` cites five blob
   shas. I recomputed them with `git hash-object` against `V0/scripts/regime/`. **All five match
   exactly**: `compute.js 75cd2110…`, `lib/indicators.js a752928c…`, `lib/transforms.js 69228d18…`,
   `lib/utils.js 3ae7ea18…`, `update.js aa51879c…`.
2. **The vendored library files are verbatim.** `diff` against `V0` shows only a prepended provenance
   comment header — zero logic lines changed, in all four.
3. **The `update.js` extraction is verbatim.** `backtest-correlations.js` is hand-carved out of
   `update.js`, so I compared it mechanically: all **17 functions** (`computeCorrelations`,
   `toDateMap`, `lookupPrice`, `addDaysIso`, `spearman`, `ranks`, `pearson`, `computeBacktest`,
   `combineConservativeN`, `combineAggressiveN`, `firstIndexWithAllAssets`, `forwardFillDaily`,
   `sameWeights`, `turnoverBetween`, `simulate`, `stripDailyFromSnapshot`, `nullIfNaN`) plus all four
   constants and `PORTFOLIO_SPECS` are equivalent after comment/whitespace normalization.
4. **The numbers check out.** I ran v0's **original** `compute.js` + `lib/*` loaded directly from
   `V0` (not from the vendored copy) over the same fixture floor, then the extraction, and compared:
   **`corrDiffs=0, btDiffs=0` at 1e-9** against `P464`'s committed reference.

So the comparison **is** genuinely independent, and the claim holds.

### A nuance worth recording

Running the same original-JS driver against **`main`'s** (TS-generated) reference also gives
`corrDiffs=0, btDiffs=0` — and the two reference files are **payload-identical excluding `meta`**.
Meaning: #444 did **not** corrupt any number. What it destroyed was the *epistemic independence* of
the check — it turned a cross-implementation proof into a self-consistency proof while keeping the
name that promised the former. #464 restores the independence and, incidentally, confirms the TS port
was faithful all along. That is the right fix, honestly described.

### What #464 does NOT cover

- **The frozen-merge semantics — the actual 8% divergence.** The generator
  (`P464/backend/scripts/regime-independent-reference-regenerate.ts:133,173-174`) calls
  `computeBacktest` on a **fresh** `computeRegime` result. That is precisely v1's assumption. The
  reference can therefore *never* detect F1/F2, no matter how exact it is. It proves
  "given the same `result`, both implementations agree" — while the whole divergence lies in *which
  `result` production feeds in*.
- **The production compute call.** The golden uses the 2-panel default `computeRegime(transformed,
  dateAxis)` with **no `ages`** and **no 3-panel `r3`**. `index.ts:227-228` passes `ages` and computes
  `r3`. Neither production argument is exercised by any golden.
- **One date, one vintage.** `asof=2026-06-29`, one raw floor, one extras vintage. No
  incremental-vs-full-rebuild comparison, no multi-vintage replay, no second date.
- **The entire assembly layer.** `extras`, `bucket_thresholds`, `rolling_window_days`, the eq/factor
  path, `backtest-equity.csv`, indicator metadata (F3–F7) are all outside the reference payload.
- **No CI enforcement of regeneration.** `regime-independent-reference:regenerate` is a manual script
  (`P464/backend/package.json:18`); no workflow runs it or asserts the committed golden still matches
  what the vendored JS produces. The `bun test` job (`.github/workflows/backend.yml:106`) *does*
  execute the fidelity tests, so a **TS** regression fails CI — but nothing structurally prevents a
  future PR from regenerating the golden from the TS side again and silently repeating #444.

**Recommendation:** merge #464 (it is a genuine improvement, soundly evidenced), but do not read it as
v0↔v1 parity evidence, and add a CI step that re-runs the vendored-JS generator and diffs the result
against the committed golden.

---

## Findings

| # | Finding | Severity | Trigger condition |
|---|---|---|---|
| **F1** | v1 has no frozen-history merge; correlations/backtest are computed over a fresh full recompute, v0's over the frozen locked history (`update.js:131` + aliasing at `compute.js:128-136`). | **BLOCKS-PARITY** | Any run after the first. Measured: 9 composite label rows differ, `eth.composite.final_value` −8.01%, `transitions` 56→58, `mixed.composite` −5.24%. |
| **F2** | Historical `regime_snapshots` rows are rewritten every run (`regime-store.ts:53`), whereas v0's past rows are immutable (`update.js:330-368`). | **BLOCKS-PARITY** | Any raw-data revision or backfill. A published historical composite/regime label changes between two v1 runs with no version bump — so v1 is not stable against *itself*, let alone v0. |
| **F3** | `extras` (spx/eth chart overlay) never written by the pipeline → `NULL` in production. | **NUMERIC-RISK** | Every production run. Only `db/import-regime-eq.ts` (fixture importer) populates it, so demo/Playwright shows data production lacks. |
| **F4** | `bucket_thresholds` never written; `rolling_window_days` has no column at all. | **COSMETIC** | Every run. Both are constants and identical in value (`0.33/0.67`, `1095`), so no number is wrong — only unavailable to clients. |
| **F5** | Backtest/correlations computed from `r2` only, while the row advertises `panels:["macro","onchain","factor"]`. v0 shipped a separate 3-panel eq snapshot with a `factor` correlations index and a `factor` backtest strategy. | **NUMERIC-RISK** | Every run. `factor` strategy and `forward.factor`/`concurrent.factor` cells are absent; a consumer iterating `panels` finds no matching backtest entry. |
| **F6** | `data/regime/backtest-equity.csv` (full daily equity, all portfolios × strategies) has no v1 counterpart; `_daily` is stripped and discarded. | **NUMERIC-RISK** | Every run. Only month-end `equity_curve` survives, so daily drawdown/equity analysis available in v0 cannot be reproduced in v1. |
| **F7** | Indicator metadata `source_url`, `description`, `derivation`, `interpretation` dropped. | **COSMETIC** | Every run. Non-numeric; affects dashboard provenance/explainer copy. |
| **F8** | `main`'s `backtest-correlations-fidelity.test.ts` STRICT test is named *"reproduces the ORIGINAL JS reference byte-for-byte"* but compares against a golden generated by the implementation under test. | **NUMERIC-RISK** | Present on `main` until #464 merges. The name misleads any future reader into over-trusting it; the numbers happen to be right, the guarantee is not. |
| **F9** | v1-only forward-fill age capping (`MAX_FORWARD_FILL_DAYS = 120`, `compute.ts:69-80`, passed at `index.ts:228`) has no v0 equivalent. | **NUMERIC-RISK** *(currently inert)* | Fires only when a non-`zero_fill` indicator's real observations stop for **>120 consecutive days**. Measured on the current floor: **0** label diffs, `max|Δcomposite| = 0`. Becomes an active divergence the first time any feed stalls that long. |
| **F10** | v0's `fmt6` 6-dp quantization of frozen values vs v1's full float precision. | **COSMETIC** | Subsumed by F1; would matter only if F1 were fixed by replaying v0's CSV. |

---

## What I could not determine

- **Whether v0's live cron still runs the frozen path today.** I audited the checked-out state of
  `robotmoney-site` (working tree, files dated 2026-07-31; snapshot `generated_at` 2026-06-25). If a
  version bump has landed since, v0's next run would take the one-shot fresh-rewrite branch and
  transiently agree with v1 — after which it re-freezes. I could not observe the deployed cron.
- **v0's exact extras vintage.** The published snapshot slices `spx`/`eth` to the history start and
  does not publish `tbill3m` at all, so my reproduction used `V1`'s fixture `tbill3m` plus the
  snapshot's sliced prices. This makes my *absolute* forward-correlation ρ values non-comparable to
  v0's published ρ (truncated forward prices at the 180d horizon). It does **not** affect the
  frozen-vs-fresh comparison, which used identical extras on both sides, nor the backtest figures
  (confirmed by the exact `final_value` reproduction).
- **Real user-visible impact of F3/F4/F5.** I did not trace which frontend components consume
  `extras`, `bucket_thresholds`, or a `factor` backtest strategy, so I cannot say whether these
  degrade silently or render as empty UI.
- **Whether v1 has ever executed against the live source in production.** This audit read code and
  fixtures; I did not inspect a deployed database, so I cannot confirm the persisted rows match what
  the code implies.
- **Off-by-one risk in `n_days` / `cagr` year-count under a leading gap.** Both sides share the same
  convention (`years` spans `startDate`→`endDate` while `equity` compounds over active days only), so
  it is not a *parity* defect; whether it is a defect *in both* is out of this audit's scope.
- **`source`/telemetry columns.** v1-only, no v0 analogue, no numeric content — not graded.

---

*Method note: every numeric claim above was produced by executing v0's own unmodified modules
(`V0/scripts/regime/{compute,lib/utils,lib/transforms,lib/indicators}.js`) out of a scratch directory
under `/tmp`. No file under `V0` or `P464` was written, and no git state anywhere was modified.*
