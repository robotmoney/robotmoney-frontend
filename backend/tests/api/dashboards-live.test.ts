// The four new live-data dashboard handlers (live-data contract #50 honesty):
//   GET /api/dashboards/buybacks       → chain/buyback-logs.ts (buyback_swaps table)
//   GET /api/dashboards/token-metrics  → chain/token-metrics.ts (supply/price/marketCap)
//   GET /api/dashboards/wallet-sleeves → chain/wallet-sleeves.ts (per-wallet holdings)
//   GET /api/dashboards/allocation     → chain/allocation-framework.ts (managed weights)
//
// Same discipline as tests/api/wallet-balances.test.ts: a mocked fetch transport
// for the Base RPC + keyless price hosts, run against the REAL (ephemeral)
// Postgres provisioned by tests/preload.ts — never a reachable RPC/price host.
// Postgres is REQUIRED: preload throws (loud, not skip) when it is absent, so
// every DB assertion below is genuine coverage under the test-coverage policy.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { resolveVaultAdapters, isPlaceholderAddress, resolveBuybackConfig } from "../../src/config.ts";
import { getBuybacks, getTokenMetrics, getWalletSleeves, getAllocation } from "../../src/api/routes/dashboards.ts";
import { _resetBuybackCacheForTests } from "../../src/chain/buyback-logs.ts";
import { _resetTokenMetricsCacheForTests } from "../../src/chain/token-metrics.ts";
import { _resetWalletSleevesCacheForTests } from "../../src/chain/wallet-sleeves.ts";
import { _resetAllocationFrameworkCacheForTests, ALLOCATION_FRAMEWORK_SEED } from "../../src/chain/allocation-framework.ts";

const realFetch = globalThis.fetch;
const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");

const ENV_KEYS = ["BASE_RPC_SOURCE", "PRICE_SOURCE"] as const;

function resetCaches() {
  _resetBuybackCacheForTests();
  _resetTokenMetricsCacheForTests();
  _resetWalletSleevesCacheForTests();
  _resetAllocationFrameworkCacheForTests();
}

beforeEach(resetCaches);
afterEach(() => {
  globalThis.fetch = realFetch;
  resetCaches();
  for (const k of ENV_KEYS) delete process.env[k];
});

// A deterministic Base-RPC + price mock. eth_call answers by selector; a symbol
// in `failSelectors` throws (forced single-leg failure); gecko/yahoo throw when
// `failPrice` is set so the live-price degrade path is exercised.
const TOTAL_SUPPLY = "0x18160ddd";
const BALANCE_OF = "0x70a08231";
const CONVERT_TO_ASSETS = "0x07a2d13a";
function mockChain(opts: { totalSupply?: bigint; failPrice?: boolean; failCall?: boolean } = {}) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com") || u.includes("finance.yahoo.com")) {
      if (opts.failPrice) throw new Error("mockChain: forced price failure");
      const addr = u.split("/token_price/")[1]?.toLowerCase() ?? "x";
      return new Response(JSON.stringify({ data: { attributes: { token_prices: { [addr]: "0.5" } } } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: any[] };
    if (opts.failCall) throw new Error("mockChain: forced RPC failure");
    if (body.method === "eth_getBalance") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(50_000_000_000_000_000n) }), { status: 200 });
    if (body.method === "eth_call") {
      const sel = (body.params[0] as { data: string }).data.slice(0, 10);
      if (sel === TOTAL_SUPPLY) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(opts.totalSupply ?? 84_102_550_000n) }), { status: 200 });
      if (sel === BALANCE_OF) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(1_000_000n) }), { status: 200 });
      if (sel === CONVERT_TO_ASSETS) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(4_500_000_000n) }), { status: 200 });
    }
    throw new Error(`mockChain: unexpected ${body.method}`);
  }) as typeof fetch;
}

// ── route wiring ────────────────────────────────────────────────────────────
test("contract exposes the four new dashboard routes", () => {
  expect(ROUTES.dashboards.buybacks).toBe("/api/dashboards/buybacks");
  expect(ROUTES.dashboards.tokenMetrics).toBe("/api/dashboards/token-metrics");
  expect(ROUTES.dashboards.walletSleeves).toBe("/api/dashboards/wallet-sleeves");
  expect(ROUTES.dashboards.allocation).toBe("/api/dashboards/allocation");
});

