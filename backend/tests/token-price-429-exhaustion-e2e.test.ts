// Issue #202 (rescoped 2026-07-22): prove the token-price 429-exhaustion path
// honest-degrades END TO END, and that the smoke-readiness gate's only
// token-price-dependent boot step survives persistent 429s.
//
// What makes this file different from the existing partial coverage:
//   - tests/token-prices-resilience.test.ts:48-58 drives real 429-exhaustion
//     but only asserts the THROW (the documented token-prices.ts contract);
//   - tests/api/dashboards-live.test.ts exercises degrade-to-stale but via a
//     GENERIC injected transport throw (`failPrice: true` throws before any
//     HTTP status exists), never the real bounded 429 retry budget.
// Here the mocked transport returns a REAL `429 Too Many Requests` Response
// for every GeckoTerminal token_price request, so the genuine retry loop in
// chain/token-prices.ts (fetchGeckoTokenPricesUsdUncached) runs its full
// bounded budget (GECKO_PRICE_MAX_RETRIES) and throws ITS OWN 429-exhaustion
// error through valueLeg → valueAsset, which must degrade each gecko-priced
// leg to its last-persisted wallet_balance_samples row with provenance
// 'stale' — never rethrow, never fabricate (the same honest-degrade path BNKR
// uses; original #202 AC3).
//
// Demo-readiness gate (AC2): the gate is e2e.yml's "Full-stack smoke" step
// (scripts/smoke.ts → scripts/lib/smoke-main.ts), which reaches READY when
// postgres + migrations/seed + api/mcp /health + the EDGAR bootstrap complete
// AND the worker lanes stay up. The ONLY step in that boot sequence that
// touches the token-price feed is the seed's cold-start
// `wallet.sample_balances` job on the analytics lane (db/seed.ts enqueues it
// with dedupe_key 'wallet.sample_balances:coldstart'; /health is SELECT 1 and
// the request-path wallet endpoint reads ONLY persisted samples). The original
// #202 defect report was exactly this job's 429-exhaustion throw killing the
// analytics worker and with it the gate. The AC2 test reproduces the boot
// condition hermetically: same job row, processed through the REAL queue
// machinery (worker/loop.ts processOneJob on LANES.analytics) with the price
// feed persistently 429ing. The job must settle 'succeeded' — the worker loop
// survives, nothing throws — with the degraded 'stale' rows persisted and the
// request-path wallet endpoint still serving. Stubbing the 429s (rather than
// hitting real GeckoTerminal) is deliberate: deterministic, and it does not
// burn the shared per-IP CI/smoke quota that caused the symptom.
//
// Postgres is REQUIRED and provisioned by tests/preload.ts, which FAILS LOUDLY
// when Docker/Postgres is absent — never a silent skip (test-coverage policy).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { decodeAggregate3Calls, encodeAggregate3Result, type Aggregate3Result } from "../src/chain/base-rpc-client.ts";
import { fetchWalletBalances, _resetWalletBalancesCacheForTests } from "../src/chain/wallet-balances.ts";
import { _resetTokenPriceCacheForTests } from "../src/chain/token-prices.ts";
import { _resetRateLimitStateForTests } from "../src/chain/gecko-rate-limit.ts";
import { getWalletBalances } from "../src/api/routes/dashboards.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { LANES } from "../src/worker/lanes.ts";

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");

const ENV_KEYS = [
  "BASE_RPC_SOURCE",
  "PRICE_SOURCE",
  "GECKO_PRICE_MAX_RETRIES",
  "GECKO_PRICE_RETRY_BASE_MS",
  "GECKO_MIN_INTERVAL_MS",
] as const;

// The bounded budget under test: 2 retries → exactly 3 upstream attempts for
// ONE micro-batched token_price request (WETH/ETH share one address, so the
// wallet feeds' same-tick gecko fan-out coalesces into a single request).
const MAX_RETRIES = 2;
const EXPECTED_GECKO_ATTEMPTS = MAX_RETRIES + 1;

beforeEach(async () => {
  process.env.BASE_RPC_SOURCE = "live"; // real batched-multicall path against the mocked transport
  process.env.PRICE_SOURCE = "live"; // real GeckoTerminal/Yahoo path against the mocked transport
  process.env.GECKO_PRICE_MAX_RETRIES = String(MAX_RETRIES);
  process.env.GECKO_PRICE_RETRY_BASE_MS = "1";
  process.env.GECKO_MIN_INTERVAL_MS = "0";
  _resetTokenPriceCacheForTests();
  _resetWalletBalancesCacheForTests();
  _resetRateLimitStateForTests();
  await sql`DELETE FROM wallet_balance_samples`;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  for (const k of ENV_KEYS) delete process.env[k];
  _resetTokenPriceCacheForTests();
  _resetWalletBalancesCacheForTests();
  _resetRateLimitStateForTests();
  await sql`DELETE FROM wallet_balance_samples`;
});

