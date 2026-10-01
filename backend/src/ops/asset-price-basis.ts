// The time basis every asset_prices row is written and read at (D41). A leaf
// module, so the wallet chain modules and ops/asset-prices.ts can both use it
// at module level (a registered probe names it) without importing each other.
export const ASSET_PRICE_TIME_BASIS = "utc-daily-close" as const;
