# A4 — Input Data Identity (v0 → v1)

Worker W4, v0→v1 mathematical parity audit. Audited 2026-08-03.

- **v0** = `/drive2/home/lucas/robotmoney/robotmoney-site` (production today), read-only.
- **v1** = this worktree, `backend/src/analytics/{extract,access,store}` + `backend/tests/fixtures/regime/raw-indicator-history.csv.gz`.

Every claim below is backed by an executed diff or a `path:line` read. Per the
PR #464 caveat, no in-repo comment or test name was accepted as evidence — where
a comment happened to agree with the measurement that is noted as corroboration,
not as the source.

---

## Verdict

**NO — v1's inputs are not identical to v0's.** v1 adds one composite-bearing
series (`BTC_MVRV`, 3102 rows) that v0's persisted floor has **zero** rows for,
and six factor-panel Yahoo ETF-ratio series differ in ~40% of their cells across
the whole 2018→2026 history from adjusted-close revision drift; the remaining 19
series are byte-identical over the certifiable window.

---

## 1. Series inventory parity

Both registries declare **26** indicators with **identical** ids, `source`,
`series`, `sign`, `transform`, and `panel` values
(v0 `scripts/regime/lib/indicators.js`, v1 `backend/src/analytics/analyze/indicators.ts`),
and both set `PANELS = ['macro','onchain']`
(v0 `lib/indicators.js:479`, v1 `analyze/indicators.ts:464`). Nothing was
renamed or dropped at the registry level.

The divergence is between the **registry** and the **persisted floor**:

| Series | Panel | v0 floor rows | v1 floor rows | Status | Weight impact |
|---|---|---|---|---|---|
| `BTC_MVRV` | onchain | **0** | **3102** | **ADDED (source repointed)** | **BLOCKS-PARITY** — enters the onchain panel index and the inverse-correlation weight normalisation for every other onchain indicator, on every date |
| `T10Y2Y` `DFII10` `T5YIE` `HY_OAS` `DXY` `ICSA` `VIX` `COPPER_GOLD` | macro | 3097–3098 (`HY_OAS` 1123) | 3101–3102 (`HY_OAS` 1127) | present | see §2 |
| `DEFI_TVL` `DEFI_GROWTH` `STABLES` `STABLES_GROWTH` `BTC_ACTIVE` `ETH_ACTIVE` `BTC_ETH` `ETH_TREND` `NEW_TOKENS` | onchain | 3098 (`NEW_TOKENS` 26) | 3102 (`NEW_TOKENS` 30) | present | see §2 |
| `SPX_TREND` `IWM_SPY` `SPHB_SPLV` `MTUM_SPY` `IWF_IWD` `XLU_SPY` `XLP_XLY` `SHILLER_CAPE` | factor | 3097–3098 | 3101–3102 | present | **not in the 2-panel composite**; in the eq/3-panel composite and on indicator pages |

`BTC_MVRV` root cause, both sides read directly:

- v0 `lib/indicators.js:268` → `source: 'blockchain_com', series: 'mvrv'`. That
  chart was removed upstream; `fetch_all.js:68-72` swallows the failure and
  returns `[]`, so `update.js:172-190` never writes a row.
- v1 `analyze/indicators.ts` → `source: "coinmetrics", series: { asset: "btc", metric: "CapMVRVCur" }`,
  and the floor was regenerated for it via `extract/floor-seed-generator.ts`.

