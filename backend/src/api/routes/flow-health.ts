import { sql } from "../../db/client.ts";
import { flowCheckpoints, flowDeployment } from "../../pipeline/stores/flow-index.ts";
import { createRateLimiter } from "../rate-limit.ts";

/** A watermark older than this is stale: the indexer runs every minute and waits 12 blocks. */
export const FLOW_MAX_AGE_SECONDS = 300;
const limiter = createRateLimiter({ max: 60, windowMs: 60_000 });
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Index health and freshness. 200 "idle" (enabled false) while the feature is
 * unconfigured. 503 while a configured index is bound to other contracts or empty. Otherwise 200 with `status` "ok", or "stale" once
 * the newest indexed block is older than FLOW_MAX_AGE_SECONDS, so a stopped
 * indexer shows up here without failing readiness probes.
 */
export async function handleFlowHealth(req: Request, ip: string, now = () => Date.now()): Promise<Response> {
  if (limiter.check(ip).limited) return reply(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return reply(405, { error: "method not allowed" });
  const queue = process.env.FLOW_QUEUE_ADDRESS, fund = process.env.FLOW_FUND_ADDRESS;
  if (!queue || !fund) return reply(200, { schemaVersion: 1, status: "idle", enabled: false, reason: "flow index is not configured" });
  try {
    const [bound, checkpoints] = await Promise.all([flowDeployment(sql, 8453), flowCheckpoints(sql, 8453)]);
    if (bound?.queue_address !== queue.toLowerCase() || bound.fund_address !== fund.toLowerCase()) return reply(503, { schemaVersion: 1, status: "unavailable", error: "flow index is bound to other contracts" });
    const watermark = checkpoints[0];
    if (!watermark) return reply(503, { schemaVersion: 1, status: "unavailable", error: "flow index has no indexed block" });
    const ageSeconds = Math.max(0, Math.floor(now() / 1000) - watermark.timestamp);
    return reply(200, {
      schemaVersion: 1,
      status: ageSeconds > FLOW_MAX_AGE_SECONDS ? "stale" : "ok",
      indexedThrough: { block: watermark.number, hash: watermark.hash, time: new Date(watermark.timestamp * 1000).toISOString() },
      ageSeconds,
      maxAgeSeconds: FLOW_MAX_AGE_SECONDS,
    });
  } catch {
    return reply(503, { schemaVersion: 1, status: "unavailable", error: "flow index unavailable" });
  }
}
