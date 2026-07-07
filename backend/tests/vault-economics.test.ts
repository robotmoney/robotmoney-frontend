// Vault-economics handler (backend/src/chain/vault-economics.ts) + sampler
// (backend/src/worker/handlers/vault.ts): happy path against a mocked
// `eth_call` transport, totalSupply=0, missing-history APY, RPC-failure
// degraded payload, the sampler's one-row-per-run upsert, RPC/adapter
// provenance (source live|stub, per-adapter configured), and the
// never-eth-call-a-placeholder guarantee (issue #50) — all against the real
// (ephemeral) Postgres, never a reachable RPC (test-coverage policy).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { config, resolveBaseRpcSource, resolveVaultAdapters, type VaultAdapterConfig } from "../src/config.ts";
import { fetchVaultEconomics, computeApy7d, _resetVaultEconomicsCacheForTests } from "../src/chain/vault-economics.ts";
import { sampleSharePrice } from "../src/worker/handlers/vault.ts";
import { ROUTES } from "@robotmoney/contract";
import { getVaultEconomics } from "../src/api/routes/dashboards.ts";

const realFetch = globalThis.fetch;
const VAULT = config.vault.address;

// Non-placeholder adapter addresses used to exercise the ADAPTER_*_ADDRESS
// env-override → configured:true path. Any well-formed hex address works for
// the mock transport; these are deliberately distinct from the 0x1111.../
// 0x2222.../0x3333... placeholders so a test can prove which set was queried.
const MORPHO_OVERRIDE = "0x" + "aa11".repeat(10);
const AAVE_OVERRIDE = "0x" + "bb22".repeat(10);
const COMPOUND_OVERRIDE = "0x" + "cc33".repeat(10);
const ADAPTER_ENV_KEYS = ["ADAPTER_MORPHO_ADDRESS", "ADAPTER_AAVE_ADDRESS", "ADAPTER_COMPOUND_ADDRESS", "BASE_RPC_SOURCE"] as const;

