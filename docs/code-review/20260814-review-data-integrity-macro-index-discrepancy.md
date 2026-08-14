# Data Integrity Review — Macro index discrepancy, v1 0.657 vs v0 0.611 — 2026-08-14

> **Revised same-day after a second-pass adversarial review** that treated
> neither implementation as the reference. The re-review confirmed the root
> cause, sharpened the mechanism (§6), closed the weighting residual (§9),
> **found a latent defect on the v1 side too (D6)**, and grounded the
> previously under-supported "v1 is correct" claim with 74/74-day executed
> evidence (§14). Sections carrying revisions are marked.

## 1. Scope and pinned commits

- **Question**: `robotmoney-frontend` (v1) published a Macro index of **0.66** on
  2026-08-14 while running the research pipeline from `robotmoney-site` (v0) for
  the same indicator produced **0.61**. Confirm the discrepancy by executing v0's
  full pipeline, then attribute the gap across data fidelity, data gaps,
  schedules, methodology, and code defects.
- **v0 (live production)**: https://github.com/agentjuno/robotmoney @ `2f8cf171`
  — see §2, the repo identity is a trap.
- **v1 (under comparison)**: https://github.com/robotmoney/robotmoney-frontend,
  live API at `https://robotmoney.network`. Doc branch
  `adhoc/20260814-macro-index-discrepancy` off `main` @ `ccf983f`.
- **Executed**: 2026-08-14, in worktrees
  `adhoc-20260814-macro-discrepancy` (v0, detached @ `2f8cf171`) and
  `adhoc-20260814-macro-index-discrepancy` (v1, this doc).
- **Method**: live execution, not replay. v0's `scripts/regime/update.js` was run
  end to end against live sources; v1's number was read from its production API;
  FRED was queried directly for ground truth. A counterfactual harness
  (`counterfactual.js`, in the v0 worktree) re-runs **v0's own `computeRegime`**
  over three different input floors to isolate input pollution from algorithm
  difference.
- **Second-pass method** (§14): trust-neither verification. Candidate floor
  models (clean current-vintage, seeded-hybrid, native-cadence, point-in-time)
  were rebuilt from primary sources only — FRED CSVs, v1's vendored seed
  fixture, v0's committed floor — and their percentiles compared against 60
  days of v1's live API history (`range=60`, per-row `percentiles` map) on
  every day where the models disagree. The seed fixture was inspected directly
  for fabricated rows; FRED's serve-window behavior for `BAMLH0A0HYM2` was
  tested directly; the HY_OAS span hypothesis was tested by re-running v0's
  `computeRegime` with a span-restricted floor (`counterfactual.js` variant B2).
- **Relationship to prior work**: extends
  [`docs/audits/v0-v1-parity/A1-regime-core-procedures.md`](../audits/v0-v1-parity/A1-regime-core-procedures.md)
  (algorithm parity PROVEN bit-identical) and
  [`R8-residual-attribution.md`](../audits/v0-v1-parity/R8-residual-attribution.md)
  (capture-vintage residuals at ~1e-4). This review concerns a **~5e-2** gap,
  three orders of magnitude larger, and finds a different, structural cause.

## 2. Repo identity — read this before reproducing

`~/robotmoney/robotmoney-site`'s `origin` (`robotmoney/robotmoney-site`) is a
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

Cleaning only the input floor — with v0's own code, v0's own math, unchanged —
moves v0's macro index from **0.6106 → 0.6536**, landing within **0.0036** of
v1's 0.6572. **ICSA alone accounts for 87% of the gap.**

**v1's published output is the documented methodology, computed correctly** —
this is now proven by execution, not assumed: across all 74 days in the trailing
60-day API history where a clean floor and a polluted floor produce different
percentiles, v1 matches the clean current-vintage computation on **74/74** and
the polluted model on **0/74**, to 6 decimals (§14). But v1 is **not** clean by
construction: its vendored floor-seed fixture embeds v0's fabricated rows and
its seed-ingestion path would implant them permanently into any freshly seeded
deployment (**D6**). Production evidently escaped that path; the fixture remains
armed.

## 4. Severity summary

