// Central environment configuration. The only required input is DATABASE_URL.
// RM_ENV selects behavior hints (ephemeral | smoke | prod) but the connection
// itself is always driven by DATABASE_URL so the same code runs everywhere.
import parser from "cron-parser";
import { envSecret } from "./lib/env-secret.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

// --- Base RPC provenance (issue #50) ----------------------------------------
// The vault-economics DTO labels where its numbers came from: 'live' (a real
// Base JSON-RPC endpoint — the production default, and the ONLY source the
// smoke/CI path selects since issue #147 removed DEMO_HERMETIC and the
// hermetic smoke/CI fixture stub entirely) or 'stub' (a deterministic fixture
// value backend unit tests set directly via BASE_RPC_SOURCE=stub with their
// own in-process mocked transport — see backend/tests/vault-economics.test.ts
// — so stub-served payloads are never presented as live chain data). Resolved
// at CALL time (not module load) by chain/vault-economics.ts so tests can flip
// the env. Fail-closed: an unrecognized value refuses to resolve rather than
// silently claiming 'live'.
export type BaseRpcSource = "live" | "stub";
export function resolveBaseRpcSource(
  env: Record<string, string | undefined> = process.env,
): BaseRpcSource {
  const raw = env.BASE_RPC_SOURCE;
  if (raw === undefined || raw === "" || raw === "live") return "live";
  if (raw === "stub") return "stub";
  throw new Error(`invalid BASE_RPC_SOURCE "${raw}" — expected "live" | "stub" (or unset for live)`);
}

// --- Placeholder-address sentinel (issue #50) --------------------------------
// A reserved non-functional placeholder is a single hex nibble repeated 40 times
// (0x0000…0 … 0xffff…f) — verified-empty accounts on Base mainnet used as an
// "address unset" sentinel. A real deployed contract/wallet address is never of
// this form. IMPORTANT: never use low addresses like 0x0…01/02/03 as sentinels —
// on Base (and most EVM chains) those alias the ecrecover/sha256/ripemd160
// precompiles, which return real (garbage, for this use) output instead of
// erroring, silently producing an absurd fabricated-looking balance. An address
// that is a placeholder is reported configured:false and is NEVER eth_called, so
// it can never render as a live-looking $0.
const PLACEHOLDER_ADDRESS_RE = /^0x([0-9a-f])\1{39}$/i;
export function isPlaceholderAddress(address: string | null | undefined): boolean {
  return !address || PLACEHOLDER_ADDRESS_RE.test(address);
}

// --- Vault adapter set (issues #40/#50) --------------------------------------
// Decision (issue #40): adapter set comes from config, NOT on-chain discovery.
// The three real Base-mainnet adapter contract addresses are baked as defaults
// so a smoke with only DATABASE_URL set reads real per-adapter TVL. Override any
// of them via ADAPTER_*_ADDRESS for a re-pointed deployment.
//
// `configured` (issue #50) is true iff the resolved address is a REAL
// (non-placeholder) address — real defaults are configured:true, and an env
// override still wins (overriding with a placeholder flips it back to false).
// An adapter that is a placeholder is reported configured:false and is NEVER
// eth_called by chain/vault-economics.ts (its balanceUsd stays null), so it can
// never render as a live-looking $0. Resolved at CALL time so tests can flip
// the env per case.
export interface VaultAdapterConfig {
  name: string;
  address: string;
  configured: boolean;
}
export function resolveVaultAdapters(
  env: Record<string, string | undefined> = process.env,
): VaultAdapterConfig[] {
  const adapter = (envKey: string, name: string, real: string): VaultAdapterConfig => {
    const address = env[envKey] || real;
    return { name, address, configured: !isPlaceholderAddress(address) };
  };
  return [
    adapter("ADAPTER_MORPHO_ADDRESS", "Morpho", "0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9"),
    adapter("ADAPTER_AAVE_ADDRESS", "Aave", "0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea"),
    adapter("ADAPTER_COMPOUND_ADDRESS", "Compound", "0x8247da22a59fce074c102431048d0ce7294c2652"),
  ];
}

// --- Prop-wallet valuation feed (issue #84) ----------------------------------
// The /allocation + /performance pages value the agent's PROP WALLETS live off
// Base JSON-RPC + keyless prices, replacing the baked WALLET_SNAPSHOT_TOTAL_USD
// scalar and the 99-day walletPerfView series that used to live in the frontend
// (alpine/views.js). Every address/decimals/size below is CONFIG, never a
// literal in the handler or either Alpine view (AC: config-driven).
//
// PRICE_SOURCE mirrors BASE_RPC_SOURCE: 'live' hits the keyless price feeds
// (GeckoTerminal token_price + Yahoo for SP500); 'stub' serves the deterministic
// fixtures in chain/token-prices.ts that backend unit tests set directly (see
// backend/tests/api/wallet-balances.test.ts) so those tests never reach an
// uncontrolled rate-limited price host. When PRICE_SOURCE is unset it FOLLOWS
// the RPC source (BASE_RPC_SOURCE) — 'live' unless a test explicitly sets
// BASE_RPC_SOURCE=stub. The smoke/CI path (issue #147) never selects 'stub' for
// either knob; both always resolve 'live'. An explicit PRICE_SOURCE overrides.
// Fail-closed: an unrecognized value refuses rather than silently claiming 'live'.
export type PriceSource = "live" | "stub";
export function resolvePriceSource(
  env: Record<string, string | undefined> = process.env,
): PriceSource {
  const raw = env.PRICE_SOURCE;
  if (raw === undefined || raw === "") return resolveBaseRpcSource(env);
  if (raw === "live") return "live";
  if (raw === "stub") return "stub";
  throw new Error(`invalid PRICE_SOURCE "${raw}" — expected "live" | "stub" (or unset to follow BASE_RPC_SOURCE)`);
}

