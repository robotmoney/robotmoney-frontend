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
  // Additive superset (issue #87): refreshed spot price + 24h volume from the
  // market-refresh pipeline (CoinGecko / DexScreener). Null until first refresh.
  priceUsd: number | null;
  volume24h: number | null;
  // Issue #346 (the D24 pattern applied to the coin facet): the real timestamp
  // of the last successful projects.refresh_coins sample for this row, and
  // whether it is older than the freshness budget (or has never been
  // refreshed). Never a boolean alone — a consumer can always see how old a
  // served value is.
  refreshedAt: string | null;
  stale: boolean;
}

export interface ProjectWallet {
  id: string;
  label: string;
  chain: string | null;
  balanceUsd: number | null;
  // Issue #346: the real timestamp of the last successful
  // projects.refresh_wallets sample for this wallet, and whether it is older
  // than the freshness budget (or has never been refreshed).
  refreshedAt: string | null;
  stale: boolean;
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
  // revenue30d intentionally removed (issue #346): no persisted, non-fabricated
  // revenue source exists for the directory as a whole (only a subset of
  // Virtuals-protocol agents have one) — the honest move is to drop the column
  // rather than serve a partly-real, partly-empty figure as if it were uniform.
  maxMarketCap: number;
  maxFdv: number;
  sparkline: number[]; // 30d primary-coin price series (chronological)
  // Additive superset (issue #87): new aggregates the ported pipelines produce.
  volume24h: number; // max 24h trading volume across the project's coins
  tvlUsd: number; // summed live TVL across the project's vaults (fetch-vault-data)
}

export interface ProjectsResponse {
  projects: Project[];
}

// Admin-managed overview write (issue #93): POST /api/projects/admin/:slug.
// Admin-authored free text ONLY — no AI/LLM enrichment. At least one field must
// be present; omitted fields are left untouched.
export interface ProjectOverviewUpdateRequest {
  overview_short?: string;
  overview_long?: string;
  description?: string;
}

export interface ProjectOverviewUpdateResponse {
  project: {
    slug: string;
    overview_short: string | null;
    overview_long: string | null;
    description: string | null;
  };
}
