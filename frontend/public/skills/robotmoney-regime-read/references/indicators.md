# Indicator guide

What each indicator measures, and what a high or a low level means. The model reading flips indicators where a higher level means more risk.

| Id | Measures | High level | Low level |
|---|---|---|---|
| `T10Y2Y` | the 10-year Treasury yield minus the 2-year yield (the yield curve) | long rates sit well above short rates, which usually goes with expected growth | the curve is flat or inverted, which has often come before slowdowns |
| `DFII10` | the 10-year Treasury yield after inflation (TIPS) | money is expensive after inflation, which tightens financial conditions | money is cheap after inflation, which eases financial conditions |
| `T5YIE` | the inflation rate the bond market expects over the next 5 years | markets expect higher inflation, which usually goes with stronger demand | markets expect lower inflation, which points to weaker demand |
| `HY_OAS` | the extra yield lenders demand on junk bonds over Treasuries | lenders want more pay for risk, a sign of caution | lenders ask little extra pay for risk, a sign of confidence |
| `DXY` | the trade-weighted US dollar | the dollar is strong, which usually weighs on risk assets and crypto | the dollar is weak, which usually helps risk assets and crypto |
| `ICSA` | new weekly claims for unemployment insurance | more people are losing jobs | few people are filing for unemployment, so the job market is strong |
| `VIX` | the expected 30-day volatility of the S&P 500 | investors expect large stock swings | investors expect calm stock markets |
| `FISCAL` | the federal deficit over the last 12 months, as a share of GDP | the government is running a large deficit, spending that flows into company revenues | the deficit is small or shrinking, so less government spending reaches the economy |
| `VIX_TERM` | expected S&P 500 volatility over the next 3 months divided by expected volatility over the next month (the VIX term structure) | traders expect calm now and more risk later, the usual state of a steady market | traders pay more for protection now than later, which happens in sell-offs |
| `SKEW` | the CBOE SKEW index: what traders pay for protection against a large S&P 500 fall | traders are buying crash protection | traders are paying little for crash protection |
| `UPVOL_SHARE` | the share of the last 20 trading days' S&P 500 volume that traded on days the index rose | most trading came on up days, a sign of buying pressure | most trading came on down days, a sign of selling pressure |
| `COPPER_GOLD` | the copper price over the gold price | industrial demand is strong against the safe asset | the safe asset is beating industrial demand |
| `SPX_TREND` | the S&P 500's 50-day average over its 200-day average | the stock uptrend is strong | the stock trend is flat or turning down |
| `IWM_SPY` | small-cap stocks (IWM) against the S&P 500 | small companies lead, so gains are broad | small companies lag, so gains are narrow |
| `SPHB_SPLV` | high-beta stocks against low-volatility stocks | investors favor riskier stocks | investors favor steadier stocks |
| `MTUM_SPY` | the momentum factor (recent winners) against the S&P 500 | recent winners keep leading | recent winners are no longer leading |
| `IWF_IWD` | growth stocks against value stocks | growth stocks lead | value stocks lead, so money is moving out of the most expensive part of the market |
| `XLU_SPY` | utility stocks against the S&P 500 | defensive utilities lead, a cautious sign | utilities lag, so investors are not moving to defensive stocks |
| `XLP_XLY` | consumer staples against consumer discretionary stocks | staples lead, a cautious sign | discretionary stocks lead, a sign of confidence in spending |
| `SHILLER_CAPE` | the S&P 500 price over 10 years of average real earnings (Shiller CAPE) | stocks are expensive against long-run earnings | stocks are cheap against long-run earnings |
| `DEFI_TVL` | the dollar value locked in DeFi protocols (TVL) | a lot of money is at work in DeFi | little money is at work in DeFi |
| `STABLES` | the total supply of USD stablecoins | a lot of dollar liquidity sits in crypto | little dollar liquidity sits in crypto |
| `BTC_ACTIVE` | addresses active on the Bitcoin network each day | many people are using the Bitcoin network | few people are using the Bitcoin network |
| `ETH_ACTIVE` | addresses active on the Ethereum network each day | many people are using the Ethereum network | few people are using the Ethereum network |
| `BTC_MVRV` | Bitcoin's market value over its realized value (MVRV), roughly price against the average price holders paid | price is well above what holders paid, a sign of strong demand | price is close to what holders paid, a sign of weak demand |
| `BTC_ETH` | the Bitcoin price over the Ether price | Bitcoin is beating Ether, a sign of caution inside crypto | Ether is beating Bitcoin, a sign of more risk appetite inside crypto |
| `ETH_TREND` | Ether's 50-day average over its 200-day average | Ether's uptrend is strong | Ether's trend is flat or turning down |
| `NEW_TOKENS` | new DEX liquidity pools a day, roughly new token launches | many new tokens are launching, which the model reads as speculation | few new tokens are launching, which the model reads as less speculation |
| `DEFI_GROWTH` | the 90-day change in DeFi TVL | money is flowing into DeFi | money is flowing out of DeFi |
| `STABLES_GROWTH` | the 90-day change in stablecoin supply | stablecoin supply is growing, so money is coming into crypto | stablecoin supply is shrinking, so money is leaving crypto |
