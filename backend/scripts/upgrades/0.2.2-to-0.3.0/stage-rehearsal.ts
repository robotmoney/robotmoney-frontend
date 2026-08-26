// ⛔ RUN THIS ON THE DEDICATED STAGING HOST, NEVER THE PRODUCTION API HOST.
// This does a real Docker image build plus a full app boot — genuine compute
// and disk load that a machine serving live production traffic cannot spare
// (docs/runbooks/rollout-procedure.md §4, added after exactly this mistake).
//
// The v0.3.0 entry point for the heavy rehearsal, and the step that emits
// P5.rehearsal-boot. What it grades: the Gate C backup restores, this release's
// migrations run FOR REAL against production-shaped data, the site serves, and
// this release's own postflight is clean against the migrated smoke-twin.
//
// THE DRIVER IS NOT HERE ANY MORE. Restore, boot, readiness, the supervision
// rule and the teardown order live in scripts/lib/smoke-twin-rehearsal.ts, because
// none of that was ever specific to a release: it is what "boot a smoke-twin and
// check it" means. Sitting in a release directory only meant `main` — already
// past v0.2.2 — had no smoke-twin entry point at all, which is now `bun run
// smoke:smoke-twin --once`. v0.2.1-to-0.2.2's copy is left exactly as it executed; a
// shipped release directory is the record of what that release actually
// checked, and rewriting it would destroy that.
//
// THE ISOLATED WORKTREE IS GONE. This used to `git worktree add` a throwaway
// checkout, symlink node_modules into it and write a throwaway `.env`, for one
// reason: `--external-pg` read DATABASE_URL from the repo-root `.env`, and
// overwriting that on a staging host risks corrupting a real credential. The
// boot is now `--db smoke-twin`, which builds its URL in-process and writes no file,
// so the apparatus is unnecessary — and smoke-twin.ts's assertSmokeSmokeTwinIsTarget()
// proves the property it was insurance for.
//
// G8 IS STILL HERE, as the onReady hook. §6.1 step 3 requires this release's
// postflight to run against the migrated smoke-twin, and §6.4 mandates it happen
// after readiness — but the smoke-twin lives only for the duration of the rehearsal,
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
// postflight is clean against the smoke-twin; 1 = the boot, a frontend check or the
// smoke-twin postflight failed; 2 = could not run (missing files, docker failure).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBackupFiles } from "../../../../scripts/lib/restore-container.ts";
import { runSmokeSmokeTwinRehearsal } from "../../../../scripts/lib/smoke-twin-rehearsal.ts";
import { connect, type Db } from "../../lib/postflight-utils.ts";
import { cadenceMs, WEDGE_GRACE_MS } from "./postflight.ts";
import { deriveHostRole, emitReceipt, gitFacts } from "../../lib/rollout-receipt.ts";
import { NEW_SCHEDULE_KIND, TAG_GLOB } from "./release.ts";
import { observeRepairDispatch, observeRepairCompletion } from "./repair-observation.ts";

const NAME = "stage-rehearsal-0.3.0";

/** How long check 3/3 may wait for one paced backfill day. Sits inside the
 *  driver's own checkDeadlineMs, which bounds the whole window (G1/G5). */
const COMPLETION_BUDGET_MS = 20 * 60 * 1000;
const log = (msg: string) => console.log(`[${NAME}] ${msg}`);

const scriptDir = dirname(fileURLToPath(import.meta.url));
// backend/scripts/upgrades/0.2.2-to-0.3.0/ -> <repo root>
const repoRoot = join(scriptDir, "..", "..", "..", "..");

