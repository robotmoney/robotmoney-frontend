// ⛔ RUN THIS ON THE DEDICATED STAGING HOST, NEVER THE PRODUCTION API HOST.
// This does a real Docker image build plus a full app boot — genuine compute
// and disk load that a machine serving live production traffic cannot spare
// (docs/runbooks/rollout-procedure.md §4, added after exactly this mistake).
//
// The v0.3.0 entry point for the heavy rehearsal, and the step that emits
// P5.rehearsal-boot. What it grades: the Gate C backup restores, this release's
// migrations run FOR REAL against production-shaped data, the site serves, and
// this release's own postflight is clean against the migrated twin.
//
// THE DRIVER IS NOT HERE ANY MORE. Restore, boot, readiness, the supervision
// rule and the teardown order live in scripts/lib/twin-rehearsal.ts, because
// none of that was ever specific to a release: it is what "boot a twin and
// check it" means. Sitting in a release directory only meant `main` — already
// past v0.2.2 — had no twin entry point at all, which is now `bun run
// twin:rehearse`. v0.2.1-to-0.2.2's copy is left exactly as it executed; a
// shipped release directory is the record of what that release actually
// checked, and rewriting it would destroy that.
//
// THE ISOLATED WORKTREE IS GONE. This used to `git worktree add` a throwaway
// checkout, symlink node_modules into it and write a throwaway `.env`, for one
// reason: `--external-pg` read DATABASE_URL from the repo-root `.env`, and
// overwriting that on a staging host risks corrupting a real credential. The
// boot is now `--db twin`, which builds its URL in-process and writes no file,
// so the apparatus is unnecessary — and demo-twin.ts's assertTwinIsTarget()
// proves the property it was insurance for.
//
// G8 IS STILL HERE, as the onReady hook. §6.1 step 3 requires this release's
// postflight to run against the migrated twin, and §6.4 mandates it happen
// after readiness — but the twin lives only for the duration of the rehearsal,
// so a "run postflight afterwards" instruction races teardown from a second
// terminal. The hook is that window, made part of the contract.
//
// This is deliberately NOT run by restore-check.ts or on every preflight — it
// is much slower (image build/pull, migration, seed, health-wait: several
// minutes) and heavier than the SQL-only checks. Run it as the final confidence
// pass before cutover.
//
// Usage:
//   bun scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal.ts [backupDir] [--emit-receipt]
//
// Exit codes: 0 = migrated and booted clean, frontend checks pass, and
// postflight is clean against the twin; 1 = the boot, a frontend check or the
// twin postflight failed; 2 = could not run (missing files, docker failure).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBackupFiles } from "../../../../scripts/lib/restore-container.ts";
import { runTwinRehearsal } from "../../../../scripts/lib/twin-rehearsal.ts";
import { deriveHostRole, emitReceipt, gitFacts } from "../../lib/rollout-receipt.ts";
import { TAG_GLOB } from "./release.ts";

const NAME = "stage-rehearsal-0.3.0";
const log = (msg: string) => console.log(`[${NAME}] ${msg}`);

const scriptDir = dirname(fileURLToPath(import.meta.url));
// backend/scripts/upgrades/0.2.2-to-0.3.0/ -> <repo root>
const repoRoot = join(scriptDir, "..", "..", "..", "..");

async function run(backupDirArg?: string): Promise<number> {
  return runTwinRehearsal({
    name: NAME,
    backupDir: backupDirArg,
    // §6.1 step 3 / G8 — this release's postflight, inside the twin's window.
    onReady: async ({ backendUrl, databaseUrl, log: rlog, err: rerr }) => {
      rlog("running this release's postflight checks against the migrated twin (§6.1 step 3)");
      const proc = Bun.spawn(
        [
          "bun",
          "scripts/upgrades/0.2.2-to-0.3.0/postflight.ts",
          `--base-url=${backendUrl}`,
          "--emit-receipt=P5.postflight-twin",
          ...(backupDirArg ? [`--backup-dir=${backupDirArg}`] : []),
        ],
        {
          // The real checkout, so the receipt's git provenance names the branch
          // this rehearsal actually ran, not a detached HEAD.
          cwd: join(repoRoot, "backend"),
          env: { ...process.env, DATABASE_URL: databaseUrl },
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
        },
      );
      const code = await proc.exited;
      if (code !== 0) {
        rerr("postflight FAILED against the migrated twin — §6.4: treat this exactly as a failed production");
        rerr("cutover. Diagnose, patch, cut the next rc, re-rehearse. Do not carry it into the cutover.");
      }
      return code;
    },
  });
}

/**
 * Receipt wrapper. This step's evidence is bound to APP code (steps.ts's
 * APP_CODE globs), not to the gate scripts — which is why a commit that changes
 * preflight.ts invalidates Gate C while leaving a boot rehearsal standing. That
 * distinction is the whole reason receipts record a SHA.
 */
async function main(backupDirArg?: string): Promise<number> {
  const startedAt = new Date().toISOString();
  // Read the git facts BEFORE the run: it takes minutes and boots the tree as
  // it stands HERE. A receipt stamped with a SHA committed halfway through
  // would name a commit the rehearsal never rehearsed.
  const git = gitFacts(repoRoot, TAG_GLOB);
  const code = await run(backupDirArg);
  if (process.argv.includes("--emit-receipt")) {
    const backup = resolveBackupFiles(backupDirArg);
    const { path } = emitReceipt({
      step: "P5.rehearsal-boot",
      exit: code,
      verdict:
        code === 0 ? "migrated and booted clean, frontend checks pass" : code === 1 ? "REHEARSAL FAILED" : "COULD NOT RUN",
      startedAt,
      repoRoot,
      tagGlob: TAG_GLOB,
      hostRole: deriveHostRole(repoRoot).role,
      git,
      backupDir: backupDirArg,
      artifactPaths: "error" in backup ? [] : [backup.dumpEnc, backup.globalsEnc],
      note: "error" in backup ? backup.error : `stamp=${backup.stamp}`,
    });
    log(`receipt → ${path}`);
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`[${NAME}] fatal: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 2;
    });
}
