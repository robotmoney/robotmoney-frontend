#!/usr/bin/env bun
// `bun run release:run` — the agent-executed release runbook (D61).
//
// Runs on the CONTROL MACHINE. Every step runs on a host over ssh; no step
// needs a person at a host terminal (rule 4). The step list (./steps.ts) is the
// same for every target; only the target file differs (rule 2). Every database
// operation is a committed script with a receipt (rule 3). The operator's
// authority is one go file, read before the run (rule 1).
//
//   bun run release:run --target <stage|prod|path.json> --preflight [--go <go file>] [--triage <file>] [--stage-journal <dir>]
//   bun run release:run --target stage --go <go file>
//   bun run release:run --target prod  --go <go file> --stage-journal <stage run dir>
//   bun run release:run --target prod  --go <go file> --stage-journal <dir> --run <run-ts> --from <step>
//   bun run release:run --target stage --go <go file> --only <step> [--run <run-ts>]
//   bun run release:run --target <t> --go <go file> --after-preflight <preflight dir>   (continue from a green preflight, within 1 h)
//   bun run release:run --target prod --go <go file> --stage-journal <stage run dir> --after-preflight <preflight dir>   (the production cutover: SP.8)
//   bun run release:run --target <t> --abandon <run-ts>                                  (mark a dead run failed so P.busy clears)
//   bun run release:run --target <t> --run <run-ts> --accept <step> --reason "<why>" --issue <n>   (record the owner's acceptance of one failed step)
//
// What it does, in order: load and validate the target; read the go file, which
// names this release and target and is the one source of the release ref (a
// target file names none): a stage go names a commit, a production go names
// the rc tag, which the runner resolves to its commit on the control machine
// (D64); refuse a commit that is not on the release branch; print the plan
// (target, commit, step-list hash, every step and its remote command). `--preflight` (`--dry-run` is the same
// flag) needs no go: it runs every check the run needs and every step before
// the first irreversible one, changes nothing a running service uses, and
// exits 0 only when every check is green (./preflight.ts). Otherwise: refuse
// without a go file; refuse a placeholder confirmTarget;
// under RM_ENV=prod refuse unless --stage-journal names a passed stage run of
// the same step list at the same commit (SP.8); then run the steps in order,
// journal each one locally (./journal.ts), copy its receipts back, and stop at
// the first step whose exit differs from the expected one, printing the exact
// resume command. A stage run resumes in place at a new QA commit whose diff
// touches only check code (journal.ts CHECK_ONLY_PATHS, issue 1565). A step that declares `after` (issue 1557) starts as soon as
// the steps it names are done, alongside a long waiter; one that declares none
// waits for every earlier step, as before.
//
// It never prints a secret value. Output and receipts pass through
// ./scrub.ts before they reach the console or the journal.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { goRef, originProblems, validateGo, type GoRecord, type ResolvedGo } from "./go.ts";
import {
  acceptCommand, acceptStep, checkResume, checkStageJournal, earlierCommitPaths, firstNotOk, journalRoot, readJournal, resumeCommand, runStamp, runStatus, RUN_TS_RE,
  selectSteps, stepDone, writeJournal, type RunJournal, type StepRecord,
} from "./journal.ts";
import { checkAfterPreflight, controlChangedPaths, PREFLIGHT_MAX_AGE_MS, preflightSteps, runPreflight, type PreflightReport } from "./preflight.ts";
import { executeStep, prefixedDeps, readRecovery, TIMED_OUT, type RunnerDeps } from "./step-exec.ts";
import {
  BREAKING_SKIPS, CONTROL_HOST, CONTROL_REPO, notBeforeOf, READY_PENDING, renderStep, shellQuote, stepIds, stepListHash, templateValues, type RenderedStep, type StepTemplate,
} from "./steps.ts";
import { loadReleaseRunbook, stepNameOf } from "./runbook.ts";
import { confirmTargetFilled, loadTarget, type ReleaseTarget } from "./target.ts";

export { receiptPathsInOutput, type RunnerDeps } from "./step-exec.ts";

const NAME = "release:run";
const HERE = dirname(fileURLToPath(import.meta.url));

export interface RunArgs {
  target?: string;
  go?: string;
  /** `--preflight`, or its alias `--dry-run`: ./preflight.ts. */
  preflight: boolean;
  from?: string;
  only?: string;
  run?: string;
  stageJournal?: string;
  journalRoot?: string;
  triage?: string;
  /** A green preflight's directory this run continues from. */
  afterPreflight?: string;
  /** A run stamp to mark failed: the operator says it is dead. */
  abandon?: string;
  /** A failed step the owner accepts, with `--reason` and `--issue`, in the run `--run` names. */
  accept?: string;
  reason?: string;
  issue?: string;
}

