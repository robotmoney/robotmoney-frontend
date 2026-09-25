// The OPERATOR'S service token, as a host tool reads it — smoke-production
// spec §3 (D52): "the operator (the admin routes; this replaces the
// `ADMIN_TOKEN` environment variable)".
//
// The token lives in one place, the instance's `tokens/operator/token`
// (scripts/lib/smoke-state.ts `InstancePaths.tokenFiles`), provisioned by
// backend/scripts/provision-tokens.ts. A child process `bun smoke` starts for
// its own admin calls (the swarm session driver, the starter agent, the rmpc
// release driver, the browser checks) is handed the file's PATH in
// RM_OPERATOR_TOKEN_FILE, never the value: an environment variable is visible
// to every descendant and to `ps e`, a path to a 0600 file is not a secret.
//
// No module-scope work and no import beyond node:fs, so the member-agent rail
// and the browser tests can take it without pulling the smoke's state in.
import { readFileSync } from "node:fs";

/** The one variable a child reads to find the operator's token file. */
export const OPERATOR_TOKEN_FILE_ENV = "RM_OPERATOR_TOKEN_FILE";

/**
 * The operator's token, read from the file RM_OPERATOR_TOKEN_FILE names, or
 * undefined when the variable is unset. A named file that is missing or empty
 * THROWS, naming it: a caller told where the credential is must not quietly
 * proceed without it.
 */
export function operatorTokenFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const file = env[OPERATOR_TOKEN_FILE_ENV];
  if (file === undefined || file === "") return undefined;
  let token = "";
  try {
    token = readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new Error(`${OPERATOR_TOKEN_FILE_ENV}=${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!token) throw new Error(`${OPERATOR_TOKEN_FILE_ENV}=${file} is empty`);
  return token;
}

/** {@link operatorTokenFromEnv}, refusing when the variable is unset. */
export function requireOperatorToken(env: Record<string, string | undefined> = process.env): string {
  const token = operatorTokenFromEnv(env);
  if (token === undefined) {
    throw new Error(`${OPERATOR_TOKEN_FILE_ENV} is not set: this command makes admin calls with the operator's service token, and \`bun smoke\` names its file`);
  }
  return token;
}
