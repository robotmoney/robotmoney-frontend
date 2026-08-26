// Reusable §11 R8 real-inference admission case. `bun run eval` is the
// canonical suite entrypoint; `bun run onboarding-eval` remains as a thin,
// backwards-compatible one-case entrypoint.
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { makeDockerRunner, purgeSmokeEvalContainers } from "./lib/smoke-volumes.ts";
import {
  buildAgentPrompt,
  classifyOutcome,
  DEFAULT_AUTO_APPROVE_DELAY_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  generateIdentity,
  LOCAL_SWARM_ONBOARDING_SKILL_PATH,
  runOnboardingEval,
  type OnboardingEvalResult,
  type ModelConfig,
} from "./lib/onboarding-eval.ts";
import { isKeylessModel, resolveAgentModel } from "./lib/model-registry.ts";
import { ZEN_KEY_ENV, zenApiKey } from "./lib/opencode-key.ts";
import {
  createOnboardingArtifactWriter,
  createOnboardingTelemetry,
  redactTelemetryText,
  startComposeServiceLogFollower,
  type ComposeServiceLogFollower,
  type OnboardingEvent,
} from "./lib/onboarding-telemetry.ts";
import {
  createStack,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  generateStackCredentials,
  resolveStackEnvironment,
  stackProjectName,
  STAGE_WEB_PORT,
} from "./stack/index.ts";

export interface AdmissionEvalCaseOptions {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  keep?: boolean;
  project?: string;
  suiteRunId?: string;
  evalId?: string;
  sampleId?: string;
}

export interface AdmissionEvalCaseResult {
  admitted: boolean;
  outcome: string | null;
  durationMs: number;
  model: string;
  artifactDirectory: string;
  result: OnboardingEvalResult | null;
}

/** Keyed evals never probe or silently substitute a no-credential model. */
export function resolveAdmissionEvalModelConfig(env: Record<string, string | undefined>): ModelConfig {
  const model = resolveAgentModel(env);
  if (isKeylessModel(model)) {
    throw new Error(
      "Real-inference evals require OPENCODE_API_KEY and a funded AGENT_MODEL selection; no-credential models are not an eval fallback.",
    );
  }
  const apiKey = zenApiKey(env);
  if (!apiKey) {
    throw new Error(
      "Real-inference evals require OPENCODE_API_KEY before Docker; configure the keyed eval environment. No free-model probe or fallback will be attempted.",
    );
  }
  return { model, apiKeyEnv: ZEN_KEY_ENV, apiKey, keyless: false };
}

