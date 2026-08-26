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
//
// The discovery seed itself (R11 follow-up —
// docs/audits/v0-v1-parity/R11-projects-supabase-audit.md, Verdict) is the REAL v0
// project/agent/coin/wallet/vault identity roster, committed at
// ../seed/v0-roster-data.json and loaded network-free via ../seed/roster-seed.ts.
// It is regenerated deliberately by an operator via
// `bun run projects-roster-seed:regenerate` (scripts/projects-roster-seed-
// regenerate.ts) — never implicitly here.
import { config, resolveBaseRpcSource, resolvePriceSource, resolveTrackedAssets } from "../../config.ts";
import {
  callDecimals,
  decodeUint256,
  encodeAssetCall,
  encodeTotalAssetsCall,
  multicall3Aggregate3,
  type RpcCallOptions,
} from "../../chain/base-rpc-client.ts";
import {
  persistedFallbackWalletPriceReader,
  readChainAmountsBatched,
  valueLeg,
  type KeyedAssetRead,
} from "../../chain/wallet-valuation.ts";
import type { CoinGeckoMarketRow, DexPayload } from "../transforms.ts";
import type { DiscoveredProject, Erc4626Read, ProjectsDataSource } from "./data-source.ts";
import { loadV0RosterWithManifest, type LoadedRosterSeed } from "../seed/roster-seed.ts";

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

// The committed artifact cannot change while this process runs, and the pair is
// ~30k lines, so parse+validate it once and serve both discoverProjects() and
// discoveredAsOf() from the SAME validated load — never two independent reads
// that could disagree. A rejection is not cached: a transient failure must be
// retryable on the next scheduled run.
let seedLoad: Promise<LoadedRosterSeed> | null = null;
function loadedSeed(): Promise<LoadedRosterSeed> {
  seedLoad ??= loadV0RosterWithManifest().catch((err) => {
    seedLoad = null;
    throw err;
  });
  return seedLoad;
}

export const liveProjectsDataSource: ProjectsDataSource = {
  kind: "live",

  async discoverProjects(): Promise<DiscoveredProject[]> {
    // Deep-clone so a handler mutating a record can never corrupt the seed
    // (same discipline as fixture-source.ts's discoverProjects).
    return structuredClone((await loadedSeed()).projects);
  },

  // The roster's REAL capture time, straight from the checksum-validated
  // manifest — what the discovery handler stamps onto the rows it persists
  // instead of now(). See ../seed/roster-seed.ts's loadV0RosterWithManifest.
  async discoveredAsOf(): Promise<string | null> {
    return (await loadedSeed()).manifest.generatedAt;
  },

  async coinGeckoMarkets(ids: string[]): Promise<CoinGeckoMarketRow[]> {
    if (ids.length === 0) return [];
    const key = process.env.COINGECKO_API_KEY || "";
    const url = `${CG_BASE}/coins/markets?vs_currency=usd&ids=${ids.join(",")}&per_page=250&page=1&sparkline=false&price_change_percentage=24h`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (key) headers["x-cg-smoke-api-key"] = key;
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
    // THREE POSTs → TWO. totalAssets() and asset() are independent, so they
    // share one Multicall3 call; decimals() genuinely depends on asset()'s
    // answer and cannot join them (§6.5.5 — batch the independent axis, never
    // pretend a dependent one is independent).
    const [taRes, assetRes] = await multicall3Aggregate3(
      [
        { target: vaultAddress, allowFailure: true, callData: encodeTotalAssetsCall() },
        { target: vaultAddress, allowFailure: true, callData: encodeAssetCall() },
      ],
      opts,
    );
    if (!taRes || !taRes.success) throw new Error(`live-source: totalAssets() failed for ${vaultAddress}`);
    const totalAssets = decodeUint256(taRes.returnData);
    // An empty/failed asset() is a call to an address with no code. It THROWS
    // rather than decoding to the zero address, preserving callAsset's contract
    // — the caller degrades the whole vault to its last-persisted row.
    const assetRaw = (!assetRes || !assetRes.success ? "" : assetRes.returnData).replace(/^0x/, "");
    if (assetRaw.length < 40) throw new Error(`Base RPC: empty asset() result from ${vaultAddress}`);
    const assetAddr = "0x" + assetRaw.slice(-40);
    // decimals() decoding to 0/garbage falls back to 18 (legacy edge-fn semantics).
    const decimals = (await callDecimals(assetAddr, opts)) || 18;
    const assetPriceUsd = STABLES.has(assetAddr.toLowerCase()) ? 1 : await dexPriceUsd(chain, assetAddr);
    return { totalAssetsRaw: totalAssets.toString(), decimals, assetPriceUsd };
  },

  // Issue #346: reuses the SAME batched-Multicall3 + keyless-price + persisted-
  // fallback valuation machinery the prop-wallet feeds share
  // (chain/wallet-valuation.ts) instead of the never-built legacy Alchemy
  // token-balance-scan port. Scope is deliberately narrow — native-ETH balance
  // on Base only, matching the "smallest first step" the issue asks for: the
  // discovery roster's wallets that are NOT on "base" (a handful of Ethereum/
  // Solana treasuries) have no live RPC wired at all in this codebase yet, so
  // this throws for them rather than fabricate a number; the caller (
  // worker/handlers/projects.ts refreshWallets) degrades that ONE wallet to
  // its last-persisted balance_usd, never the whole run.
  async walletBalanceUsd(address: string, chain: string): Promise<number> {
    if (chain !== "base") {
      throw new Error(
        `live wallet-balance provider only covers chain "base" (got "${chain}") for ${address} — ` +
          "no RPC/pricing path exists for other chains yet",
      );
    }
    const ethAsset = resolveTrackedAssets().find((a) => a.symbol === "ETH");
    if (!ethAsset) throw new Error("native ETH tracked asset is not configured (resolveTrackedAssets)");
    const reads: KeyedAssetRead[] = [{ key: address, asset: ethAsset, wallets: [address] }];
    const chainAmounts = await readChainAmountsBatched(reads, "projects.walletBalanceUsd");
    const valued = await valueLeg(
      ethAsset,
      chainAmounts.get(address) ?? { ok: false },
      resolveBaseRpcSource(),
      resolvePriceSource(),
      persistedFallbackWalletPriceReader,
    );
    if (!valued.ok) throw valued.error instanceof Error ? valued.error : new Error(String(valued.error));
    return valued.valueUsd;
  },
};
