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
  const amount = url.searchParams.get("amount") ?? "";
  if ((action !== "deposit" && action !== "redeem") || !/^0x[0-9a-fA-F]{40}$/.test(owner) || !/^[1-9][0-9]{0,77}$/.test(amount)) return respond(400, { error: "invalid action, owner or amount" });
  if (!/^0x[0-9a-fA-F]{40}$/.test(dependencies.address)) return respond(503, { error: "queue is not configured" });
  try {
    const n = BigInt(amount);
    const quoteCall = action === "deposit" ? flowQueueCalldata.quoteDeposit(n) : flowQueueCalldata.quoteRedeem(n);
    const data = action === "deposit" ? flowQueueCalldata.requestDeposit(n, owner) : flowQueueCalldata.requestRedeem(n, owner);
    const terms = decodeFlowQuote(await dependencies.call(dependencies.address, quoteCall));
    return respond(200, { chainId: 8453, transaction: { to: dependencies.address, data, value: "0" }, terms });
  } catch (error) {
    if (error instanceof Error && error.message === "uint256 out of range") return respond(400, { error: "amount out of range" });
    return respond(503, { error: "queue quote unavailable" });
  }
}
