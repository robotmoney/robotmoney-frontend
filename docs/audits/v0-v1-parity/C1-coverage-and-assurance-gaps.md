# C1 — Coverage and assurance-gap map (v0 → v1 mathematical parity)

Worker W6. Audit date 2026-08-03. v1 under audit at branch
`adhoc/20260803-160300-v0-v1-mathematical-parity-audit` (base `main` @ `aa854ff`).
v0 read at `/drive2/home/lucas/robotmoney/robotmoney-site` (production checkout,
data vintage `asof = 2026-06-25`).

---

## Verdict

**5 of roughly 33 in-scope v0 metric families (~15%) are under a genuine
independent v0 cross-check today; the entire regime core — composite, panel
indices, percentiles, regime labels, correlations and backtest — is under
*zero* independent v0 assurance, because all four of its baseline fixtures were
regenerated from v1's own pipeline by PR #444, and a direct comparison against
v0's still-present production file shows v1's committed golden differs from v0
on 100% of `composite` rows (max 0.0768) and on the user-visible `regime` label
for 153 of 2,960 days (5.17%).**

---

## 0. The headline measurement (nobody had run this)

`docs/architecture.md` and every regime fidelity test treat
`backend/tests/fixtures/regime/regime-history.csv.gz` as "the committed ground
truth". It is not v0's file. v0's actual production artifact
(`/drive2/home/lucas/robotmoney/robotmoney-site/data/regime/regime-history.csv`,
2,960 rows, `v3`, through 2026-06-25) is still on disk and was never compared
against. Direct diff over the 2,960 common dates:

| column | max abs diff | date | rows > 1e-6 |
|---|---|---|---|
| `macro_index` | 0.106396 | 2026-06-06 | 30 / 2960 (1.0%) |
| `onchain_index` | 0.123763 | 2018-06-01 | 2960 / 2960 (**100%**) |
| `composite` | 0.076828 | 2026-06-13 | 2960 / 2960 (**100%**) |
| `composite_percentile` | 0.340425 | 2018-06-01 | 2728 / 2960 (92.2%) |
| `macro_percentile` | 0.168036 | 2026-06-06 | 27 / 2960 (0.9%) |
| `onchain_percentile` | 0.340425 | 2018-06-01 | 2824 / 2960 (95.4%) |

| label | mismatched days |
|---|---|
| `macro_regime` | 0 / 2960 (0.00%) |
| `onchain_regime` | **289 / 2960 (9.76%)** |
| `regime` (the headline user-visible label) | **153 / 2960 (5.17%)** |

**Attribution.** Comparing the two raw floors indicator-by-indicator, the only
structural differences are (a) `BTC_MVRV`, present in v1's floor with 3,102 rows
and entirely absent from v0's (0 rows), and (b) a four-day vintage lead
(v1 floor ends 2026-06-29, v0's 2026-06-25). Every other one of the 25 shared
indicators matches in row count to within those same four days. So the
divergence is *consistent with* being fully explained by issue #400's
intentional `BTC_MVRV` admission, not by a port defect.

That is the charitable reading and it is probably right. But it is
**unverified**, and the two facts the owner needs are both true regardless:

1. For 153 historical days, v1 shows a different regime label than v0 shows for
   the same date. If the owner's requirement is "for any period and any metric,
   v1 equals v0", that requirement is **already violated and measurable**, and
   the violation is intentional but was never quantified.
2. No test in the repo would have caught it, because the baseline that would
   have caught it was replaced by v1's own output in the same PR that caused
   the change.

---

## 1. The declared v1 scope boundary

Quoted verbatim from `docs/architecture.md:14-47` (§1 Goals & scope):

> ## 1. Goals & scope
>
> - **Preserve the marketing UI** of robotmoney.net (reproduce the look exactly).
> - **Cherry-pick two feature areas**: the **regime/research** data views (the
>   regime classifier + its regime-family research signals) and the **Investment
>   Swarm**. Allocation / vault / wallet dashboards are out of scope, **except**
>   the `/allocation` page's vault-economics slice (TVL, share price, adapters,
>   7-day APY), brought into scope by a live Base RPC pipeline — see
>   [decisions.md §D15](…) and §10 below — **and** the prop-wallet valuation feed
>   (live holdings + history behind `GET /api/dashboards/wallet-balances`),
>   brought into scope the same way — see [decisions.md §D16](…) and §10 below.
>   Buybacks — the last static remnant of that line — were brought into scope by
>   [decisions.md §D17](…): `GET /api/dashboards/buybacks` is served live from
>   ROBOTMONEY Transfer logs (`backend/src/chain/buyback-logs.ts`, refreshed by
>   the `buybacks.refresh` worker job). Nothing of the original out-of-scope line
>   remains a static port.

> Out of scope for v1: the allocation / vault / wallet dashboards, the
> generative-art visualizations, blog/media editorial, and other secondary pages
> — **except** the live vault-economics slice of `/allocation` (§D15), the live
> prop-wallet valuation feed (§D16), and the live buyback / token-metrics /
> wallet-sleeves feeds that retired the last baked literals (§D17).

