// ONE JUDGE, ONE SHORT-LIVED CONTAINER, ON THE MEMBER RAIL (issue #1012).
//
// A member agent and a judge are the same KIND of actor — an entity that makes
// one LLM call on the swarm's behalf — and until this file existed they were
// started two structurally different ways for no principled reason: the member
// through runMemberAgent()'s explicit per-container credential injection, the
// judge through a bare in-process fetch() in backend/src/swarm/judge.ts. That
// divergence is exactly why one path's credential delivery silently drifted
// from the other's and CI judged every session `credential_unconfigured`.
//
// So this file is DELIBERATELY THIN. It owns no launch logic of its own: the
// container name, the single explicit `-e` for the model credential, the launch
// watcher, the redaction of that credential out of every returned string, and
// the kill + `docker rm -f` cleanup in `finally` all come from runMemberAgent()
// verbatim. What it adds is only what a judge needs and a member does not:
//
//   - `commandMode` (--entrypoint bun + argv) instead of the image's `opencode`
//     entrypoint — the SAME seam scripts/lib/swarm/agent.ts uses for session
//     participation, so there is still no second launch path in this repo.
//   - NO persistent HOME volume. A member's identity must survive between
//     sessions; a judge holds no key, signs nothing and must remember nothing,
//     so mounting one would hand a model-driven container durable state for no
//     reason. The mount set here is two read-only files and nothing else.
//   - The prompt as a mounted FILE (see judge-runner.ts on MAX_ARG_STRLEN).
//
// WHERE THE SPOOL DIRECTORY COMES FROM, and why it is not just a tmpdir: the
// process calling this runs INSIDE the agent-launcher container, but `-v`
// sources are resolved by the Docker DAEMON against the HOST filesystem. A path
// that exists only in the launcher's own filesystem would mount as an empty
// directory (or fail), silently, on every call. docker-compose.yml therefore
// binds one host directory into the launcher AT THE SAME PATH, so a path
// written here means the same thing on both sides. Running the launcher outside
// a container (the integration test does) is the degenerate case of the same
// rule.
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMemberAgent, type MemberAgentModel } from "./member-agent.ts";
import { parseRunnerLine, type JudgeRunnerLine } from "./judge-runner.ts";
import { DEFAULT_COMPOSE_FILES } from "../stack/config.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(scriptDir, "..", "..");

/** Where the bundled shim and the prompt land inside the judge container. */
export const JUDGE_RUNNER_ENTRY = "/opt/robotmoney/judge-runner.js";
export const JUDGE_PROMPT_ENTRY = "/opt/robotmoney/judge-prompt.txt";

/**
 * The host path both the launcher container and the Docker daemon can see.
 * Overridable so a developer (and the integration test) can point it somewhere
 * writable without editing compose.
 */
export const DEFAULT_LAUNCHER_SPOOL_DIR = "/tmp/rm-agent-launcher";
export function launcherSpoolDir(env: Record<string, string | undefined> = process.env): string {
  return (env.SWARM_LAUNCHER_SPOOL_DIR ?? "").trim() || DEFAULT_LAUNCHER_SPOOL_DIR;
}

/**
 * THE CONTAINER'S CEILING IS BELOW THE HOST'S.
 *
 * judge() aborts its own request at `SWARM_JUDGE_TIMEOUT_MS`. If the container
 * were bounded at the same number the two deadlines would race, and a hung
 * container would report as `model_timeout` about half the time — a verdict
 * about a model that was never reached. Subtracting a margin makes the launcher
 * always answer first, so a hang is deterministically `launcher_unavailable`
 * (an acceptance criterion of #1012, not a nicety).
 */
export const LAUNCHER_RESPONSE_MARGIN_MS = 15_000;
/** Floor, so an operator's very small timeout still leaves room to start a container. */
export const MIN_JUDGE_CONTAINER_TIMEOUT_MS = 5_000;

export function judgeContainerTimeoutMs(requestedMs: number): number {
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) return MIN_JUDGE_CONTAINER_TIMEOUT_MS;
  return Math.max(MIN_JUDGE_CONTAINER_TIMEOUT_MS, Math.floor(requestedMs) - LAUNCHER_RESPONSE_MARGIN_MS);
}

export interface JudgeAgentRail {
  repoRoot: string;
  composeProject: string;
  composeFiles: string[];
  /** Exact compose interpolation env for the already-running stack. */
  composeSpawnEnv: Record<string, string>;
  /** The launcher's own copy of the Zen credential — never per-request. */
  apiKey: string;
  /** Overrides the shim's default Zen base URL when the deployment pins one. */
  baseUrl?: string;
  spoolDir?: string;
}

export interface JudgeAgentRequest {
  model: string;
  prompt: string;
  timeoutMs: number;
}

/** What one launch produced, plus the evidence an operator needs when it did not. */
export interface JudgeAgentResult {
  line: JudgeRunnerLine;
  containerName: string;
  durationMs: number;
}

/**
 * Build the shim ONCE per call, into the spool run directory.
 *
 * Bundling (rather than mounting the .ts source) is the same choice
 * buildMemberSessionRuntime() makes for the member client: the container gets
 * ONE self-contained file and never the repository, so a read-only mount cannot
 * disclose `.env`, `.agents` or unrelated source to a model-facing process.
 */
