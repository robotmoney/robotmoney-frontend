// Committee authoring eval runner. Executes live committee-take authoring
// against a stack core profile with real model inference.
import { ROUTES } from "@robotmoney/contract";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAdmissionEvalModelConfig } from "./onboarding-eval-local.ts";
import { admin, MEMBERS, runRegimeClassify, runSession, SUBJECTS } from "./lib/committee/session.ts";
import {
  createStack,
  composeArgs,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  dockerClientHostEnv,
  generateStackCredentials,
  internalDatabaseUrl,
  resolveStackEnvironment,
  stackProjectName,
} from "./stack/index.ts";
import { provisionDemoAnalyticsToken, removeDemoAnalyticsToken } from "./lib/demo-secret.ts";

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

interface KeptCommitteeEvalState {
  project: string;
  analyticsTokenFile: string;
  composeFiles: string[];
  envClass: string;
  envHash: string;
  createdAt: string;
}

function safeProject(project: string): string {
  return project.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function committeeEvalStateFile(repoRoot: string, project: string): string {
  return join(repoRoot, ".agents", `committee-eval-${safeProject(project)}.json`);
}

function writeKeptCommitteeEvalState(repoRoot: string, state: KeptCommitteeEvalState): string {
  const file = committeeEvalStateFile(repoRoot, state.project);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  return file;
}

export function cleanupKeptCommitteeEval(
  repoRoot: string,
  project: string,
  hostEnv: Record<string, string | undefined> = process.env,
  runDown: (argv: string[], env: Record<string, string>) => number = (argv, env) =>
    Bun.spawnSync(argv, { cwd: repoRoot, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exitCode ?? 1,
): void {
  const stateFile = committeeEvalStateFile(repoRoot, project);
  if (!existsSync(stateFile)) throw new Error(`no kept committee eval state found: ${stateFile}`);
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as KeptCommitteeEvalState;
  if (state.project !== project) throw new Error(`kept committee eval state project mismatch: ${state.project}`);
  const db = DEFAULT_STACK_DATABASE;
  const env: Record<string, string> = {
    ...dockerClientHostEnv(hostEnv),
    DEMO_PROJECT: project,
    RM_STACK_ENV_CLASS: state.envClass,
    RM_STACK_ENV_HASH: state.envHash,
    DATABASE_URL: internalDatabaseUrl(db),
    POSTGRES_USER: db.user,
    POSTGRES_PASSWORD: db.password,
    POSTGRES_DB: db.name,
  };
  if (existsSync(state.analyticsTokenFile)) env.ANALYTICS_TOKEN_FILE_HOST = state.analyticsTokenFile;
  const code = runDown(
    ["docker", ...composeArgs(project, state.composeFiles), "down", "--volumes", "--remove-orphans"],
    env,
  );
  if (code !== 0) throw new Error(`committee eval cleanup failed (docker compose exit ${code}); state retained at ${stateFile}`);
  if (!removeDemoAnalyticsToken(state.analyticsTokenFile, project)) {
    throw new Error(`refused unsafe committee eval token cleanup path: ${state.analyticsTokenFile}`);
  }
  rmSync(stateFile, { force: true });
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
  credentials.analyticsTokenFile = provisionDemoAnalyticsToken(project, credentials.analyticsToken);
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
  let keptStateFile: string | undefined;

  if (keep) {
    keptStateFile = writeKeptCommitteeEvalState(repoRoot, {
      project,
      analyticsTokenFile: credentials.analyticsTokenFile,
      composeFiles: [...DEFAULT_COMPOSE_FILES],
      envClass: stackEnvironment.class,
      envHash: stackEnvironment.hash,
      createdAt: new Date().toISOString(),
    });
  }

  try {
    await stack.up();
    process.env.BACKEND_URL = stack.backendUrl;
    process.env.ADMIN_TOKEN = credentials.adminToken;

    await stack.waitForHttp(`${stack.backendUrl}${ROUTES.committee.members}`, 30_000);

    const today = new Date().toISOString().slice(0, 10);
    const rail = {
      repoRoot,
      composeProject: project,
      composeFiles: [...DEFAULT_COMPOSE_FILES],
      composeSpawnEnv: stack.spawnEnv,
      backendUrl: stack.backendUrl,
      modelConfig,
    };
    // No admin("reset") here either: the endpoint is gone. This eval runs on a
    // stack it created, so there is no prior history to clear — and if it is
    // ever pointed at one that has some, wiping it would be the wrong answer.
    await runRegimeClassify(today, rail);
    await admin("subject", SUBJECTS[0]);

    // Member-container rail (issue #361 Phase 2): the session's members run in
    // their own containers against this eval stack.
    const sessionRun = await runSession(SUBJECTS[0], 1, { rail });
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
      removeDemoAnalyticsToken(credentials.analyticsTokenFile!, project);
    } else {
      console.log(`[committee-eval] --keep state: ${keptStateFile}`);
      console.log(`[committee-eval] cleanup: bun scripts/committee-eval-local.ts --cleanup --project ${project}`);
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
  const project = projectArg >= 0 ? argv[projectArg + 1] : undefined;
  if (argv.includes("--cleanup")) {
    if (!project) throw new Error("--cleanup requires --project <compose-project>");
    const repoRoot = new URL("..", import.meta.url).pathname;
    cleanupKeptCommitteeEval(repoRoot, project);
    console.log(`[committee-eval] cleaned kept project=${project}`);
    process.exit(0);
  }
  const result = await runCommitteeAuthoringEvalCase({
    keep: argv.includes("--keep"),
    project,
  });
  process.exitCode = result.passed ? 0 : 1;
}
