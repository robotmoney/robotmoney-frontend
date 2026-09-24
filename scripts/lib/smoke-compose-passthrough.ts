// WHICH EXPORTED VARIABLES REACH THE COMPOSE STACK — AND A LEAF SO IT CAN BE
// TESTED.
//
// This list used to live inside smoke-main.ts, which allocates ports, generates
// secrets and opens log files at MODULE scope (scripts/tests/unit/
// stack-purity.test.ts says so in as many words). Importing it from a test is
// therefore not possible, so the one thing an operator most needs to be true —
// "the variable I exported actually arrives in the container" — was asserted
// nowhere. It cost one release two findings: `OPENCODE_API_KEY` and
// `SWARM_JUDGE_TIMEOUT_MS`, both since removed from the stack entirely (D52:
// the judge is a participant and no stack service carries a model key).
//
// Everything here is a constant and a pure function. No environment read at
// module scope, nothing spawned.

/**
 * Exported values `bun smoke` forwards to the compose
 * stack. Every entry must also be interpolated in `docker-compose.yml` with a
 * `:-default`, so an unset value behaves exactly as before.
 *
 * Values `buildComposeEnv()` owns (ports, credentials, DATABASE_URL,
 * POSTGRES_*, DEMO_PROJECT) are deliberately NOT listed: the stack config is
 * their single source and an exported value must never shadow it.
 */
export const DEMO_COMPOSE_PASSTHROUGH = [
  "BASE_RPC_URL",
  // NO SESSION-SCHEDULING VARIABLE (issue #1026). Seven used to sit here — an
  // enable flag, five cron strings and a window. They are not merely
  // unforwarded, they no longer exist: a subject's epoch duration is the whole
  // schedule and it lives on the subject, set by bootstrap and changed only
  // through the admin API (system-scheduler-spec.md §2.2, §2.3). An operator
  // who exports one of the old names now gets exactly what the name deserves —
  // nothing, in every container.
  // NO JUDGE TRANSPORT SETTINGS. SWARM_JUDGE_BASE_URL and SWARM_JUDGE_TIMEOUT_MS
  // were forwarded here for an inline judge inside `api`; `api` no longer
  // interpolates either (D52: the judge is a participant), so forwarding them
  // would only carry a value to nothing.
  // THE TEST-ONLY JUDGE FAULT-INJECTION LEVER (backend/src/swarm/
  // judge-fault-injection.ts, R13). `docker-compose.yml` interpolates both
  // into api, and until this list named them, exporting either produced an
  // EMPTY variable in the container: an operator staging AC-E2E-06 through the
  // documented boot got a silent "flag_absent" refusal instead of the lever
  // they set. Blank by default (never enabled unless set).
  "SWARM_JUDGE_FAULT_INJECTION",
  "SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN",
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
