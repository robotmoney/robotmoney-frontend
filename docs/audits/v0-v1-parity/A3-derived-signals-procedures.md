# A3 — Derived research signals: v0 → v1 procedure parity

**Worker:** W3 · **Date:** 2026-08-03
**v0 (read-only):** `/drive2/home/lucas/robotmoney/robotmoney-site`
**v1 (under audit):** this worktree (`robotmoney-frontend`)

---

## Verdict

**NO — not certified identical.**

Two of the four v0 research scripts (`channel-divergence.js`, `late-cycle-signals.js`) have a
faithful v1 port whose per-indicator series I proved numerically identical by **executing both
implementations against the same inputs** (max abs diff `0` across 15 series / ~9,000 points); the
other two (`regime-eq-comparison.js`, `weighting-comparison.js`) have **no v1 implementation at
all** — v1 ships their v0-generated JSON as byte-identical frozen fixtures dated 2026-05-30 and
2026-05-14, so those metrics are *unrecomputable for any period after that*.

---

## Method / evidence class

| Grade | Meaning |
|---|---|
| IDENTICAL | Same algorithm, same constants, and **proven equal by execution** on shared inputs. |
| EQUIVALENT | Provably same value by algebra/inspection, different code shape. |
| DIVERGENT | Different numbers or different emitted contract; trigger stated. |
| MISSING | No v1 implementation. |
| EXTRA | v1-only, no v0 counterpart. |

**Executed evidence.** I built two harnesses that load the **real v0 source** (v0
`scripts/regime/lib/utils.js` verbatim via `require`, plus v0's own `rollingBeta`, `summarize`,
`buildEqualWeightIndex`, `firstFinite`, `latestOf` loaded from the real v0 script files with only
the network-calling `main()` invocation stripped) and run it side by side with v1's
`computeChannelDivergence` / `computeLateCycle` over identical deterministic synthetic inputs
(2018-01-01→2026-05-30 for channel, 2010-01-01→2026-05-30 for late-cycle; weekday-only equity
series, 7-day crypto series, month-end-stamped monthly M&A, quarterly margin debt, month-start
consumer confidence, and two deliberately late-listing TOP7 members to exercise the equal-weight
start rule). Results are quoted inline below. Per the PR #464 caveat, **no in-repo comment or test
name was accepted as evidence**; `backend/tests/research-fidelity.test.ts` in particular does *not*
execute the shipped functions (see Finding F6).

---

## 1. `scripts/regime/channel-divergence.js`

**v0 input contract**
- `fetchYahoo('BTC-USD'|'QQQ'|'SPY', period1 = unix(2018-01-01))` — `channel-divergence.js:53-68`, fetcher `scripts/regime/fetchers/yahoo.js:14-38` (adjclose, falling back to close).
- `STABLES` read directly out of `data/regime/raw-indicator-history.csv` (long format `date,indicator,value`) — `channel-divergence.js:50, 76, 160-176`.
- Date axis: `buildDateAxis('2018-01-01', isoDate(new Date()))` — dense **calendar** days, `channel-divergence.js:53,60-61`.
- Constants: `BETA_WINDOW=90`, `FLOW_WINDOW=90`, `PCT_RANK_WINDOW=252*3=756` — `:55-57`.
- Output: `public/data/channel-divergence.json` (pretty-printed, atomic write) — `:51,127`.

**v1 input contract**
- `liveDataSource.fetchResearchInputs` — `backend/src/analytics/access/data-source.ts:112-145`; BTC/QQQ from `unix(2018-01-01)` (`:89,115-116`), SPY from `unix(2010-01-01)` (`:90,117`).
- `STABLES` from `mergedRaw.STABLES ?? floor.STABLES` (the persisted `raw_indicator_history` table) — `backend/src/analytics/index.ts:294-297`.
- Date axis: `buildDateAxis('2018-01-01', asof)` — `backend/src/analytics/analyze/research-signals.ts:20,123`.
- Constants: `PCT_RANK_WINDOW=252*3`, `BETA_WINDOW=90`, `FLOW_WINDOW=90` — `research-signals.ts:22-24`.
- Output: `research_signals` row via `persistence.saveResearchSignal("channel-divergence", …)` — `index.ts:311`.

