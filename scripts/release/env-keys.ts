// scripts/release/env-keys.ts — the D61 `~/.env` allowlist and the target a
// host's `~/.env` names.
//
// D61 adds `rm_owner` and `doadmin` to the keys spec §3 allows (preflight
// check 4's ENV_FILE_ALLOWED_KEYS in backend/src/db/preflight.ts). The release
// runner's env rewrite (R6.2) and host guard (R7.7) use this list.
// scripts/tests/unit/release-run.test.ts pins it as a superset of check 4's.
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
