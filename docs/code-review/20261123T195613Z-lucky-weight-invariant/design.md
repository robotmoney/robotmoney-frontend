# Design: run-invariant panel weights, and the other audit findings

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

## Design for the other findings, by phase

The sections above cover the main finding (A1). This part gives the design
direction for every other finding in `problem.md`, by pipeline phase. The IDs
match `problem.md` and the rules in `spec.md`.

### One shared mechanism: knowledge time

Findings E1, E2, E4 and P1 share one cause: a value is selected by the day it
describes, not by the day it was known. One mechanism fixes all four.

- **Each stored value has two dates:** the observation date (the day or
  period it describes) and the known date (when it became public, or when the
  revision was fetched).
- **Each read takes an as-of day:** it returns, for every observation date,
  the latest value whose known date is on or before the as-of day.
- **The ledger already holds this.** `source_value_versions` records each
  value with its fetch time. The read path needs the cut. It needs no
  migration.

### Extract

| ID | Design |
|---|---|
| E1 | Add a `publication` rule to each registry indicator and research input, next to `fill`. Kinds: `same-day`, `lag` (a number of days), and `release-calendar` (weekly on a weekday, month end, quarter plus weeks). The loader refuses an indicator without one, as it does for `fill`. For FRED series, first-release dates come from ALFRED (`extract/fred.ts`, `firstReleaseValues`). |
| E2 | `loadCommittedInputs` and `asofLabels` take a knowledge-time cut-off. The backtest and the history replay build their input through it. |
| E3 | Set `ratioClose: "raw"` on the equity ratios, and compute `SPX_TREND` from the raw close. The legs are already stored separately (issue 1644). |
| E4 | An acquisition made before the UTC day ends is stored with a `provisional` flag. The first fetch after the day ends is a revision with that known date. |
| E5 | Add a day-boundary note to each extractor's header, and a test per source with a fixture around midnight UTC. |

### Prepare

| ID | Design |
|---|---|
| P1 | `prepareRegimeInputs` cuts `lastRaw` at the as-of day. The "Not cut at asof" exception is removed. |
| P2 | Add `calendar: "daily" \| "exchange" \| "periodic"` to each indicator. `periodic` covers weekly and monthly releases (`ICSA`, `SHILLER_CAPE`), whose carried rows keep counting as they do today: skipping them would leave `SHILLER_CAPE` under the 60-observation floor and `ICSA` with no shared days. Decision (2026-11-24): periodic series keep counting carried rows in the transform, the rank and the weight fit, as today. A different cadence rule for them is a method choice for 1673. `prepareRegimeInputs` returns a `carried` mask per indicator (it already computes the fill age: carried means age > 0). |

### Transform

| ID | Design |
|---|---|
| T1 | `applyTransform` runs on the series's own observations for an `exchange` series, then aligns the result to the axis. A `daily` series is unchanged. Rename nothing: `trend_50_200` then means what it says. This is a methodology change and ships with A2. |

### Analyze

| ID | Design |
|---|---|
| A2 | `rollingPercentileRank` and the weight fit take the `carried` mask and skip carried rows when counting. Window lengths stay in calendar days, so 1,095 days still means three years. |
| A3 to A6, A8 | Each becomes a declared parameter of the methodology version, next to `REGIME_LOOKBACK`, with today's value as the default. The tooling ships first, and the values are chosen in issue 1673. |
| A7 | `computeRegime` returns no composite for a day with a missing included panel. The complete-day rule (issue 1655) works per indicator and ships with the `score-newest` day rule, so it does not refuse such a day today. This is a separate, per-panel rule. It amends decision D89 item 2, which averages the panels finite that day. |

T1, A2 and A7 change past values. They ship as one methodology change, so
history moves once.

### Backtest

| ID | Design |
|---|---|
| B1 | `scheduleFromLabels` takes a `lagSessions` option, default 1. The reference backtest uses it. |
| B2 | `simulate` takes a per-asset `calendar`. A target change on a closed day is held and applied at that asset's next open day. |
| B3 | `periodStats` receives post-cost returns and the cash rate series, and computes Sharpe on the difference. |
| B4 | `regime-versions.ts` declares `adoptedOn` per version. `periodStats` splits at it, replacing `BACKTEST_IN_SAMPLE_END`. |
| B5 | Convert `DTB3` from discount basis to a bond-equivalent yield in one helper, used by both simulators. |
| B6 | `SimulateOptions.costBps` accepts a per-asset map. |
| B7 | `periodStats` requires daily values and throws on a sparser series. |
| B8 | No design of its own. It is met when E1 to E3 and A1 are done. |

### Report and consume

| ID | Design |
|---|---|
| R1 | `CorrelationCell` gains `n_eff` (n divided by the horizon, rounded down) on forward cells, in the payload and the contract type. No page shows these today. |
| R2 | Add a purity test: no module under `allocate/` or `backend/src/swarm/` imports `analyze/correlations.ts` directly, and no `allocate/` file reads `RunResult.correlations`. A transitive rule would fail today, because `allocate/labels.ts` imports `run.ts`, which computes correlations. |
| R3 | Both comparison generators call `periodStats` with the adoption-date split (B4). |
| R4 | Declare a cutoff date per model (none exists today) and add a guard: a session dated before the configured model's cutoff is refused with a named error. Sessions take no as-of date today, so the guard sits on the session date in the epoch insert path and in brief publication. |
| R5 | Review task, not a design: list each brief field and its source, then apply the rules above. |

### Test that covers every phase

The run-invariance test in the Tests section above checks A1 on identical
inputs. A second test checks the whole pipeline:

> For sampled days *t*, a run as of *t* on data known on *t* equals row *t* of
> a later full run that reads through the knowledge-time cut.

It fails today because of E1, E2, E4 and A1. It passes when those are fixed.
