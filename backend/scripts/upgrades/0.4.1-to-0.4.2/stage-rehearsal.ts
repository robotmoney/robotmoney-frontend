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
  name: "stage-rehearsal-0.4.2",
  backupDir,
  onReady: async ({ databaseUrl }) => {
    const proc = Bun.spawn(
      ["bun", "backend/scripts/upgrades/0.4.1-to-0.4.2/postflight.ts", ...(emit ? ["--emit-receipt=P5.rehearsal"] : [])],
      { cwd: repoRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, stdout: "inherit", stderr: "inherit" },
    );
    const postflightCode = await proc.exited;
    if (postflightCode !== 0) return postflightCode;

    // Rehearsal criterion #9: a closed-day allocation total must not move
    // when the D41 read path switches. Both sides of the switch are
    // computable in the migrated twin (0046 leaves the fused columns in
    // place), so this runs as a real check instead of an unimplemented
    // criterion — see closed-day-allocation.ts.
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
