#!/usr/bin/env bun
// `bun run release:supervise` — keeps one stage run alive and reported (issue
// 1555; policy section 4.4.1).
//
//   bun run release:supervise --target stage --go <go file> [--run <run-ts>] [--journal-root <dir>]
//
// It starts itself detached (setsid, stdin closed, output to
// `<journal root>/stage/supervise-<run-ts>.log`), so it outlives the shell or
// agent session that launched it. Without --run it picks the run stamp, and
// every child it starts runs `release:run --target <t> --go <go> --run <run-ts>`:
// one supervisor writes one run.
//
// On a child's exit 3 (a watch step's notBefore) it reads `pausedUntil` from
// run.json, sleeps until then, and resumes the same run. Any other exit ends it.
// A child killed by a signal, a child that exits without recording a stop
// (no stopReason and no refused-<ts>.json since it started), or a run.json that
// says `running` with a heartbeat older than 10 minutes, is a died driver: one
// `died` notification naming the last step and the resume command. It never
// restarts a died run. Stage only: production runs have no supervisor.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { journalRoot, readJournal, resumeCommand, runStamp, RUN_TS_RE, type RunJournal, type StopReason } from "./journal.ts";
import { notify, type NotifyResult, type StopEvent } from "./notify.ts";
import { realDeps, targetPath } from "./run.ts";
import { CONTROL_REPO } from "./steps.ts";
import { loadTarget } from "./target.ts";

const NAME = "release:supervise";

/** A heartbeat older than this, on a run that says `running`, is a dead driver. */
export const STALE_HEARTBEAT_MS = 10 * 60_000;
/** How often the supervisor reads run.json while a child runs. */
export const POLL_MS = 60_000;

export interface SuperviseArgs {
  target: string;
  go: string;
  run?: string;
  journalRoot?: string;
}

