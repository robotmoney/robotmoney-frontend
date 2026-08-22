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
import { jsonValue, sql } from "../../src/db/client.ts";
import { fileURLToPath } from "node:url";
import {
  resolveVaultAdapters,
  isPlaceholderAddress,
  resolveBuybackConfig,
  resolveTrackedAssets,
  resolvePropWallets,
  BUYBACK_FROM_BLOCK,
  BUYBACK_LOG_CHUNK,
  BUYBACK_MAX_CHUNKS,
} from "../../src/config.ts";
import { decodeAggregate3Calls, encodeAggregate3Result, type Aggregate3Result } from "../../src/chain/base-rpc-client.ts";
import { getBuybacks, getTokenMetrics, getWalletSleeves, getAllocation } from "../../src/api/routes/dashboards.ts";
import { _resetBuybackCacheForTests, indexBuybacks } from "../../src/chain/buyback-logs.ts";
import { _resetTokenMetricsCacheForTests } from "../../src/chain/token-metrics.ts";
import { sampleWalletSleeves } from "../../src/worker/handlers/wallet.ts";
import {
  _resetWalletSleevesCacheForTests,
  getWalletSleeves as readWalletSleeves,
  type WalletSleeveReaders,
} from "../../src/chain/wallet-sleeves.ts";
import { _resetAllocationFrameworkCacheForTests, ALLOCATION_FRAMEWORK_SEED } from "../../src/chain/allocation-framework.ts";
import { _resetTokenPriceCacheForTests } from "../../src/chain/token-prices.ts";

const realFetch = globalThis.fetch;
const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");

const ENV_KEYS = ["BASE_RPC_SOURCE", "PRICE_SOURCE"] as const;

async function resetCaches() {
  _resetBuybackCacheForTests();
  _resetTokenMetricsCacheForTests();
  _resetWalletSleevesCacheForTests();
  _resetAllocationFrameworkCacheForTests();
  _resetTokenPriceCacheForTests();
  await sql`DELETE FROM wallet_sleeve_samples`;
  await sql`DELETE FROM vault_adapter_samples`;
}

beforeEach(async () => {
  await resetCaches();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await resetCaches();
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
      // token_price takes a comma-separated address list (token-prices.ts
      // micro-batches same-burst legs into one request) — answer every
      // requested address at the fixed fixture price.
      const addrs = (u.split("/token_price/")[1] ?? "x").toLowerCase().split(",");
      return new Response(JSON.stringify({ data: { attributes: { token_prices: Object.fromEntries(addrs.map((a) => [a, "0.5"])) } } }), { status: 200 });
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
  }) as unknown as typeof fetch;
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
test("wallet-sleeves: per-wallet holdings resolve in ≤2 batched eth_calls; totalUsd == sum(holdings.valueUsd); BNKR resolves like every other configured asset (issue #148)", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  const counter = mockChain();
  await sampleWalletSleeves({});
  const r = await getWalletSleeves();
  // TWO rounds, and the bound in the title is what matters. This mock answers
  // EVERY balanceOf with a non-zero word, so since issue #642 baked the real
  // ERC-4626 vault addresses into the strategy position list, both strategy
  // accounts report non-zero vault shares here and round 2 (convertToAssets)
  // legitimately fires. The invariant being guarded is that the count never
  // scales with wallet/asset count — not that it is exactly one.
  expect(counter.aggregateCalls).toBe(2);
  expect(counter.aggregateCalls).toBeLessThanOrEqual(2);
  expect(r.source).toBe("stub");
  expect(r.wallets).toHaveLength(3);
  const bankr = r.wallets.find((w) => w.type === "primary")!;
  expect(isPlaceholderAddress(resolveTrackedAssets().find((a) => a.symbol === "BNKR")!.address)).toBe(false);
  expect(bankr.holdings.map((h) => h.symbol)).toEqual(["USDC", "ROBOTMONEY", "WETH", "ETH", "BNKR"]);
  for (const w of r.wallets) {
    for (const h of w.holdings) {
      expect(h.provenance).toBe("stub");
      expect(typeof h.valueUsd).toBe("number");
    }
    const sum = Math.round(w.holdings.reduce((a, h) => a + (h.valueUsd ?? 0), 0) * 100) / 100;
    expect(w.totalUsd).toBeCloseTo(sum, 6);
  }
  expect(r.wallets.filter((w) => w.type === "strategy").map((w) => w.holdings.map((h) => h.symbol))).toEqual([["ZYFAI-SS1"], ["GIZA-SS1"]]);
});

