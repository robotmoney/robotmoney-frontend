// ⛔ RUN THIS ON THE DEDICATED STAGING HOST, NEVER THE PRODUCTION API HOST.
//
// Does the v0.2.2 BACKUP restore, and would this release's preflight pass
// against it? A fast, SQL-only check — no app boot, no image build. The heavy
// counterpart is the twin rehearsal (`bun run twin:rehearse`), which boots the
// real stack against the same restored copy.
//
// The restore mechanics — resolve the backup files, start a throwaway Postgres,
// load globals, pg_restore, open a connection, tear both down on every path —
// are NOT here any more. They live in scripts/lib/restore-container.ts's
// withTwinContainer() and backend/scripts/lib/twin-session.ts's
// withTwinDatabase(), because every release's version of this script does the
// identical five things around its own queries, and the failure-path teardown is
// the part that must not be re-derived: a checker returning early from the
// middle of its own try block is how a container holding a copy of production
// gets left behind.
//
// What remains below is exactly the part that IS specific to 0.2.2: which tables
// to count, the handle/id namespace invariant migration 0030 introduces, and
// this release's own preflight checks.
//
// Usage:
//   bun scripts/upgrades/0.2.1-to-0.2.2/restore-check.ts [backupDir]
//
// Expects, in backupDir (default ~/rm-backup-v022):
//   .last-stamp                        the stamp §5.1 wrote
//   rm-preupgrade-<STAMP>.dump.gpg     §5.1/§5.2's encrypted pg_dump
//   rm-globals-<STAMP>.sql.gpg         §5.1/§5.2's encrypted pg_dumpall --globals-only
//   .backup-passphrase                 §5.2's generated passphrase
//
// Exit codes: 0 = restored and this release's preflight is clean;
// 1 = a verification query or preflight check FAILED; 2 = could not run.
import { columnExists, createChecker, printVerdict } from "../../lib/checks.ts";
import { withTwinDatabase } from "../../lib/twin-session.ts";
import { runChecks } from "./preflight.ts";

const NAME = "restore-check-0.2.2";
const log = (msg: string) => console.log(`[${NAME}] ${msg}`);
const err = (msg: string) => console.error(`[${NAME}] ${msg}`);

async function main(backupDirArg?: string): Promise<number> {
  const result = await withTwinDatabase({ backupDir: backupDirArg, log }, async (db) => {
    log("verification queries");
    const counts = (await db`
      SELECT 'swarm_members' t, count(*) FROM swarm_members
      UNION ALL SELECT 'swarm_recommendations', count(*) FROM swarm_recommendations
      UNION ALL SELECT 'swarm_sessions', count(*) FROM swarm_sessions
      UNION ALL SELECT 'admin_credential', count(*) FROM admin_credential
      UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations
    `) as unknown as { t: string; count: string }[];
    for (const row of counts) log(`  ${row.t}: ${row.count}`);

    // §5.3's namespace invariant — same pre-0030 landmine as §8's checks
    // 4/6/7/9: swarm_members.handle does not exist until migration 0030
    // applies, so check column existence first (docs/runbooks/*.md §5.3).
    if (await columnExists(db, "swarm_members", "handle")) {
      const violations = (await db.unsafe(
        `SELECT a.id AS holder, a.handle AS handle, b.id AS shadowed
         FROM swarm_members a JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id`,
      )) as unknown as { holder: string; handle: string; shadowed: string }[];
      if (violations.length > 0) {
        err(`${violations.length} handle/id namespace violation(s) in the restored copy`);
        return 1;
      }
      log("  namespace invariant: 0 rows (post-0030 backup, clean)");
    } else {
      log("  swarm_members.handle absent — this backup predates migration 0030 (expected pre-upgrade)");
    }

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
      err("a preflight check failed against the restored dump — do not proceed to the live replica (§4) until this is clean");
      return 1;
    }

    log("restore verified and dump-based preflight is clean — safe to proceed to §4's live replica check");
    return 0;
  });

  if (typeof result === "number") return result;
  err(result.error);
  return result.code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2])
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      err(`fatal: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 2;
    });
}
