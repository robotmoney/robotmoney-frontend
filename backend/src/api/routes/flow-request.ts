import { sql } from "../../db/client.ts";
import { config } from "../../config.ts";
import { flowCheckpoints, flowDeployment } from "../../pipeline/stores/flow-index.ts";
import { ethGetBlockByNumber } from "../../chain/base-rpc-client.ts";
import { readFlowRequest } from "../../chain/flow-request.ts";
import { createRateLimiter } from "../rate-limit.ts";

const limiter = createRateLimiter({ max: 20, windowMs: 60_000 });
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function handleFlowRequest(req: Request, id: string, ip: string): Promise<Response> {
  if (limiter.check(ip).limited) return reply(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return reply(405, { error: "method not allowed" });
  if (!/^[1-9][0-9]{0,77}$/.test(id) || BigInt(id) >= (1n << 256n)) return reply(400, { error: "invalid request id" });
  const queue = process.env.FLOW_QUEUE_ADDRESS, fund = process.env.FLOW_FUND_ADDRESS;
  if (!queue || !fund) return reply(503, { error: "flow index unavailable" });
  try {
    const [bound, checkpoints] = await Promise.all([flowDeployment(sql, 8453), flowCheckpoints(sql, 8453)]);
    if (bound?.queue_address !== queue.toLowerCase() || bound.fund_address !== fund.toLowerCase() || !checkpoints.length) return reply(503, { error: "flow index unavailable" });
    const checkpoint = checkpoints[0]!;
    const current = await ethGetBlockByNumber(checkpoint.number, { rpcUrl: config.baseRpcUrl });
    if (typeof current.hash !== "string" || current.hash.toLowerCase() !== checkpoint.hash.toLowerCase()) return reply(503, { error: "flow index is reorganizing" });
    const request = await readFlowRequest(queue, BigInt(id), checkpoint.number);
    if ((await ethGetBlockByNumber(checkpoint.number, { rpcUrl: config.baseRpcUrl })).hash !== current.hash) return reply(503, { error: "flow index is reorganizing" });
    if (!request) return reply(404, { error: "request not found" });
    return reply(200, { schemaVersion: 1, indexedThrough: { block: checkpoint.number, hash: checkpoint.hash, time: new Date(checkpoint.timestamp * 1000).toISOString() }, request });
  } catch { return reply(503, { error: "flow request unavailable" }); }
}
