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
import { resolveVaultAdapters, isPlaceholderAddress, resolveBuybackConfig, resolveTrackedAssets } from "../../src/config.ts";
import { decodeAggregate3Calls, encodeAggregate3Result, type Aggregate3Result } from "../../src/chain/base-rpc-client.ts";
import { getBuybacks, getTokenMetrics, getWalletSleeves, getAllocation } from "../../src/api/routes/dashboards.ts";
import { _resetBuybackCacheForTests, indexBuybacks } from "../../src/chain/buyback-logs.ts";
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

// A deterministic Base-RPC + price mock. eth_call answers by selector — both
// single calls (token-metrics) and Multicall3 aggregate3 batches (the batched
// wallet-sleeves path), whose sub-calls are answered by the same selector rules.
// `failBalanceOfTargets` reverts JUST those targets' balanceOf sub-calls
// (success:false — an allowFailure revert), `failCall` throws the whole POST,
// and `failPrice` throws the gecko/yahoo hosts so each degrade path is
// exercised. Returns a counter of aggregate3 eth_calls served — the batched
// call count the sleeves tests assert (mirrors api/wallet-balances.test.ts).
const TOTAL_SUPPLY = "0x18160ddd";
const BALANCE_OF = "0x70a08231";
const CONVERT_TO_ASSETS = "0x07a2d13a";
const GET_ETH_BALANCE = "0x4d2301cc"; // Multicall3 getEthBalance(address)
const AGGREGATE3 = "0x82ad56cb"; // Multicall3 aggregate3(Call3[])
function mockChain(opts: { totalSupply?: bigint; failPrice?: boolean; failCall?: boolean; failBalanceOfTargets?: string[] } = {}) {
  const counter = { aggregateCalls: 0 };
  // One aggregate3 sub-call, answered with the same fixtures the single-call
  // branch serves; a target in failBalanceOfTargets reverts (success:false).
  const subResult = (target: string, callData: string): Aggregate3Result => {
    const sel = callData.slice(0, 10);
    if (sel === GET_ETH_BALANCE) return { success: true, returnData: word(50_000_000_000_000_000n) };
    if (sel === BALANCE_OF) {
      if (opts.failBalanceOfTargets?.some((a) => a.toLowerCase() === target.toLowerCase())) return { success: false, returnData: "0x" };
      return { success: true, returnData: word(1_000_000n) };
    }
    if (sel === CONVERT_TO_ASSETS) return { success: true, returnData: word(4_500_000_000n) };
    throw new Error(`mockChain: unexpected sub-call selector ${sel}`);
  };
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
      const data = (body.params[0] as { data: string }).data;
      const sel = data.slice(0, 10);
      if (sel === AGGREGATE3) {
        counter.aggregateCalls += 1;
        const results = decodeAggregate3Calls(data).map((c) => subResult(c.target, c.callData));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAggregate3Result(results) }), { status: 200 });
      }
      if (sel === TOTAL_SUPPLY) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(opts.totalSupply ?? 84_102_550_000n) }), { status: 200 });
      if (sel === BALANCE_OF) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(1_000_000n) }), { status: 200 });
      if (sel === CONVERT_TO_ASSETS) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word(4_500_000_000n) }), { status: 200 });
    }
    throw new Error(`mockChain: unexpected ${body.method}`);
  }) as typeof fetch;
  return counter;
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
test("wallet-sleeves: per-wallet holdings resolve in ≤2 batched eth_calls; totalUsd == sum(holdings.valueUsd); placeholder BNKR is never eth_called", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  const counter = mockChain();
  const r = await getWalletSleeves();
  // Multicall3 batching (finding 007): ALL sleeves' chain legs land in round-1
  // balances + round-2 strategy NAV — TWO aggregate3 eth_calls, never a
  // per-holding fan-out (mirrors the wallet-balances AC3-batch assertion).
  expect(counter.aggregateCalls).toBe(2);
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

test("wallet-sleeves: ONE reverted sub-call degrades ONLY that holding to stale; every other leg stays valued (per-leg honesty in the batch)", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  // Revert JUST the WETH balanceOf sub-call (an allowFailure success:false —
  // the batched analogue of a single reverted eth_call).
  const weth = resolveTrackedAssets().find((a) => a.symbol === "WETH")!.address!;
  const counter = mockChain({ failBalanceOfTargets: [weth] });
  const r = await getWalletSleeves();
  expect(counter.aggregateCalls).toBe(2); // the failure never falls back to per-leg calls
  const bankr = r.wallets.find((w) => w.type === "primary")!;
  const wethHolding = bankr.holdings.find((h) => h.symbol === "WETH")!;
  // The reverted leg is honestly degraded: null values, provenance 'stale'.
  expect(wethHolding.amount).toBeNull();
  expect(wethHolding.priceUsd).toBeNull();
  expect(wethHolding.valueUsd).toBeNull();
  expect(wethHolding.provenance).toBe("stale");
  // Every OTHER holding (this sleeve and the strategy sleeves) stays valued.
  for (const h of r.wallets.flatMap((w) => w.holdings).filter((h) => h.symbol !== "WETH")) {
    expect(h.provenance).toBe("stub");
    expect(typeof h.valueUsd).toBe("number");
  }
  // The stale flags roll up: the degraded sleeve + the top level, ONLY those.
  expect(bankr.stale).toBe(true);
  expect(r.stale).toBe(true);
  for (const w of r.wallets.filter((w) => w.type === "strategy")) expect(w.stale).toBe(false);
});

