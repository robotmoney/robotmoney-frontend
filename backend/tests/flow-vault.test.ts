import { expect, test } from "bun:test";
import { readFlowVault } from "../src/chain/flow-vault.ts";

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const encoded = (...values: bigint[]) => `0x${values.map(word).join("")}`;
test("reads fund, holdings and queue state at the same verified block", async () => {
  let call = 0;
  const params = Array.from({ length: 21 }, () => 0n); params[1] = 10n; params[18] = 5n;
  const asset = [0n, 1n, 5000n, 1n, 2n, 3n, 3000n, 60n, 0n, 4n, 60n];
  const vault = await readFlowVault("0xqueue", "0xfund", 12, "0xhash", async (batch) => {
    expect(batch.every((entry) => entry.method === "eth_call" ? entry.params?.[1] === "0xc" : entry.params?.[0] === "0xc")).toBe(true);
    const values = call++ === 0 ? [encoded(100n, 90n), encoded(80n), encoded(200n, 50n, 25n, 0n), encoded(1n, 0n, 0n, 0n, 0n, 5n, 100n), encoded(3n), encoded(...params), encoded(32n, 1n, 5000n), encoded(32n, 1n, ...asset), encoded(7n, 64n, 1n, 33n), encoded(123n)] : [encoded(100n)];
    return [...values.map((result) => ({ ok: true as const, result })), { ok: true as const, result: { hash: "0xhash" } }];
  });
  expect(vault).toMatchObject({ navUsdc: "100", totalShares: "80", roomAtLastGoodNavUsdc: "100", cancelCutoff: "85", pricePerMillionSharesUsdc: "123", priceBinding: false, keeperConfigured: true, holdings: [{ held: "33", targetBps: "5000", active: true }] });
});

test("refuses a vault read when the indexed block changes", async () => {
  await expect(readFlowVault("0xqueue", "0xfund", 12, "0xcanonical", async () => [{ ok: true as const, result: { hash: "0xorphan" } }])).rejects.toThrow("indexed block changed");
});
