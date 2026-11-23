# Design: run-invariant panel weights

- **Date:** 2026-11-23
- **Author:** lucky
- **Implements:** `spec.md`, requirements W1 to W6
- **Fixes:** `problem.md`
- **Rollout:** `remediation.md`

This document says how the code should change so that the weights follow the
spec. It covers where the rule lives, what the interfaces look like, how
versions keep old runs replayable, and how tests prove the rule holds.

## Goals

1. Weights for day *t* are W(r(t)): the fit from the latest refresh date on or
   before *t*, on the fixed calendar. There is no refit tied to the run.
2. Any run containing day *t* produces the same row *t*.
3. Every run stamped with an older methodology version still replays exactly.
4. The rule is a declared methodology parameter, not a constant buried in a
   loop.

## Non-goals

- Changing the fit itself: the window, eligibility, correlation, floor or cap.
- Dating source data by its release date (issue 1733).
- Backtest execution timing and in-sample reporting (issue 1734).
- Restating published rows.

## Where the rule lives

The refresh rule becomes part of the methodology declaration, next to the
lookback windows (`packages/analyst-sdk/src/analyze/regime-versions.ts`).

```ts
export interface WeightRefresh {
  /** Days between refits on the axis calendar. */
  intervalDays: number;
  /** Calendar anchor: day 0 of the refresh calendar. */
  anchor: string;            // "2018-01-01" (BACKFILL_START)
  /** Legacy only: also refit on the run's last axis day. */
  refitOnLastDay: boolean;
}

export const REGIME_WEIGHT_REFRESH: Readonly<Record<RegimeVersion, WeightRefresh>> = {
  v3: { intervalDays: 21, anchor: BACKFILL_START, refitOnLastDay: true },
  // corrected in place (see "Versioning" below)
  v4: { intervalDays: 21, anchor: BACKFILL_START, refitOnLastDay: false },
};
```

- **`refitOnLastDay`:** it exists only so that versions shipped with the
  defect replay byte for byte. Only v3 sets it to `true`; v4 and later may not. A unit
  test enforces that.
- **`anchor`:** it is a calendar date, not an axis index. A run whose axis
  starts later than the anchor still refits on the same calendar dates. Today
  every axis starts at `BACKFILL_START`, so the index rule and the date rule
  agree. Naming the anchor keeps it that way when a caller passes a different
  start.

## Refresh-date function

One pure function decides which fit date applies on a day. Both the
compute loop and the tests use it.

```ts
/** The latest refresh date on or before `day` (spec: r(t)); null before the anchor. */
export function refreshDateOn(day: string, refresh: WeightRefresh): string | null;

/** True when `day` is a refresh date of the calendar. */
export function isRefreshDate(day: string, refresh: WeightRefresh): boolean;
```

Both work on whole UTC days (day number minus anchor day number, modulo
`intervalDays`). They do not depend on the axis, so the rule is the same for
every caller.

## Compute loop

`computeRegime` (`analyze/compute.ts:133-147`) changes as follows:

```ts
const refresh = REGIME_WEIGHT_REFRESH[version];
const last = dateAxis.length - 1;
for (let i = 0; i < dateAxis.length; i++) {
  const due =
    isRefreshDate(dateAxis[i], refresh) ||
    (refresh.refitOnLastDay && i === last) ||
    (i === 0 && !isRefreshDate(dateAxis[0], refresh)); // see "Axis that starts between refresh dates"
  if (due) refit(i);
  ...
}
```

### Axis that starts between refresh dates

If a caller's axis starts after the anchor and between two refresh dates, day
0 has no earlier fit inside the run. The spec rule says day 0 should use the
fit from r(day 0), which lies before the axis.

The design handles this by **fitting at r(day 0)**: it computes signed ranks
from the input that the caller already holds, back to r(day 0) minus the
weight window. When the input does not reach that far, the run is refused with
a named error (`WeightAnchorOutOfRangeError`). Fitting on day 0 instead would
break run invariance.

