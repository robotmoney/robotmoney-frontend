// The token page's FAQ (views/tokenomics.html) as its structured data states
// it (seo.js). The view's FAQ is static HTML, so the prerender and a reader
// without JavaScript get every answer; this list says exactly what the page
// says, in plain text (a link keeps its words, the markup goes), and
// scripts/tests/unit/seo-token-faq.test.ts holds the two together. Each id is
// the row's id on the page, so `${url}#${id}` opens that answer.
//
// Facts behind the answers, read on chain on 2026-10-06 (RM-156):
// - the token is Doppler's DERC20, verified on Sourcify; totalSupply 100e9;
//   vestedTotalAmount 0; yearlyMintRate 2%, but currentYearStart is 0, and
//   only the Airlock's migrate() can start minting, which first exits the
//   pool's liquidity, and a Locked pool cannot exit;
// - the pool launched 2026-03-12 18:27 UTC; its fee is 1.2% and the locker's
//   shares are 57 / 36.1 / 5 / 1.9;
// - bought-back tokens arrive in the primary prop wallet and stay there.

export const TOKEN_CONTRACT = "0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3";
export const TOKEN_PRIMARY_WALLET = "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6";

export const TOKEN_FAQ = [
  {
    id: "what-is-robotmoney",
    q: "What is $ROBOTMONEY?",
    a: "$ROBOTMONEY is the token of Robot Money, the treasury layer for the agent economy. It trades on Base, and the protocol's share of its swap fees buys it back.",
  },
  {
    id: "contract",
    q: "What is the $ROBOTMONEY contract address?",
    a: `${TOKEN_CONTRACT}, an ERC-20 on Base. Its source code is verified on Sourcify.`,
  },
  {
    id: "launch",
    q: "How was $ROBOTMONEY launched?",
    a: "As a fair launch through Bankr on Doppler, on 12 March 2026. There was no team allocation, pre-sale or insider tranche: all 100 billion tokens went into the Uniswap v4 pool, and Doppler's contract locks that liquidity with no way to withdraw it.",
  },
  {
    id: "supply",
    q: "Can the $ROBOTMONEY supply grow?",
    a: "No. The supply is 100 billion. Doppler's token contract carries a 2% yearly mint rate, but minting can only start when the pool migrates, and a locked pool cannot migrate, so no token has been minted since launch.",
  },
  {
    id: "swap-fee",
    q: "What fee does a $ROBOTMONEY swap pay?",
    a: "1.2%, on every swap in its Uniswap v4 pool. The protocol's primary wallet receives 57% and uses it to fund buybacks, Bankr 36.1%, Doppler 5%, and an ecosystem share Bankr reserved at launch 1.9%.",
  },
  {
    id: "burn",
    q: "Are bought-back tokens burned?",
    a: `No. They are held in the protocol's primary wallet, ${TOKEN_PRIMARY_WALLET}.`,
  },
  {
    id: "vault-returns",
    q: "Does holding $ROBOTMONEY earn the vault's returns?",
    a: "No. The token has no claim on the vault's returns. To earn the vault's yield, deposit USDC on the deposit page.",
  },
  {
    id: "governance",
    q: "What governance is planned for $ROBOTMONEY?",
    a: "None of it is built, and it has no ship date. A published quantitative filter would decide which tokens are eligible, and holders would vote their weights, so projects that want inclusion would hold $ROBOTMONEY. The vote would cover sleeve weights and nothing else: not the protocol wallets, marketing or operations. The design borrows Curve's gauge voting, with the filter in place of emissions, and Botto's allocation-only vote.",
  },
  {
    id: "participation",
    q: "How do I buy $ROBOTMONEY?",
    a: `In its Uniswap v4 pool on Base, directly, through Bankr or through any DEX aggregator. Check the contract address, ${TOKEN_CONTRACT}, before you trade.`,
  },
];
