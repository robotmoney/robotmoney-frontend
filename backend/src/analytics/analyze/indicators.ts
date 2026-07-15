// Regime detection indicator universe — ported VERBATIM from
// agentjuno/robotmoney scripts/regime/lib/indicators.js.
//
// Two live panels: macro (8) and onchain (10). The factor panel (8) is fetched
// and persisted but NOT in PANELS, so it does not affect /regime's composite
// (it feeds the extended /regime_eq path). Each indicator is percentile-ranked
// over a 3y rolling window, sign-aligned so +1 = risk-on, and inverse-correlation
// weighted within its panel.
//
// Sign convention: +1 means "rising raw value = risk-on", -1 means flip.
// Transform: applied to the raw history before percentile ranking.

export type Panel = "macro" | "onchain" | "factor";

export interface Indicator {
  id: string;
  name: string;
  panel: Panel;
  source: string;
  series?: string | string[] | { asset: string; metric: string };
  sign: 1 | -1;
  transform: string;
  align?: "zero_fill";
  unit: string;
  source_url?: string;
  description?: string;
  derivation?: string;
  interpretation?: string;
}

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
    source_url: "https://fred.stlouisfed.org/series/DTWEXBGS",
    description:
      "A broad trade-weighted index of the US dollar against the currencies of major US trading partners. Measures dollar strength globally, not just against the major reserve currencies.",
    derivation:
      "FRED series DTWEXBGS. Published weekly (not the daily DXY ICE futures index). We read the raw index level.",
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
    sign: +1,
    transform: "level",
    unit: "ratio4",
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
    source_url: "https://finance.yahoo.com/quote/%5EGSPC",
    description:
      "Ratio of the S&P 500's 50-day simple moving average to its 200-day simple moving average. The classic \"golden cross / death cross\" trend indicator on the broadest equity benchmark.",
    derivation:
      "Yahoo ^GSPC daily closes. We compute SMA(50) ÷ SMA(200) for each day. Stored value is the ratio itself (above 1 = uptrend, below 1 = downtrend).",
    interpretation:
      "Ratio above 1 (golden cross) = SPX in a sustained uptrend = risk-on. Ratio below 1 (death cross) = downtrend = risk-off. Trend signals lag price action but filter out short-term noise, which is desirable in a regime classifier.",
  },
  {
    id: "IWM_SPY",
    name: "Equity breadth (IWM/SPY)",
    panel: "factor",
    source: "yahoo",
    series: ["IWM", "SPY"],
    sign: +1,
    transform: "level",
    unit: "ratio4",
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
    sign: -1,
    transform: "level",
    unit: "ratio2",
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
    source_url: "https://defillama.com/stablecoins",
    description:
      "The 90-day percent change in total stablecoin float. Captures whether dollar liquidity on crypto rails is expanding or shrinking — a leading indicator of imminent risk-asset deployment or withdrawal.",
    derivation:
      "DefiLlama stablecoin aggregate, transformed via (Stables[today] − Stables[today−90]) ÷ Stables[today−90].",
    interpretation:
      "Stablecoin float almost always grows over multi-month periods (the asset class is structurally growing), so a 90d change above ~5% counts as healthy expansion = risk-on. Stagnation or contraction = capital leaving crypto = risk-off. One of the cleaner pure-flow signals.",
  },

  // ── FACTOR (DATA-ONLY: fetched + persisted, NOT included in PANELS) ──────
  {
    id: "SPHB_SPLV",
    name: "High-beta vs low-vol",
    panel: "factor",
    source: "yahoo",
    series: ["SPHB", "SPLV"],
    sign: +1,
    transform: "level",
    unit: "ratio4",
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
    sign: +1,
    transform: "level",
    unit: "ratio4",
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
    sign: +1,
    transform: "level",
    unit: "ratio4",
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
    sign: -1,
    transform: "level",
    unit: "ratio4",
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
    sign: -1,
    transform: "level",
    unit: "ratio4",
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
    source_url: "https://www.multpl.com/shiller-pe",
    description:
      "Robert Shiller's Cyclically Adjusted Price-to-Earnings ratio for the S&P 500 — current real price divided by the 10-year average of real earnings. Smooths the earnings cycle so the multiple is comparable across business cycles, unlike raw trailing P/E which spikes mechanically in recessions.",
    derivation:
      "Sourced from the datasets/s-and-p-500 GitHub mirror of Robert Shiller's spreadsheet (PE10 column), with a multpl.com HTML scrape as a fallback if the primary source is unreachable. Monthly cadence, forward-filled to daily by the framework. The 3y rolling percentile rank then measures elevation against the indicator's own trailing 3-year range.",
    interpretation:
      "High CAPE = expensive equity market = lower long-horizon expected returns and elevated drawdown risk = risk-off (sign -1). The signal is strongest at tails (top/bottom decile); between extremes it is a slow-moving level rather than a precise short-horizon timer.",
  },
];

export const PANELS: Panel[] = ["macro", "onchain"];

export const ROLLING_WINDOW_DAYS = 365 * 3;
export const COMPOSITE_BUCKETS = { risk_off: 0.33, risk_on: 0.67 };
