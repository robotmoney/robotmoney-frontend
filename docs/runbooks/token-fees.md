# $ROBOTMONEY holdings and fee income

Answers two questions on demand: how much $ROBOTMONEY the prop wallets hold, and what the token's trading fees earn the protocol.

```bash
bun scripts/token-fees.ts          # report
bun scripts/token-fees.ts --json   # the same numbers as JSON
```

No keys and no stack. It reads Base over the public RPC and prices from GeckoTerminal, and takes about half a minute because the public RPC rate-limits it. Set `BASE_RPC_URL` to a keyed node to make it faster.

## What it reports

- **Holdings.** `balanceOf` for each prop wallet in `resolvePropWallets()` (backend/src/config.ts), valued at the GeckoTerminal spot price.
- **Fee split.** The live shares in Doppler's locker. $ROBOTMONEY launched through Bankr on Doppler (Uniswap v4), not Clanker. Swaps pay a 1.2% fee: 57% to the primary prop wallet, 36.1% to Bankr, 5% to Doppler and 1.9% to an ecosystem leg Bankr reserved at launch. The API's `feeSplit` (backend/src/chain/token-metrics.ts) is a constant; if the script ever shows different shares, update it.
- **Lifetime and claimable, exact.** From the locker's running fee totals. Lifetime is our share of every fee collected since launch, in WETH and $ROBOTMONEY; claimable is what the prop wallet could claim now.
- **By month, estimated.** GeckoTerminal daily pool volume × 1.2% × 57%. GeckoTerminal keeps about six months of daily candles, so the launch month (March 2026) is only in the lifetime line.

## Limits

Exact claims by month need the locker's `Release` events, and the public Base RPC allows `eth_getLogs` over 500 blocks at a time, with no archive state. A keyed RPC (`BASE_RPC_URL`) or a Dune plan that can run queries would add that.

Fee income paid in WETH does not stay in the primary wallet, so tracing where it went needs the same log access.
