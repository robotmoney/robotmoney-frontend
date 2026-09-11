import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { columnExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { runPreflightMain, type Db } from "../../lib/preflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import {
  DIGEST_SCHEME_COLUMN, MEMBER_RECEIVED_INDEX, OWNER_ROLE, PRIOR_RELEASE_MIGRATIONS,
  SIGNING_KEY_COLUMN, TAG_GLOB, THIS_RELEASE_MIGRATIONS,
} from "./release.ts";
import { COMMITTED_EVIDENCE_DIR } from "./steps.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");

export async function runChecks(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`SELECT name FROM schema_migrations`) as unknown as { name: string }[];
  const names = new Set(rows.map((r) => r.name));
  const missing = PRIOR_RELEASE_MIGRATIONS.filter((name) => !names.has(name));
  if (missing.length) record("v0.4-baseline", "FAIL", `missing v0.4.0 migration(s): ${missing.join(", ")}`);
  else record("v0.4-baseline", "PASS", "v0.4.0 migration baseline present");

  const alreadyApplied = THIS_RELEASE_MIGRATIONS.filter((name) => names.has(name));
  if (alreadyApplied.length) record("clean-target", "FAIL", `v0.5.0 migration(s) already applied: ${alreadyApplied.join(", ")}`);
  else record("clean-target", "PASS", "no v0.5.0 migration recorded");

  const existingColumns: string[] = [];
  for (const c of [SIGNING_KEY_COLUMN, DIGEST_SCHEME_COLUMN]) {
    if (await columnExists(db, c.table, c.column)) existingColumns.push(`${c.table}.${c.column}`);
  }
  record("clean-target-columns", existingColumns.length ? "FAIL" : "PASS",
    existingColumns.length ? `already exist: ${existingColumns.join(", ")}` : "0049/0052's new columns absent before migration");

  const indexPresent = (await db`SELECT to_regclass(${`public.${MEMBER_RECEIVED_INDEX.index}`}) IS NOT NULL AS present`)[0] as { present: boolean };
  record("clean-target-index", indexPresent.present ? "FAIL" : "PASS",
    indexPresent.present ? `${MEMBER_RECEIVED_INDEX.index} already exists` : "0055's new index absent before migration");

  // 0053 creates cluster-level ROLES, not per-database objects — readable
  // from the read-only replica connection the same as any other catalog row,
  // even though rm_owner itself is a role this connection is not.
  const ownerRole = (await db`SELECT 1 FROM pg_roles WHERE rolname = ${OWNER_ROLE}`) as unknown as unknown[];
  record("clean-target-role", ownerRole.length ? "FAIL" : "PASS",
    ownerRole.length ? `role ${OWNER_ROLE} already exists` : `role ${OWNER_ROLE} absent before migration`);

  // Every table these seven migrations touch already exists on a v0.4.0
  // database — none of them creates a new TABLE (0049/0052 add columns, 0053/
  // 0054 change ownership and grants, 0055 adds an index) — so there is no
  // "clean-target-tables" check to make here the way earlier releases' new
  // tables needed one. Recorded explicitly so a future migration that DOES
  // add a table has an obvious existing check to extend instead of a silent
  // gap, rather than this being an assumption nothing states.
  record("no-new-tables", "PASS", "this release adds columns, an index, and role/grant changes only — no new table to pre-check");
}

const emit = process.argv.includes("--emit-receipt");
runPreflightMain({
  envPath: join(repoRoot, ".env.readonly"), name: "preflight-0.5.0", allowPrivilegedEnvVar: "PREFLIGHT_ALLOW_PRIVILEGED", runChecks,
  receipt: emit ? { step: "P4.preflight-live", repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role, committedEvidenceDir: COMMITTED_EVIDENCE_DIR } : undefined,
}).then((code) => process.exitCode = code);
