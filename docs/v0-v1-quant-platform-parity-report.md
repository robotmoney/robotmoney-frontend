# v0 → v1 Quant Platform Parity Report

**For:** the platform owner, deciding whether to cut over to v1.
**Date:** 2026-08-03.
**v0 (production today):** `/drive2/home/lucas/robotmoney/robotmoney-site` @ `4a1c4639`, data vintage `asof = 2026-06-25`. Read-only throughout.
**v1 (under audit):** worktree `adhoc/20260803-160300-v0-v1-mathematical-parity-audit`, base `main` @ `aa854ff`.
**Consolidates:** audits A1, A2, A3, A4, B1, C1 (`docs/audits/v0-v1-parity/`), plus two reconciliations executed for this report.

---

## Governing principle

Absence of evidence is not evidence of parity. Every step below carries exactly one evidence class. Nothing was upgraded on the strength of a comment, a test name, or a fixture that v1 produced itself.

| Class | Meaning |
|---|---|
| **PROVEN-IDENTICAL** | Parity demonstrated by executing both implementations, or by byte-comparing a genuine v0 artifact. Cites what ran and over what range. |
| **PROVEN-DIFFERENT** | Divergence demonstrated. Magnitude, range, and user-visible consequence stated. Where a step differs **by construction** (the two sides compute different quantities) but the gap was never measured, the note says so — it is not softened. |
| **PROVEN-DIFFERENT-DORMANT** | Divergence proven, currently inert. The arming condition is stated. **This is not parity.** |
| **UNVERIFIED** | No executed evidence either way. **The default. It is a risk, not a pass.** |
| **UNTESTABLE-DATA-ACCESS** | Cannot be settled without data, credentials, or network unavailable here. |

Two hard rules applied throughout:

- **A step whose only support is a v1-derived fixture is UNVERIFIED.** Six such fixtures are named by name in §4 and §6.
- **A step that passes only because v1 vendors v0's literal bytes is transport fidelity, not computational parity.** It is labelled as such and cannot survive the next recomputation.

---

## 1. Verdict

> **No. v1 does not reproduce v0's results.** On the single most user-visible number — the published daily regime label — **v1 disagrees with v0's production `regime-history.csv` on 153 of 2,960 classified days (5.17%)**, spread across every year from 2018 to 2026. The composite index differs on **100%** of those 2,960 days (max |Δ| 0.0768), the on-chain panel index on 100% (max |Δ| 0.1238), and the headline shipped backtest multiple `eth.composite.final_value` moves **−8.01%** (13.7333 → 12.6339). None of this is a porting defect: I proved by execution that v0's own engine, given v1's inputs, produces v1's numbers exactly. The divergence is entirely a matter of **which inputs are admitted** and **which publication policy is used** — both deliberate v1 changes that were never quantified before this audit, and neither of which any test in the repository could have caught, because **all four regime baseline fixtures were regenerated from v1's own pipeline** in PR #444.

Two facts frame everything else:

1. **The regime engine is sound.** Executed this session: v0's unmodified `scripts/regime/compute.js` + `lib/*`, run over v0's own raw floor with v1's `BTC_MVRV` column added, reproduces v1's committed full-history recompute with **zero** differing composite values on every day from 2018-01-01 to 2026-06-19 and **zero** regime-label differences across all 2,960 published days. The arithmetic was ported faithfully.
2. **The assurance around it is not.** Only **5 of ~33 in-scope v0 metric families (~15%)** are under a genuine independent v0 cross-check today, and all five are research signals. **The entire regime core — composite, panel indices, percentiles, labels, correlations, backtest — has zero independent v0 assurance** (C1 §0, §3). The two tracking gates that nominally guard it have tolerance bands (**0.08** absolute composite; **20%** relative `final_value`) *wider than the divergence actually measured* (0.0768; 8.01%) — they are mathematically incapable of failing on it.

### Scoreboard

119 pipeline steps inventoried end to end (§3).

| Evidence class | Steps | Share |
|---|---:|---:|
| **PROVEN-IDENTICAL** | **30** | 25% |
| **PROVEN-DIFFERENT** | **43** | 36% |
| **PROVEN-DIFFERENT-DORMANT** | **10** | 8% |
| **UNVERIFIED** | **29** | 24% |
| **UNTESTABLE-DATA-ACCESS** | **7** | 6% |
| *Total* | *119* | *100%* |

Read that as: **53 of 119 steps (45%) are proven to differ, or are proven to differ under a stated future condition. 36 of 119 (30%) have no executed evidence at all.** Only 25% is proven identical, and that 25% is concentrated almost entirely in the arithmetic layer — the part that was never in doubt.

### Coverage of the assurance suite

| | Count |
|---|---:|
| v0 metric families in scope | ~33 |
| …with a genuine **independent v0** cross-check | **5** (~15%) — all research signals |
| …with only a **v1-derived** baseline | regime core: composite, percentiles, labels, correlations, backtest |
| …with **no baseline of any kind** | vault economics, wallet balances, buybacks, prices, all swarm metrics |
| Regime fidelity assertions that are self-consistency checks **after PR #464 merges** | **4 of 6** |

---

## 2. The certifiable envelope

This is the paragraph that can be defended to a counterparty. It is deliberately narrow.

> **What can be certified today.** Over the published history **2018-05-15 → 2026-06-25 (2,960 days)**, v1 reproduces v0's published **macro panel** to within v0's own 6-decimal CSV write precision (≤5e-7) on **2,930 of 2,960 days**, and reproduces v0's published **macro regime label on 2,960 of 2,960 days — zero flips**. The 30 exceptions to the numeric claim are all dated **2026-05-23 → 2026-06-25** and are attributable to FRED revision plus v0's frozen-vintage mosaic, not to v1's arithmetic.
>
> **Separately, and this is the stronger claim:** v0's own unmodified `scripts/regime/compute.js` and `lib/{utils,transforms,indicators}.js`, executed over v0's own raw floor with v1's `BTC_MVRV` series added, reproduce v1's committed full-history recompute with **zero differing composite values on every day from 2018-01-01 through 2026-06-19**, and **zero regime-label differences on all 2,960 published days**. The regime engine is therefore a proven-faithful port, and **100% of the measured v0↔v1 output divergence is attributable to inputs and publication policy, not to the arithmetic.**

**Conditions attached to that envelope, all of which must be quoted with it:**

- It covers the **2-panel `computeRegime(transformed, dateAxis)` signature only**. Production calls `computeRegime(transformed, dateAxis, PANELS, ages)` (`backend/src/analytics/index.ts:227`). **No golden, and no measurement in this audit, exercises the production signature against v0.**
- It covers the **regime core arithmetic**. It does not cover correlations or backtest against v0's *published* values, which differ (§5).
- It is conditional on **identical raw inputs**. v1's floor already differs from v0's on 11,164 of 72,385 shared cells (§7a).
- It ends at **2026-06-19** for the composite. Beyond that, v0's floor carries provisional prints that upstream later restated.

**What cannot be certified — state this plainly:**

| Metric | Status |
|---|---|
| `onchain_index`, `composite` | **No certifiable window at all.** 100% of the 2,960 published days differ. |
| `composite_percentile` | No certifiable window. 92.2% of days differ above quantisation. |
| `onchain_regime` | No certifiable window. 289 / 2,960 days (9.76%) flip. |
| `regime` (headline label) | No certifiable window. 153 / 2,960 days (5.17%) flip. |
| Backtest `final_value`, `cagr`, `sharpe`, `max_drawdown`, `transitions` | Not certifiable. `eth.composite` −8.01%. |
| Correlations (48 `{rho,n}` cells) | Not certifiable against published values. |
| Six factor-panel ETF ratio inputs | **No certifiable window** — differ from 2018-01-02, the first shared date. |
| `BTC_MVRV` | **Empty window** — v0's floor has zero rows. |
| Vault economics, wallet balances, buybacks, prices, all swarm metrics | **No baseline of any kind exists.** Unaudited. |
| Anything on the demo / e2e surface | **Vacuous.** `ANALYTICS_SOURCE=hermetic` replaces every input with a seeded random walk (`backend/src/analytics/access/hermetic-source.ts:37-49`). |

---

## 3. Complete pipeline step inventory

Path roots: **v0** = `robotmoney-site`; **v1** = this worktree. Every row is one step. Steps that exist on only one side say so.

### Stage 1 — Ingestion / fetchers

| # | Step | v0 | v1 | Produces | Class | Magnitude | Note |
|---|---|---|---|---|---|---|---|
| 1.1 | FRED CSV fetch | `scripts/regime/fetchers/fred.js:19-23,32-44` | `backend/src/analytics/extract/fred.ts:16-20,23-42` | `T10Y2Y DFII10 T5YIE HY_OAS DXY ICSA` | UNVERIFIED | — | Identical URL/parse on read. Never executed live on either side. **Neither pins an ALFRED vintage** → neither is reproducible from a later fetch. |
| 1.2 | Yahoo chart v8 fetch | `fetchers/yahoo.js:11-35` | `extract/yahoo.ts:16-31,35-54` | 10 price/ratio series | **PROVEN-DIFFERENT** | ≤1.38e-6 rel, 11,134 cells | Code is a faithful port (same `adjclose`→`close` fallback). The **data** differs: Yahoo retroactively restates adjusted close on every distribution. Six dividend-bearing ETF ratios drift across the entire history; every non-dividend leg is bit-identical. Unfixable property of the input. |
| 1.3 | blockchain.com charts | `fetchers/blockchain_com.js:15,22-27` | `extract/blockchain-com.ts:15-16,19-25` | `BTC_ACTIVE` | UNVERIFIED | — | Identical endpoint/parse on read. v1 throws where v0 returns `[]`; same net outcome. |
| 1.4 | Coinmetrics asset-metrics | `fetchers/coinmetrics.js:10-33` | `extract/coinmetrics.ts:13-18,23-55` | `ETH_ACTIVE`; **v1 also `BTC_MVRV`** | UNVERIFIED | — | Pagination/parse identical on read. Usage differs — see 4.1. |
| 1.5 | DefiLlama historical chain TVL | `fetchers/defillama.js:8-20` | `extract/defillama.ts:12-15,27-29` | `DEFI_TVL`, `DEFI_GROWTH` | UNVERIFIED | — | Identical. Upstream restates ~6 recent days (observed in the floor tail). |
| 1.6 | DefiLlama stablecoin float | `fetchers/defillama.js:30` | `extract/defillama.ts:22` | `STABLES`, `STABLES_GROWTH` | **PROVEN-DIFFERENT-DORMANT** | Unit error, unbounded | **The native-units-as-USD bug.** v0 falls back to the `totalCirculatingUSD` *object* → `NaN` → row dropped (a loud gap). v1 falls back to `totalCirculating?.peggedUSD` — the **native-unit** aggregate — a finite number silently ingested as USD. **Arms the moment DefiLlama changes payload shape.** Same branch on today's payload. |
| 1.7 | GeckoTerminal new pools | `fetchers/geckoterminal.js:44-47` | `extract/geckoterminal.ts:36-40,85-131` | `NEW_TOKENS` | **PROVEN-DIFFERENT-DORMANT** | Direction known, size unmeasured | v0 breaks out on a 429 and silently **under-counts**; v1 retries (5 attempts/page, 45 s budget). On any throttled day v1 records a **higher** count. `NEW_TOKENS` has `sign −1`, so it pushes the composite the *other* way. **Arms on the first throttled live run.** |
| 1.8 | multpl.com CAPE scrape | `fetchers/multpl.js:32-42` | `extract/shiller.ts:58-69` | `SHILLER_CAPE` | **PROVEN-DIFFERENT-DORMANT** | Unbounded | **v1 fixes a v0 bug, which breaks parity.** v0's regex cannot match the `&#x2002;` entity multpl now emits; CAPE has been frozen at **30.81 since 2023-09-01** on both floors (1029/1033-day flat run). v1's first live run recovers a current CAPE; v0 keeps carrying 30.81. Factor panel → 3-panel composite and indicator pages. **Arms on v1's first live fetch.** |
| 1.9 | datahub Shiller mirror + merge | `fetchers/shiller.js:20-21,35-69,73-124` | `extract/shiller.ts:15-16,22-51,95-148` | `SHILLER_CAPE` backfill | UNVERIFIED | — | Same URL, same `PE10` column resolution, same `allSettled` merge precedence. Never executed. |
| 1.10 | EDGAR full-text S-4 counts | `late-cycle-signals.js:220-282` | `extract/edgar.ts:23,39,45-49` + `extract/edgar-fetch-plan.ts:20,28` | `MNA` monthly | **PROVEN-DIFFERENT-DORMANT** | Permanent per-month drift | v0 re-crawls **every** month from 2010 on every run, so any EDGAR back-revision lands indefinitely. v1 fetches only missing months + a **2-month** revision window against the persisted floor. **A revision to a month older than 2 months never lands and the persisted value diverges permanently.** In v1's favour: v1 refuses to publish the signal when the refresh degrades (`index.ts:330-342`); v0 published with silent month gaps. |
| 1.11 | Backtest extras (`^GSPC`, `ETH-USD`, FRED `DTB3`) | `update.js:374-396` | `access/data-source.ts:91,147-154` | correlation + backtest price/cash legs | UNVERIFIED | — | Same symbols, same start dates. Never executed live. |
| 1.12 | Transport policy: timeouts, cache, hermetic substitution | none (v0 has no timeouts) | `extract/http.ts:16-57`; `extract/fetch-cache.ts:40-42`; `access/hermetic-source.ts:37-49` | all inputs | **PROVEN-DIFFERENT-DORMANT** | Falls back to floor | v1 imposes 8 s/15 s hard fetch timeouts; **a slow-but-healthy upstream that v0 waits for makes v1 fall back to the persisted floor.** `DEMO_MODE` adds a 1 h GET cache. `ANALYTICS_SOURCE=hermetic` replaces every series with a seeded random walk — **any parity observed on demo/e2e is vacuous.** |

### Stage 2 — Raw floor persistence

