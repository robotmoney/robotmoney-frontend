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
import {
  fetchWalletBalances,
  fetchPersistedWalletBalances,
  _resetWalletBalancesCacheForTests,
} from "../../src/chain/wallet-balances.ts";
import {
  _resetRpcConcurrencyForTests,
  decodeAggregate3Calls,
  encodeAggregate3Result,
  type Aggregate3Result,
} from "../../src/chain/base-rpc-client.ts";
import { getWalletBalances } from "../../src/api/routes/dashboards.ts";
import { sampleWalletBalances } from "../../src/worker/handlers/wallet.ts";
import { backfillWalletHistory } from "../../src/db/seed.ts";
import { _resetTokenPriceCacheForTests } from "../../src/chain/token-prices.ts";

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
  "BASE_RPC_RETRY_BASE_MS", "BASE_RPC_MAX_RETRIES", "BASE_RPC_MAX_CONCURRENCY",
  "STRATEGY_VAULT_GTUSDCP_ADDRESS", "STRATEGY_VAULT_STEAKUSDC_ADDRESS",
  "STRATEGY_VAULT_CUSDCV3_ADDRESS", "STRATEGY_VAULT_ABASUSDC_ADDRESS",
  "STRATEGY_VAULT_CSHYUSDC_ADDRESS",
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
  _resetRpcConcurrencyForTests();
  // The GeckoTerminal price cache (chain/token-prices.ts) is a MODULE-LEVEL,
  // process-wide cache (30s TTL) keyed by token address, so it survives across
  // test FILES within the same `bun test` run, not just across tests here. The
  // #148 test below deliberately leaves BNKR_ADDRESS unset to exercise the REAL
  // default token address; without this reset, a price cached here for that
  // real address can silently answer a price read in a LATER test/file (e.g.
  // tests/api/dashboards-live.test.ts's #173 forced-failure case) straight from
  // cache, bypassing that test's mock entirely.
  _resetTokenPriceCacheForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  _resetWalletBalancesCacheForTests();
  _resetRpcConcurrencyForTests();
  _resetTokenPriceCacheForTests();
  for (const k of ENV_KEYS) delete process.env[k];
});

const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

const BALANCE_OF = "0x70a08231";
const CONVERT_TO_ASSETS = "0x07a2d13a";
const GET_ETH_BALANCE = "0x4d2301cc"; // Multicall3 getEthBalance(address)
const AGGREGATE3 = "0x82ad56cb"; // Multicall3 aggregate3(Call3[])

interface ChainFixtures {
  // eth_call balanceOf(token) → raw balance, ignoring the holder arg (fine when
  // only one holder ever queries that target in a given test).
  balanceOf?: Record<string, bigint>;
  // eth_call balanceOf(token) → raw balance, KEYED BY HOLDER too (target →
  // holder → balance). Checked before the holder-agnostic `balanceOf` map so a
  // test can give the SAME target (e.g. USDC) different balances per holder —
  // needed for the strategy NAV idle-USDC read, which queries USDC.balanceOf
  // for the smart-account address, distinct from the primary wallet's USDC leg.
  balanceOfByHolder?: Record<string, Record<string, bigint>>;
  // getEthBalance(wallet) → wei (native leg, now read via Multicall3).
  native?: bigint;
  // convertToAssets(vault) → underlying raw (6-dp USDC).
  nav?: Record<string, bigint>;
  // GeckoTerminal token_price (address → USD) for the live-price path.
  gecko?: Record<string, number>;
  // Addresses to OMIT from an otherwise-successful token_price response (as
  // opposed to a fixture typo, which still throws loudly). Mirrors
  // runGeckoBatch's real per-address failure mode (token-prices.ts): a
  // SUCCESSFUL batched response simply missing one address rejects only that
  // address's waiter — every other co-batched address still resolves live.
  geckoOmit?: string[];
  // Yahoo SP500 close for the live-price path.
  sp500Price?: number;
  // Token addresses whose balanceOf sub-call comes back success:false (forced
  // single-leg failure) — the batched analogue of a reverted allowFailure call.
  failBalanceOf?: string[];
  // Number of leading aggregate3 requests to answer with HTTP 429 (rate limited)
  // before a valid 200 — exercises the transport's retry/backoff on the WHOLE
  // batch through the REAL rpcRequest. Mutated (decremented) in place per request.
  rateLimitCalls?: number;
}

