import { expect, test } from "bun:test";
import { readFlowRequest } from "../src/chain/flow-request.ts";

const word = (n: bigint) => n.toString(16).padStart(64, "0");
test("reads request status and lazy claimability at the indexed block", async () => {
  const owner = `0x${"1".repeat(40)}`;
  const words = Array.from({ length: 20 }, () => word(0n));
  words[0] = owner.slice(2).padStart(64, "0"); words[1] = word(0n); words[2] = word(9n); words[3] = word(100n); words[9] = word(11n); words[11] = word(15n);
  const calls: string[] = [];
  const result = await readFlowRequest(owner, 5n, 100, {
    call: async (_to, data, opts) => { calls.push(data, opts.blockTag!); return `0x${words.join("")}`; },
    batch: async (batch) => { calls.push(...batch.map((call) => String(call.params?.[1]))); return [1n, 30n, 70n].map((n) => ({ ok: true as const, result: `0x${word(n)}` })); },
  });
  expect(result).toMatchObject({ requestId: "5", owner, kind: "deposit", status: "pending", amount: "100", pending: "30", claimable: "70", epoch: "9" });
  expect(calls.filter((x) => x === "0x64")).toHaveLength(4);
});
