// The paid CoinGecko account ran out of its monthly call credit on 2026-11-16
// (HTTP 429, error_code 10006, overage off). Every paid-host call on production
// and stage-2 has answered 429 since, which failed the v0.9.1 stage run at
// Q13-log-baseline and Q28-log-verdict (run 20261117T144007Z). The release does
// not cause it, so both gates classify these lines as a known issue (1664, no
// fixedIn): a warning, never a failure, and still visible in every report.
//
// The lines are the ones that run's gate reports listed for worker-analytics.
// RED CONTROLS: a 429 from another host or endpoint, another status on the coin
// refresh, and the same lines from a non-worker container stay unclassified.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const WORKER = "rm_smoke_stack_75e6ee6b55-worker-analytics-1";
const groupsOf = (lines: string[], source = WORKER) => classify(inventory(source, lines.map((text) => ({ ts: null, text }))), committed);

const PRICE_URL =
  "https://pro-api.coingecko.com/api/v3/onchain/simple/networks/base/token_price/0x22af33fe49fd1fa80c7149773dde5890d3c76f3b,0x4200000000000000000000000000000000000006,0x65021a79aeef22b17cdc1b768f5e79a8618beba3";
const POOL_URL = "https://pro-api.coingecko.com/api/v3/onchain/networks/base/pools/0xcece56fd6eb8fcbc6c45af8181bfe71ea6057770630490cac36dbbc4aa27a4a6";

const QUOTA = [
  `error: 429 Too Many Requests for ${PRICE_URL}`,
  `error: 429 Too Many Requests for ${POOL_URL}`,
  `token-market: pool read failed, keeping the last good reading: 429 |     if (proRefused(target, res.status)) {`,
  `[projects.refresh_coins] extractor failed — keeping last-persisted rows (degraded): coingecko markets pro-api.coingecko.com 429`,
  `job 81234 (projects.refresh_coins) DEGRADED — kept last-persisted (attempts exhausted; settled FAILED, next cron re-enqueues): coingecko markets pro-api.coingecko.com 429`,
  `job 81234 (projects.refresh_coins) DEGRADED — kept last-persisted, retry in 60s: coingecko markets pro-api.coingecko.com 429`,
];

describe("the paid CoinGecko quota 429 is a known issue (1664)", () => {
  test("each line takes its rule", () => {
    const ruleOf = (line: string) => groupsOf([line])[0]!.rule?.id;
    expect(ruleOf(QUOTA[0]!)).toBe("known-gecko-paid-quota-429-onchain");
    expect(ruleOf(QUOTA[1]!)).toBe("known-gecko-paid-quota-429-onchain");
    expect(ruleOf(QUOTA[2]!)).toBe("external-token-market-pool-read-kept-last-good");
    expect(ruleOf(QUOTA[3]!)).toBe("known-gecko-paid-quota-429-coin-markets");
    expect(ruleOf(QUOTA[4]!)).toBe("known-gecko-paid-quota-429-coin-markets");
    expect(ruleOf(QUOTA[5]!)).toBe("known-gecko-paid-quota-429-coin-markets");
  });

  test("the baseline gate warns and does not fail", () => {
    const v = inventoryVerdict(groupsOf(QUOTA), "baseline", "v0.9.1");
    expect(v.unclassifiedErrors).toBe(0);
    expect(v.failures).toEqual([]);
    expect(v.warnings.some((w) => w.includes("known-gecko-paid-quota-429-onchain"))).toBe(true);
  });

  test("the post-release gate warns and does not fail, since no release fixes it yet", () => {
    const v = inventoryVerdict(groupsOf(QUOTA), "post-release", "v0.9.1");
    expect(v.unclassifiedErrors).toBe(0);
    expect(v.failures).toEqual([]);
    expect(v.warnings.some((w) => w.includes("1664"))).toBe(true);
  });
});

describe("RED CONTROLS: the rules stay narrow", () => {
  const unclassified = (lines: string[], source = WORKER) => inventoryVerdict(groupsOf(lines, source), "post-release", "v0.9.1").unclassifiedErrors;

  test("a 429 from another paid endpoint is unclassified", () => {
    expect(unclassified([`error: 429 Too Many Requests for https://pro-api.coingecko.com/api/v3/onchain/networks/new_pools?page=1`])).toBe(1);
    expect(unclassified([`error: 429 Too Many Requests for https://pro-api.coingecko.com/api/v3/coins/markets?vs_currency=usd`])).toBe(1);
  });

  test("another status on the same endpoints is unclassified", () => {
    expect(unclassified([`error: 401 Unauthorized for ${PRICE_URL}`])).toBe(1);
    expect(unclassified([`[projects.refresh_coins] extractor failed — keeping last-persisted rows (degraded): coingecko markets pro-api.coingecko.com 401`])).toBe(1);
  });

  test("the same lines from a non-worker container are unclassified", () => {
    expect(unclassified([QUOTA[0]!, QUOTA[3]!], "rm_smoke_stack_75e6ee6b55-api-1")).toBe(2);
  });
});
