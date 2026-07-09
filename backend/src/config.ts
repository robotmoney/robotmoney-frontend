// Central environment configuration. The only required input is DATABASE_URL.
// RM_ENV selects behavior hints (ephemeral | demo | prod) but the connection
// itself is always driven by DATABASE_URL so the same code runs everywhere.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

// --- Base RPC provenance (issue #50) ----------------------------------------
// The vault-economics DTO labels where its numbers came from: 'live' (a real
// Base JSON-RPC endpoint — the production default) or 'stub' (the hermetic
// demo/CI fixture stub, backend/tests/support/base-rpc-stub.ts). The hermetic
// demo layer (docker-compose.demo.yml under DEMO_HERMETIC=1) sets
// BASE_RPC_SOURCE=stub alongside pointing BASE_RPC_URL at the stub, so
// stub-served payloads are never presented as live chain data. Resolved at
// CALL time (not module load) by chain/vault-economics.ts so tests can flip
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

// --- Vault adapter set (issues #40/#50) --------------------------------------
// Decision (issue #40): adapter set comes from config, NOT on-chain discovery.
// The vault's three real adapter contract addresses are not published anywhere
// in this repo yet, so the defaults below are deliberately NON-FUNCTIONAL
// placeholders — override with the real deployed addresses via env once known.
// IMPORTANT: real overrides must be contract addresses; do NOT use low
// addresses like 0x0…01/02/03 — on Base (and most EVM chains) those alias the
// ecrecover/sha256/ripemd160 precompiles, which return real (garbage, for this
// use) output instead of erroring, silently producing an absurd
// fabricated-looking balance. The repeating-digit placeholder addresses below
// are verified empty accounts on Base mainnet.
//
// `configured` (issue #50) is true iff the address came from an env override:
// an adapter still at its placeholder is reported configured:false and is
// NEVER eth_called by chain/vault-economics.ts (its balanceUsd stays null), so
// a placeholder can never render as a live-looking $0. Resolved at CALL time
// so tests can flip the env per case.
export interface VaultAdapterConfig {
  name: string;
  address: string;
  configured: boolean;
}
export function resolveVaultAdapters(
  env: Record<string, string | undefined> = process.env,
): VaultAdapterConfig[] {
  return [
    {
      name: "Morpho",
      address: env.ADAPTER_MORPHO_ADDRESS || "0x1111111111111111111111111111111111111111",
      configured: Boolean(env.ADAPTER_MORPHO_ADDRESS),
    },
    {
      name: "Aave",
      address: env.ADAPTER_AAVE_ADDRESS || "0x2222222222222222222222222222222222222222",
      configured: Boolean(env.ADAPTER_AAVE_ADDRESS),
    },
    {
      name: "Compound",
      address: env.ADAPTER_COMPOUND_ADDRESS || "0x3333333333333333333333333333333333333333",
      configured: Boolean(env.ADAPTER_COMPOUND_ADDRESS),
    },
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
// hermetic fixtures in chain/token-prices.ts so a demo never reaches an
// uncontrolled rate-limited price host. When PRICE_SOURCE is unset it FOLLOWS
// the RPC source (BASE_RPC_SOURCE) — so the hermetic demo (BASE_RPC_SOURCE=stub,
// set by DEMO_HERMETIC=1) automatically serves stub prices with no extra env and
// no live network, while prod stays live. An explicit PRICE_SOURCE overrides.
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

// Canonical prop-wallet addresses on Base (Open Question 1 — candidates recovered
// from the legacy allocation port; override with the confirmed set via
// PROP_WALLET_ADDRESSES=comma,separated). These are the holders whose balances
// are summed per tracked asset. Base-only by design (#84 scope).
export function resolvePropWallets(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.PROP_WALLET_ADDRESSES;
  // Candidates recovered from the legacy allocation port (0xfbc2…c9d6 /
  // 0x422c…8eee / 0x8d0c…9442), padded to valid Base addresses; confirm/override
  // via PROP_WALLET_ADDRESSES once the canonical set is owner-confirmed (Open Q1).
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [
        "0xfbc200000000000000000000000000000000c9d6",
        "0x422c000000000000000000000000000000008eee",
        "0x8d0c000000000000000000000000000000009442",
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
//   strategy  — ERC-4626 share: convertToAssets(balanceOf(wallet)) → USDC (6 dp),
//               pinned $1 (yield-bearing: valued at NAV, NOT a $1-pegged share).
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
      decimals: 6, address: addr("USDC_ADDRESS", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"), poolId: null },
    // Strategy shares are yield-bearing (valued at NAV, NOT $1-pegged): the
    // documented addresses are owner data (Open Q2) — non-functional
    // repeating-digit placeholders until <SYMBOL>_ADDRESS overrides them,
    // mirroring resolveVaultAdapters()'s placeholder convention (#50).
    { symbol: "ZYFAI-SS1", group: "Stable", color: "#10b981", valuationKind: "strategy", priceKind: "usdc",
      decimals: 18, address: addr("ZYFAI_SS1_ADDRESS", "0x4444444444444444444444444444444444444444"), poolId: null },
    { symbol: "GIZA-SS1", group: "Stable", color: "#10b981", valuationKind: "strategy", priceKind: "usdc",
      decimals: 18, address: addr("GIZA_SS1_ADDRESS", "0x5555555555555555555555555555555555555555"), poolId: null },
    { symbol: "WETH", group: "Protocol", color: "#f59e0b", valuationKind: "erc20", priceKind: "gecko",
      decimals: 18, address: addr("WETH_ADDRESS", "0x4200000000000000000000000000000000000006"), poolId: env.WETH_POOL_ID || null },
    // Native ETH: balance via eth_getBalance (the `native` kind ignores address),
    // but priced off WETH's address (canonical wrapped price) so `address` here
    // is the PRICING address, not a balanceOf target.
    { symbol: "ETH", group: "Protocol", color: "#f59e0b", valuationKind: "native", priceKind: "gecko",
      decimals: 18, address: addr("WETH_ADDRESS", "0x4200000000000000000000000000000000000006"), poolId: env.WETH_POOL_ID || null },
    { symbol: "ROBOTMONEY", group: "Agent", color: "#3b82f6", valuationKind: "erc20", priceKind: "gecko",
      decimals: 18, address: addr("ROBOTMONEY_ADDRESS", "0x6666666666666666666666666666666666666666"), poolId: env.ROBOTMONEY_POOL_ID || null },
    { symbol: "BNKR", group: "Agent", color: "#3b82f6", valuationKind: "erc20", priceKind: "gecko",
      decimals: 18, address: addr("BNKR_ADDRESS", "0x7777777777777777777777777777777777777777"), poolId: env.BNKR_POOL_ID || null },
    { symbol: "SP500", group: "Stocks", color: "#8b5cf6", valuationKind: "config", priceKind: "yahoo",
      decimals: 0, address: null, poolId: null },
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
    });
  }
  return out;
}

// SP500 position size + ticker (Open Question 3 — owner data; size comes from
// config because there is no derivatives-venue positions API). Yahoo ticker
// defaults to ^GSPC (the index the baked series tracked).
export function resolveSp500(
  env: Record<string, string | undefined> = process.env,
): { size: number; ticker: string } {
  return {
    size: Number(env.SP500_SIZE ?? "0.6330"),
    ticker: env.SP500_TICKER || "^GSPC",
  };
}

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

// Fail-closed: default to "prod" when RM_ENV is unset, and REFUSE to start on an
// unrecognized value (so a typo like "production" can never silently open the
// privileged surface). The unauthenticated convenience path is opt-in: it is
// allowed only in the "ephemeral" (CI/throwaway) env or with RM_ALLOW_INSECURE=1.
const VALID_ENVS = ["ephemeral", "demo", "prod"] as const;
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
  workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  // Shared secret guarding privileged endpoints (member onboarding + admin
  // lifecycle). If set, callers must present it as `X-Admin-Token`. If unset,
  // those endpoints are allowed only outside prod (demo/ephemeral convenience).
  adminToken: process.env.ADMIN_TOKEN || null,
  // Credential for the analytics-provider role. Only this role may write the
  // regime via POST /api/committee/regime. Presented as a Bearer token. If set,
  // it is required (every env); if unset, the role is allowed only outside prod
  // (demo/ephemeral convenience), mirroring adminToken.
  analyticsToken: process.env.ANALYTICS_TOKEN || null,
  // DEPRECATED for orchestrator source selection — kept only for the retired
  // FetcherProvider test scaffolding (access/fetcher-provider.ts, tests/providers.test.ts).
  // The production/demo analytics pipeline (analytics/index.ts runAnalytics) selects its
  // data source SOLELY via `ANALYTICS_SOURCE` (unset|live → real fetchers, hermetic →
  // seeded/offline) — see analytics/index.ts::resolveAnalyticsSource. `PROVIDER` no
  // longer influences the live/demo data path; do NOT use it to opt a demo into real data.
  analyticsProvider: (process.env.PROVIDER === "live" ? "live" : "seeded") as "live" | "seeded",
  // --- Vault economics (live Base RPC read, issue #40) ---------------------
  // Base mainnet (chainId 8453) JSON-RPC endpoint used for the read-only
  // eth_call vault-economics pipeline (backend/src/chain). No API key required
  // for the public default; override for a private/rate-limited provider.
  baseRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  vault: {
    // RobotMoneyVault on Base, documented publicly at
    // frontend/public/views/docs/skill/installation.html and skill.html.
    address: process.env.VAULT_ADDRESS || "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd",
    // USDC on Base, same doc pages.
    usdc: process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    // Load-time snapshot of the adapter set (see resolveVaultAdapters above,
    // which chain/vault-economics.ts calls per request so `configured` tracks
    // the live env). Placeholder (unconfigured) adapters are never eth_called
    // (issue #50), so a placeholder can never render as a live-looking $0.
    adapters: resolveVaultAdapters(),
  },
};

