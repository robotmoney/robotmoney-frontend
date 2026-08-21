# Research signals — channel-divergence and late-cycle

The two research signals are a **separate analysis** from the regime engine
([`regime-engine.md`](regime-engine.md)): different questions, different
inputs, computed by different functions, and — as of the fix described in
§2 — the **same** rolling-percentile convention as the regime core, after an
earlier period where they deliberately did not match it. Both live in
`backend/src/analytics/analyze/research-signals.ts`, are invoked from
`analytics/index.ts::runAnalytics` (the `RESEARCH_TOOL_GROUP` alias — both
share one live EDGAR sweep, see the comment at `analytics/index.ts` around
`runAnalytics`), and are persisted via `store/research-store.ts::persistResearchSignal`
into `research_signals`, keyed by signal id. Their payload shape
(`ResearchPayload`/`Gauge`) is defined in `analyze/research.ts` — read that
file's header for the non-finite-gauge-value contract (`null` means "no
reading for this as-of date", never a raw NaN and never a neutral zero).

This document does not restate `architecture.md` §7.1's plumbing description
of these two pipelines — see that section for where they sit relative to the
regime pipeline's shared access/extract/transform/store/report stages.

## 1. What each signal answers

### `channel-divergence` — "Is the easy-money → crypto transmission channel breaking down?"

Ported from v0's `scripts/regime/channel-divergence.js`
(`computeChannelDivergence`, `research-signals.ts:169`). Three component
readings, combined into one composite gauge:

1. **`BTC_BETA`** — BTC's rolling OLS beta (`rollingBetaSeries`,
   `research-signals.ts:35`, a 90-day-window series form of
   `transform/math.ts::rollingBeta`'s scalar) against a "risk appetite"
   factor defined as `QQQ daily return − SPY daily return` — high-beta tech
   vs. the broad market. A rising beta means BTC is trading more like a
   high-beta risk asset; a falling/negative beta means the crypto-to-risk-on
   linkage is weakening.
2. **`BTC_QQQ_RATIO`** — BTC price ÷ QQQ price, percentile-ranked against its
   own trailing history. Relative strength of crypto against the growth/tech
   trade.
3. **`STABLES_QQQ_FLOW`** — 90-day stablecoin-float growth minus 90-day QQQ
   growth. Positive means dollar liquidity is flowing onto crypto rails
   faster than it's flowing into growth equities — a leading-indicator read
   on where fresh capital wants to go.

The composite (`CHANNEL` gauge) is the mean of whichever of the three
percentile readings are finite that day. `channelRead` buckets it: `≥ 0.6`
"channel intact", `≤ 0.35` "breaking down", between = "softening".

### `late-cycle-signals` — "How late in the cycle is this rally?"

Ported from v0's `scripts/regime/late-cycle-signals.js`
(`computeLateCycle`, `research-signals.ts:278`). Five gauges:

1. **`CONCENTRATION`** — SPY ÷ RSP (cap-weighted vs. equal-weight S&P 500).
   A rising ratio means the index's gains are concentrated in its largest
   names rather than broad-based.
