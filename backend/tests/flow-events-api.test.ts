import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { flowBindDeployment, flowRecord, flowRewind } from "../src/pipeline/stores/flow-index.ts";
import { handleFlowEvents } from "../src/api/routes/flow-events.ts";
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
    });
    const response = await handleFlowEvents(new Request(url), url, "flow-events-1");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.indexedThrough.hash).toBe("a");
    expect(body.events).toHaveLength(1);
    await sql.begin(async (tx) => { await flowRewind(tx, 8453, 0); await flowRecord(tx, 8453, [{ number: 1, hash: "b", timestamp: 2 }], []); });
    const next = await handleFlowEvents(new Request(url), url, "flow-events-2");
    expect((await next.json()).events).toHaveLength(0);
    process.env.FLOW_FUND_ADDRESS = `0x${"3".repeat(40)}`;
    expect((await handleFlowEvents(new Request(url), url, "flow-events-3")).status).toBe(503);
  } finally {
    if (oldQueue === undefined) delete process.env.FLOW_QUEUE_ADDRESS; else process.env.FLOW_QUEUE_ADDRESS = oldQueue;
    if (oldFund === undefined) delete process.env.FLOW_FUND_ADDRESS; else process.env.FLOW_FUND_ADDRESS = oldFund;
  }
});
