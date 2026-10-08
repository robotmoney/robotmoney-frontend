// scripts/release/step-exec.ts — run one rendered step and judge it, for the
// release run (./run.ts) and its preflight (./preflight.ts).
//
// One step: run its command over ssh (or on the control machine), scrub its
// output, write stdout.log and stderr.log, copy back the receipts it wrote,
// and decide ok or failed. A baseline gate (R2.5) that exits non-zero is ok
// only when the owner's triage file covers every failed finding. The run and
// the preflight share this code, so a step the preflight saw green is judged
// by the same rule in the run.
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { GoRecord } from "./go.ts";
import type { ReceiptRecord, StepRecord } from "./journal.ts";
import { forbiddenReceiptPath, lineScrubber, scrubSecrets } from "./scrub.ts";
import { shellQuote, type RenderedStep } from "./steps.ts";
import { applyTriage, failedFindings, parseTriage } from "./triage.ts";

const NAME = "release:run";

/** The exit `exec` reports when it killed the command at the step's bound. */
export const TIMED_OUT = 124;

export interface RunnerDeps {
  /** Run a remote command; stream its output; resolve to the exit code. */
  exec(host: string, remote: string, onStdout: (s: string) => void, onStderr: (s: string) => void, timeoutMs?: number): Promise<number>;
  /** Run a short remote command and collect stdout (receipt listing and copy). */
  collect(host: string, remote: string): Promise<{ code: number; stdout: string }>;
  readText(path: string): string | undefined;
  now(): Date;
  log(line: string): void;
  error(line: string): void;
  home: string;
}

/** Receipt paths a step's output names (`receipt: /path`, `receipt → /path`, `report: /path`). */
export function receiptPathsInOutput(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:receipt|report)\s*(?::|→|->)\s*(\/[^\s()]+)/gi)) out.add(m[1]!.replace(/[.,;]+$/, ""));
  return [...out];
}

export async function pullReceipts(
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

/** SC.1: the signed recovery matrix the go names. A path must be readable; its sha256 is journaled. */
export function readRecovery(go: GoRecord, deps: Pick<RunnerDeps, "readText" | "home">):
  { ref: string; sha256: string | null } | { error: string } {
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(go.recovery)) return { ref: go.recovery, sha256: null };
  const path = go.recovery.startsWith("~/") ? join(deps.home, go.recovery.slice(2)) : resolve(go.recovery);
  const text = deps.readText(path);
  if (text === undefined) return { error: `the go names the recovery matrix ${go.recovery}, which cannot be read (SC.1)` };
  return { ref: path, sha256: createHash("sha256").update(text).digest("hex") };
}

/**
 * Run one rendered step and fill `record` (exit, receipts, triage, error,
 * status). Returns whether the step is ok. The caller journals the record.
 */
export async function executeStep(
  step: RenderedStep, triageGate: boolean | undefined, record: StepRecord, started: Date,
  stepDir: string, triagePath: string | undefined, deps: RunnerDeps,
): Promise<boolean> {
  const id = step.id;
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
        step.maxMillis,
      );
      if (exit === TIMED_OUT) record.error = `timed out after ${Math.round(step.maxMillis / 60_000)} min (the step's maxMinutes); the remote command was killed`;
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
    if (!ok && triageGate && exit !== step.expectExit && pulled.missingRequired.length === 0) {
      const verdict = triageStep(stepDir, triagePath, deps);
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
  return ok;
}

/** R2.5: read the step's pulled gate report and the owner's triage file; accept only full coverage. */
export function triageStep(stepDir: string, triagePath: string | undefined, deps: RunnerDeps):
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
