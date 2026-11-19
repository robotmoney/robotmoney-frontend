import { flowConfigured, flowDisabled } from "./flow-config.ts";
import { sql } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { flowCheckpoints, flowDeployment } from "../../pipeline/stores/flow-index.ts";
import { decodeFlowEvent } from "../../chain/flow-events.ts";
import { encodeAddressArg } from "../../chain/base-rpc-client.ts";
import { createRateLimiter } from "../rate-limit.ts";

// Owner-level settlement events. In FlowQueue v0.9 claims, credits and
// wind-down releases are emitted per owner (first indexed topic), not per
// request, so this is the owner's claim history in chain order.
const SHARES_DELIVERED = "0xdfe275799fb4d958ef7eb4fa3c86cdca5a4999fd0b8941d39653fd13f1c22bae";
const REDEEM_CLAIMED = "0x9058dd2ba35a60a487ae583a06f9d17836b0e841c951f43a1baa3f33d0c55ccf";
const CREDIT_ADDED = "0x4a39100d222c6c07af4e59c449c4643191784bcc65a9b1427f7c6e0018a75b3e";
const CREDIT_WITHDRAWN = "0x77982616940619ddbda4afe3675280fff7c605d31503336add3633fbea69d8ba";
const WIND_DOWN_RELEASED = "0x5872104128ca2bce296136f7aaebaffd0cd055e054483e0a1f15e73a8b491c75";
const claims = registerQuery({ role: "rm_app", object: "flow_index_logs", privileges: ["SELECT"], site: "src/api/routes/flow-owner-claims:claims", purpose: "List an owner's canonical claim, credit and wind-down events.", callers: ["src/api/index"], probe: { statement: "SELECT block_number, log_index, transaction_hash, topics, data FROM flow_index_logs WHERE chain_id = $1 AND canonical AND lower(address) = $2 AND lower(topics->>1) = $3 AND lower(topics->>0) IN ($4, $5, $6, $7, $8) AND (block_number, log_index) > ($9, $10) ORDER BY block_number, log_index LIMIT 100", params: [8453, "0xqueue", "0xowner", SHARES_DELIVERED, REDEEM_CLAIMED, CREDIT_ADDED, CREDIT_WITHDRAWN, WIND_DOWN_RELEASED, 0, -1] } });
const times = registerQuery({ role: "rm_app", object: "flow_index_blocks", privileges: ["SELECT"], site: "src/api/routes/flow-owner-claims:times", purpose: "Date an owner's canonical claim events.", callers: ["src/api/index"], probe: { statement: "SELECT block_number, block_time FROM flow_index_blocks WHERE chain_id = $1 AND canonical AND block_number = ANY($2::bigint[])", params: [8453, "{1}"] } });
const limiter = createRateLimiter({ max: 60, windowMs: 60_000 });
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleFlowOwnerClaims(req: Request, url: URL, owner: string, ip: string): Promise<Response> {
  if (limiter.check(ip).limited) return reply(429, { error: "rate limit exceeded" });
  if (req.method !== "GET") return reply(405, { error: "method not allowed" });
  if (!flowConfigured()) return flowDisabled();
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return reply(400, { error: "invalid owner" });
  const block = Number(url.searchParams.get("afterBlock") ?? 0), index = Number(url.searchParams.get("afterLogIndex") ?? -1);
  if (!Number.isSafeInteger(block) || block < 0 || !Number.isSafeInteger(index) || index < -1) return reply(400, { error: "invalid cursor" });
  try {
    const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const bound = await flowDeployment(tx, 8453), watermark = (await flowCheckpoints(tx, 8453))[0];
      if (!process.env.FLOW_QUEUE_ADDRESS || !process.env.FLOW_FUND_ADDRESS || bound?.queue_address !== process.env.FLOW_QUEUE_ADDRESS.toLowerCase() || bound.fund_address !== process.env.FLOW_FUND_ADDRESS.toLowerCase() || !watermark) return null;
      const topic = `0x${encodeAddressArg(owner)}`;
      const rows = await on(tx, claims)<{ block_number: string; log_index: number; transaction_hash: string; topics: string[]; data: string }>`SELECT block_number, log_index, transaction_hash, topics, data FROM flow_index_logs WHERE chain_id = ${8453} AND canonical AND lower(address) = ${bound.queue_address} AND lower(topics->>1) = ${topic} AND lower(topics->>0) IN (${SHARES_DELIVERED}, ${REDEEM_CLAIMED}, ${CREDIT_ADDED}, ${CREDIT_WITHDRAWN}, ${WIND_DOWN_RELEASED}) AND (block_number, log_index) > (${block}, ${index}) ORDER BY block_number, log_index LIMIT 100`;
      const numbers = [...new Set(rows.map((row) => Number(row.block_number)))];
      const blocks = await on(tx, times)<{ block_number: string; block_time: Date }>`SELECT block_number, block_time FROM flow_index_blocks WHERE chain_id = ${8453} AND canonical AND block_number = ANY(${numbers}::bigint[])`;
      const date = new Map(blocks.map((row) => [Number(row.block_number), row.block_time.toISOString()]));
      const last = rows.at(-1);
      return {
        schemaVersion: 1,
        indexedThrough: { block: watermark.number, hash: watermark.hash, time: new Date(watermark.timestamp * 1000).toISOString() },
        nextCursor: last ? { block: Number(last.block_number), logIndex: last.log_index } : null,
        claims: rows.map((row) => {
          const time = date.get(Number(row.block_number));
          if (!time) throw new Error("claim block unavailable");
          return { block: Number(row.block_number), time, logIndex: row.log_index, transactionHash: row.transaction_hash, event: decodeFlowEvent(row) };
        }),
      };
    });
    return result ? reply(200, result) : reply(503, { error: "flow index unavailable" });
  } catch { return reply(503, { error: "flow index unavailable" }); }
}
