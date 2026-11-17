import { sql } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { flowCheckpoints, flowDeployment } from "../../pipeline/stores/flow-index.ts";
import { decodeFlowEvent } from "../../chain/flow-events.ts";
import { encodeUint256Arg } from "../../chain/base-rpc-client.ts";
import { createRateLimiter } from "../rate-limit.ts";

const history = registerQuery({ role: "rm_app", object: "flow_index_logs", privileges: ["SELECT"], site: "src/api/routes/flow-request-history:events", purpose: "Read a request's canonical indexed events.", callers: ["src/api/index"], probe: { statement: "SELECT block_number, log_index, transaction_hash, topics, data FROM flow_index_logs WHERE chain_id = $1 AND canonical AND lower(address) = $2 AND lower(topics->>1) = $3 AND (block_number, log_index) > ($4, $5) ORDER BY block_number, log_index LIMIT 100", params: [8453, "0xqueue", "0xid", 0, -1] } });
const times = registerQuery({ role: "rm_app", object: "flow_index_blocks", privileges: ["SELECT"], site: "src/api/routes/flow-request-history:times", purpose: "Date canonical request events.", callers: ["src/api/index"], probe: { statement: "SELECT block_number, block_time FROM flow_index_blocks WHERE chain_id = $1 AND canonical AND block_number = ANY($2::bigint[])", params: [8453, "{1}"] } });
const limiter = createRateLimiter({ max: 60, windowMs: 60_000 });
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const requestEvents = new Set(["DepositRequested", "RedeemRequested", "RequestCancelled", "ExpiredWithdrawn", "RedemptionNoticeGiven", "RedemptionNoticeReturned", "DepositFilled", "RedeemFilled"]);
export async function handleFlowRequestHistory(req: Request, url: URL, id: string, ip: string): Promise<Response> {
  if (limiter.check(ip).limited) return reply(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return reply(405, { error: "method not allowed" });
  if (!/^[1-9][0-9]{0,77}$/.test(id) || BigInt(id) >= (1n << 256n)) return reply(400, { error: "invalid request id" });
  const block = Number(url.searchParams.get("afterBlock") ?? 0), index = Number(url.searchParams.get("afterLogIndex") ?? -1);
  if (!Number.isSafeInteger(block) || block < 0 || !Number.isSafeInteger(index) || index < -1) return reply(400, { error: "invalid cursor" });
  try {
    const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const bound = await flowDeployment(tx, 8453), watermark = (await flowCheckpoints(tx, 8453))[0];
      if (!process.env.FLOW_QUEUE_ADDRESS || !process.env.FLOW_FUND_ADDRESS || bound?.queue_address !== process.env.FLOW_QUEUE_ADDRESS.toLowerCase() || bound.fund_address !== process.env.FLOW_FUND_ADDRESS.toLowerCase() || !watermark) return null;
      const topic = `0x${encodeUint256Arg(BigInt(id))}`;
      const rows = await on(tx, history)<{ block_number: string; log_index: number; transaction_hash: string; topics: string[]; data: string }>`SELECT block_number, log_index, transaction_hash, topics, data FROM flow_index_logs WHERE chain_id = ${8453} AND canonical AND lower(address) = ${bound.queue_address} AND lower(topics->>1) = ${topic} AND (block_number, log_index) > (${block}, ${index}) ORDER BY block_number, log_index LIMIT 100`;
      const numbers = [...new Set(rows.map((row) => Number(row.block_number)))];
      const blocks = await on(tx, times)<{ block_number: string; block_time: Date }>`SELECT block_number, block_time FROM flow_index_blocks WHERE chain_id = ${8453} AND canonical AND block_number = ANY(${numbers}::bigint[])`;
      const date = new Map(blocks.map((row) => [Number(row.block_number), row.block_time.toISOString()]));
      return { schemaVersion: 1, indexedThrough: { block: watermark.number, hash: watermark.hash, time: new Date(watermark.timestamp * 1000).toISOString() }, attribution: "request-events-only", nextCursor: rows.length ? { block: Number(rows[rows.length - 1]!.block_number), logIndex: rows[rows.length - 1]!.log_index } : null, events: rows.flatMap((row) => { const event = decodeFlowEvent(row), time = date.get(Number(row.block_number)); if (!time) throw new Error("event block unavailable"); return event && requestEvents.has(event.name) ? [{ block: Number(row.block_number), time, logIndex: row.log_index, transactionHash: row.transaction_hash, event }] : []; }) };
    });
    return result ? reply(200, result) : reply(503, { error: "flow index unavailable" });
  } catch { return reply(503, { error: "flow index unavailable" }); }
}
