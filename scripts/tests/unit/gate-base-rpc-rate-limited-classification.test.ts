// The Base RPC client logs one warning per rate-limit retry ("Base RPC rate limited (<method>, HTTP 429):
// retry n of m in t ms", backend/src/chain/base-rpc-client.ts). The gate treats it as the external
// outcome it is: a warning, never a failure and never an unclassified line.
// RED CONTROL: a line that only looks similar stays unclassified.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, inventory, inventoryVerdict, validateRules } from "../../lib/gate/log-inventory.ts";

const committed = validateRules(JSON.parse(readFileSync(join(import.meta.dir, "../../lib/gate/log-classifications.json"), "utf8")));
const clientSrc = readFileSync(join(import.meta.dir, "../../../backend/src/chain/base-rpc-client.ts"), "utf8");
const groupsOf = (lines: string[]) => classify(inventory("worker-analytics", lines.map((text) => ({ ts: null, text }))), committed);

test("the line under test is the one the client emits", () => {
  expect(clientSrc).toContain("Base RPC rate limited (${method}, HTTP 429): retry ${attempt + 1} of ${maxRateLimitRetries()} in ${Math.round(waitMs)} ms");
});

test("a rate-limit retry line is external and never fails a gate", () => {
  const lines = [
    "Base RPC rate limited (eth_getLogs, HTTP 429): retry 1 of 5 in 5412 ms",
    "Base RPC rate limited (batch, 3 entries): retry 2 of 5 in 11030 ms",
    "Base RPC rate limited (eth_call, JSON-RPC -32016): retry 3 of 5 in 22001 ms",
  ];
  const groups = groupsOf(lines);
  for (const g of groups) expect(g.rule?.id).toBe("external-base-rpc");
  for (const mode of ["baseline", "post-release"] as const) expect(inventoryVerdict(groups, mode, "v0.6.2").failures).toEqual([]);
});

test("red: a line that is not the client's stays unclassified", () => {
  const groups = groupsOf(["Base RPC is fine, nothing rate limited here, but this error: boom"]);
  expect(groups.map((g) => g.rule)).toEqual([null]);
});