| # | Step | v0 | v1 | Produces | Class | Magnitude | Note |
|---|---|---|---|---|---|---|---|
| 2.1 | `mergeSeries` append-only merge | `lib/utils.js:332` | `transform/math.ts:356` | merged floor | **PROVEN-IDENTICAL** | 0 | Executed: 400-trial differential fuzz + full real replay (A1). Same "fetched wins on overlap", same `localeCompare` sort, same non-finite drop. |
| 2.2 | Floor **write shape** | `update.js:138,172-190` writes the **dense forward-filled grid** | `store/raw-history-store.ts` writes the **sparse merged observations** | `raw-indicator-history.csv` / `raw_indicator_history` | **PROVEN-DIFFERENT** | Structural | Same aligned values re-derived on read, **but it changes `ages` semantics and is what arms step 3.6.** Today every axis day in the seed is a "real" row, so `forwardFillAge` reads 0 everywhere. Past the 2026-06-29 seed cutoff, v1 accumulates genuine ages. |
| 2.3 | Floor **content** (shared cells) | `data/regime/raw-indicator-history.csv`, 72,385 rows | `backend/tests/fixtures/regime/raw-indicator-history.csv.gz`, 75,587 rows | the input to everything | **PROVEN-DIFFERENT** | **11,164 / 72,385 cells (15.4%)** | Measured this session (§7a). 11,134 in the ≤1e-6 Yahoo band; 11 cells at 5.3e-3…7.1e-2, **all dated 2026-06-22…25**. |
| 2.4 | `BTC_MVRV` floor rows | **0 rows** | **3,102 rows** | onchain panel input | **PROVEN-DIFFERENT** | Total | v0's `blockchain_com/mvrv` chart was removed upstream; `fetch_all.js:68-72` swallows the failure. The single largest driver of every downstream difference. |
| 2.5 | Floor capture provenance | daily cron commit | no manifest | — | UNVERIFIED | — | v1's floor leads v0's by exactly 4 days on all 25 shared series — consistent with a later v0 capture, but **no manifest records when or by what run it was captured** (unlike `edgar-mna-seed.manifest.json`). |
| 2.6 | `NEW_TOKENS` second floor + `capped` flag | `fetchers/geckoterminal.js:23,65-98` maintains `data/regime/token-launches.csv` | none — flag computed at `extract/geckoterminal.ts:142,152`, **never persisted** | provenance signal | **PROVEN-DIFFERENT** | Non-numeric | v1 drops the independent second floor and the throttle-provenance flag. (Note: `token-launches.csv` is **not present** in the v0 checkout either, and is not in v0's cron commit list — so it is uncommitted in v0 too.) |

### Stage 3 — Transforms & alignment

| # | Step | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 3.1 | `buildDateAxis` (UTC, calendar days, inclusive end) | `lib/utils.js:288` | `transform/math.ts:342` | **PROVEN-IDENTICAL** | Executed, full replay. |
| 3.2 | `alignDailyForwardFill` (NaN before first obs) | `lib/utils.js:257` | `transform/math.ts:278` | **PROVEN-IDENTICAL** | Executed. Contrast the dead `transform/grid.ts:20`, which **back-fills** — see 3.6 note. |
| 3.3 | `alignDailyZeroFill` | `lib/utils.js:270` | `transform/math.ts:324` | **PROVEN-IDENTICAL** | Both unreachable — no indicator sets `align` on either side. |
| 3.4 | `applyTransform` — all 7 cases | `lib/transforms.js:19` | `transform/transforms.ts:14` | **PROVEN-IDENTICAL** | Executed over 400 fuzz trials + all 26 real series. Same `s200[i] !== 0` guard, same throw on unknown name. |
| 3.5 | `applyRatio` | `lib/transforms.js:49` | `transform/transforms.ts:44` | **PROVEN-IDENTICAL** | Executed. Same `Math.min` length, `den !== 0` guard, NaN fill. |
| 3.6 | Forward-fill **expiry cap** | *(none — v0 forward-fills without bound)* | `transform/math.ts:302,309`; `analyze/compute.ts:69-80`; wired `index.ts:222,227-228` | **PROVEN-DIFFERENT-DORMANT** | **The #402 `ages` cap.** When an indicator's last real observation is >120 days old, v1 nulls that day *before* percentile ranking; v0 carries it forward at full panel weight forever. **Measured exposure on both real floors today: zero** (the dense seed makes every age 0). **Synthetic bound: 916/2,557 composite days and 136/2,557 regime labels change.** Arms when any feed stalls >120 days past the 2026-06-29 seed cutoff. **`backend/tests/regime-fidelity.test.ts:84` calls `computeRegime` with no `ages` — the production signature is never exercised.** |

### Stage 4 — Indicator construction

| # | Step | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 4.1 | `INDICATORS` registry, 26 entries | `lib/indicators.js:27` | `analyze/indicators.ts:31` | **PROVEN-DIFFERENT (1 of 26)** | Executed field-by-field diff: 25/26 identical on id/panel/source/series/sign/transform/align, identical array order. **`BTC_MVRV` differs:** v0 `blockchain_com`/`mvrv` vs v1 `coinmetrics`/`{btc, CapMVRVCur}` — **different metrics from different providers**. |
| 4.2 | `PANELS`, `ROLLING_WINDOW_DAYS=1095`, `COMPOSITE_BUCKETS{0.33,0.67}` | `lib/indicators.js:479-482` | `analyze/indicators.ts:464-467` | **PROVEN-IDENTICAL** | Executed. Panel membership identical: macro 8, onchain 10, factor 8. |
| 4.3 | `sign` field + sign-align expression | all 26; `compute.js:43` | all 26; `compute.ts:83` | **PROVEN-IDENTICAL** | Executed. |
| 4.4 | Ratio pair date-intersection | `lib/fetch_all.js:75-86` | `extract/sources.ts:47-55` | UNVERIFIED | Code-equal on read; never executed against live fetch output. |

### Stage 5 — Panel indices & weighting

All executed bit-identical over v0's authoritative floor (3,098 days) *and* over 400 randomized differential-fuzz trials with NaN/tie/zero/zero-variance injection (A1).

| # | Step | v0 | v1 | Class |
|---|---|---|---|---|
| 5.1 | `rollingPercentileRank` — 1095d trailing-inclusive, mid-rank ties `(below+0.5·equal)/n`, 30-obs warm-up | `lib/utils.js:146` | `transform/math.ts:176` | **PROVEN-IDENTICAL** |
| 5.2 | Sign-align `sign >= 0 ? v : 1 - v` | `compute.js:43` | `compute.ts:83` | **PROVEN-IDENTICAL** |
| 5.3 | `pearson` — pairwise-finite, `<3 pairs → 0`, zero-variance → 0 | `lib/utils.js:123` | `transform/math.ts:153` | **PROVEN-IDENTICAL** |
| 5.4 | `inverseCorrelationWeights` — `minValidObs=60`, `cap=0.25`, `max(0.05, avgAbs)` floor | `lib/utils.js:171` | `transform/math.ts:201` | **PROVEN-IDENTICAL** |
| 5.5 | `capWeights` — 20 iterations, `cap+1e-9` tolerance, proportional redistribution | `lib/utils.js:228` | `transform/math.ts:250` | **PROVEN-IDENTICAL** |
| 5.6 | `WEIGHT_REFRESH_DAYS = 21` refresh predicate `i % 21 === 0 \|\| i === last` | `compute.js:53` | `compute.ts:86` | **PROVEN-IDENTICAL** |
| 5.7 | `weightedMeanOnDay` → panel index | `compute.js:246` | `compute.ts:249` | **PROVEN-IDENTICAL** |

### Stage 6 — Composite & percentile

| # | Step | v0 | v1 | Class |
|---|---|---|---|---|
| 6.1 | Composite = arithmetic mean of included panel indices | `compute.js` pipeline step 5 | `compute.ts` | **PROVEN-IDENTICAL** |
| 6.2 | Composite percentile = `rollingPercentileRank(composite, 1095)` | `compute.js` step 6 | `compute.ts` | **PROVEN-IDENTICAL** |

### Stage 7 — Regime classification

| # | Step | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 7.1 | `bucketFn` — `p<0.33 → risk_off`, `p>0.67 → risk_on` (**strict, exclusive upper**), NaN → null | `compute.js:259` | `compute.ts:267` | **PROVEN-IDENTICAL** | Boundary executed at 0.32999999 / 0.33 / 0.67 / 0.6700001 / NaN. |
| 7.2 | `smoothRegimes` — 5-day confirmation, 2σ fast-track, 252d lookback, **sample** (n−1) variance | `compute.js:171` | `compute.ts:172` | **PROVEN-IDENTICAL** | Executed. |
| 7.3 | `computeRegime` end-to-end, 2-panel default signature | `compute.js:34` | `compute.ts:54` | **PROVEN-IDENTICAL** | **Executed this session:** v0's engine over v0's floor + v1's `BTC_MVRV` reproduces v1's committed recompute with **0 nonzero composite diffs before 2026-06-20** and **0/2,960 label diffs**. Also: A1's 3,098-day real replay and 2,557-day synthetic end-to-end, both 0 diffs. |
| 7.4 | `computeRegime` **production** signature with `ages` | *(no v0 analogue)* | `index.ts:227` | **UNVERIFIED** | **No golden and no measurement in this audit exercises it against v0.** The fidelity suite omits `ages` entirely (`regime-fidelity.test.ts:84`). |
| 7.5 | 3-panel `r3` compute | `update.js:151` (separate eq snapshot) | `index.ts:228` | **UNVERIFIED** | No golden exercises the 3-panel path. |
| 7.6 | `classifyRegime` in the shared contract | *(none)* | `contract/src/regime.js:23` | **PROVEN-DIFFERENT-DORMANT** | Executed: at `p = 0.67` the contract says `risk_on` where both v0 and v1 say `neutral`; on NaN it says `neutral` where both say `null`. It also classifies a **raw composite**, whereas the label is defined on the composite's **rolling percentile**. `contract/src/regime.js:3` names `analyze/regime.ts` as "the canon" — **factually wrong**; the canon is `compute.ts:267`. Exactly-0.67 is reachable during warm-up. **Correction to A1:** A1 recorded this as "off the hot path", with the contract's only consumers being demo synthesis gated off prod at `swarm/domain.ts:900`. That is **not accurate** — `classifyRegime` is also a live fallback inside `buildRegimeSummary` (`swarm/domain.ts:1203,1228-1231`), which has **no prod gate**. See 13.6 / D15. It stays DORMANT only because it fires solely on rows whose stored label is `NULL`; **how often that happens in production is UNVERIFIED.** |
| 7.7 | `regimeTool` — a second, wholly different classifier | *(none)* | `analyze/regime.ts:45` | **PROVEN-DIFFERENT-DORMANT** | 11 hardcoded indicators (not 26), **static** literal weights (not inverse-correlation), **90-day** window (not 1095), `percentileInWindow` (no tie-splitting), labels the **raw composite** (not its percentile), no smoothing, `toFixed(4)` everywhere. Dead in production — only importer is `backend/tests/analytics.test.ts`. Arms if anything registers it. |

### Stage 8 — Frozen-vintage publication & snapshot assembly

**This whole stage is v0-only. v1 implements none of it.** It is the second of the two parity blockers.

| # | Step | v0 | v1 | Class | Magnitude |
|---|---|---|---|---|---|
| 8.1 | `mergeFrozenIntoResult` — overwrite every historical day with its original locked vintage | `update.js:308`, called `:131` | **none** | **PROVEN-DIFFERENT** | **9/2,960 labels; max \|Δcomposite\| 0.0725; max \|Δcomposite_percentile\| 0.2493; 2,552/2,960 rows exceed write precision.** Executed. |
| 8.2 | `appendTodayToFrozenHistory` — past rows immutable | `update.js:330-368` | `store/regime-store.ts:53-75` — `ON CONFLICT (date) DO UPDATE`, **all rows** | **PROVEN-DIFFERENT** | **v1 is not reproducible against itself.** Any raw-data revision silently rewrites published history with no version bump. |
| 8.3 | `isHistoryAtVersion` / one-shot version-gated relock | `update.js:121-133,235-272` | **none** — `CURRENT_REGIME_VERSION` is a bare constant (`analyze/regime-versions.ts:8`) | **PROVEN-DIFFERENT** | Every v1 run behaves like a version-bump run. |
| 8.4 | `fmt6` 6-dp quantisation of persisted history | `update.js:370-372` | full float64 (`index.ts:430-443`) | **PROVEN-DIFFERENT** | ≤5e-7. Immaterial numerically, but "byte-identical to v0's published CSV" is unachievable by construction. |
| 8.5 | `extras: {spx, eth}` chart overlay | `update.js:449-455,474-477` | **never written** — column exists (`regime-store.ts:52`), pipeline never sets it | **PROVEN-DIFFERENT** | `NULL` in production. Only the fixture importer `db/import-regime-eq.ts` populates it — **so demo and Playwright show data production lacks.** |
| 8.6 | `bucket_thresholds`, `rolling_window_days` | `update.js:465-466` | never written / no column | **PROVEN-DIFFERENT** | Values are constants and agree (0.33/0.67, 1095); only unavailable to clients. |
| 8.7 | Separate 3-panel eq snapshot document | `update.js:150-152` → `regime-eq-snapshot.json` with its **own** correlations + backtest | one row declaring `panels:["macro","onchain","factor"]` but computing both from `r2` **only** (`index.ts:240-241,450`) | **PROVEN-DIFFERENT** | **The row is internally inconsistent: 3-panel display, 2-panel backtest.** See 9.5 / 10.6. |
| 8.8 | Indicator metadata `source_url`, `description`, `derivation`, `interpretation` | `update.js:414-420` | omitted (`index.ts:478-495`) | **PROVEN-DIFFERENT** | Non-numeric; affects dashboard provenance copy. |

### Stage 9 — Correlations

| # | Step | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 9.1 | `computeCorrelations` engine | `update.js:531-583` | `analyze/correlations.ts:41-90` | **PROVEN-IDENTICAL** | Executed: 0 numeric diffs at 1e-9 by driving v0's own modules (A2). |
| 9.2 | Spearman (rank-then-Pearson), fractional midrank, `pairs<10 → NaN` | `update.js:607-626` | `correlations.ts:119-139` | **PROVEN-IDENTICAL** | Executed. |
| 9.3 | `lookupPrice` bridging (`maxStep=7`), `addDaysIso`, `toDateMap`, log returns, pairwise-complete deletion, horizons `[30,90,180]` calendar days, assets `[spx,eth]` | `update.js:585-612` | `correlations.ts:92-124` | **PROVEN-IDENTICAL** | Executed. No off-by-one; same asymmetric `p0` backward / `p1` forward search. |
| 9.4 | **Published** correlation values | frozen-history input | fresh-recompute input | **PROVEN-DIFFERENT** | `concurrent.composite.eth` ρ 0.408731 → 0.408897; `forward.composite.eth_180d` −0.047320 → −0.047290. Small — correlations consume ~2,960 index *levels*, so 9 label rows wash out. |
| 9.5 | `factor` correlation index (`forward.factor`, `concurrent.factor`) | present in eq snapshot — 6 forward + 2 concurrent cells | **absent** | **PROVEN-DIFFERENT** | 8 `{rho,n}` cells with no v1 counterpart, on a row that advertises a `factor` panel. |

### Stage 10 — Backtest

| # | Step | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 10.1 | `computeBacktest` | `update.js:695-770` | `analyze/backtest.ts:89-142` | **PROVEN-IDENTICAL** | Executed: **0 numeric diffs across 4,992 leaves** (A2). |
| 10.2 | `simulate`, rebalance timing, T-bill cash leg `(1+r/100)^(1/365)-1` lagged one day, turnover `∑\|Δw\|/2 × 10bps`, `sameWeights` 1e-9 | `update.js:827-925` | `backtest.ts:195-301` | **PROVEN-IDENTICAL** | Executed. **No look-ahead on either side.** |
| 10.3 | Metrics: `cagr` (365.25), `sharpe` (sample sd, ×365/√365, **no risk-free subtraction**), `max_drawdown`, `transitions`, `n_days`, in/out-of-sample split at `2024-01-31`, month-end `equity_curve` | `update.js:867-919` | `backtest.ts:243-295` | **PROVEN-IDENTICAL** | Executed. Both share the same (mildly odd) `years`-spans-calendar-while-equity-compounds-over-active-days convention. |
| 10.4 | `PORTFOLIO_SPECS`, `BACKTEST_COST_PER_REBALANCE=0.001`, `combineConservativeN`, `combineAggressiveN`, `macro_inverted`, `forwardFillDaily` | `update.js:662-693,772-810` | `backtest.ts:20,31-59,144-178` | **PROVEN-IDENTICAL** | Byte-equal after whitespace normalisation. |
| 10.5 | **Published** backtest values | frozen-history input | fresh-recompute input | **PROVEN-DIFFERENT** | **`eth.composite.final_value` 13.7333 → 12.6339 (−8.01%)**, transitions 56→58, sharpe 0.847→0.830. `mixed.composite` −5.24%. `eth.conservative` −1.84%, `eth.aggressive` +0.97%, `mixed.conservative` −1.82%, `mixed.aggressive` +1.37%. |
| 10.6 | `factor` backtest strategy | present for all 3 portfolios in the eq snapshot, 11 metrics each | **absent** | **PROVEN-DIFFERENT** | v0's `eth.factor` = `{final_value 12.6945, cagr 0.3679, sharpe 0.8472, max_drawdown −0.7193, transitions 64, …}`. **User-visible:** `frontend/public/assets/js/app/alpine/views/shared.js:80,97,113` declares an "Equity factor bucket" strategy row for **all three** backtest tables that the v1 backend never computes. |
| 10.7 | `backtest-equity.csv` — full daily equity, all portfolios × strategies | `update.js:459,927-940` | **none** — `_daily` stripped at `index.ts:241` and discarded | **PROVEN-DIFFERENT** | Only month-end `equity_curve` survives; daily drawdown/equity analysis available in v0 cannot be reproduced. (Note: the file is not committed in v0 either, and not in v0's cron commit list — it is ephemeral on both sides.) |
| 10.8 | `monthlySparkline` | `update.js:494-518` | `index.ts:501-521` | **PROVEN-IDENTICAL** | |

### Stage 11 — Derived research signals

| # | Step | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 11.1 | `channel-divergence` series: `btc_price`, `qqq_price`, `btc_beta_vs_risk_appetite` (90d OLS), `btc_qqq_ratio_percentile` (756d midrank), `stables_vs_qqq_flow` | `channel-divergence.js:116-121,135-158` | `analyze/research-signals.ts:36-53,185-190` | **PROVEN-IDENTICAL** | Executed by loading v0's real source and running side by side: **3,072/3,072 points equal on all 5 series**; `spec` object byte-identical. Independently corroborated by the one genuine v0 fixture (`channel-divergence.json.gz`, PR #9, never regenerated). |
| 11.2 | `channel` summary "latest" semantics | `arr[dates.length-1]` (`channel-divergence.js:181,187`) | `lastFinite(arr)` (`research-signals.ts:147`) | **PROVEN-DIFFERENT-DORMANT** | Unreachable under forward-filled dense axes. Arms if the axis extends past the last observation without forward-fill, or if `qqq === 0` on the final day. v1's behaviour is more defensible; it is nonetheless not v0's. |
| 11.3 | `channel` **gauges** and the `CHANNEL` composite | *(none — v0 published no gauges)* | `research-signals.ts:120,149-161` | **PROVEN-DIFFERENT** | **The mixed-percentile-definition defect.** `BTC_BETA` and `STABLES_QQQ_FLOW` use `percentileInWindow` — **full-history**, `count(x ≤ v)/n`, no minimum obs, no tie-splitting. `BTC_QQQ_RATIO` uses `rollingPercentileRank` — **trailing 756-day**, 30-obs gated, midrank. **The `CHANNEL` composite averages all three**, blending a look-ahead-contaminated full-sample statistic with a point-in-time rolling rank. Executed: for value 3 in `[1,2,3,4]` the two definitions give **0.75 vs 0.625**. The `read` thresholds (≥0.6 / ≤0.35) then bucket that blend with **no hysteresis**, unlike the regime classifier's 5-day confirmation + 2σ fast-track. **This is the number the v1 research page actually shows.** |
| 11.4 | `late-cycle` series (12): `spy_price`, `concentration_cap_vs_equal(_pct)`, `concentration_top7_vs_spy(_pct)`, `mna_s4_monthly`, `mna_pct`, `margin_debt_level/_yoy/_yoy_pct`, `consumer_conf_level/_pct` | `late-cycle-signals.js:150-162,184-213` | `research-signals.ts:58-84,272-284` | **PROVEN-IDENTICAL** | Executed: **858/858** equal on the daily series, 196/196 on M&A, 66/66 on margin debt, 197/197 on confidence — including both deliberately late-listing TOP7 members. Corroborated by the genuine v0 fixture (`late-cycle-signals.json.gz`, PR #9). |
| 11.5 | `late-cycle` `summary` shape | `{date, value}` with `value` 6-dp rounded (`:284-289`) | `{latest}`, unrounded, **no date** (`research-signals.ts:286-292`) | **PROVEN-DIFFERENT** | Numeric content equal (e.g. `0.149471` vs `0.14947089947089948`). A consumer typed against v0 renders `—` for all five gauges. **Cosmetic today only because v1's own views read `gauges[]` exclusively — the entire `indicators` map and `summary` block v1 computes are dead payload.** |
| 11.6 | `late-cycle` **gauges** | *(none)* | `research-signals.ts:211,245-249` | **PROVEN-DIFFERENT** | v1-only surface. These ones are safe — each `percentile` is `lastFinite(<the v0 756-day pct series>)`, numerically the v0 `summary.*.value`. Thresholds (≥0.7 / ≥0.5) have no v0 analogue and no hysteresis. |
| 11.7 | `regime-eq-comparison.js` — base-vs-eq composites, per-panel walk-forward indices, daily label series for both arms, `time_share` (5 series), `agreement` incl. `diff_by_year`, 3 portfolios × 6 strategies with phase-level CAGR/drawdown | `scripts/regime/regime-eq-comparison.js` | **NO v1 IMPLEMENTATION** | **PROVEN-DIFFERENT** | v1 ships `frontend/public/data/regime-eq-comparison.json` **byte-identical** to v0's (695,058 B), frozen at `asof 2026-05-30`. **This is transport fidelity, not computational parity** — it scores 216/216 exact in the harness *because it is a copy*. Nothing in `scripts/`, `backend/`, `package.json` or `.github/` regenerates it. **v1 cannot compute it for any period.** Uses a **constant 2.6%/yr cash model** that has no v1 code path. |
| 11.8 | `weighting-comparison.js` — `static_invcorr` / `equal_1n` / `walk_forward`, per-indicator `panel_weights`, 2 portfolios × 4 strategies with phase-level metrics | `scripts/regime/weighting-comparison.js` | **NO v1 IMPLEMENTATION** | **PROVEN-DIFFERENT** | Same: byte-identical copy (282,710 B), frozen at `asof 2026-05-14`, 260/260 "exact" **because it is a copy**. Repo-wide grep for `walk_forward\|equal_1n\|static_invcorr`: **zero hits**. |
| 11.9 | Dead synthetic research tools sharing the v0 filenames | *(none)* | `analyze/channel-divergence.ts`, `analyze/late-cycle.ts` | **PROVEN-DIFFERENT-DORMANT** | Implement the same two signals from the **seeded random walk** (`access/provider.ts:24-46`) over 210/260-day windows, no STABLES leg, no TOP7 basket, no real margin/confidence sources, `SPY`-return fallback of `0`. Registered in no `Registry`; the only test asserts shape. **They share filenames with the v0 scripts they do not implement** — a maintainer wiring "the channel-divergence tool" into the registry ships synthetic numbers to production. |

### Stage 12 — Persistence / store

| # | Step | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 12.1 | Published-history row write | append-only CSV, past rows immutable | `regime_snapshots` upsert-all (`store/regime-store.ts:53`) | **PROVEN-DIFFERENT** | See 8.2. Schema `backend/migrations/0009_analytics_v2.sql:16-23`. |
| 12.2 | Research-signal container | two `public/data/*.json` files, cron-committed (history immutable in git) | `research_signals` table via `saveResearchSignal` (`index.ts:311`) → `persistResearchSignal`, which upserts `ON CONFLICT (signal_key, date) DO UPDATE SET payload = EXCLUDED.payload` (`store/research-store.ts:19-21`) | **PROVEN-DIFFERENT** | v1 emits **no** `channel-divergence.json` / `late-cycle-signals.json` artifact at all — and **the research surface has the same rewrite-on-every-run semantics as `regime_snapshots` (D3, 6.15)**: a re-run for the same `(signal_key, date)` silently replaces the stored payload. |
| 12.3 | Provenance / telemetry columns | none | `source` (`index.ts:444`), `forward_fill_age_days`, `forward_fill_expired` (`index.ts:492-493`) | **PROVEN-DIFFERENT** | Additive, non-numeric. An improvement; recorded for completeness. |

### Stage 13 — API / serving

| # | Step | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 13.1 | Regime/research delivery model | static files under `public/data/` served by Next | Postgres-backed `GET /api/dashboards/regime-snapshots` (`api/index.ts:78-80` → `report/projections.ts:39`), `/research-signals/:key` (`api/index.ts:205-209` → `projections.ts:12`) | **UNTESTABLE-DATA-ACCESS** | Requires a running v1 stack + seeded DB. Not compared. Note two structural risks recorded but not measured: `POST /api/swarm/regime` (`api/routes/swarm.ts:230-234`) is a **second door onto `saveRegimeSnapshots` that is not wrapped in `sql.begin`**, unlike its `/api/analytics` twin (`api/routes/analytics.ts:385`); and `report/projections.ts:45` applies a read-side `WHERE date <= today` boundary v0 had no analogue for. |
| 13.2 | `GET /api/dashboards/vault-economics` | `public/data/hourly-vault-tvl.csv`, `vault-apy.json` | DB-backed route | **UNTESTABLE-DATA-ACCESS** | No file-to-file comparison exists. |
| 13.3 | `GET /api/dashboards/wallet-balances` | `public/data/hourly-wallet-balances.csv` | DB-backed route | **UNTESTABLE-DATA-ACCESS** | Same. |
| 13.4 | `report/` DTO mappers (`regime-eq-map.ts`, `regime-projection.ts`, `projections.ts`) | v0 rendered from JSON directly | row → DTO | **UNVERIFIED** | Read far enough to confirm they are mappers, not recomputations. Not executed. |
| 13.5 | `goldens/api-goldens.json` as a parity baseline | — | `"source": "capture:http://127.0.0.1:48787"` | **PROVEN-DIFFERENT** | **Structurally incapable of being a v0 baseline** — self-captured from v1's own dev server, values explicitly point-in-time, history clamped to 180 days (2026-01-14 → 2026-07-12, entirely past v0's data). Measured anyway to close the loop: **163 shared dates, 163/163 differing, max abs 0.2106 @ 2026-05-12.** |
| 13.6 | **Swarm regime-summary re-derivation on the serving path** | `generate-brief.js` / `generate-session.js` read v0's snapshot values directly | `swarm/domain.ts:1184-1244` `buildRegimeSummary` | **PROVEN-DIFFERENT** | **The serving layer invents numbers when a column is NULL.** See D15. No prod gate. |
| 13.7 | `computeRegimeSnapshotStaleness` — the only arithmetic in `report/` | *(no v0 analogue — v0 had no staleness concept)* | `report/regime-projection.ts:145-158,172-188,198-207,215-222`; threshold `REGIME_STALE_THRESHOLD_DAYS = 3` at `:122` | **PROVEN-DIFFERENT** | v1-only. Needed because `index.ts:208` builds the axis as `buildDateAxis(BACKFILL_START, asof)` — **the pipeline forward-fills the axis to `asof` on every run whether or not any upstream refreshed**, so `regime_snapshots.date` cannot indicate freshness. An improvement over v0, which had no staleness signal at all; recorded because it is a number v0 never published. Everything else in `report/` (`projections.ts`, `regime-eq-map.ts`, `rowToSnapshot`) is verified pure rename + null-coercion + ordering, with no value arithmetic. |

### Stage 14 — Rendered views

| # | Step | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 14.1 | Frontend re-derivation of conservative/aggressive regime bands | `src/.../RegimeBandsCharts.tsx` | `frontend/public/assets/js/app/alpine/views/blog-charts.js:306-318` | **UNVERIFIED** | v1 re-implements `combineConservative`/`combineAggressive` in the browser. The rule matches `backtest.ts:144-158` **on read**, but nothing tests the browser copy against the backend, and it is a fourth copy of the same semantics. |
| 14.2 | Backtest strategy table rows | 8 strategies (2-panel) / 9 (eq, incl. `factor`) | `frontend/public/assets/js/app/alpine/views/shared.js:75-121` declares **9 rows incl. `factor`** for all three portfolios | **PROVEN-DIFFERENT** | **The frontend renders a strategy the backend never computes** (10.6). This is the concrete user-visible consequence A2 could not determine. |
| 14.3 | Research page payload consumption | v0 pages read `summary.*.value` / `.date` | v1 views read `gauges[]` only | **PROVEN-DIFFERENT** | v1's `indicators` map and `summary` block are computed and persisted but **never rendered** — dead payload. Conversely a v0-typed consumer gets `—` for all five late-cycle gauges. |
| 14.4 | Regime page rendering | v0 Next pages | `frontend/public/assets/js/app/alpine/views/regime.js:43` (`api.get(regimeSnapshots, {range: 4000})`) | **UNVERIFIED** | Not compared end to end. |
| 14.5 | `/research/late-cycle-signals` page wiring | v0 page read `summary.*.value`/`.date` | `frontend/public/views/research/late-cycle-signals.html` — **no `x-data` hook at all** | **PROVEN-DIFFERENT** | Verified: `channel-divergence.html:11` carries `x-data="researchView('channel-divergence')" x-init="load()"`; **`late-cycle-signals.html` carries none.** The backend computes and persists the late-cycle signal to `research_signals` on every run (`index.ts:330-342`) and **the page never fetches it.** The entire late-cycle signal is dead payload end to end — a stronger result than A3's F2, which found only `summary`/`indicators` unrendered. |
| 14.6 | Client-side numeric derivations | v0 rendered server-side | `shared.js:48-52` `alignToDates` **forward-fills** a sparse series onto a dense axis; `regime.js:170-175` `corrSampleMeta` derives a trailing-window label from correlation `n` (`n/252` years, `Math.round(n/21)` months); `regime.js:56-63` **infers the panel set** when `latest.panels` is NULL; `regime.js:143-144` re-derives a risk-on/off verdict from `last >= 0.5`; `static-views.js:1550-1563` **coerces a null composite to 0** in sparkline geometry | **UNVERIFIED** | Five independent numeric derivations in the browser, none tested against the backend. Two are hazardous: the panel-set inference papers over 8.6 (`panels` written but `bucket_thresholds`/`extras` NULL), and the null→0 sparkline coercion **renders a missing composite as a genuine 0.0 reading**. |

### Stage 15 — Adjacent in-scope numeric surfaces (per `docs/architecture.md:14-47`)

These are in v1's declared scope and carry numbers, but **no v0 baseline artifact was ever vendored for any of them**, and several of v0's own outputs are point-in-time live-chain reads that cannot be replayed. Classes are assigned from C1's coverage map.

| # | Family | v0 | v1 | Class | Note |
|---|---|---|---|---|---|
| 15.1 | GeckoTerminal token prices | `scripts/hourly-prices.js` | `chain/token-prices.ts:154,235,262` | UNVERIFIED | |
| 15.2 | `ZYFAI-SS1` / `GIZA-SS1` strategy NAV | `hourly-prices.js:104` | `chain/wallet-valuation.ts:337` | UNVERIFIED | |
| 15.3 | **`SP500` price source** | Hyperliquid perp `accountValue/\|size\|` (`scripts/lib/hyperliquid.js:148`) | **Yahoo `^GSPC`** (`chain/token-prices.ts:252`) | **PROVEN-DIFFERENT** *(by construction; magnitude unmeasured)* | **Different quantities.** v0 derived a synthetic price from a perpetual's account value; v1 reads an index level. Grep for `hyperliquid` in v1: **zero hits**. **No decision record found.** Any `/allocation` figure touching the SP500 leg is guaranteed non-parity. |
| 15.4 | `prices.csv` hourly price history | `public/data/prices.csv` | `prices` table exists, **dead** — no reader, no writer (`migrations/0002_dashboards.sql:34`) | **PROVEN-DIFFERENT** | Silent gap. Price history survives only denormalised in `wallet_balance_samples.price_usd`, at daily grain. |
| 15.5 | `hourly-wallet-balances.csv` | hourly rows | `wallet_balance_samples`, **daily** rows (`worker/handlers/wallet.ts:32` keys on `(sample_date, symbol)`) | **PROVEN-DIFFERENT** *(grain; magnitude unmeasured)* | Silent 24× grain loss. |
| 15.6 | `unified-wallet-history.csv` | `total_aum`, per-asset | `WalletHistoryPoint` (`chain/wallet-balances.ts:50`) | UNVERIFIED | |
| 15.7 | Vault TVL / share price / idle | `scripts/hourly-vault-tvl.js:114` | `chain/vault-economics.ts:26,42,76-81` | UNTESTABLE-DATA-ACCESS | Live Base RPC reads. **No fidelity fixture and no v0 cross-check exists at all**; `vault-economics.test.ts` tests v1 against v1. |
| 15.8 | Adapter TVL (MORPHO/AAVE/COMPOUND) | same script | `chain/vault-economics.ts:86` | UNTESTABLE-DATA-ACCESS | Same. |
| 15.9 | 7-day APY `(1+growth)^(365/days)−1` | `scripts/daily-vault-apy.js:59` | `chain/vault-economics.ts:127` | UNVERIFIED | Formula-identical by inspection; never cross-checked. |
| 15.10 | Buybacks | Basescan `tokentx` | Base RPC `eth_getLogs` (`chain/buyback-logs.ts:87,174,206`) | **PROVEN-DIFFERENT** | v0's `valueUsd` was a hardcoded `0` placeholder (`scripts/update-wallet-history.js:223`). **v1 is more correct here** — but it is not v0. |
| 15.11 | Tokenomics fee split 57/40/3 | hardcoded (`src/app/tokenomics/page.tsx:172`) | derived from Clanker pool config (`chain/token-metrics.ts:44,62,112`) | **PROVEN-DIFFERENT** | Hardcoded → derived. Improvement; not parity. |
| 15.12 | `subject-balances.csv` per-wallet/per-asset | `scripts/committee/hourly-subject-balances.js` | `swarm/domain.ts:932` | UNTESTABLE-DATA-ACCESS | Live-chain reads, not replayable. |
| 15.13 | Daily subject snapshots | `daily-subject-snapshots.js:32` | `swarm/domain.ts:121`, `swarm/projections.ts:187` | UNTESTABLE-DATA-ACCESS | Same. |
| 15.14 | **≥50% concentration `notable` flag** | `daily-subject-snapshots.js:78` | **none** | **PROVEN-DIFFERENT** | Subject page shows a donut but never the flag. Grep for a `>= 0.5` share threshold in v1 backend + frontend: no hits. |
| 15.15 | **Swarm brief regime block** | full block, `generate-brief.js:73` | **1 row** (`swarm/domain.ts:1047-1049`) | **PROVEN-DIFFERENT** | |
| 15.16 | **Brief `regime_history` — trailing 8 rows** | `generate-brief.js:135` | **absent from the brief** | **PROVEN-DIFFERENT** | **Member agents receive strictly less context than v0's, which changes their takes and therefore every downstream aggregate.** No test covers brief content parity. |
| 15.17 | Brief `allocation` bucket `target_weight`s | in the brief | moved to `GET /api/dashboards/allocation` | **PROVEN-DIFFERENT** | Relocated, not lost. |
| 15.18 | Session `regime_summary` (+8-point history) | `generate-session.js` | `swarm/domain.ts:1184` | UNVERIFIED | |
| 15.19 | Member `confidence`, stance aggregation, quorum | `generate-session.js:355` | `swarm/domain.ts:~1380-1490` | UNVERIFIED | |
| 15.20 | `bucket_weights` (sums to 1.0 ±0.01) | `generate-session.js:433` | `meanTakeWeights` / `normalizedTakeWeights` | UNVERIFIED | |
| 15.21 | `within_bucket_weights` | present | frontend **reads** it; **no backend producer located** | UNVERIFIED | Suspected gap. Needs a runtime check against a real published session. |
| 15.22 | **Actual-vs-target bucket drift (pp)** | `charts.tsx:100,112-181,489-570` | **none** — frontend emits `target:null, actual:null` (`static-views.js:1473-1493`) | **PROVEN-DIFFERENT** | Drift chart silently degrades to "Recommended-only" without surfacing that two series are missing. |
| 15.23 | Projects table (market cap, FDV, 24h %, sparkline, wallet balance) | Supabase | `projects/projections.ts:225-290` | **VERIFIED (R11)** | Live-baseline audit against v0's Supabase: [R11](audits/v0-v1-parity/R11-projects-supabase-audit.md). |
| 15.24 | MC/FDV % | server | derived client-side (`views/projects.js:14`) | **VERIFIED (R11)** | See [R11 §2](audits/v0-v1-parity/R11-projects-supabase-audit.md). |
| 15.25 | `data_coverage_score` | Supabase `compute_project_coverage()` | `projects/transforms.ts:188,226` | **VERIFIED (R11)** | [R11 §3](audits/v0-v1-parity/R11-projects-supabase-audit.md): formula PROVEN-IDENTICAL across all 995 live rows; the `MIN_SCORE` 55-vs-45 directory floor is a separate, quantified divergence. |
| 15.26 | Revenue 30d on the projects table | present | removed from the DTO; relocated to `/agents` + leaderboard | **PROVEN-DIFFERENT** | Intentional (issue #346). |
| 15.27 | Dashboard overview (entity counts, vault TVL + 7d sparkline, total AUM) | v0 pages | `projects/entities-projections.ts:282,337-352` | UNVERIFIED | |
| 15.28 | x402 score / txns / volume / buyers / resources; productivity score | v0 | `projects/access/data-source.ts:19-23` | **PROVEN-DIFFERENT (R11)** | [R11 §5](audits/v0-v1-parity/R11-projects-supabase-audit.md): `x402_buyers` is real live v0 data with no v1 column at all. |
| 15.29 | Scoring-weight methodology 40/30/30 | `analytics/src/pages/Methodology.tsx:10-12,70` | `/methodology` page | UNVERIFIED | Hardcoded on both sides. |

---

## 4. Results / report inventory

Every artifact v0 produces, its v1 counterpart, the ranges, the intersection, whether the v1 side is a **valid v0 baseline**, and the measured diff. Re-measured this session with `scripts/audits/v0-v1-report-diff.ts`.

| v0 artifact | v1 counterpart | v0 range | v1 range | Intersection | Provenance valid as a v0 baseline? | Measured diff |
|---|---|---|---|---|---|---|
| `data/regime/raw-indicator-history.csv` | `fixtures/regime/raw-indicator-history.csv.gz` | 2018-01-01 → 2026-06-25 (3,098 d) | → 2026-06-29 (3,102 d) | 3,098 d | **YES** — input floor, v0 rows are a strict subset | **11,164 / 72,385 cells differ (15.4%)**; 7 series exact; 11 cells >5e-3, all 2026-06-22…25 |
| `data/regime/regime-history.csv` | `fixtures/regime/regime-history.csv.gz` | 2018-05-15 → 2026-06-25 (2,960) | → 2026-06-29 (2,968) | 2,960 | **NO — regenerated from v1's pipeline (#444, `6985188`); not flagged by #447, not restored by #464** | 8 of 10 fields FAIL |
| `data/regime/regime-versions.json` | `regime-versions.json` | n/a | n/a | 1 | **YES** — byte-identical | 46/46 EXACT |
| `public/data/regime-snapshot.json` | `fixtures/regime/regime-snapshot.json.gz` | 2018-01-31 → 2026-06-25 | → 2026-06-29 | 2,987 | **NO — regenerated (#444); not flagged by #447, not restored by #464.** `history[]` alone is v0-preserved | 273 of 418 fields FAIL |
| `public/data/regime-eq-snapshot.json` | `fixtures/regime/regime-eq-snapshot.json.gz` | 2018-01-31 → 2026-06-25 | same | 2,995 | **YES — byte-identical (sha256), untouched since `91b9fbc`** | **484/484 EXACT** — *transport fidelity* |
| `public/data/channel-divergence.json` | `fixtures/regime/channel-divergence.json.gz` | 2018-01-01 → 2026-06-25 | → 2026-06-29 | 3,099 | **YES** — untouched since `df5ee09`, genuine v0 cron artifact | 11/21 exact; `btc_beta` differs on 2,975/3,098 at ~1e-4; `qqq_price` at ≤5.93e-7 rel |
| `public/data/late-cycle-signals.json` | `fixtures/regime/late-cycle-signals.json.gz` | 2010-01-01 → 2026-06-30 | same | 1,199 | **YES** — untouched since `df5ee09` | 33/48 EXACT; **0 differing values in every year 2010–2025**; divergence confined to 2026 |
| `public/data/regime-eq-comparison.json` | `frontend/public/data/regime-eq-comparison.json` (695,058 B) | 2018-01-01 → 2026-05-30 | same | 3,078 | **YES — but it is a static copy** | 216/216 EXACT — **transport fidelity, not computational parity.** No v1 generator exists. |
| `public/data/weighting-comparison.json` | `frontend/public/data/weighting-comparison.json` | 2018-02-28 → 2026-05-14 | same | 106 | **YES — but it is a static copy** | 260/260 EXACT — **transport fidelity.** No v1 generator exists. |
| *(derived)* `regime-history.csv` | `fixtures/regime/regime-compute-reference.json.gz` | 2018-05-15 → 2026-06-25 | 2018-01-01 → 2026-06-29 | 2,960 | **NO** — `meta.source` = "in-repo regeneration" | **THE HEADLINE.** See below. |
| *(derived)* `regime-snapshot.json` → backtest+correlations | `fixtures/regime/regime-backtest-correlations-reference.json.gz` | — | — | 102 | **NO** — `meta.source` = "in-repo regeneration" | 218 of 336 fields FAIL |
| — | `goldens/api-goldens.json` | — | 2026-01-14 → 2026-07-12 | — | **NO** — `"source": "capture:http://127.0.0.1:48787"` | 163/163 shared dates differ, max abs 0.2106 |
| `public/data/prices.csv` | **NONE** | — | — | — | — | Unmapped; `prices` table dead |
| `public/data/vault-apy.json` | **NONE** (DB route) | — | — | — | — | Unmapped as a file |
| `public/data/hourly-vault-tvl.csv` | **NONE** (DB route) | — | — | — | — | Unmapped as a file |
| `public/data/hourly-wallet-balances.csv` | **NONE** (DB route) | — | — | — | — | Unmapped as a file; hourly → daily grain |
| `public/data/unified-wallet-history.csv` | **NONE** | — | — | — | — | Unmapped |
| `public/data/subject-balances.csv` | **NONE** (DB) | — | — | — | — | Unmapped |
| `data/regime/backtest-equity.csv` | **NONE** | — | — | — | — | Not produced by v1; not committed by v0 either |
| *(none — v1-only)* | `frontend/public/data/regime-conservative-aggressive.json` (444,997 B) | — | — | — | **UNVERIFIED provenance** | A fourth static blog-chart fixture with **no v0 counterpart file and no v1 generator**. Feeds `blog-charts.js` band rendering (14.1). Its lineage was not established by any audit. |

`frontend/public/data/` holds exactly four top-level analytics files (~1.4 MB): the two frozen comparison reports (D5), `regime-conservative-aggressive.json` above, and `treasury-allocation.json` (25,714 B). **There is no `regime-snapshot.json`** — production's rolling file was deliberately not vendored (`blog-charts.js:14-20`).

### The headline pair, in full

`regime-compute-reference.json.gz` is the only v1 artifact carrying a full-history recomputation from v1's own pipeline. Diffing it against v0's committed `regime-history.csv` is the true "does v1 reproduce v0 for every period" test. v0's CSV stores 6 decimals, so **≤5e-7 is quantisation, not divergence**.

| Series | n | ≤5e-7 | >1e-1 | max abs | mean abs |
|---|---:|---:|---:|---:|---:|
| `macro_index` | 2,960 | **98.99%** | 0.03% | 0.1064 @ 2026-06-06 | 2.24e-4 |
| `macro_percentile` | 2,960 | **99.09%** | 0.14% | 0.1680 @ 2026-06-06 | 4.00e-4 |
| `composite` | 2,960 | **0.00%** | 0.00% | **0.0768** @ 2026-06-13 | 1.01e-2 |
| `onchain_index` | 2,960 | **0.00%** | 0.44% | **0.1238** @ 2018-06-01 | 2.00e-2 |
| `composite_percentile` | 2,960 | 7.84% | 4.56% | **0.3404** @ 2018-06-01 | 2.83e-2 |
| `onchain_percentile` | 2,960 | 4.56% | **10.95%** | **0.3404** @ 2018-06-01 | 4.17e-2 |

| Label | Mismatched days |
|---|---|
| `macro_regime` | **0 / 2,960 (0.00%)** |
| `onchain_regime` | **289 / 2,960 (9.76%)** |
| `regime` (headline) | **153 / 2,960 (5.17%)** |

Share of dates exceeding 1e-3, by year — **the divergence is uniform across the whole history, not a recent-data artifact:**

| Series | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `macro_index` | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 13.4% |
| `composite` | 97.4% | 94.5% | 91.8% | 89.9% | 99.7% | 88.8% | 92.9% | 94.2% | 84.9% |
| `onchain_index` | 98.3% | 97.8% | 95.6% | 96.4% | 99.7% | 93.4% | 97.3% | 95.9% | 93.6% |
| `composite_percentile` | 81.0% | 94.5% | 95.9% | 60.3% | 91.5% | 91.0% | 99.2% | 88.8% | 100.0% |

Regime-label flips by year: 2018 11/231 · 2019 12/365 · 2020 22/366 · 2021 3/365 · 2022 31/365 · 2023 0/365 · 2024 41/366 · 2025 22/365 · 2026 11/172.

**Read the whole table together with the provenance column: every pair that scores 0 FAIL is a pair where v1 vendors v0's bytes. Every pair where v1 *computes* the number scores heavy FAIL.**

---

## 5. Flagged differences, ranked by user-visible impact

### D1 — `BTC_MVRV` admission rewrites 5.17% of published regime history — **BLOCKS PARITY**

| | |
|---|---|
| **What differs** | v0's floor has **0** rows for `BTC_MVRV`; v1's has **3,102**. In v0 it is an all-NaN series excluded by `minValidObs`, weight 0. In v1 it is a full-weight member of the 10-indicator onchain panel at weight **0.09316**, which re-normalises every other onchain weight. |
| **By how much** | **153 / 2,960 published regime labels (5.17%)**; `onchain_regime` 289/2,960 (9.76%); composite differs on 100% of days, max 0.0768; `onchain_index` max 0.1238; percentiles max 0.3404. Onchain weights move materially: `ETH_TREND` 0.15726→0.12810, `DEFI_GROWTH` 0.14396→0.10967. Macro weights move only in the 4th decimal. |
| **Over what period** | **2018-05-15 → 2026-06-25 — the entire published history.** Every year affected. |
| **Root cause** | v0's `blockchain_com`/`mvrv` chart was removed upstream; `fetch_all.js:68-72` swallows the failure. v1 repointed to `coinmetrics`/`{btc, CapMVRVCur}` (`analyze/indicators.ts`) — **a different metric from a different provider** — and regenerated the floor for it (`extract/floor-seed-generator.ts:72-88`). |
| **Intentional?** | **Yes** (issues #400 → #444). But I found **no record that anyone accepted a 5.17% rewrite of published regime history as the cost**, and it was never quantified before this audit. |
| **Owner must decide** | Accept the rewrite and republish history with a version bump and a public note, **or** exclude `BTC_MVRV` to preserve continuity with what customers have already seen. |

### D2 — Frozen-vintage publication vs full recompute — **BLOCKS PARITY**

| | |
|---|---|
| **What differs** | v0 publishes a **mosaic of original vintages**: `mergeFrozenIntoResult` (`update.js:308`, called `:131`) overwrites every freshly computed historical day with the value locked when that day was first computed, leaving only today mutable. v1 has no analogue and republishes a **full fresh recompute** every run (`analyze/regime-versions.ts:5-7`, `index.ts:261`). |
| **By how much** | v0-published vs a fresh v0 recompute: **9 / 2,960 labels**, max \|Δcomposite\| **0.0725**, max \|Δcomposite_percentile\| **0.2493**, 2,552/2,960 rows exceed write precision. Downstream, on identical extras: **`eth.composite.final_value` −8.01%** (13.7333 → 12.6339), transitions 56→58; `mixed.composite` −5.24%. |
| **Root cause** | Because `compute.js:128-136` assigns the **same array references** into `panelIndices`/`panelRegimes`, the frozen merge simultaneously mutates the arrays that `computeCorrelations` (`update.js:539-540`) and `computeBacktest` (`update.js:710-711`) read — and the merge happens at `update.js:131`, *before* `writeSnapshot` at `:145`. So v0's shipped backtest is computed over frozen labels. |
| **Intentional?** | **Ambiguous, and this matters.** `data/regime/regime-versions.json` declares v3 as *"the frozen-baseline lockout is removed; every cron run rewrites regime-history.csv"* — which is what v1 implements. But `update.js` does not do that: `isHistoryAtVersion` (`:235-244`) returns true once the CSV carries the current tag (all 2,960 rows are tagged `v3`), so the frozen branch is taken on **every** run. **v1 matches v0's stated intent but not v0's shipped output.** For an audit asking "is v1 identical to v0", the shipped output is the answer. |
| **Owner must decide** | Which is the product: immutable published history (v0's behaviour) or best-available-data history (v0's documentation and v1's behaviour)? |

### D3 — v1 is not reproducible against itself — **BLOCKS PARITY**

`store/regime-store.ts:53` upserts **every** historical row on **every** run (`ON CONFLICT (date) DO UPDATE SET` across all 23 columns), where v0's past rows are immutable (`update.js:330-368`). Any raw-data revision or backfill silently changes a **published historical composite and regime label between two v1 runs, with no version bump and no audit trail**. This is strictly worse than a v0↔v1 gap: it means v1 has no stable published history at all. Combined with D2's measured magnitudes (max \|Δcomposite\| 0.0725 from a single vintage shift), the exposure is material.

**Scope correction, so this is not overstated:** `store/raw-history-store.ts:69` *also* upserts (`ON CONFLICT (date, indicator) DO UPDATE SET value = EXCLUDED.value`), but this **matches v0**, whose own `update.js:135-137` comment states the raw CSV is *"still regenerated each run — that file is 'what the indicator data looked like at cron time', not a permanent record."* **The raw floor is mutable on both sides. Only the published `regime_snapshots` history is a v0↔v1 divergence.** Note also that the floor seed path is correctly gap-fill-only and never overwrites (`store/floor-seed.ts:30-42`).

**Reclassified in revision — this is now the binding precondition, not merely a ranked finding.** v0 is reconstructible at **any** point in time via git: 3,077 commits, sub-daily cadence, floor and outputs committed atomically. **v1 is reconstructible at no point in time.** Because published history is rewritten on every run, *"v1 as of datetime T"* is not a well-defined quantity — it depends on when you asked, not on T. **Parameterized auditing over arbitrary `(sha, datetime)` is therefore impossible against v1 until published history is immutable and the floor is addressable by vintage.** Every other remediation in §8 is downstream of this; it is Phase 0a, and nothing below it can be trusted as a time-addressed result until it lands.

**Extended in a later revision: the research surface has the identical defect.** `store/research-store.ts:19-21` (`persistResearchSignal`) upserts `ON CONFLICT (signal_key, date) DO UPDATE SET payload = EXCLUDED.payload` — so *"v1's research signals as of T"* is equally undefined, and **Phase 0a's immutability precondition covers `research_signals` as well as `regime_snapshots`** (12.2, 6.15). The contrast with v0 is sharper here than for the regime core: v0's research artifacts are cron-committed JSON, so their full vintage history already sits in git.

**Owner must decide:** adopt a lockout/versioning mechanism before cutover, or accept that any historical number can change without notice — and accept, as a direct consequence, that v1 can never be audited as-of a date.

### D4 — The `factor` strategy and `factor` correlation index do not exist in v1

v0 ships a full 3-panel eq snapshot with a `factor` backtest strategy for all three portfolios (e.g. `eth.factor` = `final_value 12.6945, cagr 0.3679, sharpe 0.8472, max_drawdown −0.7193, transitions 64`) and `forward.factor`/`concurrent.factor` correlation cells. v1 computes backtest and correlations from `r2` (2-panel) **only** (`index.ts:240-241`) while the persisted row advertises `panels:["macro","onchain","factor"]` (`index.ts:450`) — **the row is internally inconsistent**. **User-visible consequence, verified this session:** `frontend/public/assets/js/app/alpine/views/shared.js:80,97,113` declares an "Equity factor bucket" strategy row on **all three** backtest tables that the backend never produces. **Owner must decide:** compute the 3-panel backtest/correlations, or remove the `factor` row and the `factor` panel claim.

### D5 — Two derived research reports have no v1 implementation at all

`regime-eq-comparison.json` (`time_share`, `agreement` incl. `diff_by_year`, base-vs-eq composite histories, per-panel walk-forward indices, 3 portfolios × 6 strategies with phase-level CAGR/drawdown) and `weighting-comparison.json` (`static_invcorr` / `equal_1n` / `walk_forward`, per-indicator `panel_weights`, 2 portfolios × 4 strategies). **v1 ships both as byte-identical frozen copies** — `asof 2026-05-30` and `2026-05-14` — and **no code in v1 can regenerate either for any period.** Repo-wide grep for `walk_forward\|equal_1n\|static_invcorr`: zero hits. They score 216/216 and 260/260 "exact" in the harness **only because they are copies — transport fidelity, not computational parity.** They are served to `/blog/regime-eq-vs-base` and `/blog/honest-backtesting-weights` and will silently age with **no staleness signal** (unlike regime snapshots, which carry `computeRegimeSnapshotStaleness`). Both scripts use a **constant 2.6%/yr cash model** with no v1 code path, so a "clean" port using v1's real-DTB3 backtest would produce different absolute multiples. Classified NOT-PORTED-**GAP**, not intentional, because no canonical doc drops them.

### D6 — The DefiLlama native-units-as-USD bug

`extract/defillama.ts:22` falls back to `row.totalCirculating?.peggedUSD` — the **native-unit** aggregate — where v0 (`fetchers/defillama.js:30`) falls back to the `totalCirculatingUSD` **object**, which coerces to `NaN` and drops the row. v0 fails **loudly** (a visible gap); v1 would **silently ingest native units as USD** into `STABLES`/`STABLES_GROWTH`, both onchain-panel indicators. Same branch on today's payload; **arms on any DefiLlama schema change.** This is a latent data-corruption defect, not merely a parity gap.

### D7 — The self-contradicting regime-snapshot fixture

`backend/tests/fixtures/regime/regime-snapshot.json.gz` disagrees with **itself** on the same date. Verified this session:

| Same file, `2026-06-29` | Value |
|---|---|
| top-level `regime` (recomputed, BTC_MVRV-inclusive) | `risk_off` |
| `history[-1].regime` (preserved, pre-BTC_MVRV) | **`neutral`** |
| top-level `composite` | 0.4494875723085398 |
| `history[-1].composite` | 0.4541570691590452 (Δ 4.67e-3) |
| top-level `onchain_index` | 0.31467908906224884 |
| `history[-1].onchain` | 0.3240180827632596 (Δ 9.34e-3) |

Cause: `backend/scripts/regime-goldens-regenerate.ts` classifies `history[]` as a *"non-numeric descriptive field"* and preserves it verbatim through a `{...oldSnap}` spread, while overwriting the scalars. But `history[]` **is** numeric and **is** mathematically downstream of the raw floor. **v0's equivalent file is perfectly self-consistent** (verified: labels match, Δ = 0). Cross-check: v0's snapshot `history[]` vs v0's `regime-history.csv` → **0 differing rows**; v1's snapshot `history[]` vs v1's `regime-history.csv.gz` → **2,968 / 2,968 differing, max abs 0.1238**. Two artifacts written seconds apart by one script disagree on every single date.

### D8 — The channel-divergence `CHANNEL` composite mixes two percentile definitions

`research-signals.ts:149,153` use `percentileInWindow` (`math.ts:31`) — **full-history**, `count(x ≤ v)/n`, no minimum obs, **no tie-splitting** — for `BTC_BETA` and `STABLES_QQQ_FLOW`, while `:150` uses `rollingPercentileRank` (`math.ts:176`) — **trailing 756-day**, 30-obs gated, **midrank** — for `BTC_QQQ_RATIO`. The `CHANNEL` gauge averages all three (`:155,161`), blending a **look-ahead-contaminated full-sample statistic that mechanically drifts as history grows** with a point-in-time rolling rank — violating the walk-forward discipline the rest of the platform maintains. Executed: the two definitions give **0.75 vs 0.625** for value 3 in `[1,2,3,4]`. The `read` thresholds (≥0.6 / ≤0.35) bucket that blend with **no hysteresis**, unlike the regime classifier's 5-day confirmation + 2σ fast-track. v0 published none of these, so it is new surface area rather than a regression — **but it is the number the v1 research page actually shows.**

### D9 — Four fixtures were substituted, only two are being restored

**PR #444 (commit `6985188`) regenerated FOUR baseline fixtures from v1's own pipeline**, as its own script header lists. #447/#464 flagged only two.

| Fixture | Flagged in #447/#464? | Restored by #464? | Tests silently converted to self-consistency |
|---|---|---|---|
| `regime-compute-reference.json.gz` | yes | **yes** | `regime-fidelity.test.ts:185` (STRICT, 1e-12) |
| `regime-backtest-correlations-reference.json.gz` | yes | **yes** | `backtest-correlations-fidelity.test.ts:108` (STRICT, 1e-9) |
| **`regime-history.csv.gz`** | **no** | **NO** | `regime-fidelity.test.ts:94` (STRICT), `:254` (TRACKING) |
| **`regime-snapshot.json.gz`** | **no** | **NO** | `regime-fidelity.test.ts:123` (STRICT), `backtest-correlations-fidelity.test.ts:167` (TRACKING) |

**So even after PR #464 merges, four of the six regime fidelity assertions remain self-consistency checks.** The two `-reference` files carry an honest `meta.source` admitting in-repo provenance; `regime-history.csv.gz` (a bare CSV, no metadata slot) and `regime-snapshot.json.gz` (which retains a `generated_at` that *looks* like a v0 cron stamp) carry **no provenance marker at all**, and their four consuming test comments still describe them as "the committed regime-history.csv" / "the committed regime-snapshot.json" — language that only makes sense if they came from v0. Two STRICT test **titles** still claim they reproduce the ORIGINAL JS pipeline; only body comments correct them.

**Worse, the two TRACKING gates cannot fail on the divergence we found:**

| Gate | Band | Measured divergence | Can it fail? |
|---|---|---|---|
| `regime-fidelity.test.ts:254` | `maxComposite < 0.08` | **0.0768** | **No** — 4% margin |
| `backtest-correlations-fidelity.test.ts:167` | `final_value` relative drift **< 20%** | **8.01%** | **No** — 2.5× margin |
| `regime-fidelity.test.ts:254` | `pctLabel > 0.995` (≤0.5% flips) | 5.17% flips vs v0 | Would fail *against v0* — but the baseline is v1 |

**The substitution was avoidable.** #447's premise — "the original JS generator is confirmed permanently unavailable" — was shown false by #464 for the *generator*, and is equally false for the *outputs*: v0's `data/regime/regime-history.csv` and `public/data/regime-snapshot.json` are present and readable on disk. And `regime-eq-snapshot.json.gz` is **byte-identical (sha256) to v0's file** — proving genuine v0 baselines were once vendored and remain available.

### D10 — The goldens-drift gate asserts nothing

`scripts/tests/unit/goldens-drift.test.ts` is named and treated as the drift gate. Its three assertions are: (1) `hasHealthCheck || goldensRoutes.size > 0` — tautological for any non-empty file; (2) `Object.keys(goldens.routes).length > 0` — non-empty; (3) a "correct golden shapes" loop guarded by `if (route in goldens.routes)` over three route names, **two of which (`/api/dashboards/swarm`, `/api/dashboards/regime`) do not exist** — the real names are `/api/dashboards/regime-snapshots` etc. **No numeric value in the 4.4 MB goldens file is asserted by anything.** Treat as a no-op.

### D11 — CI gating means the fidelity suite does not protect the cutover

The entire regime/backtest/research fidelity suite lives in `backend/tests/**` and runs only via `.github/workflows/backend.yml`. Its gate (`backend.yml:82`) is draft-gated **and** path-gated on `backend/**`. **A PR that changes only `frontend/`, `contract/`, or `scripts/` executes zero fidelity assertions.** It does run on push to `main`, i.e. post-merge. Branch-protection required contexts could not be read (`gh api …/branches/main/protection` returns 403), so whether a skipped job blocks merge is unconfirmed.

### D12 — Six factor-panel inputs differ across the entire history

`XLP_XLY`, `IWF_IWD`, `XLU_SPY`, `IWM_SPY`, `MTUM_SPY`, `SPHB_SPLV` differ on 1,810–1,958 of 3,097 shared cells each (36.8–41.6% identical), from **2018-01-02 — the first shared date**. Magnitude is small (max rel **1.38e-6**) but non-zero and systematic. Root cause: Yahoo retroactively restates the split/dividend adjustment factor over the entire history on every new distribution. Exactly the six ratios whose legs are dividend-paying ETFs drift; every non-dividend leg (`BTC_ETH`, `COPPER_GOLD`, `SPX_TREND`, `VIX`) is bit-identical to the last digit. These are factor-panel, so they miss the 2-panel composite but hit the 3-panel eq composite and every indicator page. **Any claim that v1 reproduces v0 byte-identically over the factor panel, on the two vintages compared here, is false.**

**Corrected in revision — this is auditable.** An earlier draft called the restatement *"an unfixable property of the input"*. That holds only for **re-fetching**. It has no bearing on **reading the floor committed at a v0 sha**, which is vintage-correct by construction — those are the exact bytes v0 computed against. Under §8's sha-addressed design the six ETF ratios are **fully auditable** over any `(sha, asof)` pair, and the drift becomes a *measurable property of a vintage pair* rather than an irreducible noise floor. The real residual is narrower than this finding originally implied: **v0-at-sha-S versus v1-computed-from-S's-committed-floor is exactly comparable**; only *v0-at-S versus a later re-fetch* is not. What remains true is that the two artifacts **as vendored today** were captured four days apart, which is why the drift shows up here.

### D13 — Silent losses with no decision record

| Loss | Consequence |
|---|---|
| **SP500 source Hyperliquid → Yahoo `^GSPC`** | Different quantities by construction (perp `accountValue/\|size\|` vs index level). Grep for `hyperliquid` in v1: zero hits. Any `/allocation` figure touching the SP500 leg is guaranteed non-parity. **Magnitude unmeasured** — no v0 artifact retained. |
| **Swarm brief regime context: 8 rows → 1** | Member agents receive strictly less input than v0's, which changes their takes and therefore **every downstream aggregate** (stance, quorum, bucket weights). No test covers brief content parity. |
| **≥50% concentration `notable` flag** | Absent. Subject page shows a donut but never the flag. |
| **Actual-vs-target bucket drift (pp)** | Absent. The chart degrades to "Recommended-only" **without surfacing that two series are missing**. |
| **`prices` table** | Dead — no reader, no writer. Price history survives only denormalised in `wallet_balance_samples.price_usd`, at daily grain (v0 was hourly). |

### D14 — Scope-boundary gaps

`docs/architecture.md:14-47` defines the in-scope set. Two documented gaps: (1) **the projects / analytics-dashboard surface is not named anywhere in §1**, yet v1 ships a large implementation of it (`backend/src/projects/**`, eight `/api/dashboards/*` routes, eight pages); §14 calls it "partially ported" (six of ~25 legacy pipelines). Whether the ~19 unported pipelines are intentional or a gap **cannot be settled from the canonical doc**. (2) **§1 says "regime/research data views" without enumerating them**, so under a literal reading D5's two frozen artifacts are in-scope views that were not ported.

### D15 — The swarm serving layer invents numbers when a column is NULL — **NEW, not found by any specialist audit**

`backend/src/swarm/domain.ts:1184-1244` `buildRegimeSummary` reads the last 14 `regime_snapshots` rows and serves them into swarm briefs and sessions. **It has no prod gate** (unlike `backfillRegimeHistory` at `:900-901`, which does). Four separate substitutions happen on the way out:

| Substitution | `path:line` | What is served |
|---|---|---|
| **Hardcoded fallback constants** | `:1202-1206`, `:1226-1227` | A NULL `composite` is served as **0.5**; NULL `macro_index` as **0.6**; NULL `onchain_index` as **0.35**; NULL `factor_index` as **0.75**. These are invented numbers presented as data. |
| **Index substituted for percentile** | `pct(v, base)` — `:1194-1199` | When a `*_percentile` column is NULL, the corresponding **panel index** is clamped to [0,1] and served **as the percentile**. These are different quantities: an index is a weighted mean of percentiles; a percentile is a 1095-day rolling rank of the composite. |
| **Label re-derivation via the divergent classifier** | `:1203, 1228-1231` | A NULL stored label is filled by `classifyRegime(...)` — the **contract classifier proven in 7.6 to disagree with `bucketFn` at exactly 0.67 and on NaN**, and which classifies a raw composite where the label is defined on the composite's percentile. |
| **Synthetic padding** | `:1211-1221` → `syntheticRegimePoint` `:881-888` | If fewer than `minPoints = 8` real rows exist, the history is **prepended with deterministic seeded-PRNG points** dated before the earliest real row. Not persisted, but served. |

**Why this matters now:** 8.5 and 8.6 establish that v1's pipeline **never writes** `extras` or `bucket_thresholds`, and A2 established that the pipeline computes backtest/correlations from `r2` only — so NULL columns on `regime_snapshots` are not hypothetical. Every one of these fallbacks is a silent substitution with no warning to the consumer, and swarm briefs feed member agents whose takes drive every downstream aggregate.

**This corrects A1's F7**, which recorded `classifyRegime`'s only consumers as demo synthesis "gated off prod". It is also a live fallback on an ungated serving path. **How often these fallbacks fire in production is UNVERIFIED** — it requires a seeded stack (check 6.4). **Owner must decide:** fail loudly on a NULL column, or keep serving invented values.

### Credit where it is due

The test **discipline** is real; the **baselines** are what is compromised. Specifically: `backend/tests/fixtures/regime/load.ts:12-14` **throws** `missing fixture … cannot run` rather than skipping — loud-skip is honoured. Every STRICT test **counts its own executed assertions** (`numericCompared > 6*2900`, `bCount.n > 1000`, `perInd > 15`) — genuine protection against a silently-empty comparison. `unit.yml:74-75` explicitly asserts that `bun test` over an empty selection exiting 0 is a failure. And PR #464 is a **genuine improvement, soundly evidenced**: I independently verified all five vendored blob shas against v0 with `git hash-object` (all match), confirmed the vendored library files are verbatim, mechanically compared all 17 extracted functions, and reproduced `corrDiffs=0, btDiffs=0` at 1e-9. **Merge it — but do not read it as v0↔v1 parity evidence**, because its generator calls `computeBacktest` on a *fresh* `computeRegime` result, which is precisely v1's assumption; the reference can never detect D2/D3 no matter how exact it is.

---

## 6. Cannot be tested — data access

**Correction issued in revision.** An earlier draft of this section treated several items as structurally unverifiable. That was wrong, and the error is worth naming because it shaped the remediation plan: **it assumed the only way to obtain a v0 input was to re-fetch it from upstream.** It is not. v0 is a git repository that commits its raw floor *and* its published outputs in the same commit, so any historical input is retrievable by sha without touching the network. Under the sha-addressed design in §8, the items below split into three groups.

### 6a. DISSOLVED by sha-addressed replay/recompute — not blockers

| # | Former blocker | Why it dissolves | Verified |
|---|---|---|---|
| 6.1 | **Yahoo adjusted-close restatement makes the six ETF ratios non-reproducible** | Restatement makes them non-reproducible **by re-fetching**. It has no bearing on reading the floor **committed at sha S**, which is vintage-correct *by construction* — it is literally the bytes v0 computed against. **The six factor ratios are fully auditable this way**, over any (sha, asof) pair. The earlier "unfixable property of the input" framing (D12) applies only to the re-fetch path and is corrected there. | v0 commits `data/regime/raw-indicator-history.csv` in the same commit as its outputs — confirmed at `e64a211e` (2026-06-25), which touches floor + `regime-history.csv` + both snapshots atomically. |
| 6.2 | **Coinmetrics network access** | Was needed only for floor **re**generation (`floor-seed-regenerate.ts`). **RECOMPUTE-from-committed-floor needs no network at all.** The `BTC_MVRV` question is answerable without an outbound socket. | `git cat-file -e <sha>:data/regime/raw-indicator-history.csv` succeeds at every regime sha. |
| 6.3 | **"The local v0 checkout stops at 2026-06-25 while v1's fixtures derive from a later v0 state"** | A `git fetch` on v0, not a structural limit. The checkout is a **full, non-shallow clone** (3,077 commits, `main`), so every vintage v0 ever published is already addressable; the 4-day tail simply needs the remote's newer commits. | `git rev-parse --is-shallow-repository` → `false`. |
| 6.4 | **Attributing the §7a input outliers** | Better settled by replay than by live re-fetch: read the floor at the sha where each value was first written and at the next sha, and the restatement is observed directly. The `DXY` forward-fill signature becomes a commit-level fact rather than an inference. | — |
| 6.5 | **Whether v0's cron still runs the frozen path** | Directly observable from commit contents, no deployment access needed: the 2026-06-25 regime commit adds **exactly one line** to `regime-history.csv` (`1 +`) while rewriting the floor. **That is commit-level proof of the append-only frozen behaviour** underpinning D2. Sweeping the 67 regime commits shows whether it ever deviated. | `git show --stat e64a211e`. |

### 6b. STILL BLOCKED — genuinely, under the §8 design

| # | Check | Why it remains blocked | What the test would be | Risk that stays open |
|---|---|---|---|---|
| 6.6 | **`/api/dashboards/*` served payloads** | **Postgres-backed.** Requires a running v1 stack + seeded DB; no artifact substitutes. | `bun run demo` + `db/import-regime-eq.ts`, then diff live responses. | **Stage 13 entirely unverified.** Also the only way to see whether `NULL` `extras`/`bucket_thresholds` degrade silently — and how often D15's fallbacks fire. |
| 6.7 | **v0's six wallet/price/treasury exports** | v1 has **no file counterpart**; delivery moved to DB-backed routes. Replay gives v0's side but there is nothing on v1's side to replay against. | Live-API comparison against a seeded v1 stack. | `prices.csv`, `vault-apy.json`, `hourly-vault-tvl.csv`, `hourly-wallet-balances.csv`, `unified-wallet-history.csv`, `subject-balances.csv` — **numerical parity entirely unaudited.** |
| 6.8 | **Vault economics, wallet balances, buybacks, all swarm metrics** | v0's outputs here are **point-in-time live-chain reads**. Replay recovers what v0 *recorded*, but v1 cannot be re-run against that same chain state — the block is on v1's side, and it is real. | A fresh **dual-run capture** against the same chain state on the same day. | 4 families in declared scope with **no assurance of any kind**. |
| 6.9 | **Live fetcher behaviour under fault conditions** | Replay gives *outputs*, never *upstream behaviour under stress*. Throttling, schema change, and timeout responses are not recorded in any artifact. | Run both fetcher sets against live upstreams, including fault injection. | **D6 (DefiLlama native-units), 1.7 (GeckoTerminal throttle), 1.8 (multpl CAPE) can only be settled this way.** All three arm on the first live run. |
| 6.10 | **`ages` under realistic sparse production data** | Needs a v1 production database with post-seed sparse rows. Cannot be synthesized from v0, which persists a dense grid. | Replay `computeRegime(…, ages)` over a real sparse floor past 2026-06-29. | The #402 cap's real steady-state effect is unknown; the synthetic bound (136/2,557 flips) is illustrative only. |
| 6.11 | **Anything observed on the demo / e2e surface** | `ANALYTICS_SOURCE=hermetic` (`access/hermetic-source.ts:37-49`) replaces **every** series with a deterministic seeded random walk. **No sha addressing helps** — the substitution is upstream of everything. | Validate against `liveDataSource` (`access/data-source.ts:107-155`) only. | **Any parity signed off from a demo or Playwright observation is vacuous.** |
| 6.12 | **Branch-protection required contexts** | `gh api …/branches/main/protection` → **403** (private repo, plan-gated). Credentials, not data. | Read the protection config. | Whether the draft/path-skipped `backend` job actually **blocks** merge (D11) is unconfirmed. |
| 6.13 | **`within_bucket_weights` producer** | Needs a real published session at runtime. | Inspect a live session payload. | Frontend reads a field with no located backend producer. |
| 6.14 | **Cross-runtime float determinism** | Both engines ran under Bun 1.3.14 this session; v0 production runs Node. | Run v0 under Node and diff — trivially unblocked by §8's harness (it materializes v0 source anyway). | All ops are `+ − × ÷ sqrt` (correctly rounded per IEEE-754), so divergence is not expected — but unconfirmed. |

### 6c. BLOCKED ON V1, NOT ON DATA — the precondition

| # | Check | Why |
|---|---|---|
| 6.15 | **"v1 as of datetime T"** | **Not a well-defined quantity today — for either published surface.** `store/regime-store.ts:53` rewrites all regime history on every run (D3), and `store/research-store.ts:19-21` does the same for research signals (`ON CONFLICT (signal_key, date) DO UPDATE SET payload = EXCLUDED.payload`), so what v1 says about date *D* depends on *when you asked*, not on *D*. v0 is reconstructible at any sha; v1 is not reconstructible at any point in time. **This is the binding constraint on the entire parameterized design** — see §8 Phase 0, whose immutability precondition covers **both** `regime_snapshots` and `research_signals`. |

**One check that was cheap and hermetic and deliberately not run:** `regime-goldens-regenerate.ts` needs no network and no DB, but executing it would **rewrite the very fixtures under audit** inside the worktree. Its behaviour was established by reading it and by measuring its committed output (D7).

---

## 7. The two open reconciliations — resolved

### 7a. The 1e-2 raw-floor outliers — **RESOLVED, fully attributed**

**The disagreement.** A1 reported ~8 indicators with unattributed **1e-2** relative outliers among ~11,026 differing raw-floor cells. A4 attributed the bulk of floor divergence to Yahoo adjusted-close restatement at **≤1.38e-6** plus "a short vintage tail". 1e-2 is four orders of magnitude above that band.

**What I did.** Re-measured both floors cell-by-cell keyed on `(indicator, date)`: v0's `data/regime/raw-indicator-history.csv` (72,385 rows) against v1's decompressed fixture (75,587 rows). Script: `.audit-scratch/C/recon-a.py`.

**Result — the two audits are describing the same population; A1 simply never date-stamped it.**

| Band (relative) | Cells | Attribution |
|---|---:|---|
| ≤1e-6 | **11,134** | Yahoo adjusted-close restatement — 6 dividend-bearing ETF ratios + 3 `DEFI_TVL`/`DEFI_GROWTH` cells |
| 1e-6 … 1e-4 | 15 | 11 of these are `SPHB_SPLV`/`IWM_SPY` at **1.00e-6 … 1.38e-6** — the *same* Yahoo mechanism, marginally over the band |
| 1e-4 … 1e-3 | 2 | vintage tail |
| 1e-3 … 1e-2 | 4 | vintage tail |
| **>1e-2** | **9** | vintage tail |
| **Total differing** | **11,164 / 72,385 (15.4%)** | |

**Every one of the 11 cells at ≥5e-3 is dated 2026-06-22 … 2026-06-25 — the final four days of v0's floor.** There are **zero** cells anywhere before 2026-06-22 exceeding **1.38e-6**.

| Indicator | Date | v0 | v1 | rel Δ |
|---|---|---|---|---|
| `BTC_ACTIVE` | 2026-06-25 | 488,035 | 522,671 | **7.10e-2** |
| `DFII10` | 2026-06-25 | 2.23 | 2.19 | 1.79e-2 |
| `DXY` | 2026-06-24 | **119.287** | 121.412 | 1.78e-2 |
| `DXY` | 2026-06-25 | **119.287** | 121.056 | 1.48e-2 |
| `DXY` | 2026-06-23 | **119.287** | 121.055 | 1.48e-2 |
| `DEFI_TVL` / `DEFI_GROWTH` | 2026-06-25 | 6.95436e10 | 7.03869e10 | 1.21e-2 |
| `DXY` | 2026-06-22 | **119.287** | 120.546 | 1.06e-2 |
| `ETH_ACTIVE` | 2026-06-25 | 847,686 | 838,983 | 1.03e-2 |
| `HY_OAS` | 2026-06-25 | 2.76 | 2.78 | 7.25e-3 |
| `COPPER_GOLD` | 2026-06-25 | 0.0015142 | 0.00150614 | 5.32e-3 |

**Mechanism, proven by the data itself.** `DXY` carries the **identical value 119.287 on all four days** 2026-06-22…25 in v0, against four distinct real prints in v1. That is not a revision — it is v0 **forward-filling a FRED series that had not yet published** at its 2026-06-25 capture, while v1's 2026-06-29 capture got the real prints. `BTC_ACTIVE`'s 7.1% gap is a **partial-UTC-day count** on the capture day. `DEFI_TVL` is DefiLlama's known ~6-day TVL restatement. `DFII10`/`HY_OAS` are ordinary FRED revisions.

**Verdict on the reconciliation.** A4 is correct and A1's outliers are **fully attributed** to A4's cluster (b), the capture-vintage tail. **There is no unexplained raw-input discrepancy.** Two corrections to the source audits: **(i)** the differing-cell count is **11,164**, not A1's 11,026 — A1's figure is not reproducible and should not be quoted; **(ii)** A4's ~1 ppm Yahoo band is slightly understated — 11 `SPHB_SPLV`/`IWM_SPY` cells reach 1.00e-6…1.38e-6, so the honest band is **≤1.38e-6**, which is what A4's own per-series table already shows.

**One caveat that must travel with this result:** the attribution rests on the *pattern* (all outliers in the last four days, forward-fill signature on `DXY`), not on direct observation of the restatement. **It is settleable without any network access** — read the floor at the sha where each value was first committed and at the next regime sha, and the restatement is observed directly rather than inferred (§6a, item 6.4). That check was not run here only because the harness in §8 does not exist yet; it is not blocked on data.

### 7b. 159 vs 153 regime-label flips — **RESOLVED, both are correct, they answer different questions**

**The disagreement.** A1 measured **159** flips from toggling `BTC_MVRV` inside v0's engine. B1 (and independently C1) measured **153** from v1's recompute vs v0's published history.

**What I did.** Ran v0's own unmodified `compute.js` + `lib/{utils,transforms,indicators}.js` — `require`d directly out of the read-only v0 checkout, nothing written there — over v0's own raw floor on the 3,098-day axis `2018-01-01 … 2026-06-25`, in two configurations, and compared both against v0's published `regime-history.csv` and against v1's committed `regime-compute-reference.json.gz`. Scripts: `.audit-scratch/C/recon-b.js`, `recon-b2.js`.

| # | Comparison | Basis | Flips |
|---|---|---|---:|
| 1 | **A** (v0 engine, no MVRV) vs **B** (v0 engine, +MVRV) | full axis, all **2,964** classified days | **159 / 2,964 (5.36%)** ← A1's figure, reproduced exactly |
| 2 | same toggle, restricted to the **2,960 published** dates | published basis | **158 / 2,960** |
| 3 | **P** (v0 published) vs **A** (v0 fresh, no MVRV) | published basis — *frozen-vintage effect alone* | **9 / 2,960 (0.30%)** ← A1 F3 / A2, reproduced exactly |
| 4 | **P** vs **B** (v0 fresh, +MVRV) | published basis — *both effects, v0 engine* | **153 / 2,960 (5.17%)** |
| 5 | **P** vs **R** (v1's committed recompute) | published basis | **153 / 2,960 (5.17%)** ← B1/C1's figure, reproduced exactly |
| 6 | **B** (v0 engine +MVRV) vs **R** (v1's recompute) | published basis | **0 / 2,960** |

**Why the bases differ.** A1's axis classifies **2,964** days; v0's published CSV carries **2,960** — v0 never published `2026-06-02, 06-05, 06-15, 06-18`. Exactly one of A1's 159 flips falls on those four dates, giving 158 on the published basis. The remaining reconciliation is a **non-additive interaction**, not an error:

```
158  BTC_MVRV flips on the published basis
 −7  masked: the frozen value already equalled the new label
     (2020-05-25..28, 2026-06-14, 06-16, 06-17)
 +2  pure frozen-vintage flips not caused by MVRV
     (2026-06-06, 2026-06-13)
────
153  published-vs-published
```

**The defensible figure is 153 / 2,960 = 5.17%.** That is the published-vs-published number — what a cutover actually costs a user looking at the site. **159 is also correct** but answers a different question: how many labels `BTC_MVRV` moves *holding the engine and vintage fixed*. Quote 153 externally; use 159 only when attributing cause. **Do not average them, and do not quote 159 as the cutover impact** — it overstates it by 4%.

**The far more valuable result is row 6.** v0's own engine, given v1's inputs, reproduces v1's committed recompute with:

- **0 / 2,960 regime-label differences**, and 0 label differences across the whole 3,098-day axis;
- **0 nonzero composite differences on every day from 2018-01-01 through 2026-06-19**;
- exactly **4** nonzero days — `2026-06-22 … 06-25`, max \|Δcomposite\| **2.13e-2** — which are precisely the raw-floor vintage-tail cells isolated in §7a, and which flip **no** labels.

**This closes C1 §6's top open question and it did not need PR #464's vendored copy** — v0's original modules were loaded directly from the read-only checkout. The decomposition is now complete and exact:

> **v0-published ≠ v1-recompute = `BTC_MVRV` admission + frozen-vintage mosaic + a 4-day raw-floor capture tail. Residual attributable to the port: zero.**

This upgrades the regime core from UNVERIFIED to **PROVEN-IDENTICAL** over 2018-01-01 → 2026-06-19 — the first genuinely independent, non-circular cross-implementation evidence in the entire audit, and the basis for the certifiable envelope in §2. **It does not extend to the production `ages` signature or the 3-panel path**, neither of which was exercised.

---

## 8. What would be required to reach full assurance

### DECIDE THIS (product choices — no engineering unblocks them)

| # | Decision | Consequence of each option |
|---|---|---|
| **P1** | **`BTC_MVRV`: bug-parity or bug-fix?** | *Fix (v1 today):* 153 published labels (5.17%) change, composite changes on 100% of days, headline backtest −8.01%. Requires a version bump, a public methodology note, and re-issuing any distributed backtest figure. *Parity:* exclude `BTC_MVRV` from the onchain panel; v1's composite becomes reconcilable to v0's; the panel keeps a known-dead indicator. |
| **P2** | **Published-history policy: immutable or best-available?** | *Immutable (v0's behaviour):* port `mergeFrozenIntoResult` + the version-gated relock; v1's published history becomes stable and reproducible. *Best-available (v0's docs, v1's behaviour):* accept that any historical number can change between runs with no version bump — then D3 **must** be closed with an audit trail. Note v0's own `regime-versions.json` documents the second while `update.js` implements the first; this contradiction must be resolved on one side. |
| **P3** | **The three dormant fetcher divergences: fix-forward or match v0?** | The multpl/CAPE fix (1.8), the GeckoTerminal retry (1.7), and the DefiLlama fallback (D6) are all *improvements* that break parity on first live run. D6 in particular is a **latent unit bug** and should be fixed regardless of the parity decision. |
| **P4** | **The `factor` panel: compute it or stop advertising it?** | v1 persists `panels:["macro","onchain","factor"]` and the frontend renders a `factor` strategy row the backend never produces. Either compute the 3-panel backtest/correlations or remove both claims. |
| **P5** | **The two frozen comparison reports: port, retire, or label?** | `regime-eq-comparison` and `weighting-comparison` are served stale with no staleness signal and cannot be regenerated. Port them (note: their **constant 2.6%/yr cash model** differs from v1's real-DTB3 model, so a clean port changes the published numbers), formally retire them with a doc line, or surface a staleness banner. |
| **P6** | **Scope: is the projects/analytics surface in or out?** | `docs/architecture.md:14-47` does not name it, yet v1 ships eight routes and eight pages of it. Until §1 says, ~19 unported legacy pipelines cannot be classified. |
| **P7** | **Adjacent surfaces: accept unverified, or fund a dual-run capture?** | Vault economics, wallet balances, buybacks, prices and all swarm metrics are in declared scope with **no baseline of any kind**. Parity there needs a fresh dual-run capture, not a fixture. |

### BUILD THIS — the design premise

**Pinning is an argument of an audit *run*, not a property of the architecture.** A given run records a `(sha, datetime)` pair in its manifest so it is reproducible; the tool itself must accept **any** `(sha, datetime)`. The earlier draft of this section called for re-vendoring a frozen v0 snapshot as the baseline. That is the wrong shape — it reproduces the exact failure mode of PR #444, just with better provenance: a single blessed artifact that ages, that someone eventually regenerates, and that can only ever answer one vintage.

The correct shape is a **parameterized harness over v0's git history**. Three facts make this work, all verified:

| Premise | Verified |
|---|---|
| v0 is a full, non-shallow clone of `main` with **3,077 commits** spanning 2026-03-10 → 2026-06-26 | `git rev-parse --is-shallow-repository` → `false` |
| Commit cadence is sub-daily — rotating `Hourly price update:`, `Hourly wallet balance update:`, `Vault TVL update:` plus daily regime/committee/APY commits — across **108 distinct days**, so `datetime → sha` is **dense and well-defined** | `git rev-list -1 --before="2026-06-01 12:00" HEAD` → `a8808b1f`, `Hourly price update: 2026-06-01T10+00:00` |
| **v0 commits its raw floor and its published outputs atomically**, so both replay and recompute are hermetic at a sha — no network, no DB | `git show --stat e64a211e` touches `raw-indicator-history.csv`, `regime-history.csv`, and both snapshots in one commit |

#### Target signature

```
parity.ts --v0-repo <path>
          [--v0-sha <sha> | --asof <datetime>]     # --asof → git rev-list -1 --before=<datetime> main
          --mode replay|recompute|both
          --metrics all|<registry-selector>
```

`--asof` and `--v0-sha` are interchangeable entry points to the same addressed state. Every run writes a **manifest** recording the resolved sha, the requested datetime, the v1 commit, the metric selector, and the tolerances applied — so a run is reproducible without the *tool* being pinned to anything.

#### Materialization — read-only on v0, non-negotiable

```bash
mkdir -p "$SCRATCH/v0@$SHA" && git -C "$V0_REPO" archive "$SHA" | tar -x -C "$SCRATCH/v0@$SHA"
```

**Do not use `git worktree add`.** It writes to v0's `.git` (worktree metadata, `HEAD` files, and an entry in `worktrees/`), which violates the read-only constraint on the production checkout. `git archive | tar -x` touches nothing under `$V0_REPO` and materializes into audit-owned scratch. Note this is also what makes check 6.14 (cross-runtime float determinism) trivial — the harness has v0's source materialized anyway, so running it under Node costs nothing extra.

#### Two hermetic modes, kept strictly distinct

| Mode | What it does | What it is ground truth for |
|---|---|---|
| **REPLAY** | Read v0's **committed artifacts** at sha — `regime-history.csv`, `regime-snapshot.json`, `regime-eq-snapshot.json`, the research JSONs | **"What v0 actually published."** The authoritative answer for any customer-facing claim. |
| **RECOMPUTE** | Execute v0's **code** at sha over the **floor committed at that same sha** | **"Does the procedure reproduce the published report?"** Isolates methodology from vintage. |

Both are network-free and DB-free. Conflating them is precisely the error that made the frozen-vintage divergence (D2) invisible for so long: v1 implements RECOMPUTE semantics and was being compared against REPLAY expectations. Reporting them as separate columns makes that class of difference structural rather than a surprise.

#### The sweep — the actual certification artifact

A single `(sha, asof)` pair is a spot check. Running the harness across **N historical shas** yields a **per-metric parity time series** — and that, not a pass/fail at one vintage, is what answers *"for any period and any metric."* It returns the **date a divergence began**, not merely that one exists.

Two consequences worth stating explicitly:

- **It would have caught the `BTC_MVRV` admission at the v1 change that introduced it** — a single-run regression against the immediately preceding v0 sha — instead of the divergence surfacing only now, via a manual audit, after it had already been baked into every one of the 2,960 published rows.
- **It makes registry tolerances empirical rather than guessed.** Measure each metric's actual v0-vs-v1 residual across history and set the band from the observed distribution. This is exactly the failure behind the `final_value < 20%` TRACKING band (D9), which was picked as a round number and sits 2.5× above the real 8.01% divergence, and behind `maxComposite < 0.08` sitting 4% above the real 0.0768.

**Honest limit on sweep depth — state this in any certification.** v0's git history begins **2026-03-10**, and `data/regime/regime-history.csv` first appears at **`90c79a21`, 2026-05-08**. There are **67 `Daily regime update` commits (69 touching the floor), spanning 2026-05-08 → 2026-06-25**. So the sweep yields **~67 vintages of an 8-year series, not 8 years of vintages**. That is still decisive for the two questions that matter — *when did v1 begin to diverge* and *was v0's own published history stable across vintages* — but it cannot reconstruct a v0 vintage from before 2026-05-08, and no amount of engineering changes that. Any claim of "full historical parity certification" must carry this bound.

### BUILD THIS — phased plan

#### Phase 0 — make parameterized auditing possible at all

**These two items gate everything below. Neither is optional.**

0a. **Make v1 addressable as-of a datetime — promote D3 from a finding to a precondition.** For an arbitrary `(sha, asof)` to be answerable, **both** sides must be reconstructible at that point. v0 is, via git. **v1 is not.** `store/regime-store.ts:53` rewrites all published history on every run, so *"v1 as of datetime T"* depends on when you asked, not on T. **Parameterized auditing is impossible against v1 until published history is immutable and the floor is addressable by vintage.** Concretely: an append-only published-history table with a vintage/version key (or a full snapshot-versioning scheme), plus a floor addressable by capture date rather than a single mutable current state. Until this lands, every result below is a spot check against whatever v1 happens to hold today. *(Closes D3 / A2's F2, which this revision reclassifies from a ranked finding to the binding structural constraint.)*

0b. **Build the parameterized harness contract** — the signature, `--asof` sha resolution, `git archive` materialization, the replay/recompute split, and the run manifest, exactly as specified above. **The metric registry hangs off the harness, not the reverse:** `--metrics` is a selector into a registry whose entries each declare their extractor, their comparison rule, their tolerance, and a **`decision` column** — `identical` or `deliberate-deviation(expected delta)` — so an accepted divergence is a recorded expectation the sweep verifies, not a silently widened tolerance. *(The `decision` column is a correction added with Phase R; see R5, R9.)* Adding a metric must not mean touching the harness.

#### Phase 1 — restore honest baselines and gates

1. **Retire the frozen-fixture model for regime baselines.** Replace the four #444-regenerated fixtures with **sha-addressed replay** against v0 (a fixture is then only a cache keyed by sha, not a blessed artifact). This is the durable fix for D9; re-vendoring a newer frozen copy is not, because it re-creates the same aging-artifact failure.
2. **Mark the two unflagged substitutions.** `regime-history.csv.gz` and `regime-snapshot.json.gz` were regenerated by #444 and are **not** restored by #464. Until Phase 1.1 lands they must carry a provenance marker (the bare CSV needs a sidecar), and the four consuming test comments plus the two STRICT test **titles** claiming ORIGINAL-JS provenance must be corrected. *(D9.)*
3. **Set tolerances from the sweep, not by hand.** Once Phase 0b + the sweep exist, derive every band from the measured residual distribution. Retire `maxComposite < 0.08` and `final_value < 20%`. *(D9.)*
4. **Add a CI job that runs the harness at a pinned `(sha, datetime)` from the manifest** and fails on a residual outside the registry tolerance. This replaces the manual `regime-independent-reference:regenerate` script, which no workflow runs — the structural hole that allows a future PR to repeat #444.
5. **Fix the self-contradicting snapshot.** `regime-goldens-regenerate.ts` must treat `history[]` as numeric and downstream of the floor. Assert that a snapshot's `history[-1]` agrees with its own top-level scalars — v0's file passes trivially, v1's fails on every date. *(D7.)*
6. **Make the fidelity suite actually gate the cutover.** `backend.yml:82` is draft-gated and path-gated on `backend/**`; a frontend-only PR runs zero fidelity assertions. Remove the path filter for this job or add it to required contexts — and confirm the branch-protection config (6.12). *(D11.)*
7. **Replace or delete the goldens-drift gate.** Two of three assertions are tautological; the third's loop is guarded on route names that do not exist. *(D10.)*

#### Phase 2 — close the correctness gaps the audit found

8. **Add a golden for the production call signature.** Every existing golden calls `computeRegime(transformed, dateAxis)`; production calls `computeRegime(transformed, dateAxis, PANELS, ages)` and also computes `r3`. Neither production argument is exercised anywhere. *(7.4, 7.5, 6.10.)*
9. **Make NULL columns fail loudly instead of substituting invented values.** `buildRegimeSummary` (`swarm/domain.ts:1194-1231`) serves hardcoded constants (0.5 / 0.6 / 0.35 / 0.75), substitutes a panel **index** for a **percentile**, fills missing labels with the divergent contract classifier, and pads short history with seeded-PRNG points — silently, on an ungated path feeding member agents. *(D15.)*
10. **Persist `extras` and `bucket_thresholds`** — both columns exist and the pipeline never writes them, so production serves `NULL` while demo/Playwright show data populated only by the fixture importer. *(8.5, 8.6.)*
11. **Delete or hard-deprecate the shadow implementations.** `analyze/regime.ts` (`regimeTool`), `analyze/channel-divergence.ts`, `analyze/late-cycle.ts`, `transform/grid.ts` — all dead, all mathematically different from the code they appear to name, and `contract/src/regime.js:3` points readers at the wrong "canon". *(7.6, 7.7, 11.9.)*
12. **Rename the divergent-semantics twins in `transform/math.ts`.** `mean` (0 for empty) shadows `meanArr` (NaN); `std` (**population**) sits beside `stddev` (**sample**, which the 2σ fast-track depends on); `pctChange` holds the v0 name while the port is `pctChangeLag`; `percentileInWindow` shadows `rollingPercentileRank`. **In every pair the wrong twin owns the more attractive name.** *(Prevents a future D8.)*
13. **Unify the percentile definition in the channel gauges,** or document why `CHANNEL` averages a look-ahead full-sample statistic with a point-in-time rolling rank. *(D8.)*
14. **Wire or delete `/research/late-cycle-signals`.** The backend computes and persists the signal every run; the page has no `x-data` hook and never fetches it. *(14.5.)*

#### Phase 3 — extend coverage to what replay cannot reach

15. **Run the sweep and publish the parity time series** as the standing certification artifact, carrying the 2026-05-08 depth bound.
16. **Stand up a live-API parity harness** against a seeded v1 stack, plus a dual-run capture for the chain-read families. *(6.6, 6.7, 6.8; all of Stage 13 and Stage 15.)*
17. **Fault-inject the live fetchers** to settle the three dormant divergences that no artifact can record — D6 (DefiLlama native-units), 1.7 (GeckoTerminal throttle), 1.8 (multpl CAPE). *(6.9.)*
18. **Pin input vintages going forward.** Neither side uses ALFRED `realtime_start`/`realtime_end`, and Yahoo restates adjusted close retroactively, so **neither v0 nor v1 is reproducible from a later *fetch***. Note this is now a *forward* hygiene item, not an audit blocker: historical vintages are already recoverable from v0's git (6a), and vintage pinning is about making v1's own future runs reconstructible — which is Phase 0a's requirement seen from the input side.

#### Phase R — Research engine: the perfect-parity workstream

**Definition.** The v0 research engine is the four scripts `scripts/regime/channel-divergence.js`, `late-cycle-signals.js`, `regime-eq-comparison.js`, `weighting-comparison.js` and their published artifacts (`public/data/channel-divergence.json`, `late-cycle-signals.json`, `regime-eq-comparison.json`, `weighting-comparison.json`).

**The strategic fact, up front: this is the only surface in the platform where perfect parity is attainable without resolving P1/P2.** The two computed signals are already proven exact by execution — A3 measured **0 error over ~9,000 points** across all 17 series (channel: 5 × 3,072 points; late-cycle: 12 series at 858/196/66/197 points), and both are guarded by the only **genuine** v0 fixtures in the repo (`channel-divergence.json.gz`, `late-cycle-signals.json.gz`, PR #9, never regenerated). Nothing in this workstream depends on `BTC_MVRV` (D1) or on the frozen-vintage publication policy (D2) — with exactly one carve-out, stated honestly in R1. The regime core cannot be certified until the P1/P2 fork is decided; the research engine can be certified **now**.

**R1 — Port the two missing generators verbatim.** `regime-eq-comparison.js` and `weighting-comparison.js` have **no v1 implementation** (D5, 11.7, 11.8); v1 serves byte-copies frozen at `asof 2026-05-30` / `2026-05-14`. Port rules for parity:
   - **(a)** Keep the **constant 2.6%/yr cash model** (`CASH_YR = 0.026`, `regime-eq-comparison.js:35` / `weighting-comparison.js:35`) **verbatim**. Do **not** "clean up" to v1's real-DTB3 model (`backtest.ts:94-101,221`) — that changes every published multiple (11.7, 11.8). Same for the other frozen constants: `COST = 0.001`, `REFRESH = 21`, the hardcoded `PHASES` (including `weighting-comparison.js:44`'s `2026-05-12` anchor and the two scripts' *different* phase-CAGR conventions, A3 F8).
   - **(b)** Reproduce the **exact input contract**: both scripts read the raw floor CSV **and** `public/data/regime-snapshot.json` (`snap.extras.eth`/`snap.extras.spx` — `regime-eq-comparison.js:142-143`, `weighting-comparison.js:170-171`). The port must accept those same two inputs. **Note the go-forward dependency this confirms:** regeneration under v1 requires `extras`, which v1's pipeline never persists (8.5) — so R1's go-forward path also depends on Phase 2 item 10.
   - **Acceptance — executable today, verified against v0's git:** both artifacts **are** committed in v0 — `regime-eq-comparison.json` at **`3e0bd316`** (2026-05-31, the commit that also adds the generator script) and `weighting-comparison.json` at **`9f65cb53`** (2026-05-15, likewise) — with dense daily `regime-snapshot.json` commits adjacent (e.g. `f7a69f1a`, `Daily regime update: 2026-05-30`). RECOMPUTE at those shas must reproduce v0's committed JSON at **1e-9** (byte-identical modulo float formatting). Both post-date the 2026-05-08 start of regime history, so every required input vintage is sha-addressable.
   - **Carve-out, stated honestly:** the certification above is against **v0's committed inputs**. *Go-forward regeneration* under v1 feeds v1's own snapshot into input (b) — so these two reports inherit whatever is decided in **P1/P2** the moment they are regenerated against live v1 state. **The port is decision-free; the future publication cadence is not.**

**R2 — Make the fidelity test execute the shipped code.** `backend/tests/research-fidelity.test.ts:51-80` never imports `computeChannelDivergence`/`computeLateCycle` — it replays a parallel inline reimplementation built from `math.ts` primitives (A3 F6; the #444 pattern of a truthful-sounding test over a parallel implementation). **This finding was absent from §8 until this addition — corrected here.** Rewrite the test to import the shipped functions from `analyze/research-signals.ts` and assert against the genuine v0 fixtures.

**R3 — Delete the synthetic name-collision twins first.** `analyze/channel-divergence.ts` and `analyze/late-cycle.ts` (11.9; Phase 2 item 11) compute the same signals from the **seeded random walk** and share filenames with the v0 scripts they do not implement. **Hard dependency of R2:** the rewritten test must import `analyze/research-signals.ts`, and a maintainer wiring the identically-named wrong file ships synthetic numbers to production.

**R4 — Wire or delete `/research/late-cycle-signals`.** No `x-data` hook; the signal is computed and persisted every run and never fetched (14.5; Phase 2 item 14). Cross-referenced here because a "certified" signal nobody can see is not a deliverable.

**R5 — Match or formally accept the two dormant v0-semantics divergences.**
   - **(a)** `channel` summary "latest": v1 `lastFinite(arr)` (`research-signals.ts:147`) vs v0 `arr[dates.length-1]` (`channel-divergence.js:181,187`) — divergent only when the final axis day is NaN while an earlier day is finite (11.2). For perfect parity, match v0; if keeping v1's more defensible behaviour, record it in the registry as `deliberate-deviation`.
   - **(b)** `late-cycle` `summary` shape: v1 `{latest}` unrounded vs v0 `{date, value}` 6-dp (11.5) — numeric content equal. Decide payload-shape parity or record the deviation.

**R6 — EDGAR M&A revision semantics.** v0 re-crawls **every** month from 2010 on every run; v1 fetches only missing months + a **2-month** revision window (1.10, `extract/edgar-fetch-plan.ts:28`), so an EDGAR back-revision older than 2 months never lands and `mna_s4_monthly`/`mna_pct` drift permanently. For perfect parity, widen v1 to a full re-crawl (or a window provably covering EDGAR's actual revision distribution); otherwise a registry-recorded deviation **with the drift bound measured**, not guessed.

**R7 — Exclude the `CHANNEL` composite from all parity claims.** It has no v0 counterpart, so parity is **undefined** for it (D8). Its mixed percentile definitions (full-history look-ahead `percentileInWindow` vs 756-day midrank `rollingPercentileRank`) should be fixed or the gauge dropped regardless — but either way it must not appear in any parity certification. Same exclusion applies to the other v1-only `gauges`/`read` thresholds (11.3, 11.6): parity language is reserved for surfaces v0 published.

**R8 — Attribute the two open research residuals via sha-replay.** Both are hermetically settleable under the §8 harness; **neither attribution is currently in §4's inventory rows, and both should be back-filled there once measured:**
   - **(a)** `btc_beta_vs_risk_appetite` differs on 2,975/3,098 dates at ~1e-4 against the **genuine** v0 fixture (§4) while the procedure is proven exact (11.1). Hypothesis: the QQQ leg's Yahoo adjusted-close restatement propagating through the 90-day OLS beta. Settle by replaying at matched shas.
   - **(b)** Late-cycle divergence confined to 2026 (§4: `consumer_conf_pct` 0 diffs 2010–2025, 8/25 in 2026). Hypothesis: capture-vintage tail + the R6 revision window. Same method.

**R9 — Register and sweep.** Add every research metric family to the harness registry with the Phase 0b `decision` column (`identical` or `deliberate-deviation(expected delta)` — the column this addition introduced) and run the sweep. **Caveat to carry in any certification:** `channel-divergence.json` and `late-cycle-signals.json` are cron-committed in v0 (`daily-research-signals.yml`), so they sweep across the 67-vintage window; the two comparison reports are **not cron-wired in v0** (§9 provenance table — manual-run scripts) and exist at essentially single vintages. **Their parity claim is per-artifact, not per-vintage.** **Second caveat — Phase 0a applies here too:** `research_signals` is rewritten on every run exactly like `regime_snapshots` (`store/research-store.ts:19-21`, 12.2, 6.15), so a sweep **against v1's stored research output is meaningless until Phase 0a lands** — until then the v1 side of every sweep point is "whatever the last run wrote", not a vintage. Sweeping v0's committed artifacts, and recomputing v1 fresh at each sha, is unaffected.

**R10 — Staleness for the two comparison reports.** Today they are served frozen with no staleness signal (D5), unlike regime snapshots (`computeRegimeSnapshotStaleness`, `report/regime-projection.ts:215-223`). After R1, either put them on a regeneration cadence or attach staleness metadata so the pages disclose their `asof`.

**Dependencies:**

| Item | Depends on | Independent of P1/P2? |
|---|---|---|
| R1 | §8 harness (acceptance runs); go-forward regeneration also needs `extras` persisted (8.5, Phase 2 item 10) | **Yes** for the port + certification; **no** for go-forward regeneration (carve-out) |
| R2 | **R3** (must import the right module) | Yes |
| R3 | — | Yes |
| R4 | — | Yes |
| R5 | — | Yes |
| R6 | — | Yes |
| R7 | — | Yes |
| R8 | §8 harness (Phase 0b) | Yes |
| R9 | **R1, R2, Phase 0b** | Yes |
| R10 | **R1** | Yes |

**Certifiable end-state:** *upon completion of R1–R9, every research-engine metric family is PROVEN-IDENTICAL against genuine v0 artifacts under the harness (or carries a registry-recorded deliberate deviation with a measured delta), gated in CI on every PR — a certification available NOW, independent of the regime-core P1/P2 fork.*
---

## 9. Provenance of this report

### Inputs

| Audit | Scope | Status |
|---|---|---|
| `docs/audits/v0-v1-parity/A1-regime-core-procedures.md` | Regime core procedures | Read in full |
| `…/A2-backtest-correlations-procedures.md` | Snapshot assembly, correlations, backtest | Read in full |
| `…/A3-derived-signals-procedures.md` | Derived research signals | Read in full |
| `…/A4-input-data-identity.md` | Input data identity | Read in full |
| `…/B1-report-output-diff.md` | Report output diff | Read in full |
| `…/C1-coverage-and-assurance-gaps.md` | Coverage, metric universe, assurance gaps | Read in full (landed mid-consolidation; folded in) |
| `scripts/audits/v0-v1-report-diff.ts` | Harness | Read and **executed** |

### Executed by this report (not read — run)

| What | How | Result |
|---|---|---|
| Raw-floor cell-by-cell re-diff, 72,385 shared cells | `.audit-scratch/C/recon-a.py` | 11,164 differing; full magnitude-band attribution; §7a |
| v0's engine over v0's floor, **without** `BTC_MVRV` | `.audit-scratch/C/recon-b.js` — `require`s v0's unmodified `compute.js`, `lib/{utils,transforms,indicators}.js` | 2,964 classified days |
| v0's engine over v0's floor **with** v1's `BTC_MVRV` | same | 159 flips vs the above; 153 vs v0 published |
| v0's engine (+MVRV) vs **v1's committed recompute** | `.audit-scratch/C/recon-b2.js` | **0/2,960 label diffs; 0 nonzero composite before 2026-06-20** |
| Macro-panel envelope measurement | inline node | 2,930/2,960 within 5e-7; 0/2,960 macro label flips |
| Self-contradicting snapshot fixture | inline node | Confirmed: `risk_off` vs `neutral`, same file, same date |
| v0 metric universe enumeration | inline node over v0's two snapshots | 8 vs 9 strategies, 3 vs 4 correlation indices, `eth.factor` values |
| Frontend `factor` strategy row | grep + read | `shared.js:80,97,113` — confirmed user-visible consequence of D4 |
| DefiLlama fallback, both sides | read `defillama.js:30` / `defillama.ts:22` | Confirmed native-units bug |
| v0 cron scheduling | read `.github/workflows/` | `regime-eq-comparison` / `weighting-comparison` are **not** cron-wired in v0 either |
| `buildRegimeSummary` prod gate | read `swarm/domain.ts:1184-1244` + grep all `classifyRegime` importers | **No prod gate.** Confirmed D15 and corrected A1's F7 |
| Raw-floor upsert semantics | read `store/raw-history-store.ts:48-71` vs `update.js:135-137` | **Matches v0** — both rewrite the raw floor each run. D3 narrowed to `regime_snapshots` only |
| `/research/late-cycle-signals` view wiring | grep `x-data` across both research views | **No `x-data` hook** — signal persisted, never fetched |
| **v0 sha-addressability** (premises for §8) | `git rev-parse --is-shallow-repository`; `git rev-list --count HEAD`; `git rev-list -1 --before=…`; `git log --grep="Daily regime update"`; `git show --stat`; `git cat-file -e <sha>:<path>` | Full clone, **3,077 commits**, 2026-03-10 → 2026-06-26, **108 distinct commit days**; `datetime → sha` resolves densely; **floor + outputs committed atomically**; **67 regime commits** from **2026-05-08** (the sweep depth bound) |
| Research-store upsert semantics (12.2, 6.15, Phase 0a extension) | read `backend/src/analytics/store/research-store.ts:12-22` | `persistResearchSignal` upserts `ON CONFLICT (signal_key, date) DO UPDATE SET payload` — same rewrite-on-every-run defect as `regime_snapshots` |
| R1 acceptance executability | `git show --stat 3e0bd316 / 9f65cb53`; read `regime-eq-comparison.js:142-143`, `weighting-comparison.js:170-171` | Both comparison artifacts committed in v0 alongside their generator scripts (2026-05-31 / 2026-05-15); adjacent daily snapshot commits (`f7a69f1a`); `snap.extras` input reads confirmed |
| **Full harness re-run** | see below | Reproduced B1's §2 roll-up exactly, including 153 |

**v0 was never written to.** Its modules were `require`d out of the read-only checkout; all scratch output went to `.audit-scratch/C/` inside this worktree.

### Re-run command for the harness

```bash
cd /drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260803-160300-v0-v1-mathematical-parity-audit

# Everything (the §4 roll-up):
bun run scripts/audits/v0-v1-report-diff.ts --v0 /drive2/home/lucas/robotmoney/robotmoney-site

# The headline pair with the per-year tables of §4:
bun run scripts/audits/v0-v1-report-diff.ts \
  --v0 /drive2/home/lucas/robotmoney/robotmoney-site \
  --pair compute-reference-vs-v0-history --era --era-top 4

# Machine-readable, for regression tracking:
bun run scripts/audits/v0-v1-report-diff.ts \
  --v0 /drive2/home/lucas/robotmoney/robotmoney-site --json /tmp/parity.json --quiet
```

Flags: `--v0 <path>` (required, read-only) · `--v1 <path>` · `--pair <name>` (repeatable) · `--era` / `--era-top N` · `--top N` · `--json <file>` · `--quiet`. **The harness always exits 0 — it is a measurement tool, not a gate.** Adding a pair means one entry in `buildPairs()`.

### Where the specialists disagreed — surfaced, not averaged

| Disagreement | Resolution |
|---|---|
| A1's **11,026** vs A4's **11,164** differing floor cells | **11,164** — re-measured. A1's figure is not reproducible; do not quote it. |
| A1's **159** vs B1/C1's **153** label flips | **Both correct, different bases.** 153 is the cutover cost; 159 is the `BTC_MVRV`-only attribution. §7b. Quote 153. |
| A4's "≤1.38e-6" Yahoo band vs A1's "1e-2 outliers" | **Same population, different framing.** All ≥5e-3 cells are the 2026-06-22…25 capture tail. §7a. |
| A1 could not attribute the 9 frozen-vintage label rows; A2 could not confirm the frozen path still runs | The 9-row count and the 2 pure-frozen dates (2026-06-06, 06-13) are now pinned. **A2's question is answered:** the 2026-06-25 regime commit adds **exactly one line** to `regime-history.csv` while rewriting the floor — commit-level proof the frozen append-only path was still live (§6a, item 6.5). Per-row attribution of the 9 remains open. |
| C1's "unverified whether the divergence hides a port defect" | **Resolved.** §7b row 6: residual attributable to the port is **zero**. |
| A2 could not determine the user-visible impact of the missing `factor` strategy | **Resolved.** `shared.js:80,97,113` renders it on all three tables. D4. |
| A1 F7: `classifyRegime` is "off the hot path", consumers "gated off prod at `swarm/domain.ts:900`" | **Corrected.** `buildRegimeSummary` (`swarm/domain.ts:1203,1228-1231`) is an **ungated** live consumer. D15. |
| A2/A3 on dead payload: `summary` + `indicators` unrendered | **Extended.** `/research/late-cycle-signals` has **no `x-data` hook at all** — the whole signal is never fetched. 14.5. |

---

## Bullet summary

- **Verdict: NO.** v1 disagrees with v0's published regime label on **153 / 2,960 days (5.17%)**, differs on the composite on **100%** of days (max 0.0768), and moves the headline backtest `eth.composite.final_value` by **−8.01%**.
- **The engine is sound; the inputs and the publication policy are not.** Executed proof: v0's own `compute.js`, given v1's inputs, reproduces v1's recompute with **0/2,960 label diffs and 0 nonzero composite diffs before 2026-06-20**. Residual attributable to the port: **zero**.
- **Scoreboard of 119 steps:** 30 PROVEN-IDENTICAL · 43 PROVEN-DIFFERENT · 10 PROVEN-DIFFERENT-DORMANT · 29 UNVERIFIED · 7 UNTESTABLE-DATA-ACCESS. **45% proven to differ; 30% with no evidence at all.**
- **Certifiable envelope, narrow:** the **macro panel only**, 2018-05-15 → 2026-06-25, within 6-dp write precision on 2,930/2,960 days, **macro regime label 2,960/2,960 with zero flips**. Onchain, composite, percentile and headline label have **no certifiable window**.
- **Reconciliation (a) resolved:** all 11 raw-floor cells ≥5e-3 are dated **2026-06-22…25** — v0's capture-vintage tail, with a forward-fill signature on `DXY` (119.287 repeated 4 days vs 4 real prints). No unexplained input discrepancy. Correct count is **11,164**, not 11,026.
- **Reconciliation (b) resolved:** 153 = 158 MVRV flips on the published basis − 7 masked + 2 pure-frozen. **Quote 153**; 159 answers a different question and overstates cutover impact.
- **Assurance is the deeper problem:** only **5 of ~33 metric families (~15%)** have a genuine v0 cross-check, all research signals. **PR #444 substituted four baseline fixtures, not two; #464 restores only two**, so 4 of 6 regime fidelity assertions stay self-consistent — and both TRACKING bands (0.08 composite, 20% `final_value`) are **wider than the measured divergence**, so they cannot fail on it. The goldens-drift gate asserts nothing. `backend.yml:82` is draft- and path-gated, so a frontend-only PR runs zero fidelity assertions. The test *discipline* (loud-skip, assertion counting) is genuinely good; the *baselines* are what is compromised.
- **New in consolidation, found by no specialist audit:** the swarm serving layer (`swarm/domain.ts:1184-1244`, **no prod gate**) substitutes hardcoded constants (0.5 / 0.6 / 0.35 / 0.75) for NULL columns, serves a panel **index** as a **percentile**, fills missing labels with the divergent contract classifier, and pads short history with seeded-PRNG points — all silently. `/research/late-cycle-signals` has **no `x-data` hook**, so a signal computed and persisted every run is never fetched.
- **Research engine — perfect parity is attainable now:** §8 Phase R lays out the R1–R10 workstream; the two computed signals are already proven exact by execution against genuine v0 fixtures, nothing there waits on the `BTC_MVRV` / frozen-vintage decisions except go-forward regeneration of the two ported comparison reports.
- **Top three owner decisions:** (1) `BTC_MVRV` bug-parity vs bug-fix — accept a 5.17% rewrite of published history or preserve continuity; (2) immutable published history vs best-available recompute — v0's code and v0's own docs contradict each other, and v1 is currently not reproducible against itself; (3) restore genuine v0 baselines, tighten the tracking bands below the measured divergence, and decide whether the `factor` strategy and the two frozen comparison reports are ported or formally retired.
