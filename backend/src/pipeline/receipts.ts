// Idempotency receipts for pipeline writes (issue 1034, decision D75).
//
// Every write the pipeline worker sends carries an Idempotency-Key. The api
// records the key, the sha256 of the request body and the response it sent, in
// the same transaction as the write (migration 0126). A replay with the same
// key and body is answered from the receipt and writes nothing, so a worker
// that lost a response to a network error, or restarted mid-request, can send
// the request again without adding a row. The same key with a different body is
// a client bug, and is refused.
import { createHash } from "node:crypto";
import { on, registerQuery, type RegistryDb } from "../db/registry.ts";

const PIPELINE_ROUTE = ["src/api/routes/pipeline"];

const readReceipt = registerQuery({
  role: "rm_app",
  object: "pipeline_ingest_receipts",
  privileges: ["SELECT"],
  site: "src/pipeline/receipts:findReceipt",
  purpose: "Find the receipt a pipeline write's Idempotency-Key already holds, to answer a replay from it.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: "SELECT body_sha256, response FROM pipeline_ingest_receipts WHERE idempotency_key = $1",
    params: ["probe-key"],
  },
});

const writeReceipt = registerQuery({
  role: "rm_app",
  object: "pipeline_ingest_receipts",
  privileges: ["INSERT"],
  site: "src/pipeline/receipts:recordReceipt",
  purpose: "Record a pipeline write's Idempotency-Key, body hash and response in the write's own transaction.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO pipeline_ingest_receipts (idempotency_key, operation, body_sha256, response, job_id)
      SELECT $1, $2, $3, $4::jsonb, $5::bigint WHERE false`,
    params: ["probe-key", "probe", "0000000000000000000000000000000000000000000000000000000000000000", "{}", null],
  },
});

/** sha256 of a request body, as the receipt stores it. */
export function bodySha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface StoredReceipt {
  readonly bodySha256: string;
  /** The response sent, as `{ status, body }` with the body in the pipeline encoding. */
  readonly response: { status: number; body: unknown };
}

/** The receipt `key` holds, or null. */
export async function findReceipt(db: RegistryDb, key: string): Promise<StoredReceipt | null> {
  const [row] = await on(db, readReceipt)<{ body_sha256: string; response: { status: number; body: unknown } }>`
    SELECT body_sha256, response FROM pipeline_ingest_receipts WHERE idempotency_key = ${key}`;
  return row ? { bodySha256: row.body_sha256, response: row.response } : null;
}

/** Record `key`'s receipt. A concurrent duplicate fails here on the primary key and its transaction rolls back. */
export async function recordReceipt(
  db: RegistryDb,
  receipt: { key: string; operation: string; bodySha256: string; response: { status: number; body: unknown }; jobId: number | null },
): Promise<void> {
  await on(db, writeReceipt)`
    INSERT INTO pipeline_ingest_receipts (idempotency_key, operation, body_sha256, response, job_id)
    VALUES (${receipt.key}, ${receipt.operation}, ${receipt.bodySha256}, ${db.json(receipt.response as never)}, ${receipt.jobId})`;
}
