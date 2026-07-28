// `bun run onboarding-eval` — run ONLY the §11 R8 real-inference onboarding
// eval, locally, against a throwaway stack.
//
// Why it exists: the eval is the required `e2e` gate's most expensive and most
// failure-prone step, and until this file the only way to exercise it was a
// full `bun run demo` in CI mode (browser checks, live smoke, Base RPC — tens
// of minutes, and rate-limit-prone on the shared runner) or a push to `main`.
// So a broken eval took a full CI cycle per hypothesis. That is how the gate
// stayed red for five consecutive runs over a container-permission bug and a
// CLI flag that never existed — neither of which needed a demo stack to find.
// This boots the `core` stack §11.3 E3 says layer 4 actually needs — postgres
// and the api, no worker lanes, no EDGAR seed, no frontend — and calls
// `runOnboardingEval` directly. One admission, ~3-20 minutes end to end.
//
// It is a DEVELOPER tool, never a CI gate: nothing in .github/workflows runs
// it, and it asserts nothing beyond the eval's own result. The eval that gates
// merges is the one `bun run demo` performs with ONBOARDING_REAL_EVAL=1, off
// the same `runOnboardingEval` this calls — one implementation, two callers
// (§11 R8: config-only differences, never a parallel code path).
//
// The bring-up is the SHARED scripts/stack module on its `core` profile, the
// same one scripts/tests/integration/onboarding-eval-infra.test.ts uses — not a
// fork of it. (§11.3 E5 / D22 "shared components": a second copy of the compose
// lifecycle is exactly the thing that module exists to delete.)
//
// Usage (needs docker + OPENCODE_API_KEY, or AGENT_MODEL=free for a keyless run):
//
//   OPENCODE_API_KEY=… bun run onboarding-eval
//   AGENT_MODEL=kimi bun run onboarding-eval --project rmeval_kimi_1 --keep
//
// Flags:
//   --project <name>  compose project name (default: a fresh rmeval_local_<hex>)
//   --keep            leave the stack up afterwards (prints the teardown command)
//
// Co-tenancy: this host also runs the self-hosted CI runner and a standing
// `rmdemo_*` demo. Both published ports are drawn free by allocatePorts (never
// the stage tunnel's pinned 48787, which is asserted below) and the default
// project name is unique per run, so a local run can never collide with CI's
// `rmdemo_ci_*` or with the standing demo. Teardown removes this run's volumes,
// this run's member-agent containers, and nothing else.
import { ROUTES } from "@robotmoney/contract";
import { makeDockerRunner, purgeDemoEvalContainers } from "./lib/demo-volumes.ts";
import { runOnboardingEval } from "./lib/onboarding-eval.ts";
import {
  allocatePorts,
  createStack,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  generateStackCredentials,
} from "./stack/index.ts";

const STAGE_TUNNEL_PORT = 48787; // pinned by cloudflared — never bind it here

const repoRoot = new URL("..", import.meta.url).pathname;
const argv = Bun.argv.slice(2);
const keep = argv.includes("--keep");
const projectArg = argv.indexOf("--project");
const project = projectArg >= 0 ? argv[projectArg + 1]! : `rmeval_local_${crypto.randomUUID().slice(0, 8)}`;

const [apiPort, pgPort] = await allocatePorts([{}, {}]);
for (const p of [apiPort!, pgPort!]) {
  if (p === STAGE_TUNNEL_PORT) throw new Error(`refusing to bind ${STAGE_TUNNEL_PORT} — the stage tunnel is pinned to it`);
}

const credentials = generateStackCredentials();
const stack = createStack(
  {
    repoRoot,
    project,
    profile: "core",
    apiPort: apiPort!,
    pgPort: pgPort!,
    composeFiles: DEFAULT_COMPOSE_FILES,
    database: DEFAULT_STACK_DATABASE,
    credentials,
  },
  { hostEnv: process.env, io: { stdout: "inherit", stderr: "inherit" } },
);

console.log(`[eval] project=${project} api=${apiPort} pg=${pgPort}`);
// Throws (never skips) on a missing/unusable Docker daemon, a postgres that
// never becomes ready, a failed migration, or a /health that never answers.
await stack.up();
await stack.waitForHttp(`${stack.backendUrl}${ROUTES.committee.members}`, 30_000);
await stack.build(["member-agent"]);

const started = Date.now();
let admitted = false;
try {
  const result = await runOnboardingEval({
    repoRoot,
    composeProject: project,
    composeFiles: DEFAULT_COMPOSE_FILES,
    backendUrl: stack.backendUrl,
    adminToken: credentials.adminToken,
    onEvent: (m) => console.log(`[eval] ${m}`),
  });
  admitted = result.admitted;
  console.log(
    `\n[eval] admitted=${result.admitted} timedOut=${result.timedOut} ` +
      `containerExit=${result.containerExitCode} elapsed=${Math.round((Date.now() - started) / 1000)}s`,
  );
  // Always present, admitted or not (an admitted run's transcript is what a
  // failed one gets diffed against). Already redacted of every secret this
  // process injected — see scripts/agent/member-agent.ts's redactSecrets.
  // Printing it is the whole point of running locally.
  if (result.transcript) console.log(`\n[eval] container transcript:\n${result.transcript}`);
} finally {
  // A member-agent container outlives its `docker compose run` CLI when that
  // CLI is killed (see memberAgentContainerName's comment), and `down` does not
  // reach one-shot `run` containers. Scoped to THIS project.
  try {
    purgeDemoEvalContainers(makeDockerRunner(stack.spawnEnv), { project });
  } catch (e) {
    console.error(`[eval] eval-container purge failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (keep) console.log(`\n[eval] --keep: tear down with:\n  docker compose -p ${project} down --volumes --remove-orphans`);
  else stack.down({ removeVolumes: true, removeOrphans: true });
}
// Non-zero on a failed admission so this is usable in a loop, matching how
// scripts/lib/demo-main.ts treats the same result.
process.exit(admitted ? 0 : 1);
