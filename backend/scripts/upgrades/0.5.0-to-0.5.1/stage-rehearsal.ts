// Digital-smoke-twin rehearsal for the v0.5.0 -> v0.5.1 rollout.
//
// WHAT A CODE-ONLY RELEASE ACTUALLY NEEDS REHEARSED. v0.5.1 applies no
// migration, so the usual headline -- "the migration ran for real against
// production-shaped data" -- is not this rehearsal's point, and every schema
// check it has is necessarily green before the release does anything. Its
// point is the half rollout-procedure.md §6 says restore-check can never
// cover: that THIS code boots against production-shaped rows, heals what the
// old code wedged, and keeps working afterwards.
//
// ONE CONNECTION, ONE VERDICT, ONE RECEIPT. The schema checks, the four
// functional acceptance criteria and the closed-day price check all run
// through a single runPostflightMain() call, so the P5.rehearsal receipt's
// check summary covers ALL of them. This is deliberate and was not the
// obvious shape: the previous release spawned postflight.ts as a subprocess
// with its own --emit-receipt, which writes a receipt recording the schema
// half at the moment it finishes -- i.e. BEFORE the functional criteria have
// run. A receipt that says P5 passed while the checks that could fail it are
// still running is worse than no receipt, so the spawn is gone and the
// criteria are folded into the graded run.
//
// The driver (scripts/lib/smoke-twin-rehearsal.ts) owns G1-G7; this file fills
// G8's onReady window.
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPostflightMain } from "../../lib/postflight-utils.ts";
import { runSmokeTwinRehearsal } from "../../../../scripts/lib/smoke-twin-rehearsal.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import { runChecks as runSchemaChecks } from "./postflight.ts";
import { runFunctionalRehearsal } from "./functional-rehearsal.ts";
import { runClosedDayAllocationCheck } from "./closed-day-allocation.ts";
import { TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const backupDir = process.argv.find((arg) => !arg.startsWith("-") && arg !== process.argv[0] && arg !== process.argv[1]);
const emit = process.argv.includes("--emit-receipt");

/** Ceiling on the four functional criteria. Must leave the driver's own
 *  checkDeadlineMs room for the schema and price checks that follow, or a slow
 *  observation would be reported as "the release's checks did not finish"
 *  rather than as the criterion that actually failed. */
const FUNCTIONAL_DEADLINE_MS = 30 * 60 * 1000;
const CHECK_DEADLINE_MS = 40 * 60 * 1000;

const code = await runSmokeTwinRehearsal({
  name: "stage-rehearsal-0.5.1",
  backupDir,
  checkDeadlineMs: CHECK_DEADLINE_MS,
  onReady: async ({ databaseUrl, log }) => {
    // runPostflightMain reads DATABASE_URL from the environment. Set it for
    // this process only -- never written to a file (G7).
    process.env.DATABASE_URL = databaseUrl;
    return runPostflightMain({
      name: "rehearsal-0.5.1",
      receipt: emit
        ? { step: "P5.rehearsal", repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role }
        : undefined,
      runChecks: async (db, checker) => {
        // 1. The schema half -- shared with the production postflight, so the
        //    twin is graded by exactly the checks production will be.
        await runSchemaChecks(db, checker);

        // 2. THE FOUR FUNCTIONAL ACCEPTANCE CRITERIA. These are what v0.5.1
        //    actually claims, and none of them is a fact about a row's
        //    existence -- each is a fact about the system's movement, only
        //    observable by watching a live stack. See functional-rehearsal.ts.
        log("observing the booted stack for the four functional criteria (wedge healing, closure, new sessions, a judged session)");
        await runFunctionalRehearsal(db, checker, { deadlineMs: FUNCTIONAL_DEADLINE_MS, log });

        // 3. D41's closed-day read path. Carried over from v0.5.0 because
        //    v0.5.1 ships new code on both sides of that read, and "we did not
        //    touch the price path" is a claim worth checking rather than
        //    asserting. Both sides stay computable in the migrated twin (0046
        //    leaves the fused columns in place).
        const priceDb = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
        try {
          await runClosedDayAllocationCheck(priceDb, checker);
        } finally {
          await priceDb.end({ timeout: 5 });
        }
      },
    });
  },
});
process.exitCode = code;