// Transport mock: Base RPC (Multicall3 aggregate3) answers healthily so every
// chain AMOUNT read succeeds; the PRICE hosts return persistent, REAL HTTP 429
// responses — GeckoTerminal through its genuine bounded retry loop, Yahoo
// (SP500) through fetchJson's non-ok throw. Counts every gecko/yahoo hit so
// the tests can assert the real retry budget was actually exhausted.
const BALANCE_OF = "0x70a08231";
const CONVERT_TO_ASSETS = "0x07a2d13a"; // ERC-4626 convertToAssets(uint256)
const GET_ETH_BALANCE = "0x4d2301cc"; // Multicall3 getEthBalance(address)
const AGGREGATE3 = "0x82ad56cb"; // Multicall3 aggregate3(Call3[])
function mockPersistent429Transport(): { gecko: number; yahoo: number } {
  const counters = { gecko: 0, yahoo: 0 };
  const subResult = (callData: string): Aggregate3Result => {
    const sel = callData.slice(0, 10);
    if (sel === GET_ETH_BALANCE) return { success: true, returnData: word(50_000_000_000_000_000n) };
    if (sel === BALANCE_OF) return { success: true, returnData: word(1_000_000n) };
    // Round-2 strategy NAV. Since issue #642 baked the real ERC-4626 vault
    // addresses into the strategy position list, the blanket non-zero
    // balanceOf above gives both strategy accounts vault shares, so round 2
    // fires. It must SUCCEED here: this test is about the PRICE hosts being
    // rate-limited while every chain AMOUNT read stays healthy, and a thrown
    // sub-call would degrade the strategy legs for the wrong reason and mask
    // exactly the assertion below (that pinned-$1 legs stay 'live').
    if (sel === CONVERT_TO_ASSETS) return { success: true, returnData: word(1_000_000n) };
    throw new Error(`mock transport: unexpected sub-call selector ${sel}`);
  };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) {
      counters.gecko += 1;
      // A REAL rate-limit response: the retry loop must see status 429 and
      // walk its bounded budget — this is NOT an injected generic throw.
      return new Response("Rate limit exceeded", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "0" },
      });
    }
    if (u.includes("finance.yahoo.com")) {
      counters.yahoo += 1;
      return new Response("Rate limit exceeded", { status: 429, statusText: "Too Many Requests" });
    }
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (body.method === "eth_call") {
      const data = (body.params[0] as { data: string }).data;
      if (data.slice(0, 10) === AGGREGATE3) {
        const results = decodeAggregate3Calls(data).map((c) => subResult(c.callData));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAggregate3Result(results) }), { status: 200 });
      }
    }
    throw new Error(`mock transport: unexpected RPC method ${body.method}`);
  }) as unknown as typeof fetch;
  return counters;
}

