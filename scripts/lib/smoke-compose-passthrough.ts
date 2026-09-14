// WHICH EXPORTED VARIABLES REACH THE COMPOSE STACK — AND A LEAF SO IT CAN BE
// TESTED.
//
// This list used to live inside smoke-main.ts, which allocates ports, generates
// secrets and opens log files at MODULE scope (scripts/tests/unit/
// stack-purity.test.ts says so in as many words). Importing it from a test is
// therefore not possible, so the one thing an operator most needs to be true —
// "the variable I exported actually arrives in the container" — was asserted
// nowhere. It cost this release two findings: `OPENCODE_API_KEY`, rescued
// during the release itself, and `SWARM_JUDGE_TIMEOUT_MS`, whose absence made
// the judge budget unreachable through the documented `bun run smoke:stage`
// boot and forced a QA run to recreate a service by hand with 27 values
// re-supplied.
//
// Everything here is a constant and a pure function. No environment read at
// module scope, nothing spawned.

/**
 * Exported values `bun smoke` / `bun run smoke:stage` forwards to the compose
 * stack. Every entry must also be interpolated in `docker-compose.yml` with a
 * `:-default`, so an unset value behaves exactly as before.
 *
 * Values `buildComposeEnv()` owns (ports, credentials, DATABASE_URL,
 * POSTGRES_*, DEMO_PROJECT) are deliberately NOT listed: the stack config is
 * their single source and an exported value must never shadow it.
 */
export const DEMO_COMPOSE_PASSTHROUGH = [
  "BASE_RPC_URL",
  "SWARM_AGGREGATE_CRON",
  "SWARM_CLOSE_WINDOW_CRON",
  "SWARM_NOTIFICATION_EMAIL_FROM",
  "SWARM_NOTIFICATION_EMAIL_TRANSPORT_TOKEN",
  "SWARM_NOTIFICATION_EMAIL_TRANSPORT_URL",
  "SWARM_OPEN_SESSION_CRON",
  "SWARM_PUBLISH_BRIEF_CRON",
  "SWARM_PUBLISH_CRON",
  "SWARM_SCHEDULES_ENABLED",
  "SWARM_WINDOW_MINUTES",
  // THE JUDGE'S TRANSPORT SETTINGS (this release). `docker-compose.yml` has
  // interpolated both into api and worker-swarm since the judge shipped, but
  // nothing carried them from the operator's shell to compose — so exporting
  // `SWARM_JUDGE_TIMEOUT_MS` produced an EMPTY variable in the container and
  // `resolveJudgeTimeoutMs()` fell back to the default, silently. The budget an
  // operator sets is the one lever over a judge that is timing out; it has to
  // reach the container through the boot the runbook documents.
  "SWARM_JUDGE_BASE_URL",
  "SWARM_JUDGE_TIMEOUT_MS",
  "FETCH_CACHE_DIR",
  "FLOOR_SEED_PATH",
  "PROJECTS_SOURCE",
  // NO "RM_ENV". It is a first-class StackConfig field now (`rmEnv`,
  // scripts/stack/config.ts) resolved from the KIND of boot by
  // resolveStackRmEnv(), and buildComposeEnv() refuses to see it in the extras
  // map. Passing it through from the operator's shell is exactly what made the
  // acceptance path a property of what somebody last typed (D13).
  "WORKER_DATABASE_URL",
] as const;

export function smokePassthroughEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DEMO_COMPOSE_PASSTHROUGH) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}
