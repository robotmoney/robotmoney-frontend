import { config } from "../../config.ts";
import { rpcBatchRequest } from "../../chain/base-rpc-client.ts";
import { decodeFlowQuote, flowQueueCalldata } from "../../chain/flow-queue-calldata.ts";
import { sql } from "../../db/client.ts";
import { flowCheckpoints, flowDeployment } from "../../pipeline/stores/flow-index.ts";
import { readFlowRequest } from "../../chain/flow-request.ts";
import { createRateLimiter } from "../rate-limit.ts";

const limiter = createRateLimiter({ max: 20, windowMs: 60_000 });
const respond = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Build request transactions only after a live protocol quote has been read. */
export async function handleFlowTransactions(req: Request, url: URL, clientIp: string, dependencies = {
  address: process.env.FLOW_QUEUE_ADDRESS ?? "",
  watermark: async () => {
    const [bound, checkpoints] = await Promise.all([flowDeployment(sql, 8453), flowCheckpoints(sql, 8453)]);
    if (!process.env.FLOW_QUEUE_ADDRESS || !process.env.FLOW_FUND_ADDRESS || bound?.queue_address !== process.env.FLOW_QUEUE_ADDRESS.toLowerCase() || bound.fund_address !== process.env.FLOW_FUND_ADDRESS.toLowerCase()) throw new Error("index deployment mismatch");
    if (!checkpoints[0]) throw new Error("no indexed block");
    return checkpoints[0];
  },
  batch: rpcBatchRequest<unknown>,
  request: readFlowRequest,
}): Promise<Response> {
  if (limiter.check(clientIp).limited) return respond(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return respond(405, { error: "method not allowed" });
  const action = url.searchParams.get("action");
  const owner = url.searchParams.get("owner") ?? "";
  const sender = url.searchParams.get("sender") ?? owner;
  const amount = url.searchParams.get("amount") ?? "";
  const requestId = url.searchParams.get("requestId") ?? "";
  const newRequest = action === "deposit" || action === "redeem";
  const claim = action === "claim-deposit" || action === "claim-redeem";
  const byId = action === "cancel" || action === "withdraw-expired" || action === "notice" || action === "claim-notice" || claim;
  if ((!newRequest && !byId) || !/^0x[0-9a-fA-F]{40}$/.test(owner) || !/^0x[0-9a-fA-F]{40}$/.test(sender) || ((newRequest || claim) && !/^[1-9][0-9]{0,77}$/.test(amount)) || (byId && !/^[1-9][0-9]{0,77}$/.test(requestId))) return respond(400, { error: "invalid action, owner, sender, amount or request id" });
  if ((byId && BigInt(requestId) >= (1n << 256n)) || ((newRequest || claim) && BigInt(amount) >= (1n << 256n))) return respond(400, { error: "amount or request id out of range" });
  if (!/^0x[0-9a-fA-F]{40}$/.test(dependencies.address)) return respond(503, { error: "queue is not configured" });
  try {
    const watermark = await dependencies.watermark();
    if (byId) {
      if (sender.toLowerCase() !== owner.toLowerCase() && action !== "claim-deposit") return respond(400, { error: "sender must be the request owner" });
      const request = await dependencies.request(dependencies.address, BigInt(requestId), watermark.number, watermark.hash);
      if (!request || request.owner.toLowerCase() !== owner.toLowerCase()) return respond(404, { error: "request not found" });
      if ((action === "claim-deposit" && request.kind !== "deposit") || ((action === "claim-redeem" || action === "notice" || action === "claim-notice") && request.kind !== "redeem") || (action === "withdraw-expired" && request.kind !== "deposit")) return respond(400, { error: "action does not match request kind" });
      const requestNum = BigInt(requestId);
      const claimAmount = claim ? BigInt(amount) : 0n;
      if (claim && claimAmount > BigInt(request.claimable)) return respond(400, { error: "amount exceeds claimable balance at indexed block" });
      const data = action === "cancel" ? flowQueueCalldata.cancel(requestNum)
        : action === "withdraw-expired" ? flowQueueCalldata.withdrawExpired(requestNum)
        : action === "notice" ? flowQueueCalldata.giveRedemptionNotice(requestNum)
        : action === "claim-notice" ? flowQueueCalldata.claimNoticeReturn(requestNum)
        : action === "claim-deposit" ? flowQueueCalldata.deposit(claimAmount, owner)
        : flowQueueCalldata.redeem(claimAmount, owner, owner);
      return respond(200, { chainId: 8453, sender, transactions: [{ to: dependencies.address, data, value: "0" }], claimScope: claim ? "owner-oldest-eligible-first" : null, terms: { epoch: request.epoch, cancelCutoff: request.cancelCutoff, originalEpochSettleableAt: request.originalEpochSettleableAt, exitFeeBps: request.exitFeeBps, minHold: request.minHold, expiresAt: request.expiresAt }, asOf: { block: watermark.number, hash: watermark.hash, time: new Date(watermark.timestamp * 1000).toISOString() } });
    }
    const n = BigInt(amount);
    const blockTag = `0x${watermark.number.toString(16)}`;
    const read = async (calls: { to: string; data: string }[]) => {
      const results = await dependencies.batch([...calls.map((call) => ({ method: "eth_call", params: [call, blockTag] })), { method: "eth_getBlockByNumber", params: [blockTag, false] }], { rpcUrl: config.baseRpcUrl });
      const header = results.pop();
      if (!header?.ok || typeof header.result !== "object" || header.result === null || !("hash" in header.result) || typeof header.result.hash !== "string" || header.result.hash.toLowerCase() !== watermark.hash.toLowerCase()) throw new Error("indexed block changed");
      return results.map((result) => { if (!result.ok || typeof result.result !== "string") throw new Error("invalid RPC result"); return result.result; });
    };
    const quoteCall = action === "deposit" ? flowQueueCalldata.quoteDeposit(n) : flowQueueCalldata.quoteRedeem(n);
    const data = action === "deposit" ? flowQueueCalldata.requestDeposit(n, owner) : flowQueueCalldata.requestRedeem(n, owner);
    const [quoteWord, assetWord] = await read([{ to: dependencies.address, data: quoteCall }, { to: dependencies.address, data: action === "deposit" ? "0x38d52e0f" : "0xa8d5fd65" }]);
    if (!quoteWord || !assetWord) throw new Error("missing queue result");
    const terms = decodeFlowQuote(quoteWord);
    // asset() on the queue is USDC; redeem requests escrow the fund's shares.
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(assetWord)) throw new Error("invalid token address");
    const token = `0x${assetWord.slice(-40)}`;
    if (/^0x0{40}$/.test(token)) throw new Error("invalid token address");
    const [allowanceWord] = await read([{ to: token, data: flowQueueCalldata.allowance(sender, dependencies.address) }]);
    if (!allowanceWord || !/^0x[0-9a-fA-F]{64}$/.test(allowanceWord)) throw new Error("invalid allowance");
    const transactions = [];
    if (BigInt(allowanceWord) < n) transactions.push({ to: token, data: flowQueueCalldata.approve(dependencies.address, n), value: "0" });
    transactions.push({ to: dependencies.address, data, value: "0" });
    return respond(200, { chainId: 8453, sender, transactions, terms, asOf: { block: watermark.number, hash: watermark.hash, time: new Date(watermark.timestamp * 1000).toISOString() } });
  } catch (error) {
    if (error instanceof Error && error.message === "uint256 out of range") return respond(400, { error: "amount out of range" });
    return respond(503, { error: "queue quote unavailable" });
  }
}
