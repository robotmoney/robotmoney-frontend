// Central environment configuration. The only required input is DATABASE_URL.
// RM_ENV selects behavior hints (ephemeral | demo | prod) but the connection
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
// demo/CI path selects since issue #147 removed DEMO_HERMETIC and the
// hermetic demo/CI fixture stub entirely) or 'stub' (a deterministic fixture
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
// so a demo with only DATABASE_URL set reads real per-adapter TVL. Override any
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
// BASE_RPC_SOURCE=stub. The demo/CI path (issue #147) never selects 'stub' for
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
// real defaults so a demo with only DATABASE_URL set reads real wallet balances.
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
//   strategy  — smart-account NAV (issues #120/#145 — `address` is the AGENT'S
//               SMART-ACCOUNT WALLET itself, a Safe/Kernel account, NOT an
//               ERC-4626 share token; balanceOf on it always reverts): amount =
//               idleUsdc(account) + Σ over resolveStrategyVaults() of
//               convertToAssets(balanceOf(account)), all 6 dp USDC. Reported
//               plain 'live' like every other kind (owner decision: no distinct
//               provenance/badge despite the vault list's rotation-drift risk).
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
    // These addresses are the agent's delegated smart-account WALLETS on Base
    // (ZyfAI Safe / Giza Kernel account, source of truth: robotmoney-site),
    // proven by on-chain investigation (#120) — NOT ERC-4626 share tokens.
    // Valued at account NAV (see the `strategy` ValuationKind doc above), not a
    // $1-pegged share. Baked as defaults; override via <SYMBOL>_ADDRESS.
    { symbol: "ZYFAI-SS1", group: "Stable", color: "#10b981", valuationKind: "strategy", priceKind: "usdc",
      decimals: 18, address: addr("ZYFAI_SS1_ADDRESS", "0xC125200A1a5710af0D8711085F4407863158976D"), poolId: null },
    { symbol: "GIZA-SS1", group: "Stable", color: "#10b981", valuationKind: "strategy", priceKind: "usdc",
      decimals: 18, address: addr("GIZA_SS1_ADDRESS", "0x8E5c5Ab532a2D3Cb6b1Dd159707b2A8588Cf8795"), poolId: null },
    { symbol: "WETH", group: "Protocol", color: "#f59e0b", valuationKind: "erc20", priceKind: "gecko",
      decimals: 18, address: addr("WETH_ADDRESS", "0x4200000000000000000000000000000000000006"), poolId: env.WETH_POOL_ID || null },
    // Native ETH: balance via eth_getBalance (the `native` kind ignores address),
    // but priced off WETH's address (canonical wrapped price) so `address` here
    // is the PRICING address, not a balanceOf target.
    { symbol: "ETH", group: "Protocol", color: "#f59e0b", valuationKind: "native", priceKind: "gecko",
      decimals: 18, address: addr("WETH_ADDRESS", "0x4200000000000000000000000000000000000006"), poolId: env.WETH_POOL_ID || null },
    { symbol: "ROBOTMONEY", group: "Agent", color: "#3b82f6", valuationKind: "erc20", priceKind: "gecko",
      decimals: 18, address: addr("ROBOTMONEY_ADDRESS", "0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3"), poolId: env.ROBOTMONEY_POOL_ID || null },
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
      decimals: 18, address: addr("BNKR_ADDRESS", "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b"), poolId: env.BNKR_POOL_ID || null },
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

