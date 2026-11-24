# Problems found: look-ahead, run variance, windowing and skew in the regime pipeline

- **Date:** 2026-11-23
- **Author:** lucky
- **Audited at:** `main` d3f89e8b0
- **Target behaviour:** `spec.md`
- **Design:** `design.md`
- **Fix order and tracking:** `remediation.md`

This document lists every defect the audit found, grouped by the phase of the
data pipeline where it occurs. The main finding is the last-day weight refit
(A1). It is described in full at the end.

Code paths are under `packages/analyst-sdk/src/` unless they start with
`backend/`.

## Kinds of defect

| Kind | Meaning |
|---|---|
| **Look-ahead** | A value for day *t* uses information that was not available on day *t*. |
| **Run variance** | The value for day *t* depends on when the run happened, not only on day *t* and its data. |
| **Windowing** | A window does not cover the span its name says, or counts some days more than others. |
| **Skew** | A step distorts a value in one direction by construction. |
| **Bias** | A reported statistic is flattering or overstated, though each input is correct. |
| **Unverified** | Not audited. It is listed so that it does not get lost. |

## Summary by phase

| ID | Phase | Defect | Kind | Tracked in |
|---|---|---|---|---|
| E1 | Extract | Slow-release series dated by the period they describe | Look-ahead | 1733 |
| E2 | Extract | Later revisions replayed into the past | Look-ahead | 1733 |
| E3 | Extract | Dividend-adjusted closes embed later dividends | Look-ahead | 1733 |
| E4 | Extract | Partial-day capture of 24/7 series | Skew | 1733 |
| E5 | Extract | UTC day boundary of each extractor | Unverified | 1733 |
| P1 | Prepare | `lastRaw` is not cut at the as-of day | Look-ahead (display) | 1733 |
| P2 | Prepare | Calendar axis repeats the last close on closed days | Windowing (root cause of T1, A2) | 1741 |
| T1 | Transform | "Day" windows count calendar days on forward-filled series | Windowing | 1741 |
| A1 | Analyze | **Last-day weight refit** | Run variance | 1739 |
| A2 | Analyze | Rank and weight windows count each Friday three times | Windowing | 1741 |
| A3 | Analyze | Rank starts after only 30 observations | Skew | 1673 |
| A4 | Analyze | v4 cuts a composite bunched near 0.5 at uniform-scale cut-offs | Skew | 1673 |
| A5 | Analyze | The 25% weight cap does nothing in a small panel | Skew | 1673 |
| A6 | Analyze | Absolute correlation treats a diversifier as redundant; noisy fit | Skew | 1673 |
| A7 | Analyze | Composite jumps when a panel is missing; panels equal-weighted | Skew | 1741 |
| A8 | Analyze | Smoothing: easy fast-track, no buffer zone at the cut-offs | Skew | 1673 |
| B1 | Backtest | Trade at the same close as the signal | Look-ahead | 1734 |
| B2 | Backtest | Weekend and holiday trades at a stale price | Look-ahead | 1734 |
| B3 | Backtest | Sharpe ignores the T-bill rate and trading costs | Bias | 1734 |
| B4 | Backtest | Method chosen with hindsight, reported as out-of-sample | Bias | 1734 |
| B5 | Backtest | Cash rate quoted on a discount basis, compounded as a yield | Skew | 1734 |
| B6 | Backtest | 10 bps cost is light for ETH | Bias | 1734 |
| B7 | Backtest | Max drawdown may be measured on month-end values | Unverified | 1734 |
| B8 | Backtest | Backtest input inherits E1-E3 and A1 | Inherited | 1733, 1739 |
| R1 | Report | Forward correlations overstate their sample size | Bias | 1742 |
| R2 | Report | Forward correlations look forward by design | Guard needed | 1742 |
| R3 | Report | Research comparisons score on the full sample | Bias | 1734 |
| R4 | Report | A historical committee replay would leak model training data | Guard needed | 1742 |
| R5 | Report | Swarm brief contents | Unverified | 1742 |

## Extract

### E1. Slow-release series dated by the period they describe (look-ahead)

Each value is stamped with the period it covers. Forward-fill then makes it
visible from that date, before it was published.

| Series | Used in | Dated | Published | Early by |
|---|---|---|---|---|
| `BOGZ1FL663067003Q` margin debt | late-cycle gauge (`analyze/research-signals.ts:306`) | first day of the quarter | about 10 weeks after quarter end | about 5 months |
| `UMCSENT` | late-cycle gauge (`research-signals.ts:312`) | 1st of the month | mid-month, final at month end | 2 to 4 weeks |
| `SHILLER_CAPE` | factor panel (`extract/shiller.ts:79`) | 1st of the month | uses the whole month's average price | about 1 month |
| `ICSA` | macro panel (`analyze/indicators.ts:211`) | the Saturday the week ends | the next Thursday | 5 days |
| `DTWEXBGS` (DXY) | macro panel (`indicators.ts:192`) | each day | weekly, on Monday | up to about 10 days |
| `DFII10`, `T10Y2Y`, `T5YIE`, `HY_OAS` | macro panel | each day | the next business day | 1 day |

