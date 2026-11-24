// @ts-check
// Token logos for the deposit surfaces (RM-146): each asset's own official
// mark, shown at 24px, the smallest size Circle's USDC guidelines allow on
// screen. Files live in assets/img/tokens/; fetched 17 Nov 2026 from:
//   usdc.svg   Circle's pressroom brand kit (usdc.zip, "Token Logo/USDC Token.svg"), unaltered.
//   weth.svg   ethereum.org/assets, eth-diamond-purple-purple.svg: the diamond's
//              paths unaltered, set on a disc of that file's own background colour.
//   cbbtc.png  the logo Coinbase registered on cbBTC's Basescan token page
//              (basescan.org/token/images/cbbtc_32.png). Coinbase publishes no
//              download; replace it with a vector if Coinbase supplies one.
// rmFUND has no icon yet: proposals are on the design canvas (board 28).

const ICONS = Object.freeze({
  USDC: "/assets/img/tokens/usdc.svg",
  WETH: "/assets/img/tokens/weth.svg",
  CBBTC: "/assets/img/tokens/cbbtc.png",
});

/** The logo for a token symbol ("USDC", "wETH", "cbBTC"), or null. @param {string} symbol */
export function tokenIcon(symbol) {
  return ICONS[/** @type {keyof typeof ICONS} */ (String(symbol || "").toUpperCase())] || null;
}
