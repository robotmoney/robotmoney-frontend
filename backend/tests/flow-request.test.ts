import { expect, test } from "bun:test";
import { readFlowRequest } from "../src/chain/flow-request.ts";

const word = (n: bigint) => n.toString(16).padStart(64, "0");
test("reads request status and lazy claimability at the indexed block", async () => {
  const owner = `0x${"1".repeat(40)}`;
  const words = Array.from({ length: 20 }, () => word(0n));
  words[0] = owner.slice(2).padStart(64, "0"); words[1] = word(0n); words[2] = word(9n); words[3] = word(100n); words[9] = word(11n); words[11] = word(15n);
  const calls: string[] = [];
  let pass = 0;
  const result = await readFlowRequest(owner, 5n, 100, "0xhash", {
    batch: async (batch) => {
      calls.push(...batch.map((call) => String(call.params?.[call.method === "eth_call" ? 1 : 0])));
      const values = pass++ === 0 ? [`0x${words.join("")}`] : [1n, 30n, 70n].map((n) => `0x${word(n)}`);
      return [...values.map((result) => ({ ok: true as const, result })), { ok: true as const, result: { hash: "0xhash" } }];
    },
  });
  expect(result).toMatchObject({ requestId: "5", owner, kind: "deposit", status: "pending", amount: "100", pending: "30", claimable: "70", epoch: "9" });
  expect(calls.filter((x) => x === "0x64")).toHaveLength(6);
});

test("refuses a request result if the indexed block was reorganized", async () => {
  await expect(readFlowRequest(`0x${"1".repeat(40)}`, 5n, 100, "0xcanonical", {
    batch: async () => [{ ok: true as const, result: "0x" }, { ok: true as const, result: { hash: "0xorphan" } }],
  })).rejects.toThrow("indexed block changed");
});
