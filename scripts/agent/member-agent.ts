// The member-agent container PRIMITIVE (docs/architecture.md §11.3 E5,
// docs/decisions.md D22 "shared components").
//
// One place that knows how to launch a vanilla OpenCode agent container: the
// per-run tmpdir and mounted `opencode.json`, the deterministic container name,
// the `docker compose run` argv, draining BOTH pipes, killing the CLI, and
// removing the container. Extracted verbatim from
// scripts/lib/onboarding-eval.ts's runOnboardingEval so the eval's layers and
// the demo's single admission launch containers the SAME way.
//
// KEYLESS and env-free by construction (docs/decisions.md D22 rule 1,
// docs/architecture.md §11.3 E1): the model is the in-code constant EVAL_MODEL,
// this module reads no environment variable, and the argv it builds can never
// carry a `-e` flag — there is no parameter, no branch, and no ambient value
// through which a provider key or a different model could reach the container.
// It also has no inference-off affordance: the `observe`/`inspect` hooks watch
// a real run, they can never stand in for one (E2).
//
// Cleanup is BRACKETED, not a caller obligation: removal happens in the same
// `finally` regardless of how the run ends, so a kept container cannot leak.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeArgs, DEFAULT_COMPOSE_FILES } from "../stack/config.ts";
import { buildAgentOpencodeConfig, EVAL_MODEL } from "./model-config.ts";

export async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

// A deterministic, explicit container name — NOT left to `docker compose
// run`'s auto-generated one — so cleanup can target the real container
// directly. This matters because `proc.kill()` below only signals the local
// `docker` CLI process; `docker compose run` is a client of the Docker daemon,
// and the CONTAINER it starts is NOT a child process of that CLI. Killing the
// CLI does not reliably stop the container (a well-known Docker gotcha,
// confirmed live: a "timed out" eval's container kept running and reasoning
// for 10+ minutes after the harness gave up on it and a RETRY launched a
// second container concurrently with the still-running first one).
export function memberAgentContainerName(project: string, runId: string): string {
  return `${project}-member-agent-eval-${runId}`;
}

export interface MemberAgentArgvOptions {
  composeProject: string;
  composeFiles?: string[];
  containerName: string;
  opencodeConfigPath: string;
  title: string;
  prompt: string;
  // When true, `--rm` is omitted so the STOPPED container survives long enough
  // to be inspected (eval layers 1-3 read its filesystem). Nothing else about
  // the argv changes.
  keep?: boolean;
}

export function buildMemberAgentArgv(a: MemberAgentArgvOptions): string[] {
  return [
    "docker",
    ...composeArgs(a.composeProject, a.composeFiles ?? DEFAULT_COMPOSE_FILES),
    "run",
    ...(a.keep ? [] : ["--rm"]),
    "--no-deps",
    "--name",
    a.containerName,
    "-v",
    `${a.opencodeConfigPath}:/home/agent/opencode.json:ro`,
    // NO `-e` flag, ever: nothing is injected into this container's
    // environment, because there is no key to inject (E1).
    "member-agent",
    "run",
    "--model",
    EVAL_MODEL,
    "--format",
    "json",
    "--dangerously-skip-permissions",
    "--title",
    a.title,
    "--dir",
    "/home/agent",
    a.prompt,
  ];
}

// ── The compose child's environment and stdio (both LOAD-BEARING) ───────────
//
// ENVIRONMENT. `docker compose run` re-resolves the WHOLE compose model, not
// just the service named on the command line, and `ensureProjectVolumes` then
// compares every project volume against the `com.docker.compose.config-hash`
// label recorded when that volume was created. docker-compose.demo.yml's
// pgdata volume carries `robotmoney.demo.project: ${DEMO_PROJECT}`, so a child
// that does not carry DEMO_PROJECT hashes a volume definition whose label is
// the empty string — a DIFFERENT hash from the one `stack.up()` recorded, which
// makes compose print
//
//   Volume "<project>_pgdata" exists but doesn't match configuration in
//   compose file. Recreate (data will be lost)?
//
// and wait for an answer. Reproduced end-to-end on this repo's own compose
// files with compose 2.40.3; with a PTY on stdin the invocation BLOCKS
// indefinitely, and "yes" would delete the running stack's postgres data
// mid-run. DEMO_PROJECT is by definition the compose project name
// (scripts/stack/config.ts's buildComposeEnv sets `DEMO_PROJECT: cfg.project`),
// so it is DERIVED here rather than plumbed — a caller cannot forget it.
//
// STDIN. Every compose invocation on this path runs with stdin closed
// (`/dev/null`), so a confirmation prompt can only ever be declined
// immediately. A harness question that waits forever is how a 20-minute
// per-sample budget gets burned by the harness and then reported as a product
// timeout; there is no compose flag that answers this particular prompt
// non-interactively (`docker compose run --help`, 2.40.3, has no `--yes`), so
// closing stdin IS the mechanism.
export function memberAgentSpawnEnv(
  composeProject: string,
  hostEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(hostEnv)) if (v !== undefined) out[k] = v;
  out.DEMO_PROJECT = composeProject;
  return out;
}

