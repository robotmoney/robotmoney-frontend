#!/usr/bin/env bun
// scripts/release/probe.ts — the website probe a release runs around its
// cutover (owner, 2026-10-14: the website never goes down). Control-machine
// steps, so the probe asks the public origin the way a visitor does.
//
//   bun scripts/release/probe.ts start --origin <url> --target <name> --run <run-ts>   start probing in the background, record the window start
//   bun scripts/release/probe.ts grade --target <name> --run <run-ts>                  stop the probe; exit 1 on any non-200 or gap
//
// Every PROBE_EVERY_MS the probe asks `/` and `/version.json`, and
// `/api/status/maintenance`, whose receipt records `maintenance: true` only for
// a 200 with a valid active MaintenanceStatus body (issue 1501). The grade fails
// on any site answer that is not 200, on a gap between ticks over the interval
// plus jitter, and on a probe that died (scripts/lib/rollout-probe.ts). In a
// declared maintenance window the site still answers 200 (website-server stays
// up), and the window must hold a receipt with `maintenance: true`. `start` leaves a
// live probe alone ("already running"); a probe.json whose pid is dead, or that a
// newer grade.json already stopped, is a retried run's leftover (issue 1612): it
// is moved aside and a fresh probe starts. Files live
// in the run's control journal, `<journal root>/<target>/<run-ts>/probe/`:
// probe.json (pid, window start), probe.jsonl (one line per answer) and
// grade.json.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJournal, type RunJournal } from "./journal.ts";
import { PHASES, PHASE_PREFIX, PHASE_TARGET } from "./runbook.ts";
import { gradeProbeReceipts, gradeProbeWithDeclaredWindow, parseProbeReceipts, probeMaintenance, probeOnce, type ProbeGrade, type ProbeReceipt } from "../lib/rollout-probe.ts";

/** How often the release probe asks. Far tighter than the 15 s rollout default: a release must show no gap a visitor would see. */
export const PROBE_EVERY_MS = 2_000;
/** Timer and network jitter allowed on top of the interval. */
export const PROBE_SLACK_MS = 3_000;
/** The maintenance status route: answered by the api, or by nginx from maintenance.json while the api is down. */
export const MAINTENANCE_STATUS_PATH = "/api/status/maintenance";
/** The paths each tick asks: the page, the identity file a page fetches, and the maintenance status route. */
export const PROBE_PATHS = Object.freeze(["/", "/version.json", MAINTENANCE_STATUS_PATH]);

interface ProbeState { readonly pid: number; readonly startMs: number; readonly origin: string; readonly everyMs: number }

/** The probe's directory in the run's control journal. */
export function probeDir(target: string, runTs: string, root: string = join(homedir(), ".local", "state", "robotmoney-release")): string {
  return join(root, target, runTs, "probe");
}

/** The steps that bracket a breaking cutover's declared window, by name: Q18a-maintenance-on and C05a-maintenance-on open it, Q24a-maintenance-off and C12a-maintenance-off close it. */
export const WINDOW_OPEN_NAME = "maintenance-on";
export const WINDOW_CLOSE_NAME = "maintenance-off";
/** Whether a step id belongs to a target, by its phase prefix: a production journal also holds the stage twins (Q18a, Q24a) as skipped (issue 1502). */
const onTarget = (id: string, rmEnv: RunJournal["rmEnv"]) => PHASES.some((p) => PHASE_TARGET[p] === rmEnv && id.startsWith(PHASE_PREFIX[p]));
const stepNamed = (steps: RunJournal["steps"], name: string, rmEnv: RunJournal["rmEnv"]) =>
  Object.values(steps).find((r) => onTarget(r.id, rmEnv) && r.id.replace(/^[A-Z]\d{2}[a-z]?-/, "") === name);

/**
 * PURE. The declared maintenance window a run journal holds, in epoch ms: from the start of the step that
 * puts the maintenance page on to the end of the step that takes it off, read from the run's own target's steps
 * (C05a and C12a on production, Q18a and Q24a on stage). `none` when the run did not run
 * the window steps (a rolling release: nothing is excused). An opened window that never closed is a problem.
 */
export function declaredWindow(steps: RunJournal["steps"], rmEnv: RunJournal["rmEnv"]): { window: { start: number; end: number } } | { problem: string } | "none" {
  const on = stepNamed(steps, WINDOW_OPEN_NAME, rmEnv);
  if (on === undefined || on.status === "skipped") return "none";
  if (!on.startedAt) return { problem: `${on.id} has no start time` };
  const off = stepNamed(steps, WINDOW_CLOSE_NAME, rmEnv);
  if (off?.status !== "ok" || !off.endedAt) return { problem: `the maintenance window was opened (${on.id}) and never closed (${off?.id ?? WINDOW_CLOSE_NAME} is ${off?.status ?? "absent"})` };
  return { window: { start: Date.parse(on.startedAt), end: Date.parse(off.endedAt) } };
}

/** PURE. Grade a probe: a run that declared a maintenance window excuses exactly it, any other run excuses nothing. */
export function gradeRun(receipts: readonly ProbeReceipt[], window: { start: number; end: number }, steps: RunJournal["steps"], rmEnv: RunJournal["rmEnv"], everyMs: number, slackMs: number): ProbeGrade {
  const declared = declaredWindow(steps, rmEnv);
  if (declared === "none") return gradeProbeReceipts(receipts, window, everyMs, slackMs);
  if ("problem" in declared) {
    const base = gradeProbeReceipts(receipts, window, everyMs, slackMs);
    return { ...base, ok: false, problems: [declared.problem, ...base.problems] };
  }
  return gradeProbeWithDeclaredWindow(receipts, window, declared.window, everyMs, slackMs);
}