// Canonical prop-wallet addresses on Base (source of truth: robotmoney-site
// wallet.ts). These are the holders whose balances are summed per tracked asset;
// the first is the primary/Bankr wallet (also the buyback destination). Baked as
// real defaults so a smoke with only DATABASE_URL set reads real wallet balances.
// Override via PROP_WALLET_ADDRESSES=comma,separated. Base-only by design (#84).
export function resolvePropWallets(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.PROP_WALLET_ADDRESSES;
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [
        "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6", // Primary / Bankr
        "0x422c906083cA40B7E055b811D517f03bBBEf8eeE", // Stablecoin Strategy 1 (ZyfAI)
        "0x8d0c331e45Beca4184B758f3049F8897AaBb9442", // Stablecoin Strategy 2 (Giza)
      ];
  return list.map((a) => a.toLowerCase());
}

// How a tracked asset is valued on chain (Open Questions 5/6 — precision policy
// + Aave/strategy set resolved here, documented per-kind):
//   erc20     — ERC-20 balanceOf(wallet); amount = raw / 10^decimals; * price.
//   native    — native ETH via eth_getBalance(wallet) (18 dp); * price.
//   aave      — Aave V3 aToken balanceOf(wallet) → underlying (aTokens rebase
//               1:1 with the underlying) → * underlying price. Config-driven and
//               EMPTY by default (Open Q6: exact aToken/debt set is owner data —
//               "do not assume the full legacy map"); add via AAVE_AUSDC_ADDRESS.
//   strategy  — smart-account NAV (issues #120/#145, corrected by #642 —
//               `address` is the AGENT'S SMART-ACCOUNT WALLET itself, a
//               Safe/Kernel account, NOT an ERC-4626 share token; balanceOf on
//               it always reverts): amount = idleUsdc(account)
//               + Σ resolveStrategyVaults() of convertToAssets(balanceOf(account))
//               + Σ resolveStrategyUnderlyingPositions() of balanceOf(account),
//               all 6 dp USDC. The two sums are DISTINCT paths on purpose: only
//               verified ERC-4626 shares may reach convertToAssets. Reported
//               plain 'live' like every other kind (#145: no distinct
//               provenance value), with idle-only NAV disclosed per-leg as
//               WalletHolding.strategyNavIdleOnly.
//   config    — off-chain size from config * price (SP500; no derivatives API).
// USDC carries priceKind 'usdc' (pinned $1); crypto legs 'gecko'; SP500 'yahoo'.
export type ValuationKind = "erc20" | "native" | "aave" | "strategy" | "config";
export type PriceKind = "usdc" | "gecko" | "yahoo";
export interface TrackedAsset {
  symbol: string;
  group: "Stable" | "Protocol" | "Agent" | "Stocks";
  color: string;
  valuationKind: ValuationKind;
  priceKind: PriceKind;
  decimals: number;
  // Token / strategy contract on Base (null for native ETH and the config SP500).
  address: string | null;
  // GeckoTerminal pool id for the live OHLCV/price read (Open Question 4 — the
  // authoritative pool is owner data; the stub price path never uses it).
  poolId: string | null;
  // ISO calendar day the asset was first tracked. The snapshot manifest uses
  // this so that a historical day is only expected to contain assets that were
  // live at the time — preventing stale-completeness infinite retry loops when
  // a new asset is added to the config after historical data was written.
  deployedAt: string;
}