async function buildRunnerArtifact(repoRoot: string, runDir: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(repoRoot, "scripts", "agent", "judge-runner.ts")],
    outdir: runDir,
    naming: "judge-runner.js",
    target: "bun",
    format: "esm",
    sourcemap: "none",
  });
  if (!built.success) throw new Error(`judge runner bundle failed: ${built.logs.map(String).join("; ")}`);
  return join(runDir, "judge-runner.js");
}

/** A rail from the launcher process's own environment. Throws loudly on a missing piece. */
export function judgeRailFromEnv(env: Record<string, string | undefined> = process.env): JudgeAgentRail {
  const composeProject = (env.SMOKE_PROJECT ?? env.COMPOSE_PROJECT_NAME ?? "").trim();
  if (!composeProject) {
    throw new Error(
      "judgeRailFromEnv: SMOKE_PROJECT (or COMPOSE_PROJECT_NAME) is required — the launcher starts judge " +
        "containers in the already-running stack's compose project and cannot guess its name.",
    );
  }
  const apiKey = (env.OPENCODE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "judgeRailFromEnv: OPENCODE_API_KEY is required — the launcher holds the judge's credential and " +
        "injects it per container. It is deliberately NOT accepted per request, so there is no other route in.",
    );
  }
  const composeSpawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) composeSpawnEnv[k] = v;
  return {
    repoRoot: REPO_ROOT,
    composeProject,
    composeFiles: env.COMPOSE_FILE ? env.COMPOSE_FILE.split(":") : [...DEFAULT_COMPOSE_FILES],
    composeSpawnEnv,
    apiKey,
    baseUrl: (env.SWARM_JUDGE_BASE_URL ?? "").trim() || undefined,
    spoolDir: launcherSpoolDir(env),
  };
}

export async function runJudgeAgent(rail: JudgeAgentRail, req: JudgeAgentRequest): Promise<JudgeAgentResult> {
  const runId = `judge-${crypto.randomUUID().slice(0, 8)}`;
  const spool = rail.spoolDir ?? launcherSpoolDir();
  const runDir = join(spool, runId);
  const timeoutMs = judgeContainerTimeoutMs(req.timeoutMs);
  const modelConfig: MemberAgentModel = {
    model: req.model,
    // The judge model is a `swarm_judge_config` ROW, not a registry selector, so
    // it is passed verbatim — resolveJudgeTransport() already re-asserted the
    // model policy against it host-side (AC-MODEL-01) before the prompt got
    // here, and re-deriving it from AGENT_MODEL would be a second, unreviewable
    // model signal (D22 rule 1).
    apiKeyEnv: "OPENCODE_API_KEY",
    apiKey: rail.apiKey,
  };
  mkdirSync(runDir, { recursive: true });
  try {
    const runnerArtifact = await buildRunnerArtifact(rail.repoRoot, runDir);
    const promptPath = join(runDir, "judge-prompt.txt");
    await Bun.write(promptPath, req.prompt);

    const result = await runMemberAgent({
      repoRoot: rail.repoRoot,
      composeProject: rail.composeProject,
      composeFiles: rail.composeFiles,
      composeSpawnEnv: rail.composeSpawnEnv,
      runId,
      // The commandMode seam — the image's `opencode` ENTRYPOINT is replaced,
      // so no opencode CLI ever runs for a judging (an acceptance criterion).
      entrypoint: "bun",
      command: [JUDGE_RUNNER_ENTRY],
      // TWO READ-ONLY FILES AND NOTHING ELSE. No `/home/agent` volume: see this
      // file's header for why a judge must carry nothing between calls.
      mounts: [
        { source: runnerArtifact, target: JUDGE_RUNNER_ENTRY, readonly: true },
        { source: promptPath, target: JUDGE_PROMPT_ENTRY, readonly: true },
      ],
      extraEnv: {
        RM_JUDGE_MODEL: req.model,
        RM_JUDGE_PROMPT_FILE: JUDGE_PROMPT_ENTRY,
        ...(rail.baseUrl ? { RM_JUDGE_BASE_URL: rail.baseUrl } : {}),
      },
      modelConfig,
      timeoutMs,
    });

    return { line: readAnswer(result, timeoutMs), containerName: result.containerName, durationMs: result.durationMs };
  } finally {
    // The container is removed by runMemberAgent()'s own finally-bracketed
    // `docker rm -f`; this removes the two files that were mounted into it. Both
    // halves run on EVERY exit path — success, timeout, crash and a throw out of
    // the bundler alike — which is what "no leaked containers or volumes" means
    // when the thing leaked would be a prompt full of member-authored text.
    rmSync(runDir, { recursive: true, force: true });
  }
}

/**
 * The container's answer, or the RAIL failure that explains its absence.
 *
 * Order matters. "Never launched" and "timed out" are checked BEFORE the stdout
 * scan because a container that died early can still have flushed a partial
 * line, and reporting that as the model's answer is how a launcher fault would
 * come to wear a model verdict.
 */
export function readAnswer(
  result: { stdout: string; exitCode: number | null; timedOut: boolean; containerLaunched: boolean | null },
  timeoutMs: number,
): JudgeRunnerLine {
  if (result.containerLaunched === false) {
    return { ok: false, kind: "launcher", detail: "judge container never launched" };
  }
  if (result.timedOut) {
    return { ok: false, kind: "launcher", detail: `judge container exceeded its ${timeoutMs}ms ceiling` };
  }
  const line = parseRunnerLine(result.stdout);
  if (line) return line;
  return {
    ok: false,
    kind: "launcher",
    detail: `judge container produced no answer line (exit ${result.exitCode ?? "unknown"})`,
  };
}
