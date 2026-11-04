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
// Resume in place (issue 1565). A stage run may resume at a new QA commit whose
// diff from the journal's commit touches only CHECK_ONLY_PATHS: the check code,
// not the product it checks. The journal lists every commit it ran at
// (`commits`), and each step records its own. SP.8 then requires every earlier
// commit to differ from the production commit only in those paths.
//
// Pure apart from readJournal/writeJournal, so each refusal is a unit test.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `accepted`: a failed step the owner recorded an acceptance of (`--accept`); the run continues past it. */
export type StepStatus = "ok" | "failed" | "running" | "skipped" | "accepted";

/** A step is done when it passed, when its template skips this policy (`onlyFor`), or when the owner accepted its failure. */
export function stepDone(status: StepStatus | undefined): boolean {
  return status === "ok" || status === "skipped" || status === "accepted";
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
  /** A baseline gate's failures accepted by the owner's triage file (P08-log-baseline). */
  triage?: { file: string; sha256: string; used: { check: string; fragment: string; reason: string }[] };
  /** The owner's recorded acceptance of this step's failure (`--accept`): why, the issue, and when. */
  accepted?: { reason: string; issue: number; at: string };
  /** The commit this step ran at (issue 1565): a stage run resumed in place runs later steps at a later commit. */
  commit?: string;
}

/** One commit a run ran at, from the step it started at (issue 1565). */
export interface CommitRecord {
  readonly commit: string;
  readonly tree: string;
  readonly goSha256: string;
  readonly fromStep: string;
  readonly at: string;
}

/**
 * The paths a stage resume in place may change (issue 1565): check code, not
 * product. `dir/**` matches every file under dir; any other entry is one file.
 * Nothing else is check-only: not the runner (run.ts, journal.ts, steps.ts,
 * step-exec.ts), not any product path.
 */
export const CHECK_ONLY_PATHS: readonly string[] = Object.freeze([
  "scripts/release/version-checks/**",
  "scripts/release/runbooks/**",
  "scripts/release/version-check.ts",
  "scripts/release/analytics-load-check.ts",
  "scripts/release/sdk-check.ts",
  "scripts/release/sdk-lib.ts",
  "scripts/release/public-analytics-read.ts",
  "scripts/release/replay-row.ts",
  "scripts/tests/**",
]);

/** PURE. Is this repo path check-only? */
export function isCheckOnlyPath(path: string): boolean {
  return CHECK_ONLY_PATHS.some((p) => (p.endsWith("/**") ? path.startsWith(p.slice(0, -2)) : path === p));
}

/** PURE. The changed paths that are not check-only. */
export function notCheckOnly(paths: readonly string[]): string[] {
  return paths.filter((p) => !isCheckOnlyPath(p));
}

/** `git diff --name-only <from> <to>` on the control machine, or undefined when git cannot. */
export type ChangedPaths = (from: string, to: string) => Promise<readonly string[] | undefined>;

/** The commits a stage journal ran at before its last one, in order: what SP.8 diffs against the production commit. */
export function earlierCommits(journal: Pick<RunJournal, "commit" | "commits">): string[] {
  return [...new Set((journal.commits ?? []).map((c) => c.commit).filter((c) => c !== journal.commit))];
}

/** Each earlier commit's changed paths against `to`, for checkStageJournal. */
export async function earlierCommitPaths(journal: RunJournal | undefined, to: string, diff: ChangedPaths): Promise<Record<string, readonly string[] | undefined>> {
  const out: Record<string, readonly string[] | undefined> = {};
  if (journal === undefined) return out;
  for (const c of earlierCommits(journal)) out[c] = await diff(c, to);
  return out;
}

