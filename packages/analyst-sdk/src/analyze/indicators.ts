// Regime detection indicator universe — ported VERBATIM from
// agentjuno/robotmoney scripts/regime/lib/indicators.js.
//
// Panels: macro (8), onchain (10) and factor (8). PANEL_MEMBERSHIP marks each
// panel included or excluded; PANELS is the included set, and the composite is
// the plain 1/n mean of the included panel indices. Each indicator is percentile-ranked
// over a 3y rolling window, sign-aligned so +1 = risk-on, and inverse-correlation
// weighted within its panel.
//
// Sign convention: +1 means "rising raw value = risk-on", -1 means flip.
// Transform: applied to the raw history before percentile ranking.

// #402: the former single maximum age (in days) a forward-filled value could be
// carried. Since issue 1655 it is the value every registry indicator declares in
// its own fill policy below. Defined here, in the pure registry, so a reader of
// the registry imports no calculation code; transform/math.ts re-exports it.
export const MAX_FORWARD_FILL_DAYS = 120;

/**
 * When a source publishes the value for a period date.
 *   same-day:      on the period date itself.
 *   business-days: `days` business days (Monday to Friday) after it.
 *   next-weekday:  on the first `weekday` (0 Sunday .. 6 Saturday) strictly after it.
 *   months-later:  on the 1st of the month `months` after the period's month.
 */
export type PublicationRule =
  | { kind: "same-day" }
  | { kind: "business-days"; days: number }
  | { kind: "next-weekday"; weekday: number }
  | { kind: "months-later"; months: number };

export type Panel = "macro" | "onchain" | "factor";
export type RatioInput = "stored" | "legs";
export type RatioClose = "adjusted" | "raw";

export interface Indicator {
  id: string;
  name: string;
  panel: Panel;
  source: string;
  // A two-symbol `series` ([numerator, denominator], source "yahoo") is a
  // ratio of the two symbols' closes, calculated with mergeRatioSeries in the
  // transform stage (transform/ratios.ts). Each symbol is stored as two source
  // series, `yahoo:<SYMBOL>.close` (raw) and `yahoo:<SYMBOL>.adjclose`
  // (adjusted) (issue 1644, analytics requirements 4.3).
  series?: string | string[] | { asset: string; metric: string };
  // A ratio's two declared methodology parameters (issue 1644; the choices are
  // research issue 1673). Required on a ratio, refused on any other indicator.
  // ratioInput "stored": read the stored ratio when the input carries one,
  // else compute it from the legs; ingestion keeps storing the ratio.
  // ratioInput "legs": always compute it from the legs and ignore a stored
  // ratio. ratioClose selects the legs: "adjusted" reads the .adjclose legs,
  // "raw" the .close legs. Ingestion stores every ratio (STORED_RATIO_IDS):
  // methodology v3 reads all eight stored and adjusted (issue 1733).
  ratioInput?: RatioInput;
  ratioClose?: RatioClose;
  sign: 1 | -1;
  transform: string;
  // How a day without a real observation is treated (issue 1655). Required:
  // the SDK has no default. See FillPolicy below.
  fill: FillPolicy;
  // Why this indicator has its policy, in a short phrase.
  fillReason: string;
  // The days the source observes the series (issue 1741). Required: the loader
  // refuses a row without a valid value (CalendarError). See Calendar below.
  calendar: Calendar;
  // When the source publishes the value for a period date (issue 1733).
  // Required: the loader refuses an indicator without one (PublicationRuleError).
  publication: PublicationRule;
  unit: string;
  source_url?: string;
  description?: string;
  derivation?: string;
  interpretation?: string;
}

// Fill policy (issue 1655, docs/technical/regime-engine.md section 8.1). The
// SDK never fills a gap by default. Each indicator declares its policy:
//   none:    no fill; a day without a real observation is missing.
//   forward: the last real observation is carried for at most maxAgeDays days;
//            an older day is missing. maxAgeDays null carries it with no age
//            limit (issue 1554, the backtest's price and cash-rate series).
//   zero:    a gap is a real 0.
// An analyst changes a row (fill and fillReason) in its own reviewed diff,
// which owns any methodology version change and golden regeneration.
export type FillPolicy = { kind: "none" } | { kind: "forward"; maxAgeDays: number | null } | { kind: "zero" };

// Every registry indicator declares the former global cap, so every figure is
// the one the SDK computed before per-indicator policies existed.
const DECLARED_FILL: FillPolicy = { kind: "forward", maxAgeDays: MAX_FORWARD_FILL_DAYS };
const DECLARED_FILL_REASON = "Carried forward up to the former global cap";

