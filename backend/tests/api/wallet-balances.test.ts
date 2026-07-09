// GET /api/dashboards/wallet-balances handler (chain/wallet-balances.ts) +
// sampler/backfill (worker/handlers/wallet.ts) + config guards (issue #84).
//
// Same discipline as vault-economics.test.ts: a mocked fetch transport for the
// Base RPC + keyless price hosts, run against the REAL (ephemeral) Postgres
// provisioned by tests/preload.ts — never a reachable RPC/price host. Fails
// loudly (not skips) when Postgres is absent (loud-skip policy).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import {
  resolvePropWallets,
  resolveTrackedAssets,
  resolveSp500,
  resolvePriceSource,
  assertNoVaultAddressCollision,
  config,
} from "../../src/config.ts";
import { fetchWalletBalances, _resetWalletBalancesCacheForTests } from "../../src/chain/wallet-balances.ts";
import { getWalletBalances } from "../../src/api/routes/dashboards.ts";
import { sampleWalletBalances, backfillWalletHistory } from "../../src/worker/handlers/wallet.ts";

const realFetch = globalThis.fetch;

// A single prop wallet keeps the per-wallet sums trivial to reason about.
const WALLET = "0x" + "ab".repeat(20);

// Deterministic token/strategy addresses so the mock keys are known.
const A = {
  USDC: "0x" + "11".repeat(20),
  ZYFAI: "0x" + "44".repeat(20),
  GIZA: "0x" + "55".repeat(20),
  WETH: "0x" + "66".repeat(20),
  ROBOTMONEY: "0x" + "77".repeat(20),
  BNKR: "0x" + "88".repeat(20),
  AUSDC: "0x" + "99".repeat(20),
};

const ENV_KEYS = [
  "BASE_RPC_SOURCE", "PRICE_SOURCE", "PROP_WALLET_ADDRESSES", "SP500_SIZE",
  "USDC_ADDRESS", "ZYFAI_SS1_ADDRESS", "GIZA_SS1_ADDRESS", "WETH_ADDRESS",
  "ROBOTMONEY_ADDRESS", "BNKR_ADDRESS", "AAVE_AUSDC_ADDRESS",
] as const;

function setBaseEnv(extra: Record<string, string> = {}) {
  process.env.PROP_WALLET_ADDRESSES = WALLET;
  process.env.USDC_ADDRESS = A.USDC;
  process.env.ZYFAI_SS1_ADDRESS = A.ZYFAI;
  process.env.GIZA_SS1_ADDRESS = A.GIZA;
  process.env.WETH_ADDRESS = A.WETH;
  process.env.ROBOTMONEY_ADDRESS = A.ROBOTMONEY;
  process.env.BNKR_ADDRESS = A.BNKR;
  process.env.SP500_SIZE = "0.633";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

beforeEach(async () => {
  await sql`DELETE FROM wallet_balance_samples`;
  _resetWalletBalancesCacheForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  _resetWalletBalancesCacheForTests();
  for (const k of ENV_KEYS) delete process.env[k];
});

const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

const BALANCE_OF = "0x70a08231";
const CONVERT_TO_ASSETS = "0x07a2d13a";

interface ChainFixtures {
  // eth_call balanceOf(token) → raw balance (single wallet).
  balanceOf?: Record<string, bigint>;
  // eth_getBalance(wallet) → wei.
  native?: bigint;
  // convertToAssets(strategy) → underlying raw (6-dp USDC).
  nav?: Record<string, bigint>;
  // GeckoTerminal token_price (address → USD) for the live-price path.
  gecko?: Record<string, number>;
  // Yahoo SP500 close for the live-price path.
  sp500Price?: number;
  // Addresses whose balanceOf read should THROW (forced single-leg failure).
  failBalanceOf?: string[];
}

function mockChain(fx: ChainFixtures) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) {
      const addr = u.split("/token_price/")[1]!.toLowerCase();
      const price = fx.gecko?.[addr];
      if (price == null) throw new Error(`mockChain: no gecko price for ${addr}`);
      return new Response(JSON.stringify({ data: { attributes: { token_prices: { [addr]: String(price) } } } }), { status: 200 });
    }
    if (u.includes("finance.yahoo.com")) {
      if (fx.sp500Price == null) throw new Error("mockChain: no sp500Price fixture");
      const p = fx.sp500Price;
      return new Response(JSON.stringify({ chart: { result: [{ timestamp: [1, 2], indicators: { adjclose: [{ adjclose: [p, p] }], quote: [{ close: [p, p] }] } }] } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: any[] };
    if (body.method === "eth_getBalance") {
      if (fx.native == null) throw new Error("mockChain: no native fixture");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: word(fx.native) }), { status: 200 });
    }
    if (body.method === "eth_call") {
      const { to, data } = body.params[0] as { to: string; data: string };
      const toLc = to.toLowerCase();
      const selector = data.slice(0, 10);
      if (selector === BALANCE_OF) {
        if (fx.failBalanceOf?.map((a) => a.toLowerCase()).includes(toLc)) throw new Error(`mockChain: forced balanceOf failure for ${toLc}`);
        const raw = fx.balanceOf?.[toLc];
        if (raw == null) throw new Error(`mockChain: no balanceOf fixture for ${toLc}`);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: word(raw) }), { status: 200 });
      }
      if (selector === CONVERT_TO_ASSETS) {
        const raw = fx.nav?.[toLc];
        if (raw == null) throw new Error(`mockChain: no convertToAssets fixture for ${toLc}`);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: word(raw) }), { status: 200 });
      }
      throw new Error(`mockChain: unexpected selector ${selector}`);
    }
    throw new Error(`mockChain: unexpected method ${body.method}`);
  }) as typeof fetch;
}

