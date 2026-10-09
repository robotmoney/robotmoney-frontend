// scripts/release/preflight.ts — `bun run release:run --preflight` (`--dry-run`
// is the same flag): every check the run needs green, before the go.
//
// A preflight changes nothing a running service uses, on any host, and needs
// no go file. It reports each check green, red or pending, and exits 0 only
// when none is red:
//
//   local, on the control machine
//     P.target     confirmTarget is filled in (the run refuses the placeholder)
//     P.go         the go file is valid for this release and target. Pending without --go
//     P.recovery   the go's signed recovery matrix is readable (SC.1). Pending without --go
//     P.commit     the commit (the go's, else the control checkout's HEAD) is the
//                  control checkout's clean HEAD, so the printed step list is that commit's
//     P.origin     the commit is on a branch of origin (R1.1 fetches it there)
//     P.ci         CI on the commit: every check run completed and green, and each
//                  required workflow present (runbook R0, standing SP.7)
//     P.stage      prod only: a passed stage journal of this step list at this
//                  commit exists (SP.8). Its path is what --stage-journal takes
//     P.live       the release checkout on each host is not the one a running
//                  compose project was started from
//     P.busy       no run of this target is in flight in the journal root: its
//                  steps share the checkouts, the capture directory and the
//                  restore container a preflight would use
//
//   remote, the steps before the first irreversible one (R1.1 to R2.5)
//     Each runs exactly as the run runs it, through ./step-exec.ts: the same
//     command, receipts, bound and triage rule. None stops a service or writes
//     a database: a checkout and an install in the release checkout, a dump
//     from the read replica into a new directory, a restore into a throwaway
//     container, and read-only queries and log reads. A control-machine step
//     (the rc tag push) is not run. The steps run lane by lane, a lane being
//     one host and one checkout path: the cheap lanes first (the legacy gate,
//     then the target checkout), the capture lane with its 10 min dump last,
//     so a red R2.5 shows in seconds. Within a lane the run's order holds.
//     After a failed step, the rest of its lane is reported blocked.
//
// The journal is `<journal root>/<target>/preflight-<ts>/`: preflight.json
// (the checks and every step's record), the full plan, and each step's logs
// and receipts. It is never a run journal, so neither SP.8 nor a resume can
// take it for one. A run started within an hour with `--after-preflight <dir>`
// continues from it instead of repeating R1.1 to R2.5 (./run.ts).
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoRecord } from "./go.ts";
import { checkStageJournal, readJournal, RUN_TS_RE, type StepRecord } from "./journal.ts";
import { executeStep, readRecovery, type RunnerDeps } from "./step-exec.ts";
import { skipReason } from "./run.ts";
import { CONTROL_HOST, CONTROL_REPO, renderStep, shellQuote, templateValues, type RenderedStep, type StepTemplate } from "./steps.ts";
import { confirmTargetFilled, type ReleaseTarget } from "./target.ts";

const NAME = "release:run";

export type CheckStatus = "green" | "red" | "pending" | "blocked";

export interface PreflightCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** The CI workflows the go needs green (runbook R0). `e2e` covers every `e2e-*` workflow. */
export const REQUIRED_CI = Object.freeze(["e2e", "unit", "backend", "integration", "contract", "web-client", "repo-guards", "docs-lint"]);

const CI_OK = new Set(["success", "skipped", "neutral"]);

/** PURE. Every reason the check runs (`name\tstatus\tconclusion` lines) are not a green CI. */
export function ciProblems(lines: readonly string[]): string[] {
  const runs = lines.map((l) => l.split("\t")).filter((p) => p[0]).map(([name, status, conclusion]) => ({ name: name!, status: status ?? "", conclusion: conclusion ?? "" }));
  if (runs.length === 0) return ["no check run on the commit: CI never ran there"];
  const out: string[] = [];
  for (const r of REQUIRED_CI) {
    if (!runs.some((x) => x.name === r || x.name.startsWith(`${r}-`))) out.push(`no ${r} check run`);
  }
  for (const x of runs) {
    if (x.status !== "completed") out.push(`${x.name} is ${x.status}`);
    else if (!CI_OK.has(x.conclusion)) out.push(`${x.name} concluded ${x.conclusion}`);
  }
  return [...new Set(out)];
}

