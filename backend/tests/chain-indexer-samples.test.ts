// Test suite for the new Postgres chain indexer tables and worker handlers (issue #294).
// Covers:
// 1) Migration 0021 DDL applied and verified via information_schema
// 2) sampleWalletSleeves and sampleVaultAdapters worker handlers execution against Postgres
// 3) Idempotency on natural keys
// 4) Thrown RPC read inside sampler persists no row (no fabricated zero) and leaves previous sample intact
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { config, resolveVaultAdapters } from "../src/config.ts";
import { sampleWalletSleeves } from "../src/worker/handlers/wallet.ts";
import { sampleVaultAdapters } from "../src/worker/handlers/vault.ts";
import { decodeAggregate3Calls, encodeAggregate3Result } from "../src/chain/base-rpc-client.ts";

const realFetch = globalThis.fetch;
const VAULT = config.vault.address;

function word(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

function mockRpc(failAdapters: string[] = [], failAll = false) {
  const TOTAL_ASSETS_SEL = "0x01e1d114";
  const BALANCE_OF_SEL = "0x70a08231";
  const CONVERT_TO_ASSETS_SEL = "0x07a2d13a";
  const GET_ETH_BALANCE_SEL = "0x4d2301cc";
  const AGGREGATE3_SEL = "0x82ad56cb";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (failAll) throw new Error("mockRpc: forced whole-transport failure");

    const u = String(url);
    if (u.includes("geckoterminal.com") || u.includes("finance.yahoo.com")) {
      const addrs = (u.split("/token_price/")[1] ?? "x").toLowerCase().split(",");
      return new Response(
        JSON.stringify({ data: { attributes: { token_prices: Object.fromEntries(addrs.map((a) => [a, "10.0"])) } } }),
        { status: 200 },
      );
    }

    const body = JSON.parse(String(init?.body)) as { method: string; params: any[] };
    if (body.method === "eth_getBalance") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(50_000_000_000_000_000n) }), { status: 200 });
    }

    if (body.method === "eth_call") {
      const param = body.params[0] as { to: string; data: string };
      const to = param.to.toLowerCase();
      const data = param.data;
      const sel = data.slice(0, 10);

      // One sub-call's answer: null when this mock has no opinion on the
      // selector, and a throw for an address the test asked to fail.
      const answer = (target: string, callData: string): string | null => {
        if (failAdapters.some((a) => a.toLowerCase() === target.toLowerCase())) {
          throw new Error(`mockRpc: adapter ${target} call failed`);
        }
        const s = callData.slice(0, 10);
        if (s === TOTAL_ASSETS_SEL) return word(28_000_000_000n);
        if (s === BALANCE_OF_SEL) return word(1_000_000n);
        if (s === CONVERT_TO_ASSETS_SEL) return word(1_000_000n);
        if (s === GET_ETH_BALANCE_SEL) return word(50_000_000_000_000_000n);
        return null;
      };

      if (sel === AGGREGATE3_SEL) {
        // Answer the batch sub-call by sub-call, as the real Multicall3 does: a
        // sub-call the test failed comes back {success:false} under allowFailure
        // instead of failing the whole batch. sampleVaultAdapters reads its
        // adapters through this path now that the #294 batching landed, so the
        // per-adapter failure injection has to be expressed here to still bite.
        const results = decodeAggregate3Calls(data).map((c) => {
          try {
            const rd = answer(c.target, c.callData);
            return rd === null ? { success: false, returnData: "0x" } : { success: true, returnData: rd };
          } catch (err) {
            if (!c.allowFailure) throw err;
            return { success: false, returnData: "0x" };
          }
        });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAggregate3Result(results) }),
          { status: 200 },
        );
      }

      const single = answer(to, data);
      if (single !== null) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: single }), { status: 200 });
      }
    }

    throw new Error(`mockRpc: unhandled call to ${body.method}`);
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await sql`DELETE FROM wallet_sleeve_samples`;
  await sql`DELETE FROM vault_adapter_samples`;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("Migration 0021 DDL exists and applies wallet_sleeve_samples & vault_adapter_samples", async () => {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_name IN ('wallet_sleeve_samples', 'vault_adapter_samples')
  `;
  expect(tables.map((t) => t.table_name).sort()).toEqual(["vault_adapter_samples", "wallet_sleeve_samples"]);

  const sleeveCols = await sql<{ column_name: string }[]>`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_name = 'wallet_sleeve_samples'
  `;
  const sleeveColNames = sleeveCols.map((c) => c.column_name);
  expect(sleeveColNames).toContain("sample_date");
  expect(sleeveColNames).toContain("wallet_address");
  expect(sleeveColNames).toContain("symbol");
  expect(sleeveColNames).toContain("amount");
  expect(sleeveColNames).toContain("price_usd");
  expect(sleeveColNames).toContain("value_usd");
  expect(sleeveColNames).toContain("provenance");

  const adapterCols = await sql<{ column_name: string }[]>`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_name = 'vault_adapter_samples'
  `;
  const adapterColNames = adapterCols.map((c) => c.column_name);
  expect(adapterColNames).toContain("vault_address");
  expect(adapterColNames).toContain("adapter_address");
  expect(adapterColNames).toContain("adapter_name");
  expect(adapterColNames).toContain("sample_hour");
  expect(adapterColNames).toContain("balance_usd");
  expect(adapterColNames).toContain("configured");
  expect(adapterColNames).toContain("provenance");
});

test("sampleWalletSleeves and sampleVaultAdapters are idempotent on natural keys", async () => {
  mockRpc();

  // Run samplers once
  await sampleWalletSleeves({});
  await sampleVaultAdapters({});

  const sleeveCount1 = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM wallet_sleeve_samples`;
  const adapterCount1 = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM vault_adapter_samples`;

  expect(Number(sleeveCount1[0]!.count)).toBeGreaterThan(0);
  expect(Number(adapterCount1[0]!.count)).toBeGreaterThan(0);

  // Run samplers second time in same slot
  await sampleWalletSleeves({});
  await sampleVaultAdapters({});

  const sleeveCount2 = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM wallet_sleeve_samples`;
  const adapterCount2 = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM vault_adapter_samples`;

  expect(sleeveCount2[0]!.count).toBe(sleeveCount1[0]!.count);
  expect(adapterCount2[0]!.count).toBe(adapterCount1[0]!.count);
});

test("A thrown RPC read inside a sampler persists no row (no fabricated zero) and leaves previous sample intact", async () => {
  const adapters = resolveVaultAdapters();
  const failingAdapter = adapters.find((a) => a.configured)?.address ?? "0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9";

  // Seed initial sample
  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  await sql`
    INSERT INTO vault_adapter_samples
      (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
    VALUES
      (${VAULT.toLowerCase()}, ${failingAdapter.toLowerCase()}, 'Morpho', ${hour}, 50000, true, 'live', ${hour})
  `;

  // Run sampler with failing RPC call for failingAdapter
  mockRpc([failingAdapter]);
  await sampleVaultAdapters({});

  // Verify previous sample remains unchanged (balance_usd is still 50000, not wiped to null/0)
  const rows = await sql<{ balance_usd: string }[]>`
    SELECT balance_usd FROM vault_adapter_samples
     WHERE lower(adapter_address) = lower(${failingAdapter})
  `;
  expect(rows).toHaveLength(1);
  expect(Number(rows[0]!.balance_usd)).toBe(50000);
});
