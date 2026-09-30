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
  // THE TEST-ONLY JUDGE FAULT-INJECTION LEVER (backend/src/swarm/
  // judge-fault-injection.ts, R13). `docker-compose.yml` interpolates both
  // into api and worker-swarm, but the same gap as SWARM_JUDGE_TIMEOUT_MS
  // above meant exporting either produced an EMPTY variable in the
  // container: an operator staging AC-E2E-06 through the documented
  // `bun run smoke:stage` boot got a silent "flag_absent" refusal instead of
  // the lever they set. Blank by default (never enabled unless set).
  "SWARM_JUDGE_FAULT_INJECTION",
  "SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN",
  "FETCH_CACHE_DIR",
  "FLOOR_SEED_PATH",
  "PROJECTS_SOURCE",
  // THE PAID COINGECKO KEY (issue #1047). Both compose files interpolate it
  // into the three worker lanes, where projects.refresh_coins sends it to the
  // Pro host. Without this entry an exported key reached no container.
  "COINGECKO_API_KEY",
  // NO "RM_ENV". It is a first-class StackConfig field now (`rmEnv`,
  // scripts/stack/config.ts) resolved from the KIND of boot by
  // resolveStackRmEnv(), and buildComposeEnv() refuses to see it in the extras
  // map. Passing it through from the operator's shell is exactly what made the
  // acceptance path a property of what somebody last typed (D13).
  //
  // NOT "WORKER_DATABASE_URL" — except on an --db external boot, see
  // EXTERNAL_ONLY_PASSTHROUGH below. It was on this list from the 2026-07-28
  // extraction (9aaaaeec) until it cost a stage twin boot on 2026-09-18: the
  // stage checkout's `.env` carries the DEPLOYMENT's value
  // (`…@postgres:5432/robotmoney`, the rm_worker login of the persistent stack,
  // deployment.md §4.3) and bun auto-loads `.env` into the driver's process.env,
  // so every `bun smoke:twin` on that host forwarded it into all three worker
  // lanes. A smoke has no `postgres` service to resolve — `--db smoke-twin`/
  // `--db external` delete it outright — so each lane's first query died in DNS,
  // the lanes sat `unhealthy` forever, and every enqueued swarm.open_session
  // stayed `pending` at attempts=0. With an in-stack postgres the ephemeral
  // database's credentials are generated per boot, so an ambient rm_worker URL
  // would authenticate against nothing either. Unset, docker-compose.yml's `:-`
  // default leaves it empty and worker-client.ts falls back to the stack's
  // DATABASE_URL. Exported, it is reported and dropped
  // (smoke-compose-env.ts's shadowingStackEnvWarnings).
  //
  // Set only by a rehearsal that opted into RM_TWIN_PRODUCTION_PRIVILEGES; it
  // is what makes migrate.ts run as the non-superuser bootstrap login instead
  // of inheriting the container superuser's DATABASE_URL.
  "MIGRATE_DATABASE_URL",
] as const;

/**
 * Forwarded ONLY on an `--db external` boot, where the database IS the
 * deployment's and so is the operator's rm_worker URL: production's worker
 * lanes receive WORKER_DATABASE_URL through this path and no other (the v0.5.0
 * cutover, ec261867). Every other boot owns its database, so the same value is
 * a deployment URL pointing at a host that boot does not have — the 2026-09-18
 * stage twin. There it is dropped, and shadowingStackEnvWarnings() says so.
 */
export const EXTERNAL_ONLY_PASSTHROUGH = ["WORKER_DATABASE_URL"] as const;

export interface PassthroughOptions {
  /** The boot's data path is `--db external` (the deployment's own database). */
  external?: boolean;
}

export function smokePassthroughEnv(
  env: Record<string, string | undefined>,
  opts: PassthroughOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const names: readonly string[] = opts.external
    ? [...DEMO_COMPOSE_PASSTHROUGH, ...EXTERNAL_ONLY_PASSTHROUGH]
    : DEMO_COMPOSE_PASSTHROUGH;
  for (const k of names) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}
