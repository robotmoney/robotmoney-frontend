// Issue 1062: GeckoTerminal calls use the paid CoinGecko key where the plan (Basic) includes the call, fall back when
// the Pro host refuses, are paced per tier, and the key never reaches the source ledger.
//
// All HTTP is mocked at the process boundary and the waits are tens of milliseconds. No network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  PRO_CALLS, PRO_REJECTED_COOLDOWN_MS, fallBackToFree, freeUrlFor, geckoAuthHeaders, geckoUrl, isProUrl, proRefused, tierOf,
  _resetGeckoEndpointForTests,
} from "../src/chain/gecko-endpoint.ts";
import { _resetRateLimitStateForTests, serialized } from "../src/chain/gecko-rate-limit.ts";
import { captureSourceAcquisition, redactRequestIdentity, type AcquisitionSink } from "../src/analytics/source-ledger.ts";
import { fetchGeckoTerminalNewPools } from "../src/analytics/extract/geckoterminal.ts";

const KEY = "sentinel-paid-key-0123456789";
const FREE = "https://api.geckoterminal.com/api/v2";
const PRO = "https://pro-api.coingecko.com/api/v3/onchain";
const quiet = { warn: () => {} };
const realFetch = globalThis.fetch;
const realKey = process.env.COINGECKO_API_KEY;

beforeEach(() => {
  _resetGeckoEndpointForTests();
  _resetRateLimitStateForTests();
  delete process.env.COINGECKO_API_KEY;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.COINGECKO_API_KEY;
  else process.env.COINGECKO_API_KEY = realKey;
  delete process.env.GECKO_MIN_INTERVAL_MS;
  delete process.env.GECKO_PRO_MIN_INTERVAL_MS;
});

// ── host and header selection ────────────────────────────────────────────────

test("with no key, every call is the free host exactly as before", () => {
  expect(geckoUrl("new_pools", "/networks/new_pools?page=1", { log: quiet })).toBe(`${FREE}/networks/new_pools?page=1`);
  expect(geckoUrl("token_price", "/simple/networks/base/token_price/0xabc", { log: quiet })).toBe(`${FREE}/simple/networks/base/token_price/0xabc`);
  expect(geckoUrl("ohlcv", "/networks/base/pools/0xp/ohlcv/day?limit=1", { log: quiet })).toBe(`${FREE}/networks/base/pools/0xp/ohlcv/day?limit=1`);
});

test("a blank or whitespace key is no key", () => {
  for (const key of ["", "   ", undefined]) {
    expect(geckoUrl("new_pools", "/networks/new_pools?page=1", { key, log: quiet }).startsWith(FREE)).toBe(true);
  }
});

test("with a key, the calls the Basic plan includes go to the Pro host; OHLCV, which it does not, stays free", () => {
  expect([...PRO_CALLS].map(String).sort()).toEqual(["new_pools", "token_pools", "token_price"]);
  expect(geckoUrl("new_pools", "/networks/new_pools?page=2", { key: KEY, log: quiet })).toBe(`${PRO}/networks/new_pools?page=2`);
  expect(geckoUrl("token_pools", "/networks/base/tokens/0xabc/pools", { key: KEY, log: quiet })).toBe(`${PRO}/networks/base/tokens/0xabc/pools`);
  expect(geckoUrl("token_price", "/simple/networks/base/token_price/0xabc", { key: KEY, log: quiet })).toBe(`${PRO}/simple/networks/base/token_price/0xabc`);
  expect(geckoUrl("ohlcv", "/networks/base/pools/0xp/ohlcv/day?limit=1", { key: KEY, log: quiet })).toBe(`${FREE}/networks/base/pools/0xp/ohlcv/day?limit=1`);
});

test("the key header is sent to a Pro URL and to no other URL", () => {
  expect(geckoAuthHeaders(`${PRO}/networks/new_pools?page=1`, KEY)).toEqual({ "x-cg-pro-api-key": KEY });
  expect(geckoAuthHeaders(`${FREE}/networks/new_pools?page=1`, KEY)).toEqual({});
  expect(geckoAuthHeaders(`${PRO}/networks/new_pools?page=1`, "")).toEqual({});
  expect(isProUrl(`${PRO}/x`)).toBe(true);
  expect(isProUrl(`${FREE}/x`)).toBe(false);
  expect(isProUrl("https://pro-api.coingecko.com.evil.test/api/v3/onchain/x")).toBe(false);
  expect(tierOf(`${PRO}/x`)).toBe("pro");
  expect(tierOf(`${FREE}/x`)).toBe("free");
});

