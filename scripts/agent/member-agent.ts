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
// ── Model and credential: RESOLVED BY THE CALLER, never by this module ──────
// (docs/decisions.md D22 rule 1 AS AMENDED 2026-07-28, docs/architecture.md
// §11.3 E1 as amended.)
//
// This module reads NO environment variable and holds no model id. It takes a
// `MemberAgentModel` — exactly the record `resolveModelConfig()` in
// scripts/lib/onboarding-eval.ts produces from `resolveAgentModel()` /
// `isKeylessModel()` against scripts/lib/model-registry.ts — and does what that
// record says. There is deliberately no second selection path here: no default
// model, no fallback, no `process.env` read, no in-code constant. Handing this
// primitive a model is the ONLY way it gets one.
//
// An earlier revision of this file asserted that the argv "can never carry a
// `-e` flag — there is no parameter, no branch, and no ambient value". That
// invariant is GONE and the assertion with it: D22 rule 1's keyless mandate was
// amended because `opencode/big-pickle`, the free model it pinned, is saturated
// upstream with no paid sibling to escape to. The eval now runs a funded,
// registry-selected model billed to OPENCODE_API_KEY, and a container inherits
// nothing — so an explicit `-e` injection at `docker compose run` time is the
// only way the credential can reach it.
//
// What survives from that invariant, and is enforced here: AT MOST ONE `-e`
// flag, carrying exactly the env NAME the registry chose (`apiKeyEnv`), and
// ONLY when the resolved model actually needs credit. A keyless selection
// (`AGENT_MODEL=free`, `isKeylessModel(model) === true`) yields `apiKeyEnv:
// null` and the argv carries no `-e` at all — the keyless path is still a real,
// fully-supported path, it is simply no longer the only one.
//
// It also has no inference-off affordance: the `observe`/`inspect` hooks watch
// a real run, they can never stand in for one (E2).
//
// Cleanup is BRACKETED, not a caller obligation: removal happens in the same
// `finally` regardless of how the run ends, so a kept container cannot leak.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeArgs, DEFAULT_COMPOSE_FILES } from "../stack/config.ts";

/**
 * The model + credential this primitive runs with, resolved by the caller.
 *
 * Structurally identical to `ModelConfig` in scripts/lib/onboarding-eval.ts
 * (`resolveModelConfig`'s return), which is what every real caller passes —
 * declared here rather than imported so the low-level primitive does not depend
 * on the higher-level harness, and deliberately NOT re-derived from anything:
 * whatever the registry resolved is what runs.
 *
 * `apiKeyEnv === null` ⇔ keyless: no `-e` flag is emitted at all.
 */
export interface MemberAgentModel {
  /** Full `opencode/<id>`, from resolveAgentModel(). */
  model: string;
  /** Env var name the credential is injected under, or null when keyless. */
  apiKeyEnv: string | null;
  /** The credential value, or null when keyless. */
  apiKey: string | null;
}

// opencode.json written per-run, mounted read-only into the container (never
// baked into the image). Carries NO onboarding-specific knowledge and no
// Robot Money connectivity config — the agent reaches the committee REST API
// with plain HTTP (bash), using the base URL carried in the prompt's harness
// note (D21: the MCP transport is retired, so there is no MCP client to wire).
//
// The model arrives as a PARAMETER, resolved by the caller from the registry —
// this function invents nothing.
//
// ── Why `external_directory` is spelled out (2026-07-27) ────────────────────
// opencode's own default permission set contains
// `external_directory: { "*": "ask", <its tool-output dir>: "allow",
// /tmp/opencode/*: "allow" }` — confirmed with `opencode debug agent build`
// inside the pinned image. `--dangerously-skip-permissions` (the flag
// buildMemberAgentArgv already passes; a hidden alias of `--auto` in the pinned
// binary) does NOT lift it: the 2026-07-27 layer-4 run passed that flag and
// opencode still rejected the calls, citing that exact rule. In a
// non-interactive `opencode run` an "ask" has nobody to ask, so it resolves to
// a REJECTION rather than a wait.
//
// The effect, observed live in that sweep: an agent that discovers the
// committee-onboarding skill by cloning robotmoney-core into /tmp can `ls` its
// way to SKILL.md and then cannot read one byte of it — everything outside
// `--dir /home/agent` is "external". The agent was structurally unable to read
// the very document the eval measures it for, and the run was scored as a
// product failure. scripts/agent/classify-outcome.ts's `harness-error` outcome
// exists to make that class of defect loud; this line removes this instance of
// it.
//
// Verified against the pinned opencode 1.18.1 with `opencode debug agent
// build`: adding it appends `external_directory * → allow` AFTER the default
// `external_directory * → ask`, and later rules win (the same mechanism by
// which the `* → deny` below overrides opencode's own default `* → allow`).
// It carries no onboarding knowledge: it names no path, host, repository, or
// step — only that this container does not stop to ask permission.
export function buildAgentOpencodeConfig(model: string): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    autoupdate: false,
    permission: { "*": "deny", bash: "allow", external_directory: "allow" },
  };
}

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
  /** Resolved by the caller from scripts/lib/model-registry.ts. Required. */
  modelConfig: MemberAgentModel;
  // When true, `--rm` is omitted so the STOPPED container survives long enough
  // to be inspected (eval layers 1-3 read its filesystem). Nothing else about
  // the argv changes.
  keep?: boolean;
}

