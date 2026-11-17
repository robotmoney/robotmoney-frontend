import { sql } from "../../db/client.ts";
import { flowCheckpoints, flowDeployment } from "../../pipeline/stores/flow-index.ts";
import { readFlowPosition } from "../../chain/flow-position.ts";
import { createRateLimiter } from "../rate-limit.ts";

const limiter = createRateLimiter({ max: 20, windowMs: 60_000 });
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function handleFlowPosition(req: Request, owner: string, ip: string): Promise<Response> {
  if (limiter.check(ip).limited) return reply(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return reply(405, { error: "method not allowed" });
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return reply(400, { error: "invalid owner" });
  const queue = process.env.FLOW_QUEUE_ADDRESS, fund = process.env.FLOW_FUND_ADDRESS;
  if (!queue || !fund) return reply(503, { error: "flow index unavailable" });
  try {
    const [bound, checkpoints] = await Promise.all([flowDeployment(sql, 8453), flowCheckpoints(sql, 8453)]);
    if (bound?.queue_address !== queue.toLowerCase() || bound.fund_address !== fund.toLowerCase() || !checkpoints.length) return reply(503, { error: "flow index unavailable" });
    const watermark = checkpoints[0]!;
    const position = await readFlowPosition(queue, fund, owner, watermark.number, watermark.hash);
    return reply(200, { schemaVersion: 1, indexedThrough: { block: watermark.number, hash: watermark.hash, time: new Date(watermark.timestamp * 1000).toISOString() }, position });
  } catch { return reply(503, { error: "flow position unavailable" }); }
}
