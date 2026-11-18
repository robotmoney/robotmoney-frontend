// Issue 1664: a process never sends more than GECKO_PRO_CALLS_PER_MIN Pro calls a minute. CoinGecko counts the paid
// credit per account, and every process holding the key spends the same pool, so a call over the budget is sent to
// the free host instead. Fake clock; no network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { budgetedTarget, geckoUrl, tierOf, _resetGeckoEndpointForTests } from "../src/chain/gecko-endpoint.ts";
import { _resetRateLimitStateForTests, proCallsPerMin } from "../src/chain/gecko-rate-limit.ts";

const KEY = "budget-test-key-0123";
const quiet = { warn: () => {} };

beforeEach(() => {
  _resetGeckoEndpointForTests();
  _resetRateLimitStateForTests();
  process.env.GECKO_PRO_CALLS_PER_MIN = "2";
});
afterEach(() => {
  delete process.env.GECKO_PRO_CALLS_PER_MIN;
  _resetRateLimitStateForTests();
});

test("the default budget is two Pro calls a minute", () => {
  delete process.env.GECKO_PRO_CALLS_PER_MIN;
  expect(proCallsPerMin()).toBe(2);
});

test("with a budget of 2 and a key set, the third Pro-eligible call inside one minute goes to the free host, and the counter resets after the window", () => {
  const t0 = 10_000_000;
  const url = geckoUrl("token_price", "/simple/networks/base/token_price/0xabc", { key: KEY, now: t0, log: quiet });
  expect(tierOf(url)).toBe("pro");

  const tiers = [t0, t0 + 1_000, t0 + 2_000].map((t) => tierOf(budgetedTarget(url, t, quiet)));
  expect(tiers).toEqual(["pro", "pro", "free"]);
  expect(budgetedTarget(url, t0 + 2_000, quiet)).toBe("https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/0xabc");

  // Still inside a minute of the first call.
  expect(tierOf(budgetedTarget(url, t0 + 59_999, quiet))).toBe("free");
  // The first call has left the window: one slot frees up, and only one.
  expect(tierOf(budgetedTarget(url, t0 + 60_000, quiet))).toBe("pro");
  expect(tierOf(budgetedTarget(url, t0 + 60_500, quiet))).toBe("free");
  // Both earlier calls have left the window.
  expect(tierOf(budgetedTarget(url, t0 + 61_000, quiet))).toBe("pro");
});

test("free-host URLs never spend the budget", () => {
  const free = "https://api.geckoterminal.com/api/v2/networks/new_pools?page=1";
  for (let i = 0; i < 5; i++) expect(budgetedTarget(free, 1_000 + i, quiet)).toBe(free);
  const pro = "https://pro-api.coingecko.com/api/v3/coins/markets?ids=x";
  expect(budgetedTarget(pro, 2_000, quiet)).toBe(pro);
  expect(budgetedTarget(pro, 2_001, quiet)).toBe(pro);
  expect(budgetedTarget(pro, 2_002, quiet)).toBe("https://api.coingecko.com/api/v3/coins/markets?ids=x");
});
