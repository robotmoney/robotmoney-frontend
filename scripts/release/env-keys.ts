// scripts/release/env-keys.ts — the D61 `~/.env` allowlist and the target a
// host's `~/.env` names.
//
// The keys spec §3 allows, with D61's `rm_owner`: a copy of preflight check
// 4's ENV_FILE_ALLOWED_KEYS (backend/src/db/preflight.ts), kept literal so the
// runner reads it before `bun install`. The release runner's env rewrite
// (C07-env-rewrite), host guard (S06-host-guards) and target check (P02-identity) use it.
// scripts/tests/unit/release-run.test.ts pins it equal to check 4's list.
//
// `doadmin` is NOT on the list (D61 amendment, owner, 2026-10-08): the release
// runbook uses `rm_owner` only. `doadmin` is never stored in a file: the admin
// types it at the hidden prompt of `bun run role-passwords --target <target>`,
// a provisioning step run before a release, and it lives only in that
// process's memory. C07-env-rewrite moves a stray `doadmin` line out of `~/.env`, like
// any other key off the list.
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
  "rm_readonly",
  "rm_owner",
  "RM_ENV",
  "RM_CREDENTIALS",
  "COINGECKO_API_KEY",
]);

/**
 * Keys `~/.env` must hold before a run (`bun run role-passwords --target
 * <target>` writes `rm_owner`; `RM_CREDENTIALS` has named the credential file
 * since v0.6.0). P02-identity refuses without them, before C05-migrate starts the
 * cutover: a run that migrated and then found one missing would stop between
 * the migrate and the rolling boot.
 */
export const PRE_CUTOVER_REQUIRED_KEYS: readonly string[] = Object.freeze(["rm_owner", "RM_CREDENTIALS"]);

/** Keys the run writes itself, and the step that writes each. None: the generic list writes no `~/.env` key (issue 1272). */
export const RUN_WRITTEN_KEYS: Readonly<Record<string, string>> = Object.freeze({});

/** Keys C07-env-rewrite (the env rewrite) requires again, as defence in depth. */
export const D61_REQUIRED_KEYS: readonly string[] = Object.freeze([...PRE_CUTOVER_REQUIRED_KEYS]);

/**
 * PURE. The P02-identity refusal about `~/.env` keys: a missing or empty pre-cutover
 * line. A message names the key and the file, never a value.
 */
export function preCutoverKeyProblems(env: Record<string, string | undefined>, envPath: string): string[] {
  const missing = PRE_CUTOVER_REQUIRED_KEYS.filter((k) => {
    const v = env[k];
    return v === undefined || v.trim() === "";
  });
  if (missing.length === 0) return [];
  return [
    `${envPath} has no non-empty ${missing.join(" or ")} line; run \`bun run role-passwords --target <target>\` first. ` +
      "C05-migrate starts the cutover, so this is checked before it",
  ];
}

/** `host:port/database` from a parsed `~/.env`, the form `--confirm-target` takes; undefined when incomplete. */
export function confirmTargetOf(env: Record<string, string | undefined>): string | undefined {
  const host = env.host;
  const db = databaseName(env);
  if (!host || !db) return undefined;
  return `${host}:${env.port && env.port !== "" ? env.port : "5432"}/${db}`;
}
