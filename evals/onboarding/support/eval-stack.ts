// Docker/compose bring-up for the ISOLATED onboarding claims — the SHARED
// scripts/stack module, never a fork (docs/architecture.md §11.3 E5).
//
// The isolated claims (runtime, skill-install, toolchain, keygen-signing) need
// NO server (§11.3 E3): only the member-agent IMAGE, built once and reused by
// every claim in the job via Docker's own layer cache. There is deliberately
// no `core`/`full` stack bring-up here — that belongs to the integrated
// admission eval alone.
//
// LOUD-SKIP-NEVER (§11.3 E2): every function here either succeeds or THROWS.
// `assertDockerAvailable()` returns void or throws — there is no boolean, no
// "available?" predicate, and no option a caller could turn into a conditional
// skip. A missing Docker daemon or missing egress fails the eval, loudly.
import { join } from "node:path";
import {
  createStack,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  dockerClientHostEnv,
  generateStackCredentials,
  resolveStackEnvironment,
  type Stack,
} from "../../../scripts/stack/index.ts";

// evals/onboarding/support/ -> repo root
export const repoRoot = join(import.meta.dir, "..", "..", "..");

// A dedicated "rmeval_" name family — distinct from the shared stack module's
// `eval` role (which the integrated admission eval already occupies) so that
// four isolated claims running concurrently in the SAME nightly job, each with
// its own project, can never collide with one another or with an admission
// run sharing the same environment hash. Pure and random — no environment read
// (§11.3 E1), matching every other function in this file.
export function evalProject(claim: string): string {
  return `rmeval_${claim}_${crypto.randomUUID().slice(0, 8)}`;
}

// A stack object used ONLY for its compose plumbing (build + teardown). No
// service is started: the isolated claims have no server by design.
export function imageOnlyStack(project: string): Stack {
  return createStack(
    {
      repoRoot,
      project,
      profile: "core",
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      credentials: generateStackCredentials(),
      environment: resolveStackEnvironment({}),
    },
    { hostEnv: dockerClientHostEnv(), io: { stdout: "pipe", stderr: "pipe" } },
  );
}

// Build the vanilla member-agent image. THROWS when Docker is unusable — that
// is the E2 behaviour, and it is why this is a plain call with no guard around
// it in any claim file.
export async function buildMemberAgentImage(stack: Stack): Promise<void> {
  stack.assertDockerAvailable();
  await stack.build(["member-agent"]);
}

// Teardown that can never mask an earlier failure by throwing over it, but is
// LOUD about leaving real Docker resources behind. `removeVolumes`/
// `removeOrphans` remove containers, networks, and (named) volumes for this
// run's project — never the images, which is what the workflow's build cache
// depends on staying warm across nightly runs.
export function tearDown(stack: Stack | null, label: string): void {
  if (!stack) return;
  const r = stack.down({ removeVolumes: true, removeOrphans: true });
  if (r.exitCode !== 0) {
    console.error(`[${label}] teardown for project ${stack.config.project} failed (exit ${r.exitCode}): ${r.stderr}`);
  }
}