export interface RunJournal {
  readonly version: 1;
  readonly target: string;
  readonly rmEnv: "stage" | "prod";
  readonly release: string;
  /** The commit the run runs at now: its last `commits` entry once it resumed in place. */
  commit: string;
  /** The commit's tree (`git rev-parse <commit>^{tree}`): what SP.8 compares, because stage runs the QA commit and production the squash commit (D70). */
  tree?: string;
  /** The rc tag the go named (a production run, D64); the commit is its resolution. */
  readonly tag?: string;
  readonly stepListHash: string;
  readonly stepIds: readonly string[];
  goSha256: string;
  /** Every commit the run ran at, in order (issue 1565); a run that never resumed in place lists one. */
  commits?: CommitRecord[];
  readonly runTs: string;
  readonly startedAt: string;
  updatedAt: string;
  status: "running" | "failed" | "passed" | "incomplete";
  steps: Record<string, StepRecord>;
  /** The stage journal production checked (SP.8), for the record. */
  stageJournal?: { path: string; runTs: string; stepListHash: string; commit: string; tree?: string };
  /** The signed recovery matrix the go names (SC.1): its reference and, for a file, its sha256. */
  recovery?: { ref: string; sha256: string | null };
  /** The migrate's start to READY's end, once both passed: the cutover window (Q18-migrate to Q23-ready on stage, C05-migrate to C11-ready on production). The website stays up through it (the probe's grade). */
  cutoverSeconds?: number;
  /** The preflight this run continued from (`--after-preflight`), when it did. */
  afterPreflight?: { path: string; runTs: string };
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
  expected: {
    stepListHash: string; tree: string; stepIds: readonly string[];
    /** Each earlier commit's changed paths against this run's commit (earlierCommitPaths); undefined when git could not diff. */
    earlierPaths?: Readonly<Record<string, readonly string[] | undefined>>;
  },
): string[] {
  if (journal === undefined) return ["SP.8: no stage run journal was found; production runs only what stage passed (pass --stage-journal <run dir>)"];
  const out: string[] = [];
  if (journal.rmEnv !== "stage") out.push(`SP.8: the journal is a ${journal.rmEnv} run, not a stage run`);
  if (journal.stepListHash !== expected.stepListHash) {
    out.push(`SP.8: the stage run used step list ${journal.stepListHash.slice(0, 12)}; this run is ${expected.stepListHash.slice(0, 12)}`);
  }
  // D70: stage ran the QA commit, production runs the squash commit; the tree is what they share.
  if (journal.tree === undefined) out.push(`SP.8: the stage run (commit ${journal.commit}) records no tree; rerun stage with this runner`);
  else if (journal.tree !== expected.tree) out.push(`SP.8: the stage run's tree is ${journal.tree.slice(0, 12)} (commit ${journal.commit.slice(0, 12)}); this run's tree is ${expected.tree.slice(0, 12)}`);
  // Issue 1565: a stage run resumed in place ran its earlier steps at earlier commits; each may differ from this one only in check code.
  for (const c of earlierCommits(journal)) {
    const paths = expected.earlierPaths?.[c];
    if (paths === undefined) out.push(`SP.8: the stage run also ran commit ${c.slice(0, 12)}, which git could not diff against this run's commit`);
    else if (notCheckOnly(paths).length > 0) out.push(`SP.8: the stage run's earlier commit ${c.slice(0, 12)} differs from this run's commit outside the check-only paths: ${notCheckOnly(paths).join(", ")}`);
  }
  const status = runStatus(journal, expected.stepIds);
  if (status !== "passed") {
    const notOk = expected.stepIds.filter((id) => !stepDone(journal.steps[id]?.status));
    out.push(`SP.8: the stage run did not pass (${status}; not ok: ${notOk.join(", ")})`);
  }
  // An owner's acceptance lets a run continue; it is not a pass. Production runs only what stage passed.
  const accepted = expected.stepIds.filter((id) => journal.steps[id]?.status === "accepted");
  if (accepted.length > 0) out.push(`SP.8: the stage run accepted a failure rather than passing: ${accepted.join(", ")}`);
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
 * later than the first step that is not ok. A stage run may also resume in
 * place at a new commit, with a new go, when `changedPaths` (the journal's
 * commit to this one) are all check-only (issue 1565). Production never does.
 */
export function checkResume(
  journal: RunJournal,
  expected: { target: string; commit: string; stepListHash: string; goSha256: string; stepIds: readonly string[]; changedPaths?: readonly string[] },
  opts: { from?: string; only?: string },
): string[] {
  const out: string[] = [];
  if (journal.target !== expected.target) out.push(`the journal is for target ${journal.target}, not ${expected.target}`);
  const inPlace = journal.commit !== expected.commit;
  if (inPlace) {
    if (journal.rmEnv !== "stage") out.push(`the journal ran commit ${journal.commit}; this run is ${expected.commit}`);
    else if (expected.changedPaths === undefined) out.push(`the journal ran commit ${journal.commit}; this run is ${expected.commit}, and git could not list the paths between them`);
    else {
      const product = notCheckOnly(expected.changedPaths);
      if (product.length > 0) out.push(`the journal ran commit ${journal.commit}; this run is ${expected.commit}, which changes paths that are not check-only: ${product.join(", ")}`);
    }
  }
  if (journal.stepListHash !== expected.stepListHash) out.push("the journal ran a different step list; start a new run");
  // A resume in place presents the new commit's go; any other resume presents the same go.
  if ((!inPlace || journal.rmEnv !== "stage") && journal.goSha256 !== expected.goSha256) out.push("the journal ran under a different go file; a resume presents the same go");
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

/**
 * PURE. The journal's steps in runbook order (stepIds), whatever order they
 * finished in (issue 1557: concurrent steps end in any order); a record for an
 * id the list lacks keeps its place after them.
 */
export function stepsInRunbookOrder(journal: Pick<RunJournal, "steps" | "stepIds">): Record<string, StepRecord> {
  const out: Record<string, StepRecord> = {};
  for (const id of journal.stepIds ?? []) if (journal.steps[id] !== undefined) out[id] = journal.steps[id]!;
  for (const [id, rec] of Object.entries(journal.steps)) if (!(id in out)) out[id] = rec;
  return out;
}

/** Write `<dir>/run.json` atomically, mode 0600, its steps in runbook order. */
export function writeJournal(dir: string, journal: RunJournal): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.run.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ ...journal, steps: stepsInRunbookOrder(journal) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, "run.json"));
}

