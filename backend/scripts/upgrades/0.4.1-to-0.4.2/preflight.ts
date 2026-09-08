// Read-only preflight for the v0.4.1 -> v0.4.2 rollout. This release carries
// four additive migrations (0045-0048); the checks prove production is a
// clean v0.4.1 baseline with none of them applied yet, so the candidate's
// migration run at boot has nothing surprising to reconcile.

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { runPreflightMain, type Db } from "../../lib/preflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import { NEW_RELEASE_TABLES, PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS, TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const migrationsDir = join(dir, "..", "..", "..", "migrations");

export async function runChecks(db: Db, { record }: Checker): Promise<void> {
  if (!(await tableExists(db, "schema_migrations"))) {
    record("schema-migrations", "FAIL", "public.schema_migrations is absent", "Confirm the target is the v0.4.1 production database.");
    return;
  }

  const rows = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
  const applied = new Set(rows.map((row) => row.name));
  const missing = PRIOR_RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  record(
    "v0.4-schema",
    missing.length ? "FAIL" : "PASS",
    missing.length ? [`missing v0.4.0 migration(s): ${missing.join(", ")}`] : `all ${PRIOR_RELEASE_MIGRATIONS.length} v0.4.0 migrations are recorded`,
    "Do not deploy v0.4.2 until the target is identified and its v0.4.0/v0.4.1 rollout is reconciled.",
  );

  const onDisk = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const expectedPending = new Set<string>(RELEASE_MIGRATIONS);
  const pending = onDisk.filter((name) => !applied.has(name));
  const unexpectedPending = pending.filter((name) => !expectedPending.has(name));
  const orphans = rows.map((row) => row.name).filter((name) => !onDisk.includes(name));
  record(
    "no-schema-delta",
    unexpectedPending.length || orphans.length ? "FAIL" : "PASS",
    unexpectedPending.length || orphans.length
      ? [
          ...(unexpectedPending.length ? [`unexpected pending migration(s): ${unexpectedPending.join(", ")}`] : []),
          ...(orphans.length ? [`recorded but absent from checkout: ${orphans.join(", ")}`] : []),
        ]
      : `database migration ledger matches the candidate checkout aside from the ${RELEASE_MIGRATIONS.length} v0.4.2 migration(s) not yet applied`,
    "Stop and resolve schema/code drift before migrating.",
  );

  const absentTables: string[] = [];
  for (const table of ["swarm_judge_config", "swarm_session_judgements", "swarm_consensus_receipts"]) {
    if (!(await tableExists(db, table))) absentTables.push(table);
  }
  record(
    "v0.4-runtime-schema",
    absentTables.length ? "FAIL" : "PASS",
    absentTables.length ? `required v0.4.0 table(s) absent: ${absentTables.join(", ")}` : "v0.4.0 judge and receipt tables remain present",
    "Do not treat this as a clean v0.4.1 production baseline.",
  );

  const alreadyApplied = RELEASE_MIGRATIONS.filter((name) => applied.has(name));
  record(
    "clean-target",
    alreadyApplied.length ? "FAIL" : "PASS",
    alreadyApplied.length ? `v0.4.2 migration(s) already applied: ${alreadyApplied.join(", ")}` : "no v0.4.2 migration recorded yet",
    "The target is not a clean pre-migration v0.4.1 database.",
  );

  const existingNewTables: string[] = [];
  for (const table of NEW_RELEASE_TABLES) if (await tableExists(db, table)) existingNewTables.push(table);
  record(
    "clean-target-tables",
    existingNewTables.length ? "FAIL" : "PASS",
    existingNewTables.length ? `already exist: ${existingNewTables.join(", ")}` : "v0.4.2's new tables are absent before migration",
  );
}

const emit = process.argv.includes("--emit-receipt");
const code = await runPreflightMain({
  envPath: join(repoRoot, ".env.readonly"),
  name: "preflight-0.4.2",
  allowPrivilegedEnvVar: "PREFLIGHT_ALLOW_PRIVILEGED",
  runChecks,
  receipt: emit ? { step: "P4.preflight-live", repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role } : undefined,
});
process.exitCode = code;