**The in-scope set, resolved.** Regime classifier + regime-family research
signals; the Investment Swarm (v0's "Investment Committee"); vault economics
(TVL / share price / adapters / 7-day APY); prop-wallet valuation + history;
buybacks / token-metrics / wallet-sleeves. Everything else — the generative-art
pages, blog/media editorial, secondary allocation variants — is explicitly out.

**Two documented gaps in the boundary itself:**

- **The projects / analytics-dashboard surface is not named anywhere in §1**,
  yet v1 ships a large implementation of it (`backend/src/projects/**`,
  `/api/projects`, `/api/dashboards/{overview,entities,agents,coins,vaults,wallets,list2,leaderboard}`,
  and the `/list`, `/list2`, `/list3`, `/market`, `/agents`, `/lobster`,
  `/vaults`, `/wallets` pages). §14's prose calls it "partially ported, not the
  full legacy suite" (`docs/architecture.md:1333-1348`: six of ~25 legacy
  pipelines). This is real, shipped, user-visible surface with **no scope
  declaration in §1** — so "in scope or not" cannot be settled from the
  canonical doc. It needs an explicit line.
- **§1 says "regime/research data views" without enumerating them.** Two v0
  regime-family research artifacts — `regime-eq-comparison.json` and
  `weighting-comparison.json` — are *not computed anywhere in v1*; they survive
  only as frozen static JSON files served to the blog charts
  (`frontend/public/data/`, read by
  `frontend/public/assets/js/app/alpine/views/blog-charts.js:85,192`). Under a
  literal reading of §1 those are in-scope regime views that were not ported.
  They are currently classified below as NOT-PORTED-GAP rather than
  NOT-PORTED-INTENTIONAL, because no doc says they were dropped.

---

## 2. The metric universe and its coverage map

Classification key: **PORTED** (same math, same output), **PORTED-RENAMED**
(same math, different name/transport), **NOT-PORTED-INTENTIONAL** (a canonical
doc declares it out), **NOT-PORTED-GAP** (absent with no declaration),
**V1-ONLY-NEW**.

### 2.1 Regime core

| # | v0 metric / report | v1 counterpart | class | where it surfaces | evidence |
|---|---|---|---|---|---|
| 1 | `computeRegime` — 3y rolling percentile, sign-align, inverse-corr weights (25% cap), 21-day refresh | `computeRegime()` | PORTED | `/regime`, `/regime_2panel` | v0 `scripts/regime/compute.js:34` → v1 `backend/src/analytics/analyze/compute.ts:54`; weights `backend/src/analytics/transform/math.ts:201,250` |
| 2 | `smoothRegimes` — 5-day confirm + 2σ fast-track, 252d lookback | `smoothRegimes()` | PORTED | same | v0 `compute.js:171` → v1 `compute.ts:172` (`CONFIRMATION_DAYS=5`, `FAST_TRACK_SIGMA=2.0`, `SIGMA_LOOKBACK_DAYS=252` at `compute.ts:168-170`) |
| 3 | `regime-history.csv` 11 columns | `regime_snapshots` table rows | PORTED-RENAMED | `GET /api/dashboards/regime-snapshots` | v0 `scripts/regime/update.js:223` → v1 `backend/src/analytics/index.ts:394` `buildSnapshotRows()`; schema `backend/migrations/0009_analytics_v2.sql:16-23` |
| 4 | `regime-snapshot.json` rich `indicators[]` (`raw_value`, `transformed_value`, `percentile`, `signed_percentile`, `panel_weight`, `sparkline[24]`) | `buildRichIndicators()` | PORTED | `/regime` indicator table | v0 `update.js:398,494` → v1 `backend/src/analytics/index.ts:460,501` |
| 5 | Factor panel (8 indicators) + `regime-eq-snapshot.json` 3-panel | all 8 factor indicators present; 3-panel run explicit; `factor_*` columns on `regime_snapshots` | PORTED-RENAMED | `/regime` | v1 `backend/src/analytics/analyze/indicators.ts:169,186,367,383,399,415,431,447`; 3-panel call `backend/src/analytics/index.ts:228`. The `.json` file itself survives only as a vendored v0 fixture + one-shot import (`backend/src/db/import-regime-eq.ts`) |
| 6 | `computeCorrelations` — Spearman ρ, 30/90/180d fwd + concurrent, spx/eth, `{rho,n}` | `computeCorrelations()` | PORTED | `/regime` correlations table | v0 `update.js:531` → v1 `backend/src/analytics/analyze/correlations.ts:41`; horizons/assets `correlations.ts:18-19` |
| 7 | `computeBacktest` — 3 portfolios × ~10 strategies × `{final_value,cagr,cagr_in_sample,cagr_out_sample,sharpe,max_drawdown,transitions,n_days,equity_curve}`; DTB3 cash leg; 10bps turnover | `computeBacktest()` | PORTED | `/regime` backtest table + equity charts | v0 `update.js:695,827` → v1 `backend/src/analytics/analyze/backtest.ts:89`; `BACKTEST_COST_PER_REBALANCE=0.001` (`backtest.ts:20`), `BACKTEST_IN_SAMPLE_END="2024-01-31"` (`backtest.ts:21`) |
| 8 | `backtest-equity.csv` daily series | stripped before persistence (`stripDailyFromSnapshot`) | NOT-PORTED-INTENTIONAL | — | v1 `backend/src/analytics/analyze/backtest.ts:305`; v0 wrote it at `update.js:927` |
| 9 | `regime-eq-comparison.json` — `time_share`, `agreement`, `phases[]`, base-vs-eq backtests | **none** — frozen static JSON only | **NOT-PORTED-GAP** | `/blog/regime-eq-vs-base` (serves stale frozen numbers) | v0 `scripts/regime/regime-eq-comparison.js`; v1 `frontend/public/data/regime-eq-comparison.json` fetched at `frontend/public/assets/js/app/alpine/views/blog-charts.js:85`. Grep for `time_share\|agreement\|phases` in `backend/src` returns no regime hits |
| 10 | `weighting-comparison.json` — `static_invcorr` / `equal_1n` / `walk_forward` | **none** — frozen static JSON only | **NOT-PORTED-GAP** | `/blog/honest-backtesting-weights` | v0 `scripts/regime/weighting-comparison.js`; v1 `blog-charts.js:192`. Grep for `walk_forward\|equal_1n\|static_invcorr` repo-wide: zero hits |
| 11 | `daily-update.js` narrative deltas (top-5 movers by `\|Δ × weight\|`) | none | NOT-PORTED-INTENTIONAL (stdout-only op tool in v0) | — | v0 `scripts/regime/daily-update.js` |
| — | forward-fill expiry / staleness flags | `MAX_FORWARD_FILL_DAYS=120`, `forward_fill_expired`, `computeRegimeStaleness` | **V1-ONLY-NEW** | `/regime` | `backend/src/analytics/transform/math.ts:302`; `backend/src/analytics/report/regime-projection.ts:145,215` |