export function parseArgs(argv: readonly string[]): RunArgs | { error: string } {
  const out: RunArgs = { preflight: false };
  const valued: Record<string, keyof RunArgs> = {
    "--target": "target", "--go": "go", "--from": "from", "--only": "only", "--run": "run",
    "--stage-journal": "stageJournal", "--journal-root": "journalRoot", "--triage": "triage",
    "--after-preflight": "afterPreflight", "--abandon": "abandon", "--accept": "accept", "--reason": "reason", "--issue": "issue",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--preflight" || a === "--dry-run") { out.preflight = true; continue; }
    const key = valued[a];
    if (!key) return { error: `unknown argument "${a}"` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
    (out as unknown as Record<string, string>)[key] = v;
    i++;
  }
  if (!out.target) return { error: "--target <stage|prod|path> is required" };
  if (out.run !== undefined && !RUN_TS_RE.test(out.run)) return { error: `--run takes a run stamp like 20261008T142233Z, got "${out.run}"` };
  if (out.from !== undefined && out.run === undefined) return { error: "--from resumes a run: name it with --run <run-ts> (the failed run prints the command)" };
  if (out.from !== undefined && out.only !== undefined) return { error: "--from and --only cannot be combined" };
  if (out.preflight && (out.run !== undefined || out.only !== undefined)) return { error: "--preflight checks a run before it starts: it takes no --run, --from or --only" };
  if (out.afterPreflight !== undefined && (out.run !== undefined || out.only !== undefined || out.preflight)) return { error: "--after-preflight starts a new run from a green preflight: it takes no --run, --from, --only or --preflight" };
  if (out.abandon !== undefined && !RUN_TS_RE.test(out.abandon)) return { error: `--abandon takes a run stamp like 20261008T142233Z, got "${out.abandon}"` };
  if (out.abandon !== undefined && (out.go !== undefined || out.run !== undefined || out.preflight || out.afterPreflight !== undefined)) return { error: "--abandon takes only --target and the run stamp" };
  if (out.accept !== undefined) {
    if (out.run === undefined) return { error: "--accept names a step of a run: name the run with --run <run-ts>" };
    if (!out.reason?.trim()) return { error: "--accept needs --reason \"<why the owner accepts this failure>\"" };
    if (out.issue === undefined || !/^[1-9]\d*$/.test(out.issue)) return { error: `--accept needs --issue <n>, the issue that records the failure; got "${out.issue ?? ""}"` };
    if (out.go !== undefined || out.from !== undefined || out.only !== undefined || out.preflight || out.afterPreflight !== undefined || out.abandon !== undefined) {
      return { error: "--accept takes only --target, --run, the step, --reason and --issue" };
    }
  } else if (out.reason !== undefined || out.issue !== undefined) return { error: "--reason and --issue go with --accept <step>" };
  return out;
}

/** `stage` → scripts/release/targets/stage.json; a path is taken as given. */
export function targetPath(arg: string): string {
  return arg.includes("/") || arg.endsWith(".json") ? resolve(arg) : join(HERE, "targets", `${arg}.json`);
}

/** The plan, as printed before anything runs. */
export function renderPlan(target: ReleaseTarget, commit: string, hash: string, steps: readonly RenderedStep[]): string {
  const lines = [
    `release:run plan`,
    `  target        ${target.name} (RM_ENV=${target.rmEnv}, instance ${target.instance})`,
    `  host          ${target.host}  checkout ${target.checkout}  HOME ${target.home}`,
    `  capture host  ${target.capture.host}  checkout ${target.capture.checkout}  HOME ${target.capture.home}`,
    `  running stack whatever ${target.host}'s smoke state names for instance ${target.instance} (the rolling boot replaces it one service at a time; website-server is kept)`,
    `  release       ${target.release} at ${commit}`,
    `  confirm       ${target.confirmTarget}`,
    `  step list     ${hash}`,
    "",
  ];
  for (const s of steps) {
    const skip = s.onlyFor !== undefined && s.onlyFor !== target.rmEnv ? ` SKIPPED (only ${s.onlyFor})` : "";
    const wait = s.notBefore ? ` not before ${s.notBefore.afterStep} + ${s.notBefore.hours} h` : "";
    const after = s.after ? ` after ${s.after.join(", ")}` : "";
    lines.push(`  [${s.id}]${s.irreversible ? " IRREVERSIBLE" : ""}${skip}${wait}${after} on ${s.host}: ${s.description}`);
    if (s.standing.length > 0) lines.push(`      standing: ${s.standing.join(", ")}`);
    lines.push(s.host === CONTROL_HOST ? `      $ sh -c ${shellQuote(s.remote)}` : `      $ ssh -T ${s.host} ${shellQuote(s.remote)}`);
  }
  return lines.join("\n");
}

/**
 * The whole run. Returns the process exit code. The steps are the release's
 * own runbook (runbooks/releases/<release>.yaml, ./runbook.ts), which only
 * adds to its template; a missing runbook or one that drops a template step
 * refuses. `stepList` replaces it in tests.
 */
export async function runRelease(argv: readonly string[], deps: RunnerDeps, stepList?: readonly StepTemplate[], options: { readonly breaking?: boolean } = {}): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    deps.error(`[${NAME}] ${args.error}`);
    return 2;
  }
  let target: ReleaseTarget;
  let steps: readonly StepTemplate[];
  // True when the release's runbook declares `breaking:`: its cutover is down, migrate, up (spec section 8.5).
  let breaking = options.breaking === true;
  try {
    target = loadTarget(targetPath(args.target!));
    if (stepList === undefined) {
      const runbook = loadReleaseRunbook(target.release);
      steps = runbook.steps;
      breaking = runbook.breaking !== undefined;
    } else steps = stepList;
  } catch (error) {
    deps.error(`[${NAME}] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // The operator marks a dead run (killed mid-step, still `running`) failed, so P.busy clears and the journal tells the truth.
  if (args.abandon !== undefined) {
    const dir = join(args.journalRoot ?? journalRoot(deps.home), target.name, args.abandon);
    const j = readJournal(dir);
    if (j === undefined) { deps.error(`[${NAME}] refusing: no journal at ${dir}.`); return 2; }
    if (j.status !== "running") { deps.error(`[${NAME}] refusing: run ${args.abandon} is ${j.status}, not running; nothing to abandon.`); return 2; }
    const now = deps.now().toISOString();
    for (const rec of Object.values(j.steps)) {
      if (rec.status !== "running") continue;
      rec.status = "failed";
      rec.endedAt = now;
      rec.error = `abandoned by the operator at ${now} (--abandon); the remote command may still have run to its end`;
    }
    j.status = "failed";
    j.updatedAt = now;
    writeJournal(dir, j);
    deps.log(`[${NAME}] run ${args.abandon} marked failed (abandoned). Resume it with --run ${args.abandon} --from <step> once the host is quiet, or start a new run.`);
    return 0;
  }

  // The owner's recorded acceptance of one failed step (issue 1282): the journal keeps the step's
  // failure, exit and output, plus why the owner accepts it and the issue; the run continues past it.
  if (args.accept !== undefined) {
    const dir = join(args.journalRoot ?? journalRoot(deps.home), target.name, args.run!);
    const j = readJournal(dir);
    if (j === undefined) { deps.error(`[${NAME}] refusing: no journal at ${dir}.`); return 2; }
    const at = deps.now().toISOString();
    const refusal = acceptStep(j, args.accept, { reason: args.reason!.trim(), issue: Number(args.issue), at }, {
      ids: stepIds(steps), irreversible: (id) => steps.find((s) => s.id === id)?.irreversible === true,
    });
    if (refusal !== undefined) { deps.error(`[${NAME}] refusing: ${refusal}.`); return 2; }
    writeFileSync(join(dir, args.accept, "result.json"), `${JSON.stringify(j.steps[args.accept], null, 2)}\n`, { mode: 0o600 });
    writeJournal(dir, j);
    deps.log(`[${NAME}] ${args.accept} of run ${args.run} accepted by the owner at ${at} (issue ${args.issue}): ${args.reason!.trim()}. The run is ${j.status}; continue it with --run ${args.run} [--from <step>].`);
    return 0;
  }

  // Rule 1: the one recorded go. It is the only source of the release ref.
  let go: ResolvedGo | undefined;
  if (args.go) {
    const goText = deps.readText(args.go);
    if (goText === undefined) {
      deps.error(`[${NAME}] refusing: the go file ${args.go} cannot be read.`);
      return 2;
    }
    const goResult = validateGo(goText, { release: target.release, target: target.name, rmEnv: target.rmEnv });
    if ("errors" in goResult) {
      deps.error(`[${NAME}] refusing: the go file does not authorize this run:\n  - ${goResult.errors.join("\n  - ")}`);
      return 2;
    }
    const resolved = await resolveGo(goResult.go, deps);
    if ("error" in resolved) {
      deps.error(`[${NAME}] refusing: ${resolved.error}.`);
      return 2;
    }
    go = resolved.go;
  } else if (!args.preflight) {
    deps.error(`[${NAME}] refusing: no --go <file>. The operator's go names the release, the commit and the target (D61 rule 1).`);
    return 2;
  }
  const ids = stepIds(steps);
  const hash = stepListHash(steps);
  const root = args.journalRoot ?? journalRoot(deps.home);
  if (args.preflight) {
    if (target.rmEnv !== "prod") {
      deps.error(`[${NAME}] refusing --preflight on ${target.name}: a preflight is production's gate before its cutover. A stage run is QA: run it whole with --go (D70 as amended 2026-10-15).`);
      return 2;
    }
    return runPreflight({
      target, go, goPath: args.go, stageJournal: args.stageJournal ? resolve(args.stageJournal) : undefined, triage: args.triage,
      steps, ids, hash, root, runTs: runStamp(deps.now()), renderPlan: (c, r) => renderPlan(target, c, hash, r),
    }, deps);
  }
  if (go === undefined) return 2;
  const commit = go.commit;

  // D70: stage runs a QA branch commit; production the release branch's rc (a tag resolves there).
  const branches = await deps.collect(CONTROL_HOST, `cd ${shellQuote(CONTROL_REPO)} && git fetch -q origin && git branch -r --contains ${commit}`);
  const origin = branches.code === 0 ? originProblems(target.release, commit, branches.stdout, target.rmEnv) : [`git could not list the origin branches containing ${commit}`];
  if (origin.length > 0) {
    deps.error(`[${NAME}] refusing: ${origin.join("; ")}.`);
    return 2;
  }
  // The commit's tree: what SP.8 compares between the stage QA commit and the production squash commit (D70).
  const tree = (await deps.collect(CONTROL_HOST, `cd ${shellQuote(CONTROL_REPO)} && git rev-parse ${commit}^{tree}`)).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(tree)) {
    deps.error(`[${NAME}] refusing: the tree of ${commit} cannot be read on the control machine.`);
    return 2;
  }

  let selected: string[];
  try {
    selected = selectSteps(ids, { from: args.from, only: args.only });
  } catch (error) {
    deps.error(`[${NAME}] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // Production's cutover starts only from a green preflight of the same rc and step list, at most
  // 60 minutes old (D70 as amended 2026-10-15). A resume of a run that did so (--run) needs none.
  if (target.rmEnv === "prod" && args.afterPreflight === undefined && args.run === undefined) {
    deps.error(`[${NAME}] refusing: production's cutover continues from a green preflight. Run --preflight --go <file> first, then --go <file> --after-preflight <its journal> within ${PREFLIGHT_MAX_AGE_MS / 60_000} minutes.`);
    return 2;
  }

  // A run within an hour of a green preflight continues from it: same run stamp,
  // so every path the preflight's steps wrote ({runTs}) is this run's, and P01-checkout
  // to P08-log-baseline are its records. Policy 4.3 holds: the dump is this run's.
  let preflight: PreflightReport | undefined;
  if (args.afterPreflight !== undefined) {
    const path = join(resolve(args.afterPreflight), "preflight.json");
    const text = deps.readText(path);
    try { preflight = text === undefined ? undefined : JSON.parse(text) as PreflightReport; } catch { preflight = undefined; }
    const refusals = checkAfterPreflight(preflight, { target: target.name, commit, stepListHash: hash, stepIds: ids, preflightIds: preflightSteps(steps).map((s) => s.id) }, deps.now());
    if (refusals.length > 0) {
      deps.error(`[${NAME}] refusing --after-preflight ${args.afterPreflight}:\n  - ${refusals.join("\n  - ")}`);
      return 2;
    }
  }
  const runTs = args.run ?? preflight?.runTs ?? runStamp(deps.now());
  const values = templateValues(target, commit, runTs, READY_PENDING, go.ref);
  const rendered = steps.map((s) => renderStep(s, target, values));
  deps.log(renderPlan(target, commit, hash, rendered));

  // SC.1: the recovery decision in the release's runbook YAML; its sha256 is journaled.
  const recovery = readRecovery(target.release, deps);
  if ("error" in recovery) {
    deps.error(`[${NAME}] refusing: ${recovery.error}.`);
    return 2;
  }

  if (!confirmTargetFilled(target)) {
    deps.error(`[${NAME}] refusing: ${target.name}.confirmTarget is the placeholder. Write host:port/database from ${target.host}:${target.home}/.env into the target file.`);
    return 2;
  }

  // SP.8: production runs only what stage passed.
  let stageRecord: RunJournal["stageJournal"];
  if (target.rmEnv === "prod") {
    const stage = args.stageJournal ? readJournal(resolve(args.stageJournal)) : undefined;
    // Issue 1565: a stage run resumed in place ran earlier steps at earlier commits; each is diffed against this one.
    const earlierPaths = await earlierCommitPaths(stage, commit, controlChangedPaths(deps));
    const refusals = checkStageJournal(stage, { stepListHash: hash, tree, stepIds: ids, earlierPaths });
    if (refusals.length > 0) {
      deps.error(`[${NAME}] refusing:\n  - ${refusals.join("\n  - ")}`);
      return 2;
    }
    stageRecord = { path: resolve(args.stageJournal!), runTs: stage!.runTs, stepListHash: stage!.stepListHash, commit: stage!.commit, tree: stage!.tree };
  }

  const runDir = join(root, target.name, runTs);
  let journal: RunJournal;
  let resumed = false;
  if (args.run !== undefined) {
    const existing = readJournal(runDir);
    if (existing === undefined && args.from !== undefined) {
      deps.error(`[${NAME}] refusing: no journal at ${runDir} to resume.`);
      return 2;
    }
    if (existing !== undefined) {
      // Issue 1565: a stage resume at a new commit lists the paths between the two on the control machine.
      const changedPaths = existing.commit !== commit && target.rmEnv === "stage" ? await controlChangedPaths(deps)(existing.commit, commit) : undefined;
      const refusals = checkResume(existing, { target: target.name, commit, stepListHash: hash, goSha256: go.sha256, stepIds: ids, changedPaths }, { from: args.from, only: args.only });
      if (refusals.length > 0) {
        deps.error(`[${NAME}] refusing to resume ${runDir}:\n  - ${refusals.join("\n  - ")}`);
        return 2;
      }
      journal = existing;
      resumed = true;
      if (args.from === undefined && args.only === undefined) {
        const next = firstNotOk(journal, ids);
        selected = next === undefined ? [] : ids.slice(ids.indexOf(next));
      }
    } else {
      journal = newJournal(target, commit, hash, ids, go, runTs, deps.now());
    }
  } else {
    if (existsSync(runDir)) {
      deps.error(`[${NAME}] refusing: ${runDir} exists already.`);
      return 2;
    }
    journal = newJournal(target, commit, hash, ids, go, runTs, deps.now());
    if (preflight !== undefined) {
      for (const id of ids) {
        const rec = preflight.steps[id];
        if (rec !== undefined && (rec.status === "ok" || rec.status === "skipped")) journal.steps[id] = { ...rec, receipts: [...rec.receipts] };
      }
      journal.afterPreflight = { path: resolve(args.afterPreflight!), runTs: preflight.runTs };
      const next = firstNotOk(journal, ids);
      selected = next === undefined ? [] : ids.slice(ids.indexOf(next));
      deps.log(`[${NAME}] continuing from preflight ${preflight.runTs}: ${Object.keys(journal.steps).join(", ")} carried over; starting at ${next ?? "(nothing left)"}`);
    }
  }
  if (stageRecord) journal.stageJournal = stageRecord;
  journal.recovery = recovery;
  // Issue 1565: every commit the run ran at. A journal from before the list seeds it with its own commit;
  // a resume in place appends the new one and runs on under its commit, tree and go.
  journal.commits ??= resumed ? [{ commit: journal.commit, tree: journal.tree ?? "", goSha256: journal.goSha256, fromStep: ids[0]!, at: journal.startedAt }] : [];
  if (journal.commits.at(-1)?.commit !== commit) {
    if (journal.commits.length > 0) deps.log(`[${NAME}] resuming in place at ${commit}: the change from ${journal.commit} is check code only; the steps already done keep their records`);
    journal.commits.push({ commit, tree, goSha256: go.sha256, fromStep: selected[0] ?? ids[0]!, at: deps.now().toISOString() });
  }
  journal.commit = commit;
  journal.goSha256 = go.sha256;
  journal.tree = tree;
  writeJournal(runDir, journal);
  deps.log(`\n[${NAME}] go ${go.sha256.slice(0, 12)} for ${go.release} ${go.ref}${go.tag ? ` (${commit})` : ""} on ${go.target}; journal ${runDir}`);

  // The preflight steps a green preflight already ran are carried, never run again.
  const carried = new Set(journal.afterPreflight === undefined ? [] : preflightSteps(steps).map((s) => s.id).filter((id) => journal.steps[id]?.status === "ok"));

  // QA collects every error (owner, 2026-10-16): a stage run goes on past a failed step, records it, and fails at the end
  // with all of them listed. Stage is disposable. Production's cutover is irreversible and stops at its first failure.
  const collectAll = target.rmEnv === "stage";
  const failedSteps: string[] = [];

  // The scheduler (issue 1557). A step with no `after` starts once every earlier selected step has settled, so a list
  // that declares none runs one step at a time, in order, exactly as before. A step with `after` starts once the steps
  // it names are done and its notBefore is met, alongside whatever still runs. Only this loop writes run.json: a running
  // step returns its record here.
  const todo = selected.filter((id) => !carried.has(id));
  const inTodo = new Set(todo);
  const pending = new Set(todo);
  const inflight = new Map<string, Promise<{ id: string; ok: boolean; record: StepRecord; irreversible: boolean }>>();
  const concurrent = todo.some((id) => steps[ids.indexOf(id)]!.after !== undefined);
  const unsettled = (id: string) => pending.has(id) || inflight.has(id);
  const prodFailed: string[] = [];
  let refusal: string | undefined;
  let waiting: { id: string; earliest: Date; afterStep: string; anchorEnded: string; hours: number }[] = [];
  const settle = (id: string, rec: StepRecord) => {
    journal.steps[id] = rec;
    writeFileSync(join(runDir, id, "result.json"), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
    journal.status = runStatus(journal, ids);
    writeJournal(runDir, journal);
  };
  const notRun = (id: string, template: StepTemplate, why: string) => {
    const now = deps.now().toISOString();
    settle(id, {
      id, status: "failed", exit: null, expectExit: template.expectExit, startedAt: now, endedAt: now, durationMs: 0, receipts: [],
      attempt: (journal.steps[id]?.attempt ?? 0) + 1, error: `not run: ${why}`, commit,
    });
    deps.error(`[${NAME}] ${id} NOT RUN: ${journal.steps[id]!.error}`);
    failedSteps.push(id);
  };

  for (;;) {
    waiting = [];
    // One pass in runbook order: a step settled here (skipped, not run) opens the gates of the later ones in the same pass.
    for (const [k, id] of todo.entries()) {
      if (prodFailed.length > 0 || refusal !== undefined) break;
      if (!pending.has(id)) continue;
      const template = steps[ids.indexOf(id)]!;
      if (template.after === undefined ? todo.slice(0, k).some(unsettled) : template.after.some((a) => inTodo.has(a) && unsettled(a))) continue;
      mkdirSync(join(runDir, id), { recursive: true, mode: 0o700 });

      // A prod-only step (the release tags) is recorded skipped on any other policy.
      const skip = skipReason(template, target, breaking);
      if (skip !== undefined) {
        pending.delete(id);
        const now = deps.now().toISOString();
        settle(id, {
          id, status: "skipped", skipped: skip, exit: null, expectExit: template.expectExit, startedAt: now, endedAt: now,
          durationMs: 0, receipts: [], attempt: (journal.steps[id]?.attempt ?? 0) + 1, commit,
        });
        deps.log(`\n[${NAME}] ── ${id} skipped: ${skip}${template.onlyFor ? ` (runs only for ${template.onlyFor})` : ""}`);
        continue;
      }

      // A step whose named step failed in this run never starts: the state it reads is not there (stage; production stops instead).
      const failedDep = template.after?.find((a) => inTodo.has(a) && !stepDone(journal.steps[a]?.status));
      if (failedDep !== undefined) {
        pending.delete(id);
        notRun(id, template, `${failedDep} did not pass, and this step runs after it`);
        continue;
      }

      // A watch step waits for its window after READY (the target's watchHours).
      const notBefore = notBeforeOf(template, target);
      if (notBefore !== undefined) {
        const anchor = journal.steps[notBefore.afterStep];
        if (anchor?.status !== "ok" || !anchor.endedAt) {
          if (collectAll && anchor?.status === "failed") {
            // Its anchor failed, so the window it waits for never opens: record it failed, not run, and go on.
            pending.delete(id);
            notRun(id, template, `${notBefore.afterStep} did not pass, so there is no READY to wait from`);
            continue;
          }
          refusal = `${id} runs only after ${notBefore.afterStep} passed in this run; it has not.`;
          break;
        }
        const earliest = new Date(Date.parse(anchor.endedAt) + notBefore.hours * 3_600_000);
        if (deps.now().getTime() < earliest.getTime()) {
          waiting.push({ id, earliest, afterStep: notBefore.afterStep, anchorEnded: anchor.endedAt, hours: notBefore.hours });
          continue;
        }
      }

      pending.delete(id);
      const readyStep = journal.steps[READY_STEP[target.rmEnv]];
      const readyIso = readyStep?.status === "ok" ? readyStep.endedAt : undefined;
      const step = renderStep(template, target, templateValues(target, commit, runTs, readyIso ?? READY_PENDING, go.ref));
      const started = deps.now();
      const record: StepRecord = {
        id, status: "running", exit: null, expectExit: step.expectExit, startedAt: started.toISOString(),
        receipts: [], attempt: (journal.steps[id]?.attempt ?? 0) + 1, commit,
      };
      journal.steps[id] = { ...record, receipts: [] };
      journal.status = "running";
      journal.updatedAt = started.toISOString();
      writeJournal(runDir, journal);
      deps.log(`\n[${NAME}] ── ${id}${step.irreversible ? " (IRREVERSIBLE)" : ""} on ${step.host}: ${step.description}`);
      const stepDeps = concurrent ? prefixedDeps(deps, id) : deps;
      inflight.set(id, executeStep(step, template.triage, record, started, join(runDir, id), args.triage, stepDeps)
        .catch((error: unknown) => {
          // A step that threw (a receipt copy failed) is failed, never left running: the runner settles it like any other.
          const ended = deps.now();
          Object.assign(record, { status: "failed", endedAt: ended.toISOString(), durationMs: ended.getTime() - started.getTime(), error: error instanceof Error ? error.message : String(error) });
          return false;
        })
        .then((ok) => ({ id, ok, record, irreversible: step.irreversible })));
    }
    if (inflight.size === 0) break;

    // Wait for the next step to end, or for the earliest waiter's notBefore (polled at most a minute apart).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wakeMs = waiting.length === 0 || prodFailed.length > 0 || refusal !== undefined ? undefined
      : Math.min(60_000, Math.max(0, Math.min(...waiting.map((w) => w.earliest.getTime())) - deps.now().getTime()));
    const done = await Promise.race([
      ...inflight.values(),
      ...(wakeMs === undefined ? [] : [new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), wakeMs); })]),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (done === undefined) continue;
    inflight.delete(done.id);
    journal.updatedAt = done.record.endedAt!;
    settle(done.id, done.record);
    if (done.ok) {
      deps.log(`[${NAME}] ${done.id} ok (${Math.round(done.record.durationMs! / 1000)} s, ${done.record.receipts.filter((r) => r.local).length} receipt(s))`);
    } else if (collectAll) {
      failedSteps.push(done.id);
      deps.error(`[${NAME}] ${done.id} FAILED: ${done.record.error}. QA goes on: it collects every error.`);
    } else {
      // Production: the first failure stops new starts; the steps in flight settle before the runner exits.
      prodFailed.push(done.id);
      if (inflight.size > 0) deps.error(`[${NAME}] ${done.id} FAILED: ${done.record.error}. No step starts after it; waiting for ${[...inflight.keys()].join(", ")} to settle.`);
    }
  }
  const inOrder = (list: readonly string[]) => [...list].sort((a, b) => ids.indexOf(a) - ids.indexOf(b));

  // Exit point: production stopped at a failure (every started step has settled). Resume at the first failed step in runbook order.
  if (prodFailed.length > 0) {
    const first = inOrder(prodFailed)[0]!;
    const firstIrreversible = steps[ids.indexOf(first)]!.irreversible;
    for (const id of inOrder(prodFailed)) deps.error(`[${NAME}] ${id} FAILED: ${journal.steps[id]?.error ?? "failed"}. Nothing after it ran.`);
    if (firstIrreversible) deps.error(`[${NAME}] ${first} is irreversible: read runbook section 8 (recovery matrix) before any retry.`);
    deps.error(`[${NAME}] resume with:\n  ${resumeCommand({ target: args.target!, go: args.go!, runTs, stepId: first, stageJournal: args.stageJournal })}`);
    if (!firstIrreversible) deps.error(`[${NAME}] or record the owner's acceptance of this failure, then resume at the next step:\n  ${acceptCommand({ target: args.target!, runTs, stepId: first })}`);
    return 1;
  }

  // Exit point: a watch step's anchor never passed in this run (every started step has settled).
  if (refusal !== undefined) {
    deps.error(`[${NAME}] ${refusal}`);
    return 2;
  }

  // Exit point: nothing runnable and nothing in flight, but a step waits on a future notBefore. Resume then.
  if (waiting.length > 0) {
    journal.status = runStatus(journal, ids);
    writeJournal(runDir, journal);
    for (const w of waiting) deps.log(`\n[${NAME}] ${w.id} becomes runnable at ${w.earliest.toISOString()} (${w.afterStep} ended ${w.anchorEnded} + ${w.hours} h).`);
    deps.log(`[${NAME}] resume then with:\n  ${resumeCommand({ target: args.target!, go: args.go!, runTs, stepId: waiting[0]!.id, stageJournal: args.stageJournal })}`);
    return 3;
  }

  // Exit point: the run ended (stage collects every failure and lists them here, in runbook order).
  journal.status = runStatus(journal, ids);
  if (failedSteps.length > 0) {
    const failed = inOrder(failedSteps);
    deps.error(`\n[${NAME}] ${failed.length} step(s) failed in this run, all of them listed here:`);
    for (const id of failed) {
      deps.error(`  - ${id}: ${journal.steps[id]?.error ?? "failed"}`);
      if (!steps[ids.indexOf(id)]!.irreversible) deps.error(`    or record the owner's acceptance of it:\n      ${acceptCommand({ target: args.target!, runTs, stepId: id })}`);
    }
    deps.error(`[${NAME}] after the fixes, rerun the whole QA at the new QA tip. To retry only these: resume with\n  ${resumeCommand({ target: args.target!, go: args.go!, runTs, stepId: failed[0]!, stageJournal: args.stageJournal })}`);
  }
  journal.cutoverSeconds = cutoverSeconds(journal, target.rmEnv);
  writeJournal(runDir, journal);
  const side: Side = target.rmEnv;
  if (journal.cutoverSeconds !== undefined) deps.log(`[${NAME}] cutover window ${MIGRATE_STEP[side]} to READY (${READY_STEP[side]}): ${journal.cutoverSeconds} s; the website stayed up (${PROBE_GRADE_STEP[side]})`);
  deps.log(`\n[${NAME}] run ${runTs}: ${journal.status}. Step list ${hash}. Journal ${runDir}`);
  return journal.status === "passed" || args.only !== undefined ? 0 : 1;
}

