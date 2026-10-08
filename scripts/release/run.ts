#!/usr/bin/env bun
// `bun run release:run` — the agent-executed release runbook (D61).
//
// Runs on the CONTROL MACHINE. Every step runs on a host over ssh; no step
// needs a person at a host terminal (rule 4). The step list (./steps.ts) is the
// same for every target; only the target file differs (rule 2). Every database
// operation is a committed script with a receipt (rule 3). The operator's
// authority is one go file, read before the run (rule 1).
//
//   bun run release:run --target <stage|prod|path.json> --dry-run [--go <go file>]
//   bun run release:run --target stage --go <go file>
//   bun run release:run --target prod  --go <go file> --stage-journal <stage run dir>
//   bun run release:run --target prod  --go <go file> --stage-journal <dir> --run <run-ts> --from <step>
//   bun run release:run --target stage --go <go file> --only <step> [--run <run-ts>]
//
// What it does, in order: load and validate the target; read the go file, which
// names this release and target and is the one source of the release commit
// (a target file names none); print the plan (target, commit, step-list hash,
// every step and its remote command); stop there under --dry-run. A dry run
// without --go renders {commit} as COMMIT-FROM-GO. Otherwise: refuse without a
// go file; refuse a placeholder confirmTarget;
// under RM_ENV=prod refuse unless --stage-journal names a passed stage run of
// the same step list at the same commit (SP.8); then run the steps in order,
// journal each one locally (./journal.ts), copy its receipts back, and stop at
// the first step whose exit differs from the expected one, printing the exact
// resume command.
//
// It never prints a secret value. Output and receipts pass through
// ./scrub.ts before they reach the console or the journal.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGo, type GoRecord } from "./go.ts";
import { applyTriage, failedFindings, parseTriage } from "./triage.ts";
import {
  checkResume, checkStageJournal, firstNotOk, journalRoot, readJournal, resumeCommand, runStamp, runStatus, RUN_TS_RE,
  selectSteps, writeJournal, type ReceiptRecord, type RunJournal, type StepRecord,
} from "./journal.ts";
import { forbiddenReceiptPath, lineScrubber, scrubSecrets } from "./scrub.ts";
import {
  CONTROL_HOST, notBeforeOf, READY_PENDING, RELEASE_STEPS, renderStep, shellQuote, stepIds, stepListHash, templateValues, type RenderedStep, type StepTemplate,
} from "./steps.ts";

/** The step whose end is READY: the watch steps count their window from it, and W1 grades sessions since it. */
const READY_STEP = "R6.9";
import { confirmTargetFilled, loadTarget, type ReleaseTarget } from "./target.ts";

const NAME = "release:run";
const HERE = dirname(fileURLToPath(import.meta.url));

export interface RunnerDeps {
  /** Run a remote command; stream its output; resolve to the exit code. */
  exec(host: string, remote: string, onStdout: (s: string) => void, onStderr: (s: string) => void): Promise<number>;
  /** Run a short remote command and collect stdout (receipt listing and copy). */
  collect(host: string, remote: string): Promise<{ code: number; stdout: string }>;
  readText(path: string): string | undefined;
  now(): Date;
  log(line: string): void;
  error(line: string): void;
  home: string;
}

export interface RunArgs {
  target?: string;
  go?: string;
  dryRun: boolean;
  from?: string;
  only?: string;
  run?: string;
  stageJournal?: string;
  journalRoot?: string;
  triage?: string;
}

export function parseArgs(argv: readonly string[]): RunArgs | { error: string } {
  const out: RunArgs = { dryRun: false };
  const valued: Record<string, keyof RunArgs> = {
    "--target": "target", "--go": "go", "--from": "from", "--only": "only", "--run": "run",
    "--stage-journal": "stageJournal", "--journal-root": "journalRoot", "--triage": "triage",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") { out.dryRun = true; continue; }
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
  return out;
}

/** `stage` → scripts/release/targets/stage.json; a path is taken as given. */
export function targetPath(arg: string): string {
  return arg.includes("/") || arg.endsWith(".json") ? resolve(arg) : join(HERE, "targets", `${arg}.json`);
}

/** What `{commit}` renders as in a dry run without a go file: never a real SHA. */
export const COMMIT_FROM_GO = "COMMIT-FROM-GO";

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

/** Receipt paths a step's output names (`receipt: /path`, `receipt → /path`, `report: /path`). */
export function receiptPathsInOutput(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:receipt|report)\s*(?::|→|->)\s*(\/[^\s()]+)/gi)) out.add(m[1]!.replace(/[.,;]+$/, ""));
  return [...out];
}