// Publication rules (issue 1733, docs/technical/regime-engine.md section 8.1.2).
// A value is read from the day it was published, never its period date.
// FRED dailies (T10Y2Y, DFII10, T5YIE, BAMLH0A0HYM2) publish the next business
// day; DTWEXBGS (H.10) the Monday after; ICSA the Thursday after its
// week-ending Saturday; the multpl/Shiller monthly CAPE averages the whole
// month, so it is known from the 1st of the next month. Market closes and the
// on-chain dailies are known on their own UTC day.
const SAME_DAY: PublicationRule = { kind: "same-day" };
const NEXT_BUSINESS_DAY: PublicationRule = { kind: "business-days", days: 1 };

// Calendar (issue 1741, docs/technical/regime-engine.md section 3). The days a
// series has a real observation:
//   daily:    every day, 24/7 (crypto and on-chain).
//   exchange: business or trading days. Under a version that counts observation
//             days, the transform, the rank and the weight fit count each real
//             observation once, never the days a close is carried over a weekend.
//   periodic: a weekly or monthly release. Its carried rows keep counting.
export type Calendar = "daily" | "exchange" | "periodic";
export const CALENDARS: readonly Calendar[] = ["daily", "exchange", "periodic"];

// Raised when an indicator has no valid declared calendar. Names it.
export class CalendarError extends Error {
  constructor(readonly indicatorId: string, detail: string) {
    super(`indicator ${indicatorId}: ${detail} (declare calendar as "daily", "exchange" or "periodic")`);
    this.name = "CalendarError";
  }
}

/** The indicator's declared calendar. Throws CalendarError when it is missing or unknown. */
export function calendarOf(ind: { id: string; calendar?: unknown }): Calendar {
  const c = ind.calendar;
  if (c === undefined || c === null) throw new CalendarError(ind.id, "no calendar declared");
  if (typeof c !== "string" || !(CALENDARS as readonly string[]).includes(c)) {
    throw new CalendarError(ind.id, `unknown calendar ${JSON.stringify(c)}`);
  }
  return c as Calendar;
}

// Raised when an indicator has no valid declared fill policy. Names it.
export class FillPolicyError extends Error {
  constructor(readonly indicatorId: string, detail: string) {
    super(`indicator ${indicatorId}: ${detail} (declare fill as { kind: "none" }, { kind: "forward", maxAgeDays }, or { kind: "zero" }, with a fillReason)`);
    this.name = "FillPolicyError";
  }
}

/** The indicator's declared fill policy. Throws FillPolicyError when it is missing or malformed. */
export function fillPolicyOf(ind: { id: string; fill?: unknown; fillReason?: unknown }): FillPolicy {
  const f = ind.fill as { kind?: unknown; maxAgeDays?: unknown } | undefined;
  if (!f || typeof f !== "object") throw new FillPolicyError(ind.id, "no fill policy declared");
  if (typeof ind.fillReason !== "string" || ind.fillReason.trim() === "") throw new FillPolicyError(ind.id, "no fillReason declared");
  if (f.kind === "none" || f.kind === "zero") return { kind: f.kind };
  if (f.kind === "forward") {
    const n = f.maxAgeDays;
    if (n === null || (typeof n === "number" && Number.isInteger(n) && n > 0)) return { kind: "forward", maxAgeDays: n };
    throw new FillPolicyError(ind.id, `forward fill needs a positive integer maxAgeDays, or null for no age limit, got ${JSON.stringify(n)}`);
  }
  throw new FillPolicyError(ind.id, `unknown fill kind ${JSON.stringify(f.kind)}`);
}

/** Days a gap may be filled under the policy: 0 for none, maxAgeDays for forward (Infinity when null), Infinity for zero. */
export function fillMaxAgeDays(policy: FillPolicy): number {
  return policy.kind === "none" ? 0 : policy.kind === "forward" ? (policy.maxAgeDays ?? Infinity) : Infinity;
}

// Day rule (issue 1655): what a run does with a day that is not complete.
//   score-newest:     score the day given, or the newest input row, as before;
//                     an indicator older than its policy is NaN that day.
//   require-complete: without an as-of day score the latest complete day; an
//                     explicit incomplete day is an IncompleteDay, no figure.
// The declared value keeps today's day in every case.
export type DayRule = "score-newest" | "require-complete";
export const DAY_RULES: readonly DayRule[] = ["score-newest", "require-complete"];
export const DAY_RULE: DayRule = "score-newest";