/**
 * D64: the go's ref as a commit. A stage go's commit is taken as written. A
 * production go's rc tag resolves on the control machine after a tag fetch; a
 * tag origin does not have refuses. The commit's branch is checked by the
 * caller (originProblems), once the commit is known.
 */
export async function resolveGo(go: GoRecord, deps: Pick<RunnerDeps, "collect">): Promise<{ go: ResolvedGo } | { error: string }> {
  const ref = goRef(go);
  if (go.tag === undefined) return { go: { ...go, commit: go.commit!, ref } };
  const r = await deps.collect(CONTROL_HOST, `cd ${shellQuote(CONTROL_REPO)} && git fetch -q --tags origin && git rev-parse --verify --quiet ${shellQuote(`${go.tag}^{commit}`)}`);
  const commit = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) return { error: `the go names ${go.tag}, which origin has no tag for; cut it at the stage-passed commit first (bun scripts/release/tag.ts rc --release ${go.release} --commit <stage commit>)` };
  return { go: { ...go, commit, ref } };
}

/** PURE. Why a step does not run on this target, or undefined when it runs. */
export function skipReason(step: StepTemplate, target: ReleaseTarget, breaking = false): string | undefined {
  if (step.onlyFor !== undefined && step.onlyFor !== target.rmEnv) return target.rmEnv;
  // A release that declares `breaking:` cuts over down, migrate, up: the rolling migrate and boot do not run, and the breaking steps do.
  if (breaking && BREAKING_SKIPS.includes(stepNameOf(step.id))) return "the release declares breaking: its cutover is down, migrate, up";
  if (!breaking && step.breakingOnly === true) return "the release declares no breaking: its cutover is rolling";
  return undefined;
}