/**
 * Wait for the restored smoke-twin's schedules to catch up before anything grades
 * them.
 *
 * WHY THIS EXISTS. Every rehearsal of this release so far has died on
 * postflight's `no-wedge` check without ever reaching checks 2 and 3 — the two
 * that actually observe the gap repair. It was read as a wedge. It is not one.
 *
 * A smoke-twin is a RESTORE of a Gate C dump, and the dump's `job_schedules` rows
 * carry whatever `next_run_at` they had when it was taken. Ours was 35 hours
 * old. `no-wedge`'s budget is one cadence plus WEDGE_GRACE_MS, which for the
 * two per-minute samplers is 150s, so a dump older than about two and a half
 * minutes arrives "wedged" by that definition and stays so until the scheduler
 * has ticked the backlog off. Nothing about the release caused it and nothing
 * about the release fixes it; it is the age of the dump.
 *
 * The backlog does drain on its own. #614's CLAMP (7b92a8c, shipped in v0.2.2)
 * advances the cursor on EVERY iteration rather than only when the loop breaks,
 * so a schedule further behind than MAX_SLOTS_PER_TICK drains a fresh batch per
 * tick instead of being pinned forever — which is what it did before that fix,
 * and is the reason this looked like a known defect. And `0034` gives the two
 * per-minute samplers `catchup_policy='collapse-per-bucket'`, so the backlog
 * collapses to one job per UTC day rather than one per minute. It is a wait,
 * not a repair.
 *
 * A TIMEOUT IS NOT SWALLOWED. If the schedules have not caught up inside the
 * budget, this says so and returns anyway, so `no-wedge` runs and FAILs on a
 * smoke-twin that genuinely is wedged. The check keeps its teeth; it just stops
 * firing on the restore's own clock.
 */
