// What a database credential LOOKS LIKE in an environment (issue #1026 W3,
// smoke-production-spec.md §3 and §7.2).
//
// Two places must agree on this answer: the compose-config test that proves no
// service outside `api` and the pipeline worker is handed a database
// credential, and the participant's own startup refusal, which is the runtime
// half of the same rule (a participant holds no database credential at all).
// The list below was copied from
// scripts/tests/integration/no-db-credential-outside-api-compose-config.test.ts,
// so a participant refuses every name that test counts as a credential.
//
// A credential hides in two shapes, and a key-name list alone catches neither
// reliably:
//
//   - A NAME: `PGPASSWORD` is a credential whatever its value, because libpq
//     reads it on its own. So are the per-role password variables.
//   - A VALUE: `FOO=postgres://rm_app:x@db/rm` is a credential under an
//     innocuous name, and so is a libpq keyword DSN such as
//     `host=db user=rm_app password=x`, which carries no URL scheme at all.

/**
 * Environment names that hand a process a client credential for the database.
 *
 * `POSTGRES_PASSWORD` is NOT here. It is the server's own initialization
 * variable on the `postgres` service — the database setting its own password,
 * not a client being given one. A caller with a stricter rule (a participant
 * holds nothing that names Postgres at all) adds its own name pattern.
 */
export const DB_CREDENTIAL_KEYS = [
  "DATABASE_URL",
  "WORKER_DATABASE_URL",
  "PREFLIGHT_DATABASE_URL",
  "PGPASSWORD",
  "PGUSER",
  "PGPASSFILE",
  "RM_APP_PASSWORD",
  "RM_WORKER_PASSWORD",
  "RM_OWNER_PASSWORD",
  "RM_READONLY_PASSWORD",
] as const;

/** True when `key` is one of `DB_CREDENTIAL_KEYS`, compared case-insensitively. */
export function isDbCredentialKey(key: string): boolean {
  const upper = key.trim().toUpperCase();
  return (DB_CREDENTIAL_KEYS as readonly string[]).includes(upper);
}

/**
 * libpq connection keywords (PostgreSQL docs, "Parameter Key Words"). Only the
 * ones that locate or authenticate a connection count: a value naming two of
 * them is a DSN, not prose.
 */
const LIBPQ_KEYWORDS = [
  "host",
  "hostaddr",
  "port",
  "dbname",
  "user",
  "password",
  "passfile",
  "service",
  "sslmode",
  "sslcert",
  "sslkey",
  "target_session_attrs",
] as const;

/** The keywords that make a DSN point AT a database or authenticate to one. */
const LIBPQ_DECISIVE = new Set(["host", "hostaddr", "dbname", "user", "password", "passfile", "service"]);

/**
 * A value that is a Postgres connection string, whatever the key is called:
 * a `postgres://` / `postgresql://` URL, or a libpq keyword/value DSN naming at
 * least two distinct connection keywords, one of which locates or
 * authenticates the connection (`host=db user=x password=y`,
 * `dbname=rm user=rm_app`).
 */
export function looksLikeConnectionString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (/^postgres(ql)?:\/\//i.test(text)) return true;
  const found = new Set<string>();
  const pattern = new RegExp(`(?:^|\\s)(${LIBPQ_KEYWORDS.join("|")})\\s*=\\s*\\S`, "gi");
  for (const match of text.matchAll(pattern)) {
    found.add((match[1] ?? "").toLowerCase());
  }
  if (found.size < 2) return false;
  for (const keyword of found) if (LIBPQ_DECISIVE.has(keyword)) return true;
  return false;
}
