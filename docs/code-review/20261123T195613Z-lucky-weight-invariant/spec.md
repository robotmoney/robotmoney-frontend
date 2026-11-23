# Regime algorithm: expected behaviour

- **Date:** 2026-11-23
- **Author:** lucky
- **Methodology version:** v4 (`packages/analyst-sdk/src/analyze/regime-versions.ts`)
- **Audited at:** `main` d3f89e8b0
- **Companion:** `problem.md` (how the weights went wrong in v0 and in the refactor)

This document states how the regime algorithm is meant to work. Code paths are
cited so each step can be checked against it. Where the code differs from this
spec, the difference is a defect, and it is described in `problem.md` or in
the linked issues.

## The governing rule

Every value the algorithm produces for day *t* is a function of exactly two
things:

1. the methodology version, and
2. the source data **known** on or before *t*.

Nothing else may change it. That rules out the date the job ran, how many days
follow *t* on the axis, later data revisions, and whether the value was ever
published. Every run whose date axis contains *t* must produce the same row
*t*.

This is the **run-invariance rule**. Every step below has to obey it.
Publishing is separate: it stores a value that was already computed. It plays
no part in defining what the value should be.

## Executive summary of the steps

### a) Data collection

- **What:** fetch each registry indicator's raw series from its source (FRED,
  Yahoo, DefiLlama, Coin Metrics, blockchain.com, GeckoTerminal, multpl/Shiller)
  (`packages/analyst-sdk/src/extract/*`, `backend/src/analytics/access/data-source.ts`).
- **Stored as:** every fetched value is kept in the source ledger with the time
  it was fetched (`source_value_versions`). Each run freezes the set of values
  it read as a run vintage (`backend/src/analytics/index.ts:451-497`).
- **Correct behaviour:** each observation carries the date it became public,
  not the period it describes.
  - A weekly, monthly or quarterly series becomes visible on its release date.
  - A revised value becomes visible on the date of the revision.
  - A run for day *t* reads only values public on or before *t*, at the value
    they had then.
  - Issue 1733 tracks the gap between this and today's code.

### b) Alignment and fill

- **What:** build a daily calendar axis from `BACKFILL_START` (2018-01-01) to
  the as-of day. Each series is placed on it (`prepare.ts:45`).
- **Fill policy:** every indicator declares one (`analyze/indicators.ts`).
  - *forward:* carry the last real value for at most `maxAgeDays`.
  - *zero:* a gap counts as 0.
  - *none:* a gap is missing.
- **Missing values:** a day older than the policy allows is NaN, so the
  indicator is missing that day.
- **Correct behaviour:** fill only carries values forward, never backward. A day
  before an indicator's first public observation is NaN.

### c) Transforms

- **What:** each indicator applies its declared transform to the aligned series
  (`transform/transforms.ts`): `level`, `change30`, `change90`, `sma4`, `sma7`,
  `trend_50_200` (SMA50 / SMA200), `rolling_sum_7`. Ratio indicators divide two
  price legs first (`transform/ratios.ts`).
- **Correct behaviour:** every transform is trailing. Row *t* reads only rows up
  to and including *t*.

### d) Indicator rank

- **What:** rank each transformed indicator against its own trailing window
  (`transform/math.ts:221`). The window is 1,095 days (`ROLLING_WINDOW_DAYS`).
- **Formula:** rank = (count below + ½ · count equal) / count in window. This
  gives a value from 0 to 1.
- **Warm-up:** the rank is NaN until the window holds 30 finite values.
- **Correct behaviour:** the window ends on *t* and holds only rows up to *t*.

### e) Sign alignment

- **What:** flip each rank so that 1 always means risk-on. For indicators where
  a high value means risk-off: signed = 1 − rank (`compute.ts:120`).

### f) Panel weights

- **What:** within each panel, give each indicator a weight inversely related to
  how much it repeats the others (`transform/math.ts:276`).
