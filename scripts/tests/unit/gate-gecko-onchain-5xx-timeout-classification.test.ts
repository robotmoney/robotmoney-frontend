// The paid CoinGecko host answering the onchain token_price request with a 5xx,
// a 408 or a fetch timeout is a provider fault the worker already degrades
// around, so both gates classify its lines and never fail on them (issue 1409).
//
// The lines are the shapes bun prints for console.error(headline, err) in
// backend/src/worker/handlers/token-market.ts readPrice and for the
// geckoFetchJson error in backend/src/chain/token-prices.ts, as seen on the
// v0.6.3 production preflight on 2026-10-21. RED CONTROLS: a 4xx, another
// endpoint, another cause behind the token-market headline, and the same lines
// from a non-worker container stay unclassified and fail.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const WORKER = "rm_prod_stack_20261021-worker-analytics-1";
const groupsOf = (lines: string[], source = WORKER) => classify(inventory(source, lines.map((text) => ({ ts: null, text }))), committed);

const PRICE_URL =
  "https://pro-api.coingecko.com/api/v3/onchain/simple/networks/base/token_price/0x4200000000000000000000000000000000000006,0x6c2ab7e2d5e2b1d3e5c1f0a9b8c7d6e5f4a3b2c1";

// One failed tick as worker-analytics prints it: the wallet sampler's batched
// request failed, then token-market held off and kept its last good reading.
const TICK = [
  `token-market: ROBOTMONEY price read failed, keeping the last good reading: 82 |     const failedAt = lastGeckoPriceFailureAtMs();`,
  `83 |     if (failedAt > 0 && Date.now() - failedAt < PRICE_FAILURE_HOLDOFF_MS) {`,
  `84 |       throw new Error(\`token-market: a token_price request failed \${Date.now() - failedAt} ms ago; not asking again this tick\`);`,
  `error: token-market: a token_price request failed 412 ms ago; not asking again this tick`,
  `      at priceUsd (/app/src/worker/handlers/token-market.ts:84:13)`,
  `token-market: WETH price read failed, keeping the last good reading: DOMException {`,
  `  message: "The operation timed out.",`,
  `error: 500 Internal Server Error for ${PRICE_URL}`,
  `error: 408 Request Timeout for ${PRICE_URL}`,
];

describe("CoinGecko onchain 5xx and timeouts in token-market are classified", () => {
  test("every error line of a failed tick has a rule", () => {
    const groups = groupsOf(TICK);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) expect(g.rule, g.key).not.toBeNull();
  });

  test("each line takes its narrow rule", () => {
    const ruleOf = (line: string) => groupsOf([line])[0]!.rule?.id;
    expect(ruleOf(`error: 500 Internal Server Error for ${PRICE_URL}`)).toBe("external-gecko-onchain-price-5xx-or-timeout");
    expect(ruleOf(`error: 408 Request Timeout for ${PRICE_URL}`)).toBe("external-gecko-onchain-price-5xx-or-timeout");
    expect(ruleOf(`error: 504 Gateway Timeout for ${PRICE_URL}`)).toBe("external-gecko-onchain-price-5xx-or-timeout");
    expect(ruleOf(`  message: "The operation timed out.",`)).toBe("fragment-timeout-domexception-message");
    expect(ruleOf(TICK[0]!)).toBe("external-token-market-price-read-kept-last-good");
    expect(ruleOf(TICK[3]!)).toBe("expected-token-market-price-holdoff");
  });

  test("it passes check 8 after the release, with no failure", () => {
    const v = inventoryVerdict(groupsOf(TICK), "post-release", "v0.6.3");
    expect(v.unclassifiedErrors).toBe(0);
    expect(v.failures).toEqual([]);
  });
});

describe("RED CONTROLS: the rules stay narrow", () => {
  const unclassified = (lines: string[], source = WORKER) => inventoryVerdict(groupsOf(lines, source), "post-release", "v0.6.3").unclassifiedErrors;

  test("a 4xx from the same endpoint is unclassified", () => {
    expect(unclassified([`error: 404 Not Found for ${PRICE_URL}`])).toBe(1);
    expect(unclassified([`error: 400 Bad Request for ${PRICE_URL}`])).toBe(1);
  });

  test("a 500 from another endpoint or host is unclassified", () => {
    expect(unclassified([`error: 500 Internal Server Error for https://pro-api.coingecko.com/api/v3/onchain/networks/base/pools/0xabcdef0123`])).toBe(1);
    expect(unclassified([`error: 500 Internal Server Error for https://api.example.com/api/v3/onchain/simple/networks/base/token_price/0xabcdef0123`])).toBe(1);
  });

  test("another cause behind the token-market headline still fails", () => {
    expect(
      unclassified([
        `token-market: WETH price read failed, keeping the last good reading: 108 |     if (!Number.isFinite(p) || p <= 0) throw new Error(...);`,
        `error: token-market: WETH price 0 is not a positive number`,
      ]),
    ).toBe(1);
  });

  test("the same lines from a non-worker container are unclassified", () => {
    for (const source of ["rm_prod_stack_20261021-api-1", "rm_prod_stack_20261021-system-scheduler-1"]) {
      expect(unclassified([`error: 500 Internal Server Error for ${PRICE_URL}`], source)).toBe(1);
      expect(unclassified([TICK[0]!], source)).toBe(1);
      expect(unclassified([TICK[3]!], source)).toBe(1);
    }
  });
});
