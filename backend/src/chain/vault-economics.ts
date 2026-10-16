// Live vault-economics for GET /api/dashboards/vault-economics (issue #40, #294).
// Served purely from persisted `vault_share_price_history` and `vault_adapter_samples`
// in Postgres — ZERO Base RPC eth_calls on the request path. Scheduled worker jobs
// (vault.sample_share_price, vault.sample_adapters) populate the tables.
import { config, resolveBaseRpcSource, resolveVaultAdapters, type BaseRpcSource, type VaultAdapterConfig } from "../config.ts";
import { sql } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";
import {
  decodeUint256,
  encodeBalanceOfCall,
  encodeTotalAssetsCall,
  encodeTotalSupplyCall,
  multicall3Aggregate3,
  type Aggregate3Result,
  type Call3,
  type RpcCallOptions,
} from "./base-rpc-client.ts";
import type { Provenance } from "./wallet-valuation.ts";
import { ttlCached } from "./ttl-cache.ts";

const USDC_SCALE = 1_000_000; // 6-decimal fixed point, matches the vault's asset (USDC).

function toUsd(raw: bigint): number {
  return Number(raw) / USDC_SCALE;
}

export interface VaultAdapterHolding {
  name: string;
  address: string;
  configured: boolean;
  balanceUsd: number | null;
  balanceObservedAt?: string | null;
  provenance?: Provenance;
}