| v0 emitted field (`channel-divergence.js`) | v1 counterpart | Grade | Note |
|---|---|---|---|
| `asof` `:109` | `asof` `research-signals.ts:170` | EQUIVALENT | v0 = literal run date (`isoDate(new Date())`); v1 = injected `asof`. Same when run for today; v1 additionally supports replay. |
| `spec.beta_window_days` `:111` | `research-signals.ts:174` | IDENTICAL | 90. Harness: whole `spec` object compares equal by `JSON.stringify`. |
| `spec.flow_window_days` `:112` | `:175` | IDENTICAL | 90. |
| `spec.percentile_window_days` `:113` | `:176` | IDENTICAL | 756. |
| `spec.risk_factor` `:114` | `:177` | IDENTICAL | Same string incl. the U+2212 minus. |
| `btc_price[]` `:116` | `btc_price` `:185` | IDENTICAL | fwd-filled BTC on the dense axis, 6-dec rounded, `null` pre-history. **Executed: 3072/3072 points equal.** |
| `qqq_price[]` `:117` | `qqq_price` `:186` | IDENTICAL | **Executed: 3072/3072 equal.** |
| `indicators.btc_beta_vs_risk_appetite` `:119` | `:188` | IDENTICAL | v0 `rollingBeta` `:135-158` vs v1 `rollingBetaSeries` `research-signals.ts:36-53` — same OLS `cov/var` via raw sums, same `c < floor(n/2)` reject, same `varX <= 0` reject. Risk factor = `qqqRet − spyRet` with pairwise-finite guard (`:84-86` / `:133`). **Executed: 3072/3072 equal.** |
| `indicators.btc_qqq_ratio_percentile` `:120` | `:189` | IDENTICAL | `rollingPercentileRank(btc/qqq, 756)`, midrank `(below + 0.5·equal)/n`, `<30` obs → NaN. `math.ts:176-195` is a verbatim port of `lib/utils.js:146-167`. **Executed: 3072/3072 equal.** |
| `indicators.stables_vs_qqq_flow` `:121` | `:190` | IDENTICAL | `pctChange(stables,90) − pctChange(qqq,90)`, length-preserving NaN-padded lag form (`utils.js:95-102` ≡ `math.ts:125-132`). **Executed: 3072/3072 equal.** |
| `summary.beta.{latest,median_full_history}` `:187` | `:193` | EQUIVALENT (see F3) | Values equal in the harness. v0 `latest = beta[lastIndex]` (`:181,187`); v1 `latest = lastFinite(beta)` (`:147`). Diverges only if the final axis day is NaN while an earlier day is finite. Median = upper median `v[floor(n/2)]` both sides. |
| `summary.ratio_percentile.{…}` `:188` | `:194` | EQUIVALENT (see F3) | Same. |
| `summary.flow_diff.{…}` `:189` | `:195` | EQUIVALENT (see F3) | Same. |
| — | `title`, `question`, `series` `:171-172,180-183` | EXTRA | `series` = last 180 non-null BTC/QQQ ratio points (chart payload). |
| — | `gauges[BTC_BETA].percentile` `:158` | EXTRA (F4) | `percentileInWindow(betaLast, allFiniteBetas)` — **full-history**, `count(x ≤ v)/n`. Not v0's 756-day midrank. |
| — | `gauges[BTC_QQQ_RATIO].percentile` `:159` | EXTRA | = `lastFinite(ratioPct)`; this one *is* the v0 756-day midrank. |
| — | `gauges[STABLES_QQQ_FLOW].percentile` `:160` | EXTRA (F4) | Full-history `percentileInWindow`. |
| — | `gauges[CHANNEL]` `:161` | EXTRA (F4) | Mean of the three percentiles above — mixes two different percentile definitions over two different windows. |
| — | `gauges[*].read` thresholds `research-signals.ts:120` | EXTRA | `≥0.6` intact / `≤0.35` breaking down / else softening. No v0 analogue; no hysteresis or debouncing. |

**Harness output (verbatim):**