### 2.2 Research signals

| # | v0 metric | v1 counterpart | class | surfaces | evidence |
|---|---|---|---|---|---|
| 12 | `btc_beta_vs_risk_appetite` (90d OLS rolling beta) | `rollingBetaSeries()` | PORTED | `/research/channel-divergence` | v0 `scripts/regime/channel-divergence.js:135` → v1 `backend/src/analytics/analyze/research-signals.ts:36,134` |
| 13 | `btc_qqq_ratio_percentile` (756d) | same | PORTED | same | v1 `research-signals.ts:189`, `PCT_RANK_WINDOW` at `:22` |
| 14 | `stables_vs_qqq_flow` (90d %Δ diff) | same | PORTED | same | v1 `research-signals.ts:190` |
| 15 | `summary.{beta,ratio_percentile,flow_diff}.{latest,median_full_history}` | same block | PORTED | stat cards | v1 `research-signals.ts` output shape; `GET /api/dashboards/research-signals/channel-divergence` |
| 16 | `concentration_cap_vs_equal(_pct)` (SPY/RSP) | `computeLateCycle` | PORTED | `/research/late-cycle-signals` | v0 `scripts/regime/late-cycle-signals.js` → v1 `research-signals.ts:213,274-277` |
| 17 | `concentration_top7_vs_spy(_pct)` (equal-weight TOP7) | `buildEqualWeightIndex()` | PORTED | same | v0 `late-cycle-signals.js:184` → v1 `research-signals.ts:58,224`; `TOP7` at `:28` |
| 18 | `mna_s4_monthly` + `mna_pct` (EDGAR S-4 counts) | same + incremental refresh | PORTED | same | v0 `late-cycle-signals.js:253` → v1 `research-signals.ts:278`, `backend/src/analytics/extract/edgar.ts`, `backend/src/analytics/edgar-incremental-refresh.ts` |
| 19 | `margin_debt_level` / `_yoy` / `_yoy_pct` | same | PORTED | same | v1 `research-signals.ts:281-282` |
| 20 | `consumer_conf_level` / `_pct` | same | PORTED | same | v1 `research-signals.ts:283-284,291` |
| — | degraded-EDGAR last-good retention | skips recompute, retains last good | **V1-ONLY-NEW** | — | `backend/src/analytics/index.ts:330-342`; `backend/tests/research-last-good.test.ts` |

### 2.3 Treasury / vault / prices