async function pullReceipts(
  step: RenderedStep, stepDir: string, stdoutText: string, deps: RunnerDeps,
): Promise<{ receipts: ReceiptRecord[]; missingRequired: string[] }> {
  const receipts: ReceiptRecord[] = [];
  const missingRequired: string[] = [];
  const wanted = new Set<string>();
  for (const spec of step.receipts) {
    const listing = await deps.collect(
      step.host,
      `find ${shellQuote(spec.dir)} -maxdepth 1 -type f -name ${shellQuote(spec.pattern)} -newer ${shellQuote(step.marker)} -print 2>/dev/null; true`,
    );
    const found = listing.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (found.length === 0) {
      receipts.push({ remote: `${spec.dir}/${spec.pattern}`, missing: true });
      if (spec.required) missingRequired.push(`${spec.dir}/${spec.pattern}`);
    }
    for (const f of found) wanted.add(f);
  }
  for (const p of receiptPathsInOutput(stdoutText)) wanted.add(p);
  const dir = join(stepDir, "receipts");
  for (const remote of wanted) {
    if (forbiddenReceiptPath(remote)) {
      receipts.push({ remote, missing: true });
      continue;
    }
    const got = await deps.collect(step.host, `cat -- ${shellQuote(remote)}`);
    if (got.code !== 0) {
      receipts.push({ remote, missing: true });
      continue;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let local = join(dir, basename(remote));
    for (let n = 2; existsSync(local); n++) local = join(dir, `${n}-${basename(remote)}`);
    writeFileSync(local, scrubSecrets(got.stdout), { mode: 0o600 });
    receipts.push({ remote, local });
  }
  return { receipts, missingRequired };
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
  } else if (!args.dryRun) {
    deps.error(`[${NAME}] refusing: no --go <file>. The operator's go names the release, the commit and the target (D61 rule 1).`);
    return 2;
  }
  const commit = go?.commit ?? COMMIT_FROM_GO;
  const ids = stepIds(steps);
  const hash = stepListHash(steps);
  const root = args.journalRoot ?? journalRoot(deps.home);

  let selected: string[];
  try {
    selected = selectSteps(ids, { from: args.from, only: args.only });
  } catch (error) {
    deps.error(`[${NAME}] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const runTs = args.run ?? runStamp(deps.now());
  const values = templateValues(target, commit, runTs);
  const rendered = steps.map((s) => renderStep(s, target, values));
  deps.log(renderPlan(target, commit, hash, rendered));

  if (args.dryRun || go === undefined) {
    const from = go ? `the go's commit ${commit}` : `${COMMIT_FROM_GO} for {commit} (pass --go <file> to render the go's commit)`;
    deps.log(`\n[${NAME}] --dry-run: nothing ran. Commit: ${from}. Steps that would run: ${selected.join(", ")}`);
    return 0;
  }

  // SC.1: the signed recovery matrix the go names. A path must be readable; its sha256 is journaled.
  let recovery: { ref: string; sha256: string | null };
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(go.recovery)) recovery = { ref: go.recovery, sha256: null };
  else {
    const path = go.recovery.startsWith("~/") ? join(deps.home, go.recovery.slice(2)) : resolve(go.recovery);
    const text = deps.readText(path);
    if (text === undefined) {
      deps.error(`[${NAME}] refusing: the go names the recovery matrix ${go.recovery}, which cannot be read (SC.1).`);
      return 2;
    }
    recovery = { ref: path, sha256: createHash("sha256").update(text).digest("hex") };
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
    if (template.onlyFor !== undefined && template.onlyFor !== target.rmEnv) {
      const now = deps.now().toISOString();
      journal.steps[id] = {
        id, status: "skipped", skipped: target.rmEnv, exit: null, expectExit: template.expectExit, startedAt: now, endedAt: now,
        durationMs: 0, receipts: [], attempt: (journal.steps[id]?.attempt ?? 0) + 1,
      };
      writeFileSync(join(stepDir, "result.json"), `${JSON.stringify(journal.steps[id], null, 2)}\n`, { mode: 0o600 });
      journal.status = runStatus(journal, ids);
      writeJournal(runDir, journal);
      deps.log(`\n[${NAME}] ── ${id} skipped: ${target.rmEnv} (runs only for ${template.onlyFor})`);
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

    const out = lineScrubber();
    const err = lineScrubber();
    let stdoutText = "";
    let stderrText = "";
    let exit: number;
    try {
      exit = await deps.exec(
        step.host, step.remote,
        (s) => { const t = out.push(s); if (t) { stdoutText += t; deps.log(t.replace(/\n$/, "")); } },
        (s) => { const t = err.push(s); if (t) { stderrText += t; deps.error(t.replace(/\n$/, "")); } },
      );
    } catch (error) {
      exit = -1;
      record.error = error instanceof Error ? error.message : String(error);
    }
    stdoutText += out.end();
    stderrText += err.end();
    writeFileSync(join(stepDir, "stdout.log"), stdoutText, { mode: 0o600 });
    writeFileSync(join(stepDir, "stderr.log"), stderrText, { mode: 0o600 });

    const pulled = await pullReceipts(step, stepDir, stdoutText, deps);
    const ended = deps.now();
    record.exit = exit;
    record.endedAt = ended.toISOString();
    record.durationMs = ended.getTime() - started.getTime();
    record.receipts = pulled.receipts;
    let ok = exit === step.expectExit && pulled.missingRequired.length === 0;
    if (!ok && template.triage && exit !== step.expectExit && pulled.missingRequired.length === 0) {
      const verdict = triageStep(stepDir, args.triage, deps);
      if (verdict.accepted) {
        ok = true;
        record.triage = verdict.record;
        deps.log(`[${NAME}] ${id} exited ${exit}; every failed finding is in the owner's triage ${verdict.record.file} (sha256 ${verdict.record.sha256.slice(0, 12)}):`);
        for (const e of verdict.record.used) deps.log(`  - ${e.check}: "${e.fragment}" (${e.reason})`);
      } else if (verdict.message) record.error = verdict.message;
    }
    if (!ok && exit === step.expectExit) record.error = `required receipt missing: ${pulled.missingRequired.join(", ")}`;
    if (!ok && exit !== step.expectExit) record.error ??= `exit ${exit}, expected ${step.expectExit}`;
    record.status = ok ? "ok" : "failed";
    writeFileSync(join(stepDir, "result.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    journal.status = runStatus(journal, ids);
    journal.updatedAt = ended.toISOString();
    writeJournal(runDir, journal);

    if (!ok) {
      deps.error(`[${NAME}] ${id} FAILED: ${record.error}. Nothing after it ran.`);
      if (step.irreversible) deps.error(`[${NAME}] ${id} is irreversible: read runbook section 8 (recovery matrix) before any retry.`);
      deps.error(`[${NAME}] resume with:\n  ${resumeCommand({ target: args.target!, go: args.go!, runTs, stepId: id, stageJournal: args.stageJournal })}`);
      return 1;
    }
    deps.log(`[${NAME}] ${id} ok (${Math.round(record.durationMs / 1000)} s, ${pulled.receipts.filter((r) => r.local).length} receipt(s))`);
  }

  journal.status = runStatus(journal, ids);
  writeJournal(runDir, journal);
  deps.log(`\n[${NAME}] run ${runTs}: ${journal.status}. Step list ${hash}. Journal ${runDir}`);
  return journal.status === "passed" || args.only !== undefined ? 0 : 1;
}