```
== channel-divergence ==
btc_price: IDENTICAL (3072 pts)
qqq_price: IDENTICAL (3072 pts)
indicators.btc_beta_vs_risk_appetite: IDENTICAL (3072 pts)
indicators.btc_qqq_ratio_percentile: IDENTICAL (3072 pts)
indicators.stables_vs_qqq_flow: IDENTICAL (3072 pts)
spec IDENTICAL
v0 summary: {"beta":{"latest":0.015010897727794901,"median_full_history":0.04334427863744913},
             "ratio_percentile":{"latest":0.6223544973544973,"median_full_history":0.14087301587301587},
             "flow_diff":{"latest":0.07516459226126168,"median_full_history":-0.014236941558953893}}
v1 summary: <byte-identical to the v0 line above>
```

---

## 2. `scripts/regime/late-cycle-signals.js`

**v0 input contract**
- Yahoo `SPY`, `RSP`, and the 7-name basket from `unix(2010-01-01)` — `:61-79`.
- `TOP7 = [NVDA, MSFT, AAPL, GOOGL, AMZN, META, AVGO]` — hardcoded, survivorship-biased — `:67`.
- EDGAR full-text search, one request/month over **the whole 2010→today range on every run**, `q="merger"&forms=S-4`, count = `hits.total.value`, stamped on month-END — `:220-282`.
- FRED `BOGZ1FL663067003Q` (margin debt, quarterly) and `UMCSENT` — `:111,122`.
- Axis `buildDateAxis('2010-01-01', today)`; `PCT_RANK_WINDOW = 756` — `:61,63,71`.
- Output `public/data/late-cycle-signals.json` (minified) — `:59,174`.

**v1 input contract**
- Same Yahoo tickers/start (`data-source.ts:117-119`), same `TOP7` (`research-signals.ts:28`).
- EDGAR: same URL builder `extract/edgar.ts:23` and same `hits.total.value` parse `:45-49`, month-END stamp `:39`, but fetched **incrementally** — only missing months plus a 2-month trailing revision window (`extract/edgar-fetch-plan.ts:20,28`), under a 90 s hard deadline, merged onto the persisted floor (`edgar-incremental-refresh.ts`, `data-source.ts:130-142`).
- Same FRED series ids — `data-source.ts:133-134`.
- Axis `buildDateAxis('2010-01-01', asof)`; `PCT_RANK_WINDOW = 756` — `research-signals.ts:21-22,214`.