In production and in `runRegime`, every axis starts at `BACKFILL_START`, which
is a refresh date. So this path only matters for research callers that pass
their own start.

## Reporting the weights

`RegimeComputeResult` gains the facts needed to check W3 and W5:

```ts
weightsByPanel: Record<Panel, Record<string, number>>; // weights in force on the last day (unchanged name)
weightFitDate: string | null;                          // r(last day): the fit date those weights came from
weightFits?: { date: string; weights: Record<Panel, Record<string, number>> }[]; // opt-in: every fit in the run
```

- **`weightFitDate`:** it goes into the latest snapshot row next to
  `panelWeights` (`backend/src/analytics/index.ts:911`). Readers can then see
  how old today's weights are.
- **`weightFits`:** it is opt-in (`opts.recordWeightFits`), for tests and
  research. Every fit in the run is listed, so a test can check the
  calendar.

The seven callers of `weightsByPanel` keep working unchanged. Under the new
version they get the weights actually applied on the last day (W5), not a
last-day refit.

## Versioning

The change alters values for most past days, so it is a methodology change
(spec W6).

**Decision (2026-11-23): v4 is changed in place.** v4 sets
`refitOnLastDay: false`. No new tag is added, and v4 stays
`CURRENT_REGIME_VERSION`. v3 keeps `refitOnLastDay: true`, so v3 runs replay
exactly.

As a result, a run stamped v4 under the old rule will not replay byte for byte
under the corrected v4. That is accepted. Any v4 golden fixture or replay
reference is regenerated under the corrected rule.

## Tests

| Test | File | What it proves |
|---|---|---|
| Run invariance | new `packages/analyst-sdk/tests/weight-invariance.test.ts` | For sampled days *t*, `computeRegime` as of *t* equals row *t* of a full run on identical input. It checks ranks, weights in force, panel indices, composite, percentiles and labels. |
| Calendar | same file | With `recordWeightFits`, every fit date is a refresh date, and the weights in force on each day come from `refreshDateOn(day)`. |
| No forward reads | same file | A fit on date *f* is unchanged when every row after *f* is removed from the input. |
| Last-day report | same file | `weightFitDate` equals `refreshDateOn(last day)`. `weightsByPanel` equals the fit from that date. |
| Policy guard | `regime-versions.test.ts` | Only v3 may set `refitOnLastDay: true`. v4 and every later version must be `false`. |
| Legacy replay | `backend/tests/regime-fidelity.test.ts`, `regime-replay-archive.test.ts`, `regime-replay-published.test.ts` | Runs stamped with older versions still replay byte for byte. No change is expected, which makes this the guard against breaking them. |
| SDK and backend agree | `backend/tests/regime-sdk-equivalence.test.ts` | Both paths produce the same values under the corrected v4. |
| Goldens | `backtest-correlations-fidelity.test.ts` and current-version fixtures | Regenerated under the new rule, with a written diff note. |

The run-invariance test is the acceptance test for the whole change. It fails
on current `main`, which shows the defect, and passes after the change.

## Performance

- **Fewer refits:** dropping the last-day refit removes one fit per panel per
  run.
- **Anchor fit:** the day-0 anchor fit adds one fit, and only for a run that
  starts between refresh dates.
- **Opt-in recording:** `recordWeightFits` keeps one weight map per fit,
  about 140 fits per panel over 2018–2026. It is off by default.

## Documentation

- **Regime engine doc:** update `docs/technical/regime-engine.md` in two places:
  - §6 ("Why 21-day weight refresh, not daily?"): remove the final-day
    sentence and state the run-invariance rule.
  - The "Final-day weight refresh" note near line 468: describe the fixed
    calendar, and keep the old behaviour as a note against v3 (and v4 if
    applicable).
- **Decisions:** add a decision to `docs/decisions.md`. Weights follow a
  fixed refresh calendar, and no step may depend on the run's end date.
