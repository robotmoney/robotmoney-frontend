// Issue 1664: stage and CI read CoinGecko's keyless hosts, so a keyless-host 429 is a provider rate limit the price
// reads degrade around, and the release gate classifies it as external. The paid host refusing because the monthly
// credit is spent (HTTP 429, error_code 10006) must still be seen: it stays known-gecko-paid-tier-refused and fails
// after the release. Lines are the shapes the backend prints (chain/token-prices.ts, chain/gecko-endpoint.ts,
// projects/access/live-source.ts), classified with the committed rules.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const WORKER = "rm_stage_stack_20261118-worker-analytics-1";
const groupsOf = (lines: string[]) => classify(inventory(WORKER, lines.map((text) => ({ ts: null, text }))), committed);
const ruleOf = (line: string) => groupsOf([line])[0]?.rule?.id ?? null;
const classOf = (line: string) => groupsOf([line])[0]?.rule?.class ?? null;

const ADDRS = "0x4200000000000000000000000000000000000006,0x65021a79aeef22b17cdc1b768f5e79a8618beba3";
const FREE_PRICE = `error: 429 Too Many Requests for https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${ADDRS} (error_code 429: You've exceeded the Rate Limit)`;
const FREE_COINS = "error: 429 Too Many Requests for https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=virtual-protocol";
const COINS_MARKETS = "[projects.refresh_coins] coingecko markets api.coingecko.com 429 (error_code 429: You've exceeded the Rate Limit) — keeping last-persisted rows";
const PAID_QUOTA =
  "[gecko] pro-api.coingecko.com answered HTTP 429 (error_code 10006: You've exceeded the monthly credit limit) for price for 0xabc; using api.geckoterminal.com for 10 min";
const PAID_PRICE_429 = `error: 429 Too Many Requests for https://pro-api.coingecko.com/api/v3/onchain/simple/networks/base/token_price/${ADDRS}`;

describe("keyless CoinGecko host 429s are external", () => {
  test("a 429 for api.geckoterminal.com and for api.coingecko.com classify as external", () => {
    expect(ruleOf(FREE_PRICE)).toBe("external-gecko-keyless-host-429");
    expect(classOf(FREE_PRICE)).toBe("external");
    expect(ruleOf(FREE_COINS)).toBe("external-gecko-keyless-host-429");
    expect(classOf(FREE_COINS)).toBe("external");
    expect(classOf(COINS_MARKETS)).toBe("external");
  });

  test("they pass the gate after the release", () => {
    const v = inventoryVerdict(groupsOf([FREE_PRICE, FREE_COINS]), "post-release", "v0.9.2");
    expect(v.unclassifiedErrors).toBe(0);
    expect(v.failures).toEqual([]);
  });
});

describe("the paid host refusing stays a failure", () => {
  test("a [gecko] pro-api.coingecko.com quota 429 classifies as known-gecko-paid-tier-refused", () => {
    expect(ruleOf(PAID_QUOTA)).toBe("known-gecko-paid-tier-refused");
  });

  test("it fails the gate after the release", () => {
    const v = inventoryVerdict(groupsOf([PAID_QUOTA]), "post-release", "v0.9.2");
    expect(v.failures.length).toBeGreaterThan(0);
  });

  test("RED CONTROL: a 429 from the paid host is not taken by the keyless rule", () => {
    expect(ruleOf(PAID_PRICE_429)).not.toBe("external-gecko-keyless-host-429");
    expect(ruleOf("error: 429 Too Many Requests for https://pro-api.coingecko.com/api/v3/coins/markets?ids=x")).not.toBe("external-gecko-keyless-host-429");
    expect(ruleOf("coingecko markets pro-api.coingecko.com 429")).not.toBe("external-gecko-keyless-host-429");
  });

  test("RED CONTROL: another status from a keyless host is not taken by the keyless rule", () => {
    expect(ruleOf("error: 404 Not Found for https://api.geckoterminal.com/api/v2/networks/base/pools/0xabcdef0123")).not.toBe("external-gecko-keyless-host-429");
  });
});