| # | Finding | Severity | Repo |
|---|---|---|---|
| D1 | Forward-filled values persisted as real observations; fabricated rows dated after the newest real print **shadow it** under forward-fill (§6, revised) | **CRITICAL** | v0 |
| D2 | `SHILLER_CAPE` frozen at 2023-09-01 — multpl scraper dead, datahub fallback ~3y stale | **HIGH** | v0 |
| D3 | `BTC_MVRV` returns HTTP 404 on every run; on-chain panel silently runs a member short | **HIGH** | v0 |
| D4 | HY_OAS weight-cap divergence — **attributed** (second pass): caused by the two sides' different HY_OAS history spans, not by a weighting-code difference (§9, revised) | **LOW** | both |
| D5 | No cross-implementation reconciliation check; a 0.05 divergence ran undetected | **MEDIUM** | both |
| D6 | **v1's vendored floor-seed fixture** (`backend/tests/fixtures/regime/raw-indicator-history.csv.gz`) embeds v0's fabricated rows (125 ICSA + 16 DXY filler rows, span → 2026-06-29); the gap-fill seed path (`store/floor-seed.ts`, DB-rows-win) would implant them **permanently** in any freshly seeded deployment — the fetch never returns those dates, so they can never be corrected (§14.2) | **HIGH (latent)** | v1 |
| D7 | FRED serves `BAMLH0A0HYM2` (HY_OAS) only as a trailing ~3y window; the `cosd=2010` workaround `fred.js` documents as the fix **does not work for this series**. Both sides' HY_OAS pre-history exists only in their persisted floors and is unrecoverable from source (§14.4) | **MEDIUM** | both |

## 5. The discrepancy, confirmed four ways

| Source | As-of | Macro index |
|---|---|---|
| v1 live API `/api/dashboards/regime-snapshots` | 2026-08-14 | **0.657209** |
| v1 live API (history row, same call) | 2026-08-13 | **0.666934** |
| v0 published `public/data/regime-snapshot.json` @ `upstream/main` | 2026-08-13 | **0.610963** |
| **v0 pipeline executed fresh** (`node scripts/regime/update.js`) | 2026-08-14 | **0.610602** |

Two confounds are ruled out immediately:

- **Not an as-of offset.** On the *same* date (2026-08-13) the gap is **+0.0560**.
- **Not a stale artifact.** Executing v0's pipeline live today reproduces
  **0.6106**, matching its published 2026-08-13 value to 3dp.

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
stale carry frozen since 2026-05-24 and re-stamped on every non-publication day
since — **92 of the 1095 days (8.4%)** in the current percentile window.

**The structural proof, immune to any revision or vintage explanation** (final
verification pass, §15): FRED's ICSA has observations **only on Saturdays** —
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

`DXY` (`DTWEXBGS`) shows the identical shape: `119.2868` on every weekend and
market holiday since 2026-05-22 — 32 days (2.9%) — including 2026-06-19
(Juneteenth) and 2026-07-04.

Note the real weekly prints survive as **isolated single-day spikes** on their
own observation date, surrounded by filler. This is the signature of the bug:
ICSA for week ending Saturday *S* is published the following Thursday, by which
time the run of day *S* has already written filler to *S*, and the days between
have inherited it.

### Ground truth

Queried directly at review time, `fredgraph.csv` (the same endpoint v0's own
fetcher uses, `scripts/regime/fetchers/fred.js:21`):

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

### Mechanism decomposition (revised in second pass)

The first draft of this review framed the damage as two comparable effects:
wrong today-value plus a distorted ranking window. The executed decomposition
shows that framing was wrong — **the shadowing of the newest real print is
essentially the entire effect**, and the window distortion is second-order and
currently *opposite-signed*:

| ICSA @ 2026-08-14 | Value ranked | Window | Percentile |
|---|---|---|---|
| v0 published | 215,000 (filler) | polluted | **0.329224** |
| shadowing only | 215,000 (filler) | **clean** | **0.329224** |
| window pollution only | 209,000 (real) | polluted | 0.118721 |
| correct | 209,000 (real) | clean | **0.140639** |

Ranking the filler in a *clean* window reproduces v0's published number to six
decimals — the fabricated rows dated after 2026-08-08 shadow the real 209,000
print under forward-fill, and *that value substitution* is the whole error.
The 92 filler rows inside the window shift the rank of a given value by only
~0.02, and in the *opposite* direction. (The filler percentile identity
`(314 + 0.5 × 92) / 1095 = 0.328767` from the first draft still holds for the
08-13 snapshot.)

