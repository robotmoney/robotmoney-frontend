# Data Integrity Review — Macro index discrepancy, v1 0.657 vs v0 0.611 — 2026-08-14

## 1. TL;DR

1. **v0 has a real data-fidelity bug:** it persists synthetic, forward-filled
   values as though they were factual raw observations. v1's sparse live-write
   path avoids that feedback loop, although its optional seed can import
   already-polluted keys.
2. **The sampled v1 production output did not carry the error:** its served
   snapshots matched the source-date-cleaned ICSA/DXY model in the captured
   comparison. How production avoided the polluted seed is unresolved; there
   is no evidence that startup migration fully self-healed it.
3. **v1 still carries v0-derived sample data for testing:** the fixture must be
   recomputed directly from source data, with no dependency on v0's persisted
   history.
4. **A follow-on documentation project should improve agent readability** of the
   research and regime pipeline, including the distinctions between source data,
   persisted floors, forward-filled views, and seed data.
5. **Decide whether to repair v0 or sunset it.** The detailed evidence and
   remediation considerations follow.

## 2. Repo identity — read this before reproducing

The `robotmoney/robotmoney-site` origin is a
**frozen archive fork**, last commit 2026-08-05 (`4c4fcad6`). Live v0 production
is the **`upstream` remote, `agentjuno/robotmoney`**, whose `Daily Regime Update`
cron has run successfully every night, most recently 2026-08-13 23:07 UTC.

A local `robotmoney-site` checkout is therefore ~10 days stale by default and
its `public/data/regime-snapshot.json` reads `asof: 2026-08-04`. All work below
was pinned to `upstream/main`. The principal checkout was never written to.

## 3. Headline verdict

**The discrepancy is real, reproducible, and is a data-fidelity defect in v0 —
not a methodology, schedule, or porting difference.** v0's
`scripts/regime/update.js` persists its own forward-filled values back into
`data/regime/raw-indicator-history.csv`, and the next run reads them back as if
they were real source observations. Because the sources never re-publish those
dates, the fabricated rows can never be corrected, and each run re-seeds the
next.

Cleaning only the input floor — with v0's own code and math unchanged — moved
the macro index from **0.610602 → 0.653632** in the first captured run. In that
same run, ICSA contributed **+0.039932**, or **85.7%** of the
`0.657209 - 0.610602 = 0.046607` v1-v0 gap. These are dated observations, not
stable live constants. The exact live API responses and full counterfactual
inputs were not retained byte-for-byte, so the committed evidence supports the
defect mechanism and dated attribution rather than reproducing every historical
decimal exactly.

**The sampled v1 output matches the documented ICSA/DXY methodology**: across
**74 indicator-day comparisons on 59 unique dates** in the trailing 60-day API
history where the clean and polluted models differ, v1 matched the
source-date-cleaned computation on **74/74** and the polluted model on
**0/74**, to 6 decimals (§14). This does not prove every v1 input is globally
source-clean: the model retains persisted pre-window history where a source is
truncated, notably HY_OAS. v1 is also **not** clean by construction: its
vendored floor-seed fixture contains source-absent ICSA/DXY rows, and its
DB-rows-win seed path preserves those keys (**D6**). How production avoided or
removed them remains unresolved.

## 4. Severity summary

| # | Finding | Severity | Repo |
|---|---|---|---|
| D1 | Forward-filled values persisted as real observations; fabricated rows dated after the newest real print **shadow it** under forward-fill (§6, revised) | **CRITICAL** | v0 |
| D2 | `SHILLER_CAPE` frozen at 2023-09-01 — multpl scraper dead, datahub fallback ~3y stale | **HIGH** | v0 |
| D3 | `BTC_MVRV` returns HTTP 404 on every run; on-chain panel silently runs a member short | **HIGH** | v0 |
| D4 | HY_OAS weight-cap divergence — **attributed** to the two sides' different HY_OAS history spans, not to a weighting-code difference (§9) | **LOW** | both |
| D5 | No cross-implementation reconciliation check; a 0.05 divergence ran undetected | **MEDIUM** | both |
| D6 | **v1's vendored floor-seed fixture** (`backend/tests/fixtures/regime/raw-indicator-history.csv.gz`) contains 125 ICSA rows with value `215000` and 16 DXY rows with value `119.2868` (span → 2026-06-29), but those value counts are not all fabricated: classification by source key yields ICSA **110 source-absent, 13 genuine, 2 live-overwritten overlaps** and DXY **14 source-absent, 1 genuine, 1 live-overwritten overlap**. The DB-rows-win gap-fill seed path preserves source-absent keys because refresh has no matching key to overwrite (§14.2). | **HIGH (latent)** | v1 |
| D7 | FRED serves `BAMLH0A0HYM2` (HY_OAS) only as a trailing ~3y window; the `cosd=2010` workaround `fred.js` documents as the fix **does not work for this series**. Both sides' HY_OAS pre-history exists only in their persisted floors and is unrecoverable from source (§14.4) | **MEDIUM** | both |

