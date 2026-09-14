// WHAT REACHES THE STACK'S COMPOSE ENVIRONMENT, AND WHERE IT CAME FROM.
//
// Two halves of one question, kept together because they are the same argument
// seen from opposite ends: the first value here is one the operator's shell is
// no longer allowed to decide, and the rest are the ones it still may.
//
// WHICH RM_ENV THIS BOOT DECLARES (D13).
//
// `RM_ENV` used to reach the containers from whatever the operator's shell last
// exported — or, far more often, from docker-compose.yml's `${RM_ENV:-smoke}`
// interpolation default, because nothing in the repository set it at all. That
// is how rm-frontend-stage-1 came to be running `RM_ENV=smoke` on 2026-09-13
// with every AC-MODEL-01 refusal disabled in the api, the worker and the judge.
//
// It is now a StackConfig field (`rmEnv`), resolved HERE from the kind of boot
// and emitted into every service by buildComposeEnv(). The rule itself lives in
// backend/src/acceptance-path.ts with the shared acceptance predicate; this
// wrapper only adds the FATAL/exit(1) convention smoke-main.ts's other
// preflights use. Both halves live outside smoke-main.ts because that file is
// under a line budget (scripts/tests/unit/smoke-main-split.test.ts) and because
// neither needs anything from the boot beyond its arguments.
import { resolveStackRmEnv, type RmEnv } from "../../backend/src/acceptance-path.ts";

/**
 * Refuses, rather than overrides, a `--static-port` boot whose shell claims a
 * development `RM_ENV`: that boot IS the staging deployment a tunnel points at,
 * and an operator who believes otherwise must be told rather than corrected
 * behind their back.
 */
export function resolveStackRmEnvOrExit(standingStack: boolean, env: NodeJS.ProcessEnv = process.env): RmEnv {
  try {
    return resolveStackRmEnv({ standingStack, declared: env.RM_ENV });
  } catch (err) {
    console.error(`[smoke] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ── What else the operator's shell may still contribute ─────────────────────
// Compose interpolation values the DEMO honours from the operator's own
// environment, passed to the shared stack explicitly via `extraComposeEnv`.
//
// Why an allowlist and not `...process.env`: scripts/stack deliberately does not
// inherit the ambient environment (§11.3 E1 — that is what keeps a provider key
// out of a container). But the DEMO is an operator tool, and these knobs are
// documented and load-bearing for it: exporting SWARM_WINDOW_MINUTES=5 or a
// custom BASE_RPC_URL before `bun run smoke` works today, and silently ignoring
// it after the bring-up moved onto the shared module would be a behaviour
// regression that is miserable to debug. Every name here is interpolated by
// docker-compose.yml / docker-compose.smoke.yml and each already carries a
// `:-default` there, so an unset value behaves exactly as before. Values
// buildComposeEnv() owns (ports, credentials, DATABASE_URL, POSTGRES_*,
// DEMO_PROJECT) are deliberately NOT listed: the stack config is their single
// source and an exported value must never shadow it.
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
