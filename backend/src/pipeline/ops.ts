// Every /api/pipeline/** read and ingestion operation, by name (issue 1034,
// decision D75).
//
// The pipeline worker names an operation in the path (`/api/pipeline/read/<name>`
// or `/api/pipeline/ingest/<name>`) and passes its arguments as a JSON array.
// Each entry runs a store function the api owns, as rm_app, on the batch pool:
// the worker never sends a statement, only a name from this table and values.
import { checkDomainParity, recordParityObservation } from "../analytics/cutover/parity.ts";
import { isParityDomain } from "../analytics/cutover/parity-domains.ts";
import type { RegistryDb } from "../db/registry.ts";
import { ingestOp, type PipelineOp } from "./op.ts";

/** analytics.parity_sweep: one domain's set-based comparison and its observation (issue 1375). */
async function paritySweepDomain(tx: RegistryDb, domain: unknown): Promise<unknown> {
  if (!isParityDomain(domain)) throw new Error(`analytics.parity_sweep: unknown domain ${JSON.stringify(domain)}`);
  const started = performance.now();
  const result = await checkDomainParity(domain, tx);
  await recordParityObservation(result, tx);
  return {
    domain,
    matched: result.matched,
    legacyRowCount: result.legacyRowCount,
    ledgerRowCount: result.ledgerRowCount,
    mismatchCount: result.mismatchCount,
    durationMs: Math.round(performance.now() - started),
  };
}

export const PIPELINE_OPS: Readonly<Record<string, PipelineOp>> = Object.freeze({
  "analytics.parity_sweep": ingestOp(paritySweepDomain),
});
