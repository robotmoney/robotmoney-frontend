import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { flowBindDeployment, flowRecord, flowRewind } from "../src/pipeline/stores/flow-index.ts";
import { handleFlowEvents } from "../src/api/routes/flow-events.ts";
import { handleFlowOwner } from "../src/api/routes/flow-owner.ts";
import { handleFlowPrices } from "../src/api/routes/flow-prices.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);
test("serves only canonical events with the matching deployment and watermark", async () => {
  const queue = `0x${"1".repeat(40)}`;
  const fund = `0x${"2".repeat(40)}`;
  const oldQueue = process.env.FLOW_QUEUE_ADDRESS, oldFund = process.env.FLOW_FUND_ADDRESS;
  process.env.FLOW_QUEUE_ADDRESS = queue; process.env.FLOW_FUND_ADDRESS = fund;
  const url = new URL("http://localhost/api/public/flow/events");
  try {
    await sql.begin(async (tx) => {
      await flowBindDeployment(tx, 8453, queue, fund);
      await flowRecord(tx, 8453, [{ number: 1, hash: "a", timestamp: 1 }], [{ blockNumber: 1, blockHash: "a", logIndex: 0, transactionHash: "tx", address: queue, topics: ["0xunknown"], data: "0x" }]);
      const word = (s: string) => s.padStart(64, "0");
      await flowRecord(tx, 8453, [], [{ blockNumber: 1, blockHash: "a", logIndex: 1, transactionHash: "tx2", address: queue, topics: ["0xb8cbb91f85c0ecbb8b541805846bc3a6e090a8147b47523c51583a4815daebf9", `0x${word("1")}`, `0x${word(fund.slice(2))}`, `0x${word(fund.slice(2))}`], data: `0x${word("a")}${word("1")}` }]);
      await flowRecord(tx, 8453, [], [{ blockNumber: 1, blockHash: "a", logIndex: 2, transactionHash: "tx3", address: queue, topics: ["0x8ecc624c6f11fc84fecb7269245980bab9d25af8b2548d1d47212d16e53de860", `0x${word("2")}`, `0x${word(fund.slice(2))}`], data: `0x${word("64")}${word("0").repeat(6)}` }]);
    });
    const response = await handleFlowEvents(new Request(url), url, "flow-events-1");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.indexedThrough.hash).toBe("a");
    expect(body.events).toHaveLength(3);
    const ownerResponse = await handleFlowOwner(new Request(url), url, fund, "flow-owner-1");
    const ownerBody = await ownerResponse.json();
    expect(ownerBody.requests).toHaveLength(1);
    expect(ownerBody.requests[0].event.args.requestId).toBe("1");
    const pricesResponse = await handleFlowPrices(new Request(url), url, "flow-prices-1");
    const priceBody = await pricesResponse.json();
    expect(priceBody.prices).toHaveLength(1);
    expect(priceBody.prices[0]).toMatchObject({ settlementId: "2", sharePrice: "100", time: "1970-01-01T00:00:01.000Z" });
    await sql.begin(async (tx) => { await flowRewind(tx, 8453, 0); await flowRecord(tx, 8453, [{ number: 1, hash: "b", timestamp: 2 }], []); });
    const next = await handleFlowEvents(new Request(url), url, "flow-events-2");
    expect((await next.json()).events).toHaveLength(0);
    const emptyPrices = await handleFlowPrices(new Request(url), url, "flow-prices-2");
    expect((await emptyPrices.json()).prices).toHaveLength(0);
    process.env.FLOW_FUND_ADDRESS = `0x${"3".repeat(40)}`;
    expect((await handleFlowEvents(new Request(url), url, "flow-events-3")).status).toBe(503);
  } finally {
    if (oldQueue === undefined) delete process.env.FLOW_QUEUE_ADDRESS; else process.env.FLOW_QUEUE_ADDRESS = oldQueue;
    if (oldFund === undefined) delete process.env.FLOW_FUND_ADDRESS; else process.env.FLOW_FUND_ADDRESS = oldFund;
  }
});
