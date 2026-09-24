// The startup-FAILURE half of the smoke boot: what a failed boot must STOP, how
// it recovers a cause out of the log file, and how that cause is painted.
//
// Every one of those is a DECISION, not I/O, so it lives here and is executed
// directly by scripts/tests/unit/smoke-failure.test.ts rather than grepped out
// of scripts/lib/smoke-main.ts — the same split issue #456 and #537 already
// applied to the TUI view and the smoke plan. smoke-main.ts keeps only the
// wiring: running `docker compose stop`, and reading the log file off disk.
//
// NO TUI IMPORT. `bun smoke` imports this module and draws no TUI (smoke spec
// §1), so how a failure is PAINTED — writerQuiesceLine() and
// renderFailurePane() — lives with the rest of the painting, in
// smoke-tui-view.ts. scripts/tests/unit/smoke-tui.test.ts walks the import
// graph and fails if a TUI module comes back through here.

/**
 * Every compose service that WRITES to the database — the set a failed startup
 * must stop before handing the stack back for inspection.
 *
 * `postgres` is deliberately absent: it IS the database, and under
 * --external-pg there is no such container at all — the server is remote and
 * outlives the boot entirely.
 *
 * WHY STOPPING MATTERS. A failed boot used to leave the entire stack running,
 * so the worker lanes went on polling, enqueueing and writing against a
 * database whose initialization had just failed part-way — the longer the
 * operator spent reading the error, the further the data drifted from the state
 * that produced it. Under --external-pg nothing can undo those writes:
 * smoke:down and smoke:clean only ever touch containers and volumes, of which an
 * external boot has none.
 *
 * STOPPED, not removed: `docker compose logs` and `smoke:status` must still
 * work, which is the whole reason a failed boot is left up at all.
 */
export const DB_WRITER_SERVICES: readonly string[] = Object.freeze([
  "api",
  "analytics-producer",
  "worker-analytics",
  "worker-research",
]);
// `system-scheduler` is absent because it writes to no database: it holds one
// API credential and no role password (system-scheduler-spec.md §7), so a
// failed boot that leaves it running leaves nothing drifting. Quiescing the
// `api` above already closes the only channel through which it can change
// state.

/**
 * Lines worth showing: the ones a bootstrap prints when it refuses to proceed.
 *
 * `drifted=` only counts when NON-zero — every seeder prints a "drifted=0" tally
 * on the happy path, and matching that would anchor the excerpt on a line that
 * reports nothing wrong.
 *
 * REFUS/ABORT earn their place from a live miss: the populated-database guard
 * prints "[db-preflight] REFUSING to bootstrap: … already has 55 table(s)" and
 * names the tables underneath, but used none of the other words — so the pane
 * anchored instead on the smoke's own trailing "startup failed" line and showed
 * the operator a restatement of the exit code rather than the reason.
 */
const CULPRIT = /inconsistenc|\bWARN\b|\bERROR\b|\bFAIL|\bREFUS|\bABORT|drifted=[1-9]/i;
const MAX_DETAIL_LINES = 6;

/**
 * Recover the lines that explain a failure from the boot log.
 *
 * The child processes a boot runs (migrate, the seeds, the archive
 * initializer) write their real output to the LOG FILE, never to the
 * orchestrator — so the only error smoke-main can raise is the exit code that
 * came back, e.g. "archive initializer (already migrated) failed (exit 1)".
 * That sentence names no cause. These lines do.
 *
 * Anchors on the FIRST refusal and reads FORWARD from it, rather than
 * collecting matching lines. A refusal is a block, not a line: the header names
 * the count and the indented rows under it name the actual conflicting fields
 * — which is the part an operator needs and the part that matches no keyword.
 * Falls back to the plain tail so an unrecognised failure still shows something.
 */
export function selectFailureDetail(logText: string, logFile: string): string[] {
  const lines = logText.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const tail = lines.slice(-80);
  const first = tail.findIndex((l) => CULPRIT.test(l));
  const picked = first >= 0
    ? tail.slice(first, first + MAX_DETAIL_LINES)
    : tail.slice(-MAX_DETAIL_LINES);
  return [...picked, `full log: ${logFile}`];
}