This matters for the fix: purging the fabricated rows repairs both effects, but
the *urgent* half — today's published value being a number FRED never printed —
is repaired the moment the floor stops carrying rows dated after the last real
observation.

### Executed attribution

`counterfactual.js` runs **v0's own `computeRegime`** over three input floors,
same live fetch, same axis, same date:

| Run | Macro | Onchain | Composite |
|---|---|---|---|
| **A** — v0 as shipped (dense polluted floor ∪ fetch) | **0.610602** | 0.415475 | 0.513038 |
| **B** — v0 code, clean floor (real observations only) | **0.653632** | 0.415475 | 0.534554 |
| v1 live, same date | **0.657209** | 0.396075 | 0.526642 |

Cleaning the floor alone moves v0 **+0.043031**, closing **92%** of the gap to
v1. Per-indicator, swapping one macro series at a time from A to B:

| Indicator | Δ macro when cleaned | Share of the 0.0466 gap | persisted rows | fetched rows | last real |
|---|---|---|---|---|---|
| **ICSA** | **+0.039932** | **87%** | 3142 | 867 | 2026-08-08 |
| **DXY** | +0.003224 | 7% | 3146 | 4133 | 2026-08-07 |
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

The magnitude ordering follows publication cadence exactly — weekly series
(ICSA, DXY) are badly affected because 5–6 of every 7 days are fabricated; daily
series (T10Y2Y, DFII10, T5YIE, VIX) are affected only across weekends, where
forward-fill is the correct answer anyway.

### Fix

Persist the **sparse merged real observations**; forward-fill at read time only —
i.e. adopt v1's storage shape. Two call sites: `writeRawHistoryCsv`
(`update.js:172`) must take `raw`/`merged` rather than `aligned`, and any
consumer that assumed a dense CSV must align on read.

**This will not self-heal.** The ~92 poisoned ICSA rows and 32 DXY rows are
already committed to `raw-indicator-history.csv`; they must be purged, or they
remain inside the trailing 1095-day window for another three years. A purge is
mechanically simple — drop every row whose `(date, indicator)` pair is not
present in a fresh full-history fetch from the source.

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

After D1 is corrected, ~8% of the original gap remains (v1 0.6572 vs clean-floor
v0 0.6536 = **0.0036**). It is weighting, not data:

| Indicator | v0 weight (prod floor) | v0 weight (clean floor) | v1 weight |
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

**Second-pass attribution — closed.** The cause is the two sides' different
HY_OAS *history spans*, not their weighting code. FRED serves `BAMLH0A0HYM2`
only as a trailing ~3y window (D7): today that is 2023-08-15 onward. v0's floor
additionally holds 2023-05-30 → 2023-08-14 accumulated from earlier fetches —
77 extra days a fresh deployment can never obtain. Re-running v0's own
`computeRegime` on the clean floor but with HY_OAS restricted to what FRED
serves today (the v1-like span) moves its weight **0.2325 → 0.2467** (≈ the
0.25 cap, matching v1) and the macro index to **0.6557** — within **0.0016** of
v1's 0.6572. That residual is at the noise floor of live intraday inputs (run A
itself drifted 0.6106 → 0.6096 between two executions hours apart, VIX and
COPPER_GOLD being live). Nothing about the weighting difference is left
unexplained at material magnitude.

Worth noting for its own sake: **v0's HY_OAS floor holds 1,172 rows against
~790 fetched** — the same over-count signature as ICSA. The macro effect
measured at −0.000325 because `HY_OAS` is a daily series, but the floor is
polluted by the same mechanism.

## 10. D5 — MEDIUM — nothing compares the two implementations against each other

A 0.05 divergence on a published headline number ran undetected. The existing
assurance is:

- `backend/tests/regime-fidelity.test.ts` — measures v1 against
  `backend/tests/fixtures/regime/regime-history.csv.gz`, which A1 §F3 already
  documented as **regenerated from the v1 pipeline itself** by
  `backend/scripts/regime-goldens-regenerate.ts`. Self-referential; cannot detect
  this.
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
3. **Make `writeRawHistoryCsv`'s invariant testable** — assert that every
   `(date, indicator)` row in the persisted floor is present in a fresh source
   fetch, for at least one weekly-cadence indicator.

