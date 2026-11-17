import { config } from "../../config.ts";
import { ethCall } from "../../chain/base-rpc-client.ts";
import { decodeFlowQuote, flowQueueCalldata } from "../../chain/flow-queue-calldata.ts";
import { createRateLimiter } from "../rate-limit.ts";

const limiter = createRateLimiter({ max: 20, windowMs: 60_000 });
const respond = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Build request transactions only after a live protocol quote has been read. */
export async function handleFlowTransactions(req: Request, url: URL, clientIp: string, dependencies = {
  address: process.env.FLOW_QUEUE_ADDRESS ?? "",
  call: (to: string, data: string) => ethCall(to, data, { rpcUrl: config.baseRpcUrl }),
}): Promise<Response> {
  if (limiter.check(clientIp).limited) return respond(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return respond(405, { error: "method not allowed" });
  const action = url.searchParams.get("action");
  const owner = url.searchParams.get("owner") ?? "";
  const sender = url.searchParams.get("sender") ?? owner;
  const amount = url.searchParams.get("amount") ?? "";
  if ((action !== "deposit" && action !== "redeem") || !/^0x[0-9a-fA-F]{40}$/.test(owner) || !/^0x[0-9a-fA-F]{40}$/.test(sender) || !/^[1-9][0-9]{0,77}$/.test(amount)) return respond(400, { error: "invalid action, owner, sender or amount" });
  if (!/^0x[0-9a-fA-F]{40}$/.test(dependencies.address)) return respond(503, { error: "queue is not configured" });
  try {
    const n = BigInt(amount);
    const quoteCall = action === "deposit" ? flowQueueCalldata.quoteDeposit(n) : flowQueueCalldata.quoteRedeem(n);
    const data = action === "deposit" ? flowQueueCalldata.requestDeposit(n, owner) : flowQueueCalldata.requestRedeem(n, owner);
    const terms = decodeFlowQuote(await dependencies.call(dependencies.address, quoteCall));
    // asset() on the queue is USDC; redeem requests escrow the fund's shares.
    const assetWord = await dependencies.call(dependencies.address, action === "deposit" ? "0x38d52e0f" : "0xa8d5fd65");
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(assetWord)) throw new Error("invalid token address");
    const token = `0x${assetWord.slice(-40)}`;
    if (/^0x0{40}$/.test(token)) throw new Error("invalid token address");
    const allowanceWord = await dependencies.call(token, flowQueueCalldata.allowance(sender, dependencies.address));
    if (!/^0x[0-9a-fA-F]{64}$/.test(allowanceWord)) throw new Error("invalid allowance");
    const transactions = [];
    if (BigInt(allowanceWord) < n) transactions.push({ to: token, data: flowQueueCalldata.approve(dependencies.address, n), value: "0" });
    transactions.push({ to: dependencies.address, data, value: "0" });
    return respond(200, { chainId: 8453, sender, transactions, terms });
  } catch (error) {
    if (error instanceof Error && error.message === "uint256 out of range") return respond(400, { error: "amount out of range" });
    return respond(503, { error: "queue quote unavailable" });
  }
}
