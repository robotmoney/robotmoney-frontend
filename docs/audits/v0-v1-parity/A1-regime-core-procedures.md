# A1 — Regime core: v0 → v1 procedural parity audit

**Worker:** W1 (procedure half of the regime core computation)
**Date:** 2026-08-03
**v0 (production today):** `/drive2/home/lucas/robotmoney/robotmoney-site` — read only, never written to.
**v1 (under audit):** this worktree, `backend/src/analytics/**`.

---

## Verdict

> **NO — v1's regime *core procedure* is proven bit-identical to v0's, but v1's *published regime output* is not and cannot be identical to v0's**, because v0 publishes a frozen per-day vintage mosaic while v1 republishes a full fresh recompute every run (measured gap on real data: max |Δcomposite| 0.0725, max |Δpercentile| 0.249, **9 regime labels** over 2,960 published rows), and because v1's onchain panel admits a BTC_MVRV series that v0's live floor does not carry at all (measured: **159 regime labels** and 2,993 of 3,098 composite days change).

Restated precisely, because the distinction matters:

- **Algorithm parity: PROVEN.** Every function in `compute.js` / `lib/utils.js` / `lib/transforms.js` has an exact v1 counterpart, and running both implementations over the authoritative v0 on-disk floor (3,098 days, 2018-01-01 → 2026-06-25) produced **zero** differing values on every output series and **zero** differing regime labels — including through v1's production `ages` call path. This is executed evidence, not a reading of comments.
- **Output parity: DISPROVEN.** Two pipeline-level differences (frozen-vintage publication, BTC_MVRV admission) mean the numbers a user sees will differ for most historical days.

The owner's question — "for any period and any metric, does v1 produce mathematically identical results to v0?" — answers **NO** on today's data. The reason is *not* a porting defect in the math.

---

## How this was verified

All claims below marked EXECUTED were produced by running both implementations against each other. Per the standing caveat from PR #464, no comment, test name, or docstring in either repo was accepted as evidence.

| Harness | What it ran | Result |
|---|---|---|
| Registry diff | v0 `lib/indicators.js` vs v1 `analyze/indicators.ts`, field by field | 26 vs 26 indicators, identical order, one field diff (BTC_MVRV source) |
| Differential fuzz | 400 randomized trials × 17 helper functions, with NaN / tie / zero / zero-variance injection | **0 mismatches** |
| Synthetic end-to-end | `computeRegime` both engines, 2,557-day axis, 2-panel and 3-panel | all 9 output series IDENTICAL |
| Real replay (vendored floor) | v1 test fixture `raw-indicator-history.csv.gz`, 3,102 days | all series IDENTICAL, incl. `weightsByPanel` |
| **Real replay (v0 authoritative floor)** | v0's own `data/regime/raw-indicator-history.csv`, 3,098 days | all series IDENTICAL, 0 label diffs |
| Frozen-vintage probe | v0's own published `data/regime/regime-history.csv` vs a fresh v0 recompute | 2,552 / 2,960 rows exceed write precision; 9 label diffs |
| BTC_MVRV probe | v0-fresh without BTC_MVRV vs with v1's series | 2,993 / 3,098 composite days differ; 159 label diffs |
| Bucket boundary probe | `bucketFn` at 0.33 / 0.67 / NaN across v0, v1, `@robotmoney/contract` | v0 ≡ v1; contract diverges at exactly 0.67 and on NaN |

---

## Coverage table

Every exported or internally-used function and every numeric constant in the four v0 files. Nothing omitted.

### `scripts/regime/compute.js`