beforeEach(async () => {
  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  _resetVaultEconomicsCacheForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  _resetVaultEconomicsCacheForTests();
  // Every provenance/adapter-override test below mutates process.env directly
  // (the resolvers read process.env when called with no args, matching how
  // chain/vault-economics.ts calls them) — always restore to unset so no test
  // leaks its knobs into the next one.
  for (const k of ADAPTER_ENV_KEYS) delete process.env[k];
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

// `adapters` defaults to the module-load-time placeholder set
// (config.vault.adapters) purely for callers that don't care whether an
// adapter is eth_called; tests exercising the configured/unconfigured split
// pass the freshly-resolved set explicitly (resolveVaultAdapters() reflects
// whatever ADAPTER_*_ADDRESS the test just set, unlike the frozen
// config.vault.adapters snapshot).
function happyPathFixture(adapters: Pick<VaultAdapterConfig, "address">[] = config.vault.adapters): Record<string, string> {
  const fixtures: Record<string, string> = {
    [`${VAULT.toLowerCase()}:${TOTAL_ASSETS_SEL}`]: word(84_320_120_000n), // $84,320.12
    [`${VAULT.toLowerCase()}:${TOTAL_SUPPLY_SEL}`]: word(84_102_550_000n), // 84,102.55 shares
    [`${config.vault.usdc.toLowerCase()}:${BALANCE_OF_SEL}`]: word(1_000_000n), // $1.00 idle
  };
  for (const a of adapters) {
    fixtures[`${a.address.toLowerCase()}:${TOTAL_ASSETS_SEL}`] = word(28_000_000_000n); // $28,000 each
  }
  return fixtures;
}

test("fetchVaultEconomics happy path: tvl/sharePrice/totalShares/idle/adapters match hand-computed fixtures", async () => {
  // Configure all three adapters so this test exercises the same "all live and
  // eth_called" happy path it always has; the placeholder/unconfigured path
  // is covered by its own test below.
  process.env.ADAPTER_MORPHO_ADDRESS = MORPHO_OVERRIDE;
  process.env.ADAPTER_AAVE_ADDRESS = AAVE_OVERRIDE;
  process.env.ADAPTER_COMPOUND_ADDRESS = COMPOUND_OVERRIDE;
  const adapters = resolveVaultAdapters();
  mockRpc(happyPathFixture(adapters));
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(false);
  expect(r.tvlUsd).toBeCloseTo(84320.12, 6);
  expect(r.totalShares).toBeCloseTo(84102.55, 6);
  expect(r.sharePrice).toBeCloseTo(84320120000 / 84102550000, 9);
  expect(r.idleUsdc).toBeCloseTo(1.0, 6);
  expect(r.adapters).toHaveLength(3);
  for (const a of r.adapters) {
    expect(a.configured).toBe(true);
    expect(a.balanceUsd).toBeCloseTo(28000, 6);
  }
  expect(r.adapters.map((a) => a.name)).toEqual(config.vault.adapters.map((a) => a.name));
});

test("adapters left at their placeholder addresses are configured:false, balanceUsd:null, and are NEVER eth_called", async () => {
  // No ADAPTER_*_ADDRESS overrides — every adapter stays at its non-functional
  // placeholder (0x1111.../0x2222.../0x3333...). Deliberately supply NO mock
  // fixture for any of them: if the handler ever called one, mockRpc would
  // throw "no fixture" and this test would fail loudly, proving the
  // never-eth-call-an-unconfigured-adapter guarantee structurally, not just
  // by asserting the output shape.
  mockRpc({
    [`${VAULT.toLowerCase()}:${TOTAL_ASSETS_SEL}`]: word(84_320_120_000n),
    [`${VAULT.toLowerCase()}:${TOTAL_SUPPLY_SEL}`]: word(84_102_550_000n),
    [`${config.vault.usdc.toLowerCase()}:${BALANCE_OF_SEL}`]: word(1_000_000n),
  });
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(false); // proves the run succeeded WITHOUT calling any adapter
  expect(r.adapters).toHaveLength(3);
  for (const a of r.adapters) {
    expect(a.configured).toBe(false);
    expect(a.balanceUsd).toBeNull();
  }
  expect(r.adapters.map((a) => a.address)).toEqual([
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ]);
});

test("an ADAPTER_*_ADDRESS override flips only that adapter to configured:true; the others stay unconfigured/null", async () => {
  process.env.ADAPTER_MORPHO_ADDRESS = MORPHO_OVERRIDE;
  mockRpc({
    [`${VAULT.toLowerCase()}:${TOTAL_ASSETS_SEL}`]: word(84_320_120_000n),
    [`${VAULT.toLowerCase()}:${TOTAL_SUPPLY_SEL}`]: word(84_102_550_000n),
    [`${config.vault.usdc.toLowerCase()}:${BALANCE_OF_SEL}`]: word(1_000_000n),
    [`${MORPHO_OVERRIDE.toLowerCase()}:${TOTAL_ASSETS_SEL}`]: word(28_000_000_000n),
  });
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(false);
  const morpho = r.adapters.find((a) => a.name === "Morpho")!;
  expect(morpho.configured).toBe(true);
  expect(morpho.address).toBe(MORPHO_OVERRIDE);
  expect(morpho.balanceUsd).toBeCloseTo(28000, 6);
  for (const a of r.adapters.filter((x) => x.name !== "Morpho")) {
    expect(a.configured).toBe(false);
    expect(a.balanceUsd).toBeNull();
  }
});

test("resolveVaultAdapters: unset env → all three configured:false at their documented placeholder addresses", () => {
  const adapters = resolveVaultAdapters({});
  expect(adapters.every((a) => a.configured === false)).toBe(true);
  expect(adapters.map((a) => a.address)).toEqual([
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ]);
});

test("resolveVaultAdapters: an ADAPTER_*_ADDRESS override is used verbatim and flips configured:true for just that adapter", () => {
  const adapters = resolveVaultAdapters({ ADAPTER_AAVE_ADDRESS: AAVE_OVERRIDE });
  const aave = adapters.find((a) => a.name === "Aave")!;
  expect(aave.configured).toBe(true);
  expect(aave.address).toBe(AAVE_OVERRIDE);
  for (const a of adapters.filter((x) => x.name !== "Aave")) expect(a.configured).toBe(false);
});

test("vault-economics source provenance: unset/empty BASE_RPC_SOURCE resolves 'live'; 'stub' resolves 'stub'", async () => {
  mockRpc(happyPathFixture());
  delete process.env.BASE_RPC_SOURCE;
  const rLive = await fetchVaultEconomics();
  expect(rLive.source).toBe("live");

  _resetVaultEconomicsCacheForTests();
  process.env.BASE_RPC_SOURCE = "stub";
  const rStub = await fetchVaultEconomics();
  expect(rStub.source).toBe("stub");
});

test("a degraded (stale) response still carries the correct source provenance", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as typeof fetch;
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(true);
  expect(r.source).toBe("stub");
});

test("resolveBaseRpcSource: unset/empty resolves 'live'; 'stub' resolves 'stub'; anything else fails closed (throws)", () => {
  expect(resolveBaseRpcSource({})).toBe("live");
  expect(resolveBaseRpcSource({ BASE_RPC_SOURCE: "" })).toBe("live");
  expect(resolveBaseRpcSource({ BASE_RPC_SOURCE: "live" })).toBe("live");
  expect(resolveBaseRpcSource({ BASE_RPC_SOURCE: "stub" })).toBe("stub");
  expect(() => resolveBaseRpcSource({ BASE_RPC_SOURCE: "bogus" })).toThrow(/invalid BASE_RPC_SOURCE/);
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
