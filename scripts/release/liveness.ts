// scripts/release/liveness.ts — a stage run never sits dead unreported (issue
// 1555; policy section 4.4.1).
//
// runRelease (./run.ts) calls into this module with one-line hooks:
//   - `stopRecorder` records how each invocation of a stage run ended
//     (`stopReason` in run.json, or `<root>/stage/refused-<ts>.json` when no
//     journal exists) and calls the notifier exactly once;
//   - `heartbeat` writes `heartbeatAt` and `driver` into run.json every 60 s
//     while a step runs, so the supervisor (./supervise.ts) sees a dead driver;
//   - `labelRefusal` refuses a new stage run unless exactly one open issue
//     carries the `release:<release>` label, where its notifications go.
// Production gets none of it: every hook is a no-op unless the target is stage.
import { hostname } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { firstNotOk, readJournal, runStamp, writeJournal, type RunJournal, type StopKind, type StopReason } from "./journal.ts";
import { findReleaseIssue, releaseLabel, type NotifyResult, type StopEvent } from "./notify.ts";
import { shellQuote } from "./steps.ts";
import type { RunnerDeps } from "./step-exec.ts";
import type { ReleaseTarget } from "./target.ts";

/** How often a running step's heartbeat is written. */
export const HEARTBEAT_MS = 60_000;

/** The exit code's stop kind: 0 passed, 2 refused, 3 paused, anything else failed. */
export function stopKindOf(code: number): StopKind {
  return code === 0 ? "passed" : code === 2 ? "refused" : code === 3 ? "paused" : "failed";
}

export interface StopNote {
  step?: string;
  detail?: string;
  resume?: string;
  pausedUntil?: string;
}

/**
 * The stop recorder for one invocation. `deps` is the runner's deps with
 * `error` wrapped, so a refusal's message is the stop's detail. Nothing is
 * recorded or notified until `watch` names a stage target.
 */
export function stopRecorder(argv: readonly string[], base: RunnerDeps) {
  let lastError: string | undefined;
  let ctx: { target: ReleaseTarget; root: string } | undefined;
  let runDir: string | undefined;
  let note: StopNote = {};
  const deps: RunnerDeps = { ...base, error: (line) => { lastError = line; base.error(line); } };
  const stage = () => ctx?.target.rmEnv === "stage";

  async function send(e: Omit<StopEvent, "release" | "target">): Promise<NotifyResult> {
    try {
      return await base.notify({ release: ctx!.target.release, target: ctx!.target.name, ...e });
    } catch (error) {
      return { notified: false, reason: `notify threw: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return {
    deps,
    /** This invocation is a run of `target`: from here on its stop is recorded (stage only). */
    watch(target: ReleaseTarget, root: string): void { ctx = { target, root }; },
    /** The run's journal directory, once it is this run's. */
    at(dir: string): void { runDir = dir; },
    /** The run starts or resumes: clear the last invocation's stop, so a stop recorded later is this one's. */
    begin(dir: string, journal: RunJournal): void {
      runDir = dir;
      if (!stage()) return;
      delete journal.stopReason;
      delete journal.pausedUntil;
    },
    note(n: StopNote): void { note = { ...note, ...n }; },
    /** A step failed on a human-only cause: one `blocked` notification, now. */
    async blocked(step: string, detail: string, resume: string): Promise<void> {
      if (!stage()) return;
      const runTs = runDir === undefined ? undefined : readJournal(runDir)?.runTs;
      await send({ runTs, kind: "blocked", step, detail, resume, at: base.now().toISOString() });
    },
    /** Start a step's heartbeat; the returned function stops it. */
    heartbeat(journal: RunJournal): () => void {
      if (!stage() || runDir === undefined) return () => {};
      const dir = runDir;
      const beat = () => {
        journal.heartbeatAt = base.now().toISOString();
        journal.driver = { pid: process.pid, host: hostname() };
        writeJournal(dir, journal);
      };
      beat();
      if (base.every) return base.every(HEARTBEAT_MS, beat);
      const timer = setInterval(beat, HEARTBEAT_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    /** Record the stop and notify once. Returns the exit code unchanged. */
    async finish(code: number): Promise<number> {
      if (!stage()) return code;
      const kind = stopKindOf(code);
      const at = base.now().toISOString();
      const reason: StopReason = {
        kind, ...(note.step === undefined ? {} : { step: note.step }),
        detail: note.detail ?? lastError ?? `exit ${code}`,
        resume: note.resume ?? ["bun", "run", "release:run", ...argv.map(shellQuote)].join(" "),
        at,
      };
      const journal = runDir === undefined ? undefined : readJournal(runDir);
      const write = () => {
        if (journal !== undefined) {
          journal.stopReason = reason;
          if (note.pausedUntil !== undefined) journal.pausedUntil = note.pausedUntil;
          writeJournal(runDir!, journal);
        } else {
          const dir = join(ctx!.root, ctx!.target.name);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          writeFileSync(join(dir, `refused-${runStamp(base.now())}.json`), `${JSON.stringify(reason, null, 2)}\n`, { mode: 0o600 });
        }
      };
      try {
        // Written before the notifier runs, so a hung gh still leaves the stop on disk.
        write();
        const result = await send({ runTs: journal?.runTs, kind, step: reason.step, detail: reason.detail, resume: reason.resume, at });
        reason.notified = result.notified;
        if (!result.notified) reason.notifiedReason = result.reason;
        write();
      } catch (error) {
        base.error(`[release:run] could not record the stop: ${error instanceof Error ? error.message : String(error)}`);
      }
      return code;
    },
  };
}

/** The end of a run: which step, what happened, and the command that continues it. */
export function endNote(
  journal: Pick<RunJournal, "steps" | "status" | "release" | "commit">, ids: readonly string[], failedSteps: readonly string[],
  last: string | undefined, resume: (stepId: string) => string,
): StopNote {
  if (journal.status === "passed") {
    return { step: last, detail: "the run passed every step", resume: `bun scripts/release/tag.ts rc --release ${journal.release} --commit ${journal.commit}` };
  }
  const step = failedSteps[0] ?? firstNotOk(journal, ids);
  const detail = failedSteps.length > 0 ? `${failedSteps.length} step(s) failed: ${failedSteps.join(", ")}` : `the run is ${journal.status}`;
  return { step, detail, ...(step === undefined ? {} : { resume: resume(step) }) };
}

/** A new stage run's refusal when its notifications would have nowhere to go, or undefined. */
export async function labelRefusal(target: ReleaseTarget, runDir: string, deps: Pick<RunnerDeps, "collect">): Promise<string | undefined> {
  if (target.rmEnv !== "stage" || readJournal(runDir) !== undefined) return undefined;
  const found = await findReleaseIssue(target.release, deps);
  if ("issue" in found) return undefined;
  return `a new stage run needs exactly one open tracking issue labelled ${releaseLabel(target.release)} for its notifications (policy section 6): ${found.reason}`;
}
