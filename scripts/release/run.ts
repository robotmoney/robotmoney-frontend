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
//   bun run release:run --target <t> --abandon <run-ts>                                  (mark a dead run failed so P.busy clears)
//
// What it does, in order: load and validate the target; read the go file, which
// names this release and target and is the one source of the release commit
// (a target file names none); print the plan (target, commit, step-list hash,
// every step and its remote command). `--preflight` (`--dry-run` is the same
// flag) needs no go: it runs every check the run needs and every step before
// the first irreversible one, changes nothing a running service uses, and
// exits 0 only when every check is green (./preflight.ts). Otherwise: refuse
// without a go file; refuse a placeholder confirmTarget;
// under RM_ENV=prod refuse unless --stage-journal names a passed stage run of
// the same step list at the same commit (SP.8); then run the steps in order,
// journal each one locally (./journal.ts), copy its receipts back, and stop at
// the first step whose exit differs from the expected one, printing the exact
// resume command.
//
// It never prints a secret value. Output and receipts pass through
// ./scrub.ts before they reach the console or the journal.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGo, type GoRecord } from "./go.ts";
import {
  checkResume, checkStageJournal, firstNotOk, journalRoot, readJournal, resumeCommand, runStamp, runStatus, RUN_TS_RE,
  selectSteps, writeJournal, type RunJournal, type StepRecord,
} from "./journal.ts";
import { checkAfterPreflight, runPreflight, type PreflightReport } from "./preflight.ts";
import { executeStep, readRecovery, TIMED_OUT, type RunnerDeps } from "./step-exec.ts";
import {
  CONTROL_HOST, notBeforeOf, READY_PENDING, RELEASE_STEPS, renderStep, shellQuote, stepIds, stepListHash, templateValues, type RenderedStep, type StepTemplate,
} from "./steps.ts";

/** The step whose end is READY: the watch steps count their window from it, and W1 grades sessions since it. */
const READY_STEP = "R6.9";
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
}

export function parseArgs(argv: readonly string[]): RunArgs | { error: string } {
  const out: RunArgs = { preflight: false };
  const valued: Record<string, keyof RunArgs> = {
    "--target": "target", "--go": "go", "--from": "from", "--only": "only", "--run": "run",
    "--stage-journal": "stageJournal", "--journal-root": "journalRoot", "--triage": "triage",
    "--after-preflight": "afterPreflight", "--abandon": "abandon",
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
    `  legacy stack  ${target.legacy.checkout} (${target.legacy.version}${target.legacy.commit ? ` at ${target.legacy.commit.slice(0, 8)}` : ""}), tmux ${target.legacy.tmuxSession}, compose project ${target.legacy.composeProject}${target.legacy.log ? `, log ${target.legacy.log}` : ""}`,
    `  release       ${target.release} at ${commit}`,
    `  confirm       ${target.confirmTarget}`,
    `  step list     ${hash}`,
    "",
  ];
  for (const s of steps) {
    const skip = s.onlyFor !== undefined && s.onlyFor !== target.rmEnv ? ` SKIPPED (only ${s.onlyFor})` : "";
    const wait = s.notBefore ? ` not before ${s.notBefore.afterStep} + ${s.notBefore.hours} h` : "";
    lines.push(`  [${s.id}]${s.irreversible ? " IRREVERSIBLE" : ""}${skip}${wait} on ${s.host}: ${s.description}`);
    if (s.standing.length > 0) lines.push(`      standing: ${s.standing.join(", ")}`);
    lines.push(s.host === CONTROL_HOST ? `      $ sh -c ${shellQuote(s.remote)}` : `      $ ssh -T ${s.host} ${shellQuote(s.remote)}`);
  }
  return lines.join("\n");
}

