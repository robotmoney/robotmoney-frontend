// scripts/release/journal.ts — the release run's local journal, resume rules
// and the stage-before-prod check (standing check SP.8).
//
// A run journals on the CONTROL MACHINE under
//   ~/.local/state/robotmoney-release/<target>/<run-ts>/
//     run.json                 what ran, against what, and each step's outcome
//     <step>/stdout.log        scrubbed (./scrub.ts)
//     <step>/stderr.log        scrubbed
//     <step>/result.json       exit code, timings, receipts copied back
//     <step>/receipts/…        the receipts, scrubbed when they are text
//
// SP.8. Production refuses to start unless a stage run journal exists that ran
// the SAME step list (same hash) at the SAME commit, and passed every step.
// That is D61 rule 2 as a check: the production run is the run stage rehearsed.
//
// Pure apart from readJournal/writeJournal, so each refusal is a unit test.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type StepStatus = "ok" | "failed" | "running" | "skipped";

/** A step is done when it passed, or when its template skips this policy (`onlyFor`). */
export function stepDone(status: StepStatus | undefined): boolean {
  return status === "ok" || status === "skipped";
}

export interface ReceiptRecord {
  readonly remote: string;
  readonly local?: string;
  readonly missing?: boolean;
}

export interface StepRecord {
  readonly id: string;
  status: StepStatus;
  exit: number | null;
  readonly expectExit: number;
  readonly startedAt: string;
  endedAt?: string;
  durationMs?: number;
  receipts: ReceiptRecord[];
  readonly attempt: number;
  error?: string;
  /** Why a step did not run on this target: `stage` for a prod-only step. */
  skipped?: string;
  /** A baseline gate's failures accepted by the owner's triage file (R2.5). */
  triage?: { file: string; sha256: string; used: { check: string; fragment: string; reason: string }[] };
}

export interface RunJournal {
  readonly version: 1;
  readonly target: string;
  readonly rmEnv: "stage" | "prod";
  readonly release: string;
  readonly commit: string;
  readonly stepListHash: string;
  readonly stepIds: readonly string[];
  readonly goSha256: string;
  readonly runTs: string;
  readonly startedAt: string;
  updatedAt: string;
  status: "running" | "failed" | "passed" | "incomplete";
  steps: Record<string, StepRecord>;
  /** The stage journal production checked (SP.8), for the record. */
  stageJournal?: { path: string; runTs: string; stepListHash: string; commit: string };
  /** The signed recovery matrix the go names (SC.1): its reference and, for a file, its sha256. */
  recovery?: { ref: string; sha256: string | null };
}

/** `~/.local/state/robotmoney-release`, on the control machine. */
export function journalRoot(home: string = homedir()): string {
  return join(home, ".local", "state", "robotmoney-release");
}

/** A run stamp: `20261008T142233Z`. */
export function runStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export const RUN_TS_RE = /^\d{8}T\d{6}Z$/;

/** passed when every step of the list is ok; failed when the latest attempt of any step failed. */
export function runStatus(journal: Pick<RunJournal, "steps">, ids: readonly string[]): RunJournal["status"] {
  if (ids.some((id) => journal.steps[id]?.status === "failed")) return "failed";
  if (ids.some((id) => journal.steps[id]?.status === "running")) return "running";
  return ids.every((id) => stepDone(journal.steps[id]?.status)) ? "passed" : "incomplete";
}

/**
 * SP.8: may production start? Every reason it may not, empty when it may.
 * `journal` is undefined when the file could not be read.
 */
export function checkStageJournal(
  journal: RunJournal | undefined,
  expected: { stepListHash: string; commit: string; stepIds: readonly string[] },
): string[] {
  if (journal === undefined) return ["SP.8: no stage run journal was found; production runs only what stage passed (pass --stage-journal <run dir>)"];
  const out: string[] = [];
  if (journal.rmEnv !== "stage") out.push(`SP.8: the journal is a ${journal.rmEnv} run, not a stage run`);
  if (journal.stepListHash !== expected.stepListHash) {
    out.push(`SP.8: the stage run used step list ${journal.stepListHash.slice(0, 12)}; this run is ${expected.stepListHash.slice(0, 12)}`);
  }
  if (journal.commit !== expected.commit) out.push(`SP.8: the stage run was at commit ${journal.commit}; this run is ${expected.commit}`);
  const status = runStatus(journal, expected.stepIds);
  if (status !== "passed") {
    const notOk = expected.stepIds.filter((id) => !stepDone(journal.steps[id]?.status));
    out.push(`SP.8: the stage run did not pass (${status}; not ok: ${notOk.join(", ")})`);
  }
  return out;
}

/** Which steps to run, in order. */
export function selectSteps(ids: readonly string[], opts: { from?: string; only?: string }): string[] {
  if (opts.from !== undefined && opts.only !== undefined) throw new Error("--from and --only cannot be combined");
  if (opts.only !== undefined) {
    if (!ids.includes(opts.only)) throw new Error(`--only ${opts.only}: no such step (steps: ${ids.join(", ")})`);
    return [opts.only];
  }
  if (opts.from !== undefined) {
    const at = ids.indexOf(opts.from);
    if (at < 0) throw new Error(`--from ${opts.from}: no such step (steps: ${ids.join(", ")})`);
    return ids.slice(at);
  }
  return [...ids];
}

/**
 * May this run continue in an existing journal? A resume runs the same list,
 * at the same commit, for the same target, under the same go, and starts no
 * later than the first step that is not ok.
 */
export function checkResume(
  journal: RunJournal,
  expected: { target: string; commit: string; stepListHash: string; goSha256: string; stepIds: readonly string[] },
  opts: { from?: string; only?: string },
): string[] {
  const out: string[] = [];
  if (journal.target !== expected.target) out.push(`the journal is for target ${journal.target}, not ${expected.target}`);
  if (journal.commit !== expected.commit) out.push(`the journal ran commit ${journal.commit}; this run is ${expected.commit}`);
  if (journal.stepListHash !== expected.stepListHash) out.push("the journal ran a different step list; start a new run");
  if (journal.goSha256 !== expected.goSha256) out.push("the journal ran under a different go file; a resume presents the same go");
  const start = opts.only ?? opts.from;
  if (start !== undefined) {
    const at = expected.stepIds.indexOf(start);
    const notOk = expected.stepIds.slice(0, Math.max(at, 0)).filter((id) => !stepDone(journal.steps[id]?.status));
    if (opts.from !== undefined && notOk.length > 0) out.push(`--from ${start} skips steps that are not ok: ${notOk.join(", ")}`);
  }
  return out;
}

/** The first step of the list that is not ok, or undefined when all are. */
export function firstNotOk(journal: Pick<RunJournal, "steps">, ids: readonly string[]): string | undefined {
  return ids.find((id) => !stepDone(journal.steps[id]?.status));
}

/** Read `<dir>/run.json` (or the file itself). undefined when missing or unparseable. */
export function readJournal(path: string): RunJournal | undefined {
  try {
    const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "run.json") : path;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RunJournal;
    return parsed && parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Write `<dir>/run.json` atomically, mode 0600. */
export function writeJournal(dir: string, journal: RunJournal): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.run.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, "run.json"));
}

/** The command that resumes a failed run at `stepId`. */
export function resumeCommand(opts: { target: string; go: string; runTs: string; stepId: string; stageJournal?: string }): string {
  const parts = ["bun", "run", "release:run", "--target", opts.target, "--go", opts.go, "--run", opts.runTs, "--from", opts.stepId];
  if (opts.stageJournal) parts.push("--stage-journal", opts.stageJournal);
  return parts.join(" ");
}
