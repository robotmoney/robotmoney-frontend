// Projects directory API DTOs (issue #70). The /api/projects endpoint returns the
// aggregated "Agentic Economy Ecosystem" directory: one row per project with its
// facet coverage, coin/wallet detail, trailing revenue, and a 30d price sparkline.

export interface ProjectCoin {
  id: string;
  ticker: string | null;
  name: string;
  marketCap: number | null;
  fdv: number | null;
  percentChange24h: number | null;
}

export interface ProjectWallet {
  id: string;
  label: string;
  chain: string | null;
  balanceUsd: number | null;
}

// Live-recomputed facet presence (agent / x402 / coin / wallet / vault), ignoring
// the stale has_* columns on the project row per the source Projects.tsx.
export interface ProjectFacets {
  agent: boolean;
  x402: boolean;
  coin: boolean;
  wallet: boolean;
  vault: boolean;
}

export interface Project {
  id: string;
  slug: string;
  displayName: string;
  logoUrl: string | null;
  description: string | null; // overview_short → description → overview_long
  websiteUrl: string | null;
  twitterHandle: string | null;
  dataCoverageScore: number | null;
  isSticky: boolean;
  facets: ProjectFacets;
  coins: ProjectCoin[];
  wallets: ProjectWallet[];
  walletTotalUsd: number;
  revenue30d: number;
  maxMarketCap: number;
  maxFdv: number;
  sparkline: number[]; // 30d primary-coin price series (chronological)
}

export interface ProjectsResponse {
  projects: Project[];
}