/**
 * The steps a preflight runs: every remote step before the first irreversible
 * one. PURE.
 */
export function preflightSteps(steps: readonly StepTemplate[]): StepTemplate[] {
  const first = steps.findIndex((s) => s.irreversible);
  return steps.slice(0, first < 0 ? steps.length : first).filter((s) => s.host !== "control");
}

/** PURE. A step's lane: the host and the checkout path it runs in. */
export function laneOf(step: Pick<StepTemplate, "host" | "checkout">, target: ReleaseTarget): string {
  if (step.host === "capture") return `${target.capture.host}:${target.capture.checkout}`;
  return `${target.host}:${step.checkout === "legacy" ? target.legacy.checkout : target.checkout}`;
}

/**
 * PURE. The preflight's order: lanes from cheapest to dearest (legacy gate,
 * target checkout, capture), each lane in the run's order. The capture lane
 * is never the target's: the target schema refuses a capture checkout that is
 * the target's own checkout (./target.ts, captureCheckoutProblems).
 */
export function preflightOrder(steps: readonly StepTemplate[], target: ReleaseTarget): StepTemplate[] {
  const rank = (s: StepTemplate) => (s.checkout === "legacy" ? 0 : s.host === "capture" ? 2 : 1);
  const lanes = new Map<string, { rank: number; steps: StepTemplate[] }>();
  for (const s of preflightSteps(steps)) {
    const key = laneOf(s, target);
    const lane = lanes.get(key) ?? { rank: rank(s), steps: [] };
    lane.rank = Math.min(lane.rank, rank(s));
    lane.steps.push(s);
    lanes.set(key, lane);
  }
  return [...lanes.values()].sort((a, b) => a.rank - b.rank).flatMap((l) => l.steps);
}

/** The preflight.json a run may continue from. */
export interface PreflightReport {
  readonly kind: "preflight";
  readonly target: string;
  readonly rmEnv: "stage" | "prod";
  readonly release: string;
  readonly commit: string;
  readonly stepListHash: string;
  readonly goSha256: string | null;
  readonly runTs: string;
  readonly at: string;
  readonly exit: number;
  readonly checks: readonly PreflightCheck[];
  readonly steps: Readonly<Record<string, StepRecord>>;
}

/** How long a green preflight stays usable by `--after-preflight`. */
export const PREFLIGHT_MAX_AGE_MS = 60 * 60_000;

/** PURE. Every reason a run may not continue from this preflight. */
export function checkAfterPreflight(
  report: PreflightReport | undefined,
  expected: { target: string; commit: string; stepListHash: string; stepIds: readonly string[] },
  now: Date,
): string[] {
  if (report === undefined || report.kind !== "preflight") return ["no preflight.json was found there"];
  const out: string[] = [];
  if (report.target !== expected.target) out.push(`the preflight was of ${report.target}, this run is ${expected.target}`);
  if (report.commit !== expected.commit) out.push(`the preflight was at ${report.commit}, the go names ${expected.commit}`);
  if (report.stepListHash !== expected.stepListHash) out.push(`the preflight used step list ${report.stepListHash.slice(0, 12)}; this run is ${expected.stepListHash.slice(0, 12)}`);
  const age = now.getTime() - Date.parse(report.at);
  if (!(age >= 0 && age <= PREFLIGHT_MAX_AGE_MS)) out.push(`the preflight ended ${report.at}, more than ${PREFLIGHT_MAX_AGE_MS / 60_000} min ago (policy 4.3: a fresh dump per run)`);
  const notGreen = report.checks.filter((c) => c.status === "red" || c.status === "blocked").map((c) => c.id);
  if (notGreen.length > 0) out.push(`the preflight was not green: ${notGreen.join(", ")}`);
  for (const id of expected.stepIds) {
    const r = report.steps[id];
    if (r === undefined) continue;
    if (r.status !== "ok" && r.status !== "skipped") out.push(`preflight step ${id} is ${r.status}`);
  }
  return out;
}

