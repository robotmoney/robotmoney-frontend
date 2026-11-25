import { flowConfigured, flowDisabled } from "./flow-config.ts";
import { sql } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { decodeFlowEvent } from "../../chain/flow-events.ts";
import { createRateLimiter } from "../rate-limit.ts";

const latest = registerQuery({ role: "rm_app", object: "flow_index_blocks", privileges: ["SELECT"], site: "src/api/routes/flow-events:latest", purpose: "Return the canonical flow indexing watermark.", callers: ["src/api/index"], probe: { statement: "SELECT block_number, block_hash, block_time FROM flow_index_blocks WHERE chain_id = $1 AND canonical ORDER BY block_number DESC LIMIT 1", params: [8453] } });
const deployment = registerQuery({ role: "rm_app", object: "flow_index_deployment", privileges: ["SELECT"], site: "src/api/routes/flow-events:deployment", purpose: "Verify the index belongs to the configured queue and fund.", callers: ["src/api/index"], probe: { statement: "SELECT queue_address, fund_address FROM flow_index_deployment WHERE chain_id = $1", params: [8453] } });
const logs = registerQuery({ role: "rm_app", object: "flow_index_logs", privileges: ["SELECT"], site: "src/api/routes/flow-events:logs", purpose: "Read a bounded page of canonical queue events.", callers: ["src/api/index"], probe: { statement: "SELECT block_number, block_hash, log_index, transaction_hash, address, topics, data FROM flow_index_logs WHERE chain_id = $1 AND canonical AND (block_number, log_index) > ($2, $3) ORDER BY block_number, log_index LIMIT $4", params: [8453, 0, -1, 10] } });
const limiter = createRateLimiter({ max: 60, windowMs: 60_000 });

export async function handleFlowEvents(req: Request, url: URL, ip: string): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (limiter.check(ip).limited) return Response.json({ error: "rate limit exceeded" }, { status: 429, headers });
  if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers });
  if (!flowConfigured()) return flowDisabled();
  const block = Number(url.searchParams.get("afterBlock") ?? 0);
  const index = Number(url.searchParams.get("afterLogIndex") ?? -1);
  if (!Number.isSafeInteger(block) || block < 0 || !Number.isSafeInteger(index) || index < -1) return Response.json({ error: "invalid cursor" }, { status: 400, headers });
  try {
    const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const bound = await on(tx, deployment)<{ queue_address: string; fund_address: string }>`SELECT queue_address, fund_address FROM flow_index_deployment WHERE chain_id = ${8453}`;
      if (!process.env.FLOW_QUEUE_ADDRESS || !process.env.FLOW_FUND_ADDRESS || bound[0]?.queue_address !== process.env.FLOW_QUEUE_ADDRESS.toLowerCase() || bound[0]?.fund_address !== process.env.FLOW_FUND_ADDRESS.toLowerCase()) return null;
      const watermarks = await on(tx, latest)<{ block_number: string; block_hash: string; block_time: Date }>`SELECT block_number, block_hash, block_time FROM flow_index_blocks WHERE chain_id = ${8453} AND canonical ORDER BY block_number DESC LIMIT 1`;
      if (!watermarks.length) return null;
      const rows = await on(tx, logs)<{ block_number: string; block_hash: string; log_index: number; transaction_hash: string; address: string; topics: string[]; data: string }>`SELECT block_number, block_hash, log_index, transaction_hash, address, topics, data FROM flow_index_logs WHERE chain_id = ${8453} AND canonical AND (block_number, log_index) > (${block}, ${index}) ORDER BY block_number, log_index LIMIT ${100}`;
      return { schemaVersion: 1, indexedThrough: { block: Number(watermarks[0]!.block_number), hash: watermarks[0]!.block_hash, time: watermarks[0]!.block_time }, events: rows.map((row) => ({ block: Number(row.block_number), blockHash: row.block_hash, logIndex: row.log_index, transactionHash: row.transaction_hash, address: row.address, topics: row.topics, data: row.data, event: decodeFlowEvent(row) })) };
    });
    return result ? Response.json(result, { headers }) : Response.json({ error: "flow index unavailable" }, { status: 503, headers });
  } catch {
    return Response.json({ error: "flow index unavailable" }, { status: 503, headers });
  }
}
