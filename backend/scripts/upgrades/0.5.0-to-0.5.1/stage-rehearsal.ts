// Digital-smoke-twin rehearsal for the v0.5.0 -> v0.5.1 rollout.
//
// WHAT A CODE-ONLY RELEASE ACTUALLY NEEDS REHEARSED. v0.5.1 applies no
// migration, so the usual headline — "the migration ran for real against
// production-shaped data" — is not this rehearsal's point. Its point is the
// half that rollout-procedure.md §6 says restore-check can never cover: that
// THIS code boots against production-shaped rows and serves them. The v0.5.1
// delta is swarm session lifecycle, API pool timeouts and the judge-job wait,
// which are precisely the failures a static schema check cannot see and only a
// real boot on a funded key surfaces.
//
// The driver (scripts/lib/smoke-twin-rehearsal.ts) owns G1-G7; this file fills
// G8's onReady window with the release's own grading.
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, printVerdict } from "../../lib/checks.ts";
import { runSmokeTwinRehearsal } from "../../../../scripts/lib/smoke-twin-rehearsal.ts";
import { runClosedDayAllocationCheck } from "./closed-day-allocation.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const backupDir = process.argv.find((arg) => !arg.startsWith("-") && arg !== process.argv[0] && arg !== process.argv[1]);
const emit = process.argv.includes("--emit-receipt");

const code = await runSmokeTwinRehearsal({
  name: "stage-rehearsal-0.5.1",
  backupDir,
  onReady: async ({ databaseUrl }) => {
    const proc = Bun.spawn(
      ["bun", "backend/scripts/upgrades/0.5.0-to-0.5.1/postflight.ts", ...(emit ? ["--emit-receipt=P5.rehearsal"] : [])],
      { cwd: repoRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, stdout: "inherit", stderr: "inherit" },
    );
    const postflightCode = await proc.exited;
    if (postflightCode !== 0) return postflightCode;

    // Carried over from v0.5.0 deliberately. D41's closed-day read path is
    // v0.5.0's change, not v0.5.1's — but v0.5.1 ships new code on both sides
    // of that read, and "we did not touch the price path" is a claim worth
    // checking rather than asserting. Both sides remain computable in the
    // migrated twin (0046 leaves the fused columns in place).
    const db = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const checker = createChecker("[closed-day-allocation] ");
      await runClosedDayAllocationCheck(db, checker);
      return printVerdict(checker.results, {
        logPrefix: "[closed-day-allocation] ",
        okAll: "CLOSED-DAY ALLOCATION UNCHANGED",
        okWithWarnings: "CLOSED-DAY ALLOCATION UNCHANGED",
        blocked: "CLOSED-DAY ALLOCATION MOVED",
      });
    } finally {
      await db.end({ timeout: 5 });
    }
  },
});
process.exitCode = code;
