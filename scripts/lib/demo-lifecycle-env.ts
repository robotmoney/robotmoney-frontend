/** State fields required to inspect or tear down an existing demo stack. */
export interface DemoLifecycleState {
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
 */
export function buildDemoLifecycleComposeEnv(
  state: DemoLifecycleState,
  hostEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ANALYTICS_TOKEN_FILE_HOST;
  delete env.ANALYTICS_TOKEN;
  return {
    ...env,
    COMPOSE_PROJECT_NAME: state.project,
    COMPOSE_FILE: state.composeFiles,
    DEMO_PROJECT: state.project,
    RM_STACK_ENV_CLASS: state.envClass ?? "unknown",
    RM_STACK_ENV_HASH: state.envHash ?? "unknown",
    DATABASE_URL: state.databaseUrl,
    POSTGRES_USER: state.dbUser,
    POSTGRES_PASSWORD: state.dbPassword,
    POSTGRES_DB: state.dbName,
  };
}