// Live counter of how many aggregate3 eth_calls the endpoint issued — the whole
// point of the Multicall3 batching is that this stays 1–2 regardless of fan-out.
interface MockCounter {
  aggregateCalls: number;
}

function mockChain(fx: ChainFixtures): MockCounter {
  const counter: MockCounter = { aggregateCalls: 0 };
  // Answer one aggregate3 sub-call using the same per-selector fixtures the old
  // single-eth_call path used. A failed balanceOf leg → success:false (mirrors an
  // allowFailure revert); an unknown selector/missing fixture throws (loud).
  const subResult = (target: string, callData: string): Aggregate3Result => {
    const toLc = target.toLowerCase();
    const sel = callData.slice(0, 10);
    if (sel === GET_ETH_BALANCE) {
      if (fx.native == null) throw new Error("mockChain: no native fixture");
      return { success: true, returnData: word(fx.native) };
    }
    if (sel === BALANCE_OF) {
      if (fx.failBalanceOf?.map((a) => a.toLowerCase()).includes(toLc)) return { success: false, returnData: "0x" };
      // Decode the single `balanceOf(address holder)` arg (low 20 bytes of the
      // one 32-byte word after the 4-byte selector) so the SAME target can be
      // queried for different holders (e.g. USDC for the primary wallet AND
      // for a strategy smart-account's idle balance).
      const holderLc = ("0x" + callData.slice(-40)).toLowerCase();
      const byHolder = fx.balanceOfByHolder?.[toLc]?.[holderLc];
      if (byHolder != null) return { success: true, returnData: word(byHolder) };
      const raw = fx.balanceOf?.[toLc];
      if (raw == null) throw new Error(`mockChain: no balanceOf fixture for ${toLc} (holder ${holderLc})`);
      return { success: true, returnData: word(raw) };
    }
    if (sel === CONVERT_TO_ASSETS) {
      const raw = fx.nav?.[toLc];
      if (raw == null) throw new Error(`mockChain: no convertToAssets fixture for ${toLc}`);
      return { success: true, returnData: word(raw) };
    }
    throw new Error(`mockChain: unexpected sub-call selector ${sel}`);
  };

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) {
      // token_price now takes a comma-separated address list (token-prices.ts
      // micro-batches every same-burst leg into ONE request — the demo/CI
      // quota fix). Serve EVERY requested address from the fixture book; a
      // missing fixture still throws LOUDLY (a typo in a test must fail the
      // batch, never silently degrade a leg to 'stale').
      const addrs = u.split("/token_price/")[1]!.toLowerCase().split(",");
      const token_prices: Record<string, string> = {};
      for (const addr of addrs) {
        if (fx.geckoOmit?.map((a) => a.toLowerCase()).includes(addr)) continue; // per-address miss, not a request failure
        const price = fx.gecko?.[addr];
        if (price == null) throw new Error(`mockChain: no gecko price for ${addr}`);
        token_prices[addr] = String(price);
      }
      return new Response(JSON.stringify({ data: { attributes: { token_prices } } }), { status: 200 });
    }
    if (u.includes("finance.yahoo.com")) {
      if (fx.sp500Price == null) throw new Error("mockChain: no sp500Price fixture");
      const p = fx.sp500Price;
      return new Response(JSON.stringify({ chart: { result: [{ timestamp: [1, 2], indicators: { adjclose: [{ adjclose: [p, p] }], quote: [{ close: [p, p] }] } }] } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: any[] };
    if (body.method === "eth_call") {
      const { to, data } = body.params[0] as { to: string; data: string };
      const selector = data.slice(0, 10);
      // The wallet-balances feed now issues ONE aggregate3 per round.
      if (selector === AGGREGATE3) {
        if (fx.rateLimitCalls && fx.rateLimitCalls > 0) {
          fx.rateLimitCalls -= 1; // one transient 429 on the whole batch consumed
          return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
        }
        counter.aggregateCalls += 1;
        const calls = decodeAggregate3Calls(data);
        const results = calls.map((c) => subResult(c.target, c.callData));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: encodeAggregate3Result(results) }), { status: 200 });
      }
      // Legacy single-call path retained for any direct callers.
      const single = subResult(to, data);
      if (!single.success) throw new Error(`mockChain: forced failure for ${to}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: single.returnData }), { status: 200 });
    }
    if (body.method === "eth_getBalance") {
      if (fx.native == null) throw new Error("mockChain: no native fixture");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: word(fx.native) }), { status: 200 });
    }
    throw new Error(`mockChain: unexpected method ${body.method}`);
  }) as unknown as typeof fetch;
  return counter;
}

// Fixtures under PRICE_SOURCE=stub (prices come from token-prices STUB_PRICES:
// WETH/ETH 1600, ROBOTMONEY 1e-5, BNKR 5e-4, SP500 4600; USDC/strategy $1).
// ZYFAI-SS1/GIZA-SS1 are smart-account NAV legs (issues #120/#145): with no
// STRATEGY_VAULT_*_ADDRESS configured (the default), NAV = idle USDC balance
// of the account, read via USDC.balanceOf(account) — same target (A.USDC) the
// primary wallet's own USDC leg queries, but a DIFFERENT holder, hence
// balanceOfByHolder rather than the holder-agnostic `balanceOf` map.
function stubFixtures(): ChainFixtures {
  return {
    balanceOf: {
      [A.USDC]: 9052n * E6, // primary wallet's USDC → $9052
      [A.WETH]: 10n * E18, // 10 WETH → $16,000
      [A.ROBOTMONEY]: 3_000_000_000n * E18, // 3e9 → $30,000 @ 1e-5
      [A.BNKR]: 20000n * E18, // 20,000 → $10 @ 5e-4
    },
    balanceOfByHolder: {
      [A.USDC]: {
        [A.ZYFAI]: 4538n * E6, // ZYFAI-SS1 account idle USDC → NAV $4538 (no vaults configured)
        [A.GIZA]: 4524n * E6, // GIZA-SS1 account idle USDC → NAV $4524
      },
    },
    native: 500000000000000000n, // 0.5 ETH → $800
  };
}

// Expected per-symbol valueUsd from stubFixtures() (SP500 = 0.633 * 4600).
const EXPECT: Record<string, number> = {
  USDC: 9052, "ZYFAI-SS1": 4538, "GIZA-SS1": 4524, WETH: 16000, ETH: 800,
  ROBOTMONEY: 30000, BNKR: 10, SP500: 0.633 * 4600,
};

// AC1 exercises the LIVE read engine (fetchWalletBalances) that the scheduled
// sampler uses — the request route now serves PERSISTED data (see the dedicated
// zero-RPC test below), so this validates the sampler's live payload directly.
test("AC1: stub source → 200-shaped payload; every holding numeric with provenance 'stub'; totalUsd == sum(holdings.valueUsd)", async () => {
  setBaseEnv();
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain(stubFixtures());

  const r = await fetchWalletBalances();
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

// ── Multicall3 batching (public-Base-RPC 429 storm fix) at the ENDPOINT layer.
// Every prop-wallet read now flows through ONE aggregate3 eth_call per round, so
// a transient 429 hits the WHOLE batch: the transport's retry masks the blip and
// EVERY chain leg recovers live; with retry disabled the batch throws and every
// chain leg degrades to stale. All drive the REAL rpcRequest — nothing bypasses
// the transport. AC3 above (a success:false sub-call) proves a PERMANENT single
// leg still degrades in isolation while the others stay live. ──────────────────

test("AC3-retry: a transient 429 on the whole aggregate3 batch is retried and ALL chain legs recover to provenance 'live'", async () => {
  setBaseEnv({ BASE_RPC_RETRY_BASE_MS: "1" }); // fast backoff; source+price stay live (unset)
  // The batch eth_call 429s twice, then 200s. Default BASE_RPC_MAX_RETRIES=3 ⇒ round 1 recovers.
  const fx = stubFixtures();
  fx.rateLimitCalls = 2;
  // Live price path (provenance 'live' requires priceSource live too) — supply
  // the mocked gecko/yahoo fixtures the live legs need.
  fx.gecko = { [A.WETH]: 1700, [A.ROBOTMONEY]: 0.00002, [A.BNKR]: 0.001 };
  fx.sp500Price = 4700;
  mockChain(fx);

  const r = await fetchWalletBalances();
  const weth = r.holdings.find((h) => h.symbol === "WETH")!;
  // Distinguishing assertion vs the negative control: the retried batch is LIVE,
  // not stale, and WETH carries its REAL fixture value (10 WETH × $1700).
  expect(weth.provenance).toBe("live");
  expect(weth.valueUsd).toBeCloseTo(10 * 1700, 6);
  expect(fx.rateLimitCalls).toBe(0); // both transient 429s were consumed
  for (const h of r.holdings) expect(h.provenance).not.toBe("stale");
});

test("AC3-retry negative control: the SAME transient 429 with BASE_RPC_MAX_RETRIES=0 makes the batch throw so EVERY chain leg degrades to 'stale' — proving retry (not something else) produces the live outcome", async () => {
  setBaseEnv({ BASE_RPC_RETRY_BASE_MS: "1", BASE_RPC_MAX_RETRIES: "0" });
  // last-persisted WETH sample the degrade path falls back to (mirrors AC3).
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance)
    VALUES ('2026-06-25', 'WETH', 15.4, 1550, 23870, 'live')
  `;
  const fx = stubFixtures();
  fx.rateLimitCalls = 2; // identical fixture to the recovery test
  process.env.PRICE_SOURCE = "stub"; // keep price fetches off the live gecko path
  mockChain(fx);

  const r = await fetchWalletBalances();
  const weth = r.holdings.find((h) => h.symbol === "WETH")!;
  // With retry disabled the very first 429 throws the whole batch → every chain
  // leg degrades to stale (SP500 is off-chain config, so it is NOT a chain read).
  expect(weth.provenance).toBe("stale");
  expect(weth.valueUsd).toBeCloseTo(23870, 6); // its persisted sample
  for (const sym of ["USDC", "ETH", "BNKR", "ROBOTMONEY"]) {
    expect(r.holdings.find((h) => h.symbol === sym)!.provenance).toBe("stale");
  }
  expect(r.holdings.find((h) => h.symbol === "SP500")!.provenance).not.toBe("stale");
  expect(fx.rateLimitCalls).toBe(1); // only ONE batch attempt was made (no retry)
});

