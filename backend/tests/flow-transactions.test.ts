import { expect, test } from "bun:test";
import { handleFlowTransactions } from "../src/api/routes/flow-transactions.ts";

test("returns unsigned request calldata with terms read from the queue", async () => {
  const queue = `0x${"1".repeat(40)}`;
  const owner = `0x${"2".repeat(40)}`;
  const url = new URL(`http://localhost/api/public/flow/transactions?action=deposit&owner=${owner}&amount=12`);
  let quote = "";
  const result = await handleFlowTransactions(new Request(url), url, "test-flow-quote", { address: queue, call: async (_to, data) => { quote = data; return "0x" + [1, 2, 3, 4, 5, 6].map((x) => x.toString(16).padStart(64, "0")).join(""); } });
  expect(result.status).toBe(200);
  expect(quote.startsWith("0xdb431f06")).toBe(true);
  const body = await result.json();
  expect(body.transaction.to).toBe(queue);
  expect(body.transaction.data.startsWith("0x29344f08")).toBe(true);
  expect(body.terms.cancelCutoff).toBe("2");
  expect(JSON.stringify(body)).not.toMatch(/privateKey|signature/);
});

test("fails closed for invalid input, unavailable queue, and failed quote", async () => {
  const url = new URL("http://localhost/api/public/flow/transactions?action=deposit&owner=0x1234&amount=1");
  const deps = { address: "", call: async () => "0x" };
  expect((await handleFlowTransactions(new Request(url), url, "invalid-flow", deps)).status).toBe(400);
  url.searchParams.set("owner", `0x${"2".repeat(40)}`);
  expect((await handleFlowTransactions(new Request(url), url, "missing-flow", deps)).status).toBe(503);
  expect((await handleFlowTransactions(new Request(url), url, "broken-flow", { ...deps, address: `0x${"1".repeat(40)}` })).status).toBe(503);
});