// Does the named container exist right now (running, exited, or created)?
// `docker inspect` is a read-only daemon query; it is the POSITIVE evidence
// that the container the compose CLI was asked for actually came into being.
export function containerExists(containerName: string, env?: Record<string, string>): boolean {
  const r = Bun.spawnSync(["docker", "inspect", "--type", "container", containerName], {
    ...(env ? { env } : {}),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return r.exitCode === 0;
}

// How long the launch watcher below keeps looking for the container before it
// gives up and reports "unknown". Generous: a cold `docker compose run` on a
// loaded host can take tens of seconds to create the container.
export const CONTAINER_LAUNCH_WATCH_MS = 120_000;
// Tight on purpose: `--rm` removes the container as soon as it exits, so the
// only window in which a container that DID launch could be missed is one that
// lived for less than one poll interval. An opencode container takes seconds
// to boot, and a container that died faster than this carried no agent either
// way. The classifier additionally requires an EMPTY event stream before it
// will call a run "never launched" (scripts/agent/classify-outcome.ts), so a
// single missed poll cannot on its own manufacture a harness error.
const CONTAINER_LAUNCH_POLL_MS = 250;

// `docker cp`, NOT `docker exec`: exec cannot run on a STOPPED container, and
// inspecting a stopped container's filesystem is exactly how eval layers 1-3
// observe without editing the task under test (§11.3 E3).
export function containerFileExists(containerName: string, path: string): boolean {
  const r = Bun.spawnSync(["docker", "cp", `${containerName}:${path}`, "-"], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0;
}

export function copyFromContainer(containerName: string, containerPath: string, hostPath: string): boolean {
  const r = Bun.spawnSync(["docker", "cp", `${containerName}:${containerPath}`, hostPath], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return r.exitCode === 0;
}

// A live, non-blocking view of the running container handed to `observe`.
export interface MemberAgentHandle {
  readonly containerName: string;
  readonly exitCode: number | null;
}

export interface MemberAgentOptions {
  repoRoot: string;
  composeProject: string;
  composeFiles?: string[];
  prompt: string;
  runId: string;
  title?: string;
  onEvent?: (msg: string) => void;
  // Honoured ONLY when `observe` is absent. When an observer is supplied it
  // owns ALL timing (that is how the onboarding eval keeps its own deadline
  // and post-exit grace semantics unchanged).
  timeoutMs?: number;
  keepUntilInspected?: boolean;
  observe?: (handle: MemberAgentHandle) => Promise<void>;
  inspect?: (ctx: { containerName: string; timedOut: boolean }) => Promise<void>;
}

export interface MemberAgentResult {
  containerName: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  transcript: string;
  timedOut: boolean;
  durationMs: number;
  // Was the container ever OBSERVED to exist (`docker inspect` succeeded at
  // least once)? `false` means the compose CLI was asked for a container that
  // never came into being — a harness failure, not a result about the agent.
  // `null` means the watcher could not tell (it timed out looking), which is
  // deliberately NOT treated as evidence of anything.
  containerLaunched: boolean | null;
}

// Only consulted on the no-observer path; the onboarding eval passes an
// observer and applies its own DEFAULT_TIMEOUT_MS.
export const DEFAULT_MEMBER_AGENT_TIMEOUT_MS = 20 * 60_000;

export async function runMemberAgent(opts: MemberAgentOptions): Promise<MemberAgentResult> {
  const log = opts.onEvent ?? (() => {});
  const keep = opts.keepUntilInspected ?? false;
  const startedAt = Date.now();
  const containerName = memberAgentContainerName(opts.composeProject, opts.runId);

  const workDir = mkdtempSync(join(tmpdir(), "member-agent-"));
  const opencodeConfigPath = join(workDir, "opencode.json");
  try {
    writeFileSync(opencodeConfigPath, JSON.stringify(buildAgentOpencodeConfig(), null, 2));

    const spawnEnv = memberAgentSpawnEnv(opts.composeProject, process.env);
    const proc = Bun.spawn(
      buildMemberAgentArgv({
        composeProject: opts.composeProject,
        composeFiles: opts.composeFiles,
        containerName,
        opencodeConfigPath,
        title: opts.title ?? `member-agent-${opts.runId}`,
        prompt: opts.prompt,
        keep,
      }),
      // `stdin: "ignore"` and the derived DEMO_PROJECT are both load-bearing —
      // see memberAgentSpawnEnv's comment. Do not "tidy" either away.
      { cwd: opts.repoRoot, env: spawnEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    // Actively drain both pipes for the whole run — an un-drained pipe can
    // fill its OS buffer and deadlock the child once its own transcript
    // exceeds a few tens of KB, which a real multi-tool-call session easily
    // does. Started BEFORE any await, and never moved after one.
    const stdoutPromise = drain(proc.stdout as ReadableStream<Uint8Array>);
    const stderrPromise = drain(proc.stderr as ReadableStream<Uint8Array>);

    // POSITIVE evidence that the container came into being, gathered while the
    // run is still in flight. Without it, "the compose CLI never started
    // anything" and "the agent started and produced nothing" are the same
    // observation — and the second is a real (if bleak) result about the run
    // while the first is a harness failure that must never enter a product
    // metric. Stops the moment the container is seen, so it costs a handful of
    // `docker inspect` calls on a healthy run and nothing thereafter.
    let containerLaunched: boolean | null = null;
    const launchWatcher = (async () => {
      const deadline = Date.now() + CONTAINER_LAUNCH_WATCH_MS;
      for (;;) {
        if (containerExists(containerName, spawnEnv)) {
          containerLaunched = true;
          return;
        }
        if (proc.exitCode !== null) {
          // The CLI is gone and the container was never seen. One last look
          // (it may have started and been removed between polls) and then a
          // verdict.
          containerLaunched = containerExists(containerName, spawnEnv);
          return;
        }
        if (Date.now() >= deadline) return; // stays null: "could not tell"
        await Bun.sleep(CONTAINER_LAUNCH_POLL_MS);
      }
    })();

    let timedOut = false;
    if (opts.observe) {
      await opts.observe({ containerName, get exitCode() { return proc.exitCode; } });
    } else {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_MEMBER_AGENT_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const finished = await Promise.race([proc.exited.then(() => "exited" as const), deadline]);
      if (timer !== undefined) clearTimeout(timer); // never leave a 20-minute timer holding the event loop open
      timedOut = finished === "timeout";
      if (timedOut) log(`member-agent container ${containerName} hit its ${timeoutMs}ms deadline`);
    }

    // Kill BOTH the local CLI process AND the actual container by its
    // deterministic name — killing only the CLI leaves the real container
    // running under the Docker daemon (see memberAgentContainerName's
    // comment). `docker rm -f` is a superset of `docker kill`: it stops AND
    // removes, so this is also the cleanup `--rm` would otherwise handle on a
    // normal exit. Best-effort — an already-exited container/process is not an
    // error here.
    try {
      proc.kill();
    } catch {
      /* already exited */
    }

    if (keep) {
      // Inspection reads the STOPPED container's filesystem, so wait for it to
      // stop first. (After a TIMEOUT the kill above only signalled the CLI, so
      // `timedOut` is passed through — an observer that kills on timeout may be
      // reading a still-running filesystem.)
      await proc.exited;
      if (opts.inspect) await opts.inspect({ containerName, timedOut });
    }

    try {
      Bun.spawnSync(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });
    } catch {
      /* already removed */
    }
    // LOAD-BEARING ORDERING: `docker rm -f` runs BEFORE the drains are awaited.
    // Closing the container's pipes is what lets the drains finish; awaiting
    // them first would hang. Do not "tidy" this.
    const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
    await launchWatcher; // resolves as soon as the CLI is gone; never outlives the run

    return {
      containerName,
      exitCode,
      stdout,
      stderr,
      transcript: `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      timedOut,
      durationMs: Date.now() - startedAt,
      containerLaunched,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
