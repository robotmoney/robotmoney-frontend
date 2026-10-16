// A wallet-balances Base RPC timeout burst is an external outcome the code
// degrades around, so both gates classify every line of it.
//
// The lines are the ones stage worker-analytics logged at 2026-10-08T09:03:12Z,
// which failed prod:gate check 8 as unclassified errors: the multicall request
// was aborted at its timeout, every chain leg went stale, and each leg degraded
// to its last persisted sample. RED CONTROLS: the abort fields outside
// worker-analytics, and a different error under the same words, stay
// unclassified and fail.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const SOURCE = "rm_smoke_stack_75e6ee6b55-worker-analytics-1";
const groupsOf = (lines: string[], source = SOURCE) => classify(inventory(source, lines.map((text) => ({ ts: null, text }))), committed);

const SYMBOLS = ["USDC", "ZYFAI-SS1", "GIZA-SS1", "WETH", "ETH", "ROBOTMONEY", "BNKR"];
const liveRead = (sym: string) => `wallet-balances: ${sym} live read failed, degrading to last-persisted sample: 756 |   source: BaseRpcSource,`;
const chainRead = (sym: string) => `error: ${sym} chain read unavailable`;

// The burst exactly as logged (the inventory trims each line).
const BURST: Array<[string, string]> = [
  ["wallet-balances: batched round-1 multicall failed, degrading all chain legs to stale: DOMException {", "external-wallet-balances-multicall-degraded"],
  ['  stack: "abort@[native code]",', "fragment-wallet-balances-abort-domexception"],
  ['  message: "The operation was aborted.",', "fragment-wallet-balances-abort-domexception"],
  ...SYMBOLS.flatMap((s) => [
    [liveRead(s), "external-wallet-balances-live-read-degraded"] as [string, string],
    [chainRead(s), "external-wallet-balances-chain-read-unavailable"] as [string, string],
  ]),
];

describe("the stage 2026-10-08T09:03:12Z wallet-balances timeout burst is classified", () => {
  for (const [line, id] of BURST) {
    test(line.trim().slice(0, 90), () => {
      const [g] = groupsOf([line]);
      expect(g!.rule?.id).toBe(id);
    });
  }

  test("the whole burst passes check 8 after the release", () => {
    const v = inventoryVerdict(groupsOf(BURST.map(([l]) => l)), "post-release", "v0.6.0");
    expect(v.unclassifiedErrors).toBe(0);
    expect(v.failures).toEqual([]);
  });

  test("the round-2 NAV headline is the same degradation", () => {
    const [g] = groupsOf(["wallet-balances: batched round-2 NAV multicall failed, degrading all chain legs to stale: DOMException {"]);
    expect(g!.rule?.id).toBe("external-wallet-balances-multicall-degraded");
  });
});

describe("RED CONTROLS: the rules stay narrow", () => {
  test("the abort fields in any other service are unclassified and fail", () => {
    const v = inventoryVerdict(
      groupsOf(['stack: "abort@[native code]",', 'message: "The operation was aborted.",'], "rm_smoke_stack_75e6ee6b55-api-1"),
      "post-release",
      "v0.6.0",
    );
    expect(v.unclassifiedErrors).toBe(2);
  });

  test("an abort field with more on the line is not excused", () => {
    const [g] = groupsOf(['message: "The operation was aborted.", cause: "disk full"']);
    expect(g!.rule).toBeNull();
  });

  test("a different chain-read error or a different multicall degrade is not excused", () => {
    for (const line of [
      "error: USDC chain read unavailable: permission denied",
      "wallet-balances: batched round-1 multicall failed at block 0x1, degrading that block's legs to stale: boom",
      "wallet-sleeves: batched round-1 multicall failed, degrading all chain legs to stale: DOMException {",
    ]) {
      expect(groupsOf([line])[0]!.rule).toBeNull();
    }
  });
});
