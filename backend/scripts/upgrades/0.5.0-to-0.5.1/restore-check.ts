// Gate C for v0.5.1: restore the backup into a throwaway local container (on
// stage-2, never the production host: runbook R3) and grade the DUMP against
// this release's migration facts. 0.4.0-to-0.5.0's restore-check rightly
// calls v0.5.1's two migrations "unexpected pending"; this one expects them.
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createChecker, printVerdict } from "../../lib/checks.ts";
import { deriveHostRole, emitReceipt, gitFacts } from "../../lib/rollout-receipt.ts";
import { resolveBackupFiles, restoreBackupIntoContainer, teardownContainer } from "../../../../scripts/lib/restore-container.ts";
import { PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS, REQUIRED_TABLES, TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const migrationsDir = join(repoRoot, "backend", "migrations");
const backupDir = process.argv.find((arg) => !arg.startsWith("-") && arg !== process.argv[0] && arg !== process.argv[1]);
const startedAt = new Date().toISOString();
const PREFIX = "[restore-check-0.5.1] ";

/** PURE. Grade the recorded ledger against the checkout's files and this release's facts. */
export function gradeLedger(recorded: readonly string[], onDisk: readonly string[]): { missingPrior: string[]; unexpectedPending: string[]; orphans: string[]; releasePending: string[] } {
  const applied = new Set(recorded);
  const expected = new Set<string>(RELEASE_MIGRATIONS);
  const pending = onDisk.filter((name) => !applied.has(name));
  return {
    missingPrior: PRIOR_RELEASE_MIGRATIONS.filter((name) => !applied.has(name)),
    unexpectedPending: pending.filter((name) => !expected.has(name)),
    orphans: recorded.filter((name) => !onDisk.includes(name)),
    releasePending: RELEASE_MIGRATIONS.filter((name) => !applied.has(name)),
  };
}

async function run(): Promise<number> {
  const backup = resolveBackupFiles(backupDir);
  if ("error" in backup) { console.error(backup.error); return 2; }
  const restored = await restoreBackupIntoContainer(backup, console.log);
  if ("error" in restored) { console.error(restored.error); return 2; }
  try {
    const db = postgres({ host: restored.host, port: restored.port, username: restored.username, password: restored.password, database: restored.database, max: 1 });
    try {
      const { record, results } = createChecker(PREFIX);
      const recorded = ((await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[]).map((r) => r.name);
      const onDisk = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
      const g = gradeLedger(recorded, onDisk);
      record("v0.5.0-schema", g.missingPrior.length ? "FAIL" : "PASS",
        g.missingPrior.length ? [`missing prior migration(s): ${g.missingPrior.join(", ")}`] : `all ${PRIOR_RELEASE_MIGRATIONS.length} v0.5.0 migrations (with 0062) are recorded`,
        "Do not deploy v0.5.1 until the target is identified as production at v0.5.0.");
      record("no-schema-delta", g.unexpectedPending.length || g.orphans.length ? "FAIL" : "PASS",
        g.unexpectedPending.length || g.orphans.length
          ? [...(g.unexpectedPending.length ? [`unexpected pending migration(s): ${g.unexpectedPending.join(", ")}`] : []), ...(g.orphans.length ? [`recorded but absent from checkout: ${g.orphans.join(", ")}`] : [])]
          : `ledger matches the checkout aside from the ${g.releasePending.length} v0.5.1 migration(s) not yet applied: ${g.releasePending.join(", ") || "none"}`,
        "Stop and resolve schema/code drift before migrating.");
      const present = new Set(((await db`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`) as unknown as { table_name: string }[]).map((r) => r.table_name));
      const absent = REQUIRED_TABLES.filter((t) => !present.has(t));
      record("release-tables", absent.length ? "FAIL" : "PASS", absent.length ? [`absent: ${absent.join(", ")}`] : `${REQUIRED_TABLES.length} tables this release's migrations touch are present`,
        "The dump is not a v0.5.0 production database.");
      return printVerdict(results, { logPrefix: PREFIX, okAll: "DUMP SAFE FOR 0.5.1", okWithWarnings: "DUMP SAFE FOR 0.5.1", blocked: "DUMP BLOCKED" });
    } finally { await db.end({ timeout: 5 }); }
  } finally { teardownContainer(restored.container, console.log); }
}

if (import.meta.main) {
  const code = await run();
  if (process.argv.includes("--emit-receipt")) {
    const backup = resolveBackupFiles(backupDir);
    emitReceipt({
      step: "R3.3.restore-check", exit: code, verdict: code === 0 ? "DUMP SAFE FOR 0.5.1" : "DUMP BLOCKED", startedAt,
      repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role, git: gitFacts(repoRoot, TAG_GLOB), backupDir,
      artifactPaths: "error" in backup ? [] : [backup.dumpEnc, backup.globalsEnc],
    });
  }
  process.exitCode = code;
}