/** The whole run. Returns the process exit code. */
export async function runRelease(argv: readonly string[], deps: RunnerDeps, steps: readonly StepTemplate[] = RELEASE_STEPS): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    deps.error(`[${NAME}] ${args.error}`);
    return 2;
  }
  let target: ReleaseTarget;
  try {
    target = loadTarget(targetPath(args.target!));
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

  // Rule 1: the one recorded go. It is the only source of the release commit.
  let go: GoRecord | undefined;
  if (args.go) {
    const goText = deps.readText(args.go);
    if (goText === undefined) {
      deps.error(`[${NAME}] refusing: the go file ${args.go} cannot be read.`);
      return 2;
    }
    const goResult = validateGo(goText, { release: target.release, target: target.name });
    if ("errors" in goResult) {
      deps.error(`[${NAME}] refusing: the go file does not authorize this run:\n  - ${goResult.errors.join("\n  - ")}`);
      return 2;
    }
    go = goResult.go;
  } else if (!args.preflight) {
    deps.error(`[${NAME}] refusing: no --go <file>. The operator's go names the release, the commit and the target (D61 rule 1).`);
    return 2;
  }
  const ids = stepIds(steps);
  const hash = stepListHash(steps);
  const root = args.journalRoot ?? journalRoot(deps.home);
  if (args.preflight) {
    return runPreflight({
      target, go, goPath: args.go, stageJournal: args.stageJournal ? resolve(args.stageJournal) : undefined, triage: args.triage,
      steps, ids, hash, root, runTs: runStamp(deps.now()), renderPlan: (c, r) => renderPlan(target, c, hash, r),
    }, deps);
  }
  if (go === undefined) return 2;
  const commit = go.commit;

  let selected: string[];
  try {
    selected = selectSteps(ids, { from: args.from, only: args.only });
  } catch (error) {
    deps.error(`[${NAME}] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  // A run within an hour of a green preflight continues from it: same run stamp,
  // so every path the preflight's steps wrote ({runTs}) is this run's, and R1.1
  // to R2.5 are its records. Policy 4.3 holds: the dump is this run's.
  let preflight: PreflightReport | undefined;
  if (args.afterPreflight !== undefined) {
    const path = join(resolve(args.afterPreflight), "preflight.json");
    const text = deps.readText(path);
    try { preflight = text === undefined ? undefined : JSON.parse(text) as PreflightReport; } catch { preflight = undefined; }
    const refusals = checkAfterPreflight(preflight, { target: target.name, commit, stepListHash: hash, stepIds: ids }, deps.now());
    if (refusals.length > 0) {
      deps.error(`[${NAME}] refusing --after-preflight ${args.afterPreflight}:\n  - ${refusals.join("\n  - ")}`);
      return 2;
    }
  }
  const runTs = args.run ?? preflight?.runTs ?? runStamp(deps.now());
  const values = templateValues(target, commit, runTs);
  const rendered = steps.map((s) => renderStep(s, target, values));
  deps.log(renderPlan(target, commit, hash, rendered));

  // SC.1: the signed recovery matrix the go names. A path must be readable; its sha256 is journaled.
  const recovery = readRecovery(go, deps);
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
    const refusals = checkStageJournal(stage, { stepListHash: hash, commit, stepIds: ids });
    if (refusals.length > 0) {
      deps.error(`[${NAME}] refusing:\n  - ${refusals.join("\n  - ")}`);
      return 2;
    }
    stageRecord = { path: resolve(args.stageJournal!), runTs: stage!.runTs, stepListHash: stage!.stepListHash, commit: stage!.commit };
  }

  const runDir = join(root, target.name, runTs);
  let journal: RunJournal;
  if (args.run !== undefined) {
    const existing = readJournal(runDir);
    if (existing === undefined && args.from !== undefined) {
      deps.error(`[${NAME}] refusing: no journal at ${runDir} to resume.`);
      return 2;
    }
    if (existing !== undefined) {
      const refusals = checkResume(existing, { target: target.name, commit, stepListHash: hash, goSha256: go.sha256, stepIds: ids }, { from: args.from, only: args.only });
      if (refusals.length > 0) {
        deps.error(`[${NAME}] refusing to resume ${runDir}:\n  - ${refusals.join("\n  - ")}`);
        return 2;
      }
      journal = existing;
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
  writeJournal(runDir, journal);
  deps.log(`\n[${NAME}] go ${go.sha256.slice(0, 12)} for ${go.release} ${go.commit} on ${go.target}; journal ${runDir}`);

  for (const id of selected) {
    const template = steps[ids.indexOf(id)]!;
    const stepDir = join(runDir, id);
    mkdirSync(stepDir, { recursive: true, mode: 0o700 });

    // A prod-only step (the release tags) is recorded skipped on any other policy.
    // A capture step whose checkout is the target's is recorded skipped too (stage).
    const skip = skipReason(template, target);
    if (skip !== undefined) {
      const now = deps.now().toISOString();
      journal.steps[id] = {
        id, status: "skipped", skipped: skip, exit: null, expectExit: template.expectExit, startedAt: now, endedAt: now,
        durationMs: 0, receipts: [], attempt: (journal.steps[id]?.attempt ?? 0) + 1,
      };
      writeFileSync(join(stepDir, "result.json"), `${JSON.stringify(journal.steps[id], null, 2)}\n`, { mode: 0o600 });
      journal.status = runStatus(journal, ids);
      writeJournal(runDir, journal);
      deps.log(`\n[${NAME}] ── ${id} skipped: ${skip}${template.onlyFor ? ` (runs only for ${template.onlyFor})` : ""}`);
      continue;
    }

    // A watch step waits for its window after READY (the target's watchHours).
    const notBefore = notBeforeOf(template, target);
    if (notBefore !== undefined) {
      const anchor = journal.steps[notBefore.afterStep];
      if (anchor?.status !== "ok" || !anchor.endedAt) {
        deps.error(`[${NAME}] ${id} runs only after ${notBefore.afterStep} passed in this run; it has not.`);
        return 2;
      }
      const earliest = new Date(Date.parse(anchor.endedAt) + notBefore.hours * 3_600_000);
      if (deps.now().getTime() < earliest.getTime()) {
        journal.status = runStatus(journal, ids);
        writeJournal(runDir, journal);
        deps.log(`\n[${NAME}] ${id} becomes runnable at ${earliest.toISOString()} (${notBefore.afterStep} ended ${anchor.endedAt} + ${notBefore.hours} h).`);
        deps.log(`[${NAME}] resume then with:\n  ${resumeCommand({ target: args.target!, go: args.go!, runTs, stepId: id, stageJournal: args.stageJournal })}`);
        return 3;
      }
    }

    const readyIso = journal.steps[READY_STEP]?.status === "ok" ? journal.steps[READY_STEP]!.endedAt : undefined;
    const step = renderStep(template, target, templateValues(target, commit, runTs, readyIso ?? READY_PENDING));
    const started = deps.now();
    const record: StepRecord = {
      id, status: "running", exit: null, expectExit: step.expectExit, startedAt: started.toISOString(),
      receipts: [], attempt: (journal.steps[id]?.attempt ?? 0) + 1,
    };
    journal.steps[id] = record;
    journal.status = "running";
    journal.updatedAt = started.toISOString();
    writeJournal(runDir, journal);
    deps.log(`\n[${NAME}] ── ${id}${step.irreversible ? " (IRREVERSIBLE)" : ""} on ${step.host}: ${step.description}`);

    const ok = await executeStep(step, template.triage, record, started, stepDir, args.triage, deps);
    writeFileSync(join(stepDir, "result.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    journal.status = runStatus(journal, ids);
    journal.updatedAt = record.endedAt!;
    writeJournal(runDir, journal);

    if (!ok) {
      deps.error(`[${NAME}] ${id} FAILED: ${record.error}. Nothing after it ran.`);
      if (step.irreversible) deps.error(`[${NAME}] ${id} is irreversible: read runbook section 8 (recovery matrix) before any retry.`);
      deps.error(`[${NAME}] resume with:\n  ${resumeCommand({ target: args.target!, go: args.go!, runTs, stepId: id, stageJournal: args.stageJournal })}`);
      return 1;
    }
    deps.log(`[${NAME}] ${id} ok (${Math.round(record.durationMs! / 1000)} s, ${record.receipts.filter((r) => r.local).length} receipt(s))`);
  }

  journal.status = runStatus(journal, ids);
  journal.downtimeSeconds = downtimeSeconds(journal);
  writeJournal(runDir, journal);
  if (journal.downtimeSeconds !== undefined) deps.log(`[${NAME}] downtime window R6.1 to R6.9: ${journal.downtimeSeconds} s`);
  deps.log(`\n[${NAME}] run ${runTs}: ${journal.status}. Step list ${hash}. Journal ${runDir}`);
  return journal.status === "passed" || args.only !== undefined ? 0 : 1;
}

/** PURE. Why a step does not run on this target, or undefined when it runs. */
export function skipReason(step: StepTemplate, target: ReleaseTarget): string | undefined {
  if (step.onlyFor !== undefined && step.onlyFor !== target.rmEnv) return target.rmEnv;
  if (step.sameCheckoutAs !== undefined && target.capture.host === target.host && target.capture.checkout === target.checkout) {
    return `same checkout as ${step.sameCheckoutAs} (${target.host}:${target.checkout})`;
  }
  return undefined;
}

/** PURE. The downtime window: R6.1's start to R6.9's end, in seconds, once both are ok. */
export function downtimeSeconds(journal: Pick<RunJournal, "steps">): number | undefined {
  const a = journal.steps["R6.1"];
  const b = journal.steps[READY_STEP];
  if (a?.status !== "ok" || b?.status !== "ok" || !b.endedAt) return undefined;
  return Math.round((Date.parse(b.endedAt) - Date.parse(a.startedAt)) / 1000);
}

function newJournal(target: ReleaseTarget, commit: string, hash: string, ids: readonly string[], go: GoRecord, runTs: string, now: Date): RunJournal {
  return {
    version: 1, target: target.name, rmEnv: target.rmEnv, release: target.release, commit, stepListHash: hash, stepIds: ids,
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