- **Live runs:** mostly safe, because an unpublished row is not in the
  database yet.
- **Replays:** every replay, trailing window, backtest and as-of label is
  affected.
- **Correct pattern:** EDGAR M&A counts are stamped on month end
  (`extract/edgar.ts:10`).

### E2. Later revisions replayed into the past (look-ahead)

A full run recomputes every past day from today's data. Rows are cut by
observation date, not by when the value was known
(`backend/src/analytics/index.ts:513`, `allocate/labels.ts:148`).

Revised sources:
- jobless claims;
- DefiLlama TVL, which adds protocols back in time;
- Coin Metrics active addresses;
- GeckoTerminal new pools.

The source ledger already records when each value was fetched. The reads do
not use it for past days.

### E3. Dividend-adjusted closes embed later dividends (look-ahead)

Yahoo back-adjusts each past close by dividends paid after it. A ratio of two
ETFs with different yields drifts as a result (`indicators.ts:290-578`).

- **Affected:** `IWM_SPY`, `SPHB_SPLV`, `MTUM_SPY`, `IWF_IWD`, `XLU_SPY`,
  `XLP_XLY`, and `SPX_TREND` slightly.
- **Size:** `XLU_SPY` drifts about 1.5% a year, or about 5% across a 3-year
  rank window.
- **Status:** live. The factor panel is included in the composite
  (`PANEL_MEMBERSHIP`, decision D89), so these ratios feed the label.

### E4. Partial-day capture of 24/7 series (skew)

A series that trades every hour has no close until the UTC day ends. A fetch
during the day stores a partial-day value. A later fetch stores the full-day
value. The parity audit saw this on `BTC_ACTIVE` and BTC price
(`docs/audits/v0-v1-parity/R8-residual-attribution.md:44`).

- **Effect:** the live value for today differs from the value any later run
  sees for the same day.
- **Tracking:** 1733 treats a same-day refetch as a revision.

### E5. UTC day boundary of each extractor (unverified)

The audit did not check which instant each source calls the end of a day for
Coin Metrics, DefiLlama and blockchain.com. A source that stamps a day at its
start would show a full day of data one day early.

## Prepare (alignment and fill)

### P1. `lastRaw` is not cut at the as-of day (look-ahead, display only)

`prepareRegimeInputs` returns the last row of each input series as given
(`prepare.ts:21`, `prepare.ts:58`). The doc comment says "Not cut at asof."
When a past day is replayed, the raw value and raw date shown for an indicator
can come from after that day. No calculation reads it.

### P2. The calendar axis repeats the last close on closed days (windowing, root cause)

The axis has one row per calendar day. A series with no value on a closed day
carries its last value forward. This is correct for a level on a given day. It
becomes a defect once a window is counted over those rows, as in T1 and A2.

### Checked and correct

- Fill only carries values forward.
- A day before an indicator's first observation is missing.
- A day older than the fill policy allows is missing.

## Transform

### T1. "Day" windows count calendar days on forward-filled series (windowing)

Every transform counts axis rows (`transform/transforms.ts`). For a series that
trades five days a week, the rows include the filled weekend and holiday
values.

| Transform | Named span | Actual span for an equity series |
|---|---|---|
| `trend_50_200` | 50 and 200 trading days | about 36 and 143 trading days |
| `sma4`, `sma7` | 4 or 7 days | 3 to 5 trading days, Friday counted three times |
| `change30`, `change90` | 30 or 90 days | 30 or 90 calendar days (this is a consistent meaning) |
| `rolling_sum_7` | 7 days | 7 calendar days (correct for a daily flow) |

- **Affected:** `SPX_TREND` most of all. `ETH_TREND` is correct, because ETH
  trades every day.
- **Effect:** the SPX trend signal reacts faster than a 50/200 trend, and
  Friday's close carries three times the weight of any other day.

### Checked and correct

Every transform reads only rows up to and including day *t*.

## Analyze

### A1. Last-day weight refit (run variance): the main finding