// ── config: the original "Not configured" bug fix (#50) ─────────────────────
test("resolveVaultAdapters(): the three real default adapter addresses now report configured:true", () => {
  const adapters = resolveVaultAdapters({}); // no ADAPTER_* overrides → real baked defaults
  expect(adapters).toHaveLength(3);
  expect(adapters.map((a) => a.name)).toEqual(["Morpho", "Aave", "Compound"]);
  for (const a of adapters) {
    expect(a.configured).toBe(true); // the bug: these used to be non-functional placeholders (configured:false)
    expect(isPlaceholderAddress(a.address)).toBe(false);
  }
});

test("resolveVaultAdapters(): a repeating-digit placeholder override flips configured back to false", () => {
  const adapters = resolveVaultAdapters({ ADAPTER_MORPHO_ADDRESS: "0x1111111111111111111111111111111111111111" });
  const morpho = adapters.find((a) => a.name === "Morpho")!;
  expect(morpho.configured).toBe(false);
  expect(isPlaceholderAddress("0x2222222222222222222222222222222222222222")).toBe(true);
  expect(isPlaceholderAddress(null)).toBe(true);
});

test("resolveBuybackConfig(): primary wallet is the first real prop wallet; token/weth are real", () => {
  const cfg = resolveBuybackConfig({});
  expect(cfg.primaryWallet).toBe("0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6");
  expect(isPlaceholderAddress(cfg.robotmoneyToken)).toBe(false);
  expect(isPlaceholderAddress(cfg.wethToken)).toBe(false);
  expect(cfg.source).toBe("live"); // default source is live
});

// ── buybacks ────────────────────────────────────────────────────────────────
test("buybacks: stub source serves the seeded 10 real historical rows with matching totals; not stale", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  const r = await getBuybacks();
  expect(r.source).toBe("stub");
  expect(r.rows).toHaveLength(10);
  for (const row of r.rows) {
    expect(row.provenance).toBe("seed");
    expect(row.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row.date).toBe("2026-03-23");
    expect(typeof row.valueUsd).toBe("number");
  }
  // totals are the sum of the persisted rows, never a fabricated scalar.
  const sum = r.rows.reduce((a, x) => a + x.valueUsd, 0);
  expect(r.totals.valueUsd).toBeCloseTo(Math.round(sum * 100) / 100, 6);
  expect(r.totals.wethSpent).toBeCloseTo(1.149114, 6);
  expect(r.totals.robotmoneyReceived).toBe(178_840_000);
  // stub seeds ARE the intended fixture → not degraded/stale.
  expect(r.stale).toBe(false);
});

test("buybacks: a LIVE source with only seed rows is reported stale (no row was indexed live)", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  const r = await getBuybacks();
  expect(r.source).toBe("live");
  expect(r.rows.length).toBeGreaterThan(0);
  expect(r.rows.every((x) => x.provenance !== "live")).toBe(true);
  expect(r.stale).toBe(true); // honest degrade: claims live but nothing is live
});

// ── token-metrics ───────────────────────────────────────────────────────────
test("token-metrics: stub source → fixture supply + stub price + computed marketCap + fixed fee split; not stale", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain();
  const r = await getTokenMetrics();
  expect(r.source).toBe("stub");
  expect(r.robotmoney.totalSupply).toBe(55_000_000_000);
  expect(r.robotmoney.priceUsd).toBeCloseTo(0.00001, 12);
  expect(r.robotmoney.marketCapUsd).toBeCloseTo(Math.round(55_000_000_000 * 0.00001 * 100) / 100, 6);
  expect(r.feeSplit).toEqual([{ label: "Protocol", pct: 57 }, { label: "Bankr", pct: 40 }, { label: "Clanker", pct: 3 }]);
  expect(r.stale).toBe(false);
});

test("token-metrics: a LIVE supply read is decoded from the chain (callTotalSupply path executes, 18dp normalized)", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  process.env.PRICE_SOURCE = "stub"; // stub the price leg so only the supply leg hits the mocked RPC
  const rawSupply = 55_000_000_000n * 10n ** 18n; // 55B tokens, 18dp on-chain word
  mockChain({ totalSupply: rawSupply });
  const r = await getTokenMetrics();
  expect(r.robotmoney.totalSupply).toBeCloseTo(55_000_000_000, 0); // decoded + normalized by /1e18
  expect(r.stale).toBe(false);
});