async function waitForScheduleDrain(
  db: Db,
  log: (m: string) => void,
  budgetMs = 240_000,
): Promise<"drained" | "timeout"> {
  const deadline = Date.now() + budgetMs;
  let lastReport = "";
  for (;;) {
    const rows = (await db`
      SELECT kind, cron, timezone, next_run_at,
             EXTRACT(EPOCH FROM (now() - next_run_at))::int AS seconds_late
        FROM job_schedules
       WHERE enabled
    `) as unknown as { kind: string; cron: string; timezone: string; next_run_at: Date | null; seconds_late: number | null }[];

    const behind: string[] = [];
    for (const r of rows) {
      // A NULL next_run_at means the scheduler has not ticked for that row yet
      // — on a fresh restore that is "not ready", not "dead". no-wedge grades
      // it as a wedge, so wait for it here too.
      if (r.next_run_at === null) {
        behind.push(`${r.kind} (never ticked)`);
        continue;
      }
      const cadence = cadenceMs(r.cron, r.timezone);
      if (cadence === null) continue; // unparseable: no-wedge reports it, not this
      const late = (r.seconds_late ?? 0) * 1000;
      if (late > cadence + WEDGE_GRACE_MS) behind.push(`${r.kind} ${Math.round(late / 1000)}s late`);
    }

    if (behind.length === 0) {
      log("schedules have caught up with the restore — no enabled schedule is more than one cadence behind");
      return "drained";
    }
    const report = behind.sort().join(", ");
    if (report !== lastReport) {
      log(`waiting for the restored backlog to drain: ${report}`);
      lastReport = report;
    }
    if (Date.now() >= deadline) {
      log(`schedules did NOT catch up within ${Math.round(budgetMs / 1000)}s — still behind: ${report}`);
      log("running postflight anyway: if no-wedge FAILs now, it is reporting a real wedge, not the dump's age.");
      return "timeout";
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function run(backupDirArg?: string): Promise<number> {
  return runSmokeSmokeTwinRehearsal({
    name: NAME,
    backupDir: backupDirArg,
    // §6.1 step 3 / G8 — this release's postflight, inside the smoke-twin's window,
    // followed by §7.1's dispatch observation.
    //
    // ⚠ ORDER IS LOAD-BEARING. postflight's `new-tables` check asserts
    // chain_day_blocks and wallet_backfill_state are present AND EMPTY; the
    // dispatch observation populates both. Run the observation first and
    // postflight's PASS becomes a WARN, with two checks fighting over the same
    // rows and neither of them wrong. postflight first, always.
    //
    // Postflight is the only BLOCKING member of the sequence: §6.4 says a smoke-twin
    // that fails it is a failed cutover, so spending more of a metered window on
    // it is waste. Everything after is graded but non-blocking, because the
    // point of holding one window open is that ONE smoke-twin yields all the evidence
    // — if the observation disappoints you still want it from this boot rather
    // than paying for another restore and image build.
    onReady: async ({ databaseUrl, log: rlog, err: rerr }) => {
      // BEFORE check 1, not inside it: the smoke-twin's schedules arrive as stale as
      // the dump is old, and postflight's no-wedge grades them against a
      // 150s budget. See waitForScheduleDrain.
      const drainDb = connect(databaseUrl, "schedule-drain-0.3.0");
      try {
        await waitForScheduleDrain(drainDb, rlog);
      } finally {
        await drainDb.end({ timeout: 5 });
      }

      rlog("check 1/3 postflight — this release's checks against the migrated smoke-twin (§6.1 step 3)");
      const proc = Bun.spawn(
        [
          "bun",
          "scripts/upgrades/0.2.2-to-0.3.0/postflight.ts",
          // No --base-url: postflight.ts parses only --emit-receipt and
          // --backup-dir, so this was silently discarded. None of v0.3.0's seven
          // checks makes an HTTP call (postflight-utils.ts's fetchCheck has no
          // caller in this release), so there is nothing for it to configure.
          "--emit-receipt=P5.postflight-smoke-twin",
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
        rerr("postflight FAILED against the migrated smoke-twin — §6.4: treat this exactly as a failed production");
        rerr("cutover. Diagnose, patch, cut the next rc, re-rehearse. Do not carry it into the cutover.");
        rerr("checks 2/3 and 3/3 did NOT run. A skipped check is not a passed one; no receipt is emitted for them.");
        return code;
      }

      // ── §7.1 — the dispatch observation ─────────────────────────────────
      const db = connect(databaseUrl, "repair-observation-0.3.0");
      let worst: "PASS" | "WARN" | "FAIL" = "PASS";
      try {
        rlog(`check 2/3 repair-dispatch — ${NEW_SCHEDULE_KIND} fires and dispatches (§7.1)`);
        const dispatch = await observeRepairDispatch(db, rlog);
        for (const line of dispatch.detail) rlog(`  ${line}`);
        rlog(`  [${dispatch.status}] repair-dispatch`);
        if (dispatch.remediation) rlog(`  → ${dispatch.remediation}`);
        if (dispatch.status === "FAIL") worst = "FAIL";
        else if (dispatch.status === "WARN" && worst === "PASS") worst = "WARN";

        // Only worth waiting on a completion if something was actually
        // enqueued. On a clean smoke-twin the dispatch check already said so.
        if (dispatch.status === "PASS") {
          rlog(`check 3/3 repair-completion — one day completes and writes provenance='backfilled' (§7.1)`);
          const completion = await observeRepairCompletion(db, rlog, COMPLETION_BUDGET_MS);
          for (const line of completion.detail) rlog(`  ${line}`);
          rlog(`  [${completion.status}] repair-completion`);
          if (completion.remediation) rlog(`  → ${completion.remediation}`);
          if (completion.status === "WARN" && worst === "PASS") worst = "WARN";
        } else {
          rlog("check 3/3 repair-completion — SKIPPED: nothing was dispatched to complete");
        }
      } finally {
        await db.end({ timeout: 5 });
      }

      if (worst === "FAIL") {
        rerr("§7.1's dispatch observation FAILED — the schedule is seeded but the repair does not dispatch.");
        rerr("That is this release's headline feature shipping inert (§0.3). Do not carry it into the cutover.");
        return 1;
      }
      return 0;
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
