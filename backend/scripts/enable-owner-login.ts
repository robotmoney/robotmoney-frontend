// `rm_owner` LOGIN — the database half of `bun scripts/prod-init.ts
// enable-owner-login` (decision D61; smoke-production-spec.md §9.1 step 1).
//
// A database that recorded migration 0053 created `rm_owner` NOLOGIN, and the
// runner never re-applies a recorded file, so no migration can make it LOGIN.
// Spec §9.1 step 1 makes it LOGIN through `doadmin`. D61 scripts that step:
// "`doadmin` is used by one command only, `prod-init enable-owner-login`."
//
// WHAT IT DOES, AND NOTHING ELSE:
//   1. As `doadmin`, read `rolcanlogin` for `rm_owner` from `pg_roles`. A
//      missing role refuses: §9.1 provisions the roles before this step.
//   2. Only when `rolcanlogin` is false, run exactly `ALTER ROLE rm_owner
//      LOGIN`. The password is not set or changed here: the one in `~/.env` is
//      the password the role already has.
//   3. Prove a login as `rm_owner` with the `~/.env` password (`SELECT 1`).
// Already LOGIN: step 2 is skipped, step 3 still runs. That is what makes the
// command idempotent.
//
// No URL and no password ever appears in a thrown message: every error from
// the driver is scrubbed of both passwords before it leaves this module.
// The caller (scripts/prod-init.ts) holds the §2 target lock and passes it to
// be proven held before the ALTER.
//
// THE REGISTRY (spec §7.1). All three statements are registered, so none is a
// raw statement: steps 1 and 2 are the closed `PROVISIONING_SHAPES` list,
// declared as `doadmin`, which the registry admits from this module only
// (D61: "`doadmin` is used by one command only"). Step 3 is the object-less
// `connectionCheck` shape, declared as `rm_owner`.
//
// THE DOADMIN LOGIN PROOF (release step R1.2). `proveDoadminLogin` logs in as
// `doadmin` and runs `SELECT 1`, nothing else. Release step R1.2
// (scripts/release/host-identity.ts) calls it, read-only, before the cutover's
// first irreversible step, so a wrong or missing doadmin password refuses the
// run while the legacy site still serves (D61 amendment, 2026-10-08). It is
// declared HERE, not in host-identity, so this module stays the one place a
// doadmin statement is declared and PROVISIONING_CALLER stays one module:
// host-identity reaches it the way scripts/prod-init.ts reaches the rest. It
// connects through Bun's built-in SQL client, not `postgres`, because R1.2
// runs before `bun install` (R1.3).
import { onStatement, PROVISIONING_SHAPES, registerStatement, type RegistryDb } from "../src/db/registry.ts";
import type { HeldTargetLock } from "../src/db/target-lock.ts";

const MODULE = "scripts/enable-owner-login";

/** Step 1, as doadmin: a CATALOG read of rm_owner's `rolcanlogin`. */
const readOwnerCanLogin = registerStatement({
  role: "doadmin",
  shape: "ownerCanLogin",
  site: "scripts/enable-owner-login:readCanLogin",
  purpose: "Reads whether rm_owner exists and may log in, before deciding whether the ALTER is needed (spec §9.1 step 1, D61).",
  callers: [MODULE],
});

/** Step 2, as doadmin: the one DDL statement, run only on a NOLOGIN rm_owner. */
const alterOwnerLogin = registerStatement({
  role: "doadmin",
  shape: "ownerLoginEnable",
  site: "scripts/enable-owner-login:alterLogin",
  purpose: "Makes rm_owner LOGIN without touching its password, because the runner never re-applies migration 0053 (spec §9.1 step 1, D61).",
  callers: [MODULE],
});

/** Step 3, as rm_owner: the login proof. */
const proveOwner = registerStatement({
  role: "rm_owner",
  shape: "connectionCheck",
  site: "scripts/enable-owner-login:proveOwnerLogin",
  purpose: "Proves rm_owner logs in with the password in ~/.env once it is LOGIN (spec §9.1 step 1, D61).",
  callers: [MODULE],
});

/** R1.2, as doadmin: the read-only login proof. */
const proveDoadmin = registerStatement({
  role: "doadmin",
  shape: "doadminLoginCheck",
  site: "scripts/enable-owner-login:proveDoadminLogin",
  purpose: "Proves the doadmin password in ~/.env logs in, read-only, at release step R1.2 before the cutover's first irreversible step (D61).",
  callers: [MODULE],
});

/** A connection for the doadmin login proof. Tests hand in a fake. */
export interface DoadminConnection {
  readonly db: RegistryDb;
  close(): Promise<void>;
}

/** Bun's built-in client: R1.2 runs before `bun install`, so no package import. */
function bunConnect(url: string): DoadminConnection {
  const sql = new Bun.SQL(url, { max: 1, connectionTimeout: 10 });
  return { db: sql as unknown as RegistryDb, close: () => sql.close() };
}

