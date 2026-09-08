// Postflight for the v0.4.0 -> v0.4.1 code-only rollout. All database checks
// are SELECT-only; the release changes boot/build tooling, not schema state.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertContractInstallFresh } from "../../../../scripts/lib/contract-freshness.ts";
import { tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { runPostflightMain, type Db } from "../../lib/postflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import { PRIOR_RELEASE_MIGRATIONS, TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const receiptStep = process.argv.find((arg) => arg.startsWith("--emit-receipt="))?.split("=", 2)[1]
  ?? (process.argv.includes("--emit-receipt") ? "P8.postflight-prod" : undefined);

export async function runChecks(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`SELECT name FROM schema_migrations`) as unknown as { name: string }[];
  const applied = new Set(rows.map((row) => row.name));
  const missing = PRIOR_RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  record("schema-preserved", missing.length ? "FAIL" : "PASS", missing.length ? `missing: ${missing.join(", ")}` : "all v0.4.0 migrations remain recorded");

  const absentTables: string[] = [];
  for (const table of ["swarm_judge_config", "swarm_session_judgements", "swarm_consensus_receipts"]) {
    if (!(await tableExists(db, table))) absentTables.push(table);
  }
  record("runtime-schema", absentTables.length ? "FAIL" : "PASS", absentTables.length ? `absent: ${absentTables.join(", ")}` : "v0.4.0 runtime tables are present");

  try {
    await assertContractInstallFresh(repoRoot);
    record("contract-freshness", "PASS", "installed @robotmoney/contract matches this checkout");
  } catch (error) {
    record("contract-freshness", "FAIL", error instanceof Error ? error.message : String(error), "Run bun install --force at the repository root and rerun postflight.");
  }
}

const code = await runPostflightMain({
  name: "postflight-0.4.1",
  runChecks,
  receipt: receiptStep ? { step: receiptStep, repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role } : undefined,
});
process.exitCode = code;
