// Committee authoring eval runner. Executes live committee-take authoring
// against a stack core profile with real model inference.
import { ROUTES } from "@robotmoney/contract";
import { resolveAdmissionEvalModelConfig } from "./onboarding-eval-local.ts";
import { admin, MEMBERS, runRegimeClassify, runSession, SUBJECTS } from "./lib/committee/session.ts";
import {
  createStack,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  generateStackCredentials,
  resolveStackEnvironment,
  stackProjectName,
} from "./stack/index.ts";

export interface CommitteeEvalCaseOptions {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  keep?: boolean;
  project?: string;
  suiteRunId?: string;
  evalId?: string;
  sampleId?: string;
}

export interface CommitteeEvalCaseResult {
  passed: boolean;
  authoredCount: number;
  durationMs: number;
  model: string;
  artifactDirectory: string;
  sessionState: string | null;
}

export async function runCommitteeAuthoringEvalCase(
  options: CommitteeEvalCaseOptions = {},
): Promise<CommitteeEvalCaseResult> {
  const repoRoot = options.repoRoot ?? new URL("..", import.meta.url).pathname;
  const env = options.env ?? process.env;
  // Pre-flight check: fails before stack bring-up if credentials or model selection are missing/keyless.
  const modelConfig = resolveAdmissionEvalModelConfig(env);
  const keep = options.keep ?? false;
  const stackEnvironment = resolveStackEnvironment(env);
  const project = options.project ?? stackProjectName("eval-committee", stackEnvironment);
  const selectedModel = modelConfig.model;
  const credentials = generateStackCredentials();
  const stack = createStack(
    {
      repoRoot,
      project,
      profile: "full",
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      credentials,
      environment: stackEnvironment,
    },
    {
      hostEnv: env,
      io: { stdout: "inherit", stderr: "inherit" },
    },
  );

  console.log(`[committee-eval] project=${project} model=${selectedModel}`);
  const started = Date.now();
  let passed = false;
  let authoredCount = 0;
  let sessionState: string | null = null;
  let failure: unknown = null;

  try {
    await stack.up();
    process.env.BACKEND_URL = stack.backendUrl;
    process.env.ADMIN_TOKEN = credentials.adminToken;

    await stack.waitForHttp(`${stack.backendUrl}${ROUTES.committee.members}`, 30_000);

    const today = new Date().toISOString().slice(0, 10);
    await admin("reset");
    // Producer-computed (issue #361 Phase 4): enqueue regime.classify and wait
    // for the worker-analytics lane's submitted snapshot to be served.
    await runRegimeClassify(today);
    await admin("subject", SUBJECTS[0]);

    // Member-container rail (issue #361 Phase 2): the session's members run in
    // their own containers against this eval stack.
    const rail = {
      repoRoot,
      composeProject: project,
      composeFiles: DEFAULT_COMPOSE_FILES,
      composeSpawnEnv: stack.spawnEnv,
      modelConfig,
    };
    const sessionRun = await runSession(today, SUBJECTS[0], 1, { rail });
    sessionState = sessionRun.pub?.session?.state ?? null;
    const presentMembers = MEMBERS.filter((m) => m.present);
    authoredCount = sessionRun.pub?.takes?.filter((t: any) => typeof t?.body === "string" && t.body.trim().length > 0).length ?? 0;

    if (sessionState === "published" && authoredCount >= presentMembers.length) {
      passed = true;
    }
  } catch (error) {
    failure = error;
    console.error(`[committee-eval] failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!keep) {
      stack.down({ removeVolumes: true, removeOrphans: true });
    }
  }

  if (failure) throw failure;

  return {
    passed,
    authoredCount,
    durationMs: Date.now() - started,
    model: selectedModel,
    artifactDirectory: "",
    sessionState,
  };
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const projectArg = argv.indexOf("--project");
  const result = await runCommitteeAuthoringEvalCase({
    keep: argv.includes("--keep"),
    project: projectArg >= 0 ? argv[projectArg + 1] : undefined,
  });
  process.exitCode = result.passed ? 0 : 1;
}