## 11. Hypotheses tested, with verdicts

The brief asked for the gap to be attributed across data fidelity, data gaps,
schedules, methodologies, and bugs in either codebase.

| Hypothesis | Verdict | Contribution |
|---|---|---|
| **Data fidelity** — v0 self-pollutes its raw floor (D1) | **CONFIRMED — dominant** | **~93%** |
| **Bug, v0 codebase** — same finding; this is a defect, not a design trade-off | **CONFIRMED** | (same) |
| **Weighting** — HY_OAS at cap in v1 only (D4) | **CONFIRMED — secondary, and now attributed to HY_OAS history-span difference (D7)** | ~5–8% |
| **Schedules / as-of offsets** | **RULED OUT** | 0 — same-date comparison shows the same gap; v0's cron is healthy and nightly |
| **Methodology** | **RULED OUT for the macro panel** | 0 — same 8 indicators, signs, transform, window, thresholds; §14.3 additionally proves v1's *output* implements the documented method exactly |
| **Bug, v1 codebase** | **REVISED**: no error in what v1 currently publishes (74/74-day executed proof, §14.1) — but a **latent CONFIRMED defect** in its seed path (D6) that contributes 0 today |
| **Data gaps** — SHILLER_CAPE (D2), BTC_MVRV (D3) | **CONFIRMED but out-of-panel** | 0 to macro; material to factor and on-chain |
| **Frozen-vintage publication** (A1 F3) | **NOT A CONTRIBUTOR TODAY** | 0 — v0 leaves the current day mutable; fresh recompute matched published to 3dp |
| **Capture-vintage / float noise** (R8) | **NOT A CONTRIBUTOR** | ~1e-4 scale, three orders of magnitude too small |
| **Algorithm port fidelity** (A1) | **NOT A CONTRIBUTOR** | 0 — proven bit-identical, independently corroborated here |

## 12. What I could not settle

- **The genesis of the specific filler constants.** `215000` first appears in
  ICSA's floor on 2019-05-18 and `119.2868` in DXY's on 2026-05-22. The
  self-perpetuating mechanism is proven, but I did not walk the CSV's git history
  to identify the exact run that seeded each chain. It does not change the
  attribution — the counterfactual measures the effect directly, without needing
  the origin story.
- ~~The residual 0.0036 after cleaning~~ — **closed in the second pass** (§9):
  HY_OAS history-span difference; remaining ≤0.0016 is live-input intraday noise.
- **How production v1 escaped the polluted seed.** The vendored fixture contains
  the fabricated rows and `applyRawFloorSeed` would have implanted them (DB rows
  win; the fetch never returns those dates) — yet live output matches the clean
  model on 74/74 discriminating days. Either production was never seeded through
  this path, was seeded from a pre-May-2026 vintage of the fixture, or the rows
  were purged since. Resolving this needs a `SELECT ... WHERE source='seed'`
  against the production DB — out of reach from this session. The fixture itself
  is polluted regardless (verified directly), so D6 stands.
- **How far back the published history is contaminated.** D1 has been active on
  DXY since at least 2026-05-22 and on ICSA since at least 2026-05-24, but the
  mechanism is structural and likely predates that. I did not date its onset, and
  `regime-history.csv`'s frozen rows mean the published series carries whatever
  contamination existed when each row was locked.
- **The on-chain gap** (v0 0.4155 vs v1 0.3961). Out of scope for the macro
  question; D3 is the obvious first suspect, unquantified here.
- **Whether v1 has a latent equivalent.** v1's storage shape is structurally
  immune to D1, and its live values match source. I did not audit v1's other
  persistence paths for the same anti-pattern.

## 13. Reproduction

```bash
# v0 — pin to LIVE production, not the frozen fork
cd robotmoney-site && git fetch upstream
git worktree add --detach /tmp/v0-check upstream/main
cd /tmp/v0-check && node scripts/regime/update.js      # -> macro = 0.611

# ground truth
curl -s 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=ICSA&cosd=2026-06-01' | tail -3

# v1
curl -s 'https://robotmoney.network/api/dashboards/regime-snapshots?range=5' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["latest"]["macroIndex"])'

# the filler, visible directly
grep ',ICSA,' /tmp/v0-check/data/regime/raw-indicator-history.csv | tail -15
```

