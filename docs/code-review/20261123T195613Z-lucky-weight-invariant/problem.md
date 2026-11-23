# Regime weights must not depend on the run date

- **Date:** 2026-11-23
- **Author:** lucky
- **Audited at:** `main` d3f89e8b0
- **Scope:** regime compute (`packages/analyst-sdk/src/analyze/compute.ts`)
- **Related:** source-data look-ahead (1733); backtest execution timing and methodology hindsight (1734)

## Summary

The regime engine refits each panel's indicator weights every 21 days and
also on the last day of every run. Because of that last-day refit, the same
day gets different weights depending on whether it was the newest day of the
run that computed it. So one day can have two values, from the same data and
the same method.

This is not look-ahead. Both values use only data known by that day. The
fault is that the method is not well defined: the result for a day depends
on when the job ran, not only on the day and its data.

The fix is to drop the last-day refit, so weights refresh on a fixed calendar
only.

## The invariant

> The value of any regime series for day *t* is a function of the
> methodology and the source data known on or before *t*. It does not depend
> on the run's end date, on how many days follow *t*, or on whether *t* was
> ever published.

Equivalently: every run whose date axis contains day *t* produces the same
row *t*. That includes a run ending on *t*, a full-history run ending today,
and a replay a year later.

Two separate ideas need to stay separate:

- **The correct value for day *t*** comes from the definition above.
- **Publishing** means storing or showing a value on some date. It records
  what was computed. It is not part of the definition, and later runs are not
  checked against it. They are checked against the definition.

## The defect

`packages/analyst-sdk/src/analyze/compute.ts:134`:

```ts
if (i % WEIGHT_REFRESH_DAYS === 0 || i === dateAxis.length - 1) {
  // refit inverseCorrelationWeights on the weight window ending at i
}
```

Weights are refit on every 21st axis day (anchored to the axis start) **and
on the last axis day**. Every other day reuses the most recent weights.

### Example

The 21-day refits fall on 3 Nov and 24 Nov.

| Run | Weights applied to 10 Nov |
|---|---|
| Run ending 10 Nov (10 Nov is the last day) | refit on 10 Nov, data up to 10 Nov |
| Run ending 23 Nov (10 Nov is mid-history) | refit on 3 Nov, data up to 3 Nov |

Identical inputs for 10 Nov produce different weights. So they produce a
different panel index and composite for 10 Nov, and possibly a different
label. The 5-day confirmation can carry a label difference forward several
days.

`docs/technical/regime-engine.md:468` already says so: "the as-of day is
revised by construction when D moves forward one day."

## Why it exists

The rule was ported unchanged from v0 (`scripts/regime/compute.js` in
`agentjuno/robotmoney`; parity audit
`docs/audits/v0-v1-parity/A1-regime-core-procedures.md:56`). The stated
reason (`docs/technical/regime-engine.md:292-300`) has two parts:

1. Refitting the correlation matrix is expensive, so it refreshes every 21
   days rather than daily.
2. The last day is refit so that the "published as-of weights" are "never
   stale relative to the day being published."

Point 2 mixes up publishing a weight with defining the correct weight for a
day. v0 hid the mix-up. Its history was frozen and append-only (commit
`32ca0a08`). Each day was computed once, as the last day of its run, and was
never recomputed. So "the weights used when the day was published" and "the
weights for that day" could never differ.

Production recomputes every past day on every run (history replays, the
backtest, correlations). A day gets last-day weights only on the single run
where it is newest. Every later run gives it the 21-day weights. The rule
meant to keep the newest row fresh now makes every row depend on when it was
computed.

Point 1 justifies the 21-day refresh calendar. It does not justify treating
the last day as special.

## Consequences

- **Every full-run series is a hybrid.** The history chart, the backtest
  (`backend/src/analytics/index.ts:513`) and the correlations read a series
  in which past days never carry their own run-ending weights. The algorithm
  never produces that series on any single day.
- **Today is built by a different rule from its history.** Today always gets
  last-day weights, and its past gets 21-day weights. That distorts anything
  comparing today with its own past: the trailing rank of the composite, and
  the day-over-day change used by the 2σ fast-track.
- **Reruns change labels with no data change.** Rerunning a day after more
  days exist can change its value, even when no source data was revised. It
  looks like a data error and it isn't one.
- **Replays can't be verified.** "A run replays exactly" holds only when the
  replayed day is the last day of the run.

## Fix

Drop the last-day clause so weights refresh on a fixed calendar only:

```ts
if (i % WEIGHT_REFRESH_DAYS === 0) {
```

The weights for day *t* are then the refit on the most recent scheduled
refresh date at or before *t*, using data up to that date. That is a pure
function of *t*. The refresh calendar stays anchored to the fixed axis start
(`BACKFILL_START`), so it does not move with the run.

Alternatives considered:

| Option | Run invariant | Cost | Note |
|---|---|---|---|
| **Fixed 21-day calendar only (recommended)** | yes | none | Today's weights can be up to 20 days old, which the method already accepts for every other day. |
| Refit every day | yes | about 21× the weight fitting | Removes staleness entirely. Weigh it against the cost. |
| Keep the rule and build series one run per day | yes, for the series built that way | one full run per day | Full runs still disagree, so the defect stays in every other consumer. |
| Backtest from published rows | no | — | Rejected. Published state is a record, not the definition of the correct value. |

The same invariant should hold for every other step. The audit found the
rolling ranks, transforms, composite and smoothing already satisfy it. The
weight refit is the only step that breaks it.

## Acceptance

- **Run-invariance test:** for sampled days *t* across the history, a run
  ending on *t* produces the same row *t* as a full run ending later, on
  identical inputs. This covers ranks, weights, panel indices, composite,
  composite percentile and labels.
- **Cadence test:** `weightsByPanel` reported for the last day equals the
  weights in force on that day under the fixed calendar.
- **Goldens:** regenerate the golden fixtures and replay references in the
  same change, with a note of how many past labels move.
- **Version:** ship it as a new regime methodology version, so a run stamped
  under the current version still replays exactly (`regime-versions.ts`).
  Lex signs it off as a method change.
- **Docs:** update `docs/technical/regime-engine.md` §6 ("Why 21-day weight
  refresh, not daily?") and the "Final-day weight refresh" note at line 468,
  stating the invariant above.
