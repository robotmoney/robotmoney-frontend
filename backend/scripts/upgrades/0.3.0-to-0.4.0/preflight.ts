import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { runPreflightMain, type Db } from "../../lib/preflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import { JUDGE_CONFIG_TABLE, JUDGEMENT_TABLE, PRIOR_RELEASE_MIGRATIONS, RECEIPT_TABLE, TAG_GLOB, THIS_RELEASE_MIGRATIONS } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");

export async function runChecks(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`SELECT name FROM schema_migrations`) as unknown as { name: string }[];
  const names = new Set(rows.map((r) => r.name));
  const missing = PRIOR_RELEASE_MIGRATIONS.filter((name) => !names.has(name));
  if (missing.length) record("v0.3-baseline", "FAIL", `missing v0.3.0 migration(s): ${missing.join(", ")}`);
  else record("v0.3-baseline", "PASS", "v0.3.0 migration baseline present");
  const alreadyApplied = THIS_RELEASE_MIGRATIONS.filter((name) => names.has(name));
  if (alreadyApplied.length) record("clean-target", "FAIL", `v0.4.0 migration(s) already applied: ${alreadyApplied.join(", ")}`);
  else record("clean-target", "PASS", "no v0.4.0 migration recorded");
  const existing = [] as string[];
  for (const table of [JUDGE_CONFIG_TABLE, JUDGEMENT_TABLE, RECEIPT_TABLE]) if (await tableExists(db, table)) existing.push(table);
  record("clean-target-tables", existing.length ? "FAIL" : "PASS", existing.length ? `already exist: ${existing.join(", ")}` : "judge and receipt tables absent before migration");
}

const emit = process.argv.includes("--emit-receipt");
runPreflightMain({ envPath: join(repoRoot, ".env.readonly"), name: "preflight-0.4.0", allowPrivilegedEnvVar: "PREFLIGHT_ALLOW_PRIVILEGED", runChecks,
  receipt: emit ? { step: "P4.preflight-live", repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role } : undefined,
}).then((code) => process.exitCode = code);
