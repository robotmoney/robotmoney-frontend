// Every action of /api/public/flow/transactions returns canonical unsigned
// calldata for the FlowQueue v0.9 ABI, the terms it was quoted under and the
// indexed block those terms were read at. The response never carries signing
// material: each transaction is exactly { to, data, value }, with no nonce,
// gas, chain signature or key, so the wallet alone signs and submits.
import { describe, expect, test } from "bun:test";
import { handleFlowTransactions } from "../src/api/routes/flow-transactions.ts";

const QUEUE = `0x${"1".repeat(40)}`;
const OWNER = `0x${"2".repeat(40)}`;
const USDC = `0x${"3".repeat(40)}`;
const SHARES = `0x${"5".repeat(40)}`;
const word = (value: bigint | string) => (typeof value === "string" ? value.replace(/^0x/, "").toLowerCase() : value.toString(16)).padStart(64, "0");
const watermark = { number: 8, timestamp: 1_700_000_000, hash: `0x${"ab".repeat(32)}` };
const asOf = { block: 8, hash: watermark.hash, time: "2023-11-14T22:13:20.000Z" };
const SIGNING_KEYS = /"(signature|signedTransaction|rawTransaction|privateKey|mnemonic|nonce|gas|gasPrice|maxFeePerGas|v|r|s|yParity)"/;

const request = (kind: "deposit" | "redeem") => async () => ({
  requestId: "7", owner: OWNER, kind, amountUnit: kind === "deposit" ? "usdc-base-units" : "share-base-units", status: "pending",
  amount: "100", pending: "40", claimable: "60", epoch: "3", cancelCutoff: "1000", originalEpochSettleableAt: "1100",
  exitFeeBps: "25", minHold: "3600", createdAt: "900", expiresAt: "5000",
});
const requestTerms = { epoch: "3", cancelCutoff: "1000", originalEpochSettleableAt: "1100", exitFeeBps: "25", minHold: "3600", expiresAt: "5000" };
const quoteWords = [30n, 1000n, 1100n, 4700n, 50n, 75n];
const quoteTerms = { feeBps: "30", cancelCutoff: "1000", earliestSettle: "1100", holdEnds: "4700", refBandBps: "50", legBandBps: "75" };

function chain(kind: "deposit" | "redeem", allowance: bigint) {
  return {
    address: QUEUE,
    watermark: async () => watermark,
    request: request(kind),
    batch: async (calls: readonly { method: string; params?: readonly unknown[] }[]) => calls.map((call) => {
      if (call.method === "eth_getBlockByNumber") {
        expect(call.params?.[0]).toBe("0x8");
        return { ok: true as const, result: { hash: watermark.hash } };
      }
      expect(call.params?.[1]).toBe("0x8");
      const { to, data } = call.params![0] as { to: string; data: string };
      if (data.startsWith("0xdb431f06") || data.startsWith("0x2711be44")) return { ok: true as const, result: `0x${quoteWords.map(word).join("")}` };
      if (data === "0x38d52e0f" || data === "0xa8d5fd65") return { ok: true as const, result: `0x${word(data === "0x38d52e0f" ? USDC : SHARES)}` };
      if (data.startsWith("0xdd62ed3e")) {
        expect(to).toBe(kind === "deposit" ? USDC : SHARES);
        expect(data).toBe(`0xdd62ed3e${word(OWNER)}${word(QUEUE)}`);
        return { ok: true as const, result: `0x${word(allowance)}` };
      }
      throw new Error(`unexpected call ${data}`);
    }),
  };
}

async function call(query: string, deps: ReturnType<typeof chain>) {
  const url = new URL(`http://localhost/api/public/flow/transactions?${query}`);
  const response = await handleFlowTransactions(new Request(url), url, `unsigned-${query}`, deps);
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toMatch(SIGNING_KEYS);
  const body = JSON.parse(text);
  for (const tx of body.transactions) expect(Object.keys(tx).sort()).toEqual(["data", "to", "value"]);
  expect(body.chainId).toBe(8453);
  expect(body.sender).toBe(OWNER);
  expect(body.asOf).toEqual(asOf);
  return body;
}

describe("unsigned deposit queue transactions", () => {
  test("deposit: approve USDC when the allowance is short, then requestDeposit", async () => {
    const body = await call(`action=deposit&owner=${OWNER}&amount=12`, chain("deposit", 11n));
    expect(body.transactions).toEqual([
      { to: USDC, data: `0x095ea7b3${word(QUEUE)}${word(12n)}`, value: "0" },
      { to: QUEUE, data: `0x29344f08${word(12n)}${word(OWNER)}`, value: "0" },
    ]);
    expect(body.terms).toEqual(quoteTerms);
  });

  test("redeem: no approval when the share allowance suffices, then requestRedeem", async () => {
    const body = await call(`action=redeem&owner=${OWNER}&amount=12`, chain("redeem", 12n));
    expect(body.transactions).toEqual([{ to: QUEUE, data: `0x107703ab${word(12n)}${word(OWNER)}`, value: "0" }]);
    expect(body.terms).toEqual(quoteTerms);
  });

  const byId: [string, "deposit" | "redeem", string, string][] = [
    ["cancel", "deposit", "", `0x40e58ee5${word(7n)}`],
    ["withdraw-expired", "deposit", "", `0x0b4a1063${word(7n)}`],
    ["notice", "redeem", "", `0x9a4c9b1a${word(7n)}`],
    ["claim-notice", "redeem", "", `0x29e9559b${word(7n)}`],
    ["claim-deposit", "deposit", "&amount=60", `0x6e553f65${word(60n)}${word(OWNER)}`],
    ["claim-redeem", "redeem", "&amount=60", `0xba087652${word(60n)}${word(OWNER)}${word(OWNER)}`],
  ];
  for (const [action, kind, extra, data] of byId) {
    test(`${action}: one queue call with the request's snapshotted terms`, async () => {
      const body = await call(`action=${action}&owner=${OWNER}&requestId=7${extra}`, chain(kind, 0n));
      expect(body.transactions).toEqual([{ to: QUEUE, data, value: "0" }]);
      expect(body.terms).toEqual(requestTerms);
      expect(body.claimScope).toBe(action.startsWith("claim-") && action !== "claim-notice" ? "owner-oldest-eligible-first" : null);
    });
  }

  test("a claim above the indexed claimable amount, or an action of the wrong kind, is refused", async () => {
    const over = new URL(`http://localhost/api/public/flow/transactions?action=claim-deposit&owner=${OWNER}&requestId=7&amount=61`);
    expect((await handleFlowTransactions(new Request(over), over, "unsigned-over", chain("deposit", 0n))).status).toBe(400);
    const wrong = new URL(`http://localhost/api/public/flow/transactions?action=notice&owner=${OWNER}&requestId=7`);
    expect((await handleFlowTransactions(new Request(wrong), wrong, "unsigned-wrong", chain("deposit", 0n))).status).toBe(400);
  });
});