test("a key with a control character is never sent or logged, and the call uses the free host", () => {
  const bad = `${KEY}\nInjected: header`;
  const lines: string[] = [];
  const log = { warn: (m: string) => lines.push(m) };
  expect(geckoUrl("new_pools", "/networks/new_pools?page=1", { key: bad, log }).startsWith(FREE)).toBe(true);
  process.env.COINGECKO_API_KEY = bad;
  expect(geckoAuthHeaders(`${PRO}/networks/new_pools?page=1`, bad)).toEqual({});
  expect(lines.join("\n")).not.toContain(KEY);
  expect(lines.join("\n")).toContain("not a valid header value");
});

// ── the Pro host refuses ─────────────────────────────────────────────────────

test("a Pro 401 or 403 is the plan or key refusing; 429 and 5xx are not", () => {
  const u = `${PRO}/networks/new_pools?page=1`;
  expect(proRefused(u, 401)).toBe(true);
  expect(proRefused(u, 403)).toBe(true);
  expect(proRefused(u, 429)).toBe(false);
  expect(proRefused(u, 503)).toBe(false);
  expect(proRefused(`${FREE}/networks/new_pools?page=1`, 403)).toBe(false); // the free host's refusals are not ours to route around
});

test("after a refusal the call falls back to the free host, logs once, and the Pro host is tried again after ten minutes", () => {
  const lines: string[] = [];
  const log = { warn: (m: string) => lines.push(m) };
  const t0 = 1_000_000;
  const pro = `${PRO}/networks/new_pools?page=3`;
  expect(freeUrlFor(pro)).toBe(`${FREE}/networks/new_pools?page=3`);

  expect(fallBackToFree(pro, 403, "new_pools page 3", log, t0)).toBe(`${FREE}/networks/new_pools?page=3`);
  fallBackToFree(pro, 403, "new_pools page 4", log, t0 + 1_000); // a second refusal inside the cooldown
  expect(lines.filter((l) => l.includes("answered HTTP 403")).length).toBe(1);
  expect(lines.join("\n")).not.toContain(KEY);

  expect(geckoUrl("new_pools", "/networks/new_pools?page=5", { key: KEY, now: t0 + 60_000, log: quiet }).startsWith(FREE)).toBe(true);
  expect(geckoUrl("token_price", "/simple/networks/base/token_price/0xabc", { key: KEY, now: t0 + 60_000, log: quiet }).startsWith(FREE)).toBe(true);
  // the latch ran from the second refusal, so it holds just under ten minutes after it
  expect(geckoUrl("new_pools", "/networks/new_pools?page=5", { key: KEY, now: t0 + 1_000 + PRO_REJECTED_COOLDOWN_MS - 1, log: quiet }).startsWith(FREE)).toBe(true);
  expect(geckoUrl("new_pools", "/networks/new_pools?page=5", { key: KEY, now: t0 + 1_000 + PRO_REJECTED_COOLDOWN_MS, log: quiet }).startsWith(PRO)).toBe(true);
});

// ── pacing, per tier ─────────────────────────────────────────────────────────

test("Pro requests are spaced by the Pro interval; free requests keep the free interval since the previous FREE request", async () => {
  process.env.GECKO_MIN_INTERVAL_MS = "120";
  process.env.GECKO_PRO_MIN_INTERVAL_MS = "30";
  const at: { tier: string; t: number }[] = [];
  const run = (tier: "free" | "pro") => serialized(async () => { at.push({ tier, t: Date.now() }); }, tier);
  const t0 = Date.now();
  // free, then four Pro, then free: the second free must still be >= 120 ms after the first free.
  await Promise.all([run("free"), run("pro"), run("pro"), run("pro"), run("pro"), run("free")]);
  const free = at.filter((x) => x.tier === "free").map((x) => x.t);
  const pro = at.filter((x) => x.tier === "pro").map((x) => x.t);
  expect(free[1]! - free[0]!).toBeGreaterThanOrEqual(115);
  for (let i = 1; i < pro.length; i++) expect(pro[i]! - pro[i - 1]!).toBeGreaterThanOrEqual(25);
  expect(Date.now() - t0).toBeLessThan(2_000);
});