2. **`TOP7_VS_SPY`** — an equal-weight index of today's top-7 S&P names by
   weight (`TOP7`, `research-signals.ts:27` — `NVDA, MSFT, AAPL, GOOGL,
   AMZN, META, AVGO`; survivorship-biased by construction, since membership
   is today's, not point-in-time historical) against SPY.
3. **`MNA`** — the monthly count of SEC EDGAR S-4 filings (the merger/
   acquisition registration form), percentile-ranked. Elevated M&A activity
   is a classic late-cycle behavior (see `architecture.md` §7.1's EDGAR/MNA
   seed section for how this indicator's history is bootstrapped and
   maintained).
4. **`MARGIN`** — FRED `BOGZ1FL663067003Q` (Z.1 broker-dealer margin loans,
   quarterly), transformed to year-over-year growth. Rising margin debt
   signals leveraged risk-taking.
5. **`CONF`** — FRED `UMCSENT` (University of Michigan consumer sentiment).

`lateRead` buckets each percentile: `≥ 0.7` "saturated (late-cycle)`,
`≥ 0.5` "elevated", else "benign".

Both files' `spec` field in the returned `ResearchPayload` documents the
exact windows/sources/membership used, in-payload — read
`research-signals.ts:237-242` and `:327-334` for the values as of any given
run, since those are the ground truth the API actually serves.

## 2. Percentile convention: `rollingPercentileRank`, matching the regime core — by design, and by a deliberate fix

**Both signals use `rollingPercentileRank`
(`transform/math.ts:176`) — the same trailing-window, mid-rank-tie,
30-observation-warm-up percentile the regime core uses (`regime-engine.md`
§4) — not `percentileInWindow` (`transform/math.ts:31`).** This is
deliberate, and it was not always true:

- `research-signals.ts:194-201` (`R7`, referencing issue `#465` finding
  `11.5`/`D8`) documents that all three `channel-divergence` component
  readings now share `rollingPercentileRank` "so the composite never mixes a
  look-ahead-contaminated full-sample stat (`percentileInWindow`) with a
  point-in-time rolling rank." `BTC_QQQ_RATIO` already used
  `rollingPercentileRank`; `BTC_BETA` and `STABLES_QQQ_FLOW` were moved onto
  it to match. `late-cycle-signals` uses `rollingPercentileRank` throughout
  as well (`research-signals.ts:286,298,303,307`).
- The window differs from the regime core's: **756 trading-equivalent days
  (`PCT_RANK_WINDOW = 252 * 3`, `research-signals.ts:21`)** here, vs. the
  regime core's **1095 calendar days**. Both are "the trailing ~3 years,"
  expressed in different day-count conventions — 756 counts roughly-trading
  days (252/year, matching v0's own `channel-divergence.js`/
  `late-cycle-signals.js`), while the regime core's 1095 is a literal
  calendar-day count (`365 × 3`). This is a ported, faithful difference from
  each pipeline's own v0 origin, not an inconsistency to reconcile.

**Where `percentileInWindow` (the full-sample, no-tie-split, look-ahead
convention — see `regime-engine.md` §7 and `transform/math.ts`'s own header
comment) is actually still used:** only by the **dead** `analyze/regime.ts`
(`regimeTool`). No production research or regime call site consumes it. If
you see `percentileInWindow` on an import line for code that is supposed to
be live, that is the signal something has regressed — either back toward the
pre-`#465` state this document's history describes, or into the same trap
`regime-engine.md` §7 documents for the regime core.

**A note on this document's own provenance.** An earlier audit
(`docs/audits/v0-v1-parity/A1-regime-core-procedures.md`, dated 2026-08-03,
"What I could not determine" item 4) recorded that these two signals
consumed `percentileInWindow` and that this was an open, unverified
divergence from the regime core's convention. That was true when A1 was
written. It is no longer true: the `#465`/R7 fix above landed after that
audit and switched both signals onto `rollingPercentileRank`. Treat A1's
item 4 on this specific point as **superseded** by the code as it stands
today (verified directly against `research-signals.ts` while writing this
document, not merely inferred from a comment) — the rest of A1's findings
are unaffected by this correction.

## See also

- [`regime-engine.md`](regime-engine.md) — the regime core these signals deliberately share a percentile convention with, and deliberately do not share a composite/panel/bucketing structure with.
- [`architecture.md` §7.1](../architecture.md#71-analytics-suite-six-stage-pipeline) — plumbing, the EDGAR/MNA seed, and the `RESEARCH_TOOL_GROUP` shared-fetch alias.
- `backend/src/analytics/analyze/research.ts` — the `ResearchPayload`/`Gauge` contract, including the non-finite-value (`null`) semantics.
