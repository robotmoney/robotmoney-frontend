// ⛔ RUN THIS ON THE DEDICATED STAGING HOST, NEVER THE PRODUCTION API HOST
// (docs/runbooks/rollout-procedure.md §4). Lighter than stage-rehearsal.ts — one small
// container, no image build — but still real load, and the rule is "the
// staging host," not "whichever checks seem cheap enough."
//
// Restore-verify the encrypted Gate C backup (docs/runbooks/rollout-procedure.md §5) into a
// THROWAWAY local Postgres container, THEN run this release's full preflight
// checks (preflight.ts's runChecks) against that restored copy. Touches
// nothing on production — no network path to it at all once the encrypted
// files are read from disk. This is deliberately the FIRST place preflight's
// checks run: the runbook's process is dump -> restore -> check the dump ->
// only then check the live replica, never production first.
//
// This is the FAST, SQL-only check. For a much heavier but much stronger
// rehearsal — actually running this release's migrations for real and
// booting the whole app against the restored data — see stage-rehearsal.ts.
//
// Usage:
//   bun scripts/upgrades/0.2.2-to-0.3.0/restore-check.ts [backupDir]
//   backupDir defaults to ~/rm-backup-v030. Expects, inside it:
//     .last-stamp                       — the STAMP §5.1 generated
//     rm-preupgrade-<STAMP>.dump.gpg    — §5.1/§5.2's encrypted pg_dump
//     rm-globals-<STAMP>.sql.gpg        — §5.1/§5.2's encrypted pg_dumpall --globals-only
//     .backup-passphrase                — §5.2's gpg passphrase
//
// Exit codes: 0 = restore verified AND all preflight checks pass/warn,
// 1 = a verification query or a preflight check FAILed,
// 2 = could not run (missing files, docker/gpg/pg_restore failure).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { columnExists, createChecker, printVerdict } from "../../lib/checks.ts";
import { resolveBackupFiles, restoreBackupIntoContainer, teardownContainer } from "../../../../scripts/lib/restore-container.ts";
import { deriveHostRole, emitReceipt, gitFacts } from "../../lib/rollout-receipt.ts";
import { runChecks } from "./preflight.ts";
import { TAG_GLOB } from "./release.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// backend/scripts/upgrades/0.2.2-to-0.3.0/ -> <repo root>
const repoRoot = join(scriptDir, "..", "..", "..", "..");

const NAME = "restore-check-0.3.0";
const log = (msg: string) => console.log(`[${NAME}] ${msg}`);
const err = (msg: string) => console.error(`[${NAME}] ${msg}`);

async function run(backupDirArg?: string): Promise<number> {
  const backup = resolveBackupFiles(backupDirArg);
  if ("error" in backup) {
    err(backup.error);
    return 2;
  }

  const restored = await restoreBackupIntoContainer(backup, log);
  if ("error" in restored) {
    err(restored.error);
    if (restored.container) teardownContainer(restored.container, log);
    return 2;
  }

  try {
    log("verification queries");
    const db = postgres({
      host: restored.host,
      port: restored.port,
      username: restored.username,
      password: restored.password,
      database: restored.database,
      max: 1,
    });
    try {
      const counts = (await db`
        SELECT 'swarm_members' t, count(*) FROM swarm_members
        UNION ALL SELECT 'swarm_recommendations', count(*) FROM swarm_recommendations
        UNION ALL SELECT 'swarm_sessions', count(*) FROM swarm_sessions
        UNION ALL SELECT 'admin_credential', count(*) FROM admin_credential
        UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations
        UNION ALL SELECT 'wallet_balance_samples', count(*) FROM wallet_balance_samples
        UNION ALL SELECT 'job_schedules', count(*) FROM job_schedules
      `) as unknown as { t: string; count: string }[];
      for (const row of counts) log(`  ${row.t}: ${row.count}`);

      // The handle/id namespace invariant. For v0.2.2 this had to tolerate a
      // pre-0030 backup, where swarm_members.handle did not exist yet. That
      // case is gone: any dump taken from a v0.2.2 production database is
      // post-0030 by definition, so an absent column here means the dump is
      // NOT from the database this upgrade claims to be upgrading.
      if (!(await columnExists(db, "swarm_members", "handle"))) {
        err("swarm_members.handle is absent in the restored dump — this backup predates migration 0030,");
        err("so it did not come from a v0.2.2 database. The upgrade's premise does not hold for this dump.");
        return 1;
      }
      const violations = (await db.unsafe(
        `SELECT a.id AS holder, a.handle AS handle, b.id AS shadowed
         FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id`,
      )) as unknown as { holder: string; handle: string; shadowed: string }[];
      if (violations.length > 0) {
        err(`${violations.length} handle/id namespace violation(s) in the restored copy`);
        return 1;
      }
      log("  namespace invariant: 0 rows");

      log("");
      log("running this release's preflight checks against the restored dump");
      const checker = createChecker(`[${NAME}] `);
      await runChecks(db, checker);
      const preflightCode = printVerdict(checker.results, {
        logPrefix: `[${NAME}] `,
        okAll: `[${NAME}] VERDICT: DUMP SAFE TO UPGRADE`,
        okWithWarnings: `[${NAME}] VERDICT: DUMP SAFE TO UPGRADE`,
        blocked: `[${NAME}] VERDICT: DUMP BLOCKED`,
      });
      if (preflightCode !== 0) {
        err("a preflight check failed against the restored dump — do not proceed to the live replica until this is clean");
        return 1;
      }
    } finally {
      await db.end({ timeout: 5 });
    }

    log("restore verified and dump-based preflight is clean — safe to proceed to the live replica check");
    return 0;
  } finally {
    teardownContainer(restored.container, log);
  }
}

/**
 * Wraps run() so a receipt is written on every exit path — Gate C's verdict is
 * exactly the thing a later session needs and cannot reconstruct. The receipt
 * names the DUMP's artifacts, not a database: what Gate C certifies is that
 * THIS dump restores and passes preflight, so if the dump is replaced the
 * evidence must die with it (where.ts re-hashes both files).
 */
async function main(backupDirArg?: string): Promise<number> {
  const startedAt = new Date().toISOString();
  // Before the run: a restore + full preflight takes minutes.
  const git = gitFacts(repoRoot, TAG_GLOB);
  const code = await run(backupDirArg);
  if (process.argv.includes("--emit-receipt")) {
    const backup = resolveBackupFiles(backupDirArg);
    const { path } = emitReceipt({
      step: "P3.gate-c",
      exit: code,
      verdict: code === 0 ? "DUMP SAFE TO UPGRADE" : code === 1 ? "DUMP BLOCKED" : "COULD NOT RUN",
      startedAt,
      repoRoot,
      tagGlob: TAG_GLOB,
      hostRole: deriveHostRole(repoRoot).role,
      git,
      backupDir: backupDirArg,
      artifactPaths: "error" in backup ? [] : [backup.dumpEnc, backup.globalsEnc],
      note: "error" in backup ? backup.error : `stamp=${backup.stamp}`,
    });
    log(`receipt \u2192 ${path}`);
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      err(`fatal: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 2;
    });
}