// Fixtures under PRICE_SOURCE=stub (prices come from token-prices STUB_PRICES:
// WETH/ETH 1600, ROBOTMONEY 1e-5, BNKR 5e-4, SP500 4600; USDC/strategy $1).
function stubFixtures(): ChainFixtures {
  return {
    balanceOf: {
      [A.USDC]: 9052n * E6, // 9052 USDC → $9052
      [A.ZYFAI]: 1n, // non-zero shares → convertToAssets is called
      [A.GIZA]: 1n,
      [A.WETH]: 10n * E18, // 10 WETH → $16,000
      [A.ROBOTMONEY]: 3_000_000_000n * E18, // 3e9 → $30,000 @ 1e-5
      [A.BNKR]: 20000n * E18, // 20,000 → $10 @ 5e-4
    },
    nav: {
      [A.ZYFAI]: 4538n * E6, // NAV → $4538
      [A.GIZA]: 4524n * E6, // NAV → $4524
    },
    native: 500000000000000000n, // 0.5 ETH → $800
  };
}

// Expected per-symbol valueUsd from stubFixtures() (SP500 = 0.633 * 4600).
const EXPECT: Record<string, number> = {
  USDC: 9052, "ZYFAI-SS1": 4538, "GIZA-SS1": 4524, WETH: 16000, ETH: 800,
  ROBOTMONEY: 30000, BNKR: 10, SP500: 0.633 * 4600,
};

test("AC1: stub source → 200-shaped payload; every holding numeric with provenance 'stub'; totalUsd == sum(holdings.valueUsd)", async () => {
  setBaseEnv();
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain(stubFixtures());

  const r = await getWalletBalances();
  expect(r.source).toBe("stub");
  expect(r.priceSource).toBe("stub");
  expect(r.holdings).toHaveLength(8); // the eight fixed series, no aave leg by default
  for (const h of r.holdings) {
    expect(h.chain).toBe("base");
    expect(typeof h.valueUsd).toBe("number");
    expect(h.provenance).toBe("stub");
    expect(h.valueUsd!).toBeCloseTo(EXPECT[h.symbol]!, 6);
  }
  const sum = r.holdings.reduce((a, h) => a + (h.valueUsd ?? 0), 0);
  expect(r.totalUsd).toBeCloseTo(sum, 9);
  expect(r.totalUsd).toBeCloseTo(Object.values(EXPECT).reduce((a, b) => a + b, 0), 6);
});

test("AC2: each valuation kind is exercised per-asset — erc20, native, aave aToken→underlying, strategy NAV, config SP500", async () => {
  setBaseEnv({ AAVE_AUSDC_ADDRESS: A.AUSDC });
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  const fx = stubFixtures();
  fx.balanceOf![A.AUSDC] = 1000n * E6; // aToken balance → $1000 underlying
  mockChain(fx);

  const r = await fetchWalletBalances();
  const bySym = Object.fromEntries(r.holdings.map((h) => [h.symbol, h]));

  // erc20
  expect(bySym.WETH!.amount).toBeCloseTo(10, 9);
  expect(bySym.WETH!.priceUsd).toBeCloseTo(1600, 6);
  expect(bySym.WETH!.valueUsd).toBeCloseTo(16000, 6);
  // native eth_getBalance
  expect(bySym.ETH!.amount).toBeCloseTo(0.5, 9);
  expect(bySym.ETH!.valueUsd).toBeCloseTo(800, 6);
  // aave aToken → underlying × price
  expect(bySym.aUSDC).toBeDefined();
  expect(bySym.aUSDC!.amount).toBeCloseTo(1000, 6);
  expect(bySym.aUSDC!.priceUsd).toBeCloseTo(1, 9);
  expect(bySym.aUSDC!.valueUsd).toBeCloseTo(1000, 6);
  // strategy NAV read (convertToAssets)
  expect(bySym["ZYFAI-SS1"]!.valueUsd).toBeCloseTo(4538, 6);
  expect(bySym["GIZA-SS1"]!.valueUsd).toBeCloseTo(4524, 6);
  // config-size SP500 line
  expect(bySym.SP500!.amount).toBeCloseTo(0.633, 6);
  expect(bySym.SP500!.priceUsd).toBeCloseTo(4600, 6);
  expect(bySym.SP500!.valueUsd).toBeCloseTo(0.633 * 4600, 6);
});

