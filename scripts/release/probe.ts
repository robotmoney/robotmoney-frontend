#!/usr/bin/env bun
// scripts/release/probe.ts — the website probe a release runs around its
// cutover (owner, 2026-10-14: the website never goes down). Control-machine
// steps, so the probe asks the public origin the way a visitor does.
//
//   bun scripts/release/probe.ts start --origin <url> --target <name> --run <run-ts>   start probing in the background, record the window start
//   bun scripts/release/probe.ts grade --target <name> --run <run-ts>                  stop the probe; exit 1 on any non-200 or gap
//
// Every PROBE_EVERY_MS the probe asks `/` and `/version.json`. The grade fails
// on any answer that is not 200, on a gap between ticks over the interval plus
// jitter, and on a probe that died (scripts/lib/rollout-probe.ts). Files live
// in the run's control journal, `<journal root>/<target>/<run-ts>/probe/`:
// probe.json (pid, window start), probe.jsonl (one line per answer) and
// grade.json.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gradeProbeReceipts, parseProbeReceipts, probeOnce } from "../lib/rollout-probe.ts";

/** How often the release probe asks. Far tighter than the 15 s rollout default: a release must show no gap a visitor would see. */
export const PROBE_EVERY_MS = 2_000;
/** Timer and network jitter allowed on top of the interval. */
export const PROBE_SLACK_MS = 3_000;
/** The paths each tick asks: the page and the identity file a page fetches. */
export const PROBE_PATHS = Object.freeze(["/", "/version.json"]);

interface ProbeState { readonly pid: number; readonly startMs: number; readonly origin: string; readonly everyMs: number }

/** The probe's directory in the run's control journal. */
export function probeDir(target: string, runTs: string, root: string = join(homedir(), ".local", "state", "robotmoney-release")): string {
  return join(root, target, runTs, "probe");
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function loop(origin: string, out: string): Promise<never> {
  for (;;) {
    const tick = Date.now();
    for (const path of PROBE_PATHS) appendFileSync(out, `${JSON.stringify({ ...(await probeOnce(new URL(path, origin).toString())), path })}\n`);
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
    if (existsSync(stateFile)) { console.log(`[probe] already running for ${target} ${runTs} (${stateFile})`); process.exit(0); }
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
    const grade = gradeProbeReceipts(receipts, { start: state.startMs, end: endMs }, state.everyMs, PROBE_SLACK_MS);
    writeFileSync(join(dir, "grade.json"), `${JSON.stringify({ ...grade, startMs: state.startMs, endMs }, null, 2)}\n`, { mode: 0o600 });
    console.log(`[probe] ${grade.receipts} answers over ${Math.round((endMs - state.startMs) / 1000)} s: ${grade.ok ? "every answer 200, no gap" : grade.problems.join("; ")}`);
    process.exit(grade.ok ? 0 : 1);
  } else {
    console.error(`unknown mode ${mode}`);
    process.exit(2);
  }
}
