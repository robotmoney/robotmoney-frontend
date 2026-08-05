# R8 — Residual attribution: `btc_beta` and the 2026 `late-cycle-signals` divergence

**Date:** 2026-08-03
**v0 (read-only):** `/drive2/home/lucas/robotmoney/robotmoney-site`
**v1 (under audit):** this worktree, base `main` @ `aa854ff` / `docs/v0-v1-quant-platform-parity-report.md` @ `7d52dd5`
**Scope:** attribute the two open residuals the consolidated parity report (`docs/v0-v1-quant-platform-parity-report.md`) flagged in §4 but did not fully explain: (a) `channel-divergence`'s `btc_beta` differing on 2,975/3,098 days at ~1e-4, (b) `late-cycle-signals`'s exact match in 2010–2025 vs. divergence in 2026.

**Method.** Sha-addressed replay per §7a/§7b/§6a-6.4 of the parity report: no live fetch, no network. v0 commits its raw floor and its published research JSONs atomically, so the exact vintage that ended up in v1's vendored fixtures is recoverable with `git show <sha>:<path>` against the read-only v0 checkout. Scripts and the exact JSON snapshots used are committed to `.audit-scratch/R8/` in this worktree (not tracked in git — same convention as the original audit's scratch space) for reproducibility.

---

## Vintage identification

`git log --format="%H %ad %s" -- public/data/channel-divergence.json` and the same for `public/data/late-cycle-signals.json`, run against v0, both terminate at:

```
d73f8bc091f3acfa04e50f171a1133fdfa1cd14d  Thu Jun 25 23:08:02 2026 +0000  "Daily research signals update: 2026-06-25"
```

