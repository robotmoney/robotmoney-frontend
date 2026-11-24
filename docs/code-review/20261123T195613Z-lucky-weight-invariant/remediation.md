# Remediation: the last-day weight refit, and the other audit findings

- **Date:** 2026-11-23
- **Author:** lucky
- **Problem:** `problem.md`
- **Target behaviour:** `spec.md`
- **Implementation design:** `design.md`

This document lists the steps to fix the defect and ship the fix, in order,
with a check for each step.

## 0. Decisions before work starts

| # | Decision | Owner | Default if not decided |
|---|---|---|---|
| D-a | Change v4 in place, or ship a new version tag? | lucky | **Decided 2026-11-23: change v4 in place.** No new tag. |
| D-b | Approve the method change: weights refit only on the fixed 21-day calendar. | Lex | None. Lex's written yes is needed before merge (method changes need it). |
| D-c | Keep the 21-day interval, or refit daily? | Lex | Keep 21 days. Changing it is a separate method change. |

Record each answer here before step 1.

## 1. Prove the defect on main

- **Do:** add `packages/analyst-sdk/tests/weight-invariance.test.ts` with the
  run-invariance test from `design.md`, marked as a known failure against the
  current version.
- **Check:** the test fails on `main`. It names at least one day *t* where a
  run ending on *t* and a full run disagree on the weights or the composite.

## 2. Declare the refresh rule per version

- **Do:** add `WeightRefresh` and `REGIME_WEIGHT_REFRESH` to
  `analyze/regime-versions.ts`.
  - v3 gets `refitOnLastDay: true`.
  - v4 gets `refitOnLastDay: false` (decision D-a).
  - No new version tag is added.
- **Do:** add `refreshDateOn` and `isRefreshDate` with unit tests: the anchor
  day, the days between refits, the day before the anchor and leap years.
- **Check:** `regime-versions.test.ts` enforces that no version after the
  legacy ones sets `refitOnLastDay: true`.

## 3. Change the compute loop

- **Do:** replace the refresh condition at `analyze/compute.ts:134` with the
  version-driven rule from `design.md`.
- **Do:** add the anchor fit for an axis that starts between refresh dates. It
  throws `WeightAnchorOutOfRangeError` when the input does not reach far
  enough back.
- **Do:** add `weightFitDate` to the result. Add opt-in `weightFits`.
- **Check:** the step 1 test now passes under the corrected v4. Legacy
  replay tests pass unchanged (`regime-fidelity`, `regime-replay-archive`,
  `regime-replay-published`).

## 4. Carry it through production

- **Do:** in `backend/src/analytics/index.ts`, store `weightFitDate` on the
  latest snapshot row next to `panelWeights`. This needs no migration: the
  field goes in the row's JSON payload.
- **Do:** confirm both `computeRegime` calls (`r2` and `r3`, lines 502-503)
  pass the run's methodology version. Both then follow the same rule.
- **Check:** `regime-sdk-equivalence.test.ts` passes. The SDK and the backend
  agree under the corrected v4.

## 5. Regenerate goldens and measure the change

- **Do:** regenerate the current-version fixtures and the backtest and
  correlation references.
- **Do:** write a short diff note in the PR covering four things:
  - how many past days change composite;
  - how many change label;
  - the largest composite change;
  - how each backtest statistic moved.
- **Check:** every changed fixture is explained by the note. No v3 fixture changes.

## 6. Update the docs

- **Do:** update `docs/technical/regime-engine.md` §6 and the "Final-day weight
  refresh" note, as `design.md` describes.
- **Do:** add the fixed-calendar decision to `docs/decisions.md`.
- **Do:** link this code-review folder from the decision.
- **Check:** grep finds no remaining claim that the last day is "always
  recomputed" for the current version.

## 7. Sign-off and merge

- **Do:** post the diff note from step 5 to Lex with the method change in one
  line: "weights refit only on the fixed 21-day calendar; the last day of a
  run is no longer refit."
- **Check:** Lex's written yes is recorded on the issue. Root and backend
  typecheck and unit tests pass. CI is green on the merge commit.

## 8. Release

- **Do:** ship it in the next release through the standard release runbook.
  It is a source change, so it needs a fresh stage pass.
- **Check on stage:**
  - the latest snapshot row carries `weightFitDate`;
  - `weightFitDate` equals the latest refresh date on or before the as-of day;
  - a run for yesterday on stage matches yesterday's row in today's run.

## What does not change

- **Published rows:** frozen rows stay as published (issue 1182, D83). Rows
  published under the old rule keep their old values and their old version
  stamp. Nothing is restated.
- **Production DB:** it gets no write outside the normal run. No migration is
  needed.
- **Source data:** dating source data by its release date is issue 1733.
- **Backtest timing:** execution timing and in-sample reporting are issue 1734.

