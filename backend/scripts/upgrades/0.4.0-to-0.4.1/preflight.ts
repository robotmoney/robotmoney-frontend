// Read-only preflight for the v0.4.0 -> v0.4.1 code-only rollout.
// This release has no database migration. The checks prove that production is
// at the v0.4.0 schema and that the candidate will not discover pending SQL.

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { runPreflightMain, type Db } from "../../lib/preflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import { PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS, TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const migrationsDir = join(dir, "..", "..", "..", "migrations");

export async function runChecks(db: Db, { record }: Checker): Promise<void> {
  if (!(await tableExists(db, "schema_migrations"))) {
    record("schema-migrations", "FAIL", "public.schema_migrations is absent", "Confirm the target is the v0.4.0 production database.");
    return;
  }

  const rows = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
  const applied = new Set(rows.map((row) => row.name));
  const missing = PRIOR_RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  record(
    "v0.4-schema",
    missing.length ? "FAIL" : "PASS",
    missing.length ? [`missing v0.4.0 migration(s): ${missing.join(", ")}`] : `all ${PRIOR_RELEASE_MIGRATIONS.length} v0.4.0 migrations are recorded`,
    "Do not deploy v0.4.1 until the target is identified and its v0.4.0 rollout is reconciled.",
  );

  const onDisk = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const pending = onDisk.filter((name) => !applied.has(name));
  const orphans = rows.map((row) => row.name).filter((name) => !onDisk.includes(name));
  record(
    "no-schema-delta",
    pending.length || orphans.length ? "FAIL" : "PASS",
    pending.length || orphans.length
      ? [
          ...(pending.length ? [`pending migration(s): ${pending.join(", ")}`] : []),
          ...(orphans.length ? [`recorded but absent from checkout: ${orphans.join(", ")}`] : []),
        ]
      : "database migration ledger matches the candidate checkout; v0.4.1 has no SQL to apply",
    "Stop and resolve schema/code drift; this release must be a code-only rollout.",
  );

  const absentTables: string[] = [];
  for (const table of ["swarm_judge_config", "swarm_session_judgements", "swarm_consensus_receipts"]) {
    if (!(await tableExists(db, table))) absentTables.push(table);
  }
  record(
    "v0.4-runtime-schema",
    absentTables.length ? "FAIL" : "PASS",
    absentTables.length ? `required v0.4.0 table(s) absent: ${absentTables.join(", ")}` : "v0.4.0 judge and receipt tables remain present",
    "Do not treat this as a clean v0.4.0 production baseline.",
  );

  record("release-migrations", RELEASE_MIGRATIONS.length ? "FAIL" : "PASS", "v0.4.1 declares zero migrations");
}

const emit = process.argv.includes("--emit-receipt");
const code = await runPreflightMain({
  envPath: join(repoRoot, ".env.readonly"),
  name: "preflight-0.4.1",
  allowPrivilegedEnvVar: "PREFLIGHT_ALLOW_PRIVILEGED",
  runChecks,
  receipt: emit ? { step: "P4.preflight-live", repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role } : undefined,
});
process.exitCode = code;