type Side = "stage" | "prod";
/** The migrate under the running release, the upgrade's first irreversible step. */
const MIGRATE_STEP: Readonly<Record<Side, string>> = { stage: "Q18-migrate", prod: "C05-migrate" };
/** A release that declares `breaking:` migrates here instead (spec section 8.5): the same irreversible step, against the stopped stack. */
const BREAKING_MIGRATE_STEP: Readonly<Record<Side, string>> = { stage: "Q18c-migrate-breaking", prod: "C05c-migrate-breaking" };
/** The step whose end is READY: the soak steps count their window from it, and the soak gate grades sessions since it. */
const READY_STEP: Readonly<Record<Side, string>> = { stage: "Q23-ready", prod: "C11-ready" };
/** The step that grades the website probe. */
const PROBE_GRADE_STEP: Readonly<Record<Side, string>> = { stage: "Q25-probe-grade", prod: "C13-probe-grade" };

/** PURE. The cutover window: the migrate's start to READY's end, in seconds, once both are ok. The website stays up through it (the probe's grade). */
export function cutoverSeconds(journal: Pick<RunJournal, "steps">, side: Side): number | undefined {
  const a = [journal.steps[MIGRATE_STEP[side]], journal.steps[BREAKING_MIGRATE_STEP[side]]].find((r) => r?.status === "ok") ?? journal.steps[MIGRATE_STEP[side]];
  const b = journal.steps[READY_STEP[side]];
  if (a?.status !== "ok" || b?.status !== "ok" || !b.endedAt) return undefined;
  return Math.round((Date.parse(b.endedAt) - Date.parse(a.startedAt)) / 1000);
}