| v0 emitted field (`late-cycle-signals.js`) | v1 counterpart | Grade | Note |
|---|---|---|---|
| `asof` `:141` | `research-signals.ts:255` | EQUIVALENT | run-date vs injected `asof`. |
| `spec.start` `:143` | `:259` | IDENTICAL | `2010-01-01`. |
| `spec.percentile_window_days` `:144` | `:260` | IDENTICAL | 756. |
| `spec.top7_membership` `:145` | `:261` | IDENTICAL | Same 7 tickers, same order. |
| `spec.mna_source` / `margin_source` / `conf_source` `:146-148` | `:262-264` | IDENTICAL | Same strings. |
| `spy_price[]` (weekly) `:150` | `spy_price` `:272` | IDENTICAL | `weekly` = `i % 7 === 0 || i === last` both sides (`:138` / `:107-109`). **Executed: 858/858 equal.** |
| `indicators.concentration_cap_vs_equal` `:152` | `:274` | IDENTICAL | `SPY/RSP`, guarded on `rsp !== 0`. **Executed: 858/858 equal.** |
| `indicators.concentration_cap_vs_equal_pct` `:153` | `:275` | IDENTICAL | `rollingPercentileRank(·, 756)`. **Executed: 858/858 equal.** |
| `indicators.concentration_top7_vs_spy` `:154` | `:276` | IDENTICAL | Daily-rebalanced equal-weight index (`:184-213` ≡ `research-signals.ts:58-84`, incl. the "hold level through gaps" and "start at 1.0 on the first all-finite day" rules), divided by SPY rebased at `spyA[firstFinite(spyA)]`. v1 hoists `spyBase` out of the map (`:225`) — same value. **Executed: 858/858 equal, including the two late-listing members.** |
| `indicators.concentration_top7_vs_spy_pct` `:155` | `:277` | IDENTICAL | **Executed: 858/858 equal.** |
| `indicators.mna_s4_monthly` `:156` | `:278` | IDENTICAL (shape) | Raw month-end-stamped counts passed through. **Executed: 196/196 equal.** Provenance differs — see F5. |
| `indicators.mna_pct` `:157` | `:279` | IDENTICAL | fwd-fill then `rollingPercentileRank(·,756)`. **Executed: 858/858 equal.** |
| `indicators.margin_debt_level` `:158` | `:280` | IDENTICAL | Raw FRED quarterly rows. **Executed: 66/66 equal.** |
| `indicators.margin_debt_yoy` `:159` | `:281` | IDENTICAL | `pctChange(fwdFilled, 365)` — calendar-365 lag on a dense axis, not 4 quarters. **Executed: 858/858 equal.** |
| `indicators.margin_debt_yoy_pct` `:160` | `:282` | IDENTICAL | **Executed: 858/858 equal.** |
| `indicators.consumer_conf_level` `:161` | `:283` | IDENTICAL | **Executed: 197/197 equal.** |
| `indicators.consumer_conf_pct` `:162` | `:284` | IDENTICAL | **Executed: 858/858 equal.** |
| `summary.concentration` `:165` | `:287` | **DIVERGENT (shape)** | v0 `latestOf` → `{date, value: +v.toFixed(6)}` (`:284-289`); v1 → `{latest: <unrounded>}` (`:287`). Numeric content equal (`0.149471` vs `0.14947089947089948`); the `date` field and the 6-dec rounding are gone. See F2. |
| `summary.top7_vs_spy` `:166` | `:288` | **DIVERGENT (shape)** | Same. |
| `summary.mna` `:167` | `:289` | **DIVERGENT (shape)** | Same. |
| `summary.margin_yoy` `:168` | `:290` | **DIVERGENT (shape)** | Same. |
| `summary.consumer_conf` `:169` | `:291` | **DIVERGENT (shape)** | Same. |
| — | `gauges[CONCENTRATION|TOP7_VS_SPY|MNA]` `:245-247` | EXTRA | `percentile` = `lastFinite(<the v0 756-day pct series>)` → numerically the v0 `summary.*.value`. Safe. |
| — | `gauges[MARGIN].percentile` `:248` | EXTRA | `lastFinite(marginYoYPct)` — v0 emitted the series but never a headline percentile. |
| — | `gauges[CONF].percentile` `:249` | EXTRA | `lastFinite(confPct)`. |
| — | `gauges[*].read` thresholds `:211` | EXTRA | `≥0.7` saturated / `≥0.5` elevated / else benign. No v0 analogue, no hysteresis. |
| — | `title`, `question`, `series` `:256-257,267-270` | EXTRA | Chart payload (last 180 non-null concentration points). |

**Harness output (verbatim):** all 12 series above reported `IDENTICAL`, e.g.

```
indicators.concentration_top7_vs_spy: IDENTICAL (858 pts)
indicators.margin_debt_yoy: IDENTICAL (858 pts)
v0 summary: {"concentration":{"date":"2026-05-30","value":0.149471}, …}
v1 summary: {"concentration":{"latest":0.14947089947089948}, …}
```

---

## 3. `scripts/regime/regime-eq-comparison.js` — **NO v1 IMPLEMENTATION**

**v0 input contract:** `data/regime/raw-indicator-history.csv` (`:47-51`) **plus**
`public/data/regime-snapshot.json` → `snap.extras.eth` / `snap.extras.spx` price levels
(`:131,142-143`). Axis `buildDateAxis('2018-01-01', <max csv date>)` (`:57-58`). Constants
`CASH_YR = 0.026` **constant** (`:35`), `COST = 0.001` (`:36`), `REFRESH = 21` (`:37`), five
hardcoded `PHASES` with the last one open-ended to `2099-12-31` (`:38-44`).

The named v1 files in scope — `report/regime-eq-map.ts`, `report/regime-projection.ts`,
`report/projections.ts` — are **not** counterparts. They are pure row→DTO mappers over the
canonical `regime-eq-snapshot.json` fixture and over Postgres `regime_snapshots` rows
(`regime-eq-map.ts:1-17`, `regime-projection.ts:70-98`, `projections.ts:39-53`). None of them
computes a comparison, an agreement statistic, a time-share, or a backtest.
`analyze/backtest.ts` is a port of a *different* v0 script (`update.js`'s `computeBacktest`,
per its own header `backtest.ts:1-6`) with a *different* cash model (real daily DTB3,
`backtest.ts:94-101`) and a different strategy set.

