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
import { callAsset, callDecimals, callTotalAssets, type RpcCallOptions } from "../../chain/base-rpc-client.ts";
import type { CoinGeckoMarketRow, DexPayload } from "../transforms.ts";
import type { DiscoveredProject, Erc4626Read, ProjectsDataSource } from "./data-source.ts";
import { DISCOVERY_DATASET } from "../fixtures/dataset.ts";

const CG_BASE = "https://api.coingecko.com/api/v3";
const DEX_BASE = "https://api.dexscreener.com/latest/dex/tokens";

// Hard per-request timeout for every live provider fetch (mirrors the
// analytics extract/http.ts fetchJson/fetchText discipline). Without it a
// stalled — not errored — socket hangs the handler indefinitely and pins the
// worker slot while the reaper re-queues duplicate work; the abort turns that
// into a fast throw the degrade-to-persisted path already handles. 8s matches
// the extract helpers; overridable for tests / a slow private endpoint.
export function liveFetchTimeoutMs(): number {
  const raw = Number(process.env.LIVE_FETCH_TIMEOUT_MS ?? 8000);
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}

// fetch() with the hard timeout applied. AbortSignal.timeout rejects the fetch
// with a TimeoutError once the deadline passes, so a hung socket fails fast.
export async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(liveFetchTimeoutMs()) });
}

// Underlying tokens pinned to $1 (fetch-vault-data/index.ts) — everything else
// is priced via the best-liquidity DexScreener pair on the vault's chain.
const STABLES = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC base
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC eth
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT eth
]);

// Every Base read goes through chain/base-rpc-client.ts (the SINGLE JSON-RPC
// transport) so the vault-TVL cron inherits the #119 rate-limit machinery —
// concurrency gate, 429/Retry-After retry, User-Agent — instead of hand-rolling
// its own POST (maintainability finding 015). The hard per-request timeout is
// carried via RpcCallOptions.timeoutMs (same LIVE_FETCH_TIMEOUT_MS knob).
function baseRpcOpts(): RpcCallOptions {
  return { rpcUrl: config.baseRpcUrl, timeoutMs: liveFetchTimeoutMs() };
}

async function dexPriceUsd(chain: string, address: string): Promise<number> {
  const r = await timedFetch(`${DEX_BASE}/${address}`, { headers: { accept: "application/json" } });
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
    const r = await timedFetch(url, { headers });
    if (!r.ok) throw new Error(`coingecko markets ${r.status}`);
    return (await r.json()) as CoinGeckoMarketRow[];
  },

  async dexScreenerToken(address: string): Promise<DexPayload> {
    const r = await timedFetch(`${DEX_BASE}/${address}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`dexscreener ${r.status}`);
    return (await r.json()) as DexPayload;
  },

  async vaultErc4626Read(vaultAddress: string, chain: string): Promise<Erc4626Read> {
    const opts = baseRpcOpts();
    const totalAssets = await callTotalAssets(vaultAddress, opts);
    const assetAddr = await callAsset(vaultAddress, opts); // throws on empty (no-code address) → degrade
    // decimals() decoding to 0/garbage falls back to 18 (legacy edge-fn semantics).
    const decimals = (await callDecimals(assetAddr, opts)) || 18;
    const assetPriceUsd = STABLES.has(assetAddr.toLowerCase()) ? 1 : await dexPriceUsd(chain, assetAddr);
    return { totalAssetsRaw: totalAssets.toString(), decimals, assetPriceUsd };
  },

  async walletBalanceUsd(): Promise<number> {
    // The legacy refresh-wallet-balances Alchemy port (token balances × prices)
    // is a tracked follow-up; live wallet-balance refresh is not yet wired, so
    // the handler degrades to the last-persisted balance (loud log) until then.
    throw new Error("live wallet-balance provider not yet ported (Alchemy) — deferred");
  },
};
