// Hourly share-price sampler for the live vault-economics APY calculation
// (issue #40). Reads the vault's totalAssets()/totalSupply() via Base JSON-RPC
// and upserts one row into vault_share_price_history, keyed by
// (vault_address, sample_hour) so a retried or overlapping run within the same
// hour never duplicates a slot. This is what the seeded
// `vault.sample_share_price` cron (db/seed.ts, hourly) fires.
import { config, resolveBaseRpcSource, resolveVaultAdapters } from "../../config.ts";
import { sql } from "../../db/worker-client.ts";
import {
  type Aggregate3Result,
  callTotalAssets,
  callTotalSupply,
  decodeUint256,
  encodeTotalAssetsCall,
  isEmptyReturnData,
  multicall3Aggregate3,
} from "../../chain/base-rpc-client.ts";
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

  const upsert = (a: { name: string; address: string }, balanceUsd: number | null, configured: boolean) => sql`
    INSERT INTO vault_adapter_samples
      (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
    VALUES
      (${config.vault.address.toLowerCase()}, ${a.address.toLowerCase()}, ${a.name}, ${sampleHour}, ${balanceUsd}, ${configured}, ${source}, ${sampledAt})
    ON CONFLICT (vault_address, adapter_address, sample_hour) DO UPDATE SET
      adapter_name = EXCLUDED.adapter_name,
      balance_usd  = EXCLUDED.balance_usd,
      configured   = EXCLUDED.configured,
      provenance   = EXCLUDED.provenance,
      sampled_at   = EXCLUDED.sampled_at
  `;

  let persisted = 0;
  for (const a of adapters) {
    if (a.configured) continue;
    await upsert(a, null, false);
    persisted += 1;
  }

  const configured = adapters.filter((a) => a.configured);
  if (configured.length === 0) {
    return { vaultAddress: config.vault.address, sampleHour: sampleHour.toISOString(), persisted };
  }

  // ONE eth_call for every configured adapter, via Multicall3 aggregate3, rather
  // than one totalAssets() eth_call each. Issue #294's scope called for reusing
  // the existing Multicall3 batching here and this sampler never did: three
  // separate reads per tick against the free public Base RPC is exactly the
  // per-IP burst that 429s on the shared CI runner (#285/#287), which leaves
  // every adapter unsampled and the LIVE demo smoke red on `stale` provenance.
  let results: Aggregate3Result[];
  try {
    results = await multicall3Aggregate3(
      configured.map((a) => ({ target: a.address, allowFailure: true, callData: encodeTotalAssetsCall() })),
      opts,
    );
  } catch (err) {
    // The batch eth_call itself failed (transport/HTTP/JSON-RPC). Persist NOTHING
    // for the configured adapters: the last-persisted rows stay intact and the
    // served payload keeps reporting their real age. Reported as a DEGRADED
    // result rather than a success so the worker's exponential-backoff retry
    // re-reads within this slot instead of leaving the hour unsampled until the
    // next cron tick — an honest retry of a transient blip, never a relabel.
    const message = err instanceof Error ? err.message : String(err);
    console.error("sampleVaultAdapters: batched totalAssets() read failed, persisting no adapter row:", err);
    return {
      ok: false as const,
      status: "degraded",
      error: `vault.sample_adapters: batched totalAssets() read failed: ${message}`,
      vaultAddress: config.vault.address,
      sampleHour: sampleHour.toISOString(),
      persisted,
    };
  }

  const failed: string[] = [];
  for (let i = 0; i < configured.length; i++) {
    const a = configured[i]!;
    const r = results[i];
    // A reverted sub-call (allowFailure) or an empty return (an address carrying
    // no code) is NOT a zero balance — skip the insert rather than fabricate one,
    // exactly as the per-adapter catch did before the batch.
    if (!r?.success || isEmptyReturnData(r.returnData)) {
      console.error(`sampleVaultAdapters: adapter ${a.name} totalAssets() unreadable, skipping insert`);
      failed.push(a.name);
      continue;
    }
    await upsert(a, Number(decodeUint256(r.returnData)) / USDC_SCALE, true);
    persisted += 1;
  }

  if (failed.length > 0) {
    return {
      ok: false as const,
      status: "degraded",
      error: `vault.sample_adapters: totalAssets() unreadable for ${failed.join(", ")} — kept last-persisted`,
      vaultAddress: config.vault.address,
      sampleHour: sampleHour.toISOString(),
      persisted,
    };
  }

  return { vaultAddress: config.vault.address, sampleHour: sampleHour.toISOString(), persisted };
}

