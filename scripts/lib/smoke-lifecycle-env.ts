import type { DbMode } from "./smoke-db-mode.ts";
import { DOCKER_CLIENT_ENV_ALLOWLIST } from "../stack/config.ts";

/**
 * Which data path wrote this state file.
 *
 * `db` is authoritative; `externalPg` is the pre-refactor boolean, still written
 * alongside it, and is the only signal a state file from before `--db` carries.
 * One normaliser rather than three copies of the fallback, because smoke:down,
 * smoke:status and smoke:reap must never disagree about what a boot ran against.
 */
export function dbModeFromState(s: { db?: string; externalPg?: boolean }): DbMode {
  if (s.db === "ephemeral" || s.db === "external" || s.db === "smoke-twin") return s.db;
  return s.externalPg ? "external" : "ephemeral";
}

/** State fields required to inspect or tear down an existing smoke stack. */
export interface SmokeLifecycleState {
  project: string;
  composeFiles: string;
  databaseUrl: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  envClass?: string;
  envHash?: string;
}

/**
 * Rebuild the Compose environment for status/down without requiring producer
 * secret material. Those commands never launch the producer; Compose's
 * parse-only /dev/null secret source is sufficient even after cleanup.
 *
 * NOT the host environment. Only the docker-client plumbing on the stack's own
 * allowlist (scripts/stack/config.ts) survives from `hostEnv`; every value
 * compose interpolates comes from the state file. It used to spread the whole
 * of `hostEnv`, so an exported (or bun auto-loaded) DATABASE_URL, token or
 * project name could steer a teardown (criterion 122).
 */
export function buildSmokeLifecycleComposeEnv(
  state: SmokeLifecycleState,
  hostEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DOCKER_CLIENT_ENV_ALLOWLIST) {
    const value = hostEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    COMPOSE_PROJECT_NAME: state.project,
    COMPOSE_FILE: state.composeFiles,
    SMOKE_PROJECT: state.project,
    RM_STACK_ENV_CLASS: state.envClass ?? "unknown",
    RM_STACK_ENV_HASH: state.envHash ?? "unknown",
    DATABASE_URL: state.databaseUrl,
    POSTGRES_USER: state.dbUser,
    POSTGRES_PASSWORD: state.dbPassword,
    POSTGRES_DB: state.dbName,
  };
}