What v1 actually ships: `frontend/public/data/regime-eq-comparison.json`, **byte-identical**
(`cmp -s` → equal, 695,058 bytes) to the v0 file, `generated_at: 2026-05-31T16:00:43.248Z`,
`asof: 2026-05-30`. Nothing in `scripts/`, `backend/`, `package.json` or `.github/` regenerates it.

| v0 emitted field | v1 counterpart | Grade | Note |
|---|---|---|---|
| `generated_at`, `asof` `:281-282` | frozen literal in the committed JSON | MISSING | Cannot advance past 2026-05-30. |
| `assumptions.{cash_yield_annual, rebalance_cost_bps, rolling_window_days, weight_refresh_days, weighting}` `:283-289` | — | MISSING | v1 has matching *constants* (`ROLLING_WINDOW_DAYS=365*3` `indicators.ts:466`, `BACKTEST_COST_PER_REBALANCE=0.001` `backtest.ts:20`, `WEIGHT_REFRESH_DAYS=21` `compute.ts`), but no code emits this block, and v1's backtest cash leg is DTB3, **not** the constant 2.6 %/yr this script defines. |
| `indicator_counts.{macro,onchain,factor}` `:291-294` | — | MISSING | Registries *do* agree today: v0 and v1 both give `{macro:8, onchain:10, factor:8}` (executed against both `INDICATORS` exports), so a future port would reproduce this field. |
| `history.base_composite` (monthly) `:296` | — | MISSING | 2-panel `['macro','onchain']` walk-forward composite. |
| `history.eq_composite` `:297` | — | MISSING | 3-panel `[+factor]` composite. |
| `history.macro_index` / `onchain_index` / `factor_index` `:298-300` | — | MISSING | Per-panel walk-forward indices with 21-day weight refresh (`:84-98`). |
| `history.base_regime` / `eq_regime` (daily labels) `:301-302` | — | MISSING | `smoothRegimes(rollingPercentileRank(comp,1095), bucketFn)` (`:120-123`). |
| `time_share.{base,eq,macro_alone,onchain_alone,factor_alone}` `:304-310` | — | MISSING | Day counts per bucket (`:234-242`). |
| `agreement.{same_pct,total,diff_by_year}` `:311` | — | MISSING | Label-agreement diagnostic (`:243-254`). |
| `backtest.{eth,spx,mixed}.{base,eq,macro_alone,onchain_alone,factor_alone,hodl}` `:312-316` | — | MISSING | Each with `final_value`, `cagr`, `sharpe`, `max_drawdown`, `transitions`, monthly `equity_curve`, and per-`PHASES` `{cagr, max_drawdown}` (`:149-231`). |

---

## 4. `scripts/regime/weighting-comparison.js` — **NO v1 IMPLEMENTATION**

**v0 input contract:** same two inputs (`:48-52`, `:159`). Constants `CONSTANT_CASH_YR = 0.026`
(`:35`), `COST_PER_REBALANCE = 0.001` (`:36`), `WALK_FORWARD_REFRESH_DAYS = 21` (`:37`),
`PHASES` with the last phase **hard-anchored to `2026-05-12`** (`:44`).

v1 ships `frontend/public/data/weighting-comparison.json`, **byte-identical** to v0 (282,710 bytes),
`generated_at: 2026-05-15T16:25:38.193Z`, `asof: 2026-05-14`. No generator anywhere in v1.

