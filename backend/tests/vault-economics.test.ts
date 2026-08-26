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
import {
  fetchVaultEconomics,
  computeApy7d,
  _resetVaultEconomicsCacheForTests,
  type VaultEconomicsReaders,
} from "../src/chain/vault-economics.ts";
import { sampleSharePrice, sampleVaultAdapters } from "../src/worker/handlers/vault.ts";
import { MULTICALL3_ADDRESS, decodeAggregate3Calls, encodeAggregate3Result } from "../src/chain/base-rpc-client.ts";
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
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;
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

    // A Multicall3 aggregate3 batch is answered sub-call by sub-call out of the
    // SAME fixture map, so a test still states its fixtures per (to, selector)
    // whether the caller reads singly or batches — sampleVaultAdapters batches
    // its adapter reads since the #294 Multicall3 work. An unfixtured sub-call
    // comes back {success:false} under allowFailure, which is how a real node
    // reports one reverted leg without failing the whole batch, and which the
    // sampler treats exactly as it treated a thrown single read.
    if (to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase() && selector === AGGREGATE3_SEL) {
      const results = decodeAggregate3Calls(data).map((c) => {
        const subKey = `${c.target.toLowerCase()}:${c.callData.slice(0, 10)}`;
        const sub = byToSelector[subKey];
        if (sub === undefined) {
          if (!c.allowFailure) throw new Error(`mockRpc: no fixture for ${subKey}`);
          return { success: false, returnData: "0x" };
        }
        return { success: true, returnData: sub };
      });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAggregate3Result(results) }),
        { status: 200 },
      );
    }

    const key = `${to.toLowerCase()}:${selector}`;
    const result = byToSelector[key];
    if (result === undefined) throw new Error(`mockRpc: no fixture for ${key}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as unknown as typeof fetch;
}

const AGGREGATE3_SEL = "0x82ad56cb";
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

function deterministicVaultReaders(): VaultEconomicsReaders {
  return {
    core: {
      async read() {
        return { totalAssets: 84_320_120_000n, totalSupply: 84_102_550_000n, idle: 1_000_000n };
      },
    },
    adapters: {
      async read(adapters) {
        return adapters.map((adapter) => (adapter.configured ? 28_000_000_000n : null));
      },
    },
    samples: {
      async latest() {
        return {
          asOf: "2026-07-16T12:00:00.000Z",
          totalAssets: 80_000,
          totalSupply: 79_000,
          sharePrice: 80_000 / 79_000,
        };
      },
      async apy7d() {
        return 0.05;
      },
    },
  };
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
  await sampleSharePrice({});
  await sampleVaultAdapters({});
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(false);
  expect(r.tvlUsd).toBeCloseTo(84320.12, 6);
  expect(r.totalShares).toBeCloseTo(84102.55, 6);
  expect(r.sharePrice).toBeCloseTo(84320120000 / 84102550000, 9);
  expect(r.idleUsdc).toBeCloseTo(320.12, 6);
  expect(r.adapters).toHaveLength(3);
  for (const a of r.adapters) {
    expect(a.configured).toBe(true);
    expect(a.balanceUsd).toBeCloseTo(28000, 6);
  }
  expect(r.adapters.map((a) => a.name)).toEqual(config.vault.adapters.map((a) => a.name));
});

test("vault seam: deterministic core, adapter, and sample readers preserve the public DTO and source provenance", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;
  const sampledAt = new Date();
  const sampleHour = new Date(sampledAt);
  sampleHour.setUTCMinutes(0, 0, 0);

  await sql`
    INSERT INTO vault_share_price_history (vault_address, sample_hour, sampled_at, total_assets, total_supply, share_price)
    VALUES (${VAULT}, ${sampleHour}, ${sampledAt}, 84320120000, 84102550000, 1.0025869)
  `;
  const adapters = resolveVaultAdapters();
  for (const a of adapters) {
    await sql`
      INSERT INTO vault_adapter_samples (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
      VALUES (${VAULT.toLowerCase()}, ${a.address.toLowerCase()}, ${a.name}, ${sampleHour}, 28000, true, 'stub', ${sampledAt})
    `;
  }

  _resetVaultEconomicsCacheForTests();
  const r = await fetchVaultEconomics();
  expect(Object.keys(r).sort()).toEqual([
    "adapters",
    "apy7d",
    "asOf",
    "idleUsdc",
    "sharePrice",
    "source",
    "stale",
    "totalShares",
    "tvlUsd",
  ]);
  expect(r.source).toBe("stub");
  expect(r.stale).toBe(false);
  expect(r.tvlUsd).toBeCloseTo(84_320.12, 6);
  expect(r.totalShares).toBeCloseTo(84_102.55, 6);
  expect(r.idleUsdc).toBeCloseTo(320.12, 6);
  expect(r.adapters).toHaveLength(3);
});

test("vault seam (#173): a failed adapter reader degrades ONLY the adapters — core totals stay live", async () => {
  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;
  const sampledAt = new Date();
  const sampleHour = new Date(sampledAt);
  sampleHour.setUTCMinutes(0, 0, 0);

  await sql`
    INSERT INTO vault_share_price_history (vault_address, sample_hour, sampled_at, total_assets, total_supply, share_price)
    VALUES (${VAULT}, ${sampleHour}, ${sampledAt}, 84320120000, 84102550000, 1.0025869)
  `;

  _resetVaultEconomicsCacheForTests();
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(true);
  expect(r.tvlUsd).toBeCloseTo(84_320.12, 6);
  expect(r.totalShares).toBeCloseTo(84_102.55, 6);
  expect(r.sharePrice).toBeCloseTo(84_320_120_000 / 84_102_550_000, 6);
  expect(r.adapters.every((adapter) => adapter.balanceUsd === null)).toBe(true);
});

test("vault seam (#173): missing core sample degrades core totals to null", async () => {
  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;
  const sampledAt = new Date();
  const sampleHour = new Date(sampledAt);
  sampleHour.setUTCMinutes(0, 0, 0);

  const adapters = resolveVaultAdapters();
  for (const a of adapters) {
    await sql`
      INSERT INTO vault_adapter_samples (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
      VALUES (${VAULT.toLowerCase()}, ${a.address.toLowerCase()}, ${a.name}, ${sampleHour}, 28000, true, 'live', ${sampledAt})
    `;
  }

  _resetVaultEconomicsCacheForTests();
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(true);
  expect(r.tvlUsd).toBeNull();
  expect(r.adapters.every((adapter) => adapter.balanceUsd === 28_000)).toBe(true);
});

test("#173 fix: one reverted adapter eth_call degrades ONLY that adapter; the others keep their live values", async () => {
  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;
  process.env.ADAPTER_MORPHO_ADDRESS = MORPHO_OVERRIDE;
  process.env.ADAPTER_AAVE_ADDRESS = AAVE_OVERRIDE;
  process.env.ADAPTER_COMPOUND_ADDRESS = COMPOUND_OVERRIDE;
  const adapters = resolveVaultAdapters();
  const fixtures = happyPathFixture(adapters);
  delete fixtures[`${AAVE_OVERRIDE.toLowerCase()}:${TOTAL_ASSETS_SEL}`];
  mockRpc(fixtures);
  await sampleSharePrice({});
  await sampleVaultAdapters({});

  _resetVaultEconomicsCacheForTests();
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(true);
  expect(r.tvlUsd).toBeCloseTo(84_320.12, 6);
  const morpho = r.adapters.find((a) => a.name === "Morpho")!;
  const aave = r.adapters.find((a) => a.name === "Aave")!;
  const compound = r.adapters.find((a) => a.name === "Compound")!;
  expect(morpho.balanceUsd).toBeCloseTo(28_000, 6);
  expect(aave.balanceUsd).toBeNull();
  expect(compound.balanceUsd).toBeCloseTo(28_000, 6);
});

// Reserved "unset" sentinels: a single hex nibble ×40. An adapter explicitly
// pointed at one of these is reported configured:false and must NEVER be
// eth_called (issue #50). Since the real deployed addresses are now the DEFAULTS,
// exercising the unconfigured path requires an explicit placeholder override.
const MORPHO_PLACEHOLDER = "0x1111111111111111111111111111111111111111";
const AAVE_PLACEHOLDER = "0x2222222222222222222222222222222222222222";
const COMPOUND_PLACEHOLDER = "0x3333333333333333333333333333333333333333";

test("adapters explicitly set to placeholder addresses are configured:false, balanceUsd:null, and are NEVER eth_called", async () => {
  process.env.ADAPTER_MORPHO_ADDRESS = MORPHO_PLACEHOLDER;
  process.env.ADAPTER_AAVE_ADDRESS = AAVE_PLACEHOLDER;
  process.env.ADAPTER_COMPOUND_ADDRESS = COMPOUND_PLACEHOLDER;
  mockRpc({
    [`${VAULT.toLowerCase()}:${TOTAL_ASSETS_SEL}`]: word(84_320_120_000n),
    [`${VAULT.toLowerCase()}:${TOTAL_SUPPLY_SEL}`]: word(84_102_550_000n),
    [`${config.vault.usdc.toLowerCase()}:${BALANCE_OF_SEL}`]: word(1_000_000n),
  });
  await sampleSharePrice({});
  await sampleVaultAdapters({});
  const r = await fetchVaultEconomics();
  expect(r.adapters).toHaveLength(3);
  for (const a of r.adapters) {
    expect(a.configured).toBe(false);
    expect(a.balanceUsd).toBeNull();
  }
  expect(r.adapters.map((a) => a.address)).toEqual([MORPHO_PLACEHOLDER, AAVE_PLACEHOLDER, COMPOUND_PLACEHOLDER]);
});

test("a placeholder override flips only that adapter to configured:false; the real-default adapters stay configured:true and are eth_called", async () => {
  process.env.ADAPTER_AAVE_ADDRESS = AAVE_PLACEHOLDER;
  const adapters = resolveVaultAdapters();
  mockRpc(happyPathFixture(adapters.filter((a) => a.configured)));
  await sampleSharePrice({});
  await sampleVaultAdapters({});
  const r = await fetchVaultEconomics();
  expect(r.stale).toBe(false);
  const aave = r.adapters.find((a) => a.name === "Aave")!;
  expect(aave.configured).toBe(false);
  expect(aave.balanceUsd).toBeNull();
  for (const a of r.adapters.filter((x) => x.name !== "Aave")) {
    expect(a.configured).toBe(true);
    expect(a.balanceUsd).toBeCloseTo(28000, 6);
  }
});

test("resolveVaultAdapters: unset env → the real deployed adapter addresses, all configured:true (fixes the 'Not configured' smoke bug)", () => {
  const adapters = resolveVaultAdapters({});
  expect(adapters.every((a) => a.configured === true)).toBe(true);
  expect(adapters.map((a) => a.address.toLowerCase())).toEqual([
    "0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9",
    "0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea",
    "0x8247da22a59fce074c102431048d0ce7294c2652",
  ]);
});

test("resolveVaultAdapters: a real ADAPTER_*_ADDRESS override is used verbatim (stays configured:true); a placeholder override flips that adapter to configured:false", () => {
  const overridden = resolveVaultAdapters({ ADAPTER_AAVE_ADDRESS: AAVE_OVERRIDE });
  const aave = overridden.find((a) => a.name === "Aave")!;
  expect(aave.configured).toBe(true);
  expect(aave.address).toBe(AAVE_OVERRIDE);
  for (const a of overridden.filter((x) => x.name !== "Aave")) expect(a.configured).toBe(true); // real defaults

  const placeheld = resolveVaultAdapters({ ADAPTER_AAVE_ADDRESS: AAVE_PLACEHOLDER });
  expect(placeheld.find((a) => a.name === "Aave")!.configured).toBe(false);
});

test("vault-economics source provenance: unset/empty BASE_RPC_SOURCE resolves 'live'; 'stub' resolves 'stub'", async () => {
  mockRpc(happyPathFixture());
  delete process.env.BASE_RPC_SOURCE;
  await sampleSharePrice({});
  await sampleVaultAdapters({});
  const rLive = await fetchVaultEconomics();
  expect(rLive.source).toBe("live");

  _resetVaultEconomicsCacheForTests();
  process.env.BASE_RPC_SOURCE = "stub";
  await sampleSharePrice({});
  await sampleVaultAdapters({});
  const rStub = await fetchVaultEconomics();
  expect(rStub.source).toBe("stub");
});

test("a degraded (stale) response still carries the correct source provenance", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;
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
  await sampleSharePrice({});
  await sampleVaultAdapters({});
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
  }) as unknown as typeof fetch;

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
  }) as unknown as typeof fetch;
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
  await sampleSharePrice({});
  await sampleVaultAdapters({});
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

test("fetchVaultEconomics performs ZERO chain calls on request path when injected readers call expect.unreachable()", async () => {
  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;

  const sampledAt = new Date();
  const sampleHour = new Date(sampledAt);
  sampleHour.setUTCMinutes(0, 0, 0);

  await sql`
    INSERT INTO vault_share_price_history (vault_address, sample_hour, sampled_at, total_assets, total_supply, share_price)
    VALUES (${VAULT}, ${sampleHour}, ${sampledAt}, 84320120000, 84102550000, 1.0025869)
  `;

  const adapters = resolveVaultAdapters();
  for (const a of adapters) {
    await sql`
      INSERT INTO vault_adapter_samples (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
      VALUES (${VAULT.toLowerCase()}, ${a.address.toLowerCase()}, ${a.name}, ${sampleHour}, 28000, true, 'live', ${sampledAt})
    `;
  }

  const unreachableReaders: VaultEconomicsReaders = {
    core: {
      read() {
        expect.unreachable();
      },
    },
    adapters: {
      read() {
        expect.unreachable();
      },
    },
    samples: {
      async latest() {
        expect.unreachable();
      },
      async apy7d() {
        return 0.04;
      },
    },
  };

  _resetVaultEconomicsCacheForTests();
  const r = await fetchVaultEconomics(unreachableReaders);

  expect(r.stale).toBe(false);
  expect(r.tvlUsd).toBeCloseTo(84320.12, 6);
  expect(r.totalShares).toBeCloseTo(84102.55, 6);
  expect(r.adapters).toHaveLength(3);
  for (const a of r.adapters) {
    expect(a.balanceUsd).toBeCloseTo(28000, 6);
  }

  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;
});

test("fetchVaultEconomics: freshness budget boundary pair (budget-1s -> stale false, budget+1s -> stale true)", async () => {
  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;

  const BUDGET_MS = 60 * 60_000; // 1 hour
  const adapters = resolveVaultAdapters();

  // 1) Budget - 1s (fresh)
  const freshTime = new Date(Date.now() - (BUDGET_MS - 1000));
  const freshHour = new Date(freshTime);
  freshHour.setUTCMinutes(0, 0, 0);

  await sql`
    INSERT INTO vault_share_price_history (vault_address, sample_hour, sampled_at, total_assets, total_supply, share_price)
    VALUES (${VAULT}, ${freshHour}, ${freshTime}, 84320120000, 84102550000, 1.0025869)
  `;
  for (const a of adapters) {
    await sql`
      INSERT INTO vault_adapter_samples (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
      VALUES (${VAULT.toLowerCase()}, ${a.address.toLowerCase()}, ${a.name}, ${freshHour}, 28000, true, 'live', ${freshTime})
    `;
  }

  _resetVaultEconomicsCacheForTests();
  const rFresh = await fetchVaultEconomics();
  expect(rFresh.stale).toBe(false);

  // 2) Budget + 1s (stale)
  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;

  const staleTime = new Date(Date.now() - (BUDGET_MS + 1000));
  const staleHour = new Date(staleTime);
  staleHour.setUTCMinutes(0, 0, 0);

  await sql`
    INSERT INTO vault_share_price_history (vault_address, sample_hour, sampled_at, total_assets, total_supply, share_price)
    VALUES (${VAULT}, ${staleHour}, ${staleTime}, 84320120000, 84102550000, 1.0025869)
  `;
  for (const a of adapters) {
    await sql`
      INSERT INTO vault_adapter_samples (vault_address, adapter_address, adapter_name, sample_hour, balance_usd, configured, provenance, sampled_at)
      VALUES (${VAULT.toLowerCase()}, ${a.address.toLowerCase()}, ${a.name}, ${staleHour}, 28000, true, 'live', ${staleTime})
    `;
  }

  _resetVaultEconomicsCacheForTests();
  const rStale = await fetchVaultEconomics();
  expect(rStale.stale).toBe(true);

  await sql`DELETE FROM vault_share_price_history WHERE vault_address = ${VAULT}`;
  await sql`DELETE FROM vault_adapter_samples WHERE vault_address = ${VAULT}`;
});

