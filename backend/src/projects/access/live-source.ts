// Live projects data source — hits the real providers the legacy edge functions
// used: CoinGecko /coins/markets (refresh-lobster-coins), DexScreener /tokens
// (refresh-lobster-coins + sync-agent-revenue-virtuals), and the Base JSON-RPC
// ERC-4626 read (fetch-vault-data). Selected ONLY when a deployer sets
// PROJECTS_SOURCE=live; NEVER on the per-PR graph (hermeticity AC). Its drift is
// swept nightly by tests/projects-fetchers-live.test.ts (nightly-fetchers.yml).
//
// The curated ecosystem roster is the discovery seed (identity + facet keys);
// the volatile metrics (market cap / FDV / 24h / revenue / TVL) are all fetched
// live here. Fully-autonomous multi-source discovery (the legacy 1963-line
// discover-agents crawler) is a tracked follow-up — see the issue open_questions.
import { config } from "../../config.ts";
import type { CoinGeckoMarketRow, DexPayload } from "../transforms.ts";
import type { DiscoveredProject, Erc4626Read, ProjectsDataSource } from "./data-source.ts";
import { DISCOVERY_DATASET } from "../fixtures/dataset.ts";

const CG_BASE = "https://api.coingecko.com/api/v3";
const DEX_BASE = "https://api.dexscreener.com/latest/dex/tokens";

// ERC-20 / ERC-4626 selectors (fetch-vault-data/index.ts).
const SEL = { asset: "0x38d52e0f", totalAssets: "0x01e1d114", decimals: "0x313ce567" };
const STABLES = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC base
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC eth
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT eth
]);

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(config.baseRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  if (!r.ok) throw new Error(`base rpc ${r.status}`);
  const j = (await r.json()) as { result?: string; error?: unknown };
  if (!j.result || j.result === "0x") throw new Error(`eth_call ${data} empty result`);
  return j.result;
}

async function dexPriceUsd(chain: string, address: string): Promise<number> {
  const r = await fetch(`${DEX_BASE}/${address}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`dexscreener ${r.status}`);
  const j = (await r.json()) as DexPayload;
  const best = (j.pairs ?? [])
    .filter((p) => p.chainId === chain)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!best?.priceUsd) throw new Error(`no priced base pair for ${address}`);
  return parseFloat(best.priceUsd);
}

export const liveProjectsDataSource: ProjectsDataSource = {
  kind: "live",

  async discoverProjects(): Promise<DiscoveredProject[]> {
    return structuredClone(DISCOVERY_DATASET);
  },

  async coinGeckoMarkets(ids: string[]): Promise<CoinGeckoMarketRow[]> {
    if (ids.length === 0) return [];
    const key = process.env.COINGECKO_API_KEY || "";
    const url = `${CG_BASE}/coins/markets?vs_currency=usd&ids=${ids.join(",")}&per_page=250&page=1&sparkline=false&price_change_percentage=24h`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (key) headers["x-cg-demo-api-key"] = key;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`coingecko markets ${r.status}`);
    return (await r.json()) as CoinGeckoMarketRow[];
  },

  async dexScreenerToken(address: string): Promise<DexPayload> {
    const r = await fetch(`${DEX_BASE}/${address}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`dexscreener ${r.status}`);
    return (await r.json()) as DexPayload;
  },

  async vaultErc4626Read(vaultAddress: string, chain: string): Promise<Erc4626Read> {
    const totalAssetsRaw = await ethCall(vaultAddress, SEL.totalAssets);
    const assetRaw = await ethCall(vaultAddress, SEL.asset);
    const assetAddr = "0x" + assetRaw.slice(-40);
    const decRaw = await ethCall(assetAddr, SEL.decimals);
    const decimals = parseInt(decRaw, 16) || 18;
    const assetPriceUsd = STABLES.has(assetAddr.toLowerCase()) ? 1 : await dexPriceUsd(chain, assetAddr);
    return { totalAssetsRaw: BigInt(totalAssetsRaw).toString(), decimals, assetPriceUsd };
  },

  async walletBalanceUsd(): Promise<number> {
    // The legacy refresh-wallet-balances Alchemy port (token balances × prices)
    // is a tracked follow-up; live wallet-balance refresh is not yet wired, so
    // the handler degrades to the last-persisted balance (loud log) until then.
    throw new Error("live wallet-balance provider not yet ported (Alchemy) — deferred");
  },
};