Consequence in v0's own compute: `compute.js:55` puts `BTC_MVRV` in
`indsByPanel.onchain`, but `weightedMeanOnDay` (`compute.js:246-257`) skips
non-finite values, so an all-empty series contributes nothing. v1 gives it a
real nonzero weight. **The onchain panel index, the composite, and the regime
label therefore differ on every date in the record.** The repo's own
`backend/tests/regime-fidelity.test.ts:12-46` independently states this ("every
onchain-panel-derived number changes", and the golden reference "is no longer an
INDEPENDENT cross-implementation reference").

---

## 2. Empirical raw-history diff

Method: `gunzip` v1's `backend/tests/fixtures/regime/raw-indicator-history.csv.gz`
into `.audit-scratch/A4/v1-raw.csv`, diff against v0's
`data/regime/raw-indicator-history.csv` cell-by-cell keyed on `(indicator,date)`.
Both files share the header `date,indicator,value`. Scripts in
`.audit-scratch/A4/diff.py`.

| | v0 | v1 |
|---|---|---|
| Data rows | 72,385 | 75,587 |
| Distinct series | 25 | 26 |
| Date span | 2018-01-01 → **2026-06-25** | 2018-01-01 → **2026-06-29** |
| Duplicate `(date,indicator)` cells | 0 | 0 |

**Headline: 72,385 shared cells, 11,164 differ → 84.5769% byte-identical.**
Every v0 date is present in v1; v1 adds exactly 4 trailing days
(2026-06-26 … 2026-06-29) to all 25 shared series. No v0-only dates anywhere.

### Per-series (shared dates only; `maxrel` = max |Δ|/|v0|)

| Series | Panel | Shared | Differing | Identical % | max abs Δ | max rel Δ | Differing date range |
|---|---|---|---|---|---|---|---|
| `ICSA` | macro | 3093 | **0** | 100.000% | 0 | 0 | — |
| `T10Y2Y` | macro | 3097 | **0** | 100.000% | 0 | 0 | — |
| `T5YIE` | macro | 3097 | **0** | 100.000% | 0 | 0 | — |
| `VIX` | macro | 3097 | **0** | 100.000% | 0 | 0 | — |
| `SPX_TREND` | factor | 3097 | **0** | 100.000% | 0 | 0 | — |
| `SHILLER_CAPE` | factor | 3098 | **0** | 100.000% | 0 | 0 | — |
| `NEW_TOKENS` | onchain | 26 | **0** | 100.000% | 0 | 0 | — |
| `DFII10` | macro | 3097 | 1 | 99.968% | 0.04 | 1.794e-2 | 2026-06-25 |
| `HY_OAS` | macro | 1123 | 1 | 99.911% | 0.02 | 7.246e-3 | 2026-06-25 |
| `COPPER_GOLD` | macro | 3097 | 1 | 99.968% | 8.054e-6 | 5.319e-3 | 2026-06-25 |
| `BTC_ACTIVE` | onchain | 3098 | 1 | 99.968% | 34,636 | 7.097e-2 | 2026-06-25 |
| `ETH_ACTIVE` | onchain | 3098 | 1 | 99.968% | 8,703 | 1.027e-2 | 2026-06-25 |
| `BTC_ETH` | onchain | 3098 | 1 | 99.968% | 5.682e-2 | 1.491e-3 | 2026-06-25 |
| `ETH_TREND` | onchain | 3098 | 1 | 99.968% | 3.6134 | 2.304e-3 | 2026-06-25 |
| `STABLES` | onchain | 3098 | 1 | 99.968% | 1.459e+8 | 4.672e-4 | 2026-06-25 |
| `STABLES_GROWTH` | onchain | 3098 | 1 | 99.968% | 1.459e+8 | 4.672e-4 | 2026-06-25 |
| `DXY` | macro | 3097 | **4** | 99.871% | 2.1252 | 1.782e-2 | 2026-06-22 … 2026-06-25 |
| `DEFI_TVL` | onchain | 3098 | **6** | 99.806% | 8.433e+8 | 1.213e-2 | 2026-06-20 … 2026-06-25 |
| `DEFI_GROWTH` | onchain | 3098 | **6** | 99.806% | 8.433e+8 | 1.213e-2 | 2026-06-20 … 2026-06-25 |
| `XLP_XLY` | factor | 3097 | **1810** | 41.556% | 6.726e-7 | 8.081e-7 | 2018-01-02 … 2025-12-17 |
| `IWF_IWD` | factor | 3097 | **1847** | 40.362% | 3.781e-7 | 9.365e-7 | 2018-01-02 … 2025-12-12 |
| `XLU_SPY` | factor | 3097 | **1839** | 40.620% | 7.608e-8 | 9.255e-7 | 2018-01-02 … 2025-12-18 |
| `IWM_SPY` | factor | 3097 | **1850** | 40.265% | 7.103e-7 | 1.244e-6 | 2018-01-03 … 2026-03-19 |
| `MTUM_SPY` | factor | 3097 | **1835** | 40.749% | 3.695e-7 | 8.853e-7 | 2018-01-02 … 2026-03-11 |
| `SPHB_SPLV` | factor | 3097 | **1958** | 36.778% | 1.343e-6 | 1.378e-6 | 2018-01-02 … 2026-05-15 |
| `BTC_MVRV` | onchain | **0** | n/a | **no overlap** | n/a | n/a | v0 has no rows at all |

### Interpretation of the three diff clusters

**(a) Pervasive ~1 ppm drift on six factor series — Yahoo adjusted-close revision.**
Exactly the six ratios whose legs are *dividend-paying ETFs* (`IWM/SPY`,
`MTUM/SPY`, `IWF/IWD`, `XLU/SPY`, `XLP/XLY`, `SPHB/SPLV`) drift. Every ratio
whose legs pay no dividend is bit-identical to the last digit — `BTC_ETH`
(BTC-USD/ETH-USD), `COPPER_GOLD` (HG=F/GC=F futures), and the index series
`SPX_TREND` (^GSPC), `VIX` (^VIX). Sample cells:

```
2018-01-03,IWM_SPY,0.5841267811407848   (v0)
2018-01-03,IWM_SPY,0.5841265934551783   (v1)
2018-01-03,BTC_ETH,15.789638173702691   (both, identical)
2018-01-03,SPX_TREND,2713.06005859375   (both, identical)
```

This is not serialisation rounding — the mantissas diverge at the 7th
significant digit and only for the dividend-bearing legs. Both sides request
`adjclose` first (v0 `fetchers/yahoo.js:26-30`, v1 `extract/yahoo.ts:19,27`),
and Yahoo recomputes the split/dividend adjustment factor over the *entire*
history each time a new distribution is declared. The input is therefore
**revisable and not reproducible from a later fetch**.

**(b) Last-1-to-6-day differences — snapshot vintage + upstream restatement.**
v0's file was captured 4 days earlier than v1's. `DEFI_TVL` restates ~6 days
(DefiLlama recomputes recent TVL), `DXY` differs for 4 days because v0 was
captured before FRED published `DTWEXBGS` for 2026-06-22…25 and forward-filled
119.2868 across all four, while v1 has the real prints (120.5463 / 121.0552 /
121.412 / 121.0559). `BTC_ACTIVE`'s 7.1% last-day gap is a partial-UTC-day count.

**(c) `BTC_MVRV`** — 3102 rows in v1, 3102 distinct values, range consistent
with Coinmetrics `CapMVRVCur` (2.694 on 2018-01-01 → 1.132 on 2026-06-29).
No v0 counterpart at all.

### What the persisted CSV actually contains

v0 `update.js:138,172-190` writes the **forward-filled daily grid** (`aligned`),
not raw observations. v1's floor seed is a snapshot of that same grid. Verified
against the 3102-day axis 2018-01-01…2026-06-29: all series are dense except the
genuine leading gaps `HY_OAS` (starts 2023-05-30, 1975 missing) and `NEW_TOKENS`
(starts 2026-05-31, 3072 missing), plus one leading day for the business-day
series. Neither registry sets `align:`, so `alignDailyZeroFill` is dead code on
both sides.

Longest run of an identical value (empirical proxy for forward-fill age):

| Series | v0 | v1 |
|---|---|---|
| `SHILLER_CAPE` | **1029 d**, ends 2026-06-25 | **1033 d**, ends 2026-06-29 |
| `STABLES` / `STABLES_GROWTH` | **132 d**, ends 2018-06-09 | **132 d**, ends 2018-06-09 |
| `DEFI_TVL` / `DEFI_GROWTH` | 42 d | 42 d |
| `ICSA` | 21 d | 21 d |
| all others | ≤ 8 d | ≤ 8 d |

`SHILLER_CAPE`'s last real transition is **2023-09-01 → 30.81** on *both* sides;
it has been frozen for ~2.8 years. See §3 (shiller) for why v1 will break that
tie on its first live run.

---

## 3. Per-source semantics

| Source | v0 | v1 | Endpoint / dataset | Units & scaling | Price field | Timestamp & TZ | Revision / vintage | Resample & fill | Dedup | Grade |
|---|---|---|---|---|---|---|---|---|---|---|
| **FRED** | `fetchers/fred.js:19-23,32-44` | `extract/fred.ts:16-20,23-42` | identical `fredgraph.csv?id=&cosd=2010-01-01` | none, as published | n/a | FRED's own `DATE`, no TZ math | **Neither pins a vintage** (no ALFRED `realtime_*`) → both take latest revision at fetch time | `.` → dropped; daily grid + ff downstream | by-date map | **MATCH** (v1 adds `encodeURIComponent` (no-op for these ids), `.trim()` on date, 15 s abort) |
| **Yahoo** | `fetchers/yahoo.js:11-35` | `extract/yahoo.ts:16-31,35-54` | identical v8 chart, `period1=0&interval=1d&events=history` | none | `adjclose` if finite **else** `close` — identical rule both sides | `isoDay(ts*1000)` = `toISOString().slice(0,10)`, **UTC** both sides | **Adjusted close is retroactively restated** — measured, §2(a) | non-finite dropped; ratio on date-intersection (`fetch_all.js:75-86` ≡ `sources.ts:47-55`) | date-keyed | **MATCH on code, DIVERGENT on data** |
| **blockchain.com** | `fetchers/blockchain_com.js:15,22-27` | `extract/blockchain-com.ts:15-16,19-25` | identical `charts/n-unique-addresses?timespan=all&sampled=false` | none | n/a | `x*1000` → UTC day | append-only | non-finite dropped | date-keyed | **MATCH** (v1 throws on missing `values[]` where v0 returns `[]`; same net outcome) |
| **Coinmetrics** | `fetchers/coinmetrics.js:10-33` | `extract/coinmetrics.ts:13-18,23-55` | identical `v4/timeseries/asset-metrics`, `page_size=10000`, `start_time=2018-01-01`, ≤50 pages, `next_page_token` standalone | none | n/a | `row.time.slice(0,10)`, UTC interval start | append-only | non-finite dropped | date-keyed | **MATCH** — but v0 uses it only for `ETH_ACTIVE`; v1 also for `BTC_MVRV` |
| **DefiLlama TVL** | `fetchers/defillama.js:8-20` | `extract/defillama.ts:12-15,27-29` | identical `api.llama.fi/v2/historicalChainTvl` | USD | n/a | `date*1000` → UTC day | upstream restates ~6 d (measured) | non-finite dropped | date-keyed | **MATCH** |
| **DefiLlama stables** | `fetchers/defillama.js:22-37` | `extract/defillama.ts:18-24,32-34` | identical `stablecoincharts/all` | USD | n/a | UTC day | — | non-finite dropped | date-keyed | **NEAR-MATCH, divergent fallback** — v0 `:30` falls back to the raw `totalCirculatingUSD` object → `NaN` → **row dropped**; v1 `:22` falls back to `totalCirculating?.peggedUSD`, the **native-unit** aggregate, which would be silently accepted as if it were USD. Same branch on today's payload; divergent under a schema change |
| **GeckoTerminal** | `fetchers/geckoterminal.js:23-26,35-77` | `extract/geckoterminal.ts:31-40,138-193` | identical `networks/new_pools?page=N`, `MAX_PAGES=10`, 24 h window | count | n/a | `new Date().toISOString().slice(0,10)` ≡ `isoDay(now)`, UTC | current-day only, accumulated | — | — | **DIVERGENT** — see below |
| **multpl** | `fetchers/multpl.js:13,32-42` | `extract/shiller.ts:17,58-91` | same URL | ratio | n/a | `new Date("<Month D, YYYY> UTC")` both | monthly | dedup by ISO date, `>0` filter | `Set` | **DIVERGENT REGEX** — see below |
| **datahub** | `fetchers/shiller.js:20-21,35-69` | `extract/shiller.ts:15-16,22-51` | identical raw.githubusercontent CSV; same `PE10` column resolution incl. both fallback regexes | ratio | n/a | `YYYY-MM` → `YYYY-MM-01` both | mirror lags | `<=0` rejected both | sorted, deduped in merge | **MATCH** |
| **shiller merge** | `fetchers/shiller.js:73-124` | `extract/shiller.ts:95-148` | `Promise.allSettled`, multpl wins on overlap, datahub backfills, throw only if both fail | — | — | — | — | — | — | **MATCH** |

### GeckoTerminal — structural rewrite (`NEW_TOKENS`, onchain, sign −1)

- **Persistence moved.** v0 (`geckoterminal.js:70-100`) maintains its *own*
  floor at `data/regime/token-launches.csv`, records a `capped` flag per day,
  and returns the **full persisted history**. v1 (`geckoterminal.ts:192`)
  returns a **single point** and delegates accumulation to the orchestrator's
  append-only merge into `raw_indicator_history`. Net history is equivalent, but
  v1 loses the independent second floor and **discards the `capped`/`stopped`
  flag entirely** (computed at `:142,152`, never persisted).
- **Throttle behaviour differs.** v0 has no retry: a 429 on page > 1 breaks the
  loop (`geckoterminal.js:44-47`) and silently yields a **lower** count; a 429 on
  page 1 throws. v1 adds bounded retries — up to 5 attempts/page, `Retry-After`
  honoured, 45 s aggregate budget (`geckoterminal.ts:36-40,85-131`). Under
  throttling v1 will systematically record **higher** daily counts than v0 for the
  same day. The 26 shared historical cells are identical, so this is a
  **live-path-only** divergence.

### multpl — v1 fixes a v0 bug, which *breaks* input parity

v0's row regex (`multpl.js:32-42`) uses bare `\s*` before the value cell. v1
(`shiller.ts:58`) inserts `FILLER = (?:\s|&[#a-zA-Z0-9]+;|<a[^>]*>)*` to also
match the `&#x2002;` EN-SPACE entity that multpl.com now emits. The empirical
record corroborates that v0's scraper is dead: `SHILLER_CAPE`'s last real print
on **both** floors is 2023-09-01 = 30.81, forward-filled 1029/1033 days since. On
a live run v1 recovers a current CAPE while v0 keeps carrying 30.81 — their
`SHILLER_CAPE` inputs diverge from v1's first live fetch onward. `SHILLER_CAPE`
is `panel: 'factor'`, so this misses the 2-panel composite but hits the eq
3-panel composite (v0 `update.js` `computeRegime(..., ['macro','onchain','factor'])`;
v1 `analytics/index.ts:226`) and the indicator pages.

### Cross-cutting: forward-fill expiry (#402) — v1-only, currently inert

v0 forward-fills without bound (`update.js:800-812`, `lib/utils.js`). v1 leaves
`alignDailyForwardFill` unchanged (`transform/math.ts:278-290`) but the
**production** orchestrator computes `forwardFillAge` (`index.ts:222`) and passes
`ages` into `computeRegime` (`index.ts:225`), which NaNs any day whose age
exceeds `MAX_FORWARD_FILL_DAYS = 120` (`analyze/compute.ts:70,74-81`).

Measured effect on the current floor: **none.** Because v0 persists the
*forward-filled grid* rather than raw observations, every axis date within the
floor's coverage carries a row, so `forwardFillAge` reads 0 everywhere and the
cap cannot fire — verified by the density check above (all series dense except
genuine leading gaps). The cap becomes active only for dates **beyond**
2026-06-29 where a source genuinely stops printing. It is a **forward**
divergence from v0, not a historical one.

Coverage gap: `backend/tests/regime-fidelity.test.ts:85` calls
`computeRegime(transformed, dateAxis)` **without** `ages`, so the replay test
does not exercise the cap that production applies.

### Cross-cutting: fetch cache and hermetic substitution

- `extract/fetch-cache.ts:40-42` memoises GET bodies for 1 h when `DEMO_MODE` is
  set; prod/CI TTL is 0 (off). No prod parity impact; under `DEMO_MODE` inputs
  can be up to 1 h staler than v0's.
- `access/hermetic-source.ts:37-49` — with `ANALYTICS_SOURCE=hermetic` (the demo
  and CI e2e path) **every** series is replaced by a deterministic seeded random
  walk. Any parity observed on the demo surface is vacuous; parity claims must be
  validated against `liveDataSource` (`access/data-source.ts:107-155`) only.
- v1 adds hard fetch timeouts (8 s default, 15 s for these callers,
  `extract/http.ts:16-57`) where v0 has none. A slow-but-healthy upstream that v0
  would wait for makes v1 fall back to the persisted floor.
- Backtest extras match: both fetch `^GSPC`, `ETH-USD` from 2010-01-01 and FRED
  `DTB3` (v0 `update.js:374-396`, v1 `access/data-source.ts:91,147-154`).

---

## 4. Certifiable date intersection

The window over which v1's inputs are **provably byte-identical** to v0's:

| Scope | Certifiable window | Notes |
|---|---|---|
| **Composite-bearing series (macro + onchain), excluding `BTC_MVRV`** | **2018-01-01 → 2026-06-19** | Verified by exact string comparison; first differing cell is `DEFI_TVL`/`DEFI_GROWTH` on **2026-06-20** |
| `HY_OAS` (within the above) | **2023-05-30 → 2026-06-19** | Both floors truncate identically; the `cosd=2010-01-01` fix never backfilled the persisted floor on either side |
| `NEW_TOKENS` (within the above) | **2026-05-31 → 2026-06-25** | 26 shared cells, all identical |
| `BTC_MVRV` | **empty — no certifiable window** | v0 has zero rows |
| Factor panel — `SPX_TREND`, `SHILLER_CAPE` | **2018-01-01 → 2026-06-25** | 100% identical over every shared cell |
| Factor panel — the six ETF ratios | **none** | differences begin **2018-01-02**, the first shared date |
| Beyond 2026-06-25 | **none** | v0's floor ends there |

**Bottom line for "any period, any metric":** the 2-panel composite is
certifiable over **2018-01-01 → 2026-06-19 only if `BTC_MVRV` is excluded from
the onchain panel**. With `BTC_MVRV` admitted, as v1 does, there is **no
certifiable window at all** for the composite.

---

## 5. Findings

### BLOCKS-PARITY

1. **`BTC_MVRV` is present in v1's floor and absent from v0's.** 3102 rows vs 0.
   `panel: 'onchain'` on both sides, and `PANELS` includes `onchain`, so it enters
   the panel index and the inverse-correlation weight normalisation. Every
   onchain-derived number — panel index, composite, percentile, regime label —
   differs from v0 on every date. Corroborated by
   `backend/tests/regime-fidelity.test.ts:12-46`, which also records that the
   golden fixtures were regenerated from v1 itself and are therefore no longer an
   independent reference.
   *v0:* `scripts/regime/lib/indicators.js:268`; *v1:* `backend/src/analytics/analyze/indicators.ts` (`BTC_MVRV`), `backend/src/analytics/extract/floor-seed-generator.ts:72-88`.

2. **Six factor-panel Yahoo ETF ratios differ across the entire history.**
   1810–1958 differing cells each (36.8–41.6% identical), from 2018-01-02 onward.
   Magnitude is small (max rel 1.38e-6) but non-zero and systematic, and it
   propagates into the eq 3-panel composite and every indicator-page number.
   Root cause is Yahoo's retroactive adjusted-close restatement — an *unfixable*
   property of the input, not a port defect. Any claim that v1 reproduces v0
   "byte-identically" over the factor panel is false.
   *v0:* `scripts/regime/fetchers/yahoo.js:26-30`; *v1:* `backend/src/analytics/extract/yahoo.ts:19,27`.

### NUMERIC-RISK

3. **multpl scraper fixed in v1 only.** v1 parses the current markup; v0 cannot.
   `SHILLER_CAPE` has been frozen at 30.81 since 2023-09-01 on both floors
   (1029/1033-day flat run). v1's first live run breaks the tie and the two
   `SHILLER_CAPE` series diverge permanently. Factor panel → eq composite and
   indicator pages, not the 2-panel composite.
   *v0:* `scripts/regime/fetchers/multpl.js:32-42`; *v1:* `backend/src/analytics/extract/shiller.ts:58-69`.

4. **DefiLlama stables fallback resolves to a different quantity.** v0 falls back
   to the `totalCirculatingUSD` object → `NaN` → row dropped (a loud gap). v1
   falls back to `totalCirculating?.peggedUSD`, the native-unit aggregate, which
   is a finite number and would be silently ingested as USD. Same branch on
   today's payload; divergent the moment DefiLlama changes shape.
   *v0:* `scripts/regime/fetchers/defillama.js:30`; *v1:* `backend/src/analytics/extract/defillama.ts:22`.

5. **GeckoTerminal throttle handling differs.** v1 retries 429/5xx (5 attempts/page,
   45 s budget); v0 breaks out and under-counts. v1 will record higher
   `NEW_TOKENS` counts than v0 on throttled days. `NEW_TOKENS` is onchain,
   sign −1, so a higher count pushes the composite the *other* way.
   *v0:* `scripts/regime/fetchers/geckoterminal.js:44-47`; *v1:* `backend/src/analytics/extract/geckoterminal.ts:85-131`.

6. **Forward-fill expiry (#402) is a v1-only rule with no v0 equivalent.**
   Currently inert over the vendored floor (density verified), but active for any
   date past 2026-06-29 where a source stops printing — and *not* exercised by the
   fidelity replay, which omits `ages`.
   *v1:* `backend/src/analytics/analyze/compute.ts:70,74-81`, `backend/src/analytics/index.ts:222,225`; test gap at `backend/tests/regime-fidelity.test.ts:85`.

7. **Snapshot vintage skew.** v1's floor is 4 days newer, and the last 1–6 days of
   nine series differ materially (`BTC_ACTIVE` 7.1%, `DXY` 1.78% over four days,
   `DEFI_TVL` 1.21% over six, `DFII10` 1.79%). Any comparison that includes the
   tail of either file compares different vintages, not different code.

8. **No vintage pinning on revisable FRED series.** Neither side uses ALFRED
   `realtime_start`/`realtime_end`. `ICSA` (annual seasonal-factor revisions) and
   `DTWEXBGS` silently rewrite history on both sides, so neither v0 nor v1 is
   reproducible from a later fetch. Shared limitation, but it means "identical
   inputs" can never be guaranteed by re-fetching — only by pinning the floor.

9. **Hermetic substitution on the demo/e2e path.** `ANALYTICS_SOURCE=hermetic`
   replaces all inputs with seeded random walks. Parity must never be signed off
   from a demo or e2e observation.
   *v1:* `backend/src/analytics/access/hermetic-source.ts:37-49`.

### COSMETIC

10. `NEW_TOKENS` `capped` flag is computed but discarded in v1
    (`extract/geckoterminal.ts:142,152`); v0 persists it in `token-launches.csv`.
    Unused by compute on either side, but v1 loses the provenance signal and the
    independent second floor.
11. v1 adds hard fetch timeouts and `encodeURIComponent` on ids/symbols; both are
    behaviour-preserving for the current id set.
12. `HY_OAS` starts 2023-05-30 on both sides despite the `cosd=2010-01-01` fix —
    the append-only floor was never backfilled. Identical on both sides, so not a
    parity issue, but it leaves ~3.1 y of history against a
    `ROLLING_WINDOW_DAYS = 1095` window.

---

## 6. What I could not determine

- **Whether v1's live path reproduces v0's live path**, as opposed to the two
  vendored/persisted files. I diffed artefacts, not two live runs. No network
  fetch was performed; every upstream-behaviour claim about revisions and
  throttling is inferred from the artefacts plus code reads.
- **The true forward-fill age of the original observations.** Because both sides
  persist the forward-filled grid rather than raw prints, I used longest-flat-run
  as a proxy. A genuinely repeated value would be indistinguishable from a
  carried one. This matters only for the #402 analysis, whose conclusion
  (currently inert) rests on the density check, which is exact.
- **Whether v0's floor would still be reproducible today.** v0's
  `raw-indicator-history.csv` is a static file last written 2026-06-25. I did not
  re-run v0's `update.js` (read-only constraint), so I cannot say what v0 would
  produce from a fresh fetch — only that Yahoo drift and FRED revisions guarantee
  it would not reproduce its own committed file exactly.
- **The exact composite/regime-label delta caused by `BTC_MVRV`.** I established
  that it is admitted with a real weight and therefore changes every
  onchain-derived number; quantifying the shift is the compute-side worker's
  scope, not the input half.
- **Provenance of the 4-day extension.** I could not find a manifest recording
  when or by which run v1's floor was captured at 2026-06-29 (unlike the EDGAR
  seed, which has `edgar-mna-seed.manifest.json`). The raw floor has no
  equivalent asof manifest.

---

*Scratch artefacts (not committed): `.audit-scratch/A4/{v1-raw.csv,diff.py}`.*