function newJournal(target: ReleaseTarget, commit: string, hash: string, ids: readonly string[], go: ResolvedGo, runTs: string, now: Date): RunJournal {
  return {
    version: 1, target: target.name, rmEnv: target.rmEnv, release: target.release, commit, ...(go.tag ? { tag: go.tag } : {}), stepListHash: hash, stepIds: ids,
    goSha256: go.sha256, runTs, startedAt: now.toISOString(), updatedAt: now.toISOString(), status: "running", steps: {},
  };
}

const SSH_OPTS = ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30"];

/** The real dependencies: ssh with stdin closed and no tty. */
export function realDeps(): RunnerDeps {
  return {
    exec(host, remote, onStdout, onStderr, timeoutMs) {
      return new Promise((done, fail) => {
        const argv = host === CONTROL_HOST ? ["sh", ["-c", remote]] as const : ["ssh", [...SSH_OPTS, host, remote]] as const;
        const child = spawn(argv[0], [...argv[1]], { stdio: ["ignore", "pipe", "pipe"] });
        let timedOut = false;
        // The bound kills the local ssh. The remote command may outlive it; the step is failed either way.
        const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs) : undefined;
        child.stdout.setEncoding("utf8").on("data", onStdout);
        child.stderr.setEncoding("utf8").on("data", onStderr);
        child.on("error", (e) => { if (timer) clearTimeout(timer); fail(e); });
        child.on("close", (code, signal) => { if (timer) clearTimeout(timer); done(timedOut ? TIMED_OUT : code ?? (signal ? 128 : 1)); });
      });
    },
    async collect(host, remote) {
      const [cmd, cmdArgs] = host === CONTROL_HOST ? ["sh", ["-c", remote]] : ["ssh", [...SSH_OPTS, host, remote]];
      const r = spawnSync(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { code: r.status ?? 1, stdout: r.stdout ?? "" };
    },
    readText(path) {
      try { return readFileSync(path, "utf8"); } catch { return undefined; }
    },
    now: () => new Date(),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    home: homedir(),
  };
}

if (import.meta.main) {
  process.exitCode = await runRelease(process.argv.slice(2), realDeps());
}
