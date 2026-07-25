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
// Env-free by construction: it takes an already-resolved ModelConfig and never
// reads the process environment, so extracting it adds no configuration surface
// to an eval path (D22 §11.3 E1). It also has no inference-off affordance: the
// `observe`/`inspect` hooks watch a real run, they can never stand in for one
// (E2).
//
// Cleanup is BRACKETED, not a caller obligation: removal happens in the same
// `finally` regardless of how the run ends, so a kept container cannot leak.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeArgs, DEFAULT_COMPOSE_FILES } from "../stack/config.ts";
import { buildAgentOpencodeConfig, type ModelConfig } from "./model-config.ts";

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
  modelConfig: ModelConfig;
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
    // Only pass a key when the resolved model actually needs one — the
    // default free tier is genuinely keyless (no -e flag at all).
    ...(a.modelConfig.apiKeyEnv ? ["-e", `${a.modelConfig.apiKeyEnv}=${a.modelConfig.apiKey}`] : []),
    "member-agent",
    "run",
    "--model",
    a.modelConfig.model,
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
  modelConfig: ModelConfig;
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
    writeFileSync(opencodeConfigPath, JSON.stringify(buildAgentOpencodeConfig(opts.modelConfig.model), null, 2));

    const proc = Bun.spawn(
      buildMemberAgentArgv({
        composeProject: opts.composeProject,
        composeFiles: opts.composeFiles,
        containerName,
        opencodeConfigPath,
        modelConfig: opts.modelConfig,
        title: opts.title ?? `member-agent-${opts.runId}`,
        prompt: opts.prompt,
        keep,
      }),
      { cwd: opts.repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    // Actively drain both pipes for the whole run — an un-drained pipe can
    // fill its OS buffer and deadlock the child once its own transcript
    // exceeds a few tens of KB, which a real multi-tool-call session easily
    // does. Started BEFORE any await, and never moved after one.
    const stdoutPromise = drain(proc.stdout as ReadableStream<Uint8Array>);
    const stderrPromise = drain(proc.stderr as ReadableStream<Uint8Array>);

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

    return {
      containerName,
      exitCode,
      stdout,
      stderr,
      transcript: `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      timedOut,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