// The eight fixed labelled series, in Stable → Protocol → Agent → Stocks
// group/colour order (must match the walletPerfView columns retired from
// alpine/views.js). Addresses default to documented Base tokens; each is
// overridable via <SYMBOL>_ADDRESS for the confirmed deployment.
export function resolveTrackedAssets(
  env: Record<string, string | undefined> = process.env,
): TrackedAsset[] {
  const addr = (key: string, fallback: string | null): string | null =>
    (env[key] || fallback)?.toLowerCase() ?? null;
  return [
    { symbol: "USDC", group: "Stable", color: "#10b981", valuationKind: "erc20", priceKind: "usdc",
      decimals: 6, address: addr("USDC_ADDRESS", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"), poolId: null,
      deployedAt: "2026-03-18" },
    // These addresses are the agent's delegated smart-account WALLETS on Base
    // (ZyfAI Safe / Giza Kernel account, source of truth: robotmoney-site),
    // proven by on-chain investigation (#120) — NOT ERC-4626 share tokens.
    // Valued at account NAV (see the `strategy` ValuationKind doc above), not a
    // $1-pegged share. Baked as defaults; override via <SYMBOL>_ADDRESS.
    { symbol: "ZYFAI-SS1", group: "Stable", color: "#10b981", valuationKind: "strategy", priceKind: "usdc",
      decimals: 18, address: addr("ZYFAI_SS1_ADDRESS", "0xC125200A1a5710af0D8711085F4407863158976D"), poolId: null,
      deployedAt: "2026-03-18" },
    { symbol: "GIZA-SS1", group: "Stable", color: "#10b981", valuationKind: "strategy", priceKind: "usdc",
      decimals: 18, address: addr("GIZA_SS1_ADDRESS", "0x8E5c5Ab532a2D3Cb6b1Dd159707b2A8588Cf8795"), poolId: null,
      deployedAt: "2026-03-18" },
    { symbol: "WETH", group: "Protocol", color: "#f59e0b", valuationKind: "erc20", priceKind: "gecko",
      decimals: 18, address: addr("WETH_ADDRESS", "0x4200000000000000000000000000000000000006"), poolId: env.WETH_POOL_ID || null,
      deployedAt: "2026-03-18" },
    // Native ETH: balance via eth_getBalance (the `native` kind ignores address),
    // but priced off WETH's address (canonical wrapped price) so `address` here
    // is the PRICING address, not a balanceOf target.
    { symbol: "ETH", group: "Protocol", color: "#f59e0b", valuationKind: "native", priceKind: "gecko",
      decimals: 18, address: addr("WETH_ADDRESS", "0x4200000000000000000000000000000000000006"), poolId: env.WETH_POOL_ID || null,
      deployedAt: "2026-03-18" },
    { symbol: "ROBOTMONEY", group: "Agent", color: "#3b82f6", valuationKind: "erc20", priceKind: "gecko",
      decimals: 18, address: addr("ROBOTMONEY_ADDRESS", "0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3"), poolId: env.ROBOTMONEY_POOL_ID || null,
      deployedAt: "2026-03-18" },
    // BNKR ("BankrCoin") real Base address, confirmed (issue #148) against the
    // live GeckoTerminal API: /networks/base/tokens/0x22af33...c76f3b resolves
    // name "BankrCoin"/symbol "BNKR" with an active USD price, and the primary
    // prop wallet (resolvePropWallets()[0]) holds a non-zero balanceOf it on
    // Base mainnet. The PRIOR default (0x7777...7777, a repeating-hex-digit
    // placeholder sentinel — see isPlaceholderAddress above) was never a real
    // token contract, so GeckoTerminal legitimately had no USD price for it;
    // that was not a lookup-endpoint bug, just a stale placeholder address left
    // over from before the real address was confirmed. Override via
    // BNKR_ADDRESS for a re-pointed deployment.
    { symbol: "BNKR", group: "Agent", color: "#3b82f6", valuationKind: "erc20", priceKind: "gecko",
      decimals: 18, address: addr("BNKR_ADDRESS", "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b"), poolId: env.BNKR_POOL_ID || null,
      deployedAt: "2026-03-18" },
    // SP500 is config-valued (no on-chain contract). Added to tracking ~May 2026;
    // historical days before this date have no SP500 row and are complete without it.
    { symbol: "SP500", group: "Stocks", color: "#8b5cf6", valuationKind: "config", priceKind: "yahoo",
      decimals: 0, address: null, poolId: null,
      deployedAt: "2026-05-01" },
    // Optional Aave V3 aToken legs — EMPTY by default (Open Q6, owner data). Each
    // configured aToken adds a holding valued by balanceOf → underlying × price.
    // Not part of the fixed 8 chart series unless an operator opts in.
    ...resolveAaveATokens(env),
  ];
}

// Aave V3 aToken legs, config-driven so the exact set stays owner-controlled
// (Open Q6). Default empty. Currently supports aUSDC via AAVE_AUSDC_ADDRESS
// (underlying USDC, 6 dp, pinned $1); extend as the confirmed set lands.
export function resolveAaveATokens(
  env: Record<string, string | undefined> = process.env,
): TrackedAsset[] {
  const out: TrackedAsset[] = [];
  if (env.AAVE_AUSDC_ADDRESS) {
    out.push({
      symbol: "aUSDC", group: "Stable", color: "#10b981", valuationKind: "aave", priceKind: "usdc",
      decimals: 6, address: env.AAVE_AUSDC_ADDRESS.toLowerCase(), poolId: null,
      deployedAt: "2026-03-18",
    });
  }
  return out;
}

// --- Strategy smart-account NAV positions (issues #120/#145, corrected by #642)
// ZYFAI-SS1 / GIZA-SS1 are proven smart-account WALLETS (a Gnosis Safe and a
// ZeroDev Kernel account, not ERC-20/ERC-4626 share tokens — balanceOf on the
// account itself always reverts, permanently). Each leg is valued as account
// NAV = idle USDC(account) + Σ over the positions below, all 6 dp USDC,
// reported as plain `live` like every other kind (#145: no distinct provenance
// value for these legs).
//
// WHAT #642 CORRECTED. This block previously said the list had to be
// owner-maintained through five STRATEGY_VAULT_*_ADDRESS env keys because "the
// agent rotates vaults every 1-2 days per the #120 investigation". BOTH halves
// of that sentence were false, and it is worth being precise about how a false
// statement came to be written as settled fact:
//
//   - #120 established no such thing. Its finding was that both addresses
//     revert on balanceOf, and its stated deliverable — owner confirmation of
//     the correct valuation — never arrived.
//   - The rotation claim originates as the auto-loop's own DEFAULT RATIONALE in
//     decision issue #145, whose checkboxes were never ticked. It was
//     auto-applied at the 7-day timeout, then written into this comment citing
//     #120 as its source. Nothing anywhere verified it.
//   - The env-list mechanism it justified could not work regardless: no compose
//     `environment:` block named any of the five keys, and that block is the
//     only delivery path (no `env_file:`, no Dockerfile `ENV`), so the list was
//     unconditionally empty in every containerized deployment.
//
// VERIFIED ON-CHAIN (Base mainnet, 2026-08-16) — these facts replace the claim:
//
//   - ZYFAI-SS1 (0xC125…976D) holds 0.000044 USDC plus airdrop spam (AGENT,
//     SHOPEE, OCTA) and NO vault position of any kind.
//   - GIZA-SS1 (0x8E5c…8795) holds gtUSDCp, steakUSDC, aBasUSDC and cUSDCv3
//     SIMULTANEOUSLY — a portfolio, not a rotation — all of it dust
//     (convertToAssets returns 0 for both ERC-4626 legs).
//
// So the addresses are stable, on-chain-verifiable facts, and they are baked
// here as constants — the same treatment resolveRobotmoneyToken()/resolveWeth()
// below already give their addresses. The set stays an ALLOWLIST rather than an
// on-chain "value everything this account holds" scan precisely because of the
// spam: a naive scan would price airdropped tokens into the fund's NAV.
export interface StrategyVaultConfig {
  symbol: string; // e.g. "gtUSDCp" — the observed vault-share label, not a chart series
  address: string; // ERC-4626 vault contract on Base (lowercased)
}

// ERC-4626 vault shares ONLY. Every address here is read as
// convertToAssets(balanceOf(account)), so every address here MUST implement
// ERC-4626 — verified on Base mainnet 2026-08-16: both return decimals() = 18
// and asset() = USDC (0x8335…2913). An address that does not implement it
// reverts the sub-call and degrades the WHOLE leg to 'stale' (see
// chain/wallet-valuation.ts), which is exactly the #120 failure this issue
// exists to fix — hence the split from STRATEGY_UNDERLYING_POSITIONS below and
// the guard test in backend/tests/api/wallet-balances.test.ts.
const STRATEGY_VAULTS: StrategyVaultConfig[] = [
  { symbol: "gtUSDCp", address: "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61" },
  { symbol: "steakUSDC", address: "0xbeefe94c8ad530842bfe7d8b397938ffc1cb83b2" },
];
export function resolveStrategyVaults(): StrategyVaultConfig[] {
  return STRATEGY_VAULTS.map((v) => ({ ...v }));
}

// Positions whose balanceOf is ALREADY denominated in the underlying asset, so
// they are summed directly and MUST NOT be sent through convertToAssets.
//
// aBasUSDC is Aave V3's Base USDC aToken: decimals() = 6 and asset() REVERTS
// (verified 2026-08-16). aTokens rebase 1:1 with the underlying, which is the
// same valuation rule `valuationKind: "aave"` / resolveAaveATokens already
// applies to a prop-wallet aToken leg — this is that rule, applied to a
// position held by the smart ACCOUNT rather than by a prop wallet.
//
// Why not a prop-wallet aave leg via resolveAaveATokens: that would surface the
// position as its OWN top-level series, splitting one account's NAV across two
// chart lines and turning the eight fixed labelled series into nine (a shape
// asserted in frontend/test/browser/performance-view.spec.ts and the
// WalletBalances DTO). GIZA-SS1's aToken balance is part of GIZA-SS1's NAV, so
// it belongs inside that leg. See docs/decisions.md D37.
//
// cUSDCv3 (0xb125e6687d4313864e53df431d5425969c15eb2f) is deliberately ABSENT
// from both lists — see D37. It is a Compound III Comet, not ERC-4626
// (decimals() = 6, asset() reverts), so it cannot go above; and its Comet
// balance accounting was not verified on-chain, so adding it here would be
// inventing a valuation rather than applying a checked one. The position is
// dust, so the cost of excluding it is ~$0 and the cost of guessing is a wrong
// number in the fund's NAV.
export interface StrategyUnderlyingPositionConfig {
  symbol: string;
  address: string; // token whose balanceOf(account) IS the underlying amount (6 dp USDC)
}
const STRATEGY_UNDERLYING_POSITIONS: StrategyUnderlyingPositionConfig[] = [
  { symbol: "aBasUSDC", address: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab" },
];
export function resolveStrategyUnderlyingPositions(): StrategyUnderlyingPositionConfig[] {
  return STRATEGY_UNDERLYING_POSITIONS.map((p) => ({ ...p }));
}

// An EMPTY position list is a loud boot-time WARNING, never a refusal to boot
// (issue #642, decision D37). The sibling guard assertNoVaultAddressCollision()
// throws because a collision produces a DOUBLE-COUNTED number — arithmetically
// wrong, and there is no honest way to serve it. An empty list is a different
// failure: idle-USDC-only NAV is a real, non-reverting read of the account,
// only incomplete. Refusing to boot on it would take the api — which also
// serves the whole static frontend, per D29 — down for a condition the site
// survived from launch, and would take the WORKER lanes down with it, stopping
// every unrelated pipeline.
//
// The lists are baked constants now, so this cannot fire from a missing env
// var; it fires if the constants above are ever emptied (a code change), which
// is precisely when a silent regression to idle-USDC-only would otherwise ship
// unnoticed. Runtime emptiness — an account that holds none of these positions,
// which is ZYFAI-SS1's real state — is disclosed per-leg instead, on the wire,
// as WalletHolding.strategyNavIdleOnly.
//
// Returns the warning line (also logged) when a `strategy` asset is tracked
// with no position configured, null otherwise — the return value is what makes
// this assertable in a test instead of only observable by eye.
export function warnIfStrategyVaultsUnconfigured(
  env: Record<string, string | undefined> = process.env,
  log: (message: string) => void = console.warn,
  positionCount: number = resolveStrategyVaults().length + resolveStrategyUnderlyingPositions().length,
): string | null {
  const strategySymbols = resolveTrackedAssets(env)
    .filter((a) => a.valuationKind === "strategy")
    .map((a) => a.symbol);
  if (strategySymbols.length === 0) return null;
  if (positionCount > 0) return null;
  const message =
    `strategy NAV: no vault or underlying position configured — ${strategySymbols.join(", ")} NAV is ` +
    "idle-USDC-only and OMITS every deployed position (issues #120/#145/#642). " +
    "Restore STRATEGY_VAULTS / STRATEGY_UNDERLYING_POSITIONS in backend/src/config.ts.";
  log(message);
  return message;
}

// SP500 position size + ticker (Open Question 3 — owner data; size comes from
// here because there is no derivatives-venue positions API). ^GSPC is the index
// the baked series tracked.
//
// COMMITTED CONSTANTS, NOT ENV (issue #641). `SP500_SIZE` and `SP500_TICKER`
// used to be env overrides, which is the worst of both worlds: neither key is in
// docker-compose.yml's `environment:` block, and that block is an ALLOWLIST (no
// compose file has an `env_file:` and backend/Dockerfile sets no ENV), so no
// deployed container could ever receive them — while the code kept claiming they
// were operator-settable. They follow the same rule as the addresses below
// (ROBOTMONEY_ADDRESS/WETH_ADDRESS/BUYBACK_PRIMARY_WALLET were baked for the same
// reason): the allowlist is reserved for SECRETS and OPERATOR ESCAPE HATCHES, and
// this is neither.
//
// The ticker is immutable — ^GSPC is what this leg IS. The size is not: it is
// mutable owner data, and nothing detects that it has gone stale (see the
// decision recorded at chain/wallet-balances.ts's `config` leg). As a committed
// constant its staleness is at least VISIBLE — it changes under review in a pull
// request, with a diff and a date, instead of drifting invisibly inside one
// droplet's environment where no reader of this repo could see it.
export const SP500_SIZE = 0.6330; // contracts held; owner-stated, last set 2026-03
export const SP500_TICKER = "^GSPC";

// --- ROBOTMONEY token / WETH / buyback feed ----------------------------------
// Exposed to the token-metrics + token-buyback dashboards (and any other module)
// so the real Base addresses live in ONE place. All baked as real defaults so a
// smoke with only DATABASE_URL set produces real reads; each is env-overridable.

// The ROBOTMONEY governance/reward ERC-20 on Base (source of truth:
// robotmoney-site). Backs token-metrics (totalSupply/price/marketCap) and is the
// Transfer-event source for the buyback feed.
export function resolveRobotmoneyToken(
  env: Record<string, string | undefined> = process.env,
): string {
  return (env.ROBOTMONEY_ADDRESS || "0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3").toLowerCase();
}

// WETH on Base — the buyback swap INPUT leg and the Protocol tracked asset. The
// GeckoTerminal pool id is optional owner data for the live price read.
export function resolveWeth(
  env: Record<string, string | undefined> = process.env,
): { address: string; poolId: string | null } {
  return {
    address: (env.WETH_ADDRESS || "0x4200000000000000000000000000000000000006").toLowerCase(),
    poolId: env.WETH_POOL_ID || null,
  };
}

// Buyback feed config (token-buyback dashboard). Buybacks are ROBOTMONEY
// transfers INTO the primary prop wallet (WETH → ROBOTMONEY swaps; source of
// truth: robotmoney-site wallet.ts fetchBuybackTransactions). `source` mirrors
// BASE_RPC_SOURCE so the hermetic smoke/CI (BASE_RPC_SOURCE=stub) never reaches a
// live log indexer and a stub payload is never labelled live (#50).
export interface BuybackConfig {
  primaryWallet: string; // buyback destination (receives ROBOTMONEY)
  robotmoneyToken: string; // ROBOTMONEY ERC-20 (Transfer event `to` filter)
  wethToken: string; // WETH ERC-20 (swap input leg)
  source: BaseRpcSource; // 'live' = eth_getLogs vs Base RPC; 'stub' = hermetic fixture
  fromBlock: number; // first Base block the live indexer scans (see BUYBACK_FROM_BLOCK)
}

// The block the buyback era began on Base — an IMMUTABLE MAINNET FACT, identical
// in smoke, stage and prod, so it is a committed constant with NO env override
// (#640), the same treatment ROBOTMONEY_ADDRESS / WETH_ADDRESS /
// BUYBACK_PRIMARY_WALLET already get above: a baked real default, absent from
// docker-compose.yml's `environment:` allowlist, which is reserved for secrets
// and operator escape hatches. 43,741,600 is the block of the earliest buyback
// swap in the seed set (tx 0xa19a0866…ffa37, migrations/0015_buyback_swaps.sql;
// eth_getTransactionByHash returns blockNumber 0x29b71a0, blockTimestamp
// 0x69c14023 = 2026-03-23). There is no testnet deployment for this feed, so
// nothing legitimately varies it per environment.
//
// Why this is not an env read defaulting to 0: the indexer is bounded at
// BUYBACK_MAX_CHUNKS × BUYBACK_LOG_CHUNK blocks per run against Base's ~43,200
// blocks/day, so crawling from block 0 takes ~51 days of empty eth_getLogs calls
// before the scan reaches the first buyback — 51 days of a live feed serving only
// the seed rows. Deleting the read also removes, BY CONSTRUCTION, the NaN hazard
// the old `Number(process.env.BUYBACK_FROM_BLOCK ?? "0")` carried: a value that
// cannot be supplied cannot be malformed.
export const BUYBACK_FROM_BLOCK = 43_741_600;

// The deepest Base WETH/USDC pool (~$111M reserve), used ONLY to read HISTORICAL
// daily WETH/USD candles when the buyback indexer prices a swap at its own block
// time (chain/token-prices.ts fetchGeckoDailyCloseUsd). Baked like every other
// Base-mainnet fact above; the optional per-asset `poolId` knobs are unrelated
// owner data for a spot read that does not use them.
export const WETH_USDC_POOL = "0x6c561b446416e1a00e8e93e221854d6ea4171372";

// Which pool a gecko-priced token's HISTORICAL daily candles are read from
// (chain/historical-prices.ts), keyed by the token's lowercase Base address.
//
// The alternative — and still the fallback for anything absent here — is to ask
// GeckoTerminal for every pool containing the token and take the one with the
// most 24h volume. That ranking is a live measurement, so it is not stable: for
// WETH on Base the top two pools trade places between runs ("WETH / USDC 0.3%"
// against "cbBTC / WETH 0.05%"), which makes the pool a backfill reads from a
// property of the hour it ran in rather than of the config it ran with. Two runs
// over the same day then disagree about which pool is authoritative, and neither
// disagreement is visible in what they write. Pinning removes the measurement
// from the decision: the same token reads the same pool on every host, every run.
//
// An unpinned token falling back to that ranking is tolerable only because the
// request now names the token and the response is checked against the base side
// the vendor reports for it, so a pool the ranking picks whose sides are the
// wrong way round yields a REFUSAL, not a plausible-looking number denominated
// in the other token. Availability is what a pin buys; correctness is enforced at
// the request either way. Never add an entry here that has not been read off the
// live pool: an address mistyped into a DIFFERENT pool that happens to hold the
// same base token answers the orientation check truthfully and still prices the
// token off a market nobody chose, which is the one wrong entry that check cannot
// catch.
//
// WETH's entry doubles as native ETH's: ETH carries WETH's address as its
// PRICING address (resolveTrackedAssets above), so both resolve through this one
// key. A deployment that re-points WETH_ADDRESS falls off the pin by design and
// back onto the ranking — the pin is a claim about one specific pair of Base
// mainnet addresses, and it must not be silently reused for a different token.
export const PINNED_GECKO_POOLS: Readonly<Record<string, string>> = Object.freeze({
  "0x4200000000000000000000000000000000000006": WETH_USDC_POOL, // WETH → "WETH / USDC 0.3%", WETH is the base side
});

// Null means "no pin for this token" — the caller is expected to fall back to
// volume-ranked discovery and say so in its logs, so an unpinned asset is a line
// an operator can find rather than an invisible default.
export function pinnedPoolForToken(tokenAddress: string): string | null {
  return PINNED_GECKO_POOLS[tokenAddress.toLowerCase()] ?? null;
}

export function resolveBuybackConfig(
  env: Record<string, string | undefined> = process.env,
): BuybackConfig {
  const wallets = resolvePropWallets(env);
  return {
    primaryWallet: (env.BUYBACK_PRIMARY_WALLET || wallets[0] || "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6").toLowerCase(),
    robotmoneyToken: resolveRobotmoneyToken(env),
    wethToken: resolveWeth(env).address,
    source: resolveBaseRpcSource(env),
    fromBlock: BUYBACK_FROM_BLOCK,
  };
}

// Per-run bounds of the live buyback log scan (chain/buyback-logs.ts): the
// eth_getLogs window size and how many of those windows a single run may walk.
//
// COMMITTED CONSTANTS, NOT ENV (issue #641), for the same reason as the SP500
// pair above: `BUYBACK_LOG_CHUNK`/`BUYBACK_MAX_CHUNKS` were env overrides that no
// deployed container could ever receive, because docker-compose.yml's
// `environment:` block is an allowlist and neither key is in it. A knob that
// nothing can turn is not configuration; it is a constant with a misleading
// spelling.
//
// WHY 9000. `eth_getLogs` is range-capped by the provider, and 10,000 blocks is
// the cap the common public endpoints impose (including https://mainnet.base.org,
// the BASE_RPC_URL default). 9000 sits under it with margin rather than at it, so
// an off-by-one in the inclusive `[from, from + chunk - 1]` window below can
// never turn a working scan into a provider-side range error. THIS IS THE NUMBER
// TO REVISIT — and the only one — if BASE_RPC_URL is ever re-pointed at a
// provider with a different cap: lower it to that provider's cap minus a similar
// margin. MAX_CHUNKS bounds one run's wall-clock and RPC spend; the persisted
// scan cursor (buyback_scan_state) carries progress across runs, so a lower value
// costs catch-up latency, never coverage.
export const BUYBACK_LOG_CHUNK = 9000;
export const BUYBACK_MAX_CHUNKS = 25;

// Config-time double-count guard (AC): a prop wallet must never be the vault or
// an adapter address (their shares are valued by chain/vault-economics.ts — the
// OTHER half of Total AUM), and no tracked asset may be the rmUSDC vault share.
// Throws at startup so a misconfiguration that would double-count TVL can never
// serve a live-looking number. Called from the API + worker boot.
export function assertNoVaultAddressCollision(
  env: Record<string, string | undefined> = process.env,
): void {
  const vaultSet = new Set(
    [config.vault.address, config.vault.usdc, ...resolveVaultAdapters(env).map((a) => a.address)]
      .map((a) => a.toLowerCase()),
  );
  for (const w of resolvePropWallets(env)) {
    if (vaultSet.has(w)) {
      throw new Error(`prop-wallet address ${w} collides with the vault/adapter set — would double-count vault TVL`);
    }
  }
  for (const t of resolveTrackedAssets(env)) {
    if (t.address && t.address === config.vault.address.toLowerCase()) {
      throw new Error(`tracked asset ${t.symbol} is the rmUSDC vault share (${t.address}) — never track vault shares here`);
    }
  }
}

// --- Swarm session-lifecycle cron cadence (issue #208) -------------------
// The five swarm.* job_schedules rows (open_session/publish_brief/
// close_window/aggregate/publish) ship seed-time DISABLED by default so a
// fresh CI/e2e/smoke database never auto-enqueues real swarm lifecycle jobs
// alongside the smoke's own explicit enqueue-job admin path.
// SWARM_SCHEDULES_ENABLED is the single switch that turns the WHOLE
// managed sequence on for a deployment: production sets it explicitly (daily
// 06:00-08:00 UTC — see the per-kind CRON defaults below); staging may set the
// same flag with accelerated SWARM_*_CRON overrides; repo smoke/e2e never
// sets it (docker-compose.smoke.yml pins it off). Resolved once at seed-time
// (backend/src/db/seed.ts) — job_schedules
// rows are the persisted source of truth thereafter; the scheduler
// (worker/scheduler.ts) owns next_run_at/last_enqueued_at bookkeeping.
export interface SwarmScheduleConfig {
  kind: string;
  cron: string;
  enabled: boolean;
  payload: Record<string, unknown>;
  timezone: string;
}

// Fail-closed cron validation (review-operations finding on issue #208): every
// job_schedules row is ticked by ONE shared scheduler (worker/scheduler.ts
// tickScheduler) that evaluates ALL due rows inside a SINGLE transaction/loop —
// an unparseable cron on any one row throws mid-loop and rolls back the whole
// tick, silently stalling every OTHER schedule too (vault sampling, wallet
// balances, buybacks, projects pipelines, analytics), repeatedly, every tick,
// until fixed. Before this env-configurability landed, the five swarm.*
// crons were fixed literals that could never be wrong; now an operator typo
// in SWARM_*_CRON is user-reachable. Validate at config-resolution time
// (seed-time) so a bad value fails the `bun run migrate` deploy step loudly,
// instead of degrading the shared scheduler at runtime.
function assertValidCron(envVarName: string, cron: string): void {
  try {
    parser.parseExpression(cron);
  } catch (e) {
    throw new Error(`invalid ${envVarName} "${cron}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function resolveSwarmSchedules(
  env: Record<string, string | undefined> = process.env,
): SwarmScheduleConfig[] {
  const enabled = env.SWARM_SCHEDULES_ENABLED === "1" || env.SWARM_SCHEDULES_ENABLED === "true";
  const windowMinutesRaw = Number(env.SWARM_WINDOW_MINUTES ?? "");
  const windowMinutes = Number.isFinite(windowMinutesRaw) && windowMinutesRaw > 0 ? windowMinutesRaw : 60;
  const timezone = "UTC";
  const cronVars: Record<string, string> = {
    SWARM_OPEN_SESSION_CRON: env.SWARM_OPEN_SESSION_CRON || "0 6 * * *",
    SWARM_PUBLISH_BRIEF_CRON: env.SWARM_PUBLISH_BRIEF_CRON || "0 7 * * *",
    SWARM_CLOSE_WINDOW_CRON: env.SWARM_CLOSE_WINDOW_CRON || "0 8 * * *",
    SWARM_AGGREGATE_CRON: env.SWARM_AGGREGATE_CRON || "0 9 * * *",
    SWARM_PUBLISH_CRON: env.SWARM_PUBLISH_CRON || "0 10 * * *",
  };
  for (const [name, cron] of Object.entries(cronVars)) assertValidCron(name, cron);
  return [
    { kind: "swarm.open_session", cron: cronVars.SWARM_OPEN_SESSION_CRON, enabled, payload: {}, timezone },
    // windowMinutes rides on the publish_brief job's payload — publishBrief()
    // reads it to compute window_closes_at, so SWARM_WINDOW_MINUTES is the
    // single knob that keeps the publish_brief -> close_window cron gap
    // (default 07:00 -> 08:00 = 60 minutes) coherent with the actual window.
    { kind: "swarm.publish_brief", cron: cronVars.SWARM_PUBLISH_BRIEF_CRON, enabled, payload: { windowMinutes }, timezone },
    { kind: "swarm.close_window", cron: cronVars.SWARM_CLOSE_WINDOW_CRON, enabled, payload: {}, timezone },
    { kind: "swarm.aggregate", cron: cronVars.SWARM_AGGREGATE_CRON, enabled, payload: {}, timezone },
    { kind: "swarm.publish", cron: cronVars.SWARM_PUBLISH_CRON, enabled, payload: {}, timezone },
  ];
}

// --- Swarm public base URL ----------------------------------------------
// The absolute origin the swarm notification emails link back to. Every
// other surface in this codebase can get away with a root-relative path because
// it renders inside a browser that already has an origin; an email does not. It
// is read in a mail client, so a link that is not absolute is not a link at all.
// That matters more here than it looks: the application status page at
// /swarm/apply/<memberId> is reachable ONLY by its opaque id, nothing on the
// site links to it, and the operator is handed the URL exactly once by their own
// coding agent in a chat transcript. The email is the durable copy, so the URL
// inside it has to be complete and it has to point at the deployment the
// operator actually applied to (staging applicants must not be sent to
// production, where their member id does not exist).
//
// Defaults to the public production site: an unconfigured real deployment still
// emits a link that works for a real operator, which is the failure mode we can
// live with. Trailing slashes are stripped at resolution so every call site can
// concatenate a leading-slash path without minting "https://host//swarm/...".
// Resolved at module load like the other single-value knobs below; the swarm
// tests that need a different origin set the env before importing config.
//
// THIS DEFAULT IS THE EFFECTIVE PRODUCTION VALUE, not a placeholder.
// SWARM_PUBLIC_BASE_URL is named by NO compose file: not docker-compose.yml's
// api `environment:` allowlist, not docker-compose.smoke.yml's, not the
// x-worker-env anchor — and there is no `env_file:` anywhere and
// backend/Dockerfile sets no ENV, so the variable can never reach the
// container. It is also absent from scripts/lib/smoke-main.ts's
// DEMO_COMPOSE_PASSTHROUGH, so a `bun smoke` / `bun run smoke` operator cannot
// inject it either. Whatever is written here is what every swarm notification
// email links to. It is exported and pinned by
// backend/tests/swarm-public-base-url.test.ts precisely because the tests that
// exercise the emails assert against `config.swarmPublicBaseUrl` (the
// variable), which stays green no matter what this string says.
export const SWARM_PUBLIC_BASE_URL_DEFAULT = "https://robotmoney.network";

export function resolveSwarmPublicBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return (env.SWARM_PUBLIC_BASE_URL || SWARM_PUBLIC_BASE_URL_DEFAULT).replace(/\/+$/, "");
}

// --- Swarm notification sender (issue #322) ------------------------------
// Resolved the same call-time way as resolveSwarmPublicBaseUrl above rather
// than only baked into the `config` singleton below: applyMember's receipt is
// the one caller (domain.ts::sendApplicationReceipt) that must observe an
// unset sender WITHOUT throwing — every other notification path (activation,
// seat-open) is fine treating the frozen-at-load `config.swarmNotificationEmailFrom`
// as authoritative, since a real deployment's env does not change mid-process.
// A call-time resolver is what lets a test flip this one input per-call, in the
// same process, without reloading the config module.
export function resolveSwarmNotificationEmailFrom(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.SWARM_NOTIFICATION_EMAIL_FROM || null;
}

// Fail-closed: default to "prod" when RM_ENV is unset, and REFUSE to start on an
// unrecognized value (so a typo like "production" can never silently open the
// privileged surface). The unauthenticated convenience path is opt-in: it is
// allowed only in the "ephemeral" (CI/throwaway) env or with RM_ALLOW_INSECURE=1.
const VALID_ENVS = ["ephemeral", "smoke", "prod"] as const;
const RM_ENV = process.env.RM_ENV ?? "prod";
if (!(VALID_ENVS as readonly string[]).includes(RM_ENV)) {
  throw new Error(`invalid RM_ENV "${RM_ENV}" — expected one of ${VALID_ENVS.join(" | ")}`);
}

export const config = {
  env: RM_ENV as (typeof VALID_ENVS)[number],
  // Privileged endpoints (onboarding/admin/analytics) may run WITHOUT a token
  // only when this is true; otherwise the relevant token is required in every env.
  allowInsecure: process.env.RM_ALLOW_INSECURE === "1" || RM_ENV === "ephemeral",
  // Trust X-Forwarded-For for client-ip (rate limiting) only behind a known proxy.
  trustProxy: process.env.TRUST_PROXY === "1",
  databaseUrl: required("DATABASE_URL"),
  apiPort: Number(process.env.API_PORT ?? 8787),
  // If set, the API process also serves this static directory (the built
  // frontend) — a single-box deployment with no reverse proxy.
  staticDir: process.env.STATIC_DIR || null,
  // Origins allowed to call this API cross-origin (issue #871): a split-repo
  // frontend deployed as its own container is no longer same-origin, so it
  // needs CORS. Empty by default — the single-box same-origin deployment
  // (D11/D13) needs no CORS headers at all, and api.ts's withCors()/
  // corsPreflightResponse() are no-ops when a request's Origin isn't listed.
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  // Shared secret guarding privileged endpoints (member onboarding + admin
  // lifecycle). If set, callers must present it as `X-Admin-Token`. If unset,
  // those endpoints are allowed only outside prod (smoke/ephemeral convenience).
  adminToken: process.env.ADMIN_TOKEN || null,
  automationToken: process.env.AUTOMATION_TOKEN || null,
  // Credential for the analytics-provider role. Only this role may write the
  // regime via POST /api/swarm/regime. Presented as a Bearer token. If set,
  // it is required (every env); if unset, the role is allowed only outside prod
  // (smoke/ephemeral convenience), mirroring adminToken.
  analyticsToken: envSecret("ANALYTICS_TOKEN"),
  // Swarm activation email uses a durable outbox + swarm worker job.
  // The sender is persisted with the message; the deployment transport is an
  // HTTP email adapter invoked only by that worker (tests inject a fake).
  swarmNotificationEmailFrom: resolveSwarmNotificationEmailFrom(),
  swarmNotificationEmailTransportUrl: process.env.SWARM_NOTIFICATION_EMAIL_TRANSPORT_URL || null,
  swarmNotificationEmailTransportToken: process.env.SWARM_NOTIFICATION_EMAIL_TRANSPORT_TOKEN || null,
  // Origin every link inside those emails is built from (see the resolver above).
  swarmPublicBaseUrl: resolveSwarmPublicBaseUrl(),
  // NOTE: the analytics pipeline (analytics/index.ts runAnalytics) selects its
  // data source SOLELY via `ANALYTICS_SOURCE` (unset|live → real fetchers,
  // hermetic → seeded/offline) — see analytics/index.ts::resolveAnalyticsSource.
  // The legacy `PROVIDER` env knob and the config field it fed were removed
  // (review-maintainability-011): they had zero consumers.
  // --- Vault economics (live Base RPC read, issue #40) ---------------------
  // Base mainnet (chainId 8453) JSON-RPC endpoint used for the read-only
  // eth_call vault-economics pipeline (backend/src/chain). No API key required
  // for the public default; override for a private/rate-limited provider.
  baseRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  vault: {
    // RobotMoneyVault on Base, documented publicly at
    // frontend/public/views/docs/skill/installation.html and skill.html.
    // Normalized lowercase (issue #173): vault_share_price_history.vault_address
    // is a plain `text` column, so Postgres `=` is case-sensitive. Both the
    // hourly sampler's INSERT (worker/handlers/vault.ts) and every persisted
    // fallback read (chain/vault-economics.ts) key off this value, so
    // normalizing it once here — matching resolveRobotmoneyToken/resolveWeth's
    // existing `.toLowerCase()` precedent — keeps the writer and reader
    // identity-equal without a citext migration.
    address: (process.env.VAULT_ADDRESS || "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd").toLowerCase(),
    // USDC on Base, same doc pages.
    usdc: process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    // Load-time snapshot of the adapter set (see resolveVaultAdapters above,
    // which chain/vault-economics.ts calls per request so `configured` tracks
    // the live env). Placeholder (unconfigured) adapters are never eth_called
    // (issue #50), so a placeholder can never render as a live-looking $0.
    adapters: resolveVaultAdapters(),
  },
  // Load-time snapshots of the token/wallet/buyback config, exposed so other
  // modules (token-metrics, wallet-sleeves, buyback-logs dashboards) share one
  // source of truth. Resolvers above are still called per-request where
  // provenance/`configured` must track the live env.
  robotmoney: resolveRobotmoneyToken(),
  weth: resolveWeth(),
  propWallets: resolvePropWallets(),
  buyback: resolveBuybackConfig(),
};
