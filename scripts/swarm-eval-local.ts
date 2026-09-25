// Swarm authoring eval runner. Executes live swarm-take authoring
// against a stack core profile with real model inference.
import { ROUTES } from "@robotmoney/contract";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAdmissionEvalModelConfig } from "./onboarding-eval-local.ts";
import { DEMO_MEMBERS, DEMO_SUBJECTS, ensureSubjectViaAdmin, runRegimeClassify, runSession } from "./lib/swarm/session.ts";
import { resolveSmokeCadence } from "./lib/smoke-cadence.ts";
import {
  createStack,
  composeArgs,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  throwawayStackDatabase,
  dockerClientHostEnv,
  instanceComposeEnv,
  internalDatabaseUrl,
  resolveStackEnvironment,
  stackProjectName,
} from "./stack/index.ts";
import { readServiceToken } from "./lib/smoke-secret.ts";
import { throwawayInstance } from "./lib/smoke-state.ts";

export interface SwarmEvalCaseOptions {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  keep?: boolean;
  project?: string;
  suiteRunId?: string;
  evalId?: string;
  sampleId?: string;
}

export interface SwarmEvalCaseResult {
  passed: boolean;
  authoredCount: number;
  durationMs: number;
  model: string;
  artifactDirectory: string;
  sessionState: string | null;
}

interface KeptSwarmEvalState {
  project: string;
  /** The stack's throwaway state directory (smoke-state.ts throwawayInstance), token files included. */
  stateDir: string;
  composeFiles: string[];
  envClass: string;
  envHash: string;
  createdAt: string;
}

