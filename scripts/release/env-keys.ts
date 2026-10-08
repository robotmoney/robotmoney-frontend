// scripts/release/env-keys.ts — the D61 `~/.env` allowlist and the target a
// host's `~/.env` names.
//
// The keys spec §3 allows, with D61's `rm_owner` and `doadmin`: a copy of
// preflight check 4's ENV_FILE_ALLOWED_KEYS (backend/src/db/preflight.ts), kept
// literal so the runner reads it before `bun install`. The release runner's env
// rewrite (R6.2), host guard (R7.7) and target check (R1.2) use it.
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

/**
 * Keys the operator must put in `~/.env` before a run. R1.2 refuses without
 * them, before R6.1 stops the legacy stack: a run that stopped the site and
 * then found one missing at R6.2 would leave the site down.
 */
export const PRE_CUTOVER_REQUIRED_KEYS: readonly string[] = Object.freeze(["doadmin"]);

/**
 * Keys the run writes itself, and the step that writes each. `RM_CREDENTIALS`
 * is written by R6.2a. `rm_owner` is optional before the run: R6.2b
 * (`prod-init enable-owner-login`) generates it when the line is absent and
 * keeps an existing one. Each must be written before the first step that
 * needs it (release-run.test.ts pins the order).
 */
export const RUN_WRITTEN_KEYS: Readonly<Record<string, string>> = Object.freeze({ RM_CREDENTIALS: "R6.2a", rm_owner: "R6.2b" });

/**
 * Keys R6.2 (the env rewrite) requires, as defence in depth: the pre-cutover
 * keys and `RM_CREDENTIALS`. Not `rm_owner`: R6.2 runs before R6.2b writes it.
 */
export const D61_REQUIRED_KEYS: readonly string[] = Object.freeze([...PRE_CUTOVER_REQUIRED_KEYS, "RM_CREDENTIALS"]);

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === "";

/**
 * PURE. The R1.2 refusals about `~/.env` keys: a missing or empty `doadmin`
 * line, and an `rm_owner` line that is present but empty (absent is fine:
 * R6.2b generates it). A message names the key and the file, never a value.
 */
export function preCutoverKeyProblems(env: Record<string, string | undefined>, envPath: string): string[] {
  const problems: string[] = [];
  const missing = PRE_CUTOVER_REQUIRED_KEYS.filter((k) => blank(env[k]));
  if (missing.length > 0) {
    problems.push(
      `${envPath} has no non-empty ${missing.join(" or ")} line. The cutover needs it (D61); ` +
        "add the line before the run, because R6.1 stops the legacy stack and R6.2 would refuse after it",
    );
  }
  if (env.rm_owner !== undefined && env.rm_owner.trim() === "") {
    problems.push(`${envPath} has an empty rm_owner line. Remove it, and R6.2b generates the password, or give it the role's password`);
  }
  return problems;
}

/** PURE. What R6.2b will do with `rm_owner`, from a parsed `~/.env`. */
export function rmOwnerPlan(env: Record<string, string | undefined>): "kept" | "generated-at-R6.2b" {
  return env.rm_owner === undefined ? "generated-at-R6.2b" : "kept";
}

/** `host:port/database` from a parsed `~/.env`, the form `--confirm-target` takes; undefined when incomplete. */
export function confirmTargetOf(env: Record<string, string | undefined>): string | undefined {
  const host = env.host;
  const db = databaseName(env);
  if (!host || !db) return undefined;
  return `${host}:${env.port && env.port !== "" ? env.port : "5432"}/${db}`;
}