/** Whether a pid is a running process (signal 0 only checks; EPERM still means it exists). */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * The probe a run folder holds (issue 1612). `none`: no probe.json. `live`: its pid runs and no
 * grade.json is newer than it. `stale`: its pid is dead, or a grade.json newer than it already
 * stopped it, as an earlier attempt of a retried run left it (`--run <ts> --from <step>`).
 */
export function probeStatus(dir: string, alive: (pid: number) => boolean = pidAlive): "none" | "live" | "stale" {
  const stateFile = join(dir, "probe.json");
  if (!existsSync(stateFile)) return "none";
  let pid = -1;
  try { pid = (JSON.parse(readFileSync(stateFile, "utf8")) as ProbeState).pid; } catch { return "stale"; }
  const graded = join(dir, "grade.json");
  if (existsSync(graded) && statSync(graded).mtimeMs > statSync(stateFile).mtimeMs) return "stale";
  return Number.isInteger(pid) && alive(pid) ? "live" : "stale";
}

/** Move a stale probe's probe.json, probe.jsonl and grade.json aside (suffix `.<ms>.old`), so a fresh window grades only its own answers. */
export function moveStaleProbeAside(dir: string, nowMs: number = Date.now()): string[] {
  const moved: string[] = [];
  for (const name of ["probe.json", "probe.jsonl", "grade.json"]) {
    const from = join(dir, name);
    if (!existsSync(from)) continue;
    renameSync(from, `${from}.${nowMs}.old`);
    moved.push(`${name}.${nowMs}.old`);
  }
  return moved;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function loop(origin: string, out: string): Promise<never> {
  for (;;) {
    const tick = Date.now();
    for (const path of PROBE_PATHS) {
      const url = new URL(path, origin).toString();
      appendFileSync(out, `${JSON.stringify({ ...(await (path === MAINTENANCE_STATUS_PATH ? probeMaintenance(url) : probeOnce(url))), path })}\n`);
    }
    await Bun.sleep(Math.max(0, PROBE_EVERY_MS - (Date.now() - tick)));
  }
}

if (import.meta.main) {
  const [mode] = process.argv.slice(2);
  const target = flag("--target");
  const runTs = flag("--run");
  if (mode === "loop") {
    await loop(flag("--origin")!, flag("--out")!);
  }
  if (!target || !runTs || !/^\d{8}T\d{6}Z$/.test(runTs)) {
    console.error("usage: probe.ts start --origin <url> --target <name> --run <run-ts> | grade --target <name> --run <run-ts>");
    process.exit(2);
  }
  const dir = probeDir(target, runTs, flag("--journal-root"));
  const stateFile = join(dir, "probe.json");
  if (mode === "start") {
    const origin = flag("--origin");
    if (!origin) { console.error("probe start needs --origin"); process.exit(2); }
    const existing = probeStatus(dir);
    if (existing === "live") { console.log(`[probe] already running for ${target} ${runTs} (${stateFile})`); process.exit(0); }
    if (existing === "stale") console.log(`[probe] an earlier attempt's probe is stale (dead pid or already graded); moved aside: ${moveStaleProbeAside(dir).join(", ")}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = join(dir, "probe.jsonl");
    const startMs = Date.now();
    const child = spawn(process.execPath, [import.meta.path, "loop", "--origin", origin, "--out", out], { detached: true, stdio: "ignore" });
    child.unref();
    const state: ProbeState = { pid: child.pid!, startMs, origin, everyMs: PROBE_EVERY_MS };
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    console.log(`[probe] probing ${PROBE_PATHS.map((p) => new URL(p, origin).toString()).join(" and ")} every ${PROBE_EVERY_MS / 1000} s (pid ${state.pid}); window starts ${new Date(startMs).toISOString()}`);
  } else if (mode === "grade") {
    if (!existsSync(stateFile)) { console.error(`[probe] no probe was started for ${target} ${runTs} (${stateFile})`); process.exit(1); }
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as ProbeState;
    const endMs = Date.now();
    try { process.kill(state.pid); } catch { /* already gone: the grade shows the gap */ }
    const receipts = (existsSync(join(dir, "probe.jsonl")) ? parseProbeReceipts(readFileSync(join(dir, "probe.jsonl"), "utf8")) : [])
      .filter((r) => r.at >= state.startMs && r.at <= endMs);
    // The probe's directory is <run dir>/probe: the run's journal sits beside it and says whether a window was declared.
    // With no journal there are no steps, so the target passed with them declares nothing either way.
    const journal = readJournal(dirname(dir));
    const grade = gradeRun(receipts, { start: state.startMs, end: endMs }, journal?.steps ?? {}, journal?.rmEnv ?? "prod", state.everyMs, PROBE_SLACK_MS);
    writeFileSync(join(dir, "grade.json"), `${JSON.stringify({ ...grade, startMs: state.startMs, endMs }, null, 2)}\n`, { mode: 0o600 });
    console.log(`[probe] ${grade.receipts} answers over ${Math.round((endMs - state.startMs) / 1000)} s: ${grade.ok ? "every answer 200, no gap" : grade.problems.join("; ")}`);
    process.exit(grade.ok ? 0 : 1);
  } else {
    console.error(`unknown mode ${mode}`);
    process.exit(2);
  }
}