| v0 | v1 | Grade | Note |
|---|---|---|---|
| `computeRegime` — `compute.js:34` | `computeRegime` — `analyze/compute.ts:54` | **IDENTICAL** (with caveat F1) | Line-for-line same pipeline; EXECUTED bit-identical on 3,098 real days. v1 adds two optional trailing params (`ages`, `maxForwardFillDays`) — see F1. |
| `smoothRegimes` — `compute.js:171` | `smoothRegimes` — `analyze/compute.ts:172` | **IDENTICAL** | Same 5-day confirmation, same 2σ fast-track, same directional consistency test, same `deltas.length >= 30` floor, same **sample** (n−1) variance at `compute.js:203` / `compute.ts:206`. |
| `weightedMeanOnDay` — `compute.js:246` | `weightedMeanOnDay` — `analyze/compute.ts:249` | **IDENTICAL** | Same `Number.isFinite` skip on both value and weight; same `den > 0 ? num/den : NaN`. |
| `bucketFn` (module export) — `compute.js:259` | `bucketFn` — `analyze/compute.ts:267` | **IDENTICAL** | `p < 0.33 → risk_off`, `p > 0.67 → risk_on` (strict, **exclusive** upper), else neutral; NaN → null. Boundary EXECUTED at 0.32999999 / 0.33 / 0.67 / 0.6700001 / NaN. |
| local `bucket` closure — `compute.js:97` | (folded into exported `bucketFn`) — `analyze/compute.ts:133,147` | **EQUIVALENT** | v0 defines the identical body twice (closure at :97, export at :259) and passes the closure; v1 passes the export. Same three comparisons in the same order → same result for every input including NaN. |
| `CONFIRMATION_DAYS = 5` — `compute.js:167` | `analyze/compute.ts:168` | **IDENTICAL** | |
| `FAST_TRACK_SIGMA = 2.0` — `compute.js:168` | `analyze/compute.ts:169` | **IDENTICAL** | |
| `SIGMA_LOOKBACK_DAYS = 252` — `compute.js:169` | `analyze/compute.ts:170` | **IDENTICAL** | |
| `WEIGHT_REFRESH_DAYS = 21` — `compute.js:53` | `analyze/compute.ts:86` | **IDENTICAL** | Same refresh predicate `i % 21 === 0 || i === last`, so the same days get a fresh correlation matrix and the same days reuse the stale one. |

### `scripts/regime/lib/indicators.js`

| v0 | v1 | Grade | Note |
|---|---|---|---|
| `INDICATORS` (26 entries) — `lib/indicators.js:27` | `analyze/indicators.ts:31` | **DIVERGENT** (1 of 26) | EXECUTED field diff: 25/26 identical on id/panel/source/series/sign/transform/align/unit, in identical array order. `BTC_MVRV` differs — see F2. Panel membership identical: macro 8, onchain 10, factor 8. |
| `PANELS = ['macro','onchain']` — `lib/indicators.js:479` | `analyze/indicators.ts:464` | **IDENTICAL** | |
| `ROLLING_WINDOW_DAYS = 365 * 3` — `lib/indicators.js:481` | `analyze/indicators.ts:466` | **IDENTICAL** | 1095 both sides (EXECUTED). |
| `COMPOSITE_BUCKETS = {risk_off:0.33, risk_on:0.67}` — `lib/indicators.js:482` | `analyze/indicators.ts:467` | **IDENTICAL** | |
| `sign` field on every indicator | same | **IDENTICAL** | All 26 signs match; sign-align expression `sign >= 0 ? v : 1 - v` matches (`compute.js:43` / `compute.ts:83`). |
| `align: 'zero_fill'` branch | `analyze/indicators.ts` (type declared, unused) | **IDENTICAL (both dead)** | No indicator in either registry sets `align`, so `alignDailyZeroFill` is unreachable on both production paths. |

### `scripts/regime/lib/transforms.js`

| v0 | v1 | Grade | Note |
|---|---|---|---|
| `applyTransform` — `lib/transforms.js:19` | `transform/transforms.ts:14` | **IDENTICAL** | All 7 cases (`level`, `change30`, `change90`, `sma4`, `sma7`, `trend_50_200`, `rolling_sum_7`) EXECUTED equal over 400 fuzz trials and over all 26 real indicator series. Same `s200[i] !== 0` guard, same `xs.slice()` copy on `level`, same throw on unknown name. |
| `applyRatio` — `lib/transforms.js:49` | `transform/transforms.ts:44` | **IDENTICAL** | Same `Math.min` length, same `den !== 0` guard, same NaN fill. |

