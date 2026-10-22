// The shape of one /api/pipeline/** read or ingestion operation (issue 1034,
// decision D75). The operations themselves are listed in ops.ts.
import type { RegistryDb } from "../db/registry.ts";

/** A read: runs on the batch pool, writes nothing, needs no lease. */
export interface PipelineReadOp {
  readonly kind: "read";
  run(db: RegistryDb, args: readonly unknown[]): Promise<unknown>;
}

/**
 * A write: runs in one transaction, fenced by the caller's lease and keyed by
 * its Idempotency-Key. `rows` counts the rows the request writes, which may not
 * exceed PIPELINE_MAX_ROWS; a set the request only names (a keep list, a date
 * range) is not counted, and is bounded by the body limit instead.
 */
export interface PipelineIngestOp {
  readonly kind: "ingest";
  rows(args: readonly unknown[]): number;
  run(tx: RegistryDb, args: readonly unknown[]): Promise<unknown>;
}

export type PipelineOp = PipelineReadOp | PipelineIngestOp;

/** A read operation over a store method taking positional arguments. */
export function readOp(run: (db: RegistryDb, ...args: never[]) => Promise<unknown>): PipelineReadOp {
  return { kind: "read", run: (db, args) => (run as (db: RegistryDb, ...a: unknown[]) => Promise<unknown>)(db, ...args) };
}

/** A write operation over a store method taking positional arguments; `rows` counts what it writes. */
export function ingestOp(
  run: (tx: RegistryDb, ...args: never[]) => Promise<unknown>,
  rows: (args: readonly unknown[]) => number = () => 1,
): PipelineIngestOp {
  return { kind: "ingest", rows, run: (tx, args) => (run as (tx: RegistryDb, ...a: unknown[]) => Promise<unknown>)(tx, ...args) };
}

/** Rows in the array at position `index` of the arguments (0 when it is not an array). */
export function rowsAt(index: number): (args: readonly unknown[]) => number {
  return (args) => (Array.isArray(args[index]) ? (args[index] as unknown[]).length : 0);
}