| # | v0 metric | v1 counterpart | class | surfaces | evidence |
|---|---|---|---|---|---|
| 21 | GeckoTerminal token prices (ETH/USDC/ROBOTMONEY/BNKR/WOON/PEAQ/DEUS) | `fetchGeckoTokenPricesUsdUncached` | PORTED | `/allocation`, `/tokenomics` | v0 `scripts/hourly-prices.js` → v1 `backend/src/chain/token-prices.ts:154,235,262` |
| 22 | `ZYFAI-SS1` / `GIZA-SS1` strategy NAV | tracked as `valuationKind:"strategy"`, valued via smart-account NAV | PORTED-RENAMED | `/allocation` | v0 `hourly-prices.js:104` → v1 `backend/src/config.ts:177-180`, `backend/src/chain/wallet-valuation.ts:337` |
| 23 | `SP500` price = Hyperliquid `accountValue/\|size\|` | **Yahoo `^GSPC`** instead | PORTED-RENAMED (different source, different number) | `/allocation` | v0 `scripts/lib/hyperliquid.js:148`, `hourly-prices.js:155` → v1 `backend/src/chain/token-prices.ts:252`, `backend/src/config.ts:202,271`. Grep `hyperliquid` in v1: **zero hits** |
| 24 | `prices.csv` hourly price history | `prices` table exists but is **dead** (no reader, no writer) | **NOT-PORTED-GAP** (silent) | — | `backend/migrations/0002_dashboards.sql:34`; price history survives only denormalized in `wallet_balance_samples.price_usd` at daily grain |
| 25 | `hourly-wallet-balances.csv` (`balance`, `price_usd`, `value_usd`, `total_wallet_value`) | `computeWalletBalances()` → `wallet_balance_samples` | PORTED-RENAMED (hourly → **daily** rows) | `GET /api/dashboards/wallet-balances`, `/performance` | v0 `scripts/hourly-allocation-wallet-balance.js` → v1 `backend/src/chain/wallet-balances.ts:56,179,210`; sampler `backend/src/worker/handlers/wallet.ts:32` keys on `(sample_date, symbol)` |
| 26 | `unified-wallet-history.csv` (`total_aum`, per-asset) | `WalletHistoryPoint {date, byAsset, totalUsd}` | PORTED-RENAMED | `/allocation2` → `/performance` | v1 `backend/src/chain/wallet-balances.ts:50` |
| 27 | `hourly-vault-tvl.csv` — `totalAssets`, `totalSupply`, `share_price`, `idle` | `VaultCoreRead` + `vault_share_price_history` | PORTED | `GET /api/dashboards/vault-economics` | v0 `scripts/hourly-vault-tvl.js:114` → v1 `backend/src/chain/vault-economics.ts:26,42,76-81`; hourly cron `backend/src/db/seed.ts:47-48` |
| 28 | Adapter TVL MORPHO / AAVE / COMPOUND | `rpcVaultAdapterReader` | PORTED | same | v1 `backend/src/chain/vault-economics.ts:86`, `backend/src/config.ts:70-77` |
| 29 | `vault-apy.json` — 7-day, `(1+growth)^(365/days)−1` | `computeApy7d()` | PORTED (formula-identical) | `/allocation` APY card | v0 `scripts/daily-vault-apy.js:59` → v1 `backend/src/chain/vault-economics.ts:127` |
| 30 | Buybacks (`wethSpent`, `robotMoneyIn`, `valueUsd`) via Basescan `tokentx` | `indexBuybacks()` via Base RPC `eth_getLogs` | PORTED-RENAMED (different transport) | `/tokenomics`, `/allocation` | v0 `src/lib/wallet.ts:423,527` → v1 `backend/src/chain/buyback-logs.ts:87,174,206`. Note v0's `valueUsd` was a hardcoded `0` placeholder (`scripts/update-wallet-history.js:223`) — v1 is *more* correct here |
| 31 | Tokenomics fee split 57/40/3 (hardcoded in v0) | `computeTokenMetrics().feeSplit` from Clanker pool config | PORTED-RENAMED (hardcoded → derived) | `/tokenomics` | v0 `src/app/tokenomics/page.tsx:172,1040-1056` → v1 `backend/src/chain/token-metrics.ts:44,62,112` |

### 2.4 Investment Committee → Swarm

| # | v0 metric | v1 counterpart | class | surfaces | evidence |
|---|---|---|---|---|---|
| 32 | `subject-balances.csv` per-wallet/per-asset `value_usd` | `subjectBasket()` / snapshot `positions[]` | PORTED-RENAMED | `/swarm/subjects/:id` | v0 `scripts/committee/hourly-subject-balances.js` → v1 `backend/src/swarm/domain.ts:932` |
| 33 | Daily subject snapshot `total_value_usd`, `positions[]`, `wallets[]` | `getSubjectSnapshots()` | PORTED | same | v0 `scripts/committee/daily-subject-snapshots.js:32` → v1 `backend/src/swarm/domain.ts:121`, projection `backend/src/swarm/projections.ts:187` |
| 34 | `notable` concentration flag when top position ≥ 50% of value | **none** | **NOT-PORTED-GAP** | subject page shows a donut but never the flag | v0 `scripts/committee/daily-subject-snapshots.js:78`. Grep for a `>= 0.5` share threshold in v1 backend + frontend: no hits |
| 35 | Brief regime block (composite/percentiles/labels/correlations) | `publishBrief()` regime block — **1 row** | PORTED-PARTIAL | `GET /api/swarm/brief` | v0 `scripts/committee/generate-brief.js:73` → v1 `backend/src/swarm/domain.ts:1047-1049` |
| 36 | Brief `regime_history` — trailing **8** rows | not in the brief (8-row history exists only in `buildRegimeSummary`, used by session aggregation) | **NOT-PORTED-GAP** | member agents get less context than v0's | v0 `generate-brief.js:135` → v1 `backend/src/swarm/domain.ts:1184` |
| 37 | Brief `allocation` bucket `target_weight`s | not in the brief; served separately at `GET /api/dashboards/allocation` | PORTED-RENAMED | — | v1 `backend/src/chain/allocation-framework.ts:23,41,46,179` |
| 38 | Session `regime_summary` (+ 8-point history) | `buildRegimeSummary()` | PORTED | `/swarm/:date/:subject` | v0 `scripts/committee/generate-session.js` → v1 `backend/src/swarm/domain.ts:1184` |
| 39 | Member `confidence` [0,1], stance aggregation | `meanConfidence`, `byStance`, `quorum` | PORTED | same | v0 `generate-session.js:355` → v1 `backend/src/swarm/domain.ts:~1380-1490` |
| 40 | `bucket_weights` recommendation (sums to 1.0 ±0.01) | `meanTakeWeights()` / `normalizedTakeWeights()` | PORTED | same | v0 `generate-session.js:433` → v1 `backend/src/swarm/domain.ts:~1360,1446-1450` |
| 41 | `within_bucket_weights` (per-item, sums to 1.0 per bucket) | frontend **reads** it; no backend generator located | **NOT-PORTED-GAP (suspected)** | session page renders it if present | v1 `frontend/public/assets/js/app/alpine/static-views.js` `withinBucketWeightsFrom()`; `meanTakeWeights` produces flat bucket weights only |
| 42 | Actual-vs-target bucket weight drift (pp) | **none** — frontend emits `target:null, actual:null` | **NOT-PORTED-GAP** | drift chart degrades to Recommended-only | v0 `src/app/committee/[date]/[subject]/charts.tsx:100,112-181,489-570` → v1 `frontend/public/assets/js/app/alpine/static-views.js:1473-1493` |

