// Projects pipeline data-source seam (issue #87). The worker handlers
// (worker/handlers/projects.ts) pull provider-shaped payloads through this
// interface and hand them to the pure transforms (projects/transforms.ts). Two
// implementations back it:
//   - fixtureProjectsDataSource (access/fixture-source.ts): serves vendored,
//     deterministic, NETWORK-FREE payloads. Selected under CI/tests/demo so the
//     per-PR suite is hermetic (no test opens a live socket).
//   - liveProjectsDataSource (access/live-source.ts): hits the real keyed/keyless
//     providers (CoinGecko, DexScreener, Base RPC). Selected ONLY when a deployer
//     opts in with PROJECTS_SOURCE=live; its drift is swept nightly, off the
//     per-PR graph (tests/projects-fetchers-live.test.ts + nightly-fetchers.yml).
import type { CoinGeckoMarketRow, DexPayload } from "../transforms.ts";

export interface DiscoveredAgent {
  name: string;
  protocol_standard: string;
  wallet_address?: string | null;
  virtuals_agent_id?: string | null;
  x402_score?: number | null;
  x402_txn_count?: number | null;
  x402_resources_count?: number | null;
  x402_volume_usd?: number | null;
  productivity_score?: number | null;
  source_confidence?: "high" | "medium" | "low" | null;
}

export interface DiscoveredCoin {
  name: string;
  ticker: string;
  coingecko_id?: string | null;
  contract_address?: string | null;
  chain?: string | null;
}

export interface DiscoveredWallet {
  label: string;
  chain: string;
  address: string;
}

export interface DiscoveredVault {
  name: string;
  vault_address?: string | null;
  chain?: string | null;
  strategy_type?: string | null; // erc4626 | lp
  protocol?: string | null;
  data_source?: string | null; // live | static
}

// A project + its facets as returned by the discovery bucket (discover-agents /
// discover-virtuals / discover-acp / discover-wallets, unified). Upserted on the
// project slug + each facet's natural key so discovery is idempotent.
export interface DiscoveredProject {
  slug: string;
  display_name: string;
  description: string | null;
  website_url: string | null;
  twitter_handle: string | null;
  logo_url: string | null;
  is_sticky: boolean;
  agents: DiscoveredAgent[];
  coins: DiscoveredCoin[];
  wallets: DiscoveredWallet[];
  vaults: DiscoveredVault[];
}

export interface Erc4626Read {
  totalAssetsRaw: string;
  decimals: number;
  assetPriceUsd: number;
}

export interface ProjectsDataSource {
  readonly kind: "fixture" | "live";
  // Discovery bucket: the ecosystem directory + facet identity rows.
  discoverProjects(): Promise<DiscoveredProject[]>;
  // The as-of time of the rows discoverProjects() just returned, when the
  // source actually knows it. The live source serves a COMMITTED roster whose
  // real capture time is recorded in its manifest; persisting those rows under
  // now() would report a frozen dataset as refreshed-within-the-hour on every
  // scheduled run, forever. Optional: a source with no meaningful as-of (the
  // hermetic fixture) omits it and the caller falls back to wall-clock now,
  // which for that source is the honest answer.
  discoveredAsOf?(): Promise<string | null>;
  // Market bucket: CoinGecko markets batch (listed coins) + DexScreener token
  // pairs (on-chain-only coins and Virtuals revenue).
  coinGeckoMarkets(ids: string[]): Promise<CoinGeckoMarketRow[]>;
  dexScreenerToken(address: string): Promise<DexPayload>;
  // Vault bucket: ERC-4626 totalAssets()/decimals + underlying USD price.
  vaultErc4626Read(vaultAddress: string, chain: string): Promise<Erc4626Read>;
  // Wallet bucket: summed USD balance for a tracked address.
  walletBalanceUsd(address: string, chain: string): Promise<number>;
}
