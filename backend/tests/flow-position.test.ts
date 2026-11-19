import { expect, test } from "bun:test";
import { readFlowPosition } from "../src/chain/flow-position.ts";
const word = (n: number) => n.toString(16).padStart(64, "0");
test("reads owner claims, credit and position at the indexed block", async () => {
  const owner = `0x${"1".repeat(40)}`;
  const result = await readFlowPosition("queue", "fund", owner, 100, "0xhash", async (calls) => {
    expect(calls).toHaveLength(8);
    expect(calls.every((call) => call.method === "eth_call" ? call.params?.[1] === "0x64" : call.params?.[0] === "0x64")).toBe(true);
    const values = [word(1), word(2), word(3), word(4) + word(5), word(6), word(7), word(8)];
    return [...values.map((value) => ({ ok: true as const, result: `0x${value}` })), { ok: true as const, result: { hash: "0xhash" } }];
  });
  expect(result).toMatchObject({ owner, claimableDepositUsdc: "1", claimableDepositShares: "2", claimableRedeemShares: "3", creditUsdc: "4", creditShares: "5", ledgerShares: "6", walletShares: "7", queuedShares: "8" });
});
test("refuses reorganized data", async () => {
  await expect(readFlowPosition("queue", "fund", `0x${"1".repeat(40)}`, 1, "0xcanonical", async () => [{ ok: true as const, result: { hash: "0xorphan" } }])).rejects.toThrow("indexed block changed");
});
