import { describe, expect, test } from "bun:test";
import { decodeFlowQuote, flowQueueCalldata } from "../src/chain/flow-queue-calldata.ts";

describe("FlowQueue v0.9 calldata", () => {
  const address = "0x1111111111111111111111111111111111111111";
  const word = (value: string) => value.padStart(64, "0");

  test("encodes actions using the release contract ABI", () => {
    expect(flowQueueCalldata.requestDeposit(5n, address)).toBe("0x29344f08" + word("5") + word(address.slice(2)));
    expect(flowQueueCalldata.requestRedeem(5n, address)).toBe("0x107703ab" + word("5") + word(address.slice(2)));
    expect(flowQueueCalldata.cancel(7n)).toBe("0x40e58ee5" + word("7"));
    expect(flowQueueCalldata.giveRedemptionNotice(7n)).toBe("0x9a4c9b1a" + word("7"));
    expect(flowQueueCalldata.claimNoticeReturn(7n)).toBe("0x29e9559b" + word("7"));
    expect(flowQueueCalldata.withdrawCredit()).toBe("0xc36f3874");
    expect(flowQueueCalldata.deposit(5n, address)).toBe("0x6e553f65" + word("5") + word(address.slice(2)));
    expect(flowQueueCalldata.redeem(5n, address, address)).toBe("0xba087652" + word("5") + word(address.slice(2)) + word(address.slice(2)));
    expect(flowQueueCalldata.quoteDeposit(5n)).toBe("0xdb431f06" + word("5"));
    expect(flowQueueCalldata.quoteRedeem(5n)).toBe("0x2711be44" + word("5"));
  });

  test("rejects invalid unsigned integers and addresses", () => {
    expect(() => flowQueueCalldata.cancel(-1n)).toThrow();
    expect(() => flowQueueCalldata.cancel(1n << 256n)).toThrow();
    expect(() => flowQueueCalldata.requestDeposit(1n, "0x1234")).toThrow();
  });

  test("decodes protocol quote terms and rejects malformed fields", () => {
    expect(decodeFlowQuote("0x" + [1, 2, 3, 4, 5, 6].map((v) => word(v.toString(16))).join(""))).toEqual({ feeBps: "1", cancelCutoff: "2", earliestSettle: "3", holdEnds: "4", refBandBps: "5", legBandBps: "6" });
    expect(() => decodeFlowQuote("0x")).toThrow();
    expect(() => decodeFlowQuote("0x" + word("1") + word("10000000000000000") + word("0").repeat(4))).toThrow();
  });
});