Weights are refit every 21 days and also on the last day of every run
(`analyze/compute.ts:134`). The same day gets different weights depending on
whether it was the newest day of its run. See
[The main finding in full](#the-main-finding-in-full).

### A2. Rank and weight windows count each Friday three times (windowing)

The 1,095-day rank window (`transform/math.ts:221`) and the weight window
(`compute.ts:136`) count axis rows. For an equity or FRED series, each Friday
value appears three times and each pre-holiday value more.

- **Rank:** the percentile leans toward Friday values.
- **Weights:** correlations between an equity series and a crypto series are
  computed on rows where one side is repeated and the other moves. That pulls
  the correlation toward zero and raises the weight of both.

### A3. The rank starts after only 30 observations (skew)

A rank is produced once the window holds 30 finite values
(`math.ts:264`). The window is meant to hold 1,095. Early ranks for a new
indicator rest on a month of data and swing widely.

### A4. v4 cuts a composite bunched near 0.5 at uniform-scale cut-offs (skew)

The 0.33 and 0.67 cut-offs assume a value spread evenly from 0 to 1
(`compute.ts:224`, `indicators.ts:665`).

- **Each rank:** spread evenly, with variance 1/12.
- **A panel index:** a weighted mean of ranks. Its variance shrinks to about
  (1/12)·(ρ̄ + (1−ρ̄)/k), for k indicators with average correlation ρ̄. The
  weights lower ρ̄ on purpose.
- **The composite:** a mean of two panels, which shrinks it again.
- **Effect:** the composite rarely reaches either cut-off, so v4 reads neutral
  most of the time. v3's second ranking was what spread it back out.

### A5. The 25% weight cap does nothing in a small panel (skew)

With 4 or fewer eligible indicators, every weight is at or above 0.25. The cap
loop finds no weight below the cap to receive the excess, and leaves the
weights unchanged (`math.ts:356`). This happens early in the history and
whenever indicators drop out.

### A6. Absolute correlation treats a diversifier as redundant (skew)

- **Sign:** the fit uses the mean absolute correlation (`math.ts:337-350`). An
  indicator that moves opposite to its panel is treated as redundant. It is a
  diversifier, or a sign error.
- **Noise:** daily percentile ranks over overlapping windows move slowly. The
  effective sample is small, so the weights are noisy.
- **Floor:** the 0.05 floor lets one raw weight reach 20 times another before
  the cap.

### A7. The composite jumps when a panel is missing (skew)

The composite is the plain mean of whichever panels have a value that day
(`compute.ts:150-157`).

- **Missing panel:** the composite becomes the other panel alone. That is a
  step change with no market cause.
- **Equal panel weights:** 8 macro indicators count the same as 10 on-chain
  ones.

### A8. Smoothing: easy fast-track, no buffer zone (skew)

- **Fast-track:** σ is measured on daily changes of a slow-moving series, so
  it is small and the 2σ test passes easily (`compute.ts:259-281`).
- **Direction:** any large move into neutral passes, in either direction.
- **No buffer zone:** a composite sitting at a cut-off flips back and forth
  each time it passes the 5-day confirmation.

### Checked and correct

- The rank window ends on day *t*.
- Each weight fit reads only rows up to its fit date.
- The panel index and composite use same-day values only.
- The 5-day confirmation and the fast-track look only backward.

## Backtest

### B1. Trade at the same close as the signal (look-ahead)

Day *i*'s label is built from day *i*'s closing data. The backtest rebalances
at that same close and earns day *i*+1's return
(`analyze/backtest.ts:610`). A real strategy can only trade after the label is
known. The allocation path already lags one day (`allocate/labels.ts:89`).

### B2. Weekend and holiday trades at a stale price (look-ahead)

The label can change on a Saturday, because crypto and on-chain inputs keep
moving. The simulation then trades SPX at Friday's carried-forward close and
captures Monday's gap (`backtest.ts:574-616`). The sp500 and mixed portfolios
are affected.

### B3. Sharpe ignores the T-bill rate and trading costs (bias)

`periodStats` takes the raw mean of pre-cost daily returns
(`backtest.ts:666-668`).

- **No excess return:** a strategy in cash is credited with the T-bill rate.
- **No costs:** CAGR counts the 10 bps costs, and Sharpe does not.
- **History:** this was item 2 of issue 1044. It was folded into 1146, which
  closed without the fix reaching main.

### B4. Method chosen with hindsight, reported as out-of-sample (bias)

The v4 rule, the 3-year windows, the cut-offs, the cap, the 5-day
confirmation, the panel set and the indicator list were chosen in 2026 with
the whole history in view. `BACKTEST_IN_SAMPLE_END` is fixed at 2024-01-31, so
the "out-of-sample" block covers a period the choices were made on.

### B5. Cash rate quoted on a discount basis (skew)

`DTB3` is a discount-basis quote. The backtest compounds it as an annual yield
over 365 days (`backtest.ts:587`). Cash returns are understated by a few basis
points a year.

### B6. A 10 bps cost is light for ETH (bias)

One cost rate applies to every asset (`BACKTEST_COST_PER_REBALANCE`). It is
reasonable for SPX. Spread and slippage on ETH are wider.

### B7. Max drawdown series (unverified)

`periodStats` measures drawdown on the value series it receives. If a caller
passes month-end values, drawdown is understated. The audit did not confirm
which series each caller passes.

### B8. The backtest input inherits earlier defects

The backtest trades the labels of a full run. Those labels carry E1 to E3
(look-ahead in the source data) and A1 (a series no single day ever
produced).

### Checked and correct

- Each day's return uses the weights held from the previous close.
- Cash earns the previous day's rate.
- The Markowitz fit uses returns strictly before the rebalance date
  (`allocate/markowitz.ts:495`).

## Report and consume

### R1. Forward correlations overstate their sample size (bias)

The 30, 90 and 180-day forward returns overlap. The number of independent
observations is about n divided by the horizon, and the payload reports n
(`analyze/correlations.ts`). The payload carries no effective sample size.
No page renders these correlations today: the table was removed from the
regime page on 2026-11-04.

### R2. Forward correlations look forward by design (guard needed)

They pair today's index with a later return. That is their purpose, and it is
correct for display. Today nothing in the swarm brief or allocation reads
them. No test stops a future reader from using them as an input.

### R3. Research comparisons score on the full sample (bias)

`analyze/weighting-comparison.ts` and `analyze/regime-eq-comparison.ts` rank
method variants on the whole history. A variant chosen that way is fitted to
the period it is then reported on.

### R4. A historical committee replay would leak training data (guard needed)

No code replays the LLM committee on past dates today. A language model asked
about a past date already knows what happened next. Any future historical
committee simulation would look ahead through the model itself.

### R5. Swarm brief contents (unverified)

The audit did not review which values the brief and the judge receive, beyond
confirming they do not read the forward correlations.

### Checked and correct

- Allocation labels use data up to the day before each decision.
- The research gauges use rolling ranks (`research-signals.ts:202`).
- The synthetic regime backfill runs only in the test harness
  (`backend/src/swarm/domain.ts:3487`).
- Publishing stores a computed value. It does not define it.

## The main finding in full

### The defect

`analyze/compute.ts:134`:

```ts
if (i % WEIGHT_REFRESH_DAYS === 0 || i === dateAxis.length - 1) {
  // refit inverseCorrelationWeights on the weight window ending at i
}
```

Weights are refit on every 21st axis day **and on the last axis day**. Every
other day reuses the most recent weights.

### Example

The 21-day refits fall on 3 Nov and 24 Nov.

| Run | Weights applied to 10 Nov |
|---|---|
| Run ending 10 Nov (10 Nov is the last day) | refit on 10 Nov, data up to 10 Nov |
| Run ending 23 Nov (10 Nov is mid-history) | refit on 3 Nov, data up to 3 Nov |

Identical inputs for 10 Nov produce different weights. So they produce a
different panel index and composite, and possibly a different label. The 5-day
confirmation can carry a label difference forward several days.

`docs/technical/regime-engine.md:468` already says so: "the as-of day is
revised by construction when D moves forward one day."

### How v0 introduced it

The rule comes from v0 (`scripts/regime/compute.js` in
`agentjuno/robotmoney`). Its stated reason
(`docs/technical/regime-engine.md:292-300`) has two parts:

1. Refitting the correlation matrix is costly, so it runs every 21 days.
2. The last day is refit so the "published as-of weights" are "never stale
   relative to the day being published."

Part 2 mixes up two things: publishing a weight, and defining the correct
weight for a day. v0 hid the mix-up. Its history was frozen and append-only
(commit `32ca0a08`). Each day was computed once, as the last day of its run,
and never recomputed. "The weights used when the day was published" and "the
weights for that day" could not differ.

### How the refactor exposed it

The refactor ported the refit rule unchanged
(`docs/audits/v0-v1-parity/A1-regime-core-procedures.md:56`). It did not port
the frozen history. Production recomputes every past day on every run: the
history replay, the backtest and the correlations.

- A day gets last-day weights only on the single run where it is newest.
- Every later run gives it the 21-day weights.
- A rule meant to keep the newest row fresh now makes every row depend on when
  it was computed.

Part 1 of the reason justifies the 21-day calendar. It does not justify
treating the last day as special.

### Consequences

- **Every full-run series is a hybrid.** The history replay, the backtest and
  the correlations read a series in which past days never carry their own
  run-ending weights. The algorithm never produces that series on any single
  day.
- **Today is built by a different rule from its history.** That distorts
  anything comparing today with its own past: the trailing rank of the
  composite, and the day-over-day change used by the fast-track.
- **Reruns change labels with no data change.** It looks like a data error and
  it isn't one.
- **Replays cannot be verified.** "A run replays exactly" holds only when the
  replayed day is the last day of the run.

### Why this is not look-ahead

Both sets of weights use only data up to the day they are applied. Nothing
from the future leaks in. The defect is that the method gives two answers for
one day.