export function parseSuperviseArgs(argv: readonly string[]): SuperviseArgs | { error: string } {
  const out: Partial<SuperviseArgs> = {};
  const valued: Record<string, keyof SuperviseArgs> = { "--target": "target", "--go": "go", "--run": "run", "--journal-root": "journalRoot" };
  for (let i = 0; i < argv.length; i++) {
    const key = valued[argv[i]!];
    if (!key) return { error: `unknown argument "${argv[i]}"` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${argv[i]} needs a value` };
    out[key] = v;
    i++;
  }
  if (!out.target) return { error: "--target stage is required" };
  if (!out.go) return { error: "--go <go file> is required" };
  if (out.run !== undefined && !RUN_TS_RE.test(out.run)) return { error: `--run takes a run stamp like 20261008T142233Z, got "${out.run}"` };
  return out as SuperviseArgs;
}

export interface ChildExit {
  code: number | null;
  signal: string | null;
}

export interface SuperviseDeps {
  /** Run `release:run` with these arguments; resolve when it exits. */
  runChild(args: readonly string[]): Promise<ChildExit>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Call `fn` every `ms` until the returned stop is called. */
  every(ms: number, fn: () => void): () => void;
  notify(event: StopEvent): Promise<NotifyResult>;
  log(line: string): void;
  error(line: string): void;
  home: string;
}

/** PURE. run.json says running and its heartbeat is more than 10 minutes old. */
export function staleHeartbeat(journal: Pick<RunJournal, "status" | "heartbeatAt"> | undefined, now: Date): boolean {
  if (journal?.status !== "running" || journal.heartbeatAt === undefined) return false;
  return now.getTime() - Date.parse(journal.heartbeatAt) > STALE_HEARTBEAT_MS;
}

/** PURE. Why a child's exit is a died driver, or undefined when it recorded its stop. */
export function diedReason(exit: ChildExit, stop: StopReason | undefined, startedAt: Date, refusedSince: boolean): string | undefined {
  if (exit.signal !== null) return `the driver was killed by ${exit.signal}`;
  const recorded = refusedSince || (stop !== undefined && Date.parse(stop.at) >= startedAt.getTime());
  return recorded ? undefined : `the driver exited ${exit.code ?? "?"} without recording a stop reason`;
}

/** The step a dead driver was on: the running one, else the one started last. */
export function lastStep(journal: Pick<RunJournal, "steps"> | undefined): string | undefined {
  const recs = Object.values(journal?.steps ?? {});
  return (recs.find((r) => r.status === "running") ?? recs.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1))?.id;
}

/** A refused-<ts>.json written in `dir` at or after `since`. */
function refusedSince(dir: string, since: Date): boolean {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => /^refused-.*\.json$/.test(n)); } catch { return false; }
  return names.some((n) => {
    try { return Date.parse((JSON.parse(readFileSync(join(dir, n), "utf8")) as StopReason).at) >= since.getTime(); } catch { return false; }
  });
}

/**
 * The supervision loop for one run (the detached body). Returns the last
 * child's exit code. `args.run` absent: the run stamp is picked here, once.
 */
export async function supervise(args: SuperviseArgs, deps: SuperviseDeps): Promise<number> {
  const target = loadTarget(targetPath(args.target));
  if (target.rmEnv !== "stage") {
    deps.error(`[${NAME}] refusing: ${target.name} is a ${target.rmEnv} target; only a stage run is supervised (production runs have no supervisor).`);
    return 2;
  }
  const root = args.journalRoot ?? journalRoot(deps.home);
  const runTs = args.run ?? runStamp(deps.now());
  const targetDir = join(root, target.name);
  const runDir = join(targetDir, runTs);
  const childArgs = ["--target", args.target, "--go", args.go, "--run", runTs, ...(args.journalRoot === undefined ? [] : ["--journal-root", args.journalRoot])];
  const superviseCmd = ["bun", "run", "release:supervise", ...childArgs].join(" ");

  let died = false;
  const sendDied = async (detail: string): Promise<void> => {
    if (died) return;
    died = true;
    const step = lastStep(readJournal(runDir));
    const resume = step === undefined ? superviseCmd : resumeCommand({ target: args.target, go: args.go, runTs, stepId: step });
    deps.error(`[${NAME}] run ${runTs} DIED${step ? ` at ${step}` : ""}: ${detail}. Resume with:\n  ${resume}`);
    try {
      await deps.notify({ release: target.release, target: target.name, runTs, kind: "died", ...(step ? { step } : {}), detail, resume, at: deps.now().toISOString() });
    } catch { /* the notifier never decides the supervisor's exit */ }
  };

  deps.log(`[${NAME}] supervising run ${runTs} of ${target.release} on ${target.name}; journal ${runDir}`);
  for (;;) {
    const started = deps.now();
    deps.log(`[${NAME}] ${started.toISOString()} starting release:run ${childArgs.join(" ")}`);
    const stopPoll = deps.every(POLL_MS, () => {
      const j = readJournal(runDir);
      if (staleHeartbeat(j, deps.now())) void sendDied(`run.json says running but its heartbeat is from ${j!.heartbeatAt}, more than ${STALE_HEARTBEAT_MS / 60_000} minutes old: the driver is dead or hung`);
    });
    let exit: ChildExit;
    try { exit = await deps.runChild(childArgs); } finally { stopPoll(); }
    const journal = readJournal(runDir);
    if (died) return exit.code ?? 1;
    if (exit.signal === null && exit.code === 3 && journal?.pausedUntil !== undefined) {
      const until = Date.parse(journal.pausedUntil);
      deps.log(`[${NAME}] run ${runTs} paused at ${journal.stopReason?.step ?? "?"} until ${journal.pausedUntil}; sleeping, then resuming it`);
      for (let left = until - deps.now().getTime(); left > 0; left = until - deps.now().getTime()) await deps.sleep(left);
      continue;
    }
    const reason = diedReason(exit, journal?.stopReason, started, refusedSince(targetDir, started));
    if (reason !== undefined) await sendDied(reason);
    else deps.log(`[${NAME}] run ${runTs} stopped: ${journal?.stopReason?.kind ?? "refused"} (exit ${exit.code}); the run's own notification names the next command`);
    return exit.code ?? 1;
  }
}

/** The real dependencies: the child is `bun run release:run` in the control checkout. */
export function realSuperviseDeps(): SuperviseDeps {
  const error = (l: string) => console.error(l);
  return {
    runChild: (args) => new Promise((done) => {
      const child = spawn(process.execPath, ["run", "release:run", ...args], { cwd: CONTROL_REPO, stdio: ["ignore", "inherit", "inherit"] });
      child.on("error", () => done({ code: 127, signal: null }));
      child.on("close", (code, signal) => done({ code, signal }));
    }),
    now: () => new Date(),
    // setTimeout holds at most 2^31-1 ms; the loop sleeps again for any remainder.
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2 ** 31 - 1))),
    every: (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
    notify: (event) => notify(event, { collect: realDeps().collect, error }),
    log: (l) => console.log(`${l}`),
    error,
    home: process.env.HOME ?? "",
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const args = parseSuperviseArgs(argv);
  if ("error" in args) {
    console.error(`[${NAME}] ${args.error}`);
    process.exit(2);
  }
  if (process.env.RM_SUPERVISE_DETACHED === "1") {
    process.exitCode = await supervise(args, realSuperviseDeps());
  } else {
    // Detach: a new session, stdin closed, output to the run's supervise log. The launching shell may exit.
    const target = loadTarget(targetPath(args.target));
    if (target.rmEnv !== "stage") {
      console.error(`[${NAME}] refusing: ${target.name} is a ${target.rmEnv} target; only a stage run is supervised.`);
      process.exit(2);
    }
    const runTs = args.run ?? runStamp(new Date());
    const dir = join(args.journalRoot ?? journalRoot(), target.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = join(dir, `supervise-${runTs}.log`);
    const fd = openSync(log, "a", 0o600);
    const rest = ["--target", args.target, "--go", args.go, "--run", runTs, ...(args.journalRoot === undefined ? [] : ["--journal-root", args.journalRoot])];
    const child = spawn("setsid", [process.execPath, "--no-env-file", fileURLToPath(import.meta.url), ...rest], {
      detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, RM_SUPERVISE_DETACHED: "1" },
    });
    child.unref();
    console.log(`[${NAME}] supervising run ${runTs} detached (pid ${child.pid}); log ${log}`);
  }
}
