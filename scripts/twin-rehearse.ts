// `bun run twin:rehearse` — the digital-twin rehearsal, in one command.
//
// ⛔ RUN THIS ON THE DEDICATED STAGING HOST, NEVER THE PRODUCTION API HOST.
//
// Thin entrypoint. Everything it does lives in scripts/lib/twin-rehearsal.ts,
// which is version-agnostic on purpose: a per-release runbook names this command
// rather than describing how to assemble one.
//
// Usage:
//   bun run twin:rehearse                      # ~/rm-backup-v022, the default
//   bun run twin:rehearse -- --backup-dir DIR
//
// Exit codes: 0 = migrated and booted clean, frontend checks pass;
// 1 = the boot or a check failed; 2 = could not run.
import { runTwinRehearsal } from "./lib/twin-rehearsal.ts";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--backup-dir");
  const backupDir = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && !backupDir) {
    console.error("[twin:rehearse] --backup-dir requires a value.");
    process.exit(2);
  }
  process.exitCode = await runTwinRehearsal({ name: "twin-rehearse", backupDir });
}
