// TRANSPORT INVARIANT for the projects live source (issue #129, maintainability
// finding 015): vaultErc4626Read must flow through chain/base-rpc-client.ts —
// the SINGLE Base JSON-RPC transport — so the vault-TVL cron inherits the #119
// rate-limit machinery (concurrency gate, 429/Retry-After retry, User-Agent)
// instead of hand-rolling its own POST against the same public node the wallet
// feed already got 429'd on.
//
// Same discipline as tests/base-rpc-client.test.ts / tests/api/wallet-balances
// .test.ts: fetch is mocked ONLY at the process boundary (globalThis.fetch) and
// the REAL transport + live source execute — nothing internal is stubbed. Fully
// offline; gates every PR (no skips, no network).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { liveProjectsDataSource } from "../src/projects/access/live-source.ts";
import { _resetRpcConcurrencyForTests, decodeAggregate3Calls, encodeAggregate3Result, type Aggregate3Result } from "../src/chain/base-rpc-client.ts";
import { _resetTokenPriceCacheForTests } from "../src/chain/token-prices.ts";

const realFetch = globalThis.fetch;

const KNOBS = [
  "BASE_RPC_MAX_CONCURRENCY", "BASE_RPC_MAX_RETRIES", "BASE_RPC_RETRY_BASE_MS", "LIVE_FETCH_TIMEOUT_MS",
  "BASE_RPC_SOURCE", "PRICE_SOURCE", "WETH_ADDRESS", "WETH_POOL_ID",
] as const;

const VAULT = "0x" + "aa".repeat(20);
// Base USDC — a STABLES member, so the underlying is pinned $1 and the read
// never needs a DexScreener price fetch (keeps the mock purely RPC-shaped).
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const SEL_TOTAL_ASSETS = "0x01e1d114"; // totalAssets()
const SEL_ASSET = "0x38d52e0f"; // asset()
const SEL_DECIMALS = "0x313ce567"; // decimals()

const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");
const addressWord = (addr: string): string => "0x" + addr.replace(/^0x/, "").padStart(64, "0");

// Answer one eth_call by selector with the fixture vault's values:
// totalAssets = 1,234 USDC (6 dp raw), asset() = Base USDC, decimals() = 6.
function answer(data: string): string {
  const sel = data.slice(0, 10);
  if (sel === SEL_TOTAL_ASSETS) return word(1_234_000_000n);
  if (sel === SEL_ASSET) return addressWord(USDC_BASE);
  if (sel === SEL_DECIMALS) return word(6n);
  throw new Error(`unexpected selector ${sel}`);
}

interface SeenRequest {
  url: string;
  userAgent: string | null;
  body: { jsonrpc?: string; method?: string; params?: unknown[] };
}

beforeEach(() => {
  process.env.BASE_RPC_RETRY_BASE_MS = "1"; // keep any backoff ~instant
  _resetRpcConcurrencyForTests();
  _resetTokenPriceCacheForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KNOBS) delete process.env[k];
  _resetRpcConcurrencyForTests();
  _resetTokenPriceCacheForTests();
});

test("(a) a 429 with Retry-After on a vault read is retried by the shared transport and the read succeeds", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls++;
    // First RPC request is rate-limited; every subsequent one answers. If the
    // live source bypassed base-rpc-client (its old hand-rolled POST), the 429
    // would throw immediately and this read would fail.
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    const body = JSON.parse(String(init?.body)) as { params: [{ data: string }, string] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer(body.params[0].data) }), { status: 200 });
  }) as typeof fetch;

  const read = await liveProjectsDataSource.vaultErc4626Read(VAULT, "base");
  expect(read).toEqual({ totalAssetsRaw: "1234000000", decimals: 6, assetPriceUsd: 1 });
  expect(calls).toBe(4); // one 429 + retried totalAssets + asset + decimals
});

test("(b) every vault-read RPC request carries the transport's User-Agent and a correct eth_call body", async () => {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as SeenRequest["body"] & { params: [{ to: string; data: string }, string] };
    seen.push({ url: String(url), userAgent: new Headers(init?.headers).get("user-agent"), body });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer(body.params[0].data) }), { status: 200 });
  }) as typeof fetch;

  await liveProjectsDataSource.vaultErc4626Read(VAULT, "base");
  expect(seen).toHaveLength(3); // totalAssets → asset → decimals, in order
  for (const r of seen) {
    expect(r.url).toBe(config.baseRpcUrl); // the configured Base RPC, nothing else
    expect(r.userAgent).toBe("robotmoney-rmpc/1.0"); // the public node 403s bare POSTs
    expect(r.body.jsonrpc).toBe("2.0");
    expect(r.body.method).toBe("eth_call");
    expect((r.body.params as [unknown, string])[1]).toBe("latest");
  }
  const [totalAssets, asset, decimals] = seen.map((r) => (r.body.params as [{ to: string; data: string }, string])[0]);
  expect(totalAssets!.to).toBe(VAULT);
  expect(totalAssets!.data).toBe(SEL_TOTAL_ASSETS);
  expect(asset!.to).toBe(VAULT);
  expect(asset!.data).toBe(SEL_ASSET);
  expect(decimals!.to).toBe(USDC_BASE); // decimals() is read on the UNDERLYING
  expect(decimals!.data).toBe(SEL_DECIMALS);
});