export const INDICATORS: Indicator[] = [
  // ── MACRO ────────────────────────────────────────────────────────────────
  {
    id: "T10Y2Y",
    name: "10y–2y yield curve",
    panel: "macro",
    source: "fred",
    series: "T10Y2Y",
    sign: +1,
    transform: "level",
    unit: "percent",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: NEXT_BUSINESS_DAY,
    source_url: "https://fred.stlouisfed.org/series/T10Y2Y",
    description:
      "The difference between 10-year and 2-year US Treasury yields. When negative (\"inverted\"), short-dated bonds yield more than long-dated ones — a configuration that has historically preceded every US recession since 1955.",
    derivation:
      "FRED publishes this as a daily spread (DGS10 − DGS2). We read the raw level in percentage points.",
    interpretation:
      "Steep positive curve (above ~1.5%) signals healthy growth expectations — long-term capital wants compensation for tying up money. Flat or inverted curve (below 0%) signals that the bond market expects future rate cuts because growth is slowing. Risk-on when steepening; risk-off when flattening or inverted.",
  },
  {
    id: "DFII10",
    name: "Real 10y yield",
    panel: "macro",
    source: "fred",
    series: "DFII10",
    sign: -1,
    transform: "level",
    unit: "percent",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: NEXT_BUSINESS_DAY,
    source_url: "https://fred.stlouisfed.org/series/DFII10",
    description:
      "The yield on 10-year Treasury Inflation-Protected Securities (TIPS) — the \"real\" interest rate after stripping out inflation expectations. The pure cost of capital that policymakers actually care about.",
    derivation: "FRED series DFII10, published daily.",
    interpretation:
      "Low or negative real rates (below 0.5%) mean monetary policy is loose, which lifts risk assets — investors are pushed out the risk curve. High real rates (above 2%) mean restrictive policy, which compresses valuations and squeezes leveraged businesses. Risk-on when low; risk-off when high.",
  },
  {
    id: "T5YIE",
    name: "5y breakeven inflation",
    panel: "macro",
    source: "fred",
    series: "T5YIE",
    sign: +1,
    transform: "level",
    unit: "percent",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: NEXT_BUSINESS_DAY,
    source_url: "https://fred.stlouisfed.org/series/T5YIE",
    description:
      "The bond market's implied forecast for average inflation over the next 5 years. Computed as the spread between nominal 5-year Treasury yield and 5-year TIPS yield.",
    derivation:
      "FRED T5YIE, daily. The number is the inflation rate at which an investor would be indifferent between a nominal Treasury and a TIPS over the period — \"breaking even.\"",
    interpretation:
      "Historically read as a regime-dependent signal. In deflationary periods (2009–2020), rising breakevens meant the Fed was succeeding at reflating — risk-on. In the post-2022 inflation regime, elevated breakevens can also signal Fed hawkishness — risk-off. Our sign is +1 (reflation framing). Treat with care during stagflation-like conditions.",
  },
  {
    id: "HY_OAS",
    name: "HY OAS credit spread",
    panel: "macro",
    source: "fred",
    series: "BAMLH0A0HYM2",
    sign: -1,
    transform: "level",
    unit: "percent",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: NEXT_BUSINESS_DAY,
    source_url: "https://fred.stlouisfed.org/series/BAMLH0A0HYM2",
    description:
      "ICE BofA US High Yield Option-Adjusted Spread. The yield premium that investors demand to hold US junk-rated corporate bonds over Treasuries. A direct, real-time measure of credit risk appetite.",
    derivation:
      "FRED series BAMLH0A0HYM2, daily. Already an OAS — adjusts for embedded call/put options in the bond universe so it's comparable across regimes.",
    interpretation:
      "Tight spreads (below 3.5%) signal that credit markets are complacent, default risk is being priced low — risk-on. Wide spreads (above 6%) signal that credit investors are pricing-in stress — risk-off. Above 10% is recessionary. One of the most reliable late-cycle / crisis indicators we have.",
  },
  {
    id: "DXY",
    name: "DXY (trade-weighted USD)",
    panel: "macro",
    source: "fred",
    series: "DTWEXBGS",
    sign: -1,
    transform: "level",
    unit: "index",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: { kind: "next-weekday", weekday: 1 },
    source_url: "https://fred.stlouisfed.org/series/DTWEXBGS",
    description:
      "A broad trade-weighted index of the US dollar against the currencies of major US trading partners. Measures dollar strength globally, not just against the major reserve currencies.",
    derivation:
      "FRED series DTWEXBGS, published business-daily (not the daily DXY ICE futures index). We read the raw index level.",
    interpretation:
      "A stronger dollar tightens global financial conditions — emerging-market borrowers with dollar debt struggle, commodity prices fall, and risk assets typically suffer. A weaker dollar does the opposite. Risk-off when DXY is high or rising; risk-on when low or falling.",
  },
  {
    id: "ICSA",
    name: "Initial jobless claims",
    panel: "macro",
    source: "fred",
    series: "ICSA",
    sign: -1,
    transform: "level",
    unit: "count",
    fill: DECLARED_FILL,
    calendar: "periodic",
    fillReason: DECLARED_FILL_REASON,
    publication: { kind: "next-weekday", weekday: 4 },
    source_url: "https://fred.stlouisfed.org/series/ICSA",
    description:
      "The number of new claims filed for US unemployment insurance benefits in the most recent week. The cleanest high-frequency read on labor market health.",
    derivation:
      "FRED series ICSA, published every Thursday for the prior week ending Saturday. We use the raw weekly count.",
    interpretation:
      "Low claims (below 250k) signal a tight labor market — workers are hard to replace, businesses are hesitant to lay off. Rising claims (above 350k) signal labor market stress and have historically preceded recessions by 3–6 months. Risk-on when low; risk-off when rising.",
  },
  {
    id: "VIX",
    name: "VIX",
    panel: "macro",
    source: "yahoo",
    series: "^VIX",
    sign: -1,
    transform: "level",
    unit: "index",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/%5EVIX",
    description:
      "CBOE Volatility Index. The market's expected 30-day volatility of the S&P 500, derived from the prices of out-of-the-money S&P options. Universally known as the \"fear gauge.\"",
    derivation:
      "Yahoo Finance ticker ^VIX, daily close. The number is annualized expected volatility in percentage points.",
    interpretation:
      "Below 15 = complacency, low fear, risk-on environment. 15–25 = normal. 25–40 = elevated stress, risk-off. Above 40 = panic (rare — March 2020, Lehman, 1987). VIX tends to mean-revert; sustained elevated readings matter more than spikes.",
  },
  {
    id: "COPPER_GOLD",
    name: "Copper / Gold ratio",
    panel: "macro",
    source: "yahoo",
    series: ["HG=F", "GC=F"],
    ratioInput: "stored",
    ratioClose: "adjusted",
    sign: +1,
    transform: "level",
    unit: "ratio4",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/HG=F",
    description:
      "Price of copper futures divided by price of gold futures. Copper is an industrial-demand proxy (used heavily in construction, electronics, manufacturing); gold is a defensive store of value. The ratio captures whether the commodity complex is leaning cyclical or defensive.",
    derivation:
      "Yahoo Finance HG=F (Comex copper futures) divided by GC=F (Comex gold futures), daily.",
    interpretation:
      "Rising ratio signals industrial activity outpacing safe-haven demand — growth confidence — risk-on. Falling ratio signals investors flocking to gold while copper demand fades — defensive positioning — risk-off. A classic Druckenmiller-favorite cyclical gauge.",
  },
  {
    id: "SPX_TREND",
    name: "S&P 500 50d/200d trend",
    panel: "factor",
    source: "yahoo",
    series: "^GSPC",
    sign: +1,
    transform: "trend_50_200",
    unit: "index",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/%5EGSPC",
    description:
      "Ratio of the S&P 500's 50-day simple moving average to its 200-day simple moving average. The classic \"golden cross / death cross\" trend indicator on the broadest equity benchmark.",
    derivation:
      "Yahoo ^GSPC daily closes. The stored value is the ^GSPC close; the trend_50_200 transform computes SMA(50) ÷ SMA(200) for each day downstream (above 1 = uptrend, below 1 = downtrend).",
    interpretation:
      "Ratio above 1 (golden cross) = SPX in a sustained uptrend = risk-on. Ratio below 1 (death cross) = downtrend = risk-off. Trend signals lag price action but filter out short-term noise, which is desirable in a regime classifier.",
  },
  {
    id: "IWM_SPY",
    name: "Equity breadth (IWM/SPY)",
    panel: "factor",
    source: "yahoo",
    series: ["IWM", "SPY"],
    ratioInput: "legs",
    ratioClose: "raw",
    sign: +1,
    transform: "level",
    unit: "ratio4",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/IWM",
    description:
      "Ratio of the Russell 2000 small-cap ETF (IWM) to the S&P 500 ETF (SPY). A measure of market breadth — whether small-caps are participating in the rally or just the mega-cap leaders.",
    derivation: "Yahoo Finance IWM ÷ SPY, daily.",
    interpretation:
      "Rising ratio = small-caps outperforming = broad-based participation = healthy risk-on. Falling ratio = mega-cap concentration without breadth = late-cycle, narrow leadership = risk-off. Bear markets typically start with small-cap underperformance well before the index tops.",
  },

  // ── ON-CHAIN / CRYPTO ────────────────────────────────────────────────────
  {
    id: "DEFI_TVL",
    name: "Total DeFi TVL",
    panel: "onchain",
    source: "defillama_tvl",
    sign: +1,
    transform: "level",
    unit: "usd",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://defillama.com/",
    description:
      "Total dollar value of crypto assets locked across all DeFi protocols — lending, automated market makers, liquid staking, restaking, yield aggregators. The aggregate measure of capital deployment into permissionless finance.",
    derivation:
      "DefiLlama aggregates TVL across all tracked protocols on all chains in USD terms. Updated daily.",
    interpretation:
      "Rising TVL = capital flowing into DeFi = on-chain risk appetite = risk-on. Falling TVL = capital withdrawal back to centralized rails or stables = risk-off. Note: USD value is sensitive to ETH/BTC price moves, so growth measures (90d Δ) are often more informative than the level alone.",
  },
  {
    id: "STABLES",
    name: "Total stablecoin float",
    panel: "onchain",
    source: "defillama_stables",
    sign: +1,
    transform: "level",
    unit: "usd",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://defillama.com/stablecoins",
    description:
      "Total outstanding supply of USD-pegged stablecoins (USDT, USDC, DAI, and others) across all chains. Approximates the dollar liquidity sitting on crypto rails.",
    derivation: "DefiLlama stablecoin aggregate, in USD. Updated daily.",
    interpretation:
      "Growing stablecoin float = capital entering the crypto ecosystem (often a leading indicator of upcoming deployment into risky assets). Shrinking float = capital leaving crypto. Risk-on when growing; risk-off when contracting. Counter-intuitively, stablecoin growth alongside falling crypto prices is sometimes the most bullish setup — dry powder accumulating during a sell-off.",
  },
  {
    id: "BTC_ACTIVE",
    name: "BTC active addresses",
    panel: "onchain",
    source: "blockchain_com",
    series: "n-unique-addresses",
    sign: +1,
    transform: "level",
    unit: "count",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://www.blockchain.com/explorer/charts/n-unique-addresses",
    description:
      "Number of unique Bitcoin addresses that participated in transactions on a given day. A proxy for organic network usage and on-chain engagement.",
    derivation: "Blockchain.com's n-unique-addresses chart, daily.",
    interpretation:
      "Rising active addresses = engaged user base, growing network utility = risk-on. Caveat: structural decline is real — ETF custody, Lightning Network, and exchange consolidation have moved transactions off-chain. So absolute levels are less informative than they were pre-2021. Treat this as a directional indicator, not a level read.",
  },
  {
    id: "ETH_ACTIVE",
    name: "ETH active addresses",
    panel: "onchain",
    source: "coinmetrics",
    series: { asset: "eth", metric: "AdrActCnt" },
    sign: +1,
    transform: "level",
    unit: "count",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://charts.coinmetrics.io/network-data/eth/AdrActCnt",
    description:
      "Number of unique Ethereum addresses that transacted on a given day. Equivalent to the BTC measure, for ETH mainnet specifically.",
    derivation: "Coinmetrics community data, asset=ETH, metric=AdrActCnt. Daily.",
    interpretation:
      "Same logic as BTC active addresses — rising = engaged network = risk-on. Caveats also similar: L2 migration has moved a lot of ETH activity off mainnet. Look for trend changes rather than absolute levels.",
  },
  {
    id: "BTC_MVRV",
    name: "BTC MVRV",
    panel: "onchain",
    source: "coinmetrics",
    series: { asset: "btc", metric: "CapMVRVCur" },
    sign: +1,
    transform: "level",
    unit: "ratio2",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://charts.coinmetrics.io/network-data/btc/CapMVRVCur",
    description:
      "Market Value to Realized Value ratio. Divides BTC market capitalization by its \"realized cap\" — the sum of (price-at-last-move × amount) across all UTXOs. Represents how big a paper gain or loss the average bitcoin holder is sitting on.",
    derivation:
      "Coinmetrics community data, asset=BTC, metric=CapMVRVCur (market cap ÷ realized cap, computed from on-chain UTXO data). Daily. Repointed from blockchain.com's mvrv chart after that endpoint was removed upstream (HTTP 404, #127).",
    interpretation:
      "Below 1 = market cap below cost basis of holders = historical bottoms (March 2020, late 2022). Above 3 = average holder up 3x = historical tops (late 2017, early 2021). Risk-on when rising from low; the indicator becomes a contrarian peak signal above 3.5. Use with care near extremes.",
  },
  {
    id: "BTC_ETH",
    name: "BTC / ETH ratio",
    panel: "onchain",
    source: "yahoo",
    series: ["BTC-USD", "ETH-USD"],
    ratioInput: "stored",
    ratioClose: "adjusted",
    sign: -1,
    transform: "level",
    unit: "ratio2",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/BTC-USD",
    description:
      "BTC price divided by ETH price. A proxy for \"crypto risk preference\" — when capital flies to the safest crypto asset (BTC) over the higher-beta major (ETH), risk-off is happening within crypto.",
    derivation:
      "Yahoo Finance BTC-USD ÷ ETH-USD, daily. We use this as a proxy for BTC dominance because true BTC.D historical data requires a paid feed.",
    interpretation:
      "Rising ratio = BTC outperforming ETH = capital seeking shelter within crypto = crypto risk-off. Falling ratio = ETH outperforming = animal spirits, alt-rotation = risk-on. Strongly correlates with the broader \"alt season\" framework.",
  },
  {
    id: "ETH_TREND",
    name: "ETH 50d/200d trend",
    panel: "onchain",
    source: "yahoo",
    series: "ETH-USD",
    sign: +1,
    transform: "trend_50_200",
    unit: "index",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/ETH-USD",
    description:
      "Ratio of ETH's 50-day simple moving average to its 200-day SMA. The ETH-specific equivalent of SPX_TREND.",
    derivation: "Yahoo ETH-USD daily closes. SMA(50) ÷ SMA(200).",
    interpretation:
      "Above 1 = ETH in uptrend = risk-on. Below 1 = downtrend = risk-off. Like SPX_TREND, lags but filters noise.",
  },
  {
    id: "NEW_TOKENS",
    name: "New DEX pools (24h)",
    panel: "onchain",
    source: "geckoterminal_newpools",
    sign: -1,
    transform: "level",
    unit: "count",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://www.geckoterminal.com/new-pools",
    description:
      "Count of new DEX liquidity pools (≈ new token launches) observed across all networks in the trailing 24 hours. A real-time measure of crypto speculation intensity.",
    derivation:
      "GeckoTerminal's /networks/new_pools endpoint, polled daily. The cron appends each day's count to data/regime/token-launches.csv; the percentile rank reads from that accumulated history.",
    interpretation:
      "High count = speculative froth (think 2021 NFT/meme manias, 2024 memecoin frenzy) = late-cycle behavior = contrarian risk-off signal. Low count = calm market = risk-on. Sign −1: rising count counts as risk-off. Note: this indicator is \"accumulate-forward\" — it only became reliable once we had ~60 days of daily samples, and the upstream API caps make it under-count on the busiest days.",
  },
  {
    id: "DEFI_GROWTH",
    name: "DeFi TVL growth (90d)",
    panel: "onchain",
    source: "defillama_tvl",
    sign: +1,
    transform: "change90",
    unit: "percent_change",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://defillama.com/",
    description:
      "The 90-day percent change in total DeFi TVL. Captures flow — whether capital is actively expanding or contracting the on-chain ecosystem — independent of where the absolute level happens to be.",
    derivation:
      "DefiLlama TVL series, transformed via (TVL[today] − TVL[today−90]) ÷ TVL[today−90].",
    interpretation:
      "Positive growth = capital flowing in = risk-on. Negative growth = capital exit = risk-off. Sits alongside DEFI_TVL (level): position vs. flow are different questions and both matter for treasury context.",
  },
  {
    id: "STABLES_GROWTH",
    name: "Stablecoin float growth (90d)",
    panel: "onchain",
    source: "defillama_stables",
    sign: +1,
    transform: "change90",
    unit: "percent_change",
    fill: DECLARED_FILL,
    calendar: "daily",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://defillama.com/stablecoins",
    description:
      "The 90-day percent change in total stablecoin float. Captures whether dollar liquidity on crypto rails is expanding or shrinking — a leading indicator of imminent risk-asset deployment or withdrawal.",
    derivation:
      "DefiLlama stablecoin aggregate, transformed via (Stables[today] − Stables[today−90]) ÷ Stables[today−90].",
    interpretation:
      "Stablecoin float almost always grows over multi-month periods (the asset class is structurally growing), so a 90d change above ~5% counts as healthy expansion = risk-on. Stagnation or contraction = capital leaving crypto = risk-off. One of the cleaner pure-flow signals.",
  },

  // ── FACTOR ────────────────────────────────────────────────────────────────
  {
    id: "SPHB_SPLV",
    name: "High-beta vs low-vol",
    panel: "factor",
    source: "yahoo",
    series: ["SPHB", "SPLV"],
    ratioInput: "legs",
    ratioClose: "raw",
    sign: +1,
    transform: "level",
    unit: "ratio4",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/SPHB",
    description:
      "Ratio of the Invesco S&P 500 High Beta ETF (SPHB) to the Invesco S&P 500 Low Volatility ETF (SPLV). Both are S&P 500 subsets, so the ratio isolates the risk-axis directly without cross-cap or sector confounds.",
    derivation: "Yahoo Finance SPHB ÷ SPLV, daily.",
    interpretation:
      "Rising = high-beta in favor = appetite for volatility = risk-on. Falling = defensive low-vol leading = risk-off. Sign-stable by construction since it measures beta itself.",
  },
  {
    id: "MTUM_SPY",
    name: "Momentum factor",
    panel: "factor",
    source: "yahoo",
    series: ["MTUM", "SPY"],
    ratioInput: "legs",
    ratioClose: "raw",
    sign: +1,
    transform: "level",
    unit: "ratio4",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/MTUM",
    description:
      "Ratio of the iShares MSCI USA Momentum Factor ETF (MTUM) to the S&P 500 ETF (SPY). Captures whether cross-sectional momentum — buying recent winners — is working in the current market.",
    derivation: "Yahoo Finance MTUM ÷ SPY, daily.",
    interpretation:
      "Rising = trends persisting, momentum-as-style in favor = risk-on. Falling = momentum reversal or crash, often clustering at regime turns.",
  },
  {
    id: "IWF_IWD",
    name: "Growth vs value",
    panel: "factor",
    source: "yahoo",
    series: ["IWF", "IWD"],
    ratioInput: "legs",
    ratioClose: "raw",
    sign: +1,
    transform: "level",
    unit: "ratio4",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/IWF",
    description:
      "Ratio of the iShares Russell 1000 Growth ETF (IWF) to the iShares Russell 1000 Value ETF (IWD). Captures the high-duration / risk-asset side of the equity style axis.",
    derivation: "Yahoo Finance IWF ÷ IWD, daily.",
    interpretation:
      "Rising = growth leading = long-duration appetite, low-rate or easing regime = risk-on. Falling = growth derating, often a rates or risk-off event. Value-leading is the inverse, no separate indicator needed.",
  },
  {
    id: "XLU_SPY",
    name: "Utilities leadership",
    panel: "factor",
    source: "yahoo",
    series: ["XLU", "SPY"],
    ratioInput: "legs",
    ratioClose: "raw",
    sign: -1,
    transform: "level",
    unit: "ratio4",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/XLU",
    description:
      "Ratio of the SPDR Utilities Select Sector ETF (XLU) to the S&P 500 ETF (SPY). Utilities are the canonical defensive / bond-proxy sector.",
    derivation: "Yahoo Finance XLU ÷ SPY, daily.",
    interpretation:
      "Rising = utilities outperforming = flight to safety and yield = risk-off. Falling = cyclical leadership = risk-on. Sign-stable across modern regimes; can also rally on falling rates for non-risk reasons.",
  },
  {
    id: "XLP_XLY",
    name: "Staples vs discretionary",
    panel: "factor",
    source: "yahoo",
    series: ["XLP", "XLY"],
    ratioInput: "legs",
    ratioClose: "raw",
    sign: -1,
    transform: "level",
    unit: "ratio4",
    fill: DECLARED_FILL,
    calendar: "exchange",
    fillReason: DECLARED_FILL_REASON,
    publication: SAME_DAY,
    source_url: "https://finance.yahoo.com/quote/XLP",
    description:
      "Ratio of the SPDR Consumer Staples ETF (XLP) to the SPDR Consumer Discretionary ETF (XLY). Direct read on consumer-driven cyclical vs defensive rotation.",
    derivation: "Yahoo Finance XLP ÷ XLY, daily.",
    interpretation:
      "Rising = staples leading discretionary = consumer defensives in favor = risk-off. Falling = discretionary leading = appetite for cyclical consumption = risk-on. One of the most sign-stable sector signals in the literature.",
  },
  {
    id: "SHILLER_CAPE",
    name: "Shiller CAPE (cyclically adjusted P/E)",
    panel: "factor",
    source: "shiller_cape",
    sign: -1,
    transform: "level",
    unit: "ratio2",
    fill: DECLARED_FILL,
    calendar: "periodic",
    fillReason: DECLARED_FILL_REASON,
    publication: { kind: "months-later", months: 1 },
    source_url: "https://www.multpl.com/shiller-pe",
    description:
      "Robert Shiller's Cyclically Adjusted Price-to-Earnings ratio for the S&P 500 — current real price divided by the 10-year average of real earnings. Smooths the earnings cycle so the multiple is comparable across business cycles, unlike raw trailing P/E which spikes mechanically in recessions.",
    derivation:
      "Sourced from the datasets/s-and-p-500 GitHub mirror of Robert Shiller's spreadsheet (PE10 column), with a multpl.com HTML scrape as a fallback if the primary source is unreachable. Monthly cadence, forward-filled to daily by the framework. The 3y rolling percentile rank then measures elevation against the indicator's own trailing 3-year range.",
    interpretation:
      "High CAPE = expensive equity market = lower long-horizon expected returns and elevated drawdown risk = risk-off (sign -1). The signal is strongest at tails (top/bottom decile); between extremes it is a slow-moving level rather than a precise short-horizon timer.",
  },
];

