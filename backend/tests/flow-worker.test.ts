import { expect, test } from "bun:test";
import { refreshFlowIndex } from "../src/worker/handlers/flow-index.ts";

test("worker rejects absent contract configuration instead of silently skipping", async () => {
  const queue = process.env.FLOW_QUEUE_ADDRESS;
  const fund = process.env.FLOW_FUND_ADDRESS;
  try {
    delete process.env.FLOW_QUEUE_ADDRESS;
    delete process.env.FLOW_FUND_ADDRESS;
    await expect(refreshFlowIndex()).rejects.toThrow("FLOW_QUEUE_ADDRESS, FLOW_FUND_ADDRESS");
  } finally {
    if (queue === undefined) delete process.env.FLOW_QUEUE_ADDRESS; else process.env.FLOW_QUEUE_ADDRESS = queue;
    if (fund === undefined) delete process.env.FLOW_FUND_ADDRESS; else process.env.FLOW_FUND_ADDRESS = fund;
  }
});
