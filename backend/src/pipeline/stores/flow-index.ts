import { on, registerQuery, type RegistryDb } from "../../db/registry.ts";
import type { FlowHeader, FlowLog } from "../../chain/flow-indexer.ts";

const insertDeployment = registerQuery({ role: "rm_app", object: "flow_index_deployment", privileges: ["INSERT"], site: "src/pipeline/stores/flow-index:bindDeployment", purpose: "Bind an index to one queue and fund deployment.", callers: ["src/api/routes/pipeline"], probe: { statement: "INSERT INTO flow_index_deployment (chain_id, queue_address, fund_address) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", params: [8453, "0xqueue", "0xfund"] } });
const readDeployment = registerQuery({ role: "rm_app", object: "flow_index_deployment", privileges: ["SELECT"], site: "src/pipeline/stores/flow-index:readDeployment", purpose: "Refuse a cursor bound to different contracts.", callers: ["src/api/routes/pipeline", "src/api/index"], probe: { statement: "SELECT queue_address, fund_address FROM flow_index_deployment WHERE chain_id = $1", params: [8453] } });
const readBlocks = registerQuery({ role: "rm_app", object: "flow_index_blocks", privileges: ["SELECT"], site: "src/pipeline/stores/flow-index:checkpoints", purpose: "Read a bounded page of canonical scan checkpoints for reorg detection.", callers: ["src/api/routes/pipeline"], probe: { statement: "SELECT block_number, block_hash, extract(epoch from block_time) AS block_time FROM flow_index_blocks WHERE chain_id = $1 AND canonical AND block_number < $2 ORDER BY block_number DESC LIMIT 256", params: [8453, 999] } });
const rewindBlocks = registerQuery({ role: "rm_app", object: "flow_index_blocks", privileges: ["SELECT", "UPDATE"], site: "src/pipeline/stores/flow-index:rewind", purpose: "Mark orphaned blocks noncanonical after a reorg.", callers: ["src/api/routes/pipeline"], probe: { statement: "UPDATE flow_index_blocks SET canonical = false WHERE chain_id = $1 AND block_number > $2 AND canonical", params: [8453, 0] } });
const insertBlock = registerQuery({ role: "rm_app", object: "flow_index_blocks", privileges: ["SELECT", "INSERT", "UPDATE"], site: "src/pipeline/stores/flow-index:recordBlock", purpose: "Persist a canonical block checkpoint.", callers: ["src/api/routes/pipeline"], probe: { statement: "INSERT INTO flow_index_blocks (chain_id, block_number, block_hash, block_time, canonical) VALUES ($1, $2, $3, to_timestamp($4), true) ON CONFLICT (chain_id, block_number, block_hash) DO UPDATE SET canonical = true", params: [8453, 1, "0xprobe", 1] } });
const insertLog = registerQuery({ role: "rm_app", object: "flow_index_logs", privileges: ["SELECT", "INSERT", "UPDATE"], site: "src/pipeline/stores/flow-index:recordLog", purpose: "Persist an idempotent raw queue log.", callers: ["src/api/routes/pipeline"], probe: { statement: "INSERT INTO flow_index_logs (chain_id, block_number, block_hash, log_index, transaction_hash, address, topics, data) SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8 WHERE false ON CONFLICT (chain_id, block_hash, log_index) DO UPDATE SET canonical = true", params: [8453, 1, "0xprobe", 0, "0xprobe", "0xprobe", "[]", "0x"] } });
const rewindLogs = registerQuery({ role: "rm_app", object: "flow_index_logs", privileges: ["SELECT", "UPDATE"], site: "src/pipeline/stores/flow-index:rewindLogs", purpose: "Mark orphaned logs noncanonical.", callers: ["src/api/routes/pipeline"], probe: { statement: "UPDATE flow_index_logs SET canonical = false WHERE chain_id = $1 AND block_number > $2 AND canonical", params: [8453, 0] } });

export async function flowBindDeployment(tx: RegistryDb, chainId: number, queue: string, fund: string): Promise<void> {
  queue = queue.toLowerCase(); fund = fund.toLowerCase();
  await on(tx, insertDeployment)`INSERT INTO flow_index_deployment (chain_id, queue_address, fund_address) VALUES (${chainId}, ${queue}, ${fund}) ON CONFLICT DO NOTHING`;
  const bound = await flowDeployment(tx, chainId);
  if (bound?.queue_address !== queue || bound?.fund_address !== fund) throw new Error("flow index is bound to a different deployment");
}
export async function flowDeployment(db: RegistryDb, chainId: number): Promise<{ queue_address: string; fund_address: string } | null> {
  const rows = await on(db, readDeployment)<{ queue_address: string; fund_address: string }>`SELECT queue_address, fund_address FROM flow_index_deployment WHERE chain_id = ${chainId}`;
  return rows[0] ?? null;
}

export async function flowCheckpoints(db: RegistryDb, chainId: number, before = Number.MAX_SAFE_INTEGER): Promise<FlowHeader[]> {
  const rows = await on(db, readBlocks)<{ block_number: string; block_hash: string; block_time: string }>`SELECT block_number, block_hash, extract(epoch from block_time) AS block_time FROM flow_index_blocks WHERE chain_id = ${chainId} AND canonical AND block_number < ${before} ORDER BY block_number DESC LIMIT 256`;
  return rows.map((r) => ({ number: Number(r.block_number), hash: r.block_hash, timestamp: Number(r.block_time) }));
}
export async function flowRewind(tx: RegistryDb, chainId: number, after: number): Promise<void> {
  await on(tx, rewindLogs)`UPDATE flow_index_logs SET canonical = false WHERE chain_id = ${chainId} AND block_number > ${after} AND canonical`;
  await on(tx, rewindBlocks)`UPDATE flow_index_blocks SET canonical = false WHERE chain_id = ${chainId} AND block_number > ${after} AND canonical`;
}
export async function flowRecord(tx: RegistryDb, chainId: number, headers: FlowHeader[], logs: FlowLog[]): Promise<void> {
  for (const h of headers) await on(tx, insertBlock)`INSERT INTO flow_index_blocks (chain_id, block_number, block_hash, block_time, canonical) VALUES (${chainId}, ${h.number}, ${h.hash}, to_timestamp(${h.timestamp}), true) ON CONFLICT (chain_id, block_number, block_hash) DO UPDATE SET canonical = true`;
  for (const l of logs) await on(tx, insertLog)`INSERT INTO flow_index_logs (chain_id, block_number, block_hash, log_index, transaction_hash, address, topics, data) VALUES (${chainId}, ${l.blockNumber}, ${l.blockHash}, ${l.logIndex}, ${l.transactionHash}, ${l.address}, ${tx.json(l.topics)}::jsonb, ${l.data}) ON CONFLICT (chain_id, block_hash, log_index) DO UPDATE SET canonical = true`;
}