export async function runAdmissionEvalCase(options: AdmissionEvalCaseOptions = {}): Promise<AdmissionEvalCaseResult> {
const repoRoot = options.repoRoot ?? new URL("..", import.meta.url).pathname;
const env = options.env ?? process.env;
// This preflight is intentionally before credentials, stack construction, and
// every Docker call.
const modelConfig = resolveAdmissionEvalModelConfig(env);
const keep = options.keep ?? false;
const stackEnvironment = resolveStackEnvironment(env);
const project = options.project ?? stackProjectName("eval", stackEnvironment);
const identity = generateIdentity(options.sampleId);
const selectedModel = modelConfig.model;
const prompt = buildAgentPrompt(identity);
const skillPath = join(repoRoot, "frontend", "public", LOCAL_SWARM_ONBOARDING_SKILL_PATH);
const artifacts = createOnboardingArtifactWriter({
  repoRoot,
  composeProject: project,
  runId: identity.runId,
  model: selectedModel,
  contact: identity.contact,
  prompt,
  skillPath,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  autoApproveDelayMs: DEFAULT_AUTO_APPROVE_DELAY_MS,
  suiteRunId: options.suiteRunId,
  evalId: options.evalId,
  sampleId: options.sampleId,
});

function renderLive(event: OnboardingEvent): void {
  // Harness milestones retain their established `[eval]` console rendering via
  // onEvent below. Agent and service streams are the newly-live evidence.
  if (event.source === "agent" && event.stream !== "event") {
    console.log(`[eval][agent:${event.stream}] ${event.message}`);
  } else if (event.source === "api" || event.source === "postgres" || event.source === "compose") {
    console.log(`[eval][${event.source}:${event.stream}] ${event.message}`);
  }
}

const telemetry = createOnboardingTelemetry(
  {
    composeProject: project,
    runId: identity.runId,
    suiteRunId: options.suiteRunId,
    evalId: options.evalId,
    sampleId: options.sampleId,
    model: selectedModel,
  },
  (event) => {
    artifacts.sink(event);
    renderLive(event);
  },
  [{ value: identity.contact, placeholder: "<contact redacted>" }],
);
const credentials = generateStackCredentials();
const stack = createStack(
  {
    repoRoot,
    project,
    profile: "core",
    composeFiles: DEFAULT_COMPOSE_FILES,
    database: DEFAULT_STACK_DATABASE,
    credentials,
    environment: stackEnvironment,
  },
  {
    hostEnv: env,
    io: { stdout: "inherit", stderr: "inherit" },
    hooks: {
      onEvent(event) {
        telemetry.emit({
          source: "harness",
          stream: "event",
          message:
            event.phase === "log"
              ? event.message
              : `stack ${event.phase} ${event.status}${event.detail ? `: ${event.detail}` : ""}`,
        });
      },
    },
  },
);

console.log(`[eval] project=${project} env=${stackEnvironment.class}/${stackEnvironment.hash}`);
console.log(`[eval] artifacts=${artifacts.directory}`);
telemetry.emit({ source: "harness", stream: "event", message: `eval starting with model=${selectedModel}` });

const started = Date.now();
let admitted = false;
let result: OnboardingEvalResult | null = null;
let outcome: string | null = null;
let failure: unknown = null;
let follower: ComposeServiceLogFollower | null = null;
const cleanup: Record<string, unknown> = {};

try {
  const { apiPort, pgPort } = await stack.up();
  console.log(`[eval] host ports (Docker-assigned): api=${apiPort} pg=${pgPort}`);
  if (apiPort === STAGE_WEB_PORT) {
    throw new Error(
      `Docker published the api on ${STAGE_WEB_PORT}, the stage tunnel origin; refusing to run the eval on it.`,
    );
  }
  await stack.waitForHttp(`${stack.backendUrl}${ROUTES.swarm.members}`, 30_000);
  await stack.build(["member-agent"]);

  // Follow only after readiness, so startup/build chatter cannot bury the
  // agent/API exchange this artifact is intended to diagnose.
  follower = startComposeServiceLogFollower({
    repoRoot,
    composeProject: project,
    composeFiles: DEFAULT_COMPOSE_FILES,
    spawnEnv: stack.spawnEnv,
    telemetry,
    redactions: [{ value: identity.contact, placeholder: "<contact redacted>" }],
  });
  telemetry.emit({ source: "harness", stream: "event", message: "api/postgres log follower started" });

  result = await runOnboardingEval({
    repoRoot,
    composeProject: project,
    composeFiles: DEFAULT_COMPOSE_FILES,
    backendUrl: stack.backendUrl,
    automationToken: credentials.automationToken,
    composeSpawnEnv: stack.spawnEnv,
    identity,
    env,
    telemetry,
    onEvent: (message) => console.log(`[eval] ${message}`),
  });
  admitted = result.admitted;
  outcome = classifyOutcome(result);
  telemetry.emit({ source: "harness", stream: "event", message: `classifier outcome=${outcome}` });
  console.log(
    `\n[eval] admitted=${result.admitted} timedOut=${result.timedOut} ` +
      `containerExit=${result.containerExitCode} elapsed=${Math.round((Date.now() - started) / 1000)}s`,
  );
  // Kept for backwards compatibility and convenient copying. It is assembled
  // from the same redacted records already written live above.
  if (result.transcript) console.log(`\n[eval] container transcript:\n${result.transcript}`);
} catch (error) {
  failure = error;
  const message = redactTelemetryText(error instanceof Error ? error.message : String(error));
  telemetry.emit({ source: "harness", stream: "event", message: `eval failed: ${message}` });
  console.error(`[eval] ${message}`);
} finally {
  // Stop and fully drain the follower before any service is torn down.
  if (follower) {
    try {
      const stopped = await follower.stop();
      cleanup.logFollowerExitCode = stopped.exitCode;
      telemetry.emit({ source: "cleanup", stream: "event", message: `service log follower stopped (exit ${stopped.exitCode})` });
    } catch (error) {
      cleanup.logFollowerError = redactTelemetryText(error instanceof Error ? error.message : String(error));
      telemetry.emit({ source: "cleanup", stream: "event", message: `service log follower stop failed: ${cleanup.logFollowerError}` });
    }
  }

  try {
    purgeSmokeEvalContainers(makeDockerRunner(stack.spawnEnv), { project });
    cleanup.evalContainersPurged = true;
    telemetry.emit({ source: "cleanup", stream: "event", message: "eval containers purged" });
  } catch (error) {
    cleanup.evalContainersPurged = false;
    cleanup.evalContainerPurgeError = redactTelemetryText(error instanceof Error ? error.message : String(error));
    telemetry.emit({ source: "cleanup", stream: "event", message: `eval-container purge failed: ${cleanup.evalContainerPurgeError}` });
  }

  if (keep) {
    cleanup.stack = "kept";
    console.log(`\n[eval] --keep: tear down with:\n  docker compose -p ${project} down --volumes --remove-orphans`);
  } else {
    const down = stack.down({ removeVolumes: true, removeOrphans: true });
    cleanup.stack = down.exitCode === 0 ? "removed" : "remove-failed";
    cleanup.stackDownExitCode = down.exitCode;
    telemetry.emit({ source: "cleanup", stream: "event", message: `stack teardown exit=${down.exitCode}` });
    if (down.exitCode !== 0) console.error(`[eval] stack teardown failed: ${redactTelemetryText(down.stderr)}`);
  }

  artifacts.finish({
    version: 1,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    admitted,
    outcome,
    ...(result
      ? {
          timedOut: result.timedOut,
          memberId: result.memberId,
          applyState: result.applyState,
          claimedAt: result.claimedAt,
          onActiveRoster: result.onActiveRoster,
          steps: result.steps,
          containerExitCode: result.containerExitCode,
          containerLaunched: result.containerLaunched,
        }
      : {}),
    ...(failure
      ? { error: redactTelemetryText(failure instanceof Error ? failure.message : String(failure)) }
      : {}),
    cleanup,
  });
}

if (failure) throw failure;
return {
  admitted,
  outcome,
  durationMs: Date.now() - started,
  model: selectedModel,
  artifactDirectory: artifacts.directory,
  result,
};
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const projectArg = argv.indexOf("--project");
  const result = await runAdmissionEvalCase({
    keep: argv.includes("--keep"),
    project: projectArg >= 0 ? argv[projectArg + 1] : undefined,
  });
  process.exitCode = result.admitted ? 0 : 1;
}
