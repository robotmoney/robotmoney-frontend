// ⛔ RUN THIS ON THE DEDICATED STAGING HOST, NEVER THE PRODUCTION API HOST.
// This does a real Docker image build plus a full app boot — genuine compute
// and disk load that a machine serving live production traffic cannot spare
// (docs/runbooks/*.md §2, added 2026-08-17 after exactly this mistake).
//
// The v0.2.2 entry point for the digital-twin rehearsal, kept so the committed
// runbook's copy-pasteable command keeps working.
//
// THE DRIVER MOVED. Everything this file used to do now lives in
// scripts/lib/twin-rehearsal.ts, because none of it was ever specific to 0.2.2:
// restore, boot, readiness, the supervision rule and the teardown order are
// properties of "boot a twin and check it". Sitting in a release directory only
// meant `main` had no twin entry point at all. Prefer `bun run twin:rehearse`.
//
// THE ISOLATED WORKTREE IS GONE. This script used to `git worktree add` a
// throwaway checkout, symlink node_modules into it and write a throwaway `.env`,
// for one reason: `--external-pg` read DATABASE_URL from repo-root `.env`, and
// overwriting that on a staging host risks corrupting a real credential. The
// boot is now `--db twin`, which builds its URL in-process and writes no file,
// so the apparatus is unnecessary and demo-twin.ts's assertTwinIsTarget() proves
// the property it was protecting.
//
// Usage:
//   bun scripts/upgrades/0.2.1-to-0.2.2/stage-rehearsal.ts [backupDir]
//
// Exit codes: 0 = migrated and booted clean, frontend checks pass;
// 1 = the boot or a frontend check failed; 2 = could not run.
import { runTwinRehearsal } from "../../../../scripts/lib/twin-rehearsal.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runTwinRehearsal({
    name: "stage-rehearsal-0.2.2",
    backupDir: process.argv[2],
  });
}
