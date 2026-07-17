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

export interface VaultCoreRead {
  totalAssets: bigint;
  totalSupply: bigint;
  idle: bigint;
}

export interface VaultCoreReader {
  read(vaultAddress: string, usdcAddress: string, opts: RpcCallOptions): Promise<VaultCoreRead>;
}

export interface VaultAdapterReader {
  // Parallel to adapters: null means an unconfigured placeholder and must not
  // trigger an RPC call.
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

// Resolved open question — `vault.sample_share_price` schedule/producer
// ownership (for #173's "verify and repair the persisted fallback path"
// deliverable): registration is a single `job_schedules` seed row,
// `{ kind: "vault.sample_share_price", cron: "0 * * * *" }` (hourly, top of
// hour) in backend/src/db/seed.ts. Generic due-job dispatch lives in
// backend/src/worker/scheduler.ts (`tickScheduler`). The only handler that
// ever writes `vault_share_price_history` is `sampleSharePrice` in
// backend/src/worker/handlers/vault.ts. There is exactly one producer and one
// schedule owner — #173 should verify this job is enabled and actually
// running in the target deployment (cf. the regime-projection staleness class
// of bug: a missing/disabled scheduled job reads as "no data", not an error)
// rather than adding a second write path.

// Dependency boundary established by scout #175, activated by #173: core and
// adapter reads are settled INDEPENDENTLY in fetchVaultEconomics below, so a
// failed adapter reader degrades only the adapter legs (core totals stay live)
// and a failed core reader degrades only the core legs (via the persisted
// sample, without discarding adapter data the adapter reader still returned).
// The public DTO shape is unchanged. Canonical behavior: docs/architecture.md
// §10 and docs/contract-live-data.md honesty rules.
export interface VaultEconomicsReaders {
  core: VaultCoreReader;
  adapters: VaultAdapterReader;
  samples: VaultSampleReader;
}

const rpcVaultCoreReader: VaultCoreReader = {
  async read(vaultAddress, usdcAddress, opts) {
    const [totalAssets, totalSupply, idle] = await Promise.all([
      callTotalAssets(vaultAddress, opts),
      callTotalSupply(vaultAddress, opts),
      callBalanceOf(usdcAddress, vaultAddress, opts),
    ]);
    return { totalAssets, totalSupply, idle };
  },
};

// Per-adapter isolation (#173): a reverted/thrown eth_call for ONE adapter
// must never take down the others (Promise.all would reject as a whole on the
// first rejection). Promise.allSettled degrades only the failed adapter's slot
// to null; every other configured adapter's balance is unaffected — a failed
// adapter call never erases an unrelated adapter's value.
const rpcVaultAdapterReader: VaultAdapterReader = {
  async read(adapters, opts) {
    const settled = await Promise.allSettled(
      adapters.map((a) => (a.configured ? callTotalAssets(a.address, opts) : Promise.resolve(null))),
    );
    return settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      console.error(`vault-economics: adapter ${adapters[i]!.name} read failed, degrading only that adapter:`, r.reason);
      return null;
    });
  },
};

// Vault address normalization (#173): `vault_share_price_history.vault_address`
// is a plain `text` column (backend/migrations/0012_vault_share_price_history.sql),
// so Postgres `=` is case-sensitive. `config.vault.address` is normalized
// lowercase at load (backend/src/config.ts), matching the sampler's INSERT
// (worker/handlers/vault.ts). The `lower(vault_address) = lower(...)`
// comparison below additionally recognizes any legacy mixed-case row written
// before that normalization, rather than requiring a citext migration.
async function lastPersistedSample(vaultAddress: string): Promise<PersistedVaultSample> {
  const rows = await sql<{ sample_hour: Date; total_assets: string; total_supply: string; share_price: string | null }[]>`
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

// 7-day APY from persisted hourly samples: (1 + growth)^(365/daysElapsed) - 1,
// where growth is the share-price change between the earliest and latest
// sample within the lookback window. Fewer than 2 usable samples (missing
// history, or a vault too young to have a week of data) yields null rather
// than a divide-by-zero or a fabricated rate.
export async function computeApy7d(vaultAddress: string): Promise<number | null> {
  const rows = await sql<{ sample_hour: Date; share_price: string }[]>`
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

// Short-TTL in-process cache: vault state moves on the order of minutes (an
// hourly sampler backs the APY history), not per-request, so repeated page
// loads within the TTL are served from memory instead of re-hitting the RPC.
const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: VaultEconomics } | null = null;

