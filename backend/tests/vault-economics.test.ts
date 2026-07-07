// Vault-economics handler (backend/src/chain/vault-economics.ts) + sampler
// (backend/src/worker/handlers/vault.ts): happy path against a mocked
// `eth_call` transport, totalSupply=0, missing-history APY, RPC-failure
// degraded payload, and the sampler's one-row-per-run upsert — all against the
// real (ephemeral) Postgres, never a reachable RPC (test-coverage policy).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { fetchVaultEconomics, computeApy7d, _resetVaultEconomicsCacheForTests } from "../src/chain/vault-economics.ts";
import { sampleSharePrice } from "../src/worker/handlers/vault.ts";
import { ROUTES } from "@robotmoney/contract";
import { getVaultEconomics } from "../src/api/routes/dashboards.ts";

const realFetch = globalThis.fetch;
const VAULT = config.vault.address;

beforeEach(async () => {
  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  _resetVaultEconomicsCacheForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  _resetVaultEconomicsCacheForTests();
});

// Encode a uint256 eth_call result word from a decimal string.
function word(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

// Route eth_call by `to` + selector prefix so the mock can answer
// vault.totalAssets/totalSupply, usdc.balanceOf(vault), and each adapter's
// totalAssets() distinctly, matching the real multi-call read.
function mockRpc(byToSelector: Record<string, string>) {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: [{ to: string; data: string }] };
    const { to, data } = body.params[0];
    const selector = data.slice(0, 10);
    const key = `${to.toLowerCase()}:${selector}`;
    const result = byToSelector[key];
    if (result === undefined) throw new Error(`mockRpc: no fixture for ${key}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as typeof fetch;
}

const TOTAL_ASSETS_SEL = "0x01e1d114";
const TOTAL_SUPPLY_SEL = "0x18160ddd";
const BALANCE_OF_SEL = "0x70a08231";

function happyPathFixture(): Record<string, string> {
  const fixtures: Record<string, string> = {
    [`${VAULT.toLowerCase()}:${TOTAL_ASSETS_SEL}`]: word(84_320_120_000n), // $84,320.12
    [`${VAULT.toLowerCase()}:${TOTAL_SUPPLY_SEL}`]: word(84_102_550_000n), // 84,102.55 shares
    [`${config.vault.usdc.toLowerCase()}:${BALANCE_OF_SEL}`]: word(1_000_000n), // $1.00 idle
  };
  for (const a of config.vault.adapters) {
    fixtures[`${a.address.toLowerCase()}:${TOTAL_ASSETS_SEL}`] = word(28_000_000_000n); // $28,000 each
  }
  return fixtures;
}

test("fetchVaultEconomics happy path: tvl/sharePrice/totalShares/idle/adapters match hand-computed fixtures", async () => {
  mockRpc(happyPathFixture());
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(false);
  expect(r.tvlUsd).toBeCloseTo(84320.12, 6);
  expect(r.totalShares).toBeCloseTo(84102.55, 6);
  expect(r.sharePrice).toBeCloseTo(84320120000 / 84102550000, 9);
  expect(r.idleUsdc).toBeCloseTo(1.0, 6);
  expect(r.adapters).toHaveLength(3);
  for (const a of r.adapters) expect(a.balanceUsd).toBeCloseTo(28000, 6);
  expect(r.adapters.map((a) => a.name)).toEqual(config.vault.adapters.map((a) => a.name));
});

test("totalSupply = 0 yields sharePrice: null without throwing", async () => {
  const fixtures = happyPathFixture();
  fixtures[`${VAULT.toLowerCase()}:${TOTAL_SUPPLY_SEL}`] = word(0n);
  mockRpc(fixtures);
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(false);
  expect(r.sharePrice).toBeNull();
});

test("computeApy7d: fewer than 2 samples in the lookback yields null", async () => {
  expect(await computeApy7d(VAULT)).toBeNull();

  await sql`
    INSERT INTO vault_share_price_history (vault_address, sample_hour, total_assets, total_supply, share_price)
    VALUES (${VAULT}, now(), 100, 100, 1.0)
  `;
  expect(await computeApy7d(VAULT)).toBeNull();
});

test("computeApy7d: (1+growth)^(365/daysElapsed)-1 from seeded history rows", async () => {
  const now = new Date();
  // Just inside the 7-day lookback window (avoids a flaky exact-boundary
  // comparison against the DB's `now()` evaluated a few ms after `now` here).
  const almostSevenDaysAgo = new Date(now.getTime() - 6.99 * 86_400_000);
  await sql`
    INSERT INTO vault_share_price_history (vault_address, sample_hour, total_assets, total_supply, share_price)
    VALUES
      (${VAULT}, ${almostSevenDaysAgo}, 100000000, 100000000, 1.0),
      (${VAULT}, ${now}, 100767000, 100000000, 1.00767)
  `;
  const apy = await computeApy7d(VAULT);
  const daysElapsed = (now.getTime() - almostSevenDaysAgo.getTime()) / 86_400_000;
  const expected = Math.pow(1 + (1.00767 / 1.0 - 1), 365 / daysElapsed) - 1;
  expect(apy).not.toBeNull();
  expect(apy!).toBeCloseTo(expected, 4);
});

test("a failing mocked RPC transport degrades to stale:true with last-persisted values, never fabricated, never a throw", async () => {
  const sampleHour = new Date();
  sampleHour.setUTCMinutes(0, 0, 0);
  await sql`
    INSERT INTO vault_share_price_history (vault_address, sample_hour, total_assets, total_supply, share_price)
    VALUES (${VAULT}, ${sampleHour}, 84320120000, 84102550000, ${84320120000 / 84102550000})
  `;
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as typeof fetch;

  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(true);
  expect(r.tvlUsd).toBeCloseTo(84320.12, 6);
  expect(r.sharePrice).toBeCloseTo(84320120000 / 84102550000, 9);
  expect(r.idleUsdc).toBeNull();
  expect(r.adapters).toHaveLength(3);
  for (const a of r.adapters) expect(a.balanceUsd).toBeNull();
});

test("degraded response with no persisted history at all is all-nulls, still 200-shaped, never fabricated", async () => {
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as typeof fetch;
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(true);
  expect(r.tvlUsd).toBeNull();
  expect(r.sharePrice).toBeNull();
  expect(r.totalShares).toBeNull();
  expect(r.idleUsdc).toBeNull();
  expect(r.apy7d).toBeNull();
  expect(r.adapters).toHaveLength(3);
});

test("GET /api/dashboards/vault-economics handler builds its request from the shared ROUTES constant", async () => {
  expect(ROUTES.dashboards.vaultEconomics).toBe("/api/dashboards/vault-economics");
  mockRpc(happyPathFixture());
  const r = await getVaultEconomics();
  expect(r.tvlUsd).toBeCloseTo(84320.12, 6);
  expect(r.adapters).toHaveLength(3);
});

test("sampleSharePrice inserts exactly one share-price history row per run (upsert on vault_address, sample_hour)", async () => {
  mockRpc({
    [`${VAULT.toLowerCase()}:${TOTAL_ASSETS_SEL}`]: word(84_320_120_000n),
    [`${VAULT.toLowerCase()}:${TOTAL_SUPPLY_SEL}`]: word(84_102_550_000n),
  });
  const before = await sql`SELECT count(*)::int AS n FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  expect(before[0]!.n).toBe(0);

  await sampleSharePrice({});
  const after = await sql`SELECT count(*)::int AS n FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  expect(after[0]!.n).toBe(1);

  // Re-running within the same hour upserts the same slot rather than adding a row.
  await sampleSharePrice({});
  const again = await sql`SELECT count(*)::int AS n FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  expect(again[0]!.n).toBe(1);
});