/**
 * The exact `docker compose run` argv. Pure — no env read, no I/O.
 *
 * CREDENTIAL INJECTION is the only conditional part: exactly one `-e
 * <apiKeyEnv>=<apiKey>` when the resolved model needs credit, and nothing at
 * all when it does not. A container inherits no ambient environment, so this
 * explicit injection is the only route in — and because the NAME comes from
 * the resolved config rather than from a list of candidates, there is exactly
 * one credential env var the container can ever see.
 *
 * Throws when a non-keyless config arrives with no key rather than silently
 * launching an unauthenticated container that will 401 twenty minutes later.
 */
export function buildMemberAgentArgv(a: MemberAgentArgvOptions): string[] {
  const { model, apiKeyEnv, apiKey } = a.modelConfig;
  if (!model) throw new Error("buildMemberAgentArgv: modelConfig.model is required — resolve it via resolveAgentModel()");
  if (apiKeyEnv && !apiKey) {
    throw new Error(
      `buildMemberAgentArgv: modelConfig names credential env ${apiKeyEnv} but carries no value — ` +
        "resolveModelConfig() throws on that case; do not construct one by hand.",
    );
  }
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
    // AT MOST ONE `-e`, under the env name the registry chose, and only when
    // the resolved model is funded. A keyless model gets no flag at all.
    ...(apiKeyEnv ? ["-e", `${apiKeyEnv}=${apiKey}`] : []),
    "member-agent",
    "run",
    "--model",
    model,
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
// The ambient-environment wrapper, kept HERE rather than at the call sites, so
// an eval-side compose child never has to assemble its own env. Every compose
// child in the eval path must use it, or it re-opens the volume-hash mismatch
// memberAgentSpawnEnv exists to close.
//
// NOTE ON SCOPE: this is the environment of the local `docker` CLI process, not
// of the CONTAINER. A container inherits nothing from it; the only thing that
// ever reaches the container's environment is the single explicit `-e` flag
// buildMemberAgentArgv emits from the resolved model config.
export function composeChildEnv(composeProject: string): Record<string, string> {
  return memberAgentSpawnEnv(composeProject, process.env);
}

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
  /**
   * Model + credential, resolved by the CALLER (resolveModelConfig() →
   * resolveAgentModel()/isKeylessModel() against scripts/lib/model-registry.ts).
   * Required and never defaulted: this primitive has no model of its own.
   */
  modelConfig: MemberAgentModel;
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
    writeFileSync(opencodeConfigPath, JSON.stringify(buildAgentOpencodeConfig(opts.modelConfig.model), null, 2));

    const spawnEnv = memberAgentSpawnEnv(opts.composeProject, process.env);
    const proc = Bun.spawn(
      buildMemberAgentArgv({
        composeProject: opts.composeProject,
        composeFiles: opts.composeFiles,
        containerName,
        opencodeConfigPath,
        title: opts.title ?? `member-agent-${opts.runId}`,
        prompt: opts.prompt,
        modelConfig: opts.modelConfig,
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