/** PURE. Exit 0 when no check is red or blocked. */
export function preflightExit(checks: readonly PreflightCheck[]): number {
  return checks.some((c) => c.status === "red" || c.status === "blocked") ? 2 : 0;
}

/** The runs of `target` under `root` whose journal reads running, newest first. */
export function runsInFlight(root: string, target: string): { runTs: string; updatedAt: string }[] {
  const dir = join(root, target);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => RUN_TS_RE.test(n)).sort().reverse(); } catch { return []; }
  return names.map((n) => readJournal(join(dir, n))).filter((j) => j?.status === "running").map((j) => ({ runTs: j!.runTs, updatedAt: j!.updatedAt }));
}

/** The passed stage journals under `root` for this step list and commit, newest first. */
export function passedStageJournals(root: string, hash: string, commit: string, ids: readonly string[]): string[] {
  const dir = join(root, "stage");
  let names: string[];
  try { names = readdirSync(dir).filter((n) => RUN_TS_RE.test(n)).sort().reverse(); } catch { return []; }
  return names.map((n) => join(dir, n)).filter((p) => checkStageJournal(readJournal(p), { stepListHash: hash, commit, stepIds: ids }).length === 0);
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const inRepo = (cmd: string) => `cd ${shellQuote(CONTROL_REPO)} && ${cmd}`;

export interface PreflightInput {
  readonly target: ReleaseTarget;
  readonly go: GoRecord | undefined;
  readonly goPath: string | undefined;
  readonly stageJournal: string | undefined;
  readonly triage: string | undefined;
  readonly steps: readonly StepTemplate[];
  readonly ids: readonly string[];
  readonly hash: string;
  readonly root: string;
  readonly runTs: string;
  readonly renderPlan: (commit: string, rendered: readonly RenderedStep[]) => string;
}

/** The preflight. Returns the process exit code. */
export async function runPreflight(input: PreflightInput, deps: RunnerDeps): Promise<number> {
  const { target, go, hash, ids } = input;
  const checks: PreflightCheck[] = [];
  const add = (id: string, status: CheckStatus, detail: string) => {
    checks.push({ id, status, detail });
    deps.log(`  ${status.toUpperCase().padEnd(7)} ${id.padEnd(10)} ${detail}`);
  };
  deps.log(`[${NAME}] preflight of ${target.release} on ${target.name} (${target.host}); nothing a running service uses changes`);

  add("P.target", confirmTargetFilled(target) ? "green" : "red",
    confirmTargetFilled(target) ? `confirmTarget ${target.confirmTarget}` : `confirmTarget is the placeholder: write host:port/database from ${target.host}:${target.home}/.env into the target file`);
  if (go) add("P.go", "green", `${input.goPath}: ${go.release} at ${go.commit} on ${go.target} (sha256 ${go.sha256.slice(0, 12)})`);
  else add("P.go", "pending", "no --go: the run needs the owner's go file (D61 rule 1)");
  if (go) {
    const rec = readRecovery(go, deps);
    add("P.recovery", "error" in rec ? "red" : "green", "error" in rec ? rec.error : `${rec.ref}${rec.sha256 ? ` (sha256 ${rec.sha256.slice(0, 12)})` : ""}`);
  } else add("P.recovery", "pending", "named by the go: the signed recovery matrix (SC.1)");

  // The commit: the go's, else the control checkout's HEAD as the candidate.
  const head = (await deps.collect(CONTROL_HOST, inRepo("git rev-parse HEAD"))).stdout.trim();
  const dirty = lines((await deps.collect(CONTROL_HOST, inRepo("git status --porcelain"))).stdout);
  const commit = go?.commit ?? head;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    add("P.commit", "red", `the control checkout ${CONTROL_REPO} has no readable HEAD`);
  } else if (head !== commit) {
    add("P.commit", "red", `the control checkout is at ${head || "(unreadable)"}, the go names ${commit}: the step list printed here is not the commit's. Check out the go's commit`);
  } else if (dirty.length > 0) {
    add("P.commit", "red", `the control checkout has ${dirty.length} uncommitted change(s): the step list printed here is not the commit's`);
  } else add("P.commit", "green", `${commit}${go ? "" : " (the control checkout's HEAD; the go must name it)"}`);

  if (/^[0-9a-f]{40}$/.test(commit)) {
    const branches = await deps.collect(CONTROL_HOST, inRepo(`git fetch -q origin && git branch -r --contains ${commit}`));
    const on = lines(branches.stdout);
    add("P.origin", branches.code === 0 && on.length > 0 ? "green" : "red",
      branches.code === 0 && on.length > 0 ? `on ${on.join(", ")}` : `${commit} is on no branch of origin: push it, R1.1 fetches it from there`);
    const ci = await deps.collect(CONTROL_HOST, inRepo(`gh api ${shellQuote(`repos/{owner}/{repo}/commits/${commit}/check-runs?per_page=100`)} --paginate --jq '.check_runs[] | "\\(.name)\\t\\(.status)\\t\\(.conclusion)"'`));
    if (ci.code !== 0) add("P.ci", "red", "gh could not read the commit's check runs");
    else {
      const problems = ciProblems(lines(ci.stdout));
      add("P.ci", problems.length === 0 ? "green" : "red", problems.length === 0 ? `${lines(ci.stdout).length} check runs green, ${REQUIRED_CI.join(", ")} present` : problems.join("; "));
    }
    if (target.rmEnv === "prod") {
      if (input.stageJournal) {
        const sj = readJournal(input.stageJournal);
        const refusals = checkStageJournal(sj, { stepListHash: hash, commit, stepIds: ids });
        add("P.stage", refusals.length === 0 ? "green" : "red", refusals.length === 0
          ? `${input.stageJournal} passed at this commit and step list${sj?.downtimeSeconds !== undefined ? `; its downtime window R6.1 to R6.9 was ${sj.downtimeSeconds} s` : ""}`
          : refusals.join("; "));
      } else {
        const passed = passedStageJournals(input.root, hash, commit, ids);
        const dt = passed.length > 0 ? readJournal(passed[0]!)?.downtimeSeconds : undefined;
        add("P.stage", passed.length > 0 ? "green" : "red", passed.length > 0
          ? `passed stage run ${passed[0]} (pass it as --stage-journal)${dt !== undefined ? `; its downtime window R6.1 to R6.9 was ${dt} s` : ""}`
          : `no passed stage run of step list ${hash.slice(0, 12)} at ${commit.slice(0, 8)} under ${join(input.root, "stage")} (SP.8)`);
      }
    }
  }

  // No run of this target may be in flight: its steps use the same checkouts and containers.
  const busy = runsInFlight(input.root, target.name);
  if (busy.length > 0) add("P.busy", "red", `run ${busy.map((b) => `${b.runTs} (updated ${b.updatedAt})`).join(", ")} of ${target.name} is in flight: wait for it to end, or mark a dead one`);
  else add("P.busy", "green", `no ${target.name} run in flight under ${join(input.root, target.name)}`);

  // The release checkouts must not be live: a running compose project started from one.
  // (The target schema already refuses a release checkout that is the legacy one.)
  const live = new Set<string>();
  for (const [role, host, checkout] of [["target", target.host, target.checkout], ["capture", target.capture.host, target.capture.checkout]] as const) {
    const probe = await deps.collect(host, `docker ps -q --filter ${shellQuote(`label=com.docker.compose.project.working_dir=${checkout}`)} | wc -l`);
    const n = Number(probe.stdout.trim());
    if (probe.code !== 0 || !Number.isFinite(n)) {
      add(`P.live.${role}`, "red", `cannot ask ${host} which containers run from ${checkout} (ssh or docker failed)`);
      live.add(role);
    } else if (n > 0) {
      add(`P.live.${role}`, "red", `${n} running container(s) on ${host} were started from ${checkout}: a preflight never moves a live checkout`);
      live.add(role);
    } else add(`P.live.${role}`, "green", `no running container on ${host} was started from ${checkout}`);
  }

  // The remote steps before the first irreversible one, judged as the run judges them.
  const dir = join(input.root, target.name, `preflight-${input.runTs}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const runnable = /^[0-9a-f]{40}$/.test(commit);
  const values = templateValues(target, runnable ? commit : "COMMIT-UNKNOWN", input.runTs);
  writeFileSync(join(dir, "plan.txt"), `${input.renderPlan(commit || "COMMIT-UNKNOWN", input.steps.map((s) => renderStep(s, target, values)))}\n`, { mode: 0o600 });
  const blockedBy = new Map<string, string>();
  const stepRecords: Record<string, StepRecord> = {};
  for (const template of preflightOrder(input.steps, target)) {
    const lane = laneOf(template, target);
    const skip = skipReason(template, target);
    if (skip !== undefined) {
      const now = deps.now().toISOString();
      stepRecords[template.id] = { id: template.id, status: "skipped", skipped: skip, exit: null, expectExit: template.expectExit, startedAt: now, endedAt: now, durationMs: 0, receipts: [], attempt: 1 };
      add(template.id, "green", `skipped: ${skip}`);
      continue;
    }
    const why = !runnable ? "no commit to check out"
      : busy.length > 0 ? "P.busy is red"
      : template.checkout !== "legacy" && live.has(template.host) ? `P.live.${template.host} is red`
      : blockedBy.get(lane);
    if (why !== undefined) {
      add(template.id, "blocked", `not run: ${why}`);
      continue;
    }
    const step = renderStep(template, target, values);
    const stepDir = join(dir, template.id);
    mkdirSync(stepDir, { recursive: true, mode: 0o700 });
    const started = deps.now();
    const record: StepRecord = { id: template.id, status: "running", exit: null, expectExit: step.expectExit, startedAt: started.toISOString(), receipts: [], attempt: 1 };
    deps.log(`\n[${NAME}] ── preflight ${template.id} on ${step.host}: ${step.description}`);
    const ok = await executeStep(step, template.triage, record, started, stepDir, input.triage, deps);
    stepRecords[template.id] = record;
    writeFileSync(join(stepDir, "result.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    if (ok) add(template.id, "green", `${Math.round((record.durationMs ?? 0) / 1000)} s${record.triage ? `, findings covered by the triage ${record.triage.file}` : ""}`);
    else {
      add(template.id, "red", record.error ?? "failed");
      blockedBy.set(lane, `${template.id} failed`);
    }
  }

  const exit = preflightExit(checks);
  const counts = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  const report: PreflightReport = {
    kind: "preflight", target: target.name, rmEnv: target.rmEnv, release: target.release, commit, stepListHash: hash,
    goSha256: go?.sha256 ?? null, runTs: input.runTs, at: deps.now().toISOString(), exit, checks, steps: stepRecords,
  };
  writeFileSync(join(dir, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  deps.log(`\n[${NAME}] preflight ${exit === 0 ? "GREEN" : "RED"}: ${counts("green")} green, ${counts("red")} red, ${counts("blocked")} blocked, ${counts("pending")} pending. Step list ${hash}. Journal ${dir}`);
  if (exit === 0 && runnable) deps.log(`[${NAME}] a run started within ${PREFLIGHT_MAX_AGE_MS / 60_000} min continues from it: --go <file> --after-preflight ${dir}`);
  for (const c of checks.filter((x) => x.status === "red" || x.status === "blocked" || x.status === "pending")) deps.log(`  ${c.status.toUpperCase().padEnd(7)} ${c.id}: ${c.detail}`);
  return exit;
}