| v0 emitted field | v1 counterpart | Grade | Note |
|---|---|---|---|
| `generated_at`, `asof` `:244-245` | frozen literal | MISSING | Frozen at 2026-05-14. |
| `assumptions.*` `:246-251` | — | MISSING | Constant-cash assumption has no v1 code path. |
| `methods.static_invcorr.*` `:238` | — | MISSING | One inverse-corr vector from the most recent 3y window applied to all history (look-ahead by design) — `staticMethod(false)` `:100-121`. |
| `methods.equal_1n.*` `:239` | — | MISSING | 1/N over indicators with ≥60 valid obs in the trailing 3y — `staticMethod(true)` `:105-107`. |
| `methods.walk_forward.*` `:240` | — | MISSING | Point-in-time inverse-corr, 21-day refresh, 1/N fallback when no indicator clears 60 obs — `:123-147`. |
| `methods.*.panel_weights.{macro,onchain}` `:261-264` | — | MISSING | 4-dec-rounded per-indicator weights. |
| `methods.*.{eth,mixed}.{composite,conservative,aggressive,hodl}` `:265-276` | partial: `analyze/backtest.ts:120-125` | MISSING | v1's `combineConservativeN`/`combineAggressiveN` (`backtest.ts:144-158`) *are* algebraically equal to v0's 2-panel `combineConservative`/`combineAggressive` (`:149-156`): for integer scores over N=2, `sum > 0 ⇔ x ≥ 1` and `sum < 0 ⇔ x ≤ −1`. But they are wired into the **update.js-style** backtest (DTB3 cash, different portfolio spec keys `sp500`/`eth`/`mixed`, extra `macro_inverted`/`stables_only` legs, in/out-of-sample CAGR split), not into a weighting-method comparison. Every metric this script emits — `final_value`, `cagr`, `sharpe`, `max_drawdown`, `equity_curve`, per-`PHASES` `{cagr,max_drawdown}` (`:176-232`) — is unreproducible in v1. |

---

## Explicit MISSING list (v0 signals with no v1 implementation at all)

1. **Everything emitted by `regime-eq-comparison.js`** — base-vs-eq composite histories, per-panel
   indices, daily regime label series for both arms, `time_share` for five label series,
   `agreement` (incl. `diff_by_year`), and the 3 portfolios × 6 strategies backtest grid with
   phase-level CAGR/max-drawdown.
2. **Everything emitted by `weighting-comparison.js`** — the three weighting methods
   (`static_invcorr`, `equal_1n`, `walk_forward`), their per-indicator `panel_weights`, and the
   2 portfolios × 4 strategies backtest grid with phase-level metrics.
3. **The constant-cash (2.6 %/yr) backtest model** shared by both scripts. v1 has only the
   real-DTB3 model (`backtest.ts:94-101,221`). Any attempt to reproduce either artifact with v1's
   backtest engine will produce different absolute multiples.
4. **`summary.*.date`** on `late-cycle-signals` (v0 `latestOf` returned the date of the last real
   observation; v1 emits only a bare `latest` value).
5. **The v0 JSON artifacts themselves** — v1 emits research signals only to the
   `research_signals` DB table via `saveResearchSignal`; no `public/data/channel-divergence.json`
   or `late-cycle-signals.json` is produced.

---

## Findings

### F1 — `regime-eq-comparison` and `weighting-comparison` are frozen data, not code — **BLOCKS-PARITY**
**Trigger:** any period after `2026-05-30` (eq-comparison) / `2026-05-14` (weighting-comparison).
**Evidence:** `cmp -s` proves `frontend/public/data/{regime-eq-comparison,weighting-comparison}.json`
are byte-identical to v0's; a repo-wide grep for those filenames across `scripts/`, `backend/`,
`contract/`, `docs/`, `.github/`, `package.json` returns only a code-review note and two Playwright
specs that read the committed fixtures (`frontend/test/browser/blog-charts.spec.ts:5-6,55,72`).
**Consequence:** "for any period, v1 is mathematically identical to v0" is **false today** for these
two artifacts — v1 cannot compute them for *any* period; it can only replay two frozen dates. The
numbers rendered on `/blog/regime-eq-vs-base` and `/blog/honest-backtesting-weights` will silently
age without any staleness signal (unlike regime snapshots, which do carry
`computeRegimeSnapshotStaleness`, `report/regime-projection.ts:215-223`).

### F2 — `late-cycle-signals` `summary` shape changed — **COSMETIC (today), NUMERIC-RISK if re-consumed**
**Trigger:** always.
`v0 summary.<gauge> = {date, value}` with `value` rounded to 6 dp (`late-cycle-signals.js:284-289`);
`v1 summary.<gauge> = {latest}` unrounded, no date (`research-signals.ts:286-292`). A consumer typed
against v0 (`robotmoney-site/src/app/research/late-cycle-signals/page.tsx:14-22`, which reads
`.value`/`.date`) would render `—` for all five gauges against a v1 payload.
**Why cosmetic today:** v1's own research views read `gauges[]` exclusively — a grep of
`frontend/public/views/research/{late-cycle-signals,channel-divergence}.html` finds `gauges` and
`percentile` and **no** reference to `summary` or `indicators`. The v0 headline numbers survive as
`gauges[*].percentile` / `gauges[*].value` (I verified they carry the same values in the harness:
concentration 0.149, top7 0.278, mna 0.577, margin_yoy 0.000107, conf 49.28). Note the corollary:
**the entire `indicators` map and `summary` block that v1 computes are currently dead payload** —
persisted but never rendered.