## 5. The discrepancy, confirmed four ways

### Evidence provenance

All live-source and API numbers below are historical captures, not claims about
the value returned today. The machine-readable
[`20260814-macro-index-discrepancy.json`](evidence/20260814-macro-index-discrepancy.json)
records the capture date, repository commit SHAs, source URLs and intervals,
expected classifications, a 40-row polluted incident slice, and the selected
FRED source rows needed to classify it. Those rows are embedded directly in the
JSON and pinned by the Git commit containing this review; §13 shows an inline,
offline classification over them.

The evidence file contains **selected extracted rows, not complete raw HTTP
responses**. It does not archive the historical live v1 API response, full v0
floor, full FRED responses, or original counterfactual inputs. Tables based on
those mutable inputs are retained as dated review observations and should not
be expected to reproduce exactly.

| Source | As-of | Macro index |
|---|---|---|
| v1 live API `/api/dashboards/regime-snapshots` | 2026-08-14 | **0.657209** |
| v1 live API (history row, same call) | 2026-08-13 | **0.666934** |
| v0 published `public/data/regime-snapshot.json` @ `upstream/main` | 2026-08-13 | **0.610963** |
| **v0 pipeline executed fresh** (`node scripts/regime/update.js`) | 2026-08-14 | **0.610602** |

Two confounds are ruled out immediately:

- **Not an as-of offset.** On the *same* date (2026-08-13) the gap is **+0.0560**.
- **Not a stale artifact in the capture.** The captured 2026-08-14 v0 pipeline
  execution produced **0.6106**, matching its published 2026-08-13 value to 3dp.

Both sides use the identical 8-indicator macro panel, identical signs, identical
`level` transform, identical 1095-day rolling percentile window, and identical
bucket thresholds. A1 already proved every function on this path is bit-identical
across the two codebases over 3,098 real days.

## 6. D1 — CRITICAL — v0 persists its own forward-fills as real observations

### Mechanism

`scripts/regime/update.js:138`:

```js
writeRawHistoryCsv(RAW_HISTORY_CSV, dateAxis, aligned);
```

`aligned` is the **dense, already-forward-filled** series — one row per calendar
day, per indicator (`update.js:172-192`). The next run's `loadPersistedRaw`
(`update.js:194`) reads every one of those rows back as a genuine `{date, value}`
observation, and `mergeSeries(prior, fetched)` (`update.js:72`) unions them with
*fetched-wins-on-overlap*.

FRED never returns weekends, holidays, or unpublished days. Those dates are
therefore **never in `fetched`**, never overwritten, and the fabricated value
stands permanently. Each run writes one more day of fill, which the next run
promotes to fact.

**This is a composition defect, not a careless one.** Each half of the
mechanism is individually reasonable and individually documented:

- The *write* side was conceived as a snapshot, not a record — `update.js:135-137`
  says so explicitly: the CSV is *"what the indicator data looked like at cron
  time, **not a permanent record**"*. Writing the dense aligned view under that
  contract is fine.
- The *read* side (`loadPersistedRaw` + append-only `mergeSeries`) defends
  against a real, verified problem: sources that only serve a recent window
  (`NEW_TOKENS` current-day-only; `HY_OAS` trailing ~3y — see D7, which proves
  this concern legitimate). Treating persisted rows as a floor under that
  contract is also fine.

