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
// The allowlist itself lives one module further down (smoke-compose-passthrough
// .ts) so the judge-transport test can import it without importing this file's
// RM_ENV resolver; it is re-exported here because smoke-main.ts wants both
// halves of "what reaches compose" from one import.
export { DEMO_COMPOSE_PASSTHROUGH, smokePassthroughEnv } from "./smoke-compose-passthrough.ts";
