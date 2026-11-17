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
test("decodes legacy gateway IDs without dropping leading zeroes", () => {
  const address = "11".repeat(20), id = word("1");
  const event = decodeFlowEvent({ topics: ["0xa9d4181f9a037cd8447c2d7336d15eaf9b4424df7793889e5d155ec7cdb01965", `0x${id}`, `0x${word("2")}`, `0x${word(address)}`], data: `0x${word(address)}${word("a")}${word("b")}${word("c")}` });
  expect(event).toMatchObject({ name: "AgentDeposit", args: { paymentId: `0x${id}`, agent: `0x${address}`, amount: "10", sharesMinted: "11" } });
});
