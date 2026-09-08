import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createChecker, printVerdict } from "../../lib/checks.ts";
import { deriveHostRole, emitReceipt, gitFacts } from "../../lib/rollout-receipt.ts";
import { resolveBackupFiles, restoreBackupIntoContainer, teardownContainer } from "../../../../scripts/lib/restore-container.ts";
import { runChecks } from "./preflight.ts";
import { TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const backupDir = process.argv.find((arg) => !arg.startsWith("-") && arg !== process.argv[0] && arg !== process.argv[1]);
const startedAt = new Date().toISOString();

async function run(): Promise<number> {
  const backup = resolveBackupFiles(backupDir);
  if ("error" in backup) { console.error(backup.error); return 2; }
  const restored = await restoreBackupIntoContainer(backup, console.log);
  if ("error" in restored) { console.error(restored.error); return 2; }
  try {
    const db = postgres({ host: restored.host, port: restored.port, username: restored.username, password: restored.password, database: restored.database, max: 1 });
    try {
      const checker = createChecker("[restore-check-0.4.2] ");
      await runChecks(db, checker);
      return printVerdict(checker.results, { logPrefix: "[restore-check-0.4.2] ", okAll: "DUMP SAFE FOR 0.4.2", okWithWarnings: "DUMP SAFE FOR 0.4.2", blocked: "DUMP BLOCKED" });
    } finally { await db.end({ timeout: 5 }); }
  } finally { teardownContainer(restored.container, console.log); }
}

const code = await run();
if (process.argv.includes("--emit-receipt")) {
  const backup = resolveBackupFiles(backupDir);
  emitReceipt({
    step: "P3.gate-c", exit: code, verdict: code === 0 ? "DUMP SAFE FOR 0.4.2" : "DUMP BLOCKED", startedAt,
    repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role, git: gitFacts(repoRoot, TAG_GLOB), backupDir,
    artifactPaths: "error" in backup ? [] : [backup.dumpEnc, backup.globalsEnc],
  });
}
process.exitCode = code;
