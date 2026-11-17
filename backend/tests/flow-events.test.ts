import { expect, test } from "bun:test";
import { decodeFlowEvent } from "../src/chain/flow-events.ts";

const word = (value: string) => value.padStart(64, "0");
test("decodes a queue request without losing uint256 precision", () => {
  const huge = (1n << 200n) + 1n;
  const owner = "11".repeat(20);
  expect(decodeFlowEvent({ topics: ["0xb8cbb91f85c0ecbb8b541805846bc3a6e090a8147b47523c51583a4815daebf9", `0x${word("1")}`, `0x${word(owner)}`, `0x${word(owner)}`], data: `0x${word(huge.toString(16))}${word("a")}` })).toEqual({ name: "DepositRequested", args: { requestId: "1", owner: `0x${owner}`, sender: `0x${owner}`, usdc: huge.toString(), epoch: "10" } });
});
test("rejects malformed known events and ignores unknown topics", () => {
  expect(() => decodeFlowEvent({ topics: ["0xae1f583816a37727fa407fb842920ab50ad6f9b9e7c9b025ac764a96343fe317"], data: "0x" })).toThrow();
  expect(decodeFlowEvent({ topics: ["0xabc"], data: "0x" })).toBeNull();
});