async function seedYesterdayWethSample(): Promise<void> {
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (current_date - 1, 'WETH', 1.5, 2500, 3750, 'live', now() - interval '1 day')
  `;
}

// ── AC1: real 429-exhaustion → last-persisted 'stale' sample, no throw ──────
test("persistent GeckoTerminal 429s exhaust the REAL bounded retry budget and the wallet sampler's holding output degrades to the last-persisted sample with provenance 'stale' — no throw escapes", async () => {
  await seedYesterdayWethSample();
  const counters = mockPersistent429Transport();

  // Capture the degrade log so the test proves the stale holdings were caused
  // by the genuine 429-exhaustion error (status text and all), not by some
  // other failure that happens to end in the same degrade path.
  const degradeLogs: string[] = [];
  console.error = (...args: unknown[]) => {
    degradeLogs.push(args.map(String).join(" "));
  };

  const r = await fetchWalletBalances(); // must resolve — a 429 leg never rejects the feed

  // The REAL retry loop ran to exhaustion: one micro-batched token_price
  // request (WETH+ETH dedup to one address, +ROBOTMONEY +BNKR) hit upstream
  // exactly maxRetries+1 times and every attempt saw a real HTTP 429.
  expect(counters.gecko).toBe(EXPECTED_GECKO_ATTEMPTS);
  expect(counters.yahoo).toBe(1); // SP500's Yahoo read 429s too (no retry loop there)
  expect(degradeLogs.some((l) => /429/.test(l))).toBe(true); // degrades were caused BY the 429s

  const holding = Object.fromEntries(r.holdings.map((h) => [h.symbol, h]));

  // WETH: degraded to EXACTLY its last-persisted sample — value carried
  // forward honestly, provenance 'stale', never relabelled or fabricated.
  expect(holding.WETH).toMatchObject({ amount: 1.5, priceUsd: 2500, valueUsd: 3750, provenance: "stale" });

  // Gecko legs with NO persisted sample degrade to honest nulls + 'stale'
  // (never a fabricated number), and SP500's yahoo 429 degrades identically.
  for (const symbol of ["ETH", "ROBOTMONEY", "BNKR", "SP500"] as const) {
    expect(holding[symbol]).toMatchObject({ amount: null, priceUsd: null, valueUsd: null, provenance: "stale" });
  }

  // Pinned-$1 legs are untouched by the price-feed outage: still live-valued.
  for (const symbol of ["USDC", "ZYFAI-SS1", "GIZA-SS1"] as const) {
    expect(holding[symbol]!.provenance).toBe("live");
    expect(holding[symbol]!.priceUsd).toBe(1);
  }
});

// ── AC2: smoke-readiness gate reaches ready under persistent 429s ────────────
test("smoke-readiness gate reaches ready under persistent 429s: the boot's cold-start wallet.sample_balances job settles 'succeeded' on the analytics lane (worker survives) and the request-path wallet endpoint keeps serving", async () => {
  await seedYesterdayWethSample();

  // The exact cold-start job db/seed.ts enqueues during the gate's
  // migrate+seed step. Queue cleared first so the claim below deterministically
  // picks this job (same isolation discipline as tests/queue.test.ts; DELETE
  // instead of TRUNCATE CASCADE so FK'd telemetry tables just SET NULL).
  await sql`DELETE FROM job_runs`;
  await sql`DELETE FROM jobs`;
  const [job] = await sql<{ id: number }[]>`
    INSERT INTO jobs (kind, payload, dedupe_key)
    VALUES ('wallet.sample_balances', '{}', 'wallet.sample_balances:coldstart')
    RETURNING id
  `;

  const counters = mockPersistent429Transport();
  try {
    // The REAL worker machinery, same lane as the smoke's worker-analytics
    // container. processOneJob resolving (instead of the handler's throw
    // escaping) IS the worker surviving — the original #202 defect mode.
    expect(await processOneJob({ lane: LANES.analytics, workerId: "test-429-analytics" })).toBe(true);

    // The price feed really was exercised through the real retry budget.
    expect(counters.gecko).toBe(EXPECTED_GECKO_ATTEMPTS);

    // The job settled 'succeeded' — NOT failed/dead/degraded — because the
    // sampler honest-degrades under 429-exhaustion instead of throwing, so
    // the analytics lane keeps its capacity and the gate's boot proceeds.
    const [row] = await sql<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM jobs WHERE id = ${job!.id}
    `;
    expect(row!.status).toBe("succeeded");
    expect(row!.last_error).toBeNull();
    const runs = await sql<{ status: string }[]>`SELECT status FROM job_runs WHERE job_id = ${job!.id}`;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");

    // The sampler persisted TODAY's WETH row as the carried-forward persisted
    // sample, honestly marked 'stale' (never relabelled live, never dropped).
    const [sample] = await sql<{ provenance: string; price_usd: string; value_usd: string }[]>`
      SELECT provenance, price_usd, value_usd FROM wallet_balance_samples
       WHERE symbol = 'WETH' AND sample_date = current_date
    `;
    expect(sample!.provenance).toBe("stale");
    expect(Number(sample!.price_usd)).toBe(2500);
    expect(Number(sample!.value_usd)).toBe(3750);

    // The request-path endpoint the gate's post-READY frontend check hits
    // (GET /api/dashboards/wallet-balances → persisted reader, zero price
    // fetches) serves the degraded-but-honest payload instead of 5xxing.
    const payload = await getWalletBalances();
    const weth = payload.holdings.find((h) => h.symbol === "WETH");
    expect(weth).toMatchObject({ priceUsd: 2500, valueUsd: 3750, provenance: "stale" });
  } finally {
    await sql`DELETE FROM job_runs`;
    await sql`DELETE FROM jobs`;
  }
});
