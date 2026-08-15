// Hourly share-price sampler for the live vault-economics APY calculation
// (issue #40). Reads the vault's totalAssets()/totalSupply() via Base JSON-RPC
// and upserts one row into vault_share_price_history, keyed by
// (vault_address, sample_hour) so a retried or overlapping run within the same
// hour never duplicates a slot. This is what the seeded
// `vault.sample_share_price` cron (db/seed.ts, hourly) fires.
import { config, resolveBaseRpcSource, resolveVaultAdapters } from "../../config.ts";
import { sql } from "../../db/worker-client.ts";
import { callTotalAssets, callTotalSupply } from "../../chain/base-rpc-client.ts";
import { declineReplayedSlot, isReplayedSlot } from "./slot.ts";

const USDC_SCALE = 1_000_000;

export async function sampleSharePrice(payload: Record<string, unknown> = {}): Promise<unknown> {
  // Class C (NOT_BACKFILLABLE, issue #614): totalAssets()/totalSupply() are
  // read at "latest" — a replayed slot cannot be honoured for a past hour.
  if (isReplayedSlot(payload)) return declineReplayedSlot("vault.sample_share_price", payload);
  const opts = { rpcUrl: config.baseRpcUrl };
  const [totalAssets, totalSupply] = await Promise.all([
    callTotalAssets(config.vault.address, opts),
    callTotalSupply(config.vault.address, opts),
  ]);
  const sharePrice = totalSupply === 0n ? null : Number(totalAssets) / Number(totalSupply);
  const sampledAt = new Date();
  const sampleHour = new Date(sampledAt);
  sampleHour.setUTCMinutes(0, 0, 0);

  await sql`
    INSERT INTO vault_share_price_history
      (vault_address, sample_hour, sampled_at, total_assets, total_supply, share_price)
    VALUES
      (${config.vault.address}, ${sampleHour}, ${sampledAt}, ${totalAssets.toString()}, ${totalSupply.toString()}, ${sharePrice})
    ON CONFLICT (vault_address, sample_hour) DO UPDATE SET
      sampled_at   = EXCLUDED.sampled_at,
      total_assets = EXCLUDED.total_assets,
      total_supply = EXCLUDED.total_supply,
      share_price  = EXCLUDED.share_price
  `;

  return { vaultAddress: config.vault.address, sampleHour: sampleHour.toISOString(), sharePrice };
}

export async function sampleVaultAdapters(payload: Record<string, unknown> = {}): Promise<unknown> {
  if (isReplayedSlot(payload)) return declineReplayedSlot("vault.sample_adapters", payload);
  const opts = { rpcUrl: config.baseRpcUrl };
  const source = resolveBaseRpcSource();
  const adapters = resolveVaultAdapters();
  const sampledAt = new Date();
  const sampleHour = new Date(sampledAt);
  sampleHour.setUTCMinutes(0, 0, 0);

  let persisted = 0;

  for (const a of adapters) {
    if (!a.configured) {
      await sql`
        INSERT INTO vault_adapter_samples
          (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
        VALUES
          (${config.vault.address.toLowerCase()}, ${a.address.toLowerCase()}, ${a.name}, ${sampleHour}, NULL, false, ${source}, ${sampledAt})
        ON CONFLICT (vault_address, adapter_address, sample_hour) DO UPDATE SET
          adapter_name = EXCLUDED.adapter_name,
          balance_usd  = EXCLUDED.balance_usd,
          configured   = EXCLUDED.configured,
          provenance   = EXCLUDED.provenance,
          sampled_at   = EXCLUDED.sampled_at
      `;
      persisted += 1;
      continue;
    }

    try {
      const totalAssets = await callTotalAssets(a.address, opts);
      const balanceUsd = Number(totalAssets) / USDC_SCALE;
      await sql`
        INSERT INTO vault_adapter_samples
          (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
        VALUES
          (${config.vault.address.toLowerCase()}, ${a.address.toLowerCase()}, ${a.name}, ${sampleHour}, ${balanceUsd}, true, ${source}, ${sampledAt})
        ON CONFLICT (vault_address, adapter_address, sample_hour) DO UPDATE SET
          adapter_name = EXCLUDED.adapter_name,
          balance_usd  = EXCLUDED.balance_usd,
          configured   = EXCLUDED.configured,
          provenance   = EXCLUDED.provenance,
          sampled_at   = EXCLUDED.sampled_at
      `;
      persisted += 1;
    } catch (err) {
      console.error(`sampleVaultAdapters: adapter ${a.name} RPC read failed, skipping insert:`, err);
    }
  }

  return { vaultAddress: config.vault.address, sampleHour: sampleHour.toISOString(), persisted };
}