### 2.5 Projects / analytics dashboard (scope-undeclared, see §1)

| # | v0 metric | v1 counterpart | class | surfaces | evidence |
|---|---|---|---|---|---|
| 43 | Projects table: market cap, FDV, 24h %, sparkline, wallet balance | `fetchProjects()` | PORTED-RENAMED (Supabase → Postgres) | `/projects` | v0 `src/app/display/projects/page.tsx:36` → v1 `backend/src/projects/projections.ts:225-290` |
| 44 | MC/FDV % | derived client-side | PORTED-RENAMED | same | v1 `frontend/public/assets/js/app/alpine/views/projects.js:14` |
| 45 | `data_coverage_score` | `computeCoverage()` — 1:1 port of Supabase `compute_project_coverage()` | PORTED | same | v1 `backend/src/projects/transforms.ts:188,226` |
| 46 | Revenue 30d on the projects table | removed from the DTO; math relocated to `/agents` + leaderboard | NOT-PORTED-INTENTIONAL (issue #346) | `/agents`, `/list3` | v1 `backend/src/projects/projections.ts:282`, `backend/src/projects/transforms.ts:147` |
| 47 | Dashboard overview: entity counts, vault TVL + 7d sparkline, total AUM | `fetchMarketOverview()` | PORTED | `/list`, `/market` | v1 `backend/src/projects/entities-projections.ts:282,337-352` |
| 48 | x402 score / txn count / volume / buyers / resources; productivity score | same columns | PORTED | `/agents`, `/agents/:id` | v1 `backend/src/projects/access/data-source.ts:19-23` |
| 49 | Scoring-weight methodology 40/30/30 + worked example | `/methodology` page | PORTED (hardcoded in both) | `/methodology` | v0 `analytics/src/pages/Methodology.tsx:10-12,70` |

### 2.6 Explicitly out of scope (correctly not ported)

Generative-art pages (`/chladni`, `/voronoi`, `/waves`, ~28 routes); v0's
duplicate/scratch numeric pages (`/regime-preview`, `/allocation-v2`,
`/allocation2_fixingtotals`, `/allocation3`); v0 dead code
(`src/data/allocation.ts`, `src/components/AllocationSection.tsx`,
`src/lib/hourly-balances-fixed.ts`); `scripts/hyperliquid-check.js`,
`scripts/test-sp500.js` (the latter is broken in v0 — imports a nonexistent
`fetchHip3Positions`); `build-partner-pdfs.js`. All NOT-PORTED-INTENTIONAL
under `docs/architecture.md:43-47`.

---

## 3. The assurance table — what the existing evidence actually proves

Provenance was established three ways: reading `meta.source` inside each
gzipped fixture, `git log` on the fixture path, and reading the script that
writes it (`backend/scripts/regime-goldens-regenerate.ts`).

**Commit `6985188` ("chore(analytics): regenerate vendored floor seed to include
BTC_MVRV (#444)", 2026-08-01) rewrote FOUR fixtures, not two:**
`regime-compute-reference.json.gz`, `regime-backtest-correlations-reference.json.gz`,
`regime-history.csv.gz`, **and** `regime-snapshot.json.gz` — all four from the
same in-repo TS pipeline (`backend/scripts/regime-goldens-regenerate.ts`, whose
own header lists all four outputs).

| test / assertion | what it TRULY asserts | baseline fixture & provenance | independent? | runs in CI? | catches a regression? |
|---|---|---|---|---|---|
| `regime-fidelity.test.ts:94` STRICT asof row | 6 numeric cols + 3 labels of the **last** row vs `regime-history.csv.gz`, tol 1e-6 | `regime-history.csv.gz` — **regenerated by v1's own pipeline** in `6985188` | **NO — self-consistent** (comment still calls it "the fresh asof row of regime-history.csv", implying v0 provenance) | backend.yml, **draft-gated + path-gated** | Only a *fresh* regression; a change that shifts both pipeline and future regeneration together passes |
| `regime-fidelity.test.ts:123` STRICT last-day vs snapshot | composite/percentile/panel indices + per-indicator `percentile`/`signed_percentile`/`panel_weight`/`transformed_value` at 1e-9, ≥16 indicators | `regime-snapshot.json.gz` — **regenerated by v1's own pipeline** in `6985188` | **NO — self-consistent** (comment says "the committed regime-snapshot.json", implying v0) | same | Yes for a fresh code regression; no for a regeneration-time regression |
| `regime-fidelity.test.ts:185` STRICT multi-day | all 6 series × ~3,102 rows + 3 label series at **1e-12** | `regime-compute-reference.json.gz` — `meta.source` = *"in-repo regeneration (backend/scripts/regime-goldens-regenerate.ts) … the original out-of-repo agentjuno/robotmoney generator is unavailable to this repo (issue #400)"* | **NO — self-consistent** (acknowledged in the body comment, **but the test TITLE still reads "reproduces the ORIGINAL JS pipeline"**) | same | Yes for fresh code regression only |
| `regime-fidelity.test.ts:254` TRACKING | `pctWithin(1e-3) > 0.94`, `pctLabel > 0.995`, `maxComposite < 0.08` vs `regime-history.csv.gz` | same regenerated file | **NO — self-consistent** | same | **Largely NO.** Baseline and subject are now the same pipeline so the true residual is ~0, but the bounds still permit 6% of rows to move >1e-3, 0.5% of labels to flip, and composite to move 0.08 — a band *wider than the entire measured v0↔v1 divergence in §0*. The comment admits the bounds were "kept loose rather than retightened" |
| `backtest-correlations-fidelity.test.ts:108` STRICT | deep numeric equality, >40 correlation leaves + >1000 backtest leaves, tol 1e-9 | `regime-backtest-correlations-reference.json.gz` — `meta.source` = *"in-repo regeneration … the original out-of-repo agentjuno/robotmoney generator (scratchpad/gen-fixtures.js) is unavailable to this repo (issue #400)"* | **NO — self-consistent** (acknowledged in body; **title still says "reproduces the ORIGINAL JS reference byte-for-byte"**) | same | Yes for fresh code regression only |
| `backtest-correlations-fidelity.test.ts:140` shape | key-set equality only — zero numeric assertions | `regime-snapshot.json.gz` (regenerated) | N/A (structural) | same | Only shape drift |
| `backtest-correlations-fidelity.test.ts:167` TRACKING | `transitions` within ±6; `final_value` relative drift **< 20%**; concurrent ρ within 5e-3 for >80% of cells | `regime-snapshot.json.gz` — **regenerated** | **NO — self-consistent** (comment still calls it "the committed snapshot" with "documented data-vintage drift") | same | **NO.** A 20% `final_value` tolerance against a self-produced baseline cannot fail on any realistic numeric regression |
| `research-fidelity.test.ts:52` channel-divergence | `btc_qqq_ratio_percentile` (<5e-3) and `stables_vs_qqq_flow` (<1e-3) over >2,900 dates | `channel-divergence.json.gz` — committed by PR #9, **never regenerated**; content is a genuine v0 cron artifact (`asof 2026-06-29`, four days later than my v0 checkout's 2026-06-25 — i.e. a real v0 vintage, not v1 output) | **YES — genuine independent v0 cross-check** | same | **Yes** |
| `research-fidelity.test.ts:84` late-cycle | `mna_pct`, `margin_debt_yoy` (<1e-4), `margin_debt_yoy_pct`, `consumer_conf_pct` over >700 dates | `late-cycle-signals.json.gz` — same provenance, never regenerated | **YES — genuine independent v0 cross-check** | same | **Yes** |
| `research-fidelity.test.ts:130` EDGAR incremental | merge of persisted floor ∪ refetched revision window reconstructs the committed `mna_s4_monthly` exactly, then `mna_pct` matches | same v0 fixture, but `fetchMonth` is a **deterministic double returning the fixture's own values** | Partially — proves the *merge path* is lossless, not that EDGAR fetching is correct | same | Yes for merge logic |
| `projects-pipelines-fidelity.test.ts` (9 tests) | pure transforms vs hand-derived ground truth, then a full pipeline run into real Postgres asserting `maxMarketCap`, `maxFdv`, `volume24h`, `tvlUsd`, `dataCoverageScore` (86/79/78), revenue (60k/30k/15k) | `backend/src/projects/fixtures/ground-truth.ts` — **hand-derived from the legacy Supabase edge-function formulas**, not captured from v0 output | Partially — independent of v1's code, but re-derived from *formulas*, so a misread formula reproduces itself. v0 never emitted a capturable artifact here (it read Supabase live) | same | **Yes** for the ported transforms |
| `regime-thresholds.test.ts` (7 tests) | canonical 0.33/0.67 thresholds, one shared `classifyRegime`, stored-label precedence, no synthetic writes on the live path, prod-gated backfill | v1-only invariants; no v0 baseline | N/A — not a parity test | same | Yes, for its own invariants |
| `regime-staleness.test.ts` (7+ tests) | pure `computeRegimeStaleness` classifier arithmetic, `REGIME_STALE_THRESHOLD_DAYS === 3` | v1-only feature | N/A — v0 had no staleness concept | same | Yes |
| `scripts/tests/unit/goldens-drift.test.ts` (3 tests) | see below — **effectively nothing** | `goldens/api-goldens.json`, `source: "capture:http://127.0.0.1:48787"` (a **v1** dev server), values explicitly point-in-time | **NO** — captured from v1 | unit.yml (broad) | **NO** |
| `analytics-suite.test.ts` | (regime goldens-adjacent) shares the same regenerated fixtures | regenerated | NO | same | Fresh regressions only |

### 3.1 The goldens-drift gate is a no-op

`scripts/tests/unit/goldens-drift.test.ts` is named as the drift gate and is
cited as assurance, but its three assertions are:

- `expect(hasHealthCheck || goldensRoutes.size > 0).toBe(true)` — tautological
  for any non-empty file.
- `expect(Object.keys(goldens.routes).length).toBeGreaterThan(0)` — non-empty.
- A "correct golden shapes" loop guarded by `if (route in goldens.routes)` over
  three route names. I checked the file: `/api/dashboards/allocation` is present
  (27 routes total), but **`/api/dashboards/swarm` and `/api/dashboards/regime`
  do not exist** — the real names are `/api/dashboards/regime-snapshots` etc. So
  two of the three validators are dead branches that never execute.

No numeric value in the 4.4 MB goldens file is asserted by anything. The file's
own `note` says *"VALUES are point-in-time"*. This gate would not catch any
numeric regression on any route.

### 3.2 CI execution honesty

- The whole regime/backtest/research fidelity suite lives in `backend/tests/**`
  and runs only via `.github/workflows/backend.yml`. Its gate
  (`backend.yml:82`) is:
  `if: github.event_name != 'pull_request' || (github.event.pull_request.draft == false && needs.changes.outputs.backend == 'true')`.
  So **it does not run on draft PRs, and does not run on any non-draft PR whose
  diff does not touch `backend/**` or `docker-compose*.yml`.** A PR that changes
  only `frontend/`, `contract/`, or `scripts/` never executes a single fidelity
  assertion. It does always run on push to `main`, i.e. post-merge.
- **Positively:** the suite obeys loud-skip. `backend/tests/fixtures/regime/load.ts:12-14`
  throws `missing fixture … — regime fidelity test cannot run` rather than
  skipping, and `projects-pipelines-fidelity.test.ts:1-8` documents that a
  missing DB fails red via the preload. `unit.yml:74-75` explicitly asserts that
  `bun test` over an empty selection exiting 0 is a failure — a good
  "exit 0 ≠ tested" guard, though it covers only the `scripts/tests` unit lane.
- **Positively:** each STRICT test counts its own executed assertions
  (`numericCompared > 6*2900`, `bCount.n > 1000`, `perInd > 15`) — genuine
  protection against a silently-empty comparison. That discipline is real; it is
  the *baseline*, not the execution, that is compromised.

---

## 4. Ranked assurance gaps

Ranked by (user visibility) × (absence of any genuine v0 check) × (size of the
tolerance band that would hide a regression).

1. **Regime composite / percentiles / regime labels have no v0 baseline at all,
   and measurably differ from v0 on 153 days.** All four fixtures that could
   have caught this were regenerated by `6985188`. v0's real files are still on
   disk and unused. *(§0, §3)*
2. **The `regime` label series specifically.** It is the single most
   user-visible number on the site (`/regime` headline, swarm briefs, session
   `regime_summary`, blog regime-band charts). 5.17% of historical days disagree
   with v0. Nothing asserts against v0.
3. **Backtest metrics (`final_value`, `cagr`, `sharpe`, `max_drawdown`,
   `transitions`) — 3 portfolios × ~10 strategies.** Only self-consistent
   assurance, and the TRACKING band is 20% relative on `final_value`. These are
   rendered as investment-performance claims on `/regime` and three blog posts.
4. **Correlations (48 `{rho,n}` cells).** Self-consistent only.
5. **`regime-eq-comparison.json` and `weighting-comparison.json` — served stale
   and frozen.** Two blog posts publish numbers from static files that no v1
   code can regenerate. They will silently diverge from the live regime forever,
   and there is no test that they even correspond to the current methodology.
6. **`btc_beta_vs_risk_appetite`** — the one channel-divergence series *not*
   covered by the genuine v0 fixture (SPY daily isn't embedded); covered only by
   a `rollingBeta` unit test in `transform.test.ts`.
7. **`concentration_*` late-cycle series** — same shape: the equal-weight TOP7
   index is unit-tested (`buildEqualWeightIndex`) but not fidelity-checked
   against v0's committed output.
8. **Vault economics (TVL, share price, adapters, 7-day APY)** — in scope per
   §D15, formula-identical by inspection, but **no fidelity fixture and no v0
   cross-check exists at all**. `vault-economics.test.ts` tests v1 against v1.
9. **Wallet balances / total AUM** — in scope per §D16. Same: no v0 baseline.
   Also a silent grain change (v0 hourly rows → v1 daily rows).
10. **SP500 price source changed Hyperliquid → Yahoo `^GSPC`** with no decision
    record found. These are *different numbers* (v0 derived a synthetic price
    from a perp `accountValue/|size|`). Any `/allocation` figure touching the
    SP500 leg is guaranteed non-parity.
11. **Swarm brief regime context shrank** from 8 history rows to 1 — member
    agents receive strictly less input than v0's, which changes their takes and
    therefore every downstream aggregate. No test covers brief content parity.
12. **Actual-vs-target bucket drift and the ≥50% concentration flag** — two v0
    committee metrics silently absent; the v1 chart degrades to
    "Recommended-only" without surfacing that the other two series are missing.
13. **The goldens-drift gate asserts nothing** (§3.1) while being named and
    treated as a drift gate.
14. **Draft-PR and path-filter gating** means a frontend-only or contract-only PR
    can merge with zero fidelity assertions executed.

---

## 5. Additional instances of the #447 fixture-substitution pattern

Issue #447 and PR #464 identify **two** substituted fixtures. I found **two
more**, substituted in the same commit, never flagged, and — critically — **not
restored by PR #464**.

| fixture | substituted by | flagged in #447/#464? | restored by #464? | tests silently converted |
|---|---|---|---|---|
| `regime-compute-reference.json.gz` | `6985188` (PR #444) | yes | **yes** | `regime-fidelity.test.ts:185` |
| `regime-backtest-correlations-reference.json.gz` | `6985188` | yes | **yes** | `backtest-correlations-fidelity.test.ts:108` |
| **`regime-history.csv.gz`** | `6985188` | **no** | **NO** | `regime-fidelity.test.ts:94` (STRICT), `regime-fidelity.test.ts:254` (TRACKING) |
| **`regime-snapshot.json.gz`** | `6985188` | **no** | **NO** | `regime-fidelity.test.ts:123` (STRICT), `backtest-correlations-fidelity.test.ts:167` (TRACKING) |

The evidence is in the substituting script's own header,
`backend/scripts/regime-goldens-regenerate.ts:1-31`, which lists all four
outputs. But the disclosure attached to only two of them: the two `-reference`
files carry an honest `meta.source` string admitting in-repo provenance, while
`regime-history.csv.gz` (a bare CSV, no metadata slot) and
`regime-snapshot.json.gz` (retains a `generated_at` timestamp that *looks* like
a v0 cron stamp) carry no provenance marker at all. The four test comments that
consume them still describe them as "the committed regime-history.csv", "the
committed regime-snapshot.json", "the frozen fixture", and "the documented
data-vintage drift" — language that only makes sense if they came from v0.

**So even after PR #464 merges, four of the six regime fidelity assertions
remain self-consistency checks**, and the two loosest ones (both TRACKING) will
still be measuring v1 against v1 through bands of 0.08 absolute composite and
20% relative `final_value`.

**Aggravating factor: the substitution was avoidable.** #447's premise — "the
original JS generator is confirmed permanently unavailable" — was already shown
false by #464 for the *generator*. It is equally false for the *outputs*: v0's
`data/regime/regime-history.csv` and `public/data/regime-snapshot.json` are
present and readable, and `backend/tests/fixtures/regime/regime-eq-snapshot.json.gz`
proves the practice was once followed — I verified it is **byte-identical
(sha256) to v0's `public/data/regime-eq-snapshot.json`**. A genuine v0 baseline
was available for all four files.

**Fixtures I checked and cleared:** `channel-divergence.json.gz`,
`late-cycle-signals.json.gz` (both PR #9, never regenerated, contents are real
v0 cron artifacts at `asof 2026-06-29`); `regime-extras.json.gz` (PR #17, real
Yahoo/FRED, and it is an *input* not a baseline); `regime-eq-snapshot.json.gz`
(PR #34, byte-identical to v0); `edgar-mna-seed.csv.gz` (has a manifest);
`backend/src/projects/fixtures/ground-truth.ts` (hand-derived from legacy
formulas — a weaker but not circular baseline).

---

## 6. What I could not determine

- **Whether the v0↔v1 regime divergence in §0 is 100% attributable to
  `BTC_MVRV` + the 4-day vintage lead, or whether a port defect is hiding
  inside it.** Separating them requires executing v0's `scripts/regime/compute.js`
  over v1's `BTC_MVRV`-inclusive floor and diffing — which means running v0 code
  (v0 is read-only for this audit, and `update.js` writes files). PR #464's
  vendored `backend/scripts/vendor/regime-reference-js/` makes this cheap once
  merged; it is the single highest-value follow-up.
- **Whether v1's floor rows for 2026-06-26..29 came from a genuine later v0 cron
  run or were fetched in-repo.** v1's floor leads v0's checkout by exactly four
  days across all 25 shared indicators, which is consistent with a later v0
  capture, but I found no manifest recording the capture date for
  `raw-indicator-history.csv.gz` (unlike `edgar-mna-seed.manifest.json`).
- **Whether `within_bucket_weights` is generated anywhere in v1.** The frontend
  reads it and a comment claims the payload "has carried it all along", but I
  could not locate a producer in `backend/src/swarm/domain.ts`. Needs a runtime
  check against a real published session.
- **Branch-protection required contexts.** `gh api …/branches/main/protection`
  returns 403 (private repo, plan-gated), so I could not confirm whether
  `backend` is a *required* check or merely an available one. The draft/path
  gating in `backend.yml:82` is confirmed from the workflow source; whether a
  skipped job blocks merge depends on that unreadable config.
- **Exact numeric parity for vault economics, wallet balances, buybacks, prices,
  and all swarm metrics.** No v0 baseline artifact was ever vendored for these,
  and v0's own outputs for several (subject balances, hourly wallet CSVs) are
  point-in-time live-chain reads that cannot be replayed. Establishing parity
  here would need a fresh dual-run capture, not a fixture.
- **The projects/analytics surface's intended scope.** §1 does not mention it;
  §14 describes it as partially ported. Whether the ~19 unported legacy
  pipelines are NOT-PORTED-INTENTIONAL or NOT-PORTED-GAP is a product decision I
  cannot resolve from the docs.
