import { expect, test } from "bun:test";
import { handleFlowTransactions } from "../src/api/routes/flow-transactions.ts";
const chain = { head: async () => 20, header: async () => ({ number: "0x8", timestamp: "0x1", hash: "0xabc" }) };

test("returns unsigned request calldata with terms read from the queue", async () => {
  const queue = `0x${"1".repeat(40)}`;
  const owner = `0x${"2".repeat(40)}`;
  const url = new URL(`http://localhost/api/public/flow/transactions?action=deposit&owner=${owner}&amount=12`);
  let quote = "";
  const result = await handleFlowTransactions(new Request(url), url, "test-flow-quote", { ...chain, address: queue, call: async (_to, data) => {
    if (data.startsWith("0xdb431f06")) { quote = data; return "0x" + [1, 2, 3, 4, 5, 6].map((x) => x.toString(16).padStart(64, "0")).join(""); }
    if (data === "0x38d52e0f") return "0x" + "0".repeat(24) + "3".repeat(40);
    if (data.startsWith("0xdd62ed3e")) return "0x" + "0".repeat(64);
    throw new Error("unexpected call");
  } });
  expect(result.status).toBe(200);
  expect(quote.startsWith("0xdb431f06")).toBe(true);
  const body = await result.json();
  expect(body.transactions).toHaveLength(2);
  expect(body.transactions[0].data.startsWith("0x095ea7b3")).toBe(true);
  expect(body.transactions[1].to).toBe(queue);
  expect(body.transactions[1].data.startsWith("0x29344f08")).toBe(true);
  expect(body.terms.cancelCutoff).toBe("2");
  expect(body.asOf.block).toBe(8);
  expect(JSON.stringify(body)).not.toMatch(/privateKey|signature/);
});

test("redeem omits approval when the sender already allowed enough shares", async () => {
  const address = `0x${"4".repeat(40)}`;
  const url = new URL(`http://localhost/api/public/flow/transactions?action=redeem&owner=${address}&amount=12`);
  const response = await handleFlowTransactions(new Request(url), url, "test-flow-redeem", { ...chain, address, call: async (_to, data) => {
    if (data.startsWith("0x2711be44")) return "0x" + "0".repeat(384);
    if (data === "0xa8d5fd65") return "0x" + "0".repeat(24) + "5".repeat(40);
    if (data.startsWith("0xdd62ed3e")) return "0x" + "f".repeat(64);
    throw new Error("unexpected call");
  } });
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.transactions).toHaveLength(1);
  expect(body.transactions[0].data.startsWith("0x107703ab")).toBe(true);
});

test("fails closed for invalid input, unavailable queue, and failed quote", async () => {
  const url = new URL("http://localhost/api/public/flow/transactions?action=deposit&owner=0x1234&amount=1");
  const deps = { ...chain, address: "", call: async () => "0x" };
  expect((await handleFlowTransactions(new Request(url), url, "invalid-flow", deps)).status).toBe(400);
  url.searchParams.set("owner", `0x${"2".repeat(40)}`);
  expect((await handleFlowTransactions(new Request(url), url, "missing-flow", deps)).status).toBe(503);
  expect((await handleFlowTransactions(new Request(url), url, "broken-flow", { ...deps, address: `0x${"1".repeat(40)}` })).status).toBe(503);
});