/** The command that resumes a failed run at `stepId`. */
export function resumeCommand(opts: { target: string; go: string; runTs: string; stepId: string; stageJournal?: string }): string {
  const parts = ["bun", "run", "release:run", "--target", opts.target, "--go", opts.go, "--run", opts.runTs, "--from", opts.stepId];
  if (opts.stageJournal) parts.push("--stage-journal", opts.stageJournal);
  return parts.join(" ");
}

/** The command that records the owner's acceptance of a failed step, so the run continues past it. */
export function acceptCommand(opts: { target: string; runTs: string; stepId: string }): string {
  return ["bun", "run", "release:run", "--target", opts.target, "--run", opts.runTs, "--accept", opts.stepId, "--reason", '"<why>"', "--issue", "<n>"].join(" ");
}

/**
 * PURE. Record the owner's acceptance of one failed step. Returns the refusal,
 * or undefined once the journal is updated in place.
 */
export function acceptStep(
  journal: RunJournal, stepId: string, decision: { reason: string; issue: number; at: string },
  steps: { ids: readonly string[]; irreversible: (id: string) => boolean },
): string | undefined {
  if (!steps.ids.includes(stepId)) return `--accept ${stepId}: no such step (steps: ${steps.ids.join(", ")})`;
  if (journal.status === "running") return `run ${journal.runTs} still reads running; abandon it first (--abandon) if it is dead`;
  const rec = journal.steps[stepId];
  if (rec === undefined) return `${stepId} has not run in run ${journal.runTs}; only a failed step can be accepted`;
  if (rec.status !== "failed") return `${stepId} is ${rec.status}, not failed; only a failed step can be accepted`;
  if (steps.irreversible(stepId)) return `${stepId} is irreversible; a failure there is the recovery matrix's (runbook section 8), not an acceptance`;
  rec.status = "accepted";
  rec.accepted = { ...decision };
  journal.status = runStatus(journal, steps.ids);
  journal.updatedAt = decision.at;
  return undefined;
}