export class InvalidRatioCloseError extends Error {
  override readonly name = "InvalidRatioCloseError";
  constructor(readonly indicatorId: string, readonly field: "ratioInput" | "ratioClose", detail: string) {
    super(`indicator ${indicatorId}: ${field} ${detail}`);
  }
}

const RATIO_INPUTS: readonly string[] = ["stored", "legs"];
const RATIO_CLOSES: readonly string[] = ["adjusted", "raw"];

/** True for a two-symbol Yahoo indicator: a ratio of two closes. */
export const isRatioIndicator = (ind: Indicator): boolean => ind.source === "yahoo" && Array.isArray(ind.series);

/**
 * Refuses a malformed ratio declaration (issue 1644): a ratio without
 * ratioInput or ratioClose, a value outside the two names, or either field on
 * an indicator that is not a ratio. Returns `indicators`.
 */
export function validateRatioDeclarations<T extends readonly Indicator[]>(indicators: T): T {
  for (const ind of indicators) {
    const ratio = isRatioIndicator(ind);
    for (const [field, names] of [["ratioInput", RATIO_INPUTS], ["ratioClose", RATIO_CLOSES]] as const) {
      const v = (ind as unknown as Record<string, unknown>)[field];
      if (!ratio) {
        if (v !== undefined) throw new InvalidRatioCloseError(ind.id, field, "is declared on an indicator that is not a ratio");
        continue;
      }
      if (v === undefined) throw new InvalidRatioCloseError(ind.id, field, `is required on a ratio (${names.join(" or ")})`);
      if (typeof v !== "string" || !names.includes(v)) throw new InvalidRatioCloseError(ind.id, field, `must be ${names.join(" or ")}, got ${JSON.stringify(v)}`);
    }
  }
  return indicators;
}

validateRatioDeclarations(INDICATORS);

// Whether each panel counts toward the composite. The composite is the naive
// 1/n mean of the included panels' indices, where n is however many are
// included (and finite that day): nothing below assumes two or three panels.
// An excluded panel is still computed and published, for display only.
export type PanelMembership = "included" | "excluded";
export const PANEL_MEMBERSHIP: Readonly<Record<Panel, PanelMembership>> = Object.freeze({
  macro: "included",
  onchain: "included",
  factor: "included",
});

/** Every panel, included or not, in registry order. */
export const ALL_PANELS: Panel[] = Object.keys(PANEL_MEMBERSHIP) as Panel[];

/** The panels the composite averages, 1/n each. */
export const PANELS: Panel[] = ALL_PANELS.filter((p) => PANEL_MEMBERSHIP[p] === "included");

export const ROLLING_WINDOW_DAYS = 365 * 3;
export const COMPOSITE_BUCKETS = { risk_off: 0.33, risk_on: 0.67 };
