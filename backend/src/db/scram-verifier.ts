// SCRAM-SHA-256 password verifiers, computed client-side (decision D61;
// `prod-init role-passwords`'s generate path).
//
// WHY. `prod-init role-passwords` sets a role's password through `doadmin`
// when `~/.env` has no line for it. Sending the plaintext in
// `ALTER ROLE ... PASSWORD '<plaintext>'` would put it in the server's
// statement log and in `pg_stat_activity`. Sending the verifier instead is what
// `psql \password` does: Postgres stores a string in the verifier format as it
// is, and the plaintext never leaves the host.
//
// THE FORMAT (RFC 5802, RFC 7677, and Postgres's `pg_authid.rolpassword`):
//
//   SCRAM-SHA-256$<iterations>:<base64 salt>$<base64 StoredKey>:<base64 ServerKey>
//
//   SaltedPassword = PBKDF2-HMAC-SHA-256(password, salt, iterations, 32)
//   ClientKey      = HMAC-SHA-256(SaltedPassword, "Client Key")
//   StoredKey      = SHA-256(ClientKey)
//   ServerKey      = HMAC-SHA-256(SaltedPassword, "Server Key")
//
// Postgres applies SASLprep to the password before hashing. SASLprep leaves
// printable ASCII unchanged, so this module accepts printable ASCII only and
// refuses anything else rather than guess at the normalization.
//
// THE LITERAL. `passwordVerifierLiteral` is the one vetted way to turn a
// verifier into SQL. It checks the verifier against the strict format (whose
// alphabet holds no quote and no backslash), doubles any single quote anyway,
// and wraps it in quotes. The result is an opaque, frozen value this module
// remembers. The registry (src/db/registry.ts, `onStatement`) runs the
// password-bearing provisioning shape only with a value this module made, so a
// string concatenated anywhere else cannot reach that statement.
//
// Nothing here prints, logs or throws a password or a verifier.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/** Postgres's default (`scram_iterations`), and the count RFC 7677's vector uses. */
export const SCRAM_ITERATIONS = 4096;

/** Postgres's default salt length, in bytes. */
export const SCRAM_SALT_BYTES = 16;

/** Bytes of entropy in a generated password (D61 generate path: at least 32). */
export const GENERATED_PASSWORD_BYTES = 32;

const B64 = "[A-Za-z0-9+/]+={0,2}";
/** The whole verifier format, anchored. The alphabet holds no `'` and no `\`. */
export const SCRAM_VERIFIER_PATTERN = new RegExp(`^SCRAM-SHA-256\\$[1-9][0-9]{0,6}:${B64}\\$${B64}:${B64}$`);

/** Printable ASCII: SASLprep leaves it unchanged, so the hash matches the server's. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** A fresh random password: 32 crypto-random bytes, base64url (43 URL-safe characters). */
export function generatePassword(bytes: number = GENERATED_PASSWORD_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < GENERATED_PASSWORD_BYTES) {
    throw new Error(`a generated password needs at least ${GENERATED_PASSWORD_BYTES} random bytes.`);
  }
  return randomBytes(bytes).toString("base64url");
}

/**
 * The SCRAM-SHA-256 verifier of `password`, in Postgres's format. `salt` is
 * random unless a test hands one in (the known vector).
 */
export function scramSha256Verifier(
  password: string,
  options: { readonly salt?: Buffer; readonly iterations?: number } = {},
): string {
  if (!PRINTABLE_ASCII.test(password)) {
    throw new Error("a SCRAM password must be non-empty printable ASCII (SASLprep would change anything else). The value is not printed.");
  }
  const iterations = options.iterations ?? SCRAM_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < SCRAM_ITERATIONS) {
    throw new Error(`a SCRAM verifier needs at least ${SCRAM_ITERATIONS} iterations.`);
  }
  const salt = options.salt ?? randomBytes(SCRAM_SALT_BYTES);
  if (salt.length === 0) throw new Error("a SCRAM salt cannot be empty.");
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** An opaque, vetted SQL string literal holding one verifier. Made only by {@link passwordVerifierLiteral}. */
export interface PasswordVerifierLiteral {
  readonly kind: "scram-sha-256-verifier-literal";
  /** The quoted SQL literal. Read only by the registry's `onStatement`. */
  readonly sql: string;
}

const vetted = new WeakSet<object>();

/** The literal's holder: the SQL lives in a private field, so inspecting, logging or serializing it shows no verifier. */
class VerifierLiteral implements PasswordVerifierLiteral {
  readonly kind = "scram-sha-256-verifier-literal" as const;
  readonly #sql: string;
  constructor(sql: string) {
    this.#sql = sql;
  }
  get sql(): string {
    return this.#sql;
  }
  toString(): string {
    return "[scram verifier literal]";
  }
  toJSON(): string {
    return "[scram verifier literal]";
  }
}

/**
 * The one vetted way to make a verifier into a SQL literal. Refuses a string
 * that is not exactly the verifier format, without printing it.
 */
export function passwordVerifierLiteral(verifier: string): PasswordVerifierLiteral {
  if (typeof verifier !== "string" || !SCRAM_VERIFIER_PATTERN.test(verifier)) {
    throw new Error("refusing to build a password literal from a value that is not a SCRAM-SHA-256 verifier. The value is not printed.");
  }
  const literal = Object.freeze(new VerifierLiteral(`'${verifier.replace(/'/g, "''")}'`));
  vetted.add(literal);
  return literal;
}

/** True only for a value {@link passwordVerifierLiteral} made in this process. */
export function isVettedVerifierLiteral(value: unknown): value is PasswordVerifierLiteral {
  return typeof value === "object" && value !== null && vetted.has(value);
}
