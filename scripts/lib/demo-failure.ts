// The startup-FAILURE half of the demo boot: what a failed boot must STOP, how
// it recovers a cause out of the log file, and how that cause is painted.
//
// Every one of those is a DECISION, not I/O, so it lives here and is executed
// directly by scripts/tests/unit/demo-failure.test.ts rather than grepped out
// of scripts/lib/demo-main.ts — the same split issue #456 and #537 already
// applied to the TUI view and the smoke plan. demo-main.ts keeps only the
// wiring: running `docker compose stop`, and reading the log file off disk.
import { color, hr, truncate } from "./tui.ts";
import type { FatalState, WriterQuiesce } from "./demo-tui-view.ts";

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
 * demo:down and demo:clean only ever touch containers and volumes, of which an
 * external boot has none.
 *
 * STOPPED, not removed: `docker compose logs` and `demo:status` must still
 * work, which is the whole reason a failed boot is left up at all.
 */
export const DB_WRITER_SERVICES: readonly string[] = Object.freeze([
  "api",
  "analytics-producer",
  "worker-swarm",
  "worker-analytics",
  "worker-research",
]);

/**
 * One line stating, plainly, whether the database is still being written to.
 *
 * The operator's next decision depends on this more than on the error text, so
 * it is never implied — a failed quiesce says so in as many words, because the
 * writes it could not stop are the ones no teardown can roll back.
 */
export function writerQuiesceLine(w: WriterQuiesce): string {
  switch (w) {
    case "stopped": return `${color("32", "✓")} database writers stopped — nothing is still writing`;
    case "pending": return `${color("33", "…")} stopping database writers…`;
    case "none": return `${color("2", "·")} no database writers were running`;
    case "failed": return color("1;31", "! could NOT stop the database writers — they may STILL be writing; run `bun run demo:down`");
  }
}

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
 * anchored instead on the demo's own trailing "startup failed" line and showed
 * the operator a restatement of the exit code rather than the reason.
 */
const CULPRIT = /inconsistenc|\bWARN\b|\bERROR\b|\bFAIL|\bREFUS|\bABORT|drifted=[1-9]/i;
const MAX_DETAIL_LINES = 6;

/**
 * Recover the lines that explain a failure from the boot log.
 *
 * The child processes a boot runs (migrate, the seeds, the archive
 * initializer) write their real output to the LOG FILE, never to the
 * orchestrator — so the only error demo-main can raise is the exit code that
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

/**
 * The failure pane.
 *
 * The boot is over, but the TUI stays up and keeps painting this, so the cause
 * is readable on the screen that was already showing the run — rather than
 * printed to a terminal the process just abandoned. Rendered directly under the
 * Startup pane so the ✗ step above and the reason here read together.
 */
export function renderFailurePane(fatal: FatalState, width: number, project: string): string[] {
  const out = [hr(width, "STARTUP FAILED")];
  const where = fatal.step ? `${fatal.step}: ` : "";
  out.push(truncate(`  ${color("1;31", "✗")} ${color("1", where)}${fatal.message}`, width));
  for (const d of fatal.detail) out.push(truncate(color("2", `      ${d}`), width));
  out.push(truncate(`  ${writerQuiesceLine(fatal.writers)}`, width));
  out.push(truncate(color("2", `  inspect: bun run demo:status   ·   logs: docker compose -p ${project} logs -f`), width));
  return out;
}