test("wallet-sleeves: ONE reverted sub-call degrades ONLY that holding to stale; every other leg stays valued (per-leg honesty in the batch)", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  const weth = resolveTrackedAssets().find((a) => a.symbol === "WETH")!.address!;
  const counter = mockChain({ failBalanceOfTargets: [weth] });
  await sampleWalletSleeves({});
  const r = await getWalletSleeves();
  // Two rounds for the same reason as the test above (issue #642 baked the
  // vault addresses; this mock reports a non-zero share balance for them), and
  // still bounded — a reverted leg does not add a round.
  expect(counter.aggregateCalls).toBe(2);
  expect(counter.aggregateCalls).toBeLessThanOrEqual(2);
  const bankr = r.wallets.find((w) => w.type === "primary")!;
  const wethHolding = bankr.holdings.find((h) => h.symbol === "WETH")!;
  expect(wethHolding.amount).toBeNull();
  expect(wethHolding.priceUsd).toBeNull();
  expect(wethHolding.valueUsd).toBeNull();
  expect(wethHolding.provenance).toBe("stale");
  for (const h of r.wallets.flatMap((w) => w.holdings).filter((h) => h.symbol !== "WETH")) {
    expect(h.provenance).toBe("stub");
    expect(typeof h.valueUsd).toBe("number");
  }
  expect(bankr.stale).toBe(true);
  expect(r.stale).toBe(true);
  for (const w of r.wallets.filter((w) => w.type === "strategy")) expect(w.stale).toBe(false);
});

test("wallet-sleeves: a THROWN batch (forced RPC failure) degrades every holding to value null + provenance 'stale' (never fabricated)", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  await sql`DELETE FROM wallet_sleeve_samples`;
  mockChain({ failCall: true });
  await sampleWalletSleeves({}).catch(() => {});
  const r = await getWalletSleeves();
  const holdings = r.wallets.flatMap((w) => w.holdings);
  expect(holdings.length).toBeGreaterThan(0);
  for (const h of holdings) {
    expect(h.valueUsd).toBeNull();
    expect(h.provenance).toBe("stale");
  }
  expect(r.stale).toBe(true);
});