### F3 — `channel-divergence` "latest" semantics: last-index vs last-finite — **NUMERIC-RISK (latent)**
**Trigger:** the final date on the axis is NaN for a series while an earlier date is finite.
v0 `summarize` takes `arr[dates.length-1]` verbatim (`channel-divergence.js:181,187-189`); v1 takes
`lastFinite(arr)` (`research-signals.ts:147,150-151`). Under forward-filled dense axes this is
unreachable for BTC/QQQ-derived series, which is why the harness saw identical values. It becomes
reachable if the axis is extended past the last observation without forward-fill, or if `qqq === 0`
on the final day. v1's behaviour is the more defensible one; it is nonetheless *not* v0's.
(Note the asymmetry: v0's *late-cycle* `latestOf` already scans backwards for the last finite value,
so only the channel script has the raw-last-index rule.)

### F4 — v1's channel `gauges` mix two incompatible percentile definitions — **NUMERIC-RISK**
**Trigger:** always, on every rendered channel-divergence page.
`math.ts:31-34` `percentileInWindow(v, w) = count(x ≤ v)/n` — a **full-history**, no-minimum-obs,
`≤`-inclusive fraction. `math.ts:176-195` `rollingPercentileRank` — a **trailing-756-day**,
`≥30`-obs-gated **midrank** `(below + 0.5·equal)/n`. `research-signals.ts:149,153` use the former
for `BTC_BETA` and `STABLES_QQQ_FLOW`; `:150` uses the latter for `BTC_QQQ_RATIO`. The `CHANNEL`
composite (`:155,161`) averages all three, so it blends a full-sample statistic (which mechanically
drifts as history grows, and is look-ahead-contaminated relative to the walk-forward discipline the
rest of the pipeline maintains) with a point-in-time rolling rank. The `read` thresholds
(`≥0.6` / `≤0.35`, `:120`) then bucket that blend with **no hysteresis or confirmation delay** —
unlike the regime classifier, which debounces via `CONFIRMATION_DAYS=5` + `FAST_TRACK_SIGMA=2.0`
(`compute.ts:168-170`). v0 published none of these, so this is new surface area, not a regression —
but it is the number the v1 research page actually shows.

### F5 — M&A input provenance changed from full re-crawl to incremental + 2-month revision window — **NUMERIC-RISK**
**Trigger:** any EDGAR revision landing on a month older than 2 months.
v0 re-fetches **every** month from 2010 on every run (`late-cycle-signals.js:220-251`), so any EDGAR
back-revision is picked up indefinitely. v1 plans only missing months plus
`EDGAR_REVISION_WINDOW_MONTHS = 2` (`extract/edgar-fetch-plan.ts:28`) against the persisted floor
(`edgar-incremental-refresh.ts`), so a revision to e.g. a 2023 month never lands and the persisted
value diverges permanently. The URL, count parse, and month-end stamping are otherwise identical
(`extract/edgar.ts:23,39,45-49`).
Secondary, in v1's favour: v1 **refuses to publish** the whole late-cycle signal when the refresh
degrades (`index.ts:330-342`), where v0 published with silent month gaps (`:247-249`).

### F6 — `research-fidelity.test.ts` does not execute either shipped research function — **NUMERIC-RISK (false confidence)**
`backend/tests/research-fidelity.test.ts:51-80` re-implements the ratio/flow/pct pipeline inline
from `math.ts` primitives and compares against the vendored `channel-divergence.json.gz`. It never
imports `computeChannelDivergence` or `computeLateCycle` — a repo-wide grep for those two symbols in
`backend/tests/` returns **zero** hits. So the file named "research fidelity" proves the *helpers*
reproduce v0, not that the *shipped signal functions* do. My harness closes that gap for the series
outputs; nothing in CI does. (This is exactly the PR #464 pattern: a truthful-sounding test name
over a parallel implementation.)

