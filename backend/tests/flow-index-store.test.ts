import { expect, test } from "bun:test";
import postgres from "postgres";
import { useCleanDatabase } from "./support/clean-db.ts";
import { flowCheckpoints, flowRecord, flowRewind } from "../src/pipeline/stores/flow-index.ts";

useCleanDatabase(import.meta.file);

test("stores idempotent logs and replaces canonical history without runtime DELETE", async () => {
  const db = postgres(process.env.DATABASE_URL!, { max: 1 });
  const a = { number: 1, hash: "a", timestamp: 1 };
  const b = { number: 2, hash: "b", timestamp: 2 };
  const replacement = { number: 2, hash: "c", timestamp: 3 };
  const log = { blockNumber: 2, blockHash: "b", logIndex: 0, transactionHash: "tx", address: "addr", topics: ["topic"], data: "0x" };
  try {
    await db.begin(async (tx) => { await tx`SET LOCAL ROLE rm_app`; await flowRecord(tx, 8453, [a, b], [log]); });
    await db.begin(async (tx) => { await tx`SET LOCAL ROLE rm_app`; await flowRecord(tx, 8453, [a, b], [log]); });
    await db.begin(async (tx) => { await tx`SET LOCAL ROLE rm_app`; await flowRewind(tx, 8453, 1); await flowRecord(tx, 8453, [replacement], []); });
    const checkpoints = await flowCheckpoints(db, 8453);
    expect(checkpoints.map((x) => x.hash)).toEqual(["c", "a"]);
    const rows = await db`SELECT count(*)::int AS n FROM flow_index_logs`;
    expect(rows[0]!.n).toBe(1);
    const canonical = await db`SELECT count(*)::int AS n FROM flow_index_logs l JOIN flow_index_blocks b USING (chain_id, block_number, block_hash) WHERE b.canonical`;
    expect(canonical[0]!.n).toBe(0);
  } finally { await db.end(); }
});
