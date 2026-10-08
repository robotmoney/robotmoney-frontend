// scripts/release/env-keys.ts — the D61 `~/.env` allowlist and the target a
// host's `~/.env` names.
//
// The keys spec §3 allows, with D61's `rm_owner` and `doadmin`: a copy of
// preflight check 4's ENV_FILE_ALLOWED_KEYS (backend/src/db/preflight.ts), kept
// literal so the runner reads it before `bun install`. The release runner's env
// rewrite (R6.2) and host guard (R7.7) use it.
// scripts/tests/unit/release-run.test.ts pins it equal to check 4's list.
//
// Pure: no file read, no environment read.
import { databaseName } from "../lib/env-role.ts";

export const D61_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "host",
  "port",
  "database",
  "dbname",
  "sslmode",
  "rm_app",
  "rm_worker",
  "rm_readonly",
  "rm_owner",
  "doadmin",
  "RM_ENV",
  "RM_CREDENTIALS",
  "COINGECKO_API_KEY",
]);

/** Keys the cutover needs in `~/.env`: without them a write step would stop halfway. */
export const D61_REQUIRED_KEYS: readonly string[] = Object.freeze(["rm_owner", "doadmin", "RM_CREDENTIALS"]);

/** `host:port/database` from a parsed `~/.env`, the form `--confirm-target` takes; undefined when incomplete. */
export function confirmTargetOf(env: Record<string, string | undefined>): string | undefined {
  const host = env.host;
  const db = databaseName(env);
  if (!host || !db) return undefined;
  return `${host}:${env.port && env.port !== "" ? env.port : "5432"}/${db}`;
}