/**
 * Log in as doadmin and run `SELECT 1`. Throws when the login fails; the
 * message never holds the URL or the password.
 */
export async function proveDoadminLogin(doadminUrl: string, connect: (url: string) => DoadminConnection = bunConnect): Promise<void> {
  const secrets = [doadminUrl, passwordOf(doadminUrl)];
  let conn: DoadminConnection | undefined;
  try {
    conn = connect(doadminUrl);
    const doadmin = conn.db;
    await onStatement(doadmin, proveDoadmin)`SELECT 1`;
  } catch (error) {
    throw new Error(`doadmin could not log in with the password in $HOME/.env (${scrub(error instanceof Error ? error.message : String(error), secrets)})`);
  } finally {
    await conn?.close().catch(() => undefined);
  }
}

export interface EnableOwnerLoginOptions {
  /** A `doadmin` URL from `~/.env`. Never logged. */
  readonly doadminUrl: string;
  /** An `rm_owner` URL from `~/.env`. Never logged. */
  readonly ownerUrl: string;
  readonly lock?: HeldTargetLock;
}

export interface EnableOwnerLoginResult {
  /** `rolcanlogin` as read before anything ran. */
  readonly rolcanloginBefore: boolean;
  /** Whether `ALTER ROLE rm_owner LOGIN` ran. */
  readonly altered: boolean;
  /** The rm_owner login was proven. */
  readonly verified: true;
}

/** The three effects the decision needs. Tests hand in fakes. */
export interface EnableOwnerLoginSeam {
  /** `rolcanlogin` for rm_owner, or null when the role does not exist. */
  readCanLogin(): Promise<boolean | null>;
  /** Exactly `ALTER ROLE rm_owner LOGIN`. */
  alterLogin(): Promise<void>;
  /** Log in as rm_owner and run `SELECT 1`. Throws when the login fails. */
  proveOwnerLogin(): Promise<void>;
  /** Prove the target lock is still held. */
  assertLockHeld(): Promise<void>;
}

/** The SQL the command runs, and no other DDL: the registry's provisioning shapes. */
export const ALTER_OWNER_LOGIN_SQL: string = PROVISIONING_SHAPES.ownerLoginEnable;
export const READ_OWNER_LOGIN_SQL: string = PROVISIONING_SHAPES.ownerCanLogin;

/** The decision, over a seam: read, ALTER only on NOLOGIN, then verify. */
export async function enableOwnerLoginWith(seam: EnableOwnerLoginSeam): Promise<EnableOwnerLoginResult> {
  const before = await seam.readCanLogin();
  if (before === null) {
    throw new Error(
      "pg_roles has no rm_owner role. Spec §9.1 provisions the four roles through doadmin before this step " +
        "(scripts/ops/provision-db-role-taxonomy.sh). Nothing was changed.",
    );
  }
  let altered = false;
  if (!before) {
    await seam.assertLockHeld();
    await seam.alterLogin();
    altered = true;
  }
  try {
    await seam.proveOwnerLogin();
  } catch (error) {
    throw new Error(
      `rm_owner could not log in with the password in $HOME/.env (${(error as Error).message}). ` +
        (altered ? "The role is now LOGIN; its password was not changed. " : "The role was already LOGIN. ") +
        "Check the rm_owner line in $HOME/.env against the role's password.",
    );
  }
  return { rolcanloginBefore: before, altered, verified: true };
}

/** Replace every occurrence of each secret with `***`. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.split(secret).join("***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("***");
  }
  return out;
}

/** The real command: doadmin and rm_owner connections over `postgres`. */
export async function enableOwnerLogin(options: EnableOwnerLoginOptions): Promise<EnableOwnerLoginResult> {
  const { default: postgres } = await import("postgres");
  const { assertStillHeld } = await import("../src/db/target-lock.ts");
  const secrets = [options.doadminUrl, options.ownerUrl, passwordOf(options.doadminUrl), passwordOf(options.ownerUrl)];
  const admin = postgres(options.doadminUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    return await enableOwnerLoginWith({
      async readCanLogin() {
        const rows = await onStatement(admin, readOwnerCanLogin)<{ rolcanlogin: boolean }>`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'`;
        return rows[0] === undefined ? null : rows[0].rolcanlogin === true;
      },
      async alterLogin() {
        await onStatement(admin, alterOwnerLogin)`ALTER ROLE rm_owner LOGIN`;
      },
      async proveOwnerLogin() {
        const owner = postgres(options.ownerUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
        try {
          await onStatement(owner, proveOwner)`SELECT 1`;
        } finally {
          await owner.end({ timeout: 5 }).catch(() => undefined);
        }
      },
      async assertLockHeld() {
        if (options.lock) await assertStillHeld(options.lock, "enable-owner-login");
      },
    });
  } catch (error) {
    throw new Error(scrub(error instanceof Error ? error.message : String(error), secrets));
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }
}

function passwordOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}