The defect is that the same file serves both contracts: the snapshot is read
back as the floor, which launders forward-fill into observations. The header at
`update.js:173-180` ("append-only by construction … history accumulates,
nothing gets dropped") is accurate about what it defends — nothing is
*dropped* — but the failure mode is rows being *added* and then locked in.

### Observed effect

`data/regime/raw-indicator-history.csv` @ `upstream/main`:

```
2026-08-01,ICSA,200000     <- real (FRED, week ending Sat)
2026-08-02,ICSA,215000     <- frozen filler
...
2026-08-07,ICSA,215000     <- frozen filler
2026-08-08,ICSA,209000     <- real
2026-08-09,ICSA,215000     <- frozen filler
...
2026-08-13,ICSA,215000     <- frozen filler
```

No ICSA print since late April 2026 carries the value `215000` (recent prints:
230, 227, 216, 217, 217, 209, 189, 198, 200, 209 thousand); its most recent
genuine occurrences are the weeks ending **2026-04-18** and 2025-12-20. It is a
stale carry frozen since 2026-05-24 and re-stamped on non-publication days. Do
not equate repeated-value counts with fabricated rows: in the vendored seed,
the 125 matching ICSA values classify as **110 source-absent dates, 13 genuine
observations, and 2 source-overlap rows corrected by live refresh** (§14.1).

**The structural proof, immune to any revision or vintage explanation**
(Appendix A): FRED's ICSA has observations **only on Saturdays** —
867 of 867 observations since 2010 — because it is a weekly week-ending series.
v0's floor holds ICSA rows on **all seven weekdays** (~449 each). Every
non-Saturday ICSA row is a date on which FRED has never had, and can never
have, an observation. The same holds for DXY: `DTWEXBGS` publishes business
days only; v0's floor has weekend rows. No data-revision story can make those
rows real. (The filler *values* are traceable to genuine prints — `119.2868`
is DTWEXBGS's real value for Friday **2026-05-22**, frozen ever since.)

**Why the chain never heals on its own**: both series publish with a lag (ICSA
on Thursday for the prior week-ending Saturday; DTWEXBGS roughly a week behind).
So on any given cron day, yesterday's *fabricated* row is always dated later
than the newest *real* observation — and forward-fill picks the latest-dated
row. The fabricated value therefore re-propagates daily and the revision
mechanism (`fetched wins on overlap`) can never reach it, because the fetch
never returns those dates.

`DXY` (`DTWEXBGS`) shows the identical mechanism: its business-daily source has
no weekend observations, while the floor contains weekend keys. In the seed
fixture's 16 rows carrying `119.2868`, **14 are source-absent keys, one is the
genuine 2026-05-22 observation, and one overlaps a source key that live refresh
corrects**.

Note the real weekly prints survive as **isolated single-day spikes** on their
own observation date, surrounded by filler. This is the signature of the bug:
ICSA for week ending Saturday *S* is published the following Thursday, by which
time the run of day *S* has already written filler to *S*, and the days between
have inherited it.

### Ground truth

In the manual review capture from `fredgraph.csv` (the same endpoint v0's own
fetcher uses, `scripts/regime/fetchers/fred.js:21`; this August response was not
retained byte-for-byte):

| Series | Last real observation | v0 reports | v1 reports |
|---|---|---|---|
| `ICSA` | 2026-08-08 → **209,000** | `215000` @ `2026-08-12` (snapshot `raw_date`; floor rows through `2026-08-13`) | `209000` @ `2026-08-08` ✅ |
| `DTWEXBGS` | 2026-08-07 → **119.0649** | `119.2868` @ `2026-08-12` (same) | `119.0649` @ `2026-08-07` ✅ |

v1 additionally exposes `forward_fill_age_days: 6` on ICSA — it tracks the true
age of the last real observation, because it persists the **sparse merged real
observations** and forward-fills only at read time
(`backend/src/analytics/store/raw-history-store.ts`; see A1 finding F1, which
recorded this storage-shape divergence as `DIVERGENT` without recognising it as
the cause of a live numeric defect).

### Mechanism decomposition

The review tested wrong current value and distorted ranking window as separate
effects. The executed decomposition shows that **the shadowing of the newest
real print is essentially the entire effect**, and the window distortion is
second-order and currently *opposite-signed*:

| ICSA @ 2026-08-14 | Value ranked | Window | Percentile |
|---|---|---|---|
| v0 published | 215,000 (filler) | polluted | **0.329224** |
| shadowing only | 215,000 (filler) | **clean** | **0.329224** |
| window pollution only | 209,000 (real) | polluted | 0.118721 |
| correct | 209,000 (real) | clean | **0.140639** |

Ranking the filler in a *clean* window reproduces v0's published number to six
decimals — the fabricated rows dated after 2026-08-08 shadow the real 209,000
print under forward-fill, and *that value substitution* is the whole error.
The source-absent rows inside the window shift the rank of a given value by only
~0.02, and in the *opposite* direction. Separately, the historical identity
`(314 + 0.5 × 92) / 1095 = 0.328767` holds for the 92 matching-value rows in the
08-13 snapshot; that value count is not itself a source-key classification.

This matters for the fix: purging the fabricated rows repairs both effects, but
the *urgent* half — the current snapshot attributing a genuine historical value
to a date for which FRED did not publish it — is repaired the moment the floor
stops carrying source-absent rows dated after the last real observation.

### Executed attribution

The dated counterfactual runs **v0's own `computeRegime`** over three input
floors with the same fetches, axis, and date. Their exact full inputs were not
committed; §13 supplies the durable, offline source-key classification:

| Run | Macro | Onchain | Composite |
|---|---|---|---|
| **A** — v0 as shipped (dense polluted floor ∪ fetch) | **0.610602** | 0.415475 | 0.513038 |
| **B** — source-date-cleaned replay, retaining persisted truncated-source prehistory | **0.653632** | 0.415475 | 0.534554 |
| v1 live, same date | **0.657209** | 0.396075 | 0.526642 |

Cleaning the floor alone moves v0 **+0.043031**, closing **92%** of the gap to
v1. Per-indicator, swapping one macro series at a time from A to B:

| Indicator | Δ macro in first captured run | Share of the 0.046607 gap | persisted rows | fetched rows | last real |
|---|---|---|---|---|---|
| **ICSA** | **+0.039932** | **85.7%** | 3142 | 867 | 2026-08-08 |
| **DXY** | +0.003224 | 6.9% | 3146 | 4133 | 2026-08-07 |
| HY_OAS | −0.000325 | — | 1172 | 787 | 2026-08-13 |
| DFII10 | +0.000062 | — | 3146 | 4155 | 2026-08-12 |
| T5YIE | +0.000030 | — | 3146 | 4156 | 2026-08-13 |
| VIX | −0.000022 | — | 3146 | 9223 | 2026-08-14 |
| COPPER_GOLD | +0.000008 | — | 3146 | 6512 | 2026-08-14 |
| T10Y2Y | −0.000002 | — | 3146 | 4156 | 2026-08-13 |

The `persisted rows` vs `fetched rows` columns are the tell: ICSA's floor holds
**3,142 rows for a weekly series** whose source serves 867. The pipeline's own
run log flags it without recognising it as a defect:

```
[regime] ICSA: fetch returned only 867 rows vs persisted 3142 — merging both (no history dropped)
```

The magnitude ordering follows publication cadence: ICSA is weekly, while DXY
is business-daily and therefore gains source-absent keys mainly on weekends and
holidays. The other daily series are affected primarily across non-publication
days, where forward-fill is appropriate as a view but not as a stored source
observation.

### Fix

Persist the **sparse merged real observations**; forward-fill at read time only —
i.e. adopt v1's storage shape. Two call sites: `writeRawHistoryCsv`
(`update.js:172`) must take `raw`/`merged` rather than `aligned`, and any
consumer that assumed a dense CSV must align on read.

**Database recovery is partial, not complete self-healing.** A live refresh can
correct a seeded row when the source returns the same `(date, indicator)` key,
and the latest displayed value can therefore recover. It does not delete keys
for dates the source never emits: repeated refreshes preserve the 110 ICSA and
14 DXY source-absent seed rows, so their percentile-window distortion remains
until those keys age out or are explicitly removed. Persisting the merged
history may also relabel retained seed rows as live, so provenance alone cannot
reliably locate the contamination afterward. A local database prototype
recorded in the evidence JSON exercised both the correcting-overlap and
persistent-source-absence cases on a representative 24-row source-absent
subset. Committing durable, loud-fail integration coverage is follow-up work,
not part of this documentation-only PR (§13).

**Downstream:** `data/regime/regime-history.csv` is frozen-vintage
(`mergeFrozenIntoResult`, `update.js:131`), so every historical row already
published under the polluted floor stays polluted unless a deliberate version
relock is performed (`rebuild.js --version`). That is a product decision, not a
code fix, and should be taken explicitly.

## 7. D2 — HIGH — `SHILLER_CAPE` frozen at 2023-09-01

From the executed run log:

```
[shiller] datahub fallback only: 1713 rows, last 2023-09-01
          (multpl failed: multpl: 0 rows parsed (HTML structure may have changed))
  ✓  SHILLER_CAPE   rows=  1713 last=2023-09-01
```

The primary scraper (`fetchers/multpl.js`) is broken against multpl's current
HTML, and the datahub fallback is ~3 years stale. The indicator is on the
**factor** panel, so it does not touch the macro index under way here — but v0's
`/regime-eq` three-panel composite is running on a dead input, and the fetch
summary prints `✓` for it because 1,713 rows came back. **Row count is not
freshness**; the `✓`/`✗ EMPTY` flag in `lib/fetch_all.js:32` cannot detect this
class of failure.

Note this interacts with D1: because the floor is dense, a totally dead source
still produces a full-looking daily series forever.

## 8. D3 — HIGH — `BTC_MVRV` 404s on every run

```
[regime] fetch BTC_MVRV (blockchain_com) FAILED: blockchain.com mvrv: HTTP 404
  ✗ EMPTY  BTC_MVRV  rows= 0 last=—
[regime] BTC_MVRV: empty series — composite for this indicator will be NaN
```

v0's on-chain panel therefore runs 9 members, not 10; `inverseCorrelationWeights`
excludes it via the `minValidObs` floor and renormalises the rest. v1 sources the
same indicator from coinmetrics (`CapMVRVCur`) and includes it at full weight.

This is A1 finding F2, still live and still unrepaired, and it explains the
on-chain gap visible in the table in §6 (v0 0.4155 vs v1 0.3961) — which is a
separate question from the macro discrepancy and was not pursued further here.

## 9. D4 — LOW — HY_OAS weight cap

In the first captured run, `0.657209 - 0.653632 = 0.003577` remained after the
source-date cleanup. This capture-specific residual is explained primarily by
the different HY_OAS history spans:

| Indicator | v0 weight (prod floor) | v0 weight (source-date-cleaned replay) | v1 weight |
|---|---|---|---|
| HY_OAS | 0.232010 | 0.232550 | **0.250000** (at cap) |
| ICSA | 0.206007 | 0.209540 | 0.203768 |
| COPPER_GOLD | 0.135064 | 0.133937 | 0.130762 |
| DXY | 0.100262 | 0.099709 | 0.095558 |
| T5YIE | 0.096515 | 0.096782 | 0.095771 |
| DFII10 | 0.080054 | 0.078732 | 0.077335 |
| VIX | 0.079718 | 0.078974 | 0.077933 |
| T10Y2Y | 0.070369 | 0.069774 | 0.068872 |

v0's own weights barely move between floors (max Δ 0.0035), so this is a genuine
v1-vs-v0 difference downstream of each side's correlation inputs, not a second
data bug.

The cause is the two sides' different HY_OAS *history spans*, not their
weighting code. FRED serves `BAMLH0A0HYM2`
only as a trailing ~3y window (D7): in the review capture that was 2023-08-15
onward. v0's floor additionally holds 2023-05-30 → 2023-08-14 accumulated from earlier fetches —
77 extra days a fresh deployment can never obtain. Re-running v0's own
`computeRegime` on the source-date-cleaned replay but with HY_OAS restricted to
what FRED served in that capture (the v1-like span) moves its weight
**0.2325 → 0.2467** (approximately the 0.25 cap, matching v1) and the macro
index to **0.655668** in that capture. A
later captured replay produced **0.658833**; mutable VIX and COPPER_GOLD inputs
make either number unsuitable as a timeless range or a current-value claim.
The exact values remain capture-specific; the committed evidence embeds the
source-key classification inputs, not these full-panel replay inputs.

Worth noting for its own sake: **v0's HY_OAS floor holds 1,172 rows against
787 fetched** — the same over-count signature as ICSA. The macro effect
measured at −0.000325 because `HY_OAS` is a daily series, but the floor is
polluted by the same mechanism.

## 10. D5 — MEDIUM — no source-fidelity or cross-output reconciliation gate

A 0.05 divergence on a published headline number ran undetected. The existing
assurance is:

- `backend/tests/regime-fidelity.test.ts` has two kinds of checks. The snapshot
  and regime-history goldens are generated by the current TS pipeline. The
  strict multi-day check is algorithmically independent: it compares the TS
  implementation with the vendored original JS reference and reports zero
  differences across 3,102 rows. That proves port fidelity, but both sides read
  the same raw fixture, so shared fixture provenance prevents it from detecting
  source-absent dates.
- `backend/tests/regime-staleness.test.ts` and `report/regime-projection.ts` —
  flag staleness at a 3-day threshold, and correctly reported `stale: false` here,
  because v1's data genuinely is fresh. It is v0 that is stale, and nothing on
  either side checks that.
- v0 has no test coverage of the regime pipeline at all.

Neither side would have caught this. Recommended, cheapest first:

1. **A freshness assertion against source, not against row count.** For each
   indicator, assert `last_real_observation_date` is within its declared
   publication cadence. This catches D1, D2, and D3 in one check, and is the
   single highest-value addition.
2. **A reconciliation job** that fetches v0's published snapshot and v1's API for
   the same date and alerts above a threshold (0.005 would have fired here on
   ~2026-05-24, the day the ICSA freeze began).
3. **Make `writeRawHistoryCsv`'s invariant testable** — for an indicator whose
   source serves the audited interval, assert that every `(date, indicator)` row
   in the persisted floor is present in the source response. Truncated sources
   such as HY_OAS need separate provenance and coverage-window assertions.

## 11. Hypotheses tested, with verdicts

The brief asked for the gap to be attributed across data fidelity, data gaps,
schedules, methodologies, and bugs in either codebase.

| Hypothesis | Verdict | Contribution |
|---|---|---|
| **Data fidelity** — v0 self-pollutes its raw floor (D1) | **CONFIRMED — dominant** | **~93%** |
| **Bug, v0 codebase** — same finding; this is a defect, not a design trade-off | **CONFIRMED** | (same) |
| **Weighting** — HY_OAS at cap in v1 only (D4) | **CONFIRMED — secondary, and now attributed to HY_OAS history-span difference (D7)** | ~5–8% |
| **Schedules / as-of offsets** | **RULED OUT** | 0 — same-date comparison shows the same gap; v0's cron is healthy and nightly |
| **Methodology** | **RULED OUT for the macro panel** | 0 — same 8 indicators, signs, transform, window, thresholds; §14.3 additionally shows the captured v1 ICSA/DXY output implements the documented method exactly |
| **Bug, v1 codebase** | **REVISED**: no error in the sampled output across 74 indicator-day comparisons on 59 unique dates (§14.1) — but a **latent CONFIRMED defect** in its seed path (D6) that contributed 0 in that capture |
| **Data gaps** — SHILLER_CAPE (D2), BTC_MVRV (D3) | **CONFIRMED but out-of-panel** | 0 to macro; material to factor and on-chain |
| **Frozen-vintage publication** (A1 F3) | **NOT A CONTRIBUTOR IN THE CAPTURE** | 0 — v0 left the capture date mutable; its replay matched the published value to 3dp |
| **Capture-vintage / float noise** (R8) | **NOT A CONTRIBUTOR** | ~1e-4 scale, three orders of magnitude too small |
| **Algorithm port fidelity** (A1) | **NOT A CONTRIBUTOR** | 0 — proven bit-identical, independently corroborated here |

## 12. What I could not settle

- **The genesis of the specific filler constants.** `215000` first appears in
  ICSA's floor on 2019-05-18 and `119.2868` in DXY's on 2026-05-22. The
  self-perpetuating mechanism is proven, but I did not walk the CSV's git history
  to identify the exact run that seeded each chain. It does not change the
  attribution — the counterfactual measures the effect directly, without needing
  the origin story.
- **The residual after source-date cleanup** is attributed to the HY_OAS
  history-span difference (§9); exact values depend on the dated live inputs.
- **How production v1 escaped the polluted seed.** `applyRawFloorSeed` preserves
  source-absent seed keys, yet the captured output matched the
  source-date-cleaned model in 74 indicator-day comparisons across 59 unique
  dates. Whether production skipped this seed, used another vintage, or later
  removed the keys is unresolved.
  Resolving it requires production-DB evidence that was unavailable here; do not
  infer startup self-healing from the clean output.
- **How far back the published history is contaminated.** D1 has been active on
  DXY since at least 2026-05-22 and on ICSA since at least 2026-05-24, but the
  mechanism is structural and likely predates that. I did not date its onset, and
  `regime-history.csv`'s frozen rows mean the published series carries whatever
  contamination existed when each row was locked.
- **The on-chain gap** (v0 0.4155 vs v1 0.3961). Out of scope for the macro
  question; D3 is the obvious first suspect, unquantified here.
- **Whether v1 has a latent equivalent.** v1's storage shape is structurally
  immune to the live-write feedback loop, and its sampled values matched the
  source. I did not audit v1's other persistence paths for the same anti-pattern.

## 13. Reproduction

PR #620 is documentation-only. It commits the evidence JSON, but not a test
suite or a separate forensic fixture. The following offline sample reads only
committed files and fails if either the 40-row incident classification or the
full vendored-floor classification differs from the recorded counts:

```bash
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const path = "docs/code-review/evidence/20260814-macro-index-discrepancy.json";
const e = JSON.parse(readFileSync(path, "utf8"));
const classify = (sourceRows, floorRows) => {
  const source = new Map(sourceRows.map((row) => [row.date, row.value]));
  return {
    source_absent_rows: floorRows.filter((row) => !source.has(row.date)).length,
    stale_overlap_rows: floorRows.filter(
      (row) => source.has(row.date) && source.get(row.date) !== row.value,
    ).length,
    matching_overlap_rows: floorRows.filter(
      (row) => source.get(row.date) === row.value,
    ).length,
  };
};
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  console.log(label, actual);
};

for (const id of ["ICSA", "DXY"]) {
  check(
    `incident ${id}`,
    classify(e.captured_sources[id].incident_rows, e.polluted_incident_slice[id]),
    e.incident_slice_expected[id],
  );
}

const csv = gunzipSync(readFileSync(e.vendored_floor.path)).toString("utf8");
const floor = csv.trim().split("\n").slice(1).map((line) => {
  const [date, indicator, value] = line.split(",");
  return { date, indicator, value: Number(value) };
});
for (const id of ["ICSA", "DXY"]) {
  const source = e.captured_sources[id];
  const candidates = floor.filter(
    (row) => row.indicator === id && row.value === source.candidate_value,
  );
  check(
    `full ${id}`,
    { candidate_rows: candidates.length, ...classify(source.candidate_source_overlaps, candidates) },
    e.full_fixture_expected[id],
  );
}
NODE
```

This sample proves the source-key classification, not the historical live API
decimals or database recovery behavior. Durable follow-up coverage should add
a hermetic canonical-source fixture and a loud-fail ephemeral-Postgres test for
overlap correction, source-absent retention, provenance relabeling,
non-convergence on rerun, and recovery after explicit deletion.

---

## 14. Evidence details

The review treats neither implementation as ground truth. Matching a current
raw value is necessary but insufficient because a correct value ranked in a
corrupted window can still yield a wrong percentile; the review therefore
compares source keys, percentile histories, and both implementations.

### 14.1 Sampled v1 ICSA/DXY output is clean in effect, but the seed is at risk

The threat: A1 finding F1 records that v1's floor seed is **v0's dense aligned
CSV** — and direct inspection of the vendored fixture
(`backend/tests/fixtures/regime/raw-indicator-history.csv.gz`, span 2018-01-01 →
2026-06-29) confirms **125 ICSA rows with value `215000`** and **16 DXY rows
with value `119.2868`**. Source-key classification separates them as follows:

| Indicator | Source-absent and retained | Genuine source observation | Source overlap corrected live |
|---|---:|---:|---:|
| ICSA | **110** | 13 | 2 |
| DXY | **14** | 1 | 1 |

Only the 110 and 14 source-absent keys persist indefinitely absent deletion;
the live write path corrects the two ICSA and one DXY overlap rows. These are
the full vendored-fixture counts reproduced by the offline §13 sample. The
embedded 40-row incident slice contains 24 source-absent rows and three stale
overlaps. A local SQL prototype exercised those cases end to end, but durable
database coverage is explicitly follow-up work and is not included in PR #620.

The dated manual comparison built four models from FRED rows, seed fixture, and
v0 floor, computed percentiles with the shared mid-rank rule, and compared them
with the captured 60-day v1 API history. On every indicator-day where the
source-date-cleaned and seeded-hybrid models disagree (ICSA: 25 comparisons;
DXY: 49 comparisons; **74 comparisons across 59 unique dates**):

| Model | ICSA match | DXY match |
|---|---|---|
| **B — source-date-cleaned ICSA/DXY forward-fill** | **25/25** | **49/49** |
| C — hybrid (polluted seed ≤ 06-29 + real obs after) | 0/25 | 0/49 |

Matches are exact to 6 decimals. **For these 74 captured ICSA/DXY comparisons,
v1 publishes the source-date-cleaned computation.** This does not establish a
globally source-only floor: model B retains persisted pre-window history for
truncated sources such as HY_OAS. How production avoided the source-absent seed
keys is unresolved (§12). `applyRawFloorSeed` (`store/floor-seed.ts:22`) uses a
DB-rows-win gap fill: overlap keys can be corrected by a live write, but
source-absent keys are not removed by repeated refresh.

### 14.2 The root cause of the divergence, restated precisely

Both codebases share polluted *ancestry* (v1's fixture is v0's floor). The
live divergence exists because the two sides behave differently **after** the
seed cutoff (2026-06-29):

- **v0** continues to stamp forward-fill as fact daily; its floor carries
  fabricated rows dated *after* the newest real print, which **shadow** that
  print under forward-fill — so it ranks genuine historical values on dates
  for which the source did not publish them (`215000` instead of the current
  ICSA print `209000`; `119.2868` instead of `119.0649`).
- **v1** (in effect) accumulates only real observations post-cutoff and
  forward-fills at read time — so it ranks the true latest print, with an
  honest `forward_fill_age_days`.

The onset of material divergence is therefore not gradual drift but the
2026-06-29 fork point, compounded by every subsequent v0 run.

### 14.3 What is the *correct* calculation for the product?

Three candidate methodologies were computed side-by-side to check whether some
third convention — not implemented by either side — is what the product
actually promises:

| Methodology | ICSA pct @ 08-14 | DXY pct @ 08-14 | Implemented by |
|---|---|---|---|
| **B** — source-date-cleaned ICSA/DXY daily forward-fill | **0.140639** | **0.088584** | **v1 capture (exactly)** |
| A — v0's polluted floor | 0.329224 | 0.116438 | v0 |
| E — native-cadence (rank prints against prints, no daily fill) | 0.141026 | 0.083893 | neither |
| PIT — point-in-time release-calendar fill | (differs on 13/13 sampled days from both) | — | neither |

The product's own documents pin the intent:

- Both dashboards, verbatim: *"Normalization: rolling 3-year percentile rank
  per indicator, sign-aligned"* (`src/app/regime/page.tsx:79` in v0;
  `frontend/public/views/regime.html:253` in v1).
- `docs/regime/CONTEXT.md` (v0): the percentile is *"where is today's value in
  the trailing 3y distribution of itself"*, with publication-cadence
  forward-fill explicitly discussed and accepted as the alignment.
- ICSA's published derivation: *"Published every Thursday for the prior week
  ending Saturday. **We use the raw weekly count.**"* — the published count,
  which was 209,000 in the capture. Although `215000` is a genuine older print,
  FRED did not publish it for the date/current observation v0 attributed it to.
- `mergeSeries`' contract (*"fetched wins on overlap so source corrections /
  revisions land"*, `lib/utils.js:343`) commits both sides to **current
  vintage**, ruling out PIT as the documented intent. v0 handles the
  point-in-time concern at the *publication* layer instead (frozen
  `regime-history.csv`), which is a deliberate, documented choice.

**Verdict: for the audited ICSA/DXY keys, the documented calculation is B —
source-date-cleaned current-vintage daily forward-fill — and the captured v1
output implements it exactly.** B is not globally source-only because it
retains persisted history for truncated sources such as HY_OAS; B2 is the
separate replay that limits HY_OAS to its currently source-servable span. The
defensible third option, E (native-cadence ranking), would remove the implicit
overweighting of stale values that daily forward-fill introduces for weekly
series; it is statistically reasonable and lands within ~0.005 of B on these
indicators, but it is not what either dashboard documents, and adopting it
would be a methodology change requiring a version relock — not a bug fix.

The dated 2026-08-14 observations establish the direction and attribution of
the discrepancy, not a timeless numeric range. The live macro later moved to
`0.6600156`, and a later B2 replay produced `0.658833`; current values must be
re-fetched and separately timestamped rather than compared with the historical
capture as if all inputs shared a vintage.

### 14.4 Seed and source-window findings

- **D6** (HIGH, latent, v1): the vendored seed fixture contains 110 ICSA and 14
  DXY source-absent keys that the seed/refresh path retains absent explicit
  deletion. Regenerate the fixture from source observations, then add the
  classification and database-boundary tests described in §13. Do not delete
  rows merely because a value repeats; repeated values can be genuine.
- **D7** (MEDIUM, both): FRED's `fredgraph.csv` serves `BAMLH0A0HYM2` only as a
  trailing ~3y window; verified directly — `cosd=2010-01-01` returns rows from
  2023-08-15 (**787 valid observations** in the captured response). The
  `fred.js` comment claiming `cosd` fixes this
  truncation is wrong for this series. Consequence: HY_OAS pre-history lives
  only in the persisted floors, its 1095-day percentile window is exactly at
  the edge of what the source can re-serve, and the two sides' different spans
  measurably change panel weights (§9). Worth a loud freshness/coverage
  assertion of its own.

---

## Appendix A. Verification history

The review was rerun against separately captured inputs and explicitly tested
innocent explanations for v0's behavior. The evidence JSON embeds the selected
source and polluted-floor rows used by §13, while this appendix records the
other dated checks without presenting the revision chronology as separate
competing conclusions.

### A.1 Implementation self-check

Before trusting any number in this document, the review's own percentile
implementation was validated against v0's production output: computed from
v0's own floor for the 2026-08-13 snapshot date, it reproduces v0's published
percentile for **all 8 macro indicators to 9 decimal places** (T10Y2Y 0.657534247,
DFII10 0.973515982, T5YIE 0.169406393, HY_OAS 0.095433790, DXY 0.115981735,
ICSA 0.328767123, VIX 0.258904110, COPPER_GOLD 0.372146119). The math used to
audit v0 is therefore v0's own math.

### A.2 Innocent explanations, hunted and excluded

| Candidate explanation for v0's values | Outcome |
|---|---|
| The filler rows are real observations later revised away | **Excluded structurally.** FRED ICSA observations exist only on Saturdays (867/867 since 2010); v0's floor has ICSA rows on all 7 weekdays. `DTWEXBGS` publishes business days only; v0's floor has weekend rows. Dates without observations cannot be revised — they never existed. |
| The filler values are fabricated numbers | **No — and this is fairer to v0.** `119.2868` is DTWEXBGS's genuine value for Friday 2026-05-22. `215000` genuinely printed for the weeks ending 2026-04-18 and 2025-12-20. The values are real; only their *dates* are fabricated by the snapshot-read-as-floor loop. |
| The dense CSV is intended behavior | **Half true, and documented in §6.** The write side is explicitly documented as a snapshot ("not a permanent record", `update.js:135-137`); the read side treats it as an observation floor for legitimate resilience reasons. The defect is the composition, not either half. |
| v1's agreement with FRED is luck / v1 has its own offsetting bug | **Excluded for the audited indicators and dated manual capture.** The clean-vs-hybrid discrimination yielded 74/74 indicator-day matches across 59 unique dates, and 0/74 polluted-model matches. The historical API inputs were not hash-pinned. |
| An earlier run used a transient vintage | **Excluded for the embedded source-key classification.** The evidence JSON records the reviewed commits and extracted source rows. The broader live-output decimals remain dated observations because their complete responses were not retained. |

### A.3 Capture-to-capture stability

| Quantity | This run | First run | Verdict |
|---|---|---|---|
| A — v0 as shipped | 0.611550 | 0.610602 | stable (intraday drift ±0.001, VIX/COPPER_GOLD live) |
| B — source-date-cleaned replay with retained prehistory | 0.654571 | 0.653632 | stable |
| B2 — source-date-cleaned + source-servable HY_OAS span | **0.657701** | 0.655668 | capture-specific |
| ICSA swap | +0.039923 | +0.039932 | stable |
| DXY swap | +0.003223 | +0.003224 | stable |

The percentages are run-specific: the first capture's ICSA share is 85.7%
(§6), while the third capture's changed live denominator yields 87.4%. Absolute
deltas are the more stable attribution evidence.

### A.4 Standing conclusion

The finding survives adversarial re-verification. Stated with the precision the
evidence supports: **v0's pipeline output for 2026-08-13/14 attributes to the
current day a value whose provenance is a forward-fill loop, not a source
observation; the dominant captured deltas are ICSA `+0.039932` and DXY
`+0.003224`, with the remaining material difference explained by the HY_OAS
span; and the sampled v1 ICSA/DXY percentiles match the documented
source-date-cleaned methodology.** The defect arises from the
interaction of two individually sound, individually documented design
decisions in v0 — a snapshot file also serving as the observation floor — and
its fix (persist sparse real observations; align at read time) is small and
does not change v0's methodology.
