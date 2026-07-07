// Hourly share-price sampler for the live vault-economics APY calculation
// (issue #40). Reads the vault's totalAssets()/totalSupply() via Base JSON-RPC
// and upserts one row into vault_share_price_history, keyed by
// (vault_address, sample_hour) so a retried or overlapping run within the same
// hour never duplicates a slot. This is what the seeded
// `vault.sample_share_price` cron (db/seed.ts, hourly) fires.
import { config } from "../../config.ts";
import { sql } from "../../db/client.ts";
import { callTotalAssets, callTotalSupply } from "../../chain/base-rpc-client.ts";

export async function sampleSharePrice(_payload: Record<string, unknown>): Promise<unknown> {
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