## Risk

- **Size of the change:** values move for most past days. That is expected,
  because the current history is the inconsistent series. The diff note in
  step 5 makes the size visible before sign-off.
- **Labels near the cut-offs:** a label can change on days where the composite
  sits near 0.33 or 0.67. Smoothing can carry a change forward a few days. The
  diff note lists every changed label day.
- **Rollback:** revert the PR. v3 runs still replay exactly. v4 runs computed
  under the corrected rule stop replaying exactly, because v4 is changed in place.

## Remediation for all findings, by phase

Sections 0 to 8 above fix the main finding (A1, issue 1739). This part places
every other finding from `problem.md`.

### Where each finding is tracked

| ID | Phase | Finding | Tracked in | Action still needed |
|---|---|---|---|---|
| E1 | Extract | Series dated by period | 1733 | none |
| E2 | Extract | Revisions replayed into the past | 1733 | none |
| E3 | Extract | Dividend-adjusted closes | 1733 | none |
| E4 | Extract | Partial-day capture | 1733 | none |
| E5 | Extract | UTC day boundary per extractor | 1733 | none |
| P1 | Prepare | `lastRaw` not cut at as-of | 1733 | none |
| P2 | Prepare | Carried rows not marked | 1741 | none |
| T1 | Transform | Calendar-day windows | 1741 | none |
| A1 | Analyze | Last-day weight refit | 1739 | none |
| A2 | Analyze | Fridays counted three times | 1741 | none |
| A3 | Analyze | 30-observation rank warm-up | 1673 | none (listed in a comment) |
| A4 | Analyze | Cut-offs on a bunched composite | 1673 | none (listed in a comment) |
| A5 | Analyze | Cap does nothing in a small panel | 1673 | none (listed in a comment) |
| A6 | Analyze | Absolute correlation | 1673 | none (listed in a comment) |
| A7 | Analyze | Composite jumps on a missing panel | 1741 | none |
| A8 | Analyze | Smoothing buffer and σ | 1673 | none (listed in a comment) |
| B1 | Backtest | Same-close trade | 1734 | none |
| B2 | Backtest | Closed-market trade | 1734 | none |
| B3 | Backtest | Sharpe | 1734 | none |
| B4 | Backtest | Hindsight reported as out-of-sample | 1734 | none |
| B5 | Backtest | Cash rate basis | 1734 | none |
| B6 | Backtest | ETH cost rate | 1734 | none |
| B7 | Backtest | Max drawdown series | 1734 | none |
| B8 | Backtest | Inherited defects | 1733, 1739 | none |
| R1 | Report | Effective sample size | 1742 | none |
| R2 | Report | Forward statistics as inputs | 1742 | none |
| R3 | Report | Full-sample comparisons | 1734 | none |
| R4 | Report | Historical committee replay | 1742 | none |
| R5 | Report | Swarm brief contents | 1742 | none |

### Issues filed from this review

- **1739, run-invariant weights:** A1.
- **1733, source data known on each day:** E1 to E5 and P1.
- **1741, observation-day windows:** P2, T1, A2 and A7. One methodology
  change, because all four move past values. It needs the quant analyst's
  sign-off. Weekly and monthly series keep counting carried rows as today (decided 2026-11-24).
- **1734, backtest timing and reporting:** B1 to B7 and R3.
- **1742, guards and reporting:** R1, R2, R4 and R5. It changes no computed
  value.
- **1673, parameter choices for the next methodology version:** A3 to A6
  and A8.

### Order of work

Each step builds on correct output from the one before. All of them regenerate
the v4 golden fixtures, so they merge one at a time.

| Order | Issue | Phase | Why here |
|---|---|---|---|
| 1 | 1739 | Analyze | It makes the calculation give one answer per day. Every later check depends on that. |
| 2 | 1733 | Extract, Prepare | It makes the input for each day correct. The whole-pipeline test passes after it. |
| 3 | 1741 | Prepare, Transform, Analyze | The windows count real observations. It needs the calendars that step 2 declares. |
| 4 | 1734 | Backtest | The backtest then trades a correct series, the way a real strategy could. |
| 5 | 1742 | Report | Guards and reporting on top of correct values. |
| 6 | 1673 | Analyze | The method values are chosen last, from backtests that no longer look ahead. |

Step 6 is last on purpose. Any parameter chosen before steps 1 to 4 is chosen
from evidence that carries the defects above.

### Check for the whole set

- **Each step:** the step's own acceptance checks pass, and the golden
  fixtures are regenerated with a note of what moved.
- **After step 2:** the whole-pipeline test in `design.md` passes.
- **After step 4:** the published backtest statistics are restated once, with
  a changelog line naming each cause.
- **Published rows:** frozen rows are never restated by any step.