test("(c) with BASE_RPC_MAX_CONCURRENCY=1 concurrent vault reads are serialized by the shared gate (max in-flight 1)", async () => {
  process.env.BASE_RPC_MAX_CONCURRENCY = "1";
  _resetRpcConcurrencyForTests();

  let live = 0;
  let peak = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    live++;
    peak = Math.max(peak, live);
    // Hold the slot briefly so concurrent reads genuinely overlap unless gated.
    await new Promise((r) => setTimeout(r, 2));
    const body = JSON.parse(String(init?.body)) as { params: [{ data: string }, string] };
    live--;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer(body.params[0].data) }), { status: 200 });
  }) as typeof fetch;

  const vaults = ["0x" + "a1".repeat(20), "0x" + "b2".repeat(20), "0x" + "c3".repeat(20), "0x" + "d4".repeat(20)];
  const reads = await Promise.all(vaults.map((v) => liveProjectsDataSource.vaultErc4626Read(v, "base")));
  for (const r of reads) expect(r).toEqual({ totalAssetsRaw: "1234000000", decimals: 6, assetPriceUsd: 1 });
  expect(peak).toBe(1); // the module-level gate serialized 4×3 = 12 eth_calls
});

// ── walletBalanceUsd (issue #346) ────────────────────────────────────────────
// Same discipline: fetch mocked only at the process boundary; the real
// chain/wallet-valuation.ts machinery (Multicall3 getEthBalance + GeckoTerminal
// token_price) executes, proving the projects wallet-balance read genuinely
// reuses the shared prop-wallet valuation transport rather than a bespoke one.
const AGGREGATE3 = "0x82ad56cb";
const GET_ETH_BALANCE = "0x4d2301cc";
const WALLET = "0x" + "cd".repeat(20);

function mockEthBalanceAndPrice(nativeWei: bigint, priceUsd: number): { rpcCalls: number; geckoCalls: number } {
  const counter = { rpcCalls: 0, geckoCalls: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) {
      counter.geckoCalls += 1;
      const addrs = u.split("/token_price/")[1]!.toLowerCase().split(",");
      const token_prices: Record<string, string> = {};
      for (const addr of addrs) token_prices[addr] = String(priceUsd);
      return new Response(JSON.stringify({ data: { attributes: { token_prices } } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: [{ to: string; data: string }, string] };
    expect(body.method).toBe("eth_call");
    const { to, data } = body.params[0];
    expect(to).toBe("0xcA11bde05977b3631167028862bE2a173976CA11"); // Multicall3
    expect(data.slice(0, 10)).toBe(AGGREGATE3);
    counter.rpcCalls += 1;
    const calls = decodeAggregate3Calls(data);
    const results: Aggregate3Result[] = calls.map((c) => {
      expect(c.callData.slice(0, 10)).toBe(GET_ETH_BALANCE);
      return { success: true, returnData: word(nativeWei) };
    });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: encodeAggregate3Result(results) }), { status: 200 });
  }) as typeof fetch;
  return counter;
}

test("(d) walletBalanceUsd(chain='base') reads native ETH via the shared Multicall3 transport, priced via GeckoTerminal", async () => {
  const counter = mockEthBalanceAndPrice(2_000_000_000_000_000_000n, 2500); // 2 ETH @ $2500
  const usd = await liveProjectsDataSource.walletBalanceUsd(WALLET, "base");
  expect(usd).toBe(5000);
  expect(counter.rpcCalls).toBe(1);
  expect(counter.geckoCalls).toBe(1);
});

test("(e) walletBalanceUsd rejects (never fabricates a value) when the price read fails and no persisted fallback price exists", async () => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    const body = JSON.parse(String(init?.body)) as { id?: number; params: [{ data: string }, string] };
    const calls = decodeAggregate3Calls(body.params[0].data);
    const results: Aggregate3Result[] = calls.map(() => ({ success: true, returnData: word(1_000_000_000_000_000_000n) }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: encodeAggregate3Result(results) }), { status: 200 });
  }) as typeof fetch;
  process.env.GECKO_PRICE_MAX_RETRIES = "0";
  await expect(liveProjectsDataSource.walletBalanceUsd(WALLET, "base")).rejects.toThrow();
  delete process.env.GECKO_PRICE_MAX_RETRIES;
});

test("(f) walletBalanceUsd refuses a non-'base' chain without ever opening a socket (no live RPC/pricing path exists yet)", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("must not fetch");
  }) as typeof fetch;
  await expect(liveProjectsDataSource.walletBalanceUsd(WALLET, "ethereum")).rejects.toThrow(/only covers chain "base"/);
  await expect(liveProjectsDataSource.walletBalanceUsd(WALLET, "solana")).rejects.toThrow(/only covers chain "base"/);
  expect(calls).toBe(0);
});

// CI grep (AC): the live source contains ZERO hand-rolled RPC construction —
// no JSON-RPC envelope, no eth_call literal, no local 4-byte selector table.
// Every Base read must arrive via base-rpc-client imports; only the CoinGecko/
// DexScreener HTTP fetches (different hosts, not Base RPC) may fetch directly.
test("live-source.ts source contains no hand-rolled RPC (no jsonrpc/eth_call literals, no selector hex table)", async () => {
  const src = await Bun.file(new URL("../src/projects/access/live-source.ts", import.meta.url)).text();
  expect(src).toContain("callTotalAssets"); // positive control: right file, routed through base-rpc-client
  for (const forbidden of ["jsonrpc", "eth_call", SEL_TOTAL_ASSETS, SEL_ASSET, SEL_DECIMALS, "0x70a08231"]) {
    expect(src).not.toContain(forbidden);
  }
});
