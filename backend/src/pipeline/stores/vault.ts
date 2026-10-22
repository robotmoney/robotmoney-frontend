// The vault samplers' writes, run by the api for the pipeline worker (issue
// 1034, decision D75). worker/handlers/vault.ts reads the chain and sends the
// rows; these statements are the ones that handler used to run on its own pool.
import { on, registerQuery, type RegistryDb } from "../../db/registry.ts";

const PIPELINE_ROUTE = ["src/api/routes/pipeline"];

const upsertSharePrice = registerQuery({
  role: "rm_app",
  object: "vault_share_price_history",
  // UPDATE for ON CONFLICT DO UPDATE; SELECT because the conflict target and
  // EXCLUDED are read.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/vault:upsertSharePrice",
  purpose: "Upsert the vault's hourly share-price sample on (vault_address, sample_hour).",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO vault_share_price_history
        (vault_address, sample_hour, sampled_at, total_assets, total_supply, share_price)
      VALUES ($1, $2::timestamptz, $3::timestamptz, $4::numeric, $5::numeric, $6::numeric)
      ON CONFLICT (vault_address, sample_hour) DO UPDATE SET
        sampled_at = EXCLUDED.sampled_at, total_assets = EXCLUDED.total_assets,
        total_supply = EXCLUDED.total_supply, share_price = EXCLUDED.share_price`,
    params: ["0x0000000000000000000000000000000000000001", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "1", "1", "1"],
  },
});

const upsertAdapterSample = registerQuery({
  role: "rm_app",
  object: "vault_adapter_samples",
  // UPDATE for ON CONFLICT DO UPDATE; SELECT because the conflict target and
  // EXCLUDED are read.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/vault:upsertAdapterSamples",
  purpose: "Upsert each adapter's hourly balance sample on (vault, adapter, sample_hour).",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO vault_adapter_samples
        (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
      VALUES ($1, $2, $3, $4::timestamptz, $5::numeric, $6::boolean, $7, $8::timestamptz)
      ON CONFLICT (vault_address, adapter_address, sample_hour) DO UPDATE SET
        adapter_name = EXCLUDED.adapter_name, balance_usd = EXCLUDED.balance_usd, configured = EXCLUDED.configured,
        provenance = EXCLUDED.provenance, sampled_at = EXCLUDED.sampled_at`,
    params: [
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
      "probe",
      "2026-01-01T00:00:00Z",
      "1",
      true,
      "live",
      "2026-01-01T00:00:00Z",
    ],
  },
});

/** One hourly share-price sample, as vault.sample_share_price reads it. */
export interface SharePriceSample {
  vaultAddress: string;
  sampleHour: Date;
  sampledAt: Date;
  /** Decimal strings: totalAssets()/totalSupply() are uint256. */
  totalAssets: string;
  totalSupply: string;
  sharePrice: number | null;
}

/** Upsert one share-price sample on (vault_address, sample_hour). */
export async function upsertSharePriceSample(db: RegistryDb, s: SharePriceSample): Promise<void> {
  await on(db, upsertSharePrice)`
    INSERT INTO vault_share_price_history
      (vault_address, sample_hour, sampled_at, total_assets, total_supply, share_price)
    VALUES
      (${s.vaultAddress}, ${s.sampleHour}, ${s.sampledAt}, ${s.totalAssets}, ${s.totalSupply}, ${s.sharePrice})
    ON CONFLICT (vault_address, sample_hour) DO UPDATE SET
      sampled_at   = EXCLUDED.sampled_at,
      total_assets = EXCLUDED.total_assets,
      total_supply = EXCLUDED.total_supply,
      share_price  = EXCLUDED.share_price
  `;
}

/** One adapter's hourly balance sample. A null balance is an unconfigured adapter's row. */
export interface AdapterSample {
  vaultAddress: string;
  adapterAddress: string;
  adapterName: string;
  sampleHour: Date;
  balanceUsd: number | null;
  configured: boolean;
  provenance: string;
  sampledAt: Date;
}

/** Upsert each adapter sample on (vault_address, adapter_address, sample_hour). Returns how many it wrote. */
export async function upsertAdapterSamples(db: RegistryDb, rows: readonly AdapterSample[]): Promise<number> {
  for (const r of rows) {
    await on(db, upsertAdapterSample)`
      INSERT INTO vault_adapter_samples
        (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
      VALUES
        (${r.vaultAddress}, ${r.adapterAddress}, ${r.adapterName}, ${r.sampleHour}, ${r.balanceUsd}, ${r.configured}, ${r.provenance}, ${r.sampledAt})
      ON CONFLICT (vault_address, adapter_address, sample_hour) DO UPDATE SET
        adapter_name = EXCLUDED.adapter_name,
        balance_usd  = EXCLUDED.balance_usd,
        configured   = EXCLUDED.configured,
        provenance   = EXCLUDED.provenance,
        sampled_at   = EXCLUDED.sampled_at
    `;
  }
  return rows.length;
}
