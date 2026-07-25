// Docker/compose bring-up for the onboarding eval — the SHARED scripts/stack
// module, never a fork (docs/architecture.md §11.3 E5).
//
// Two shapes, matching the layer table:
//   - layers 0-3 need NO server: only the member-agent IMAGE, built once.
//   - layer 4 needs a `core` stack (postgres + api) and nothing else. The eval
//     never boots the full demo cluster: no worker lanes, no EDGAR seed, no
//     frontend checks, no session drivers.
//
// LOUD-SKIP-NEVER (§11.3 E2): every function here either succeeds or THROWS.
// `assertDockerAvailable()` returns void or throws — there is no boolean, no
// "available?" predicate, and no option a caller could turn into a conditional
// skip. A missing Docker daemon or missing egress fails the eval, loudly.
//
// NO ENVIRONMENT READ (§11.3 E1): the docker-client plumbing a compose child
// needs comes from `dockerClientHostEnv()`, whose allowlist provably cannot
// carry a provider key, an admin token, or a model id. Nothing in this
// directory reads the ambient environment at all —
// `scripts/checks/check-eval-keyless.sh` fails the build if it ever does.
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import {
  allocatePorts,
  createStack,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  dockerClientHostEnv,
  generateStackCredentials,
  type Stack,
} from "../../../scripts/stack/index.ts";

// evals/onboarding/support/ -> repo root
export const repoRoot = join(import.meta.dir, "..", "..", "..");

export function evalProject(layer: string): string {
  return `rmeval_${layer}_${crypto.randomUUID().slice(0, 8)}`;
}

// A stack object used ONLY for its compose plumbing (build + teardown). No
// service is started: layers 0-3 have no server by design.
export function imageOnlyStack(project: string): Promise<Stack> {
  return allocatePorts([{}, {}]).then(([apiPort, pgPort]) =>
    createStack(
      {
        repoRoot,
        project,
        profile: "core",
        apiPort: apiPort!,
        pgPort: pgPort!,
        composeFiles: DEFAULT_COMPOSE_FILES,
        database: DEFAULT_STACK_DATABASE,
        credentials: generateStackCredentials(),
      },
      { hostEnv: dockerClientHostEnv(), io: { stdout: "pipe", stderr: "pipe" } },
    ),
  );
}

// Build the vanilla member-agent image. THROWS when Docker is unusable — that
// is the E2 behaviour, and it is why this is a plain call with no guard around
// it in any layer file.
export async function buildMemberAgentImage(stack: Stack): Promise<void> {
  stack.assertDockerAvailable();
  await stack.build(["member-agent"]);
}

export async function startCoreStack(project: string): Promise<Stack> {
  const [apiPort, pgPort] = await allocatePorts([{}, {}]);
  const stack = createStack(
    {
      repoRoot,
      project,
      profile: "core",
      apiPort: apiPort!,
      pgPort: pgPort!,
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      credentials: generateStackCredentials(),
    },
    { hostEnv: dockerClientHostEnv(), io: { stdout: "pipe", stderr: "pipe" } },
  );
  // Throws (never skips) when Docker is missing, postgres never becomes ready,
  // migrations fail, or /health never answers.
  await stack.up();
  await stack.waitForHttp(`${stack.backendUrl}${ROUTES.committee.members}`, 30_000);
  await buildMemberAgentImage(stack);
  return stack;
}

// Teardown that can never mask an earlier failure by throwing over it, but is
// LOUD about leaving real Docker resources behind.
export function tearDown(stack: Stack | null, label: string): void {
  if (!stack) return;
  const r = stack.down({ removeVolumes: true, removeOrphans: true });
  if (r.exitCode !== 0) {
    console.error(`[${label}] teardown for project ${stack.config.project} failed (exit ${r.exitCode}): ${r.stderr}`);
  }
}