// ── the ledger never holds the key ───────────────────────────────────────────

test("redaction covers every api-key header and leaves ordinary headers alone", () => {
  const out = redactRequestIdentity(`${PRO}/networks/new_pools?page=1`, {
    "x-cg-pro-api-key": KEY,
    "X-CG-Demo-Api-Key": KEY,
    "x-api-key": KEY,
    "x-some-other-apikey": KEY,
    authorization: `Bearer ${KEY}`,
    "user-agent": "robotmoney",
    accept: "application/json",
  });
  expect(JSON.stringify(out)).not.toContain(KEY);
  expect(out.headers["x-cg-pro-api-key"]).toBe("[REDACTED]");
  expect(out.headers["x-cg-demo-api-key"]).toBe("[REDACTED]");
  expect(out.headers["user-agent"]).toBe("robotmoney");
  expect(out.headers.accept).toBe("application/json");
});

function newPoolsResponse() {
  const now = Date.parse("2026-07-15T12:00:00Z");
  return Response.json({ data: [
    { attributes: { pool_created_at: new Date(now - 3600_000).toISOString() } },
    { attributes: { pool_created_at: new Date(now - 30 * 3600_000).toISOString() } },
  ] });
}

test("an authenticated new_pools sweep goes to the Pro host with the key, and the saved evidence holds no key", async () => {
  process.env.COINGECKO_API_KEY = KEY;
  process.env.GECKO_PRO_MIN_INTERVAL_MS = "0";
  const sent: { url: string; key: string | null }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), key: new Headers(init.headers).get("x-cg-pro-api-key") });
    return newPoolsResponse();
  }) as unknown as typeof fetch;

  const collected: any[] = [];
  const sink: AcquisitionSink = { saveSourceAcquisition: async (e) => { collected.push(e); return { acquisitionId: e.id, replayed: false }; } };
  const points = await captureSourceAcquisition({ provider: "geckoterminal", sourceKey: "NEW_TOKENS", parserVersion: "1", cacheIdentity: "t" }, sink,
    () => fetchGeckoTerminalNewPools(Date.parse("2026-07-15T12:00:00Z"), 15000, { logger: quiet, sleep: async () => {} }));

  expect(points[0]!.value).toBe(1);
  expect(sent.length).toBe(1);
  expect(sent[0]!.url).toBe(`${PRO}/networks/new_pools?page=1`);
  expect(sent[0]!.key).toBe(KEY);
  expect(collected.length).toBe(1);
  expect(JSON.stringify(collected)).not.toContain(KEY);
  expect(collected[0].fetches[0].requestIdentity.headers["x-cg-pro-api-key"]).toBe("[REDACTED]");
});

test("the Pro host refusing a sweep falls back to the free host for that page and the next, with no key sent there", async () => {
  process.env.COINGECKO_API_KEY = KEY;
  process.env.GECKO_PRO_MIN_INTERVAL_MS = "0";
  const sent: { url: string; key: string | null }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = String(url);
    sent.push({ url: u, key: new Headers(init.headers).get("x-cg-pro-api-key") });
    if (u.startsWith(PRO)) return new Response(JSON.stringify({ status: { error_code: 10005 } }), { status: 403, statusText: "Forbidden" });
    return newPoolsResponse();
  }) as unknown as typeof fetch;

  const lines: string[] = [];
  const points = await fetchGeckoTerminalNewPools(Date.parse("2026-07-15T12:00:00Z"), 15000, { logger: { warn: (m) => lines.push(m) }, sleep: async () => {} });

  expect(points[0]!.value).toBe(1); // the count came from the free host, not a fabricated zero
  expect(sent.map((s) => s.url)).toEqual([`${PRO}/networks/new_pools?page=1`, `${FREE}/networks/new_pools?page=1`]);
  expect(sent[1]!.key).toBeNull();
  expect(lines.some((l) => l.includes("answered HTTP 403"))).toBe(true);
  expect(lines.join("\n")).not.toContain(KEY);
});