test("AC3-batch: the endpoint issues at most TWO aggregate3 eth_calls regardless of wallet/asset count (was ~23 individual eth_calls)", async () => {
  // Three prop wallets × the eight tracked assets used to fan out to ~23 separate
  // eth_calls. With Multicall3 that collapses to ONE round-1 aggregate3 call
  // (balances + each strategy account's idle-USDC/vault-share reads); round 2
  // (per-vault convertToAssets) only fires when a vault is actually configured
  // (issues #120/#145 — see the dedicated NAV test below), so with the default
  // EMPTY vault list this stays at ONE call. This bound (never scaling with
  // wallet/asset count) is the whole point of the fix.
  const wallets = ["0x" + "a1".repeat(20), "0x" + "b2".repeat(20), "0x" + "c3".repeat(20)];
  setBaseEnv();
  process.env.PROP_WALLET_ADDRESSES = wallets.join(",");
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  const counter = mockChain(stubFixtures());

  const r = await fetchWalletBalances();
  expect(r.holdings).toHaveLength(8); // the full fan-out ran
  expect(counter.aggregateCalls).toBe(1); // round 1 only — no vault configured, so no round 2
  expect(counter.aggregateCalls).toBeLessThanOrEqual(2); // never scales with wallet/asset count
});

test("NAV (issues #120/#145): a configured strategy vault is queried for shares in round 1 and convertToAssets in round 2; NAV = idle USDC + vault assets", async () => {
  setBaseEnv({ STRATEGY_VAULT_GTUSDCP_ADDRESS: "0x" + "aa".repeat(20) });
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  const VAULT = "0x" + "aa".repeat(20);
  const fx = stubFixtures();
  fx.balanceOfByHolder![VAULT] = { [A.ZYFAI]: 1_000n * E6, [A.GIZA]: 0n }; // ZYFAI-SS1 holds 1000 (raw) gtUSDCp shares; GIZA holds none
  fx.nav = { [VAULT]: 1_050n * E6 }; // convertToAssets(1000 shares) → 1050 USDC (accrued yield)
  const counter = mockChain(fx);

  const r = await fetchWalletBalances();
  const bySym = Object.fromEntries(r.holdings.map((h) => [h.symbol, h]));
  // ZYFAI-SS1 NAV = idle 4538 USDC + 1050 USDC vault assets = 5588.
  expect(bySym["ZYFAI-SS1"]!.provenance).toBe("stub");
  expect(bySym["ZYFAI-SS1"]!.amount).toBeCloseTo(5588, 6);
  expect(bySym["ZYFAI-SS1"]!.valueUsd).toBeCloseTo(5588, 6);
  // GIZA-SS1 holds no shares in the configured vault → NAV = idle-only, unaffected.
  expect(bySym["GIZA-SS1"]!.provenance).toBe("stub");
  expect(bySym["GIZA-SS1"]!.amount).toBeCloseTo(4524, 6);
  // Round 2 (convertToAssets) fires because ZYFAI-SS1 has non-zero vault shares.
  expect(counter.aggregateCalls).toBe(2);
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

test("BNKR (issue #148): the REAL baked default address (no BNKR_ADDRESS override) is a non-placeholder and resolves provenance 'live' via GeckoTerminal — regression guard for the address that was stuck 'stale'", async () => {
  // Deliberately mirror setBaseEnv() for every OTHER asset but leave
  // BNKR_ADDRESS UNSET so resolveTrackedAssets() falls through to the real
  // config default. Before #148 that default was the repeating-digit
  // placeholder 0x7777...7777 — a real (empty) Base account with no token
  // contract, so GeckoTerminal legitimately had no USD price for it and the
  // leg permanently degraded to 'stale'. This test would have caught that:
  // it fails red if the default ever regresses to a placeholder or otherwise
  // stops resolving live.
  process.env.PROP_WALLET_ADDRESSES = WALLET;
  process.env.USDC_ADDRESS = A.USDC;
  process.env.ZYFAI_SS1_ADDRESS = A.ZYFAI;
  process.env.GIZA_SS1_ADDRESS = A.GIZA;
  process.env.WETH_ADDRESS = A.WETH;
  process.env.ROBOTMONEY_ADDRESS = A.ROBOTMONEY;
  process.env.SP500_SIZE = "0.633";

  const bnkrAsset = resolveTrackedAssets().find((a) => a.symbol === "BNKR")!;
  expect(bnkrAsset.address).toBe("0x22af33fe49fd1fa80c7149773dde5890d3c76f3b");

  const fx = stubFixtures();
  delete fx.balanceOf![A.BNKR]; // the fake test-double address is no longer used
  fx.balanceOf![bnkrAsset.address!] = 20000n * E18;
  fx.gecko = { [A.WETH]: 1700, [A.ROBOTMONEY]: 0.00002, [bnkrAsset.address!]: 0.000367390519898331 };
  fx.sp500Price = 4700;
  mockChain(fx);

  const r = await fetchWalletBalances();
  expect(r.priceSource).toBe("live");
  const bnkr = r.holdings.find((h) => h.symbol === "BNKR")!;
  expect(bnkr.provenance).toBe("live"); // not 'stale' — the live GeckoTerminal read succeeded
  expect(bnkr.priceUsd).toBeCloseTo(0.000367390519898331, 12);
  expect(bnkr.valueUsd).toBeCloseTo(20000 * 0.000367390519898331, 6);
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
  const r = await getWalletBalances();
  expect(r.holdings).toHaveLength(8);
});

// ── issue #118: chain reads happen ONLY on the schedule. The REQUEST path must
// serve persisted samples with ZERO RPC. This is the core new invariant. ───────

test("AC8 (issue #118): the request path serves PERSISTED samples and makes ZERO RPC (never calls fetch)", async () => {
  setBaseEnv();
  // Seed the latest sample per symbol directly (as the scheduled sampler would),
  // with DISTINCT provenance values that must be echoed back verbatim.
  const today = new Date().toISOString().slice(0, 10);
  const rows: [string, number, number, number, string][] = [
    ["USDC", 9052, 1, 9052, "live"],
    ["WETH", 10, 1700, 17000, "live"],
    ["ETH", 0.5, 1600, 800, "stub"],
    ["ROBOTMONEY", 3_000_000_000, 0.00001, 30000, "stale"],
    ["BNKR", 20000, 0.0005, 10, "seed"],
  ];
  for (const [symbol, amount, price, value, prov] of rows) {
    await sql`
      INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES (${today}, ${symbol}, ${amount}, ${price}, ${value}, ${prov}, now())
    `;
  }

  // ANY call to fetch on the request path is a hard failure — the whole point of
  // #118 is that a client request never touches the RPC (or any host).
  let fetchCalls = 0;
  globalThis.fetch = (async (...args: unknown[]) => {
    fetchCalls++;
    throw new Error(`request path must not fetch — was called with ${String(args[0])}`);
  }) as unknown as typeof fetch;

  const r = await fetchPersistedWalletBalances();
  expect(fetchCalls).toBe(0); // ZERO RPC / price fetches on the request path

  const bySym = Object.fromEntries(r.holdings.map((h) => [h.symbol, h]));
  // Provenance is echoed EXACTLY as persisted — never relabelled.
  expect(bySym.USDC!.provenance).toBe("live");
  expect(bySym.USDC!.valueUsd).toBeCloseTo(9052, 6);
  expect(bySym.WETH!.provenance).toBe("live");
  expect(bySym.WETH!.valueUsd).toBeCloseTo(17000, 6);
  expect(bySym.ETH!.provenance).toBe("stub");
  expect(bySym.ROBOTMONEY!.provenance).toBe("stale");
  expect(bySym.ROBOTMONEY!.valueUsd).toBeCloseTo(30000, 6);
  expect(bySym.BNKR!.provenance).toBe("seed");
  // A tracked symbol with NO persisted sample (GIZA-SS1, ZYFAI-SS1, SP500) →
  // honest 'stale' with null values, never fabricated.
  for (const sym of ["GIZA-SS1", "ZYFAI-SS1", "SP500"]) {
    expect(bySym[sym]!.provenance).toBe("stale");
    expect(bySym[sym]!.valueUsd).toBeNull();
  }
  // Ordering + metadata come from resolveTrackedAssets (samples table has neither).
  expect(r.holdings.map((h) => h.symbol)).toEqual(resolveTrackedAssets().map((a) => a.symbol));
  expect(r.holdings).toHaveLength(8);
  // totalUsd = sum of the non-null latest values.
  expect(r.totalUsd).toBeCloseTo(9052 + 17000 + 800 + 30000 + 10, 6);
  // Top-level provenance markers stay config-resolved (no RPC) — badge still works.
  expect(r.source).toBe("live");
  expect(r.priceSource).toBe("live");
});

test("AC8b (issue #118): the request path reflects the LATEST scheduled sample per symbol (newest sample_date wins), never an older row", async () => {
  setBaseEnv();
  // An OLD live sample and a NEWER stale degrade for the same symbol: the request
  // path must serve the NEWEST (the last thing the schedule persisted).
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES ('2026-07-01', 'WETH', 10, 1500, 15000, 'live', '2026-07-01T00:10:00Z'),
           ('2026-07-13', 'WETH', 10, 1550, 15500, 'stale', '2026-07-13T00:10:00Z')
  `;
  const r = await fetchPersistedWalletBalances();
  const weth = r.holdings.find((h) => h.symbol === "WETH")!;
  expect(weth.provenance).toBe("stale"); // the newer row
  expect(weth.valueUsd).toBeCloseTo(15500, 6);
});

// issue #614 AC6: this test was previously named "...returns it as
// CONTINUOUS..." while asserting only `date[i] >= date[i-1]` — a tautology
// against the endpoint's own `ORDER BY sample_date ASC`, true even over a
// 40-day hole. The series is genuinely, deliberately SPARSE over the
// calendar axis (contract/src/dashboards.d.ts's WalletHistoryPoint comment),
// not continuous — the seeded portion carries known gaps ported from its v0
// source. This asserts what is actually true: dates are unique and strictly
// increasing (a REAL ordering/dedupe guarantee), and explicitly proves two
// known gap days are absent rather than silently forward-filled.
test("history: backfill seeds the pre-launch series; the endpoint returns it strictly ordered and honestly sparse, group-ordered byAsset days", async () => {
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
  // History is STRICTLY ascending — unique dates, never a duplicate or
  // out-of-order row (a real guarantee, unlike the old `>=` tautology that
  // held even across a gap).
  for (let i = 1; i < r.history.length; i++) {
    expect(r.history[i]!.date > r.history[i - 1]!.date).toBe(true);
  }
  // Honestly sparse, not silently forward-filled: known gap days from the v0
  // seed source are genuinely ABSENT rows, not zero-filled or interpolated
  // ones. A consumer reading `history` linearly (rather than indexing by
  // `date`) would otherwise draw these as one continuous line across the
  // hole — the exact defect issue #614 was filed from.
  const dates = new Set(r.history.map((h) => h.date));
  expect(dates.has("2026-03-24")).toBe(false);
  expect(dates.has("2026-06-04")).toBe(false);

  // issue #614 AC5: the whole series is still 100% seed at this point (only
  // backfillWalletHistory has run — no sampler write yet), so every point's
  // day-level provenance must read 'seed', and the summary count must agree.
  for (const point of r.history) expect(point.provenance).toBe("seed");
  expect(r.historyProvenance).toEqual({ live: 0, stub: 0, stale: 0, seed: r.history.length });
});

// issue #614 AC5: once the daily sampler writes a live day, that ONE day must
// read 'live' while every earlier seeded day still reads 'seed' — the seam
// between backfilled and live-sampled history must be visible per-point, not
// collapsed into one series-wide label.
test("history: a live-sampled day is distinguishable from the seeded backfill it follows", async () => {
  await backfillWalletHistory();
  setBaseEnv();
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain(stubFixtures());
  await sampleWalletBalances({}); // stub-sourced, but NOT provenance 'seed' — a genuine sampler write
  _resetWalletBalancesCacheForTests();
  mockChain(stubFixtures());

  const r = await fetchWalletBalances();
  const today = new Date().toISOString().slice(0, 10);
  const todayPoint = r.history.find((h) => h.date === today)!;
  expect(todayPoint.provenance).not.toBe("seed");
  const seededPoint = r.history.find((h) => h.date === "2026-03-19")!;
  expect(seededPoint.provenance).toBe("seed");
  expect(r.historyProvenance.seed).toBeGreaterThan(0);
  expect(r.historyProvenance.seed + r.historyProvenance.live + r.historyProvenance.stub + r.historyProvenance.stale).toBe(r.history.length);
});

test("AC2 (issue #94): backfillWalletHistory never writes the literal provenance 'live'", async () => {
  // Source guard: the backfill body must not label seeded rows 'live'. Reading
  // the handler source keeps this honest even if a future edit reintroduces the
  // literal without the DB assertion above catching it in a stale fixture.
  const src = await Bun.file(new URL("../../src/db/seed.ts", import.meta.url)).text();
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

// issue #614 AC2: a Class C sampler must decline a REPLAYED slot for a past
// date rather than silently rewriting today's row with today's data under
// that stale key. Must fail against pre-#614 main: sampleWalletBalances
// ignored its payload entirely and always sampled `new Date()`, so a slot
// enqueued 3 days late would still write a fresh TODAY row and report
// success, with nothing to show the missed days were ever detected.
test("sampler: a slot replayed three days late declines with a recorded reason instead of rewriting today's row (issue #614 AC2)", async () => {
  setBaseEnv();
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  mockChain(stubFixtures());
  const today = new Date().toISOString().slice(0, 10);
  const staleSlot = new Date(Date.now() - 3 * 86_400_000).toISOString();

  const result = (await sampleWalletBalances({ slotAt: staleSlot })) as { ok: boolean; skipped?: boolean; reason?: string };
  expect(result.ok).toBe(true); // not a failure — the correct outcome for this input
  expect(result.skipped).toBe(true);
  expect(typeof result.reason).toBe("string");
  expect(result.reason).toContain("Class C");

  // Nothing was written under today's key — the whole point of declining.
  const rows = await sql`SELECT count(*)::int AS c FROM wallet_balance_samples WHERE sample_date = ${today}`;
  expect(rows[0]!.c).toBe(0);

  // An ON-TIME slot (no slotAt, or a fresh one) still samples normally —
  // the decline is specific to a stale replay, not a blanket regression.
  await sampleWalletBalances({});
  const onTime = await sql`SELECT count(*)::int AS c FROM wallet_balance_samples WHERE sample_date = ${today}`;
  expect(onTime[0]!.c).toBe(8);
});

// ── issue #294 regression guard ─────────────────────────────────────────────
// wallet-sleeves.ts's new sampler (worker/handlers/wallet.ts::sampleWalletSleeves)
// needs valueLeg to fall back to a recent PERSISTED price when the live price
// provider fails, so it explicitly passes persistedFallbackWalletPriceReader as
// an argument at that call site. valueLeg's DEFAULT priceReader parameter must
// stay providerWalletPriceReader — wallet-balances.ts::valueAsset (called by
// fetchWalletBalances, the /api/dashboards/wallet-balances request path, which
// issue #294 explicitly puts out of scope) calls valueLeg with NO reader
// argument and relies on that default. If the default were ever changed to
// persistedFallbackWalletPriceReader, a price-fetch failure with a SUCCESSFUL
// chain read would silently blend a FRESH on-chain amount with a STALE
// persisted price instead of falling through to lastPersistedHolding()'s fully
// -stale snapshot (amount, price, AND value all from the same persisted row).
test("issue #294 regression: fetchWalletBalances degrade path is unchanged — a live price-fetch failure with a successful chain read still degrades the WHOLE holding to lastPersistedHolding(), never a fresh-amount/stale-price blend", async () => {
  setBaseEnv();
  // Live pricing (BASE_RPC_SOURCE/PRICE_SOURCE left unset) so the real
  // providerWalletPriceReader → fetchAssetPriceUsd → GeckoTerminal path runs
  // for BNKR. Every OTHER live-priced asset gets a gecko/yahoo fixture; BNKR's
  // is deliberately omitted so its price fetch throws while its chain read
  // (fresh balanceOf) still succeeds — exactly the failure mode the finding
  // describes.
  const fx = stubFixtures();
  fx.gecko = { [A.WETH]: 1700, [A.ROBOTMONEY]: 0.00002, [A.BNKR]: 0.001 };
  fx.geckoOmit = [A.BNKR]; // BNKR's address is missing from an otherwise-successful response
  fx.sp500Price = 4700;
  mockChain(fx);

  // A recent (well within MAX_PERSISTED_PRICE_AGE_MS) persisted BNKR sample
  // with amount/price DIFFERENT from the fresh chain fixture (20,000 BNKR
  // above). This is deliberately "eligible" for
  // persistedFallbackWalletPriceReader's fallback lookup, so if that reader
  // ever became valueLeg's default again, this test would catch it: the
  // buggy path would return the FRESH chain amount (20000) priced at the
  // persisted price, not this persisted row's own amount/value.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES ('2026-06-25', 'BNKR', 15000, 0.0004, 6, 'live', now())
  `;

  const r = await fetchWalletBalances();
  const bnkr = r.holdings.find((h) => h.symbol === "BNKR")!;
  // Correct (providerWalletPriceReader default): valueLeg's price read throws,
  // so valueLeg returns {ok:false} and valueAsset degrades the WHOLE holding to
  // lastPersistedHolding() — amount, priceUsd, AND valueUsd all come from the
  // SAME persisted row, never a blend with the fresh on-chain amount.
  expect(bnkr.provenance).toBe("stale");
  expect(bnkr.amount).toBeCloseTo(15000, 6); // persisted amount, NOT the fresh 20000
  expect(bnkr.priceUsd).toBeCloseTo(0.0004, 6);
  expect(bnkr.valueUsd).toBeCloseTo(6, 6); // persisted value, NOT 20000 * 0.0004
  // Other legs' live price reads succeeded and are unaffected.
  for (const sym of ["WETH", "ROBOTMONEY", "SP500"]) {
    expect(r.holdings.find((h) => h.symbol === sym)!.provenance).toBe("live");
  }
});