- **Details:** see [The weights](#the-weights) below. This is the step the
  companion `problem.md` concerns.

### g) Panel index

- **What:** each panel's index on day *t* is the weighted mean of its
  indicators' signed ranks on *t*, using the weights in force on *t*
  (`compute.ts:311`).
- **Missing indicators:** an indicator missing on *t* is left out, and the
  remaining weights are renormalised.

### h) Composite

- **What:** the composite on day *t* is the plain mean of the included panels'
  indices on *t* (`compute.ts:150`).
- **Panels included:** `PANELS` lists them (`analyze/indicators.ts:662`). Today
  that is macro and on-chain.
- **The factor panel:** it is computed in a separate run of every panel (`r3`).
  It is reported, but it is not in the composite.

### i) Label

- **What:** cut the composite into a label (`compute.ts:224`, `bucketFn`).
  - **v4** cuts on the composite itself: below 0.33 is risk-off, above 0.67 is
    risk-on, and anything in between is neutral.
  - **v3** cut on the composite's trailing percentile instead.
  - Each panel label is cut the same way from its panel index.
- **Percentiles:** the trailing percentiles of the composite and of each panel
  are still computed, as information only.

### j) Smoothing

- **What:** a new label replaces the previous one only in either of two cases
  (`compute.ts:236`):
  - **Confirmation:** the new bucket has held for 5 days in a row.
  - **Fast track:** the day-over-day change in the series exceeds 2σ, where σ is
    measured on the trailing 252 daily changes and needs at least 30 of them.
    The move must also point the same way as the new label.
- **Correct behaviour:** both checks look only backward from *t*.

### k) Output and consumers

| Output | Code | What it carries |
|---|---|---|
| Run artifact | `backend/src/analytics/index.ts:533` | One snapshot row per axis day. |
| Swarm brief and judge | — | Read the as-of day's composite and label. |
| Allocation | `allocate/labels.ts:89` | Takes the label as of the day before each decision. |
| Backtest | `analyze/backtest.ts` | Trades the label series. A label known at day *t*'s close can only be traded at the next session, and only in an open market (issue 1734). |

Display, frozen publication (issue 1182) and the backtest are all consumers.
None of them defines the values.

## The weights

### What they are for

A panel holds several indicators. Some of them carry much the same information:
two credit spreads, or two stablecoin measures. With equal weights, a cluster
of near-duplicates would outvote an indicator that carries something
different. The weights correct for that redundancy. Each indicator's say in
the panel index shrinks as its correlation with the rest of the panel grows.

The weights do not try to predict returns. They only measure redundancy among
the panel's own inputs.

### How one set of weights is computed

For one panel, on a **fit date** *f*:

1. **Window:** take each indicator's signed rank series over the weight window
   ending on *f*. Today that is 1,095 days, from *f* − 1,094 to *f*. Only data
   up to *f* is used.
2. **Eligibility:** an indicator with fewer than 60 finite values in the window
   is ineligible and gets weight 0.
   - With no eligible indicators, every weight is 0.
   - With exactly one, that indicator gets weight 1.
3. **Correlation:** for each pair of eligible indicators, take the Pearson
   correlation of their signed ranks over the days both are finite.
4. **Redundancy:** for each indicator, take the mean of the absolute
   correlations with the other eligible indicators.
5. **Raw weight:** 1 / max(0.05, redundancy). The 0.05 floor stops a
   near-uncorrelated indicator taking almost all the weight.
6. **Normalise:** divide by the sum, so the weights sum to 1.
7. **Cap:** cap each weight at 0.25. Spread the excess across the uncapped
   weights in proportion to their size, and repeat until no weight exceeds
   the cap, up to 20 passes. If every weight is above the cap, the cap cannot
   be met, so the weights are left as they are. That happens with 4 or fewer
   eligible indicators.

The result is one weight per indicator for that panel, written **W(f)**.

### When weights are recomputed

Fitting is the costly step: a full pairwise correlation matrix per panel. So
weights are refit on a **fixed refresh calendar**, not every day.

- **Refresh dates:** the refresh dates are every 21st day of the date axis,
  counted from the fixed axis start (`BACKFILL_START`, 2018-01-01). That gives
  days 0, 21, 42, and so on (`WEIGHT_REFRESH_DAYS = 21`, `compute.ts:123`).
- **The calendar is fixed:** it depends only on the axis start. It never depends
  on the run's start or end date, and there are no extra refits.

### Which weights apply on a given day

The weights in force on day *t* are:

> **W(t) = W(r(t))**, where r(t) is the latest refresh date on or before *t*.

So:

- **On a refresh date:** the weights fitted that day apply.
- **Between refresh dates:** day *t* reuses the weights from the last refresh
  date, which is at most 20 days earlier.
- **The newest day of a run:** it is treated like any other day. If it is not a
  refresh date, it uses the last refresh date's weights.

Under this rule W(t) depends only on *t* and the data up to r(t). Every run
containing *t* gets the same weights for *t*, which satisfies the
run-invariance rule.

### Why this definition

- **Point-in-time:** a refit on *f* sees only data up to *f*, and it is applied
  only on days on or after *f*. No future data enters any weight.
- **Run-invariant:** the refresh dates are fixed in advance and the same for
  every run. So a day's weights cannot depend on when or how often it is
  recomputed.
- **Bounded staleness:** any weight is at most 20 days old. Redundancy among
  slow-moving daily ranks changes over months, so this costs little accuracy.
- **Cheap:** about one refit per 21 days of history, per panel.

### Requirements

| # | Requirement |
|---|---|
| W1 | A refit happens only on a refresh date of the fixed calendar. No run-dependent refit exists, including on the last day of the run. |
| W2 | A refit on fit date *f* reads only signed ranks dated on or before *f*. |
| W3 | Day *t* uses W(r(t)): the latest refresh date on or before *t*. |
| W4 | The refresh calendar is anchored to the fixed axis start and does not move with the run's start or end date. |
| W5 | The weights reported for a run's last day are W(r(last day)), the weights actually applied that day. |
| W6 | Changing the window length, the refresh interval, the floor or the cap is a methodology change and needs a new regime version. |

### How to verify

- **Run invariance:** for sampled days *t* across the history, a run ending on
  *t* and a full run ending later produce identical row *t*, on identical
  inputs. That covers the weights in force, the panel indices, the composite,
  the percentiles and the labels.
- **Calendar:** for every axis day, the fit date of the weights in force equals
  r(t).
- **No forward reads:** a refit on *f* is unchanged when every row after *f* is
  removed from its input.

## Out of scope here

- Dating source data by its release date: issue 1733.
- Backtest execution timing, and keeping in-sample results apart from
  out-of-sample ones: issue 1734.
- Where v0 and the refactor depart from the weight rules above: `problem.md`.