export function _resetVaultEconomicsCacheForTests(): void {
  cache = null;
}

export async function fetchVaultEconomics(readers: VaultEconomicsReaders = defaultVaultEconomicsReaders): Promise<VaultEconomics> {
  const now = Date.now();
  const useProductionCache = readers === defaultVaultEconomicsReaders;
  if (useProductionCache && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  // Resolved per call (not module load) so the provenance marker and the
  // adapter `configured` flags always track the current env — and so tests can
  // flip BASE_RPC_SOURCE / ADAPTER_*_ADDRESS per case. resolveBaseRpcSource is
  // fail-closed and intentionally OUTSIDE the try below: an invalid marker
  // must refuse loudly, never degrade into a payload claiming 'live'.
  const source = resolveBaseRpcSource();
  const adapters = resolveVaultAdapters();

  // Core and adapters are read INDEPENDENTLY (#173): a thrown adapter reader
  // must never erase successful core totals, and a thrown core reader must
  // never suppress adapter data the adapter reader DID manage to return.
  // allSettled means neither promise's rejection cancels or masks the other.
  const [coreSettled, adapterSettled] = await Promise.allSettled([
    readers.core.read(config.vault.address, config.vault.usdc, rpcOpts()),
    readers.adapters.read(adapters, rpcOpts()),
  ]);

  let coreFailed = false;
  let tvlUsd: number | null;
  let sharePrice: number | null;
  let totalShares: number | null;
  let idleUsdc: number | null;
  let asOf: string;
  if (coreSettled.status === "fulfilled") {
    const core = coreSettled.value;
    tvlUsd = toUsd(core.totalAssets);
    sharePrice = core.totalSupply === 0n ? null : Number(core.totalAssets) / Number(core.totalSupply);
    totalShares = toUsd(core.totalSupply);
    idleUsdc = toUsd(core.idle);
    asOf = new Date(now).toISOString();
  } else {
    coreFailed = true;
    console.error("vault-economics: vault core read failed, degrading to last-persisted values:", coreSettled.reason);
    const persisted = await readers.samples.latest(config.vault.address).catch(
      (): PersistedVaultSample => ({ asOf: null, totalAssets: null, totalSupply: null, sharePrice: null }),
    );
    tvlUsd = persisted.totalAssets;
    sharePrice = persisted.sharePrice;
    totalShares = persisted.totalSupply;
    idleUsdc = null; // no persisted history for idle balance / per-adapter breakdown
    asOf = persisted.asOf ?? new Date(now).toISOString();
  }

  // adapterBalances[i] === null covers BOTH an unconfigured placeholder (never
  // eth_called, issue #50) and a configured adapter whose read failed; only the
  // latter should mark the response stale, so track it separately.
  let adaptersFailed = false;
  let adapterBalances: (bigint | null)[];
  if (adapterSettled.status === "fulfilled") {
    adapterBalances = adapterSettled.value;
  } else {
    adaptersFailed = true;
    console.error("vault-economics: vault adapter read failed, degrading only the adapter legs:", adapterSettled.reason);
    adapterBalances = adapters.map(() => null);
  }
  const adapterDtos = adapters.map((a, i) => {
    const balance = adapterBalances[i];
    return {
      name: a.name,
      address: a.address,
      configured: a.configured,
      // Unconfigured (placeholder) adapters are never eth_called: null,
      // not a live-looking $0 (issue #50).
      balanceUsd: balance == null ? null : toUsd(balance),
    };
  });
  const anyConfiguredAdapterMissing = adapterDtos.some((a) => a.configured && a.balanceUsd == null);
  const stale = coreFailed || adaptersFailed || anyConfiguredAdapterMissing;

  const result: VaultEconomics = {
    asOf,
    stale,
    source,
    tvlUsd,
    sharePrice,
    totalShares,
    idleUsdc,
    apy7d: await readers.samples.apy7d(config.vault.address).catch(() => null),
    adapters: adapterDtos,
  };
  if (useProductionCache) cache = { at: now, value: result };
  return result;
}
