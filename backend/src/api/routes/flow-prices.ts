import { flowConfigured, flowDisabled } from "./flow-config.ts";
import { sql } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { flowCheckpoints, flowDeployment } from "../../pipeline/stores/flow-index.ts";
import { decodeFlowEvent } from "../../chain/flow-events.ts";
import { createRateLimiter } from "../rate-limit.ts";

const settleTopic = "0x8ecc624c6f11fc84fecb7269245980bab9d25af8b2548d1d47212d16e53de860";
const prices = registerQuery({ role: "rm_app", object: "flow_index_logs", privileges: ["SELECT"], site: "src/api/routes/flow-prices:history", purpose: "Read canonical settlement prices in chain order.", callers: ["src/api/index"], probe: { statement: "SELECT block_number, log_index, transaction_hash, topics, data FROM flow_index_logs WHERE chain_id = $1 AND canonical AND lower(address) = $2 AND lower(topics->>0) = $3 AND (block_number, log_index) > ($4, $5) ORDER BY block_number, log_index LIMIT 100", params: [8453, "0xqueue", settleTopic, 0, -1] } });
const times = registerQuery({ role: "rm_app", object: "flow_index_blocks", privileges: ["SELECT"], site: "src/api/routes/flow-prices:blockTimes", purpose: "Date canonical settlement price events.", callers: ["src/api/index"], probe: { statement: "SELECT block_number, block_time FROM flow_index_blocks WHERE chain_id = $1 AND canonical AND block_number = ANY($2::bigint[])", params: [8453, "{1}"] } });
const limiter = createRateLimiter({ max: 60, windowMs: 60_000 });
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function handleFlowPrices(req: Request, url: URL, ip: string): Promise<Response> {
  if (limiter.check(ip).limited) return reply(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return reply(405, { error: "method not allowed" });
  if (!flowConfigured()) return flowDisabled();
  const block = Number(url.searchParams.get("afterBlock") ?? 0), index = Number(url.searchParams.get("afterLogIndex") ?? -1);
  if (!Number.isSafeInteger(block) || block < 0 || !Number.isSafeInteger(index) || index < -1) return reply(400, { error: "invalid cursor" });
  try {
    const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const bound = await flowDeployment(tx, 8453), watermark = (await flowCheckpoints(tx, 8453))[0];
      if (!process.env.FLOW_QUEUE_ADDRESS || !process.env.FLOW_FUND_ADDRESS || bound?.queue_address !== process.env.FLOW_QUEUE_ADDRESS.toLowerCase() || bound.fund_address !== process.env.FLOW_FUND_ADDRESS.toLowerCase() || !watermark) return null;
      const rows = await on(tx, prices)<{ block_number: string; log_index: number; transaction_hash: string; topics: string[]; data: string }>`SELECT block_number, log_index, transaction_hash, topics, data FROM flow_index_logs WHERE chain_id = ${8453} AND canonical AND lower(address) = ${bound.queue_address} AND lower(topics->>0) = ${settleTopic} AND (block_number, log_index) > (${block}, ${index}) ORDER BY block_number, log_index LIMIT 100`;
      const blockNumbers = [...new Set(rows.map((row) => Number(row.block_number)))];
      const timeRows = await on(tx, times)<{ block_number: string; block_time: Date }>`SELECT block_number, block_time FROM flow_index_blocks WHERE chain_id = ${8453} AND canonical AND block_number = ANY(${blockNumbers}::bigint[])`;
      const timeByBlock = new Map(timeRows.map((row) => [Number(row.block_number), row.block_time.toISOString()]));
      return { schemaVersion: 1, indexedThrough: { block: watermark.number, hash: watermark.hash, time: new Date(watermark.timestamp * 1000).toISOString() }, priceScale: "1000000000000000000000000000000000000", prices: rows.map((row) => { const event = decodeFlowEvent(row), time = timeByBlock.get(Number(row.block_number)); if (!event || !time) throw new Error("settlement block unavailable"); return { block: Number(row.block_number), time, logIndex: row.log_index, transactionHash: row.transaction_hash, settlementId: event.args.settlementId, sharePrice: event.args.sharePrice }; }) };
    });
    return result ? reply(200, result) : reply(503, { error: "flow index unavailable" });
  } catch { return reply(503, { error: "flow index unavailable" }); }
}
