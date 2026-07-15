// Live vault-economics for GET /api/dashboards/vault-economics (issue #40).
// Reads the vault + USDC + configured adapters via Base JSON-RPC eth_call
// (base-rpc-client.ts) on demand, behind a short-TTL in-process cache. On any
// RPC failure it degrades to the last persisted share-price sample (or nulls)
// with `stale: true` — it NEVER fabricates a number.
import { config, resolveBaseRpcSource, resolveVaultAdapters, type BaseRpcSource, type VaultAdapterConfig } from "../config.ts";
import { sql } from "../db/client.ts";
import { callTotalAssets, callTotalSupply, callBalanceOf, type RpcCallOptions } from "./base-rpc-client.ts";

const USDC_SCALE = 1_000_000; // 6-decimal fixed point, matches the vault's asset (USDC).

function toUsd(raw: bigint): number {
  return Number(raw) / USDC_SCALE;
}

export interface VaultAdapterHolding {
  name: string;
  address: string;
  // False while the adapter is still at its non-functional placeholder address
  // (no ADAPTER_*_ADDRESS env override, issue #50). Unconfigured adapters are
  // never eth_called and always carry balanceUsd: null — a placeholder must
  // never render as a live-looking $0.
  configured: boolean;
  balanceUsd: number | null;
}

export interface VaultEconomics {
  asOf: string;
  stale: boolean;
  // Provenance (issue #50): 'live' = a real Base JSON-RPC endpoint (the ONLY
  // value the demo/CI path resolves since issue #147 removed DEMO_HERMETIC and
  // the hermetic fixture stub); 'stub' = a deterministic fixture value backend
  // unit tests set directly via BASE_RPC_SOURCE=stub. Stub-served payloads are
  // never presented as live chain data — the allocation UI renders a non-live
  // indicator off this field.
  source: BaseRpcSource;
  tvlUsd: number | null;
  sharePrice: number | null;
  totalShares: number | null;
  idleUsdc: number | null;
  apy7d: number | null;
  adapters: VaultAdapterHolding[];
}

function rpcOpts(): RpcCallOptions {
  return { rpcUrl: config.baseRpcUrl };
}

interface LiveRead {
  totalAssets: bigint;
  totalSupply: bigint;
  idle: bigint;
  // Parallel to the adapters argument: null for an UNCONFIGURED (placeholder)
  // adapter, which is never eth_called (issue #50).
  adapterBalances: (bigint | null)[];
}

async function readLive(adapters: VaultAdapterConfig[]): Promise<LiveRead> {
  const opts = rpcOpts();
  const [totalAssets, totalSupply, idle, ...adapterBalances] = await Promise.all([
    callTotalAssets(config.vault.address, opts),
    callTotalSupply(config.vault.address, opts),
    callBalanceOf(config.vault.usdc, config.vault.address, opts),
    ...adapters.map((a) => (a.configured ? callTotalAssets(a.address, opts) : Promise.resolve(null))),
  ]);
  return { totalAssets, totalSupply, idle, adapterBalances };
}

interface PersistedSample {
  asOf: string | null;
  totalAssets: number | null;
  totalSupply: number | null;
  sharePrice: number | null;
}

async function lastPersistedSample(vaultAddress: string): Promise<PersistedSample> {
  const rows = await sql<{ sample_hour: Date; total_assets: string; total_supply: string; share_price: string | null }[]>`
    SELECT sample_hour, total_assets, total_supply, share_price
      FROM vault_share_price_history
     WHERE vault_address = ${vaultAddress}
     ORDER BY sample_hour DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { asOf: null, totalAssets: null, totalSupply: null, sharePrice: null };
  return {
    asOf: row.sample_hour.toISOString(),
    totalAssets: toUsd(BigInt(row.total_assets)),
    totalSupply: toUsd(BigInt(row.total_supply)),
    sharePrice: row.share_price == null ? null : Number(row.share_price),
  };
}

// 7-day APY from persisted hourly samples: (1 + growth)^(365/daysElapsed) - 1,
// where growth is the share-price change between the earliest and latest
// sample within the lookback window. Fewer than 2 usable samples (missing
// history, or a vault too young to have a week of data) yields null rather
// than a divide-by-zero or a fabricated rate.
export async function computeApy7d(vaultAddress: string): Promise<number | null> {
  const rows = await sql<{ sample_hour: Date; share_price: string }[]>`
    SELECT sample_hour, share_price
      FROM vault_share_price_history
     WHERE vault_address = ${vaultAddress}
       AND share_price IS NOT NULL
       AND sample_hour >= now() - interval '7 days'
     ORDER BY sample_hour ASC
  `;
  if (rows.length < 2) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const p0 = Number(first.share_price);
  const p1 = Number(last.share_price);
  if (!(p0 > 0)) return null;
  const daysElapsed = (last.sample_hour.getTime() - first.sample_hour.getTime()) / 86_400_000;
  if (!(daysElapsed > 0)) return null;
  const growth = p1 / p0 - 1;
  return Math.pow(1 + growth, 365 / daysElapsed) - 1;
}

// Short-TTL in-process cache: vault state moves on the order of minutes (an
// hourly sampler backs the APY history), not per-request, so repeated page
// loads within the TTL are served from memory instead of re-hitting the RPC.
const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: VaultEconomics } | null = null;

export function _resetVaultEconomicsCacheForTests(): void {
  cache = null;
}

export async function fetchVaultEconomics(): Promise<VaultEconomics> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  // Resolved per call (not module load) so the provenance marker and the
  // adapter `configured` flags always track the current env — and so tests can
  // flip BASE_RPC_SOURCE / ADAPTER_*_ADDRESS per case. resolveBaseRpcSource is
  // fail-closed and intentionally OUTSIDE the try below: an invalid marker
  // must refuse loudly, never degrade into a payload claiming 'live'.
  const source = resolveBaseRpcSource();
  const adapters = resolveVaultAdapters();

  let result: VaultEconomics;
  try {
    const live = await readLive(adapters);
    const sharePrice = live.totalSupply === 0n ? null : Number(live.totalAssets) / Number(live.totalSupply);
    result = {
      asOf: new Date(now).toISOString(),
      stale: false,
      source,
      tvlUsd: toUsd(live.totalAssets),
      sharePrice,
      totalShares: toUsd(live.totalSupply),
      idleUsdc: toUsd(live.idle),
      apy7d: await computeApy7d(config.vault.address),
      adapters: adapters.map((a, i) => {
        const balance = live.adapterBalances[i];
        return {
          name: a.name,
          address: a.address,
          configured: a.configured,
          // Unconfigured (placeholder) adapters are never eth_called: null,
          // not a live-looking $0 (issue #50).
          balanceUsd: balance == null ? null : toUsd(balance),
        };
      }),
    };
  } catch (err) {
    console.error("vault-economics: Base RPC read failed, degrading to last-persisted values:", err);
    const persisted = await lastPersistedSample(config.vault.address).catch(
      (): PersistedSample => ({ asOf: null, totalAssets: null, totalSupply: null, sharePrice: null }),
    );
    result = {
      asOf: persisted.asOf ?? new Date(now).toISOString(),
      stale: true,
      source,
      tvlUsd: persisted.totalAssets,
      sharePrice: persisted.sharePrice,
      totalShares: persisted.totalSupply,
      idleUsdc: null, // no persisted history for idle balance / per-adapter breakdown
      apy7d: await computeApy7d(config.vault.address).catch(() => null),
      adapters: adapters.map((a) => ({ name: a.name, address: a.address, configured: a.configured, balanceUsd: null })),
    };
  }
  cache = { at: now, value: result };
  return result;
}