### `scripts/regime/lib/utils.js`

| v0 | v1 | Grade | Note |
|---|---|---|---|
| `mean` — `lib/utils.js:51` | `meanArr` — `transform/math.ts:84` | **IDENTICAL** | Same sequential accumulation order (float-sum order preserved), same `NaN` for empty. **Warning:** `transform/math.ts:20` exports a *different* function also called `mean` (returns `0` for empty, uses `reduce`) — see F5. |
| `stddev` — `lib/utils.js:58` | `stddev` — `transform/math.ts:92` | **IDENTICAL** | **Sample** (n−1) both sides; `NaN` for length < 2. Unused by the regime core on both sides. **Warning:** `transform/math.ts:24` exports `std`, which is **population** — see F5. |
| `sma` — `lib/utils.js:66` | `sma` — `transform/math.ts:102` | **IDENTICAL** | Same `minValid = max(1, floor(n/2))` NaN tolerance, same `i >= n` drop (note: both drop `xs[i-n]`, giving an n+1-wide window at the moment of drop — the same off-by-one is faithfully reproduced), same warm-up gate `i >= n-1`. |
| `pctChange(xs, lag)` — `lib/utils.js:95` | `pctChangeLag` — `transform/math.ts:125` | **IDENTICAL** | Renamed only. Same zero-denominator and non-finite-denominator skips, same length-preserving NaN pad. |
| `rollingSum` — `lib/utils.js:104` | `rollingSum` — `transform/math.ts:135` | **IDENTICAL** | Same strict `nan === 0` requirement. Unreachable in production (no `rolling_sum_7` indicator) but ported faithfully. |
| `pearson` — `lib/utils.js:123` | `pearson` — `transform/math.ts:153` | **IDENTICAL** | Same pairwise-finite filter, same `< 3 pairs → 0`, same `dx===0 || dy===0 → 0`, same accumulation order. |
| `rollingPercentileRank` — `lib/utils.js:146` | `rollingPercentileRank` — `transform/math.ts:176` | **IDENTICAL** | Same `(below + 0.5·equal) / slice.length` mid-rank tie handling, same `slice.length < 30` warm-up gate, same trailing-inclusive window `[max(0,i-w+1) .. i]`, same NaN-skip. |
| `inverseCorrelationWeights` — `lib/utils.js:171` | `transform/math.ts:201` | **IDENTICAL** | Same defaults `minValidObs = 60`, `cap = 0.25`; same `Math.max(0.05, avgAbs)` floor; same `validIds.length === 1 → weight 1`; same `Object.keys` iteration order (both driven by the caller's insertion order, which is registry order on both sides). |
| `capWeights` — `lib/utils.js:228` | `transform/math.ts:250` | **IDENTICAL** | Same 20-iteration cap, same `cap + 1e-9` tolerance, same proportional redistribution, same infeasible-cap bail. |
| `alignDailyForwardFill` — `lib/utils.js:257` | `transform/math.ts:278` | **IDENTICAL** | NaN before first observation on both sides (contrast `transform/grid.ts:20`, which back-fills — see F6). |
| `alignDailyZeroFill` — `lib/utils.js:270` | `transform/math.ts:324` | **IDENTICAL** | Both unreachable (no `align: 'zero_fill'` indicator). |
| `buildDateAxis` — `lib/utils.js:288` | `transform/math.ts:342` | **IDENTICAL** | Same UTC anchoring (`+'T00:00:00Z'`, `setUTCDate`), same inclusive `<=` end, same calendar-day (not trading-day) axis. |
| `mergeSeries` — `lib/utils.js:332` | `transform/math.ts:356` | **IDENTICAL** | Same append-only floor semantics, same "fetched wins on overlap", same `localeCompare` ascending sort, same non-finite drop. |
| `isoDate(Date)` — `lib/utils.js:249` | `isoDateUTC` (module-private) — `transform/math.ts:272` | **EQUIVALENT** | Identical body. v1 does not export it; the driver's "today" is instead an injected `asof` parameter (`analytics/index.ts:130`) rather than `isoDate(new Date())` (`update.js:90`) — a testability improvement with no numeric effect for a given date. |
| `daysBetween` — `lib/utils.js:253` | — | **MISSING (benign)** | Zero callers anywhere in v0's regime pipeline. No numeric impact. |
| `atomicWrite` — `lib/utils.js:16` | — | **MISSING (by design)** | v1 persists to Postgres through `AnalyticsPersistence`; no CSV to write atomically. |
| `readCsv` — `lib/utils.js:28` | `loadRawFloorSeed` — `analytics/extract/floor-seed.ts:31` | **EQUIVALENT (different form)** | Both parse `date,indicator,value`; v1's drops non-finite rows and sorts ascending, matching what v0's downstream consumers do after `readCsv`. Not on the arithmetic path. |
| `writeLongHistoryCsv` — `lib/utils.js:42` | `store/raw-history-store.ts` (`saveRawIndicatorHistory`) | **DIVERGENT (storage shape)** | v0 writes the **dense forward-filled** aligned series (`update.js:` `writeRawHistoryCsv`); v1 persists the **sparse merged** real observations. Same aligned values re-derived on read, but it changes `ages` semantics — see F1. |

### v1-only (EXTRA)

| v1 | Grade | Note |
|---|---|---|
| `forwardFillAge` — `transform/math.ts:309` | **EXTRA** | New; feeds the #402 staleness cap. See F1. |
| `MAX_FORWARD_FILL_DAYS = 120` — `transform/math.ts:302` | **EXTRA** | New constant with no v0 analogue. See F1. |
| `mean` — `transform/math.ts:20` | **EXTRA (hazard)** | Returns `0` for empty where v0 returns `NaN`. See F5. |
| `std` — `transform/math.ts:24` | **EXTRA (hazard)** | **Population** σ; v0 has no population σ anywhere. See F5. |
| `percentileInWindow` — `transform/math.ts:31` | **EXTRA (hazard)** | `count(x <= value) / n`, **no tie-splitting**, returns `0.5` for `n <= 1`. Structurally different from `rollingPercentileRank`. EXECUTED: for value 3 in `[1,2,3,4]` it returns `0.75` where v0's rank rule gives `0.625`. Not on the production regime path; used by `channel-divergence.ts`, `late-cycle.ts`, `research-signals.ts`, `analyze/regime.ts`. |
| `applySign` — `transform/math.ts:37` | **EXTRA** | `sign === 1 ? pct : 1 - pct`. Equivalent to v0's inline `sign >= 0` form for the ±1 domain, but only used by the dead `regimeTool`. |
| `pctChange(xs)` — `transform/math.ts:39` | **EXTRA (hazard)** | Length-**shortening** 1-lag returns that emits `0` (not NaN) on a zero denominator. Different function from v0's `pctChange(xs, lag)`; v0's is `pctChangeLag`. |
| `ratio` — `transform/math.ts:45` | **EXTRA** | Emits `0` on a zero denominator where `applyRatio` emits `NaN`. Not on the regime path. |
| `rollingBeta`, `clamp01`, `lcg`, `hashStr`, `dateBefore`, `isoDay` — `transform/math.ts:53,18,4,9,66,73` | **EXTRA** | Research/seed-provider helpers; no v0 regime-core analogue. |
| `shapeDaily`, `ratioByDate` — `transform/grid.ts:13,30` | **EXTRA (dead)** | No callers outside `backend/tests/transform.test.ts`. See F6. |
| `regimeTool`, `REGIME_INDICATORS`, `WINDOW = 90` — `analyze/regime.ts:45,20,16` | **EXTRA (dead, but dangerous)** | A second, wholly different regime classifier. See F4. |
| `CURRENT_REGIME_VERSION = "v3"` — `analyze/regime-versions.ts:8` | **EXTRA** | v0 carries the equivalent in `data/regime/regime-versions.json`; the v1 constant hardcodes it and drops v0's version-lockout machinery. See F3. |
| `classifyRegime`, `REGIME_RISK_OFF/ON` — `contract/src/regime.js:23,14,15` | **DIVERGENT (off the hot path)** | See F7. |

---

## Findings

### F1 — `ages` / `MAX_FORWARD_FILL_DAYS`: a live behavioural divergence on the production call path — **NUMERIC-RISK**

`analytics/index.ts:227-228` calls `computeRegime(transformed, dateAxis, PANELS, ages)`. v0 has no equivalent parameter and no forward-fill cap. When an indicator's last real observation is more than **120 days** old (`transform/math.ts:302`), v1 nulls that day's value *before* percentile ranking (`analyze/compute.ts:78-80`); v0 carries the stale value forward with full panel weight forever.

**Trigger condition:** any macro- or onchain-panel indicator whose upstream feed produces no real print for >120 consecutive calendar days.

**EXECUTED magnitude** (synthetic 2,557-day axis, one onchain indicator's feed killed at 60% of the axis):

- 916 / 2,557 composite days differ
- **136 / 2,557 regime labels differ**
- max |Δ compositePercentile| = 0.2466

**Current real-data exposure: zero.** Over both real floors, every indicator's max forward-fill age is 0 days, so the cap never fires and v0/v1 agree exactly (EXECUTED: 0 diffs with `ages` supplied). This is because the seeded floor (`analytics/extract/floor-seed.ts:19`) is v0's **dense** aligned CSV, in which every axis day is a "real" row. **The exposure grows silently as v1 accumulates its own sparse rows past the seed cutoff (2026-06-29)** — from that point forward `forwardFillAge` returns genuine ages, and any feed outage longer than 120 days flips the two implementations apart.

**Evidence that this is untested against v0:** `backend/tests/regime-fidelity.test.ts:84` calls `computeRegime(transformed, dateAxis)` with **no `ages`**. The fidelity suite therefore never exercises the production call signature. `backend/tests/forward-fill-cap.test.ts` tests the cap against v1's own expectations, not against v0.

This is a deliberate, documented change (#402) — a defensible improvement, and not a porting defect. But it means "identical to v0" is false as a forward-looking statement, and the divergence is invisible today.

### F2 — BTC_MVRV: different source, different series, and v0's live floor has none of it — **BLOCKS-PARITY**

| | v0 `lib/indicators.js:271-272` | v1 `analyze/indicators.ts` (BTC_MVRV entry) |
|---|---|---|
| source | `blockchain_com` | `coinmetrics` |
| series | `'mvrv'` | `{ asset: 'btc', metric: 'CapMVRVCur' }` |

These are different metrics from different providers. Worse, v0's authoritative floor at `/drive2/home/lucas/robotmoney/robotmoney-site/data/regime/raw-indicator-history.csv` contains **0 rows** for `BTC_MVRV` (EXECUTED), while v1's floor carries **3,102**. In v0 today, BTC_MVRV is an all-NaN series excluded by `inverseCorrelationWeights`' `minValidObs` floor (weight 0). In v1 it is a full-weight member of the 10-indicator onchain panel, and its admission renormalizes every other onchain weight.

**EXECUTED magnitude** (v0's own `compute.js`, v0's own floor, only BTC_MVRV toggled):

- onchainIndex: 2,993 / 3,098 days differ, max |Δ| = **0.1238**
- composite: 2,993 / 3,098 days differ, max |Δ| = **0.0619**
- compositePercentile: 2,734 / 3,098 days differ, max |Δ| = **0.3404**
- **regime label: 159 / 3,098 days differ**

Direction is not one-sided — it depends on where BTC_MVRV's rank sits relative to the panel mean on each day. This single input change is, by itself, enough to make v1's published regime series visibly different from v0's for most of the history.

### F3 — Frozen-vintage publication vs full recompute — **BLOCKS-PARITY**

v0's cron path (`update.js:` `mergeFrozenIntoResult`, defined at `update.js:308`) **overwrites every freshly-computed historical day with the value locked in `regime-history.csv` when that day was first computed**, leaving only `dateAxis[last]` (today) mutable. v1 has no analogue: `analyze/regime-versions.ts:5-7` explicitly declares "no frozen lockout — every run recomputes the full history on best-available raw data", and `analytics/index.ts:261` persists every row from the fresh recompute.

Consequence: even with byte-identical math and byte-identical inputs, v1's historical rows are the *current-vintage* recompute while v0's are a *mosaic of original vintages*. Because indicator sources revise, and because each day's inverse-correlation weights depend on the trailing 3y window's data as it stood at compute time, these are not the same numbers.

**EXECUTED magnitude** — v0's own published `data/regime/regime-history.csv` (2,960 rows) vs a fresh v0 recompute over v0's own floor:

- max |Δ composite| = **0.07254** (worst day 2026-06-13)
- max |Δ compositePercentile| = **0.24931**
- max |Δ macro_index| = 0.10640, max |Δ onchain_index| = 0.08547
- **regime label differs on 9 rows**
- 2,552 / 2,960 rows differ by more than the CSV's own 6-decimal write precision

So: v0-published ≠ v0-fresh by these margins, and v1 publishes v0-fresh. The gap above is the *floor* on how far v1's published history sits from v0's published history — before F2's contribution is added.

**Note on circularity.** The in-repo golden `backend/tests/fixtures/regime/regime-history.csv.gz` does **not** reproduce this gap (EXECUTED: max Δ 5.0e-7, 0 label diffs — pure 6dp rounding). That is because it was regenerated from the v1 pipeline itself via `backend/scripts/regime-goldens-regenerate.ts`, as `backend/tests/regime-fidelity.test.ts:33-48` admits in its own header. The in-repo "fidelity" fixture is self-referential and cannot substantiate v0 parity. Measuring against v0's real on-disk artefacts — as done here — is the only way to see F3.

### F4 — A second, contradictory regime classifier lives in the tree — **NUMERIC-RISK**

`backend/src/analytics/analyze/regime.ts` defines `regimeTool` (`:45`), a complete alternative regime computation that shares nothing with `compute.ts` but the word "regime":

| | v0 / `compute.ts` | `analyze/regime.ts` |
|---|---|---|
| indicator set | 26 registry entries, 8 macro + 10 onchain | 11 hardcoded (`:20-32`) |
| weights | point-in-time inverse-correlation, 21-day refresh, 25% cap | static literals (`weight: 1.4`, `1.1`, …) |
| percentile | `rollingPercentileRank`, 1095-day window, mid-rank ties | `percentileInWindow` (`:82`), **90**-day window (`:16`), `<=` count, no tie split |
| composite | mean of panel indices | single weighted mean over all 11 (`:70`) |
| label input | rolling **percentile of** the composite | the **raw composite** (`:83`) |
| smoothing | 5-day confirmation + 2σ fast-track | none |
| precision | full double | `toFixed(4)` on composite, percentile, every indicator value and score (`:78,82,85`) |

It is currently **dead in production** — the only importer repo-wide is `backend/tests/analytics.test.ts`. But `contract/src/regime.js:3` names *this file* as "the canon" for regime labelling, which is factually wrong: the canon is `analyze/compute.ts:267`. Anyone following that pointer to reconcile a label will reconcile against the wrong algorithm.

### F5 — Divergent-semantics smoke-smoke-twins sharing a module with the ported math — **NUMERIC-RISK**

`transform/math.ts` holds the verbatim v0 port *and* a set of look-alike helpers with different semantics, in the same file, exported side by side:

| Ported (matches v0) | Look-alike smoke-smoke-twin | Divergence |
|---|---|---|
| `meanArr` — `:84` (NaN for empty) | `mean` — `:20` (**0** for empty) | The smoke-smoke-twin owns the shorter, more attractive name. EXECUTED: `v0.mean([])` = NaN, `v1.mean([])` = 0. |
| `stddev` — `:92` (**sample**, n−1) | `std` — `:24` (**population**, n) | EXECUTED: on `[1,2,3,4]`, `stddev` = 1.29099, `std` = 1.11803 — 13.4% apart. `smoothRegimes`' 2σ fast-track depends on the sample form; a one-character import slip silently loosens the circuit-breaker. |
| `pctChangeLag` — `:125` (length-preserving, NaN pad, skips zero denominators) | `pctChange` — `:39` (length-**shortening**, emits **0** on zero denominator) | The smoke-smoke-twin again holds the v0 name. |
| `rollingPercentileRank` — `:176` (mid-rank ties, 30-obs warm-up) | `percentileInWindow` — `:31` (`<=` count, no ties, `0.5` for n≤1) | EXECUTED: 0.75 vs 0.625 on `[1,2,3,4]` at value 3. |

No current regime-core call site uses the wrong smoke-smoke-twin (verified by import-graph grep). The risk is prospective and silent: every one of these pairs is a plausible autocomplete mistake that would produce plausible-looking numbers.

### F6 — `shapeDaily` back-fills where v0 forward-fills — **COSMETIC (currently dead)**

`transform/grid.ts:20` seeds its carry variable with `filtered[0].value`, so days *before* the first observation receive the first observation's value. v0's `alignDailyForwardFill` (`lib/utils.js:262`) seeds with `NaN`, leaving pre-history missing — which is what keeps a short-history indicator out of the percentile rank during warm-up. If `shapeDaily` were ever routed onto the regime path, every young indicator would enter its panel from day 1 with a fabricated flat pre-history. It has **no callers** outside `backend/tests/transform.test.ts`, so the current exposure is nil.

### F7 — `classifyRegime` disagrees with `bucketFn` at the boundary and on NaN — **COSMETIC (off the hot path)**

EXECUTED comparison:

| p | v0 `bucketFn` | v1 `bucketFn` | `contract/src/regime.js` `classifyRegime` |
|---|---|---|---|
| 0.33 | neutral | neutral | neutral |
| 0.67 | **neutral** | **neutral** | **risk_on** |
| NaN | **null** | **null** | **neutral** |

v0/v1 use `p > 0.67` (exclusive); the contract uses `composite >= 0.67` (inclusive). And the contract labels NaN as `neutral` rather than "unknown". Separately, the contract classifies a **raw composite**, whereas the regime label is defined on the composite's **rolling percentile** — different quantities on the same 0–1 scale.

Exactly-0.67 is reachable: `rollingPercentileRank` returns `(below + 0.5·equal)/n`, which is exactly 0.67 in float64 whenever n = 100 and below+0.5·equal = 67, and `slice.length` passes through 100 during every indicator's warm-up. Impact today is nil (the persisted label comes from `compute.ts`, and `contract`'s only consumers are `swarm/domain.ts`'s smoke synthesis — gated off prod at `swarm/domain.ts:900` — and the dead `regimeTool`). It becomes real the moment anything adopts the "canonical" classifier for a live composite.

### F8 — Persistence precision — **COSMETIC**

v0 writes its published history CSV through `fmt6` (`update.js:370-372`), truncating every metric to 6 decimals; v0's JSON snapshot keeps full precision (`nullIfNaN`, `update.js:439,468`). v1 persists full double precision for the numeric columns (`analytics/index.ts:430-443`) and rounds only the per-indicator `percentiles` map to 6 decimals (`analytics/index.ts:415`). Max divergence attributable to this alone is 5e-7. Immaterial numerically, but it means "byte-identical to v0's published CSV" is unachievable by construction.

---

## What I could not determine

Honest limits of this audit. None of the following is verified-equal; all of it is unverified.

1. **Live fetcher output.** I compared v0's and v1's *stored* floors, not what their fetchers return today. The two floors already disagree on 11,026 overlapping raw values (EXECUTED). Most is 6dp CSV write precision (all ratio indicators — `IWM_SPY`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY`, `XLP_XLY` — show ~59-63% of overlap differing at max relative error ~1e-6, which is exactly `toFixed(6)`). But a handful are **not** rounding: `BTC_ACTIVE` max rel 7.1e-2, `DXY` 1.8e-2, `DFII10` 1.8e-2, `DEFI_TVL` / `DEFI_GROWTH` 1.2e-2, `ETH_ACTIVE` 1.0e-2, `HY_OAS` 7.3e-3, `COPPER_GOLD` 5.3e-3. These are single-day disagreements each, plausibly source revisions between the two capture vintages, but I did not confirm that — they could equally be parser differences. **This is W2's scope and I did not resolve it.** Confirming procedure parity does not confirm the pipeline agrees end to end.
2. **`ages` under realistic sparse production data.** Every measurement of F1 that showed zero divergence relied on the dense seeded floor. I could not obtain a v1 production database with post-seed sparse rows, so I could not measure the cap's real steady-state effect. My synthetic bound (136 label flips) is illustrative, not a production estimate.
3. **The 9 label rows in F3.** I measured the count and the maximum magnitude, but did not attribute individual rows to a specific cause (source revision vs weight-window drift vs the v3 relock at `update.js:` `writeFullHistoryCsv`). The 2026-06 clustering of the worst days suggests recent-vintage revisions dominate, but I did not prove it.
4. **Downstream consumers.** `analyze/backtest.ts`, `analyze/correlations.ts`, `analyze/channel-divergence.ts`, `analyze/late-cycle.ts`, `analyze/research-signals.ts` and `report/*` were read only far enough to trace imports out of the core. Their math is not audited here (other workers' scope). Note that `channel-divergence.ts`, `late-cycle.ts` and `research-signals.ts` all consume the `percentileInWindow` smoke-smoke-twin from F5, so their percentile convention differs from the regime core's by construction — whether that matches *their* v0 counterparts is unverified.
5. **Frontend re-derivation.** `frontend/public/assets/js/app/alpine/views/blog-charts.js:308-315` derives a combined regime label from macro/onchain votes using a rule that exists nowhere in the backend. I did not check it against v0's equivalent page.
6. **Ordering assumptions under adversarial input.** Both implementations assume `dateAxis` is ascending and `series` is date-sorted ascending. Neither asserts it. My fuzzing always supplied ascending input, so I did not test whether they *diverge* on descending or unsorted input — only that they agree on well-formed input.
7. **Float non-determinism across runtimes.** Both engines were executed under Bun 1.3.14 in this session, so the JS-vs-TS comparison shares one float implementation. v0 production runs under Node. IEEE-754 double arithmetic is specified, and all operations here are `+ - * / Math.sqrt` (all correctly rounded), so cross-runtime divergence is not expected — but I did not execute v0 under Node to confirm it empirically.

---

## Summary of grades

| Grade | Count | Items |
|---|---|---|
| IDENTICAL | 26 | All of `compute.js` (9), the 4 registry constants + panel/sign/align semantics (5), both transforms (2), and 13 of the `utils.js` stats/align/date/merge functions |
| EQUIVALENT | 3 | local `bucket` closure → exported `bucketFn`; `isoDate` → `isoDateUTC`; `readCsv` → `loadRawFloorSeed` |
| DIVERGENT | 3 | `INDICATORS` (BTC_MVRV entry, F2); `writeLongHistoryCsv` → sparse store (F1); `classifyRegime` boundary (F7) |
| MISSING | 2 | `daysBetween` (benign, no callers); `atomicWrite` (by design, DB-backed) |
| EXTRA | 20 | `forwardFillAge`, `MAX_FORWARD_FILL_DAYS`, `mean`, `std`, `percentileInWindow`, `applySign`, `pctChange`, `ratio`, `rollingBeta`, `clamp01`, `lcg`, `hashStr`, `dateBefore`, `isoDay`, `shapeDaily`, `ratioByDate`, `regimeTool`, `REGIME_INDICATORS`, `WINDOW`, `CURRENT_REGIME_VERSION` |

**Blocking parity:** F2 (BTC_MVRV), F3 (frozen vintage).
**Numeric risk:** F1 (`ages` cap), F4 (shadow classifier), F5 (semantic smoke-smoke-twins).
**Cosmetic:** F6 (`shapeDaily` back-fill, dead), F7 (contract boundary, off hot path), F8 (write precision).