/** R2.5: read the step's pulled gate report and the owner's triage file; accept only full coverage. */
function triageStep(stepDir: string, triagePath: string | undefined, deps: RunnerDeps):
  { accepted: true; record: NonNullable<StepRecord["triage"]> } | { accepted: false; message?: string } {
  const reportPath = join(stepDir, "receipts", "prod-gate-baseline.json");
  const reportText = deps.readText(reportPath);
  if (reportText === undefined) return { accepted: false, message: `the gate failed and wrote no ${reportPath} to triage` };
  let report: unknown;
  try { report = JSON.parse(reportText); } catch { return { accepted: false, message: `the gate report ${reportPath} is not JSON` }; }
  const findings = failedFindings(report) ?? [];
  const listing = findings.map((f) => `${f.check}: ${f.detail.slice(0, 160)}`).join("\n  - ");
  if (triagePath === undefined) {
    return { accepted: false, message: `the baseline gate failed. Each finding needs the owner's triage (--triage <file>, scripts/release/triage.ts):\n  - ${listing}` };
  }
  const path = triagePath.startsWith("~/") ? join(deps.home, triagePath.slice(2)) : resolve(triagePath);
  const text = deps.readText(path);
  if (text === undefined) return { accepted: false, message: `the triage file ${path} cannot be read` };
  const parsed = parseTriage(text);
  if ("errors" in parsed) return { accepted: false, message: `the triage file ${path} is malformed:\n  - ${parsed.errors.join("\n  - ")}` };
  const result = applyTriage(report, parsed.entries);
  if (!result.accepted) {
    const left = result.unmatched.map((f) => `${f.check}: ${f.detail.slice(0, 160)}`).join("\n  - ");
    return { accepted: false, message: `the triage file ${path} does not cover:\n  - ${left || "(the report names no failed check)"}` };
  }
  return {
    accepted: true,
    record: { file: path, sha256: createHash("sha256").update(text).digest("hex"), used: result.used.map((e) => ({ ...e })) },
  };
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
    exec(host, remote, onStdout, onStderr) {
      return new Promise((done, fail) => {
        const argv = host === CONTROL_HOST ? ["sh", ["-c", remote]] as const : ["ssh", [...SSH_OPTS, host, remote]] as const;
        const child = spawn(argv[0], [...argv[1]], { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.setEncoding("utf8").on("data", onStdout);
        child.stderr.setEncoding("utf8").on("data", onStderr);
        child.on("error", fail);
        child.on("close", (code, signal) => done(code ?? (signal ? 128 : 1)));
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