The counterfactual harness is `counterfactual.js` in the v0 worktree
`~/tmp/superfield-worktrees/robotmoney-site/adhoc-20260814-macro-discrepancy`.
That worktree's `data/` is dirty from the pipeline run and must not be committed.

### Second-pass reproduction (§14 evidence)

```bash
# D6 — v1's vendored seed fixture contains v0's fabricated rows
zcat backend/tests/fixtures/regime/raw-indicator-history.csv.gz \
  | awk -F, '$2=="ICSA" && $3=="215000"' | wc -l          # -> 125
zcat backend/tests/fixtures/regime/raw-indicator-history.csv.gz \
  | awk -F, '$2=="DXY" && $3=="119.2868"' | wc -l         # -> 16
zcat backend/tests/fixtures/regime/raw-indicator-history.csv.gz \
  | tail -1                                                # -> ...2026-06-29 (cutoff)

# D7 — FRED serves BAMLH0A0HYM2 only as a trailing ~3y window; cosd is ignored
curl -s 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2&cosd=2010-01-01' \
  | sed -n '2p'                                            # -> first row 2023-08-15, not 2010

# 74/74 clean-vs-hybrid discrimination (sketch; full logic in §14.1):
#  1. pull v1 history:  GET /api/dashboards/regime-snapshots?range=60
#     (each row's `percentiles` map is SIGNED; raw pct = 1 - p for sign -1)
#  2. build model B: FRED obs only (ICSA, DTWEXBGS from fredgraph.csv),
#     forward-filled daily; model C: seed fixture rows <= 2026-06-29 unioned
#     with FRED obs (FRED wins on overlap), forward-filled daily
#  3. per day D: pct = (count<x + 0.5*count==x)/1095 over the trailing
#     1095-day window; keep only days where B != C; compare v1's raw pct
#  -> ICSA 25/25 days match B, DXY 49/49 match B; 0/74 match C (6dp)

# Decomposition — shadowing is the whole D1 effect (§6):
#   rank 215000 in the CLEAN window  = 0.329224  (== v0's published pct)
#   rank 209000 in v0's own window   = 0.118721  (window pollution alone, opposite sign)

# B2 — HY_OAS span experiment (§9): in the v0 worktree,
node counterfactual.js <path-to-v0-raw-indicator-history.csv>
#   B  (clean, v0 HY_OAS span)        -> macro ~0.6525-0.6536, HY_OAS w=0.2325
#   B2 (clean, FRED-servable span)    -> macro ~0.6557,        HY_OAS w=0.2467
```

---

## 14. Second-pass adversarial review (2026-08-14, same day)

This pass re-examined the review's conclusions under the instruction to trust
*neither* implementation — in particular the first draft's "v1 is the correct
side," which had rested on today's raw values matching FRED, a necessary but
not sufficient condition (a correct raw value ranked in a corrupted window
still yields a wrong percentile).

### 14.1 v1's floor is provably clean in effect — but was at risk by construction

The threat: A1 finding F1 records that v1's floor seed is **v0's dense aligned
CSV** — and direct inspection of the vendored fixture
(`backend/tests/fixtures/regime/raw-indicator-history.csv.gz`, span 2018-01-01 →
2026-06-29) confirms it contains the fabricated rows: **125 ICSA rows of
`215000`** and **16 DXY rows of `119.2868`**. Had those rows entered the live
DB, v1's percentile windows would be polluted through mid-2029 (D6).