### F7 — Two dead, mathematically-different research tools remain in the tree — **NUMERIC-RISK (trap)**
`backend/src/analytics/analyze/channel-divergence.ts` and `analyze/late-cycle.ts` implement the same
two signals from `ctx.provider.getSeries(...)` — the **synthetic seeded random walk**
(`access/provider.ts:24-46`) — over 210/260-day windows with full-history `percentileInWindow`, no
STABLES leg, no top-7 basket, no margin/conf real sources, and a `SPY`-return fallback of `0`
(`channel-divergence.ts:25`). They are registered in **no** `Registry`
(grep for `channelDivergenceTool`/`lateCycleTool` finds only their own definitions plus
`backend/tests/analytics.test.ts:5-6`), and that test asserts only shape
(`percentile ∈ [0,1]`, `read ∈ {…}` — `analytics.test.ts:44-62`). They share filenames with the v0
scripts they do **not** implement; a future maintainer wiring "the channel-divergence tool" into the
registry would ship synthetic numbers to production. Recommend deletion or a loud `@deprecated`
+ hermetic-only rename.

### F8 — Hardcoded anchors carried by the frozen artifacts — **COSMETIC**
`weighting-comparison.js:44` hard-anchors its final phase to `2026-05-12`; `regime-eq-comparison.js:43`
uses `2099-12-31`. The two scripts also compute phase CAGR differently — eq-comparison over the
**actual data span** (`:196`), weighting-comparison over the **nominal phase length** (`:221`) —
and eq-comparison honours `align: 'zero_fill'` indicators (`:63`) while weighting-comparison
forward-fills everything (`:63`). These are pre-existing v0 inconsistencies; they matter only as a
spec for whoever ports these scripts, since a "clean" port would silently change the published
numbers.

---

## What I could not determine

1. **Whether the two frozen artifacts are still *correct* for their stated `asof`.** I proved the
   bytes match v0, not that v0's own generator would reproduce them if re-run — that needs the
   v0 `raw-indicator-history.csv` and `regime-snapshot.json` as they stood on 2026-05-30 / 2026-05-14.
2. **Live-source numeric parity.** Both harness arms ran on synthetic inputs so the two
   implementations were compared under identical data. I did **not** hit Yahoo/FRED/EDGAR, so I
   cannot rule out a divergence originating in the fetch/parse layer — though `extract/yahoo.ts:16-30`
   is a faithful port of `fetchers/yahoo.js:24-38` (same adjclose→close fallback, same NaN drop,
   same UTC day derivation) and `extract/edgar.ts:23,45-49` matches `late-cycle-signals.js:255,273-274`.
   `extract/fred.ts` was not read.
3. **Whether v1's persisted `STABLES` floor equals v0's CSV column.** v1 reads it from Postgres
   `raw_indicator_history` after a `mergeSeries` against fresh fetches (`index.ts:296`); v0 reads the
   CSV. `mergeSeries` is a verbatim port (`math.ts:356-376` ≡ `utils.js:332-351`), but I did not diff
   the actual stored series against `data/regime/raw-indicator-history.csv`.
4. **Whether any consumer outside this repo depends on `summary.*.date`** (F2). Inside the repo,
   nothing does.
5. **Whether `asof` reaches `runAnalytics` as "today"** on the production schedule. I did not trace
   the worker/cron entry point, so I cannot confirm v0's "axis ends at the literal run date" is
   always reproduced.
6. **Whether the `frontend/public/data/*.json` fixtures are actually fetched at runtime** by the
   deployed blog pages or only by the Playwright specs — I read the spec header, not the page
   bundles.

---

## Grade counts

| | channel-divergence | late-cycle-signals | regime-eq-comparison | weighting-comparison |
|---|---|---|---|---|
| IDENTICAL (executed) | 10 | 16 | 0 | 0 |
| EQUIVALENT | 4 | 1 | 0 | 0 |
| DIVERGENT | 0 | 5 | 0 | 0 |
| MISSING | 0 | 0 | 10 | 7 |
| EXTRA (v1-only) | 6 | 5 | 0 | 0 |