`git show --stat d73f8bc0` touches both files in one commit (channel-divergence rewritten in full — 11,390 changed lines — because every day's rolling beta/percentile recomputes; late-cycle-signals touched only 2 lines, because it updates on a slower/weekly-sampled cadence). `git diff d73f8bc0..HEAD -- public/data/channel-divergence.json public/data/late-cycle-signals.json` is empty — v0's working tree at `4a1c4639` is byte-identical to `d73f8bc0` for both files, i.e. **`d73f8bc0` is the exact vintage sha for both real v0 artifacts.**

**Correction to the parity report's provenance note.** §4 and B1 cite `df5ee09` as the commit these fixtures are "untouched since." That is correct but is a **frontend-repo (v1) commit** (`df5ee0989c507337e2dcc1dbfe3a48a8b7c38f07`, "Reproduce the original site's analytics signals (real data, validated) (#9)", this repo, 2026-07-01) — it records when the fixture bytes were *vendored into v1*, not the v0 vintage those bytes represent. The v0 vintage is `d73f8bc0`, established above. Both facts are true and non-contradictory; they answer different questions and should not be conflated when this doc is cited elsewhere.

**Correction to the task brief's premise for residual (a).** `data/regime/raw-indicator-history.csv` does **not** carry raw `BTC-USD` or `QQQ` price columns — verified: `cut -d, -f2 data/regime/raw-indicator-history.csv | sort -u` at v0 lists 25 indicator ids (`BTC_ACTIVE, BTC_ETH, COPPER_GOLD, DEFI_GROWTH, DEFI_TVL, DFII10, DXY, ETH_ACTIVE, ETH_TREND, HY_OAS, ICSA, IWF_IWD, IWM_SPY, MTUM_SPY, NEW_TOKENS, SHILLER_CAPE, SPHB_SPLV, SPX_TREND, STABLES, STABLES_GROWTH, T10Y2Y, T5YIE, VIX, XLP_XLY, XLU_SPY`), none of which is a raw `BTC-USD`, `QQQ`, or `SPY` price. `channel-divergence.js:63-68` fetches those three directly from Yahoo inside the script and never persists them to the shared raw floor — the **only** place vintage-pinned BTC/QQQ prices are ever committed is inside `public/data/channel-divergence.json` itself (`btc_price[]`, `qqq_price[]`). That is what this investigation reads instead, and it is a strictly more direct source of truth for this question than the CSV would have been.

---

## Residual (a): `btc_beta` — mostly attributed, not fully closed

### What was compared

`git show d73f8bc0:public/data/channel-divergence.json` (v0, real) vs. `zcat backend/tests/fixtures/regime/channel-divergence.json.gz` (v1's vendored fixture), matched on the shared date prefix (v0 = 3,098 days, 2018-01-01 → 2026-06-25; v1's fixture extends 4 further days to 2026-06-29 and its first 3,098 dates are byte-identical to v0's date axis — verified).

### The three input legs, individually

`channel-divergence.js:76-88` computes `beta = rollingBeta(btcRet, qqqRet − spyRet, 90)`. Three legs feed it: BTC price, QQQ price, SPY price. Only the first two are ever emitted in the output JSON.

| Leg | Differing dates | Magnitude |
|---|---|---|
| `btc_price` | **1 / 3,098** | `2026-06-25`: v0 = 59,813.820313, v1 = 59,721.675781, abs Δ **92.14**, rel Δ **1.54e-3**. Every other date bit-identical. |
| `qqq_price` | 2,198 / 3,098 (71.0%) | max rel Δ **5.93e-7**, mean rel Δ 1.55e-7. Ratio `v1/v0` oscillates both above and below 1.0 (min 0.99999941, max 1.00000059) — the same tiny, bidirectional, ~1e-7-scale float noise already characterized elsewhere in the audit for Yahoo adjusted-close series (§6a item 6.1, D12, A4), not a one-directional dividend rescale. |
| `spy_price` | **not emitted anywhere in this artifact** — cannot be vintage-compared directly. |

`btc_price`'s single differing date is exactly `2026-06-25` — the **last day of v0's window** — and BTC-USD trades 24/7, so "the close for calendar day D" depends on the exact minute the fetch ran; this is the same "partial-UTC-day capture" signature the parity report already established for `BTC_ACTIVE` at this identical date (§7a: `BTC_ACTIVE` 2026-06-25, rel Δ 7.10e-2). It is a capture-time artifact, not a restatement.

### `btc_beta` itself

| | |
|---|---|
| Differing dates | **2,975 / 3,098 (96.0%** of the aligned window; 2,975/3,009 = **98.9%** of days where both sides classify, i.e. after the 90-day warm-up) |
| Magnitude, 2018–2025 | max abs Δ by year: 2.37e-4 (2018), 3.90e-4 (2019), 4.17e-4 (2020), 2.44e-4 (2021), 1.69e-4 (2022), 1.04e-4 (2023), 9.80e-5 (2024), 7.90e-5 (2025) |
| Magnitude, 2026 | jumps to **2.733e-3** — one order of magnitude above every prior year, and it occurs on exactly one date |
| Where the 2026 spike lands | `2026-06-25`: v0 = 0.659668, v1 = 0.656935, Δ = **0.002733**. Scanned every day in the trailing-90-day window ending `2026-06-25` (`2026-03-27`…`2026-06-25`) for Δ > 5e-4: **only `2026-06-25` itself exceeds it.** |

The 2026 spike is fully explained by `btc_price`'s single differing date: `pctChange` with `lag=1` means only the **return realized on** `2026-06-25` (computed from `btc_price[2026-06-25]` vs. `btc_price[2026-06-24]`) is affected, and that return enters exactly one rolling-90 window — the one ending on that day. That is the capture-vintage-tail mechanism, cleanly isolated to one point.

**The pre-2026 baseline (~1e-4, present on nearly every day back to 2018) is the open part.** `btc_price` is proven bit-identical before `2026-06-25`, so it cannot be the cause. To test whether `qqq_price`'s tiny, measured drift is sufficient on its own, I re-implemented `rollingBeta`/`pctChange` verbatim from `channel-divergence.js:76-88,131-152` in Python (`.audit-scratch/R8/recon-r8.py`) and ran a marginal-sensitivity test: hold `btcRet` fixed at v0's real value and the SPY leg **identically excluded on both sides** (`riskFactor := qqqRet` alone — not the real formula, but isolates the QQQ leg's own contribution under the real algorithm), then swap only `qqqRet0` → `qqqRet1`:

| | n (both sides finite) | max | mean | median | p95 |
|---|---:|---:|---:|---:|---:|
| **QQQ-leg-only marginal \|Δbeta\|** (SPY excluded, both sides) | 3,009 | 9.68e-5 | 6.47e-6 | 2.91e-6 | 2.30e-5 |
| **Real total \|Δbeta\|** (v0-real vs. v1-fixture, published) | 3,009 | 2.73e-3 | 5.67e-5 | 3.60e-5 | 2.02e-4 |

**QQQ's own measured drift, run through the real algorithm, accounts for roughly 8–10% of the observed real divergence** (median ratio real/marginal ≈ 10.0×; the QQQ-only marginal effect is smaller than the real effect on every one of the 2,968 comparable days I inspected in this run). BTC is eliminated (bit-identical pre-2026-06-25). That leaves the un-emitted SPY leg as the only remaining candidate to explain the other ~90%, by construction of the formula (three inputs, two eliminated/bounded, one unmeasured).

### Corroborating, not conclusive, evidence for SPY

SPY is not output by `channel-divergence.js`, but it **is** output by the sibling script `late-cycle-signals.js` (also a direct Yahoo `SPY` fetch, `late-cycle-signals.js:76`), at the same v0 vintage sha `d73f8bc0`. Comparing that `spy_price` series (v0 real vs. v1's fixture) shows the identical tiny, bidirectional pattern as `qqq_price`: max rel Δ ≈ 9.12e-8 on the differing dates (see residual (b) table below) — same order of magnitude as `qqq_price`'s 5.93e-7. This is consistent with SPY undergoing the same restatement-scale drift as QQQ and therefore being large enough, combined with variance amplification through the OLS ratio (the risk factor `qqqRet − spyRet` is a difference of two highly-correlated broad-market series, so its variance is small relative to either leg's own variance — dividing by a near-cancelling denominator amplifies small numerator/denominator perturbations disproportionately), to plausibly supply the missing ~90%.

**This is not proof.** `late-cycle-signals.js`'s SPY fetch is a *different script*, a *different query window* (`START='2010-01-01'` vs. channel-divergence's `2018-01-01`), and a materially different *sampling grain* (weekly-stamped points in the output, vs. the dense daily series channel-divergence actually consumes internally) — it is evidence that SPY-as-an-asset is subject to comparable restatement-scale noise at this vintage pair, not a reconstruction of the exact daily SPY series `channel-divergence.js` actually used. v0's real daily SPY input to the beta calculation was never persisted anywhere (fetched, used, and discarded in the same script run) and is not recoverable from any committed artifact at any sha. Recovering it would require a live Yahoo fetch pinned to v0's original capture time, which is out of scope for this network-free, sha-addressed method.

### Verdict on residual (a)

**Partially attributed, not fully closed — and the partial attribution is itself decisive on the two things that matter most:**

1. **The large 2026 outlier (2.733e-3, the max in the whole series) is fully and precisely attributed**: it is the same BTC capture-vintage-tail effect already established elsewhere in the audit (§7a `BTC_ACTIVE`), isolated to the single date `2026-06-25`, propagating through exactly one 90-day trailing window via `pctChange`'s single-day return sensitivity. Zero residual mystery here.
2. **The pervasive ~1e-4-level, whole-history divergence is *not* explainable by the two legs that are directly measurable** (BTC: bit-identical pre-tail; QQQ: measured to supply only ~10% of the effect via a controlled marginal-sensitivity replay of the real algorithm). By elimination — the formula has exactly three inputs, and the procedure itself is proven port-faithful on identical inputs (parity report §11.1 / A3, `channel-divergence` graded IDENTICAL, 3,072/3,072 points equal under a synthetic-input harness) — **the un-emitted SPY leg is the only remaining candidate**, and independent (same-vintage, same-mechanism) evidence from the sibling `late-cycle-signals` artifact shows SPY is subject to comparably tiny restatement noise. This is a strong, logically-forced partial attribution, not a forced full story: **I could not directly observe v0's real daily SPY input at this vintage, because it was never committed anywhere, and closing that gap needs a live fetch that is out of scope here.**

Recommendation if full closure is wanted: add SPY as a fourth emitted field (or an intermediate `debug` field) in a future `channel-divergence.js`/`research-signals.ts` revision, purely for auditability — it costs nothing numerically and would make this exact question directly answerable at any future vintage without a live fetch.

---

## Residual (b): late-cycle-signals 2026 divergence — fully attributed, and it falsifies half the stated hypothesis

### What was compared

Same vintage pair, `d73f8bc0` (v0 real) vs. the vendored fixture (v1). All 11 `indicators.*` fields plus `spy_price`, restricted to shared 2026 dates (25 weekly-sampled dates, `2026-01-02` → `2026-06-19`, plus a handful of monthly/quarterly points).

### Field-by-field 2026 result

| Field | Diffs in 2026 | Magnitude | Category |
|---|---:|---|---|
| `spy_price` | 2 / 25 | max rel Δ 9.12e-8 | price / capture-vintage-tail |
| `indicators.concentration_cap_vs_equal` | 1 / 25 | rel Δ 2.85e-7 | price / capture-vintage-tail |
| `indicators.concentration_cap_vs_equal_pct` | 0 / 25 | — | clean |
| `indicators.concentration_top7_vs_spy` | **25 / 25** | rel Δ 5.2e-7 … 8.1e-7 | price / capture-vintage-tail |
| `indicators.concentration_top7_vs_spy_pct` | 0 / 25 | — | clean |
| `indicators.mna_s4_monthly` | **0 / 6** (all 2026 months shared) | — | **clean — EDGAR/MNA hypothesis falsified for this residual** |
| `indicators.mna_pct` | 0 / 25 | — | **clean — same** |
| `indicators.margin_debt_level` | 0 / 1 | — | clean |
| `indicators.margin_debt_yoy` | 0 / 25 | — | clean |
| `indicators.margin_debt_yoy_pct` | 0 / 25 | — | clean |
| `indicators.consumer_conf_level` | 0 / 4 (shared) | — | clean on the **shared** dates |
| `indicators.consumer_conf_pct` | **8 / 25** | abs Δ up to **0.019842**, rel Δ up to **96.8%** | see below — a distinct, much larger mechanism |

### Two mechanisms, cleanly separated by magnitude

**(i) Price-precision, ~1e-7 relative — `spy_price`, `concentration_cap_vs_equal`, `concentration_top7_vs_spy`.** Same bidirectional, tiny-magnitude pattern as `qqq_price` in residual (a); consistent with the capture-vintage-tail / Yahoo adjusted-close noise already established elsewhere in the audit. Immaterial — six orders of magnitude below the write precision that matters for any downstream decision.

**(ii) A genuine input-completeness gap, ~2e-2 absolute / up to 96.8% relative — `consumer_conf_pct`.** This is not price noise and not an EDGAR/MNA effect. Root cause, found by comparing the **raw** (non-percentile) `consumer_conf_level` observation counts near the tail:

```
v0 (@ d73f8bc0, captured 2026-06-25) consumer_conf_level, last 3 real points:
  2026-02-01: 56.6   2026-03-01: 53.3   2026-04-01: 49.8        (196 total non-null points)

v1 (fixture, captured later)         consumer_conf_level, last 3 real points:
  2026-03-01: 53.3   2026-04-01: 49.8   2026-05-01: 44.8        (197 total non-null points)
```

**v1's floor contains a real UMCSENT print for `2026-05-01` (value 44.8) that v0's floor never captured — not a revision to an existing print (every print v0 *does* have is bit-identical between the two vintages, confirmed on all 196 shared `consumer_conf_level` dates and all 65 shared `margin_debt_level` dates), but a wholly new data point.** 44.8 is markedly below the four prior prints (49.8, 53.3, 56.6, 56.4), so once it enters the trailing 756-day percentile-rank window that `consumer_conf_pct` computes (`late-cycle-signals.js` / `research-signals.ts` — algorithm itself already PROVEN-IDENTICAL, parity report §11.4/A3), it depresses v1's percentile relative to v0's for every date whose window includes it — exactly the 8 dates `2026-05-01` through `2026-06-19` that show the divergence, and none before.

Consistent with §6a item 6.4's replay method: the FRED `UMCSENT` source is monthly and v1's vendored fixture was captured 4 days later than v0's (`2026-06-29` vs. `2026-06-25`, per each side's `asof` field) — a capture-vintage gap wide enough to straddle one additional monthly release. This is squarely the **capture-vintage-tail** category the task hypothesized, just manifesting as a *missing monthly print* rather than a *Yahoo price restatement* — the same underlying "v1 captured later" fact, a different data source's discretization of it.

**The EDGAR/MNA hypothesis is directly falsified for this residual**: `mna_s4_monthly` and `mna_pct` are **bit-identical on every shared 2026 date**, including the months `2026-04`, `2026-05`, `2026-06` that would be inside the 2-month revision window described in the parity report's item 1.10 defect. That defect is real and separately documented elsewhere in the audit (it is a live-armed, presently-dormant divergence risk), but it is **not** what is causing the divergence measured here — there simply is no MNA divergence to attribute in this dataset at this vintage pair.

### Verdict on residual (b)

**Fully attributed, both parts:**
1. The trivial (~1e-7 relative) price-field noise in `spy_price` / `concentration_*` is the capture-vintage-tail / Yahoo-restatement mechanism, immaterial.
2. The material divergence (`consumer_conf_pct`, up to 96.8% relative) is a capture-vintage gap manifesting as one missing FRED `UMCSENT` monthly print in v0's floor relative to v1's — proven by direct inspection of the raw (pre-percentile) observation counts, not inferred.
3. The EDGAR 2-month revision-window hypothesis is **ruled out** as a contributor to this specific residual: `mna_s4_monthly`/`mna_pct` are exact on every shared 2026 date.

No open question remains for residual (b).

---

## Summary table

| Residual | Attribution status | Dominant cause | Magnitude explained | Residual unexplained |
|---|---|---|---|---|
| (a) `btc_beta`, 2026 spike (2.733e-3, the series max) | **Fully attributed** | BTC capture-vintage-tail (single date, `2026-06-25`) | 100% | none |
| (a) `btc_beta`, whole-history baseline (~1e-4, 2018–2025) | **Partially attributed** | QQQ leg proven to supply ~10%; SPY leg (never persisted, unmeasurable directly) is the only remaining candidate by elimination, with corroborating same-vintage evidence of comparable SPY drift | ~10% directly measured; remainder logically forced onto SPY but not directly observed | ~90%, blocked on SPY never being emitted anywhere — needs a live fetch or an instrumentation change, not more replay |
| (b) `late-cycle-signals`, 2026 price fields | **Fully attributed** | Capture-vintage-tail (Yahoo price noise) | 100% | none |
| (b) `late-cycle-signals`, `consumer_conf_pct` (up to 96.8% rel) | **Fully attributed** | Capture-vintage gap = one missing FRED UMCSENT print in v0's floor (`2026-05-01`) | 100% | none |
| (b) EDGAR/MNA hypothesis | **Falsified for this residual** | `mna_s4_monthly`/`mna_pct` exact on every shared 2026 date | n/a | n/a |

## What I could NOT settle

- v0's real daily SPY price series at the `d73f8bc0` vintage, as actually consumed by `channel-divergence.js`'s `rollingBeta`. It was fetched, used, and discarded in the same script run and is not committed to any artifact at any v0 sha. The late-cycle-signals `spy_price` series is corroborating (same asset, same restatement mechanism, same vintage pair) but is not a substitute — different fetch window, different sampling grain. Closing this fully requires either a live Yahoo fetch pinned to v0's exact original capture time (out of scope, no network used in this investigation per the audit's established method) or a code change that persists the SPY leg for future auditability.
- Whether the ~10%/~90% split measured here (QQQ leg vs. inferred SPY leg) generalizes to other date ranges — it was measured once, in aggregate, over the full 2018–2025 window; I did not re-run the marginal-sensitivity test per year or attempt to bound the SPY contribution's plausible range analytically (e.g. from Yahoo's known typical restatement magnitude) rather than by elimination.
