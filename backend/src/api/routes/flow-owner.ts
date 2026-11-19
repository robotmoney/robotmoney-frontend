import { flowConfigured, flowDisabled } from "./flow-config.ts";
import { sql } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { flowCheckpoints, flowDeployment } from "../../pipeline/stores/flow-index.ts";
import { decodeFlowEvent } from "../../chain/flow-events.ts";
import { encodeAddressArg } from "../../chain/base-rpc-client.ts";
import { createRateLimiter } from "../rate-limit.ts";

const requests = registerQuery({ role: "rm_app", object: "flow_index_logs", privileges: ["SELECT"], site: "src/api/routes/flow-owner:requests", purpose: "List canonical queue request creation events for an owner.", callers: ["src/api/index"], probe: { statement: "SELECT block_number, log_index, transaction_hash, topics, data FROM flow_index_logs WHERE chain_id = $1 AND canonical AND lower(address) = $2 AND lower(topics->>2) = $3 AND lower(topics->>0) IN ($4, $5) AND (block_number, log_index) > ($6, $7) ORDER BY block_number, log_index LIMIT 100", params: [8453, "0xqueue", "0xowner", "0xdeposit", "0xredeem", 0, -1] } });
const limiter = createRateLimiter({ max: 60, windowMs: 60_000 });
const respond = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const DEPOSIT = "0xb8cbb91f85c0ecbb8b541805846bc3a6e090a8147b47523c51583a4815daebf9";
const REDEEM = "0x4e6558a3f3bfe9109a9a42f577ad5068d47c1e903f1f059cd8844db8d524d879";

export async function handleFlowOwner(req: Request, url: URL, owner: string, ip: string): Promise<Response> {
  if (limiter.check(ip).limited) return respond(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return respond(405, { error: "method not allowed" });
  if (!flowConfigured()) return flowDisabled();
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return respond(400, { error: "invalid owner" });
  const block = Number(url.searchParams.get("afterBlock") ?? 0), index = Number(url.searchParams.get("afterLogIndex") ?? -1);
  if (!Number.isSafeInteger(block) || block < 0 || !Number.isSafeInteger(index) || index < -1) return respond(400, { error: "invalid cursor" });
  try {
    const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const bound = await flowDeployment(tx, 8453), watermark = (await flowCheckpoints(tx, 8453))[0];
      if (!process.env.FLOW_QUEUE_ADDRESS || !process.env.FLOW_FUND_ADDRESS || bound?.queue_address !== process.env.FLOW_QUEUE_ADDRESS.toLowerCase() || bound.fund_address !== process.env.FLOW_FUND_ADDRESS.toLowerCase() || !watermark) return null;
      const topic = `0x${encodeAddressArg(owner)}`;
      const rows = await on(tx, requests)<{ block_number: string; log_index: number; transaction_hash: string; topics: string[]; data: string }>`SELECT block_number, log_index, transaction_hash, topics, data FROM flow_index_logs WHERE chain_id = ${8453} AND canonical AND lower(address) = ${bound.queue_address} AND lower(topics->>2) = ${topic} AND lower(topics->>0) IN (${DEPOSIT}, ${REDEEM}) AND (block_number, log_index) > (${block}, ${index}) ORDER BY block_number, log_index LIMIT 100`;
      return { schemaVersion: 1, indexedThrough: { block: watermark.number, hash: watermark.hash, time: new Date(watermark.timestamp * 1000).toISOString() }, requests: rows.map((row) => ({ block: Number(row.block_number), logIndex: row.log_index, transactionHash: row.transaction_hash, event: decodeFlowEvent(row) })) };
    });
    return result ? respond(200, result) : respond(503, { error: "flow index unavailable" });
  } catch { return respond(503, { error: "flow index unavailable" }); }
}
