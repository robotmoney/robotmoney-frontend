#!/usr/bin/env bun
// `bun run release:precheck` — run a release's own version checks against the
// live stage stack before the full run (issue 1563).
//
//   bun run release:precheck --target stage --release vA.B.C --commit <40-hex sha>
//
// In the v0.7.1 stage QA, new version checks first ran inside a full stage run,
// so each run surfaced one check defect and a fix cost a 4 h restart. A
// precheck finds those defects in minutes. It is a tool, not a gate: it writes
// no run.json, changes no run's state, and SP.8 never reads it.
//
// On the control machine it:
//   1. refuses (exit 2) a target that is not stage, a run of the target in
//      flight (runsInFlight, ./preflight.ts), or a commit that is not on a QA
//      branch of the release line (originProblems, ./go.ts);
//   2. makes a throwaway worktree of the commit on the control machine and
//      loads runbooks/releases/<release>.yaml from it, so the checks are the
//      commit's;
//   3. selects every QA step that carries `added: <release>`, in runbook order;
//   4. for target-host steps, makes a throwaway worktree of the commit on the
//      target host (<home>/.local/state/robotmoney-release/<target>/precheck-<ts>/checkout,
//      `bun install --frozen-lockfile`); control-host steps run from the local
//      worktree;
//   5. runs each step's rendered command (the target's values, `{runTs}` =
//      precheck-<ts>, `{release}` = --release) against the live instance, as
//      the run judges it (executeStep, ./step-exec.ts), with a record that is
//      never journaled;
//   6. writes <journal root>/<target>/precheck-<ts>/precheck.json, one row per
//      step (exit, duration, the check's problems), next to each step's logs;
//   7. removes both worktrees, pass or fail.
// It prints one line per check and exits 0 only when every check met its expectExit.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { originProblems } from "./go.ts";
import { journalRoot, runStamp, type StepRecord } from "./journal.ts";
import { runsInFlight } from "./preflight.ts";
import { realDeps, targetPath } from "./run.ts";
import { loadReleaseRunbook, type RunbookStep } from "./runbook.ts";
import { executeStep, type RunnerDeps } from "./step-exec.ts";
import { BASE_ENV, CONTROL_HOST, CONTROL_REPO, renderStep, shellQuote, templateValues, type RenderedStep } from "./steps.ts";
import { loadTarget, type ReleaseTarget } from "./target.ts";

const NAME = "release:precheck";

export interface PrecheckDeps extends RunnerDeps {
  /** The runs of a target still running under the journal root (./preflight.ts). */
  runsInFlight(root: string, target: string): { runTs: string; updatedAt: string }[];
}

export interface PrecheckArgs {
  readonly target: string;
  readonly release: string;
  readonly commit: string;
}

/** One row of precheck.json. */
export interface PrecheckRow {
  readonly id: string;
  readonly host: string;
  readonly ok: boolean;
  readonly exit: number | null;
  readonly expectExit: number;
  readonly durationMs: number;
  readonly problems: readonly string[];
}

export interface PrecheckReport {
  readonly kind: "precheck";
  readonly target: string;
  readonly release: string;
  readonly commit: string;
  readonly runTs: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly passed: boolean;
  readonly steps: readonly PrecheckRow[];
}