test("token-metrics: a failed live price leg degrades priceUsd + marketCap to null with stale:true (never fabricated)", async () => {
  process.env.BASE_RPC_SOURCE = "stub"; // supply from the fixture
  process.env.PRICE_SOURCE = "live"; // price leg goes live and is forced to fail
  mockChain({ failPrice: true });
  const r = await getTokenMetrics();
  expect(r.robotmoney.totalSupply).toBe(55_000_000_000); // supply still resolves
  expect(r.robotmoney.priceUsd).toBeNull();
  expect(r.robotmoney.marketCapUsd).toBeNull();
  expect(r.stale).toBe(true);
});

// ── wallet-sleeves ──────────────────────────────────────────────────────────
test("wallet-sleeves: per-wallet holdings; totalUsd == sum(holdings.valueUsd); placeholder BNKR is never eth_called", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain();
  const r = await getWalletSleeves();
  expect(r.source).toBe("stub");
  expect(r.wallets).toHaveLength(3);
  const bankr = r.wallets.find((w) => w.type === "primary")!;
  // BNKR default is a repeating-digit placeholder → omitted, not rendered $0.
  expect(bankr.holdings.map((h) => h.symbol)).not.toContain("BNKR");
  for (const w of r.wallets) {
    for (const h of w.holdings) {
      expect(h.provenance).toBe("stub");
      expect(typeof h.valueUsd).toBe("number");
    }
    const sum = Math.round(w.holdings.reduce((a, h) => a + (h.valueUsd ?? 0), 0) * 100) / 100;
    expect(w.totalUsd).toBeCloseTo(sum, 6);
  }
  // strategy sleeves hold exactly their delegated ERC-4626 share.
  expect(r.wallets.filter((w) => w.type === "strategy").map((w) => w.holdings.map((h) => h.symbol))).toEqual([["ZYFAI-SS1"], ["GIZA-SS1"]]);
});

test("wallet-sleeves: a forced RPC failure degrades every holding to value null + provenance 'stale' (never fabricated)", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain({ failCall: true });
  const r = await getWalletSleeves();
  const holdings = r.wallets.flatMap((w) => w.holdings);
  expect(holdings.length).toBeGreaterThan(0);
  for (const h of holdings) {
    expect(h.valueUsd).toBeNull();
    expect(h.provenance).toBe("stale");
  }
});

// ── allocation ──────────────────────────────────────────────────────────────
test("allocation: seeded committee framework → 4 buckets, exact pct conversion, managed:true", async () => {
  const r = await getAllocation();
  expect(r.managed).toBe(true);
  expect(r.buckets.map((b) => b.key)).toEqual(["defi-yield", "agent-tokens", "protocol-tokens", "rwa"]);
  const strat = Object.fromEntries(r.strategy.map((s) => [s.label, s.targetPct]));
  expect(strat["Conservative DeFi Yield"]).toBe(95); // 0.95 → 95, not a losing int round
  expect(strat["Agent Tokens"]).toBe(5);
  // fractional item weight preserved to 2dp (0.1429 → 14.29).
  const agent = r.buckets.find((b) => b.key === "agent-tokens")!;
  expect(agent.items.find((i) => i.label === "RobotMoney")!.targetPct).toBe(14.29);
});

test("allocation: with the row absent, getAllocation falls back to the committee seed default (managed data is static, not a degraded chain read)", async () => {
  // Genuinely exercise the row-absent branch on the shared pool, then restore the
  // seeded row so the suite's DB state is unchanged.
  try {
    await sql`DELETE FROM allocation_framework WHERE id = 1`;
    resetCaches();
    const r = await getAllocation();
    expect(r.managed).toBe(true);
    expect(r.buckets).toHaveLength(4); // served from ALLOCATION_FRAMEWORK_SEED, not a chain read
    expect(r.strategy.find((s) => s.label === "Conservative DeFi Yield")!.targetPct).toBe(95);
  } finally {
    // Restore the committee seed row (id=1) exactly as db/seed.ts wrote it.
    await sql`
      INSERT INTO allocation_framework (id, asof, vault_contract, buckets)
      VALUES (1, ${ALLOCATION_FRAMEWORK_SEED.asof}, ${ALLOCATION_FRAMEWORK_SEED.vault_contract},
              ${sql.json(ALLOCATION_FRAMEWORK_SEED.buckets as unknown as object)})
      ON CONFLICT (id) DO NOTHING
    `;
    resetCaches();
  }
});
