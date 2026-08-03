# B1 — v0 → v1 Report Output Diff

Deliverable **B** of the v0→v1 mathematical parity audit: the empirical audit of the
**reports (outputs)**, as distinct from the code.

- **v0 baseline (read-only):** `/drive2/home/lucas/robotmoney/robotmoney-site` @ `4a1c4639` (2026-06-26 14:23:51 +0000)
- **v1 under audit:** worktree `adhoc/20260803-160300-v0-v1-mathematical-parity-audit`
- **Harness:** `scripts/audits/v0-v1-report-diff.ts` (new, re-runnable)
- **Date:** 2026-08-03

---

## Verdict

> ## PARTIAL — and NO for the headline number.
>
> v1's **macro panel** and its **statically-served research/comparison artifacts** reproduce
> v0 to floating-point noise across the full 2010–2026 history. v1's **onchain panel,
> composite index, and regime label do NOT** — v1's own full-history recomputation
> disagrees with v0's production `regime-history.csv` on **93–99.7% of dates in every
> single year 2018–2026**, and flips the published regime label on **153 / 2960 =
> 5.17%** of all classified days. This is a real, intended methodology change
> (BTC_MVRV added to the onchain panel in #400/#444), not a porting bug — but it means
> "v1's reports equal v0's" is **false** for the site's most prominent number.

Two further findings that qualify the verdict:

1. **A self-contradicting shipped artifact.** `regime-snapshot.json.gz`'s top-level
   `regime` is `risk_off` while its own `history[-1].regime` for the *same date*
   (2026-06-29) is `neutral`. The regeneration script recomputes the scalars but
   preserves the `history[]` array verbatim. See [§6](#6-defect-regime-snapshotjsongz-is-internally-inconsistent).
2. **Most of the "parity" evidence is a copy, not a computation.** The artifacts that
   pass at 100% do so because v1 vendors v0's bytes and serves them. That proves
   transport fidelity, not that v1's math reproduces v0's. See [§3](#3-provenance-which-baselines-are-actually-v0).

---

## 1. Artifact mapping table

| v0 file | v1 counterpart | v0 range | v1 range | Intersection | v0 covered | Provenance valid as a v0 baseline? |
|---|---|---|---|---|---|---|
| `data/regime/raw-indicator-history.csv` | `backend/tests/fixtures/regime/raw-indicator-history.csv.gz` | 2018-01-01 → 2026-06-25 (3098 d) | 2018-01-01 → 2026-06-29 (3102 d) | 3098 d | **100.00%** | **YES** (input floor; v0 rows are a strict subset) |
| `data/regime/regime-history.csv` | `regime-history.csv.gz` | 2018-05-15 → 2026-06-25 (2960) | → 2026-06-29 (2968) | 2960 | 100.00% | **NO** — regenerated from v1's pipeline (#444) |
| `data/regime/regime-versions.json` | `regime-versions.json` | n/a | n/a | 1 | 100.00% | **YES** — byte-identical |
| `public/data/regime-snapshot.json` | `regime-snapshot.json.gz` | 2018-01-31 → 2026-06-25 | → 2026-06-29 | 2987 | 100.00% | **MIXED** — scalars v1-derived, `history[]` v0-preserved |
| `public/data/channel-divergence.json` | `channel-divergence.json.gz` | 2018-01-01 → 2026-06-25 | → 2026-06-29 | 3099 | 100.00% | **YES** — untouched since import `df5ee09` |
| `public/data/late-cycle-signals.json` | `late-cycle-signals.json.gz` | 2010-01-01 → 2026-06-30 | same | 1199 | 99.92% | **YES** — untouched since `df5ee09` |
| `public/data/regime-eq-snapshot.json` | `regime-eq-snapshot.json.gz` | 2018-01-31 → 2026-06-25 | same | 2995 | 100.00% | **YES** — **byte-identical**, untouched since `91b9fbc` |
| `public/data/regime-eq-comparison.json` | `frontend/public/data/regime-eq-comparison.json` | 2018-01-01 → 2026-05-30 | same | 3078 | 100.00% | **YES** — static copy |
| `public/data/weighting-comparison.json` | `frontend/public/data/weighting-comparison.json` | 2018-02-28 → 2026-05-14 | same | 106 | 100.00% | **YES** — static copy |
| *(derived comparison)* `data/regime/regime-history.csv` | `regime-compute-reference.json.gz` | 2018-05-15 → 2026-06-25 | 2018-01-01 → 2026-06-29 | 2960 | 100.00% | **NO** — `meta.source` = "in-repo regeneration" |
| *(derived comparison)* `public/data/regime-snapshot.json` → `backtest`+`correlations` | `regime-backtest-correlations-reference.json.gz` | — | — | 102 | 99.03% | **NO** — `meta.source` = "in-repo regeneration" |
| — | `goldens/api-goldens.json` | — | 2026-01-14 → 2026-07-12 | — | — | **NO** — `"source": "capture:http://127.0.0.1:48787"` |

### Date-range caveat (important)

The local v0 checkout carries data through **2026-06-25** (`asof`), but every v1 regime
fixture carries **2026-06-29**. v1's fixtures were therefore vendored from a **later v0
production state than this v0 checkout holds**. All comparisons below are on the
intersection only; the 4-day tail (2026-06-26 … 06-29) is **not verifiable** against
this checkout. Intersection coverage of v0's history is ≥99.03% everywhere and 100% on
9 of 11 pairs, so this does not weaken the historical conclusions.

---

## 2. Roll-up (fields by tolerance band)

Bands are on **max relative diff** across the intersection. `EXACT` = zero differing values.

| Pair | Provenance | Fields | EXACT | ≤1e-9 | ≤1e-6 | ≤1e-3 | FAIL |
|---|---|---:|---:|---:|---:|---:|---:|
| `raw-indicator-history` | v0-derived | 25 | 7 | 0 | 4 | 4 | 10 |
| `regime-history` | v1-derived | 10 | 2 | 0 | 0 | 0 | **8** |
| `regime-versions` | v0-derived | 46 | **46** | 0 | 0 | 0 | 0 |
| `regime-snapshot` | v1-derived | 418 | 115 | 3 | 3 | 24 | **273** |
| `channel-divergence` | v0-derived | 21 | 11 | 0 | 1 | 1 | 8 |
| `late-cycle-signals` | v0-derived | 48 | 33 | 0 | 1 | 2 | 12 |
| `regime-eq-snapshot` | v0-derived | 484 | **484** | 0 | 0 | 0 | **0** |
| `compute-reference-vs-v0-history` | v1-derived | 9 | 1 | 0 | 0 | 0 | **8** |
| `snapshot-history-vs-v0-history` | v0-derived | 6 | **6** | 0 | 0 | 0 | **0** |
| `backtest-correlations-reference` | v1-derived | 336 | 93 | 3 | 0 | 22 | **218** |
| `regime-eq-comparison` | unknown | 216 | **216** | 0 | 0 | 0 | **0** |
| `weighting-comparison` | unknown | 260 | **260** | 0 | 0 | 0 | **0** |

Read this table together with the provenance column. **Every pair that scores 0 FAIL is
a pair where v1 vendors v0's bytes.** Every pair where v1 *computes* the number scores
heavy FAIL.

---

## 3. Provenance: which baselines are actually v0?

PR #464 established that in-repo fixtures had been silently regenerated from v1's own
pipeline while tests still described them as independent v0 references. That is
**confirmed and still true** for four fixtures.

### FAILS the provenance check — v1-derived, useless as a v0 baseline

`backend/scripts/regime-goldens-regenerate.ts` (added/run in PR #444, commit `6985188`)
rewrites all four from v1's own TS pipeline. Two of them say so in their own payload:

```
regime-compute-reference.json.gz     meta.source =
  "in-repo regeneration (backend/scripts/regime-goldens-regenerate.ts) over the
   BTC_MVRV-inclusive floor — the original out-of-repo agentjuno/robotmoney
   generator is unavailable to this repo (issue #400)"

regime-backtest-correlations-reference.json.gz  meta.source =
  "in-repo regeneration (backend/scripts/regime-goldens-regenerate.ts) — the original
   out-of-repo agentjuno/robotmoney generator (scratchpad/gen-fixtures.js) is
   unavailable to this repo (issue #400)"
```

| Fixture | Last rewritten by | Status |
|---|---|---|
| `regime-compute-reference.json.gz` | `6985188` (#444) | **v1-derived** |
| `regime-history.csv.gz` | `6985188` (#444) | **v1-derived** |
| `regime-snapshot.json.gz` | `6985188` (#444) | **v1-derived** (except `history[]`) |
| `regime-backtest-correlations-reference.json.gz` | `6985188` (#444) | **v1-derived** |
| `goldens/api-goldens.json` | `scripts/update-goldens.ts` | **v1-self-captured** (`"source": "capture:http://127.0.0.1:48787"`), point-in-time, demo-seeded |

**Loudly:** `backend/tests/regime-fidelity.test.ts`'s STRICT multi-day test asserts
`< 1e-12` against `regime-compute-reference.json.gz`. Since both sides now come from
the same in-repo pipeline, **that test proves internal self-consistency, not parity with
v0.** The test file's own header admits this. The same applies to
`backtest-correlations-fidelity.test.ts`. A green suite here is not evidence of v0 parity.

### PASSES the provenance check — genuinely v0 lineage

| Fixture | Evidence |
|---|---|
| `regime-eq-snapshot.json.gz` | Untouched since import `91b9fbc`; **decompresses byte-identical to v0's file** (1 674 239 B, matching MD5) |
| `regime-versions.json` | **Byte-identical** to v0's (`cmp` clean) |
| `channel-divergence.json.gz` | Untouched since import `df5ee09` |
| `late-cycle-signals.json.gz` | Untouched since import `df5ee09` |
| `raw-indicator-history.csv.gz` | Input floor; v0's 72 385 rows are a **strict subset** |
| `regime-snapshot.json.gz` → `history[]` only | Preserved verbatim by the `{...oldSnap}` spread |
| `frontend/public/data/{regime-eq,weighting}-comparison.json` | Static copies, 100% exact |

---

## 4. THE HEADLINE — v1's math vs v0's math over full history

`regime-compute-reference.json.gz` is the **only** v1 artifact carrying a full-history
recomputation from v1's own pipeline, so diffing it against v0's committed
`regime-history.csv` is the true "does v1 reproduce v0 for every period" test.

v0's CSV stores 6 decimal places, so **≤5e-7 is quantisation, not divergence**. The
distribution of `|v0 − v1|` over all 2960 shared dates:

| Series | n | ≤5e-7 (quantisation) | ≤1e-4 | ≤1e-3 | ≤1e-2 | ≤1e-1 | >1e-1 | max abs | mean abs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `macro_index` | 2960 | **98.99%** | 99.02% | 99.22% | 99.49% | 99.97% | 0.03% | 0.1064 | 2.24e-4 |
| `macro_percentile` | 2960 | **99.09%** | 99.09% | 99.19% | 99.36% | 99.86% | 0.14% | 0.1680 | 4.00e-4 |
| `composite` | 2960 | **0.00%** | 0.54% | 7.03% | 57.53% | 100.00% | 0.00% | **0.0768** | 1.01e-2 |
| `onchain_index` | 2960 | **0.00%** | 0.24% | 3.45% | 35.20% | 99.56% | 0.44% | **0.1238** | 2.00e-2 |
| `composite_percentile` | 2960 | 7.84% | 7.84% | 11.22% | 34.12% | 95.44% | 4.56% | **0.3404** | 2.83e-2 |
| `onchain_percentile` | 2960 | 4.56% | 4.59% | 7.40% | 25.34% | 89.05% | **10.95%** | **0.3404** | 4.17e-2 |

Worst-offending dates: `composite` 0.0768277 @ **2026-06-13**; `onchain_index` 0.123763 @
**2018-06-01**; `onchain_percentile` / `composite_percentile` 0.340425 @ **2018-06-01**;
`macro_index` 0.106396 @ **2026-06-06**.

**Regime label disagreement: 153 / 2960 = 5.17%** of all classified days.
`onchain_regime` disagreement: 289 / 2960 = 9.76%.

### Cause

v0's snapshot registers `BTC_MVRV` with `panel_weight = 0` (no data). v1 gives it
`panel_weight = 0.09316080861664007`. Because the onchain panel uses
inverse-correlation weighting, adding one live indicator **re-normalises every other
onchain weight**:

| Onchain indicator | v0 weight | v1 weight |
|---|---:|---:|
| `BTC_MVRV` | 0 | **0.09316** |
| `DEFI_TVL` | 0.08532 | 0.07878 |
| `STABLES` | 0.10111 | 0.10344 |
| `BTC_ACTIVE` | 0.14261 | 0.14609 |
| `ETH_ACTIVE` | 0.13625 | 0.14151 |
| `BTC_ETH` | 0.13866 | 0.11878 |
| `ETH_TREND` | 0.15726 | 0.12810 |
| `DEFI_GROWTH` | 0.14396 | 0.10967 |
| `STABLES_GROWTH` | 0.09482 | 0.08046 |

Macro weights move only in the 4th decimal (e.g. `HY_OAS` 0.22361 → 0.22439) — consistent
with the macro panel's near-perfect parity.

---

## 5. Per-era breakdown (full history, not just the latest snapshot)

### 5a. Share of dates exceeding 1e-3 — `compute-reference` vs v0 `regime-history.csv`

| Series | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `macro_index` | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 13.4% |
| `macro_percentile` | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 14.0% |
| `composite` | 97.4% | 94.5% | 91.8% | 89.9% | 99.7% | 88.8% | 92.9% | 94.2% | 84.9% |
| `onchain_index` | 98.3% | 97.8% | 95.6% | 96.4% | 99.7% | 93.4% | 97.3% | 95.9% | 93.6% |
| `composite_percentile` | 81.0% | 94.5% | 95.9% | 60.3% | 91.5% | 91.0% | 99.2% | 88.8% | 100.0% |
| `onchain_percentile` | 87.9% | 96.4% | 98.9% | 80.3% | 95.9% | 83.0% | 99.7% | 93.7% | 99.4% |

Max `|Δcomposite|` by year: 2018 **0.0619**, 2019 0.0336, 2020 0.0408, 2021 0.0193,
2022 0.0309, 2023 0.0181, 2024 0.0224, 2025 0.0221, 2026 **0.0768**.

**The divergence is uniform across the whole history — it is not a recent-data artifact
and it is not confined to any era.** The macro panel is the mirror image: clean in every
year, with all movement confined to 2026 (recent revisions + the 4-day tail).

### 5b. Regime-label flips by year

| | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `regime` flips | 11/231 (4.8%) | 12/365 (3.3%) | 22/366 (6.0%) | 3/365 (0.8%) | 31/365 (8.5%) | 0/365 (0.0%) | 41/366 (11.2%) | 22/365 (6.0%) | 11/172 (6.4%) |
| `onchain_regime` flips | 19.5% | 13.7% | 11.7% | 4.7% | 8.2% | 2.7% | 15.8% | 9.6% | 0.6% |

### 5c. `late-cycle-signals` — clean for 16 years, divergence confined to 2026

`indicators.consumer_conf_pct.value`: **0 differing values in every year 2010–2025**;
8/25 (32.0%) differ in 2026, max 0.019842.
`indicators.concentration_cap_vs_equal_pct.value`: one single differing point in the
entire 2010–2026 history (2019-05-24, 1.323e-3).
33 of 48 fields EXACT; `spy_price.value` differs on 650/860 dates but at max 1.83e-4
absolute / **8.07e-7 relative** — pure price-source precision.

### 5d. `channel-divergence` — small, systematic, all-history

`indicators.btc_beta_vs_risk_appetite.value` differs on 2975/3098 dates but at
**~1e-4 magnitude**: max abs by year is 2.37e-4 (2018), 3.90e-4, 4.17e-4, 2.44e-4,
1.69e-4, 1.04e-4, 9.80e-5, 7.90e-5 (2025) — then 2.733e-3 in 2026. Relative max 0.2766
only because the series crosses zero.
`indicators.stables_vs_qqq_flow.value` differs on 522/3098 dates, max 1.0e-6 pre-2026.
`qqq_price.value`: 2198/3098 differing at max **5.93e-7 relative** — price-source precision.

### 5e. `raw-indicator-history` (input floor) — two distinct diff populations

| Population | Indicators | Pattern | Magnitude |
|---|---|---|---|
| Ratio series | `SPHB_SPLV`, `IWM_SPY`, `IWF_IWD`, `XLU_SPY`, `MTUM_SPY`, `XLP_XLY` | ~1810–1958 of 3097 dates, spread over all years | **≤1.38e-6 relative** — float/rounding, benign |
| Level series | `BTC_ACTIVE`, `DFII10`, `DXY`, `DEFI_TVL`, `DEFI_GROWTH`, `ETH_ACTIVE`, `HY_OAS`, `COPPER_GOLD`, `ETH_TREND`, `BTC_ETH`, `STABLES`, `STABLES_GROWTH` | **1–6 dates only, all at the 2026-06-20…25 tail** | up to 6.6e-2 relative (`BTC_ACTIVE`) |
| Exact | `ICSA`, `NEW_TOKENS`, `SHILLER_CAPE`, `SPX_TREND`, `T10Y2Y`, `T5YIE`, `VIX` | 0 differing | — |

The level-series diffs are **vendor revisions of the last few days**, not a
methodology difference. The floor is otherwise v0-faithful across 8.5 years.

---

## 6. DEFECT: `regime-snapshot.json.gz` is internally inconsistent

`backend/scripts/regime-goldens-regenerate.ts` builds the new snapshot as:

```ts
// Preserve the existing rich, non-numeric top-level/descriptive fields
// (bucket_thresholds, extras, history, rolling_window_days, generated_at,
// panels) from the committed fixture; only overwrite fields that are
// mathematically downstream of the raw floor …
const newSnap = { ...oldSnap, asof: …, composite: …, onchain_index: …,
                  panel_weights: …, indicators: …, backtest: bt, correlations: corr };
```

`history` is listed as a **"non-numeric descriptive field"** and is never overwritten —
but `history[]` is numeric and *is* mathematically downstream of the raw floor. The
committed artifact therefore mixes two methodologies:

| Same file, same date 2026-06-29 | Value |
|---|---|
| top-level `regime` (recomputed, BTC_MVRV-inclusive) | `risk_off` |
| `history[-1].regime` (preserved, pre-BTC_MVRV) | **`neutral`** |
| top-level `composite` | 0.4494875723085398 |
| `history[-1].composite` | 0.4541570691590452 (Δ = 4.67e-3) |
| top-level `onchain_index` | 0.31467908906224884 |
| `history[-1].onchain` | 0.3240180827632596 (Δ = 9.34e-3) |
| `panel_weights.onchain.BTC_MVRV` | 0.09316 |

v0's equivalent file is perfectly self-consistent (Δ = 0 on all three, labels match).

Cross-checking the two v1 fixtures that the *same script run* produced:

| Check | n | ndiff (>1e-6) | max abs |
|---|---:|---:|---:|
| **v0** `snapshot.history[]` vs **v0** `regime-history.csv` | 2960 | **0** | 4.86e-7 |
| **v1** `snapshot.history[]` vs **v1** `regime-history.csv.gz` | 2968 | **2968** | **0.1238** |

v0's two artifacts agree with each other. v1's two artifacts, written seconds apart by
one script, disagree on **every single date**. Consequently
`snapshot-history-vs-v0-history` scores a perfect 6/6 EXACT against v0 — the preserved
array is flawless v0 lineage — while the rest of the same file does not.

---

## 7. UNMAPPED

### v0 artifacts with no v1 counterpart anywhere in the repo

| v0 file | Status |
|---|---|
| `public/data/prices.csv` | **UNMAPPED** — only a mention in `recyclebin/docs/FEATURE_PARITY_PLAN.md` |
| `public/data/vault-apy.json` | **UNMAPPED** — only in `recyclebin/` |
| `public/data/hourly-vault-tvl.csv` | **UNMAPPED** as a file; v1 serves vault TVL from Postgres via `GET /api/dashboards/vault-economics` |
| `public/data/hourly-wallet-balances.csv` | **UNMAPPED** — no reference at all; v1 has `GET /api/dashboards/wallet-balances` (DB-backed) |
| `public/data/unified-wallet-history.csv` | **UNMAPPED** — only in `recyclebin/` |
| `public/data/subject-balances.csv` | **UNMAPPED** as a file; only a swarm `_SCHEMA.md` mention |

These six are v0's wallet/price/treasury CSV+JSON exports. v1 replaced the *static-file*
delivery model with DB-backed `/api/dashboards/*` routes, so there is no artifact-to-
artifact comparison to make. **Their numerical parity is unaudited by this deliverable**
and needs a live-API comparison (see §8).

### Field-level unmapped

- `raw-indicator-history`: **1 v1-only field — `BTC_MVRV`** (3102 rows). No v0 counterpart by design.
- `regime-snapshot`: 8 v1-only leaf fields (all under `panel_weights.factor.*`, the factor panel v0's non-eq snapshot lacks).
- `compute-reference`: 142 v1-only dates — 2018-01-01…2018-05-14 (pre-classification warm-up, which v0's CSV omits) plus the 4-day tail.
- `late-cycle-signals`: 1 v0-only key, 2 v1-only keys (99.92% coverage).
- All other pairs: **zero** unmapped fields.

### Excluded from the numeric verdict (declared, not silently dropped)

`generated_at`, `description`, `interpretation`, `derivation`, `source_url`, `name`,
`spec`, `meta.*` — prose and regeneration timestamps. Every one is listed in
`PROSE_FIELDS` in the harness.

---

## 8. NOT-VERIFIABLE-OFFLINE

| Item | Why | What would be needed |
|---|---|---|
| **Regenerating v1's floor** (`backend/scripts/floor-seed-regenerate.ts`) | **Network required.** Fetches `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics`. No DB, no API key (keyless community API). | Outbound HTTPS to Coinmetrics. Not faked. |
| **The 4-day tail 2026-06-26 … 06-29** | This v0 checkout stops at 2026-06-25/26; v1's fixtures were vendored from a later v0 state | A v0 checkout at or past 2026-06-29 (`git fetch` on the v0 repo — deliberately **not** run, v0 is read-only here) |
| **`/api/dashboards/*` served payloads** | Postgres-backed; requires a running v1 stack + seeded DB | `bun run demo` + `import-regime-eq.ts`, then diff live responses against v0 |
| **`goldens/api-goldens.json` as a v0 baseline** | Self-captured from v1's own server (`"source": "capture:http://127.0.0.1:48787"`), values explicitly point-in-time, history clamped to 180 days (2026-01-14 → **2026-07-12**, past v0's data entirely) | Nothing — it is structurally incapable of being a v0 baseline. Measured anyway: 163 shared dates, **163/163 differing, max abs 0.2106 @ 2026-05-12** — meaningless as parity evidence, recorded to close the loop. |
| **v0's six wallet/price/treasury exports** (§7) | v1 has no file counterpart; delivery moved to DB-backed routes | Live-API comparison against a seeded v1 stack |

**Cheap and hermetic (so it WAS run):** `regime-goldens-regenerate.ts` needs no network
and no DB. It was **not** executed, because doing so would rewrite the very fixtures
under audit inside the worktree. Its behaviour was established by reading it and by
measuring its committed output — which is what §6 reports.

---

## 9. How to re-run

```bash
cd /drive2/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260803-160300-v0-v1-mathematical-parity-audit

# Everything (the numbers in §2):
bun run scripts/audits/v0-v1-report-diff.ts --v0 /drive2/home/lucas/robotmoney/robotmoney-site

# The headline pair, with the per-era tables of §5a:
bun run scripts/audits/v0-v1-report-diff.ts \
  --v0 /drive2/home/lucas/robotmoney/robotmoney-site \
  --pair compute-reference-vs-v0-history --era --era-top 4

# Machine-readable, for regression tracking:
bun run scripts/audits/v0-v1-report-diff.ts \
  --v0 /drive2/home/lucas/robotmoney/robotmoney-site --json /tmp/parity.json --quiet
```

Flags: `--v0 <path>` (required, read-only) · `--v1 <path>` (defaults to the harness's own
repo) · `--pair <name>` (repeatable) · `--era` / `--era-top N` · `--top N` · `--json <file>`
· `--quiet`.

The harness always exits 0 — it is a measurement tool, not a gate. Adding a pair means
adding one entry to `buildPairs()`; loaders for gz, wide CSV, long CSV, columnar JSON,
and nested JSON already exist.

---

## 10. What I could not determine

1. **Whether the onchain divergence was ever signed off as intended.** The change is
   clearly deliberate in code (#400 → #444 add BTC_MVRV), but I found nothing recording
   that someone accepted a **5.17% regime-label rewrite across all published history**
   as the cost. That is a product decision this audit surfaces, not one it can make.
2. **Whether v1's onchain math is *correct*** — only that it differs from v0. With every
   full-history reference now regenerated from v1 itself, **no artifact in this repo can
   settle it.** The out-of-repo `agentjuno/robotmoney` generator is the only thing that
   could, and it is unavailable.
3. **Whether v0 itself would produce these numbers if re-run today** with BTC_MVRV
   present. v0's committed CSV is the only v0 output I have; I cannot execute v0's
   pipeline.
4. **Parity for the six wallet/price/treasury artifacts** (§7) — no file counterpart
   exists; needs a live seeded v1 stack.
5. **Whether `regime-eq-comparison.json` / `weighting-comparison.json` are *maintained*
   in v1 or merely frozen copies.** They are 100% exact today, but I found no v1
   generator for either, so they will silently go stale.
6. **The pre-2018-05-15 warm-up window** (142 dates in v1's compute reference). v0
   publishes no classified rows there, so there is nothing to compare against.
7. **Whether the 4-day tail is v0-faithful** — see §8.

---

## Bullet summary

- **Verdict: PARTIAL, and NO for the headline number.** v1's macro panel and its
  statically-served artifacts match v0 to floating-point noise; the onchain panel,
  composite, and regime label do not.
- **v1's own full-history recompute disagrees with v0's `regime-history.csv` on
  93–99.7% of dates in every year 2018–2026**; max |Δcomposite| 0.0768, max
  |Δonchain_percentile| 0.3404; **regime label flips on 153/2960 = 5.17% of days**.
- Cause is deliberate: BTC_MVRV enters the onchain panel at weight 0.0932 (0 in v0),
  re-normalising every onchain weight. Macro weights move only in the 4th decimal.
- **Four fixtures fail the provenance check** — `regime-compute-reference`,
  `regime-history`, `regime-snapshot`, `regime-backtest-correlations-reference` were all
  regenerated from v1's pipeline in #444; two say so in `meta.source`. `api-goldens.json`
  is self-captured from v1's own server. Tests asserting `<1e-12` against these prove
  self-consistency, not v0 parity.
- **Genuine v0 baselines pass cleanly:** `regime-eq-snapshot` (484/484 exact, byte-identical),
  `regime-versions` (byte-identical), `regime-eq-comparison` (216/216),
  `weighting-comparison` (260/260), `late-cycle-signals` (exact 2010–2025).
- **New defect:** `regime-snapshot.json.gz` contradicts itself — top-level `regime`
  `risk_off` vs its own `history[-1].regime` `neutral` for the same date, because the
  regeneration script misclassifies numeric `history[]` as a descriptive field and
  preserves it. v0's equivalent file is self-consistent.
- Harness: `scripts/audits/v0-v1-report-diff.ts`, re-runnable, handles gz/CSV/nested JSON.