test("wallet-sleeves: a THROWN batch (forced RPC failure) degrades every holding to value null + provenance 'stale' (never fabricated)", async () => {
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
  expect(r.stale).toBe(true);
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

// ── buyback indexer: persisted scan cursor (regression: stuck-at-floor) ──────
test("buyback indexer advances a persisted scan cursor across empty windows and resumes past it (never restarts from the floor)", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  process.env.BUYBACK_FROM_BLOCK = "1000";
  process.env.BUYBACK_LOG_CHUNK = "100";
  process.env.BUYBACK_MAX_CHUNKS = "3"; // 3×100 = 300 blocks covered per run
  const LATEST = 100_000; // far beyond one run's reach → cursor must carry across runs
  // Empty-log chain: eth_blockNumber → tip, eth_getLogs → [] (no buybacks found),
  // gecko → a WETH price. If progress depended on finding a row, the cursor would
  // never move; this proves it advances on scan coverage alone.
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) {
      const addr = u.split("/token_price/")[1]?.toLowerCase() ?? "x";
      return new Response(JSON.stringify({ data: { attributes: { token_prices: { [addr]: "2000" } } } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + LATEST.toString(16) }), { status: 200 });
    if (body.method === "eth_getLogs") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
    throw new Error(`unexpected ${body.method}`);
  }) as typeof fetch;
  try {
    await sql`DELETE FROM buyback_scan_state`;
    const r1 = await indexBuybacks();
    const c1 = await sql<{ b: string }[]>`SELECT last_scanned_block::text AS b FROM buyback_scan_state WHERE id = 1`;
    // from=floor 1000; three 100-block chunks → last window ends at 1299.
    expect(r1.scannedToBlock).toBe(1299);
    expect(Number(c1[0]!.b)).toBe(1299);

    const r2 = await indexBuybacks();
    const c2 = await sql<{ b: string }[]>`SELECT last_scanned_block::text AS b FROM buyback_scan_state WHERE id = 1`;
    // Resumes at cursor+1 (1300), NOT the floor → advances another 300 blocks.
    expect(r2.scannedToBlock).toBe(1599);
    expect(Number(c2[0]!.b)).toBe(1599);
  } finally {
    for (const k of ["BUYBACK_FROM_BLOCK", "BUYBACK_LOG_CHUNK", "BUYBACK_MAX_CHUNKS"]) delete process.env[k];
    await sql`DELETE FROM buyback_scan_state`;
    _resetBuybackCacheForTests();
  }
});