export function parsePrecheckArgs(argv: readonly string[]): PrecheckArgs | { error: string } {
  const out: Record<string, string> = {};
  const valued: Record<string, string> = { "--target": "target", "--release": "release", "--commit": "commit" };
  for (let i = 0; i < argv.length; i++) {
    const key = valued[argv[i]!];
    if (!key) return { error: `unknown argument "${argv[i]}"` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${argv[i]} needs a value` };
    out[key] = v;
    i++;
  }
  if (!out.target || !out.release || !out.commit) return { error: "usage: bun run release:precheck --target stage --release vA.B.C --commit <40-hex sha>" };
  if (!/^v\d+\.\d+\.\d+$/.test(out.release)) return { error: `--release takes a release name (vA.B.C), got "${out.release}"` };
  if (!/^[0-9a-f]{40}$/.test(out.commit)) return { error: `--commit takes a full 40-hex sha, got "${out.commit}"` };
  return { target: out.target, release: out.release, commit: out.commit };
}

/** PURE. The steps a precheck runs: every QA step the release added, in runbook order. Template steps carry no added. */
export function selectPrecheckSteps(steps: readonly RunbookStep[], release: string): RunbookStep[] {
  return steps.filter((s) => s.phase === "qa" && s.added === release);
}

/** A command a host runs with the same clean environment as every step (`env -i`, ./steps.ts). */
function hostCommand(home: string, argv: readonly string[]): string {
  const env = [`HOME=${shellQuote(home)}`, ...Object.entries(BASE_ENV).map(([k, v]) => `${k}=${shellQuote(v)}`)];
  return `env -i ${env.join(" ")} ${argv.map(shellQuote).join(" ")}`;
}

/** PURE. A control step's command, moved from the control checkout to the precheck's worktree of the commit. */
export function inWorktree(step: RenderedStep, worktree: string): RenderedStep {
  const from = `cd ${shellQuote(CONTROL_REPO)}`;
  if (!step.remote.startsWith(from)) throw new Error(`${step.id}: a control step's command does not start in the control checkout`);
  return { ...step, remote: `cd ${shellQuote(worktree)}${step.remote.slice(from.length)}` };
}

/** The problems a step's pulled receipts name (a version check's receipt JSON carries `problems`). */
function receiptProblems(record: StepRecord, deps: PrecheckDeps): string[] {
  const out: string[] = [];
  for (const r of record.receipts) {
    if (r.local === undefined) continue;
    try {
      const doc = JSON.parse(deps.readText(r.local) ?? "") as { problems?: unknown };
      if (Array.isArray(doc.problems)) for (const p of doc.problems) if (typeof p === "string") out.push(p);
    } catch { /* not a JSON receipt */ }
  }
  return out;
}

export async function runPrecheck(argv: readonly string[], deps: PrecheckDeps): Promise<number> {
  const args = parsePrecheckArgs(argv);
  if ("error" in args) {
    deps.error(`[${NAME}] ${args.error}`);
    return 2;
  }
  let loaded: ReleaseTarget;
  try {
    loaded = loadTarget(targetPath(args.target));
  } catch (error) {
    deps.error(`[${NAME}] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (loaded.rmEnv !== "stage") {
    deps.error(`[${NAME}] refusing: ${loaded.name} is a ${loaded.rmEnv} target; a precheck runs against stage only.`);
    return 2;
  }
  // The release the precheck names is the one whose checks run: `{release}` renders from it.
  const target: ReleaseTarget = { ...loaded, release: args.release };
  const root = journalRoot(deps.home);
  const busy = deps.runsInFlight(root, target.name);
  if (busy.length > 0) {
    deps.error(`[${NAME}] refusing: run ${busy.map((b) => `${b.runTs} (updated ${b.updatedAt})`).join(", ")} of ${target.name} is in flight; a precheck never runs beside a run.`);
    return 2;
  }
  const branches = await deps.collect(CONTROL_HOST, `cd ${shellQuote(CONTROL_REPO)} && git fetch -q origin && git branch -r --contains ${args.commit}`);
  const origin = branches.code === 0 ? originProblems(args.release, args.commit, branches.stdout, "stage") : [`git could not list the origin branches containing ${args.commit}`];
  if (origin.length > 0) {
    deps.error(`[${NAME}] refusing: ${origin.join("; ")}.`);
    return 2;
  }

  const started = deps.now();
  const runTs = `precheck-${runStamp(started)}`;
  const dir = join(root, target.name, runTs);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const localWorktree = join(dir, "checkout");
  const remoteWorktree = `${target.home}/.local/state/robotmoney-release/${target.name}/${runTs}/checkout`;
  let localMade = false;
  let remoteMade = false;
  try {
    const local = await deps.collect(CONTROL_HOST, `cd ${shellQuote(CONTROL_REPO)} && git worktree add --detach ${shellQuote(localWorktree)} ${args.commit}`);
    localMade = local.code === 0;
    if (!localMade) {
      deps.error(`[${NAME}] the control machine could not make a worktree of ${args.commit} at ${localWorktree}.`);
      return 2;
    }
    let steps: RunbookStep[];
    try {
      steps = selectPrecheckSteps(loadReleaseRunbook(args.release, join(localWorktree, "scripts", "release", "runbooks")).steps, args.release);
    } catch (error) {
      deps.error(`[${NAME}] ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    if (steps.length === 0) {
      deps.error(`[${NAME}] refusing: the ${args.release} runbook at ${args.commit} has no QA step with added: ${args.release}.`);
      return 2;
    }
    if (steps.some((s) => s.host === "control")) {
      const install = await deps.collect(CONTROL_HOST, `cd ${shellQuote(localWorktree)} && bun install --frozen-lockfile`);
      if (install.code !== 0) {
        deps.error(`[${NAME}] bun install --frozen-lockfile failed in ${localWorktree}.`);
        return 2;
      }
    }
    if (steps.some((s) => s.host === "target")) {
      const git = (...a: string[]) => hostCommand(target.home, ["git", "-C", target.checkout, ...a]);
      const add = await deps.collect(target.host, [
        `mkdir -p ${shellQuote(remoteWorktree.replace(/\/checkout$/, ""))}`,
        git("fetch", "-q", "origin"),
        git("worktree", "add", "--detach", remoteWorktree, args.commit),
      ].join(" && "));
      remoteMade = add.code === 0;
      if (!remoteMade) {
        deps.error(`[${NAME}] ${target.host} could not make a worktree of ${args.commit} from ${target.checkout} at ${remoteWorktree}.`);
        return 2;
      }
      const install = await deps.collect(target.host, `cd ${shellQuote(remoteWorktree)} && ${hostCommand(target.home, ["bun", "install", "--frozen-lockfile"])}`);
      if (install.code !== 0) {
        deps.error(`[${NAME}] bun install --frozen-lockfile failed in ${target.host}:${remoteWorktree}.`);
        return 2;
      }
    }

    // Target steps cd into the remote worktree: the target, rendered with it as its checkout.
    const values = templateValues({ ...target, checkout: remoteWorktree }, args.commit, runTs);
    const quiet: PrecheckDeps = { ...deps, log: () => {}, error: () => {} };
    const rows: PrecheckRow[] = [];
    deps.log(`[${NAME}] ${args.release} at ${args.commit} against ${target.name} (${target.instance}): ${steps.length} added check(s)`);
    for (const step of steps) {
      const stepStarted = deps.now();
      const record: StepRecord = { id: step.id, status: "running", exit: null, expectExit: step.expectExit, startedAt: stepStarted.toISOString(), receipts: [], attempt: 1 };
      let ok = false;
      if (step.host === "capture") {
        record.error = "a capture-host step; a precheck runs target and control steps only";
      } else {
        const rendered = step.host === "control"
          ? inWorktree(renderStep(step, target, values), localWorktree)
          : renderStep(step, { ...target, checkout: remoteWorktree }, values);
        const stepDir = join(dir, step.id);
        mkdirSync(stepDir, { recursive: true, mode: 0o700 });
        ok = await executeStep(rendered, undefined, record, stepStarted, stepDir, undefined, quiet);
      }
      const problems = [...receiptProblems(record, deps), ...(record.error !== undefined ? [record.error] : [])];
      const row: PrecheckRow = {
        id: step.id, host: step.host, ok, exit: record.exit, expectExit: step.expectExit,
        durationMs: record.durationMs ?? deps.now().getTime() - stepStarted.getTime(), problems,
      };
      rows.push(row);
      deps.log(`[${NAME}] ${row.ok ? "ok    " : "FAILED"} ${row.id} exit ${row.exit ?? "-"} (expected ${row.expectExit}), ${(row.durationMs / 1000).toFixed(1)} s${problems.length > 0 ? `: ${problems.join("; ")}` : ""}`);
    }
    const passed = rows.every((r) => r.ok);
    const report: PrecheckReport = {
      kind: "precheck", target: target.name, release: args.release, commit: args.commit, runTs,
      startedAt: started.toISOString(), endedAt: deps.now().toISOString(), passed, steps: rows,
    };
    writeFileSync(join(dir, "precheck.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    deps.log(`[${NAME}] ${passed ? "passed" : "failed"}: ${rows.filter((r) => r.ok).length}/${rows.length} check(s) ok; ${join(dir, "precheck.json")}`);
    return passed ? 0 : 1;
  } finally {
    // Both worktrees go, pass or fail. A remove that fails is reported; it never changes the exit.
    if (remoteMade) {
      const rm = await deps.collect(target.host, hostCommand(target.home, ["git", "-C", target.checkout, "worktree", "remove", "--force", remoteWorktree]));
      if (rm.code !== 0) deps.error(`[${NAME}] could not remove ${target.host}:${remoteWorktree}; remove it with git -C ${target.checkout} worktree remove --force ${remoteWorktree}`);
    }
    if (localMade) {
      const rm = await deps.collect(CONTROL_HOST, `cd ${shellQuote(CONTROL_REPO)} && git worktree remove --force ${shellQuote(localWorktree)}`);
      if (rm.code !== 0) deps.error(`[${NAME}] could not remove ${localWorktree}; remove it with git worktree remove --force ${localWorktree}`);
    }
  }
}

if (import.meta.main) {
  process.exitCode = await runPrecheck(process.argv.slice(2), { ...realDeps(), runsInFlight });
}