// --- Strategy smart-account NAV vault list (issues #120/#145) ---------------
// ZYFAI-SS1 / GIZA-SS1 are proven smart-account WALLETS (a Gnosis Safe and a
// ZeroDev Kernel account, not ERC-20/ERC-4626 share tokens — balanceOf on the
// account itself always reverts, permanently). The resolved decision (#145):
// value each leg as account NAV = idle USDC(account) + Σ over a MAINTAINED
// vault-share list of convertToAssets(balanceOf(account)), reported as plain
// `live` (not a distinct provenance — the owner explicitly declined a special
// value/badge despite the documented drift risk of the agent rotating to an
// unlisted vault). This mirrors resolveAaveATokens below: owner-maintained,
// EMPTY-safe by default, opt-in per vault via <SYMBOL>_VAULT_ADDRESS — NOT an
// on-chain discovery mechanism (the agent rotates vaults every 1-2 days per
// the #120 investigation, so a scanner would still need a maintained
// candidate list; see #120's research comment for the full rationale). With
// no vault configured, NAV degrades gracefully to idle-USDC-only (still a
// real, non-reverting live read of the account).
export interface StrategyVaultConfig {
  symbol: string; // e.g. "gtUSDCp" — the observed vault-share label, not a chart series
  address: string; // ERC-4626 vault contract on Base (lowercased)
}
const STRATEGY_VAULT_CANDIDATES: { symbol: string; envKey: string }[] = [
  { symbol: "gtUSDCp", envKey: "STRATEGY_VAULT_GTUSDCP_ADDRESS" },
  { symbol: "steakUSDC", envKey: "STRATEGY_VAULT_STEAKUSDC_ADDRESS" },
  { symbol: "cUSDCv3", envKey: "STRATEGY_VAULT_CUSDCV3_ADDRESS" },
  { symbol: "aBasUSDC", envKey: "STRATEGY_VAULT_ABASUSDC_ADDRESS" },
  { symbol: "CSHYUSDC", envKey: "STRATEGY_VAULT_CSHYUSDC_ADDRESS" },
];
export function resolveStrategyVaults(
  env: Record<string, string | undefined> = process.env,
): StrategyVaultConfig[] {
  const out: StrategyVaultConfig[] = [];
  for (const c of STRATEGY_VAULT_CANDIDATES) {
    const address = env[c.envKey];
    if (address) out.push({ symbol: c.symbol, address: address.toLowerCase() });
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

// --- ROBOTMONEY token / WETH / buyback feed ----------------------------------
// Exposed to the token-metrics + token-buyback dashboards (and any other module)
// so the real Base addresses live in ONE place. All baked as real defaults so a
// demo with only DATABASE_URL set produces real reads; each is env-overridable.

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
// BASE_RPC_SOURCE so the hermetic demo/CI (BASE_RPC_SOURCE=stub) never reaches a
// live log indexer and a stub payload is never labelled live (#50).
export interface BuybackConfig {
  primaryWallet: string; // buyback destination (receives ROBOTMONEY)
  robotmoneyToken: string; // ROBOTMONEY ERC-20 (Transfer event `to` filter)
  wethToken: string; // WETH ERC-20 (swap input leg)
  source: BaseRpcSource; // 'live' = eth_getLogs vs Base RPC; 'stub' = hermetic fixture
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

// --- Swarm session-lifecycle cron cadence (issue #208) -------------------
// The five swarm.* job_schedules rows (open_session/publish_brief/
// close_window/aggregate/publish) ship seed-time DISABLED by default so a
// fresh CI/e2e/demo database never auto-enqueues real swarm lifecycle jobs
// alongside the demo's own explicit enqueue-job admin path.
// SWARM_SCHEDULES_ENABLED is the single switch that turns the WHOLE
// managed sequence on for a deployment: production sets it explicitly (daily
// 06:00-08:00 UTC — see the per-kind CRON defaults below); staging may set the
// same flag with accelerated SWARM_*_CRON overrides; repo demo/e2e never
// sets it (docker-compose.demo.yml pins it off, matching the DEMO_MODE
// pattern). Resolved once at seed-time (backend/src/db/seed.ts) — job_schedules
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
export function resolveSwarmPublicBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return (env.SWARM_PUBLIC_BASE_URL || "https://robotmoney.net").replace(/\/+$/, "");
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
  // regime via POST /api/swarm/regime. Presented as a Bearer token. If set,
  // it is required (every env); if unset, the role is allowed only outside prod
  // (demo/ephemeral convenience), mirroring adminToken.
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