function safeProject(project: string): string {
  return project.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function swarmEvalStateFile(repoRoot: string, project: string): string {
  return join(repoRoot, ".agents", `swarm-eval-${safeProject(project)}.json`);
}

function writeKeptSwarmEvalState(repoRoot: string, state: KeptSwarmEvalState): string {
  const file = swarmEvalStateFile(repoRoot, state.project);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  return file;
}

export function cleanupKeptSwarmEval(
  repoRoot: string,
  project: string,
  hostEnv: Record<string, string | undefined> = process.env,
  runDown: (argv: string[], env: Record<string, string>) => number = (argv, env) =>
    Bun.spawnSync(argv, { cwd: repoRoot, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exitCode ?? 1,
): void {
  const stateFile = swarmEvalStateFile(repoRoot, project);
  if (!existsSync(stateFile)) throw new Error(`no kept swarm eval state found: ${stateFile}`);
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as KeptSwarmEvalState;
  if (state.project !== project) throw new Error(`kept swarm eval state project mismatch: ${state.project}`);
  const db = DEFAULT_STACK_DATABASE;
  const env: Record<string, string> = {
    ...dockerClientHostEnv(hostEnv),
    SMOKE_PROJECT: project,
    RM_STACK_ENV_CLASS: state.envClass,
    RM_STACK_ENV_HASH: state.envHash,
    DATABASE_URL: internalDatabaseUrl(db),
    POSTGRES_USER: db.user,
    POSTGRES_PASSWORD: db.password,
    POSTGRES_DB: db.name,
    ...instanceComposeEnv({ name: project, stateDir: state.stateDir }),
  };
  const code = runDown(
    ["docker", ...composeArgs(project, state.composeFiles), "down", "--volumes", "--remove-orphans"],
    env,
  );
  if (code !== 0) throw new Error(`swarm eval cleanup failed (docker compose exit ${code}); state retained at ${stateFile}`);
  // The throwaway state directory goes whole, its token files with it: the
  // database whose rows they matched was just removed with its volume.
  rmSync(dirname(state.stateDir), { recursive: true, force: true });
  rmSync(stateFile, { force: true });
}

export async function runSwarmAuthoringEvalCase(
  options: SwarmEvalCaseOptions = {},
): Promise<SwarmEvalCaseResult> {
  const repoRoot = options.repoRoot ?? fileURLToPath(new URL("..", import.meta.url));
  const env = options.env ?? process.env;
  // Pre-flight check: fails before stack bring-up if credentials or model selection are missing/keyless.
  const modelConfig = resolveAdmissionEvalModelConfig(env);
  const keep = options.keep ?? false;
  const stackEnvironment = resolveStackEnvironment(env);
  const project = options.project ?? stackProjectName("eval-swarm", stackEnvironment);
  const selectedModel = modelConfig.model;
  // Not a deployment instance, but the compose model needs a state directory
  // outside the checkout (RM_INSTANCE_STATE_DIR); thrown away with the stack.
  // Its three service-token files land there when stack.up() provisions them
  // on the stack's own database (scripts/stack/throwaway-database.ts).
  const instance = throwawayInstance(project);
  const stack = createStack(
    {
      repoRoot,
      project,
      profile: "full",
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: throwawayStackDatabase(instance.paths),
      environment: stackEnvironment,
      instance: { name: instance.name, stateDir: instance.stateDir },
    },
    {
      hostEnv: env,
      io: { stdout: "inherit", stderr: "inherit" },
    },
  );

  console.log(`[swarm-eval] project=${project} model=${selectedModel}`);
  const started = Date.now();
  let passed = false;
  let authoredCount = 0;
  let sessionState: string | null = null;
  let failure: unknown = null;
  let keptStateFile: string | undefined;

  if (keep) {
    keptStateFile = writeKeptSwarmEvalState(repoRoot, {
      project,
      stateDir: instance.stateDir,
      composeFiles: [...DEFAULT_COMPOSE_FILES],
      envClass: stackEnvironment.class,
      envHash: stackEnvironment.hash,
      createdAt: new Date().toISOString(),
    });
  }

  try {
    await stack.up();
    process.env.BACKEND_URL = stack.backendUrl;
    // The operator's token, provisioned into the throwaway instance by up().
    const operatorToken = readServiceToken(instance.paths, "operator");

    await stack.waitForHttp(`${stack.backendUrl}${ROUTES.swarm.members}`, 30_000);

    const today = new Date().toISOString().slice(0, 10);
    const rail = {
      repoRoot,
      composeProject: project,
      composeFiles: [...DEFAULT_COMPOSE_FILES],
      composeSpawnEnv: stack.spawnEnv,
      backendUrl: stack.backendUrl,
      modelConfig,
      // Threaded explicitly (issue #461 finding): agent.ts's enroll() reads
      // rail.operatorToken directly and has no env fallback of its own, so an
      // in-process rail that omitted it would register with no credential.
      operatorToken,
    };
    // No admin("reset") here either: the endpoint is gone. This eval runs on a
    // stack it created, so there is no prior history to clear — and if it is
    // ever pointed at one that has some, wiping it would be the wrong answer.
    await runRegimeClassify(today, rail);
    const subject = DEMO_SUBJECTS[0];
    const members = DEMO_MEMBERS.map((member) => ({ ...member }));
    await ensureSubjectViaAdmin(subject, operatorToken);

    // Member-container rail (issue #361 Phase 2): the session's members run in
    // their own containers against this eval stack.
    // A throwaway eval stack, never the standing smoke — so the fast profile, whose
    // two-minute submission window bounds this run (issue #570).
    const sessionRun = await runSession(subject, 1, {
      rail, members, initializer: "simulation", cadence: resolveSmokeCadence({ stage: false }),
    });
    sessionState = sessionRun.pub?.session?.state ?? null;
    const presentMembers = members.filter((m) => m.present);
    authoredCount = sessionRun.pub?.takes?.filter((t: any) => typeof t?.body === "string" && t.body.trim().length > 0).length ?? 0;

    if (sessionState === "published" && authoredCount >= presentMembers.length) {
      passed = true;
    }
  } catch (error) {
    failure = error;
    console.error(`[swarm-eval] failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!keep) {
      stack.down({ removeVolumes: true, removeOrphans: true });
      instance.dispose();
    } else {
      console.log(`[swarm-eval] --keep state: ${keptStateFile}`);
      console.log(`[swarm-eval] cleanup: bun scripts/swarm-eval-local.ts --cleanup --project ${project}`);
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
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    cleanupKeptSwarmEval(repoRoot, project);
    console.log(`[swarm-eval] cleaned kept project=${project}`);
    process.exit(0);
  }
  const result = await runSwarmAuthoringEvalCase({
    keep: argv.includes("--keep"),
    project,
  });
  process.exitCode = result.passed ? 0 : 1;
}