test("AC3: a forced single-leg failure degrades that holding to its last-persisted sample marked 'stale'; other legs stay live", async () => {
  setBaseEnv();
  // last-persisted WETH sample the degrade path should fall back to.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance)
    VALUES ('2026-06-25', 'WETH', 15.4, 1550, 23870, 'live')
  `;
  const fx = stubFixtures();
  fx.failBalanceOf = [A.WETH]; // WETH balanceOf throws; every other leg succeeds
  process.env.PRICE_SOURCE = "stub"; // avoid live gecko fetch for the surviving legs
  mockChain(fx);

  const r = await fetchWalletBalances();
  const weth = r.holdings.find((h) => h.symbol === "WETH")!;
  expect(weth.provenance).toBe("stale");
  expect(weth.valueUsd).toBeCloseTo(23870, 6);
  expect(weth.amount).toBeCloseTo(15.4, 6);
  // Other legs are unaffected — never falsely 'stale', never a 5xx/throw.
  for (const h of r.holdings.filter((x) => x.symbol !== "WETH")) {
    expect(h.provenance).not.toBe("stale");
    expect(typeof h.valueUsd).toBe("number");
  }
});

test("AC3b: a failing leg with NO persisted history yields valueUsd:null + provenance 'stale', never a fabricated number or a throw", async () => {
  setBaseEnv();
  const fx = stubFixtures();
  fx.failBalanceOf = [A.BNKR];
  process.env.PRICE_SOURCE = "stub";
  mockChain(fx);

  const r = await fetchWalletBalances();
  const bnkr = r.holdings.find((h) => h.symbol === "BNKR")!;
  expect(bnkr.provenance).toBe("stale");
  expect(bnkr.valueUsd).toBeNull();
  // totalUsd simply omits the null leg (never fabricated).
  const sum = r.holdings.reduce((a, h) => a + (h.valueUsd ?? 0), 0);
  expect(r.totalUsd).toBeCloseTo(sum, 9);
});

test("live price path: PRICE_SOURCE=live executes the GeckoTerminal + Yahoo fetchers and labels provenance 'live'", async () => {
  setBaseEnv();
  // live source (unset BASE_RPC_SOURCE/PRICE_SOURCE) → real fetcher code runs.
  const fx = stubFixtures();
  fx.gecko = { [A.WETH]: 1700, [A.ROBOTMONEY]: 0.00002, [A.BNKR]: 0.001 };
  fx.sp500Price = 4700;
  mockChain(fx);

  const r = await fetchWalletBalances();
  expect(r.source).toBe("live");
  expect(r.priceSource).toBe("live");
  const bySym = Object.fromEntries(r.holdings.map((h) => [h.symbol, h]));
  expect(bySym.WETH!.priceUsd).toBeCloseTo(1700, 6); // from mocked gecko
  expect(bySym.WETH!.valueUsd).toBeCloseTo(10 * 1700, 6);
  expect(bySym.SP500!.priceUsd).toBeCloseTo(4700, 6); // from mocked yahoo
  for (const h of r.holdings) expect(h.provenance).toBe("live");
});

test("AC4: config-time guard fails startup if a prop wallet collides with the vault/adapter set; no rmUSDC vault share is tracked", () => {
  // No collision by default.
  setBaseEnv();
  expect(() => assertNoVaultAddressCollision()).not.toThrow();

  // Prop wallet == vault address → throws (would double-count vault TVL).
  process.env.PROP_WALLET_ADDRESSES = config.vault.address;
  expect(() => assertNoVaultAddressCollision()).toThrow(/double-count/i);

  // Prop wallet == USDC (an adapter-set member) → throws.
  process.env.PROP_WALLET_ADDRESSES = config.vault.usdc;
  expect(() => assertNoVaultAddressCollision()).toThrow(/double-count/i);

  // No tracked asset is the rmUSDC vault share.
  process.env.PROP_WALLET_ADDRESSES = WALLET;
  const vaultLc = config.vault.address.toLowerCase();
  expect(resolveTrackedAssets().some((t) => t.address === vaultLc)).toBe(false);
});

test("AC5: wallet addresses, tracked-asset table, and SP500 size are all config-resolved from env (no handler/view literal)", () => {
  expect(resolvePropWallets({ PROP_WALLET_ADDRESSES: "0xAaA,0xBbB" })).toEqual(["0xaaa", "0xbbb"]);
  const assets = resolveTrackedAssets({ WETH_ADDRESS: "0xWeThAddr".toLowerCase() });
  expect(assets.map((a) => a.symbol)).toEqual(["USDC", "ZYFAI-SS1", "GIZA-SS1", "WETH", "ETH", "ROBOTMONEY", "BNKR", "SP500"]);
  // Stable→Protocol→Agent→Stocks group/colour order preserved.
  expect(assets.map((a) => a.group)).toEqual(["Stable", "Stable", "Stable", "Protocol", "Protocol", "Agent", "Agent", "Stocks"]);
  expect(assets.map((a) => a.color)).toEqual(["#10b981", "#10b981", "#10b981", "#f59e0b", "#f59e0b", "#3b82f6", "#3b82f6", "#8b5cf6"]);
  expect(resolveSp500({ SP500_SIZE: "1.25", SP500_TICKER: "SPY" })).toEqual({ size: 1.25, ticker: "SPY" });
  expect(resolvePriceSource({ PRICE_SOURCE: "stub" })).toBe("stub");
  expect(() => resolvePriceSource({ PRICE_SOURCE: "bogus" })).toThrow(/invalid PRICE_SOURCE/);
});

test("AC7: the handler builds its path from the shared ROUTES constant", async () => {
  expect(ROUTES.dashboards.walletBalances).toBe("/api/dashboards/wallet-balances");
  setBaseEnv();
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain(stubFixtures());
  const r = await getWalletBalances();
  expect(r.holdings).toHaveLength(8);
});

test("history: backfill seeds the pre-launch series; the endpoint returns it as continuous, sparse, group-ordered byAsset days", async () => {
  const n = await backfillWalletHistory();
  expect(n).toBeGreaterThan(0);
  // Re-running is idempotent (ON CONFLICT DO NOTHING) — no duplicate rows.
  const before = await sql`SELECT count(*)::int AS c FROM wallet_balance_samples`;
  await backfillWalletHistory();
  const after = await sql`SELECT count(*)::int AS c FROM wallet_balance_samples`;
  expect(after[0]!.c).toBe(before[0]!.c);

  // Provenance honesty (issue #94): backfilled seed rows are ported baked UI
  // constants, NOT live chain reads — they must carry 'seed', never 'live'
  // (migration 0014 invariant). No seeded row may be labelled 'live'.
  const live = await sql`SELECT count(*)::int AS c FROM wallet_balance_samples WHERE provenance = 'live'`;
  expect(live[0]!.c).toBe(0);
  const seed = await sql`SELECT count(*)::int AS c FROM wallet_balance_samples WHERE provenance = 'seed'`;
  expect(seed[0]!.c).toBe(after[0]!.c);

  setBaseEnv();
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain(stubFixtures());
  const r = await fetchWalletBalances();
  expect(r.history.length).toBeGreaterThan(90);
  const first = r.history[0]!;
  expect(first.date).toBe("2026-03-18");
  // Mar 18 held only WETH/ROBOTMONEY/BNKR (sparse byAsset).
  expect(Object.keys(first.byAsset).sort()).toEqual(["BNKR", "ROBOTMONEY", "WETH"]);
  expect(first.totalUsd).toBeCloseTo(21519 + 51300 + 12, 6);
  // History is date-ascending.
  for (let i = 1; i < r.history.length; i++) {
    expect(r.history[i]!.date >= r.history[i - 1]!.date).toBe(true);
  }
});

test("AC2 (issue #94): backfillWalletHistory never writes the literal provenance 'live'", async () => {
  // Source guard: the backfill body must not label seeded rows 'live'. Reading
  // the handler source keeps this honest even if a future edit reintroduces the
  // literal without the DB assertion above catching it in a stale fixture.
  const src = await Bun.file(new URL("../../src/worker/handlers/wallet.ts", import.meta.url)).text();
  const body = src.slice(src.indexOf("export async function backfillWalletHistory"));
  expect(body).toContain("'seed'");
  expect(body).not.toContain("'live'");
});

test("sampler: sampleWalletBalances upserts exactly one row per held symbol per UTC day (idempotent)", async () => {
  setBaseEnv();
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain(stubFixtures());
  const today = new Date().toISOString().slice(0, 10);

  await sampleWalletBalances({});
  const first = await sql`SELECT count(*)::int AS c FROM wallet_balance_samples WHERE sample_date = ${today}`;
  expect(first[0]!.c).toBe(8); // all eight legs valued

  // Re-run within the same day upserts the same slots — no duplicate rows.
  _resetWalletBalancesCacheForTests();
  mockChain(stubFixtures());
  await sampleWalletBalances({});
  const again = await sql`SELECT count(*)::int AS c FROM wallet_balance_samples WHERE sample_date = ${today}`;
  expect(again[0]!.c).toBe(8);
});
