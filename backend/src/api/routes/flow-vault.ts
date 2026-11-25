import { flowConfigured, flowDisabled } from "./flow-config.ts";
import { sql } from "../../db/client.ts";
import { flowCheckpoints, flowDeployment } from "../../pipeline/stores/flow-index.ts";
import { readFlowVault } from "../../chain/flow-vault.ts";
import { createRateLimiter } from "../rate-limit.ts";

const limiter = createRateLimiter({ max: 20, windowMs: 60_000 });
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function handleFlowVault(req: Request, ip: string): Promise<Response> {
  if (limiter.check(ip).limited) return reply(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return reply(405, { error: "method not allowed" });
  if (!flowConfigured()) return flowDisabled();
  const queue = process.env.FLOW_QUEUE_ADDRESS, fund = process.env.FLOW_FUND_ADDRESS;
  if (!queue || !fund) return reply(503, { error: "flow index unavailable" });
  try {
    const [bound, checkpoints] = await Promise.all([flowDeployment(sql, 8453), flowCheckpoints(sql, 8453)]);
    if (bound?.queue_address !== queue.toLowerCase() || bound.fund_address !== fund.toLowerCase() || !checkpoints.length) return reply(503, { error: "flow index unavailable" });
    const checkpoint = checkpoints[0]!;
    const vault = await readFlowVault(queue, fund, checkpoint.number, checkpoint.hash);
    return reply(200, { schemaVersion: 1, indexedThrough: { block: checkpoint.number, hash: checkpoint.hash, time: new Date(checkpoint.timestamp * 1000).toISOString() }, vault });
  } catch { return reply(503, { error: "flow vault unavailable" }); }
}