test("wallet-sleeves (#173): a failed live price read falls back to a recent persisted wallet_balance_samples price; the chain amount stays fresh and an over-age/missing sample still degrades honestly", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  process.env.PRICE_SOURCE = "live";
  mockChain({ failPrice: true });

  const fresh = new Date(Date.now() - 60_000);
  const tooOld = new Date(Date.now() - 6 * 60_000);
  await sql`DELETE FROM wallet_balance_samples`;
  await sql`DELETE FROM wallet_sleeve_samples`;
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES
      (current_date, 'WETH', 1, 2500, 2500, 'live', ${fresh}),
      (current_date - 1, 'ROBOTMONEY', 1, 0.00002, 0.00002, 'live', ${tooOld})
  `;
  try {
    await sampleWalletSleeves({});
    const r = await getWalletSleeves();
    const bankr = r.wallets.find((w) => w.type === "primary")!;

    const weth = bankr.holdings.find((h) => h.symbol === "WETH")!;
    expect(weth.priceUsd).toBe(2500);
    expect(weth.provenance).toBe("stale");
    expect(weth.amount).not.toBeNull();
    expect(weth.valueUsd).toBeCloseTo(weth.amount! * 2500, 6);

    const robotmoney = bankr.holdings.find((h) => h.symbol === "ROBOTMONEY")!;
    expect(robotmoney.priceUsd).toBeNull();
    expect(robotmoney.valueUsd).toBeNull();
    expect(robotmoney.provenance).toBe("stale");

    const bnkr = bankr.holdings.find((h) => h.symbol === "BNKR")!;
    expect(bnkr.priceUsd).toBeNull();
    expect(bnkr.valueUsd).toBeNull();
    expect(bnkr.provenance).toBe("stale");

    expect(bankr.stale).toBe(true);
    expect(r.stale).toBe(true);
  } finally {
    await sql`DELETE FROM wallet_balance_samples`;
    await sql`DELETE FROM wallet_sleeve_samples`;
  }
});

test("wallet-sleeves seam: amount and price readers inject independently and persisted-price provenance reaches the unchanged DTO", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  process.env.PRICE_SOURCE = "live";
  await sql`DELETE FROM wallet_sleeve_samples`;
  const sampledAt = new Date();
  const sampleDate = sampledAt.toISOString().slice(0, 10);
  const propWallets = resolvePropWallets();

  // Seed sample rows into Postgres
  for (const w of propWallets) {
    await sql`
      INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES
        (${sampleDate}, ${w.toLowerCase()}, 'ROBOTMONEY', 2, 3, 6, 'stale', ${sampledAt}),
        (${sampleDate}, ${w.toLowerCase()}, 'USDC', 2, 4, 8, 'live', ${sampledAt})
      ON CONFLICT (sample_date, wallet_address, symbol) DO NOTHING
    `;
  }

  const r = await getWalletSleeves();
  expect(Object.keys(r).sort()).toEqual(["asOf", "source", "stale", "wallets"]);
  expect(r.source).toBe("live");

  const robotmoney = r.wallets.find((wallet) => wallet.type === "primary")!.holdings.find((holding) => holding.symbol === "ROBOTMONEY")!;
  expect(robotmoney).toEqual({ symbol: "ROBOTMONEY", amount: 2, priceUsd: 3, valueUsd: 6, provenance: "stale", observedAt: sampledAt.toISOString() });
  expect(r.wallets.find((wallet) => wallet.type === "primary")!.stale).toBe(true);
  expect(r.stale).toBe(true);

  const providerHolding = r.wallets.find((wallet) => wallet.type === "primary")!.holdings.find((holding) => holding.symbol === "USDC")!;
  expect(providerHolding).toEqual({ symbol: "USDC", amount: 2, priceUsd: 4, valueUsd: 8, provenance: "live", observedAt: sampledAt.toISOString() });
  await sql`DELETE FROM wallet_sleeve_samples`;
});

// ── allocation ──────────────────────────────────────────────────────────────
test("allocation: seeded swarm framework → 4 buckets, exact pct conversion, managed:true", async () => {
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

test("allocation: with the row absent, getAllocation falls back to the swarm seed default (managed data is static, not a degraded chain read)", async () => {
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
    // Restore the swarm seed row (id=1) exactly as db/seed.ts wrote it.
    await sql`
      INSERT INTO allocation_framework (id, asof, vault_contract, buckets)
      VALUES (1, ${ALLOCATION_FRAMEWORK_SEED.asof}, ${ALLOCATION_FRAMEWORK_SEED.vault_contract},
              ${sql.json(jsonValue(ALLOCATION_FRAMEWORK_SEED.buckets))})
      ON CONFLICT (id) DO NOTHING
    `;
    resetCaches();
  }
});

// ── buyback indexer: persisted scan cursor (regression: stuck-at-floor) ──────
test("buyback indexer advances a persisted scan cursor across empty windows and resumes past it (never restarts from the floor)", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  // The floor is the committed constant now (#640 removed the env override), and
  // window size / per-run window count are committed constants since issue #641
  // (config.ts BUYBACK_LOG_CHUNK / BUYBACK_MAX_CHUNKS), so this case reads them
  // rather than pinning small values through env that no longer exists.
  const FLOOR = BUYBACK_FROM_BLOCK;
  const RUN_SPAN = BUYBACK_LOG_CHUNK * BUYBACK_MAX_CHUNKS; // blocks covered per run
  const LATEST = FLOOR + RUN_SPAN * 3; // far beyond one run's reach → cursor must carry across runs
  // Empty-log chain: eth_blockNumber → tip, eth_getLogs → [] (no buybacks found),
  // gecko → a WETH price. If progress depended on finding a row, the cursor would
  // never move; this proves it advances on scan coverage alone.
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) {
      // Comma-separated batch URL (see mockChain above) — answer every address.
      const addrs = (u.split("/token_price/")[1] ?? "x").toLowerCase().split(",");
      return new Response(JSON.stringify({ data: { attributes: { token_prices: Object.fromEntries(addrs.map((a) => [a, "2000"])) } } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + LATEST.toString(16) }), { status: 200 });
    if (body.method === "eth_getLogs") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
    throw new Error(`unexpected ${body.method}`);
  }) as unknown as typeof fetch;
  try {
    await sql`DELETE FROM buyback_scan_state`;
    const r1 = await indexBuybacks();
    const c1 = await sql<{ b: string }[]>`SELECT last_scanned_block::text AS b FROM buyback_scan_state WHERE id = 1`;
    // from=FLOOR; BUYBACK_MAX_CHUNKS windows of BUYBACK_LOG_CHUNK blocks.
    expect(r1.scannedToBlock).toBe(FLOOR + RUN_SPAN - 1);
    expect(Number(c1[0]!.b)).toBe(FLOOR + RUN_SPAN - 1);

    const r2 = await indexBuybacks();
    const c2 = await sql<{ b: string }[]>`SELECT last_scanned_block::text AS b FROM buyback_scan_state WHERE id = 1`;
    // Resumes at cursor+1, NOT the floor → advances another full run span.
    expect(r2.scannedToBlock).toBe(FLOOR + RUN_SPAN * 2 - 1);
    expect(Number(c2[0]!.b)).toBe(FLOOR + RUN_SPAN * 2 - 1);
  } finally {
    for (const k of ["BASE_RPC_SOURCE"]) delete process.env[k];
    await sql`DELETE FROM buyback_scan_state`;
    _resetBuybackCacheForTests();
  }
});

// ── buyback scan floor: a committed mainnet constant (#640) ─────────────────
// Before this, the floor was `Number(process.env.BUYBACK_FROM_BLOCK ?? "0")` — an
// env read no compose file could deliver, whose default cost ~51 days of empty
// scanning before reaching the buyback era. The env read is now GONE, so the old
// NaN hazard (a "43,741,600" typo skipped the `floor <= 0` warning and then froze
// the chunk loop forever) is impossible by construction rather than by parsing:
// there is no longer a value that can be supplied, therefore none to malform.
test("the buyback floor is a committed constant with no env read anywhere in source", async () => {
  expect(BUYBACK_FROM_BLOCK).toBe(43_741_600); // block of the earliest seeded buyback swap
  expect(resolveBuybackConfig({}).fromBlock).toBe(BUYBACK_FROM_BLOCK);
  // An override no longer exists, so setting one must change nothing.
  expect(resolveBuybackConfig({ BUYBACK_FROM_BLOCK: "1000" }).fromBlock).toBe(BUYBACK_FROM_BLOCK);
  // And the name appears in no executable line under src/ — a comment may still
  // explain the removal, but a read would resurrect the hazard.
  const srcDir = fileURLToPath(new URL("../../src/", import.meta.url));
  const grep = Bun.spawnSync(["grep", "-rn", "process.env.BUYBACK_FROM_BLOCK", srcDir]);
  const hits = new TextDecoder().decode(grep.stdout)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !/^[^:]*:\d+:\s*(\/\/|\*)/.test(line)); // prose about the removal is fine
  expect(hits).toEqual([]);
});

test("buyback indexer: a fresh database scans from the committed constant, never from block 0", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  process.env.BUYBACK_FROM_BLOCK = "1000"; // must be IGNORED: the read is gone
  // BUYBACK_LOG_CHUNK / BUYBACK_MAX_CHUNKS are committed constants now (#641),
  // so env overrides for them would also be ignored.
  const LATEST = BUYBACK_FROM_BLOCK + 10_000;
  const scanned: Array<{ from: number; to: number }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) {
      const addrs = (u.split("/token_price/")[1] ?? "x").toLowerCase().split(",");
      return new Response(JSON.stringify({ data: { attributes: { token_prices: Object.fromEntries(addrs.map((a) => [a, "2000"])) } } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { method: string; params: any[] };
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + LATEST.toString(16) }), { status: 200 });
    if (body.method === "eth_getLogs") {
      const p = body.params[0] as { fromBlock: string; toBlock: string };
      scanned.push({ from: parseInt(p.fromBlock, 16), to: parseInt(p.toBlock, 16) });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
    }
    throw new Error(`unexpected ${body.method}`);
  }) as unknown as typeof fetch;
  try {
    await sql`DELETE FROM buyback_scan_state`; // fresh DB: no cursor, and every seed row has block_number NULL
    const r = await indexBuybacks();
    // The RPC-visible window, not just the return value: the very first
    // eth_getLogs must open at the buyback era, not at genesis (and not at the
    // stale env value either).
    expect(scanned[0]).toEqual({ from: BUYBACK_FROM_BLOCK, to: BUYBACK_FROM_BLOCK + BUYBACK_LOG_CHUNK - 1 });
    expect(scanned).toHaveLength(2); // two windows to reach LATEST
    expect(r.scannedToBlock).toBe(BUYBACK_FROM_BLOCK + 10_000);
  } finally {
    for (const k of ["BASE_RPC_SOURCE", "BUYBACK_FROM_BLOCK"]) delete process.env[k];
    await sql`DELETE FROM buyback_scan_state`;
    _resetBuybackCacheForTests();
  }
});

// Issue #641: BUYBACK_LOG_CHUNK / BUYBACK_MAX_CHUNKS were env overrides that no
// deployed container could ever receive — docker-compose.yml's `environment:`
// block is an allowlist (no compose file has an `env_file:`, backend/Dockerfile
// sets no ENV) and neither key was in it, so the "tuning knob" could only ever
// hold its inline default anyway. Both are committed constants now and the
// overrides are gone. Asserted against the LIVE INDEXER rather than a parser: the
// planted values would produce a single 1-block window, so a run that covers the
// full constant-derived span proves the constants are what the scan loop reads.
test("issue #641: the buyback scan bounds are committed constants — the retired env overrides have no effect on the indexer", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  process.env.BUYBACK_LOG_CHUNK = "1";
  process.env.BUYBACK_MAX_CHUNKS = "1";
  const RUN_SPAN = BUYBACK_LOG_CHUNK * BUYBACK_MAX_CHUNKS;
  const LATEST = BUYBACK_FROM_BLOCK + RUN_SPAN * 2;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) {
      const addrs = (u.split("/token_price/")[1] ?? "x").toLowerCase().split(",");
      return new Response(JSON.stringify({ data: { attributes: { token_prices: Object.fromEntries(addrs.map((a) => [a, "2000"])) } } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + LATEST.toString(16) }), { status: 200 });
    if (body.method === "eth_getLogs") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
    throw new Error(`unexpected ${body.method}`);
  }) as unknown as typeof fetch;
  try {
    await sql`DELETE FROM buyback_scan_state`;
    const r = await indexBuybacks();
    expect(r.scannedToBlock).toBe(BUYBACK_FROM_BLOCK + RUN_SPAN - 1);
    // Not the 1-block window the planted env would have produced.
    expect(r.scannedToBlock).not.toBe(BUYBACK_FROM_BLOCK);
    // The committed values themselves: 9000 is deliberate margin under the 10k
    // eth_getLogs range cap common public providers impose (see config.ts).
    expect([BUYBACK_LOG_CHUNK, BUYBACK_MAX_CHUNKS]).toEqual([9000, 25]);
  } finally {
    for (const k of ["BUYBACK_LOG_CHUNK", "BUYBACK_MAX_CHUNKS"]) delete process.env[k];
    await sql`DELETE FROM buyback_scan_state`;
    _resetBuybackCacheForTests();
  }
});

// ── historical pricing: each swap valued at its OWN block time (#640) ───────
// Setting the floor is what makes this bite: the first runs backfill ~5 months,
// and the old code read ONE current spot price per run and stamped it on every
// row (`buyback-logs.ts` :250/:272 before this change). At the seeded buybacks
// that is ~$2,179.3 actual vs ~$1,884.55 today — a ~13.5% fabricated value_usd,
// against migration 0015's own "a value is NEVER fabricated" invariant.
const HISTORIC_BLOCK = BUYBACK_FROM_BLOCK + 10;
const HISTORIC_TS = 1_774_270_000; // inside the 2026-03-23 UTC day (bucket 1774224000)
const HISTORIC_DAY = "2026-03-23";
const DAY_CLOSE = 2179.3; // that day's settled WETH/USD close
const TODAY_SPOT = 1884.55; // what the old per-run spot read would have used
const SWAP_TX = "0x00000000000000000000000000000000000000000000000000000000000640a1";
const WETH_OUT = 116_534_000_000_000_000n; // 0.116534 WETH, the seeded trade size
const ROBOTMONEY_IN = 18_450_000n * 10n ** 18n;

// One historical buyback in a single scanned window. `ohlcv` decides what the
// daily-candle endpoint does, which is the only thing these two cases differ on.
function mockHistoricBuyback(ohlcv: "ok" | "unavailable") {
  const calls = { ohlcv: 0, spot: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/ohlcv/")) {
      calls.ohlcv += 1;
      if (ohlcv === "unavailable") return new Response("nope", { status: 400 });
      // [bucketTs, open, high, low, close, volume] — the real 2026-03-23 candle
      // shape, close pinned to the value the seeded rows imply.
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[1_774_224_000, 2052.63, 2188.0, 2026.51, DAY_CLOSE, 1234]] } } }), { status: 200 });
    }
    if (u.includes("geckoterminal.com")) {
      calls.spot += 1; // today's spot: reading it at all is the bug under test
      const addrs = (u.split("/token_price/")[1] ?? "x").toLowerCase().split(",");
      return new Response(JSON.stringify({ data: { attributes: { token_prices: Object.fromEntries(addrs.map((a) => [a, String(TODAY_SPOT)])) } } }), { status: 200 });
    }
    // The scan prefetches a chunk's block headers and per-block WETH logs as
    // JSON-RPC ARRAY batches (chain/buyback-logs.ts), so the body may be one
    // request object or a list of them. Answering per entry keeps this mock a
    // model of the node rather than of one call shape.
    const parsedBody = JSON.parse(String(init?.body)) as
      | { id: number; method: string; params: any[] }
      | { id: number; method: string; params: any[] }[];
    const batched = Array.isArray(parsedBody);
    const entries = batched ? parsedBody : [parsedBody];

    const answerOne = (body: { method: string; params: any[] }): unknown => {
      if (body.method === "eth_blockNumber") return "0x" + (BUYBACK_FROM_BLOCK + 50).toString(16);
      if (body.method === "eth_getBlockByNumber") return { timestamp: "0x" + HISTORIC_TS.toString(16) };
      if (body.method === "eth_getLogs") {
        const p = body.params[0] as { address: string; fromBlock: string; toBlock: string };
        const inWindow = parseInt(p.fromBlock, 16) <= HISTORIC_BLOCK && HISTORIC_BLOCK <= parseInt(p.toBlock, 16);
        if (!inWindow) return [];
        // The WETH leg query pins fromBlock == toBlock == the swap's block; the
        // ROBOTMONEY leg query spans the whole chunk.
        const isWethLeg = p.fromBlock === p.toBlock;
        return [
          {
            blockNumber: "0x" + HISTORIC_BLOCK.toString(16),
            logIndex: "0x1",
            transactionHash: SWAP_TX,
            data: word(isWethLeg ? WETH_OUT : ROBOTMONEY_IN),
          },
        ];
      }
      throw new Error(`unexpected ${body.method}`);
    };

    const answers = entries.map((e) => ({ jsonrpc: "2.0", id: e.id ?? 1, result: answerOne(e) }));
    return new Response(JSON.stringify(batched ? answers : answers[0]), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

async function indexOneHistoricSwap(ohlcv: "ok" | "unavailable") {
  process.env.BASE_RPC_SOURCE = "live";
  // BUYBACK_LOG_CHUNK / BUYBACK_MAX_CHUNKS are committed constants now (#641);
  // the mock window is wide enough that the first 9000-block window contains
  // HISTORIC_BLOCK, so no env override is needed.
  const calls = mockHistoricBuyback(ohlcv);
  await sql`DELETE FROM buyback_swaps WHERE tx_hash = ${SWAP_TX}`;
  await sql`DELETE FROM buyback_scan_state`;
  const result = await indexBuybacks();
  const rows = await sql<{ occurred_on: Date; weth_spent: string; value_usd: string | null }[]>`
    SELECT occurred_on, weth_spent::text, value_usd::text FROM buyback_swaps WHERE tx_hash = ${SWAP_TX}
  `;
  return { calls, result, row: rows[0] };
}

async function cleanupHistoricSwap() {
  delete process.env.BASE_RPC_SOURCE;
  await sql`DELETE FROM buyback_swaps WHERE tx_hash = ${SWAP_TX}`;
  await sql`DELETE FROM buyback_scan_state`;
  _resetBuybackCacheForTests();
  _resetTokenPriceCacheForTests();
}

test("buyback indexer: a historical swap is valued at ITS OWN block's WETH price, not the current spot", async () => {
  try {
    const { calls, result, row } = await indexOneHistoricSwap("ok");
    expect(result.indexed).toBe(1);
    expect(row!.occurred_on.toISOString().slice(0, 10)).toBe(HISTORIC_DAY);
    // 0.116534 WETH × 2179.3 = $253.96, reproducing the $253.97 migration 0015
    // records for this trade size on this day (its implied price is 2179.38 —
    // a daily candle cannot be finer than the day). Today's spot gives $219.61,
    // which is the ~13.5% fabrication this replaces.
    expect(Number(row!.value_usd)).toBe(253.96);
    expect(Math.round(0.116534 * TODAY_SPOT * 100) / 100).toBe(219.61); // what the old code would have written
    expect(Number(row!.value_usd)).not.toBe(219.61);
    // And the run must not have consulted the current spot endpoint at all.
    expect(`ohlcv:${calls.ohlcv >= 1} spot:${calls.spot}`).toBe("ohlcv:true spot:0");
  } finally {
    await cleanupHistoricSwap();
  }
});

test("buyback indexer: an unavailable historical price persists the swap with a NULL value_usd, never an invented one", async () => {
  try {
    const { calls, result, row } = await indexOneHistoricSwap("unavailable");
    // The swap itself is fully attested (hash, block, amounts) so it is kept…
    expect(result.indexed).toBe(1);
    expect(Number(row!.weth_spent)).toBeCloseTo(0.116534, 6);
    // …and its USD value is recorded as UNKNOWN rather than back-filled from
    // today's spot, which the mock would happily have served.
    expect(row!.value_usd).toBeNull();
    expect(calls.spot).toBe(0);
  } finally {
    await cleanupHistoricSwap();
  }
});

test("wallet-sleeves: getWalletSleeves performs ZERO RPC/price calls on request path when readers expect.unreachable()", async () => {
  await sql`DELETE FROM wallet_sleeve_samples`;
  const sampledAt = new Date();
  const sampleDate = sampledAt.toISOString().slice(0, 10);
  const wallets = resolvePropWallets();
  const symbols = ["USDC", "ROBOTMONEY", "WETH", "ETH", "BNKR", "ZYFAI-SS1", "GIZA-SS1"];

  for (const w of wallets) {
    for (const s of symbols) {
      await sql`
        INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
        VALUES (${sampleDate}, ${w.toLowerCase()}, ${s}, 10, 2, 20, 'live', ${sampledAt})
        ON CONFLICT (sample_date, wallet_address, symbol) DO NOTHING
      `;
    }
  }

  const unreachableReaders: WalletSleeveReaders = {
    readChainAmounts() {
      expect.unreachable();
    },
    priceReader: {
      read() {
        expect.unreachable();
      },
    },
  };

  _resetWalletSleevesCacheForTests();
  const r = await readWalletSleeves(unreachableReaders);
  expect(r.wallets.length).toBeGreaterThan(0);
  for (const w of r.wallets) {
    for (const h of w.holdings) {
      expect(h.amount).toBe(10);
      expect(h.priceUsd).toBe(2);
      expect(h.valueUsd).toBe(20);
      expect(h.provenance).toBe("live");
    }
  }
  await sql`DELETE FROM wallet_sleeve_samples`;
});

test("wallet-sleeves: served provenance and observedAt pass-through persisted row's own value exactly", async () => {
  await sql`DELETE FROM wallet_sleeve_samples`;
  const fixedSampledAt = new Date("2026-07-25T10:00:00.000Z");
  const sampleDate = "2026-07-25";
  const wallet = "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6";

  await sql`
    INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${sampleDate}, ${wallet.toLowerCase()}, 'USDC', 100, 1, 100, 'stale', ${fixedSampledAt})
  `;

  _resetWalletSleevesCacheForTests();
  const r = await getWalletSleeves();
  const bankr = r.wallets.find((w) => w.name === "Bankr")!;
  const usdc = bankr.holdings.find((h) => h.symbol === "USDC")!;

  expect(usdc.provenance).toBe("stale");
  expect(usdc.observedAt).toBe(fixedSampledAt.toISOString());

  await sql`DELETE FROM wallet_sleeve_samples`;
});

test("wallet-sleeves: freshness budget boundary pair (budget-1s -> stale false, budget+1s -> stale true)", async () => {
  await sql`DELETE FROM wallet_sleeve_samples`;
  const BUDGET_MS = 5 * 60_000;
  const wallet = "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6";
  const symbols = ["USDC", "ROBOTMONEY", "WETH", "ETH", "BNKR"];

  // 1) Budget - 1s (fresh)
  const freshTime = new Date(Date.now() - (BUDGET_MS - 1000));
  const dateFresh = freshTime.toISOString().slice(0, 10);
  for (const s of symbols) {
    await sql`
      INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES (${dateFresh}, ${wallet.toLowerCase()}, ${s}, 10, 1, 10, 'live', ${freshTime})
    `;
  }
  _resetWalletSleevesCacheForTests();
  const rFresh = await getWalletSleeves();
  const bankrFresh = rFresh.wallets.find((w) => w.name === "Bankr")!;
  expect(bankrFresh.stale).toBe(false);

  // 2) Budget + 1s (stale)
  await sql`DELETE FROM wallet_sleeve_samples`;
  const staleTime = new Date(Date.now() - (BUDGET_MS + 1000));
  const dateStale = staleTime.toISOString().slice(0, 10);
  for (const s of symbols) {
    await sql`
      INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES (${dateStale}, ${wallet.toLowerCase()}, ${s}, 10, 1, 10, 'live', ${staleTime})
    `;
  }
  _resetWalletSleevesCacheForTests();
  const rStale = await getWalletSleeves();
  const bankrStale = rStale.wallets.find((w) => w.name === "Bankr")!;
  expect(bankrStale.stale).toBe(true);

  await sql`DELETE FROM wallet_sleeve_samples`;
});