The test: four models of what each side's effective floor could be were built
from primary sources only (FRED CSV + the seed fixture + v0's committed floor),
percentiles computed with the shared mid-rank rule, and compared against 60
days of v1's live API history. On every day where the clean and seeded-hybrid
models disagree (ICSA: 25 days; DXY: 49 days — 74 in total):

| Model | ICSA match | DXY match |
|---|---|---|
| **B — clean current-vintage forward-fill** | **25/25** | **49/49** |
| C — hybrid (polluted seed ≤ 06-29 + real obs after) | 0/25 | 0/49 |

Matches are exact to 6 decimals. **What v1 publishes is the clean
current-vintage computation, full stop.** How production avoided the seed's
pollution is unresolved (§12) — the fixture remains a loaded gun for any fresh
deployment, demo, or CI environment that seeds through
`applyRawFloorSeed` (`store/floor-seed.ts:22`), whose DB-rows-win gap-fill
makes implanted filler rows permanent by the same never-in-the-fetch mechanism
as D1.

### 14.2 The root cause of the divergence, restated precisely

Both codebases share polluted *ancestry* (v1's fixture is v0's floor). The
live divergence exists because the two sides behave differently **after** the
seed cutoff (2026-06-29):

- **v0** continues to stamp forward-fill as fact daily; its floor carries
  fabricated rows dated *after* the newest real print, which **shadow** that
  print under forward-fill — so it ranks a value the source never published
  (`215000` vs FRED's `209000`; `119.2868` vs `119.0649`).
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
| **B** — clean current-vintage daily forward-fill | **0.140639** | **0.088584** | **v1 (exactly)** |
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
  which today is 209,000. There is no reading under which `215000` — a number
  FRED never printed — satisfies this.
- `mergeSeries`' contract (*"fetched wins on overlap so source corrections /
  revisions land"*, `lib/utils.js:343`) commits both sides to **current
  vintage**, ruling out PIT as the documented intent. v0 handles the
  point-in-time concern at the *publication* layer instead (frozen
  `regime-history.csv`), which is a deliberate, documented choice.

**Verdict: the correct calculation is B — clean current-vintage daily
forward-fill — and v1's published output implements it exactly.** The
defensible third option, E (native-cadence ranking), would remove the implicit
overweighting of stale values that daily forward-fill introduces for weekly
series; it is statistically reasonable and lands within ~0.005 of B on these
indicators, but it is not what either dashboard documents, and adopting it
would be a methodology change requiring a version relock — not a bug fix.

The correct macro index for 2026-08-14 is therefore **≈ 0.656 ± 0.002** (v1's
0.6572; the clean-floor v0 replay's 0.6536–0.6557 across runs, the spread
being HY_OAS span + live intraday noise per §9). v0's published 0.611 is the
artifact of D1.

### 14.4 New findings from this pass

- **D6** (HIGH, latent, v1): the vendored seed fixture is polluted and the seed
  path makes its pollution permanent. Fix: regenerate the fixture from real
  observations only (`floor-seed-generator.ts` should filter forward-fill
  duplicates or source from FRED/native APIs), and add a fixture test asserting
  no indicator has rows on dates its source calendar cannot produce.
- **D7** (MEDIUM, both): FRED's `fredgraph.csv` serves `BAMLH0A0HYM2` only as a
  trailing ~3y window; verified directly — `cosd=2010-01-01` returns rows from
  2023-08-15 (795 rows). The `fred.js` comment claiming `cosd` fixes this
  truncation is wrong for this series. Consequence: HY_OAS pre-history lives
  only in the persisted floors, its 1095-day percentile window is exactly at
  the edge of what the source can re-serve, and the two sides' different spans
  measurably change panel weights (§9). Worth a loud freshness/coverage
  assertion of its own.

### 14.5 Scorecard of the first draft's claims (see also §15)

| First-draft claim | Second-pass verdict |
|---|---|
| Discrepancy real, ~0.05 on same date | **Upheld** |
| Root cause = v0 persisting forward-fills as observations (D1) | **Upheld**, mechanism sharpened: shadowing of the newest real print is ~100% of the effect; window distortion is second-order and currently opposite-signed |
| ICSA 87% / DXY 7% attribution | **Upheld** |
| "v1 is the correct side" | **Upheld in effect, was under-supported as stated** — now grounded by the 74/74 executed match, and qualified by D6: v1 is clean in output, not clean by construction |
| Weight-cap residual "genuine v1-vs-v0 difference, not a second data bug" | **Refined**: attributed to HY_OAS history-span difference (D7) |
| "v0's HY_OAS floor 1,172 vs 787 fetched — same over-count signature" | **Upheld**, with the added finding that ~77 of those extra days are *unrecoverable real* pre-history, not just filler |

---

## 15. Final verification pass (2026-08-14, third execution)

Run at the review owner's request before the finding is treated as settled:
every calculation redone from freshly downloaded primary data, with an explicit
hunt for innocent explanations of v0's behavior. Nothing material changed; two
presentation errors were corrected and the mechanism was sharpened.

### 15.1 Implementation self-check

Before trusting any number in this document, the review's own percentile
implementation was validated against v0's production output: computed from
v0's own floor for the 2026-08-13 snapshot date, it reproduces v0's published
percentile for **all 8 macro indicators to 9 decimal places** (T10Y2Y 0.657534247,
DFII10 0.973515982, T5YIE 0.169406393, HY_OAS 0.095433790, DXY 0.115981735,
ICSA 0.328767123, VIX 0.258904110, COPPER_GOLD 0.372146119). The math used to
audit v0 is therefore v0's own math.

### 15.2 Innocent explanations, hunted and excluded

| Candidate explanation for v0's values | Outcome |
|---|---|
| The filler rows are real observations later revised away | **Excluded structurally.** FRED ICSA observations exist only on Saturdays (867/867 since 2010); v0's floor has ICSA rows on all 7 weekdays. `DTWEXBGS` publishes business days only; v0's floor has weekend rows. Dates without observations cannot be revised — they never existed. |
| The filler values are fabricated numbers | **No — and this is fairer to v0.** `119.2868` is DTWEXBGS's genuine value for Friday 2026-05-22. `215000` genuinely printed for the weeks ending 2026-04-18 and 2025-12-20. The values are real; only their *dates* are fabricated by the snapshot-read-as-floor loop. |
| The dense CSV is intended behavior | **Half true, and documented in §6.** The write side is explicitly documented as a snapshot ("not a permanent record", `update.js:135-137`); the read side treats it as an observation floor for legitimate resilience reasons. The defect is the composition, not either half. |
| v1's agreement with FRED is luck / v1 has its own offsetting bug | **Excluded by execution.** The clean-vs-hybrid discrimination re-run from fresh FRED downloads and the git-sourced seed fixture (`origin/main`, md5-identical to the working tree) again yields **74/74** clean, 0/74 hybrid. |
| My earlier runs had a transient data vintage | **Excluded.** The floor CSV at `upstream/main` is md5-identical across pulls; the third counterfactual run reproduces every attribution number within live-input noise. |

### 15.3 Numbers, third independent run

| Quantity | This run | First run | Verdict |
|---|---|---|---|
| A — v0 as shipped | 0.611550 | 0.610602 | stable (intraday drift ±0.001, VIX/COPPER_GOLD live) |
| B — clean floor | 0.654571 | 0.653632 | stable |
| B2 — clean + FRED-servable HY_OAS span | **0.657701** | 0.655668 | now within **0.0005** of v1's 0.657209 |
| ICSA swap | +0.039923 | +0.039932 | stable |
| DXY swap | +0.003223 | +0.003224 | stable |
| ICSA share of gap | **87.4%** | ~87% | confirmed |
| DXY share of gap | **7.1%** | ~7% | confirmed |

### 15.4 Corrections applied in this pass

1. §6 ground-truth table: v0's snapshot `raw_date` for ICSA/DXY is
   **2026-08-12**, not 2026-08-13 (the *floor* carries fabricated rows through
   08-13; the snapshot field reflects the last merged row at cron time). The
   substance is unchanged.
2. §6: "215000 appears nowhere in ICSA's recent FRED history" sharpened — it
   *is* a genuine print for the week ending 2026-04-18; no print since late
   April carries it. The value is real; the dates are not.
3. §6: added the Saturday-only structural proof, the value-origin trace, the
   publication-lag explanation of why the chain never self-heals, and the
   composition-defect framing.

### 15.5 Standing conclusion

The finding survives adversarial re-verification. Stated with the precision the
evidence supports: **v0's pipeline output for 2026-08-13/14 attributes to the
current day a value whose provenance is a forward-fill loop, not a source
observation; the divergence from v1 is fully attributed (87% ICSA + 7% DXY
shadowing + ~6% HY_OAS span), and v1's published numbers equal the documented
methodology computed on source-faithful data.** The defect arises from the
interaction of two individually sound, individually documented design
decisions in v0 — a snapshot file also serving as the observation floor — and
its fix (persist sparse real observations; align at read time) is small and
does not change v0's methodology.