export interface VaultEconomics {
  asOf: string;
  stale: boolean;
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

export interface VaultCoreRead {
  totalAssets: bigint;
  totalSupply: bigint;
  idle: bigint;
}

export interface VaultCoreReader {
  read(vaultAddress: string, usdcAddress: string, opts: RpcCallOptions): Promise<VaultCoreRead>;
}

export interface VaultAdapterReader {
  read(adapters: VaultAdapterConfig[], opts: RpcCallOptions): Promise<(bigint | null)[]>;
}

export interface PersistedVaultSample {
  asOf: string | null;
  totalAssets: number | null;
  totalSupply: number | null;
  sharePrice: number | null;
}

export interface VaultSampleReader {
  latest(vaultAddress: string): Promise<PersistedVaultSample>;
  apy7d(vaultAddress: string): Promise<number | null>;
}

export interface VaultEconomicsReaders {
  core: VaultCoreReader;
  adapters: VaultAdapterReader;
  samples: VaultSampleReader;
}

/** A sub-call that reverted, or returned nothing, is NOT a zero (markets §6.1's
 *  silent-zero rail). markets §6.3's rule: batching may never turn a failed read
 *  into a plausible number. */
function requireWord(r: Aggregate3Result | undefined, what: string): bigint {
  if (!r || !r.success) throw new Error(`vault-economics: ${what} sub-call failed`);
  return decodeUint256(r.returnData);
}

const rpcVaultCoreReader: VaultCoreReader = {
  async read(vaultAddress, usdcAddress, opts) {
    // THREE READS AT ONE BLOCK → ONE eth_call. They were three separate POSTs
    // under Promise.all, which is three tokens from a bucket that meters per
    // request, for reads that Multicall3 was built to carry together. The
    // failure semantics are deliberately unchanged: all three must succeed or
    // the read throws and the caller degrades to its persisted sample, exactly
    // as an individual throw did before.
    const calls: Call3[] = [
      { target: vaultAddress, allowFailure: true, callData: encodeTotalAssetsCall() },
      { target: vaultAddress, allowFailure: true, callData: encodeTotalSupplyCall() },
      { target: usdcAddress, allowFailure: true, callData: encodeBalanceOfCall(vaultAddress) },
    ];
    const res = await multicall3Aggregate3(calls, opts);
    return {
      totalAssets: requireWord(res[0], "totalAssets()"),
      totalSupply: requireWord(res[1], "totalSupply()"),
      idle: requireWord(res[2], "idle balanceOf()"),
    };
  },
};

const rpcVaultAdapterReader: VaultAdapterReader = {
  async read(adapters, opts) {
    // N adapters at ONE block → ONE eth_call, where this was N parallel POSTs.
    // `allowFailure` maps exactly onto the per-adapter degrade this reader
    // already promised via allSettled: a reverting adapter yields null and its
    // siblings are unaffected.
    const wanted = adapters.map((a, i) => ({ a, i })).filter(({ a }) => a.configured);
    if (wanted.length === 0) return adapters.map(() => null);

    let res: Aggregate3Result[];
    try {
      res = await multicall3Aggregate3(
        wanted.map(({ a }) => ({ target: a.address, allowFailure: true, callData: encodeTotalAssetsCall() })),
        opts,
      );
    } catch (err) {
      // The BATCH failed (transport/HTTP/JSON-RPC), so every adapter in it is
      // unread — the same all-fail outcome the per-call path produced when the
      // transport was down, not a silent row of zeros.
      console.error("vault-economics: batched adapter read failed, degrading every adapter:", err);
      return adapters.map(() => null);
    }

    const out: (bigint | null)[] = adapters.map(() => null);
    for (let k = 0; k < wanted.length; k++) {
      const { a, i } = wanted[k]!;
      const r = res[k];
      if (!r || !r.success) {
        console.error(`vault-economics: adapter ${a.name} read failed, degrading only that adapter`);
        continue;
      }
      out[i] = decodeUint256(r.returnData);
    }
    return out;
  },
};

// Every statement below is a registered query (smoke-production-spec.md §7.1),
// reached only through GET /api/dashboards/vault-economics.
const latestShareSample = registerQuery({
  role: "rm_app",
  object: "vault_share_price_history",
  privileges: ["SELECT"],
  site: "src/chain/vault-economics:lastPersistedSample",
  purpose: "Read a vault's newest persisted share-price sample for the sample reader.",
  callers: ["src/api/routes/dashboards"],
  probe: {
    statement: `SELECT sample_hour, total_assets, total_supply, share_price FROM vault_share_price_history
      WHERE lower(vault_address) = lower($1) ORDER BY sample_hour DESC LIMIT 1`,
    params: ["0x0000000000000000000000000000000000000001"],
  },
});

const apyWindow = registerQuery({
  role: "rm_app",
  object: "vault_share_price_history",
  privileges: ["SELECT"],
  site: "src/chain/vault-economics:computeApy7d",
  purpose: "Read a vault's last seven days of share prices to annualise its APY.",
  callers: ["src/api/routes/dashboards"],
  probe: {
    statement: `SELECT sample_hour, share_price FROM vault_share_price_history
      WHERE lower(vault_address) = lower($1) AND share_price IS NOT NULL
        AND sample_hour >= now() - interval '7 days'
      ORDER BY sample_hour ASC`,
    params: ["0x0000000000000000000000000000000000000001"],
  },
});

const coreTotals = registerQuery({
  role: "rm_app",
  object: "vault_share_price_history",
  privileges: ["SELECT"],
  site: "src/chain/vault-economics:computeVaultEconomics.core",
  purpose: "Read the newest persisted vault totals for the vault-economics payload, with zero RPC.",
  callers: ["src/api/routes/dashboards"],
  probe: {
    statement: `SELECT sample_hour, sampled_at, total_assets, total_supply, share_price FROM vault_share_price_history
      WHERE lower(vault_address) = lower($1) ORDER BY sample_hour DESC, sampled_at DESC LIMIT 1`,
    params: ["0x0000000000000000000000000000000000000001"],
  },
});

const adapterBalances = registerQuery({
  role: "rm_app",
  object: "vault_adapter_samples",
  privileges: ["SELECT"],
  site: "src/chain/vault-economics:computeVaultEconomics.adapters",
  purpose: "Read each adapter's newest persisted balance for the vault-economics payload, with zero RPC.",
  callers: ["src/api/routes/dashboards"],
  probe: {
    statement: `SELECT DISTINCT ON (adapter_address) adapter_address, adapter_name, balance_usd, configured, provenance, sampled_at
      FROM vault_adapter_samples WHERE lower(vault_address) = lower($1)
      ORDER BY adapter_address, sample_hour DESC, sampled_at DESC`,
    params: ["0x0000000000000000000000000000000000000001"],
  },
});

async function lastPersistedSample(vaultAddress: string): Promise<PersistedVaultSample> {
  const rows = await on(sql, latestShareSample)<{ sample_hour: Date; total_assets: string; total_supply: string; share_price: string | null }>`
    SELECT sample_hour, total_assets, total_supply, share_price
      FROM vault_share_price_history
     WHERE lower(vault_address) = lower(${vaultAddress})
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

const postgresVaultSampleReader: VaultSampleReader = {
  latest: lastPersistedSample,
  apy7d: computeApy7d,
};

const defaultVaultEconomicsReaders: VaultEconomicsReaders = {
  core: rpcVaultCoreReader,
  adapters: rpcVaultAdapterReader,
  samples: postgresVaultSampleReader,
};

export async function computeApy7d(vaultAddress: string): Promise<number | null> {
  const rows = await on(sql, apyWindow)<{ sample_hour: Date; share_price: string }>`
    SELECT sample_hour, share_price
      FROM vault_share_price_history
     WHERE lower(vault_address) = lower(${vaultAddress})
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

export const VAULT_ECONOMICS_FRESHNESS_BUDGET_MS = 60 * 60_000; // 1 hour

const CACHE_TTL_MS = 30_000;

async function computeVaultEconomics(
  _readers: VaultEconomicsReaders = defaultVaultEconomicsReaders,
): Promise<VaultEconomics> {
  const now = Date.now();

  const source = resolveBaseRpcSource();
  const adapters = resolveVaultAdapters();

  // Core totals from vault_share_price_history (ZERO RPC)
  const coreRows = await on(sql, coreTotals)<
    { sample_hour: Date; sampled_at: Date; total_assets: string; total_supply: string; share_price: string | null }
  >`
    SELECT sample_hour, sampled_at, total_assets, total_supply, share_price
      FROM vault_share_price_history
     WHERE lower(vault_address) = lower(${config.vault.address})
     ORDER BY sample_hour DESC, sampled_at DESC
     LIMIT 1
  `;
  const coreRow = coreRows[0];

  let coreStale = false;
  let tvlUsd: number | null = null;
  let sharePrice: number | null = null;
  let totalShares: number | null = null;
  let coreSampledAtMs = 0;

  if (coreRow) {
    const totalAssets = BigInt(coreRow.total_assets);
    const totalSupply = BigInt(coreRow.total_supply);
    tvlUsd = toUsd(totalAssets);
    totalShares = toUsd(totalSupply);
    sharePrice = coreRow.share_price == null ? null : Number(coreRow.share_price);
    coreSampledAtMs = (coreRow.sampled_at instanceof Date ? coreRow.sampled_at : new Date(coreRow.sampled_at)).getTime();
    if (now - coreSampledAtMs > VAULT_ECONOMICS_FRESHNESS_BUDGET_MS) {
      coreStale = true;
    }
  } else {
    coreStale = true;
  }

  // Per-adapter balances from vault_adapter_samples (ZERO RPC)
  const adapterRows = await on(sql, adapterBalances)<
    { adapter_address: string; adapter_name: string; balance_usd: string | null; configured: boolean; provenance: string; sampled_at: Date }
  >`
    SELECT DISTINCT ON (adapter_address) adapter_address, adapter_name, balance_usd, configured, provenance, sampled_at
      FROM vault_adapter_samples
     WHERE lower(vault_address) = lower(${config.vault.address})
     ORDER BY adapter_address, sample_hour DESC, sampled_at DESC
  `;
  const adapterMap = new Map(adapterRows.map((r) => [r.adapter_address.toLowerCase(), r]));

  let adaptersStale = false;
  let newestAdapterMs = 0;
  const adapterDtos: VaultAdapterHolding[] = [];
  let totalAdapterUsd = 0;
  let allConfiguredAdaptersHaveValue = true;

  for (const a of adapters) {
    const row = adapterMap.get(a.address.toLowerCase());
    if (!a.configured) {
      adapterDtos.push({
        name: a.name,
        address: a.address,
        configured: false,
        balanceUsd: null,
        balanceObservedAt: row ? row.sampled_at.toISOString() : null,
        provenance: row ? (row.provenance as Provenance) : source,
      });
      continue;
    }

    if (!row) {
      adaptersStale = true;
      allConfiguredAdaptersHaveValue = false;
      adapterDtos.push({
        name: a.name,
        address: a.address,
        configured: true,
        balanceUsd: null,
        balanceObservedAt: null,
        provenance: "stale",
      });
      continue;
    }

    const rowSampledAtMs = (row.sampled_at instanceof Date ? row.sampled_at : new Date(row.sampled_at)).getTime();
    if (rowSampledAtMs > newestAdapterMs) newestAdapterMs = rowSampledAtMs;

    const isAgeStale = now - rowSampledAtMs > VAULT_ECONOMICS_FRESHNESS_BUDGET_MS;
    const prov = row.provenance as Provenance;
    if (prov === "stale" || isAgeStale || row.balance_usd == null) {
      adaptersStale = true;
    }

    const bal = row.balance_usd == null ? null : Number(row.balance_usd);
    if (bal != null) {
      totalAdapterUsd += bal;
    } else {
      allConfiguredAdaptersHaveValue = false;
    }

    adapterDtos.push({
      name: a.name,
      address: a.address,
      configured: true,
      balanceUsd: bal,
      balanceObservedAt: row.sampled_at.toISOString(),
      provenance: prov,
    });
  }

  const idleUsdc =
    tvlUsd != null && allConfiguredAdaptersHaveValue
      ? Math.max(0, Math.round((tvlUsd - totalAdapterUsd) * 100) / 100)
      : null;

  const stale = coreStale || adaptersStale;
  const maxSampleMs = Math.max(coreSampledAtMs, newestAdapterMs);
  const asOf = new Date(maxSampleMs > 0 ? maxSampleMs : now).toISOString();
  const apy7d = await computeApy7d(config.vault.address).catch(() => null);

  return {
    asOf,
    stale,
    source,
    tvlUsd,
    sharePrice,
    totalShares,
    idleUsdc,
    apy7d,
    adapters: adapterDtos,
  };
}

export const fetchVaultEconomics = ttlCached(computeVaultEconomics, CACHE_TTL_MS);

export function _resetVaultEconomicsCacheForTests(): void {
  fetchVaultEconomics._resetForTests();
}
