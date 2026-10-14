#!/usr/bin/env bun
// scripts/release/stop-legacy.ts — release step R6.1, run ON THE TARGET HOST.
//
//   bun scripts/release/stop-legacy.ts stop --instance <name> --receipt-dir <dir>
//
// stop (R6.1, IRREVERSIBLE: the stack is down from here until R6.9). Stops
// whatever stack the instance's smoke state names (scripts/lib/smoke-state.ts,
// the record `bun smoke` wrote at its last boot), the production way:
//
//   bun run smoke:down --instance <name>
//
// which rebuilds the boot's compose environment from that record and runs
// `docker compose down` without `-v`: the volumes stay (runbook R6.1). Then it
// proves no container of the record's project remains and writes the receipt.
//
// It REFUSES (exit 1, no stop attempted) when the state names no stack: a
// release holds no fact about what runs on the host (issue 1272), so it cannot
// stop a stack it cannot name. It never drives or kills a tmux session, never
// names a compose project or a checkout of its own: those were facts of the
// v0.5.4 stack, typed into the tool once, and they are gone.
//
// The state root honours RM_SMOKE_STATE_ROOT, so a unit test points it at a
// fixture directory (scripts/tests/unit/release-run.test.ts).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instancePaths, readStackState, stateRoot, type StackStateRecord } from "../lib/smoke-state.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** PURE. The one command R6.1 runs to stop the stack: smoke's own, never `-v`. */
export function smokeDownArgv(instance: string): string[] {
  return ["bun", "run", "smoke:down", "--instance", instance];
}

/** PURE. The refusal when the state names no stack, or undefined when it names one. */
export function noStackRefusal(instance: string, stateFile: string, record: StackStateRecord | null): string | undefined {
  if (record !== null) return undefined;
  return `the smoke state of instance ${instance} names no stack (${stateFile} is absent): nothing to stop, and a release names no stack of its own`;
}

export interface StopDeps {
  /** The instance's stack record, or null when the state names none. */
  readStack(instance: string): { stateFile: string; record: StackStateRecord | null };
  /** Run argv in the checkout, output passed through; the exit code. */
  run(argv: readonly string[]): number;
  /** The names of the containers of a compose project, or null when docker cannot be asked. */
  projectContainers(project: string): string[] | null;
  log(line: string): void;
  error(line: string): void;
}

export interface StopReceipt {
  readonly step: "R6.1";
  readonly instance: string;
  readonly stateFile: string;
  readonly project: string | null;
  readonly command: string;
  readonly downExit: number | null;
  readonly containersAfter: string[] | null;
  readonly problems: string[];
}

/** The stop, with its dependencies injected. Returns the receipt; its `problems` empty means exit 0. */
export function runStop(instance: string, deps: StopDeps): StopReceipt {
  const { stateFile, record } = deps.readStack(instance);
  const argv = smokeDownArgv(instance);
  const command = argv.join(" ");
  const refusal = noStackRefusal(instance, stateFile, record);
  if (refusal !== undefined) {
    return { step: "R6.1", instance, stateFile, project: null, command, downExit: null, containersAfter: null, problems: [refusal] };
  }
  const problems: string[] = [];
  deps.log(`[stop] instance ${instance}: stack ${record!.project} (created ${record!.createdAt}); ${command}`);
  const downExit = deps.run(argv);
  if (downExit !== 0) problems.push(`${command} exited ${downExit}`);
  const after = deps.projectContainers(record!.project);
  if (after === null) problems.push("docker ps failed after smoke:down");
  else if (after.length > 0) problems.push(`containers of ${record!.project} remain: ${after.join(", ")}`);
  return { step: "R6.1", instance, stateFile, project: record!.project, command, downExit, containersAfter: after, problems };
}

function realDeps(): StopDeps {
  return {
    readStack(instance) {
      const paths = instancePaths(stateRoot(process.env), instance);
      return { stateFile: paths.stackStateFile, record: readStackState(paths) };
    },
    run(argv) {
      const r = spawnSync(argv[0]!, argv.slice(1), { stdio: ["ignore", "inherit", "inherit"] });
      return r.status ?? 1;
    },
    projectContainers(project) {
      const r = spawnSync("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"], { encoding: "utf8" });
      if (r.status !== 0) return null;
      return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    },
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  };
}

function stop(): number {
  const instance = flag("--instance");
  const receiptDir = flag("--receipt-dir");
  if (!instance || !receiptDir) {
    console.error("usage: stop-legacy.ts stop --instance NAME --receipt-dir DIR");
    return 2;
  }
  let receipt: StopReceipt;
  try {
    receipt = runStop(instance, realDeps());
  } catch (error) {
    console.error(`[stop] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = join(receiptDir, "stop-legacy.json");
  writeFileSync(file, `${JSON.stringify({ ...receipt, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(`[stop] receipt: ${file}`);
  for (const p of receipt.problems) console.error(`[stop] FAIL: ${p}`);
  return receipt.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = process.argv[2] === "stop" ? stop() : (console.error("usage: stop-legacy.ts stop --instance NAME --receipt-dir DIR"), 2);
}
