// The read-only `rm_owner` login proof of release step R1.2
// (scripts/release/host-identity.ts), decision D61 as amended by the owner on
// 2026-10-08: the release runbook uses `rm_owner` only, never `doadmin`.
//
// WHAT IT DOES, AND NOTHING ELSE: log in as `rm_owner` with the password in
// `~/.env` and run `SELECT 1`. It changes nothing. R1.2 runs it before R6.1
// stops the legacy stack, so a missing, wrong or NOLOGIN owner refuses the run
// while the legacy site still serves. The fix is the provisioning step run
// before a release, `bun run role-passwords --target <target>`, which sets the
// password idempotently as `doadmin`. The admin types the doadmin password at
// a hidden prompt; it lives only in that process's memory, never in a file.
//
// THE REGISTRY (spec §7.1). The statement is the object-less `connectionCheck`
// shape, declared as `rm_owner`, so it is not a raw statement.
//
// It connects through Bun's built-in SQL client, not `postgres`, because R1.2
// runs before `bun install` (R1.3). The registry imports `postgres` as a type
// only. No URL and no password ever appears in a thrown message.
import { onStatement, registerStatement, type RegistryDb } from "../src/db/registry.ts";

const MODULE = "scripts/owner-login-check";

/** As rm_owner: the read-only login proof. */
const proveOwner = registerStatement({
  role: "rm_owner",
  shape: "connectionCheck",
  site: "scripts/owner-login-check:proveOwnerLogin",
  purpose: "Proves rm_owner logs in with the password in ~/.env, read-only, at release step R1.2 before the cutover's first irreversible step (D61).",
  callers: [MODULE],
});

/** The refusal R1.2 prints when the proof fails. Names the fix, never a value. */
export function ownerLoginRefusal(target: string): string {
  return `rm_owner cannot log in; run \`bun run role-passwords --target ${target}\` first`;
}

/** A connection for the proof. Tests hand in a fake. */
export interface OwnerConnection {
  readonly db: RegistryDb;
  close(): Promise<void>;
}

function bunConnect(url: string): OwnerConnection {
  const sql = new Bun.SQL(url, { max: 1, connectionTimeout: 10 });
  return { db: sql as unknown as RegistryDb, close: () => sql.close() };
}

/** Replace every occurrence of each secret, raw or URL-encoded, with `***`. */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.split(secret).join("***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("***");
  }
  return out;
}

function passwordOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}

/**
 * Log in as rm_owner and run `SELECT 1`. Throws `ownerLoginRefusal(target)`
 * plus the scrubbed driver message when the login fails. `target` is the
 * release target the fix names (`stage` or `prod`).
 */
export async function proveOwnerLogin(
  ownerUrl: string,
  target: string,
  connect: (url: string) => OwnerConnection = bunConnect,
): Promise<void> {
  const secrets = [ownerUrl, passwordOf(ownerUrl)];
  let conn: OwnerConnection | undefined;
  try {
    conn = connect(ownerUrl);
    const owner = conn.db;
    await onStatement(owner, proveOwner)`SELECT 1`;
  } catch (error) {
    throw new Error(`${ownerLoginRefusal(target)} (${scrub(error instanceof Error ? error.message : String(error), secrets)})`);
  } finally {
    await conn?.close().catch(() => undefined);
  }
}
