// The four §3 roles' passwords — the database half of `bun scripts/prod-init.ts
// role-passwords` (decision D61; smoke-production-spec.md §9.1 step 1).
//
// WHY. D61 keeps every role password as a `<role> = <password>` line in the
// host's `~/.env` and forbids hand steps. v0.5's
// scripts/ops/provision-db-role-taxonomy.sh created the roles idempotently as
// doadmin, but left their passwords to a person typing `\password`. 0.6's
// local mode (scripts/lib/smoke-database.ts) generates each password once and
// reuses it, so a rerun changes nothing. This module does the same for a
// remote target, as doadmin, with the line in `~/.env` as the saved copy.
//
// FOR EACH ROLE IN THE SET (default: all four), read from `~/.env` by the caller:
//   - line present, and that password logs in        → `kept`. No ALTER.
//   - line absent                                     → `set`: generate a
//     password on the host (32 crypto-random bytes, base64url), compute its
//     SCRAM-SHA-256 verifier here (src/db/scram-verifier.ts), run the role's
//     password ALTER as doadmin with the verifier (the server and its logs
//     never see the plaintext), hand the plaintext to the caller's `persist`
//     (an atomic `~/.env` write, scripts/lib/home-env-secret.ts), then prove
//     the login with it.
//   - line present, and the login fails               → refuse. Never a silent
//     rotation. `--rotate <role>` is the explicit way: the generate path, with
//     the old line kept in `~/.env.retired-<ts>` → `rotated`.
// (An EMPTY line is refused by the caller before anything connects.)
//
// rm_owner is NOLOGIN on a database that recorded migration 0053, and the
// runner never re-applies a recorded file. So rm_owner also gets LOGIN: in the
// same statement as its password (`ALTER ROLE rm_owner WITH LOGIN PASSWORD`),
// or, when its line is kept, `ALTER ROLE rm_owner LOGIN` before the proof. A
// runtime role's ALTER sets the password and nothing else: its attributes are
// never widened.
//
// THE ORDER makes a refusal change as little as possible: every present line
// that can be proven is proven first, and any failure refuses with nothing
// changed. Then a kept rm_owner that is NOLOGIN gets LOGIN. Then each role to
// set or rotate is set, persisted and proven, one at a time.
//
// A rerun finds every line it wrote, so it reports all `kept` and runs no
// ALTER: the command is idempotent. No password and no verifier is ever
// printed, logged, receipted or passed in argv. Every error leaving this
// module is scrubbed of every password it saw. The caller (scripts/prod-init.ts)
// holds the §2 target lock, passed here to be proven held before each ALTER.
//
// THE REGISTRY (spec §7.1). Every statement is registered: the catalog read and
// the ALTERs are the closed `PROVISIONING_SHAPES` list, declared as `doadmin`,
// which the registry admits from this module only (D61: "`doadmin` is used by
// one command only"). Each password ALTER's one slot takes only a literal
// scram-verifier.ts vetted. Each login proof is the object-less
// `connectionCheck` shape, declared as the role it proves.
import { onStatement, PROVISIONING_SHAPES, registerStatement, type RegistryDb } from "../src/db/registry.ts";
import { generatePassword, passwordVerifierLiteral, scramSha256Verifier, type PasswordVerifierLiteral } from "../src/db/scram-verifier.ts";
import type { HeldTargetLock } from "../src/db/target-lock.ts";

const MODULE = "scripts/role-passwords";

/** The roles this command manages: the four of spec §3, in the order it handles them. */
export const PASSWORD_ROLES = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"] as const;
export type PasswordRole = (typeof PASSWORD_ROLES)[number];

/** What happened to one role. The only thing about a password a receipt records. */
export type RoleOutcome = "kept" | "set" | "rotated";

const readLoginState = registerStatement({
  role: "doadmin",
  shape: "rolesLoginState",
  site: "scripts/role-passwords:readLoginState",
  purpose: "Reads which of the four §3 roles exist and may log in, before any password or LOGIN change (spec §9.1 step 1, D61).",
  callers: [MODULE],
});

const enableOwner = registerStatement({
  role: "doadmin",
  shape: "ownerLoginEnable",
  site: "scripts/role-passwords:enableOwnerLogin",
  purpose: "Makes rm_owner LOGIN without touching its password, because the runner never re-applies migration 0053 (spec §9.1 step 1, D61).",
  callers: [MODULE],
});

const setOwnerPassword = registerStatement({
  role: "doadmin",
  shape: "ownerPasswordSet",
  site: "scripts/role-passwords:setOwnerPassword",
  purpose: "Makes rm_owner LOGIN with a password generated on the host, sent only as its SCRAM-SHA-256 verifier (spec §9.1 step 1, D61).",
  callers: [MODULE],
});

const setAppPassword = registerStatement({
  role: "doadmin",
  shape: "appPasswordSet",
  site: "scripts/role-passwords:setAppPassword",
  purpose: "Sets rm_app's password to one generated on the host, sent only as its SCRAM-SHA-256 verifier; no attribute changes (D61).",
  callers: [MODULE],
});

const setWorkerPassword = registerStatement({
  role: "doadmin",
  shape: "workerPasswordSet",
  site: "scripts/role-passwords:setWorkerPassword",
  purpose: "Sets rm_worker's password to one generated on the host, sent only as its SCRAM-SHA-256 verifier; no attribute changes (D61).",
  callers: [MODULE],
});

const setReadonlyPassword = registerStatement({
  role: "doadmin",
  shape: "readonlyPasswordSet",
  site: "scripts/role-passwords:setReadonlyPassword",
  purpose: "Sets rm_readonly's password to one generated on the host, sent only as its SCRAM-SHA-256 verifier; no attribute changes (D61).",
  callers: [MODULE],
});

const proveOwner = registerStatement({
  role: "rm_owner",
  shape: "connectionCheck",
  site: "scripts/role-passwords:proveOwnerLogin",
  purpose: "Proves rm_owner logs in with the password in ~/.env (spec §9.1 step 1, D61).",
  callers: [MODULE],
});

const proveApp = registerStatement({
  role: "rm_app",
  shape: "connectionCheck",
  site: "scripts/role-passwords:proveAppLogin",
  purpose: "Proves rm_app logs in with the password in ~/.env (D61).",
  callers: [MODULE],
});

const proveWorker = registerStatement({
  role: "rm_worker",
  shape: "connectionCheck",
  site: "scripts/role-passwords:proveWorkerLogin",
  purpose: "Proves rm_worker logs in with the password in ~/.env (D61).",
  callers: [MODULE],
});

const proveReadonly = registerStatement({
  role: "rm_readonly",
  shape: "connectionCheck",
  site: "scripts/role-passwords:proveReadonlyLogin",
  purpose: "Proves rm_readonly logs in with the password in ~/.env (D61).",
  callers: [MODULE],
});

/** The SQL each password ALTER runs, by role: the registry's provisioning shapes. */
export const PASSWORD_SET_SQL: Readonly<Record<PasswordRole, string>> = Object.freeze({
  rm_owner: PROVISIONING_SHAPES.ownerPasswordSet,
  rm_app: PROVISIONING_SHAPES.appPasswordSet,
  rm_worker: PROVISIONING_SHAPES.workerPasswordSet,
  rm_readonly: PROVISIONING_SHAPES.readonlyPasswordSet,
});

export interface RolePasswordsOptions {
  /** A `doadmin` URL from `~/.env`. Never logged. */
  readonly doadminUrl: string;
  /** The roles to handle, a subset of {@link PASSWORD_ROLES}. */
  readonly roles: readonly PasswordRole[];
  /** `--rotate`: roles to give a new generated password even when their line exists. */
  readonly rotate: readonly PasswordRole[];
  /** The role's URL with its `~/.env` password, or undefined when `~/.env` has no line for it. */
  currentUrl(role: PasswordRole): string | undefined;
  /** The role's URL with `password`, built from the `~/.env` connection tokens. */
  urlWith(role: PasswordRole, password: string): string;
  /** Write `<role> = <password>` into `~/.env`; `retire` keeps the old line in `~/.env.retired-<ts>`. */
  persist(role: PasswordRole, password: string, retire: boolean): void | Promise<void>;
  /** Called once per role as its outcome is final, so a later failure still leaves a record. */
  report?(role: PasswordRole, outcome: RoleOutcome): void;
  readonly lock?: HeldTargetLock;
}

export interface RolePasswordsResult {
  /** role → kept / set / rotated, for every role handled. */
  readonly roles: Readonly<Partial<Record<PasswordRole, RoleOutcome>>>;
  /** rm_owner's `rolcanlogin` before anything ran; null when rm_owner was not in the set. */
  readonly ownerLoginBefore: boolean | null;
}

/** The effects the decision needs. Tests hand in fakes. */
export interface RolePasswordsSeam {
  /** `rolcanlogin` for each of the four roles that exists. */
  readLoginState(): Promise<ReadonlyMap<PasswordRole, boolean>>;
  /** Whether `~/.env` has a (non-empty) line for the role. */
  hasLine(role: PasswordRole): boolean;
  /** Exactly `ALTER ROLE rm_owner LOGIN`. */
  enableOwnerLogin(): Promise<void>;
  /** The role's password ALTER, with a vetted verifier literal. */
  setPassword(role: PasswordRole, literal: PasswordVerifierLiteral): Promise<void>;
  /** Keep a generated password in `~/.env`. */
  persist(role: PasswordRole, password: string, retire: boolean): Promise<void>;
  /** Log in as the role and run `SELECT 1`, with `password` or else its `~/.env` one. Throws when the login fails. */
  proveLogin(role: PasswordRole, password?: string): Promise<void>;
  /** Prove the target lock is still held. */
  assertLockHeld(): Promise<void>;
  report?(role: PasswordRole, outcome: RoleOutcome): void;
}

/** A refusal over a `~/.env` line that does not log in. It names `--rotate` and never rotates. */
export class RolePasswordRefused extends Error {}

/**
 * The decision, over a seam. `generate` makes each new password: tests pass a
 * fake to observe it, production uses {@link generatePassword}.
 */
export async function rolePasswordsWith(
  seam: RolePasswordsSeam,
  plan: { readonly roles: readonly PasswordRole[]; readonly rotate: readonly PasswordRole[] },
  generate: (role: PasswordRole) => string = () => generatePassword(),
): Promise<RolePasswordsResult> {
  const roles = PASSWORD_ROLES.filter((role) => plan.roles.includes(role));
  const state = await seam.readLoginState();
  const missing = roles.filter((role) => !state.has(role));
  if (missing.length > 0) {
    throw new Error(
      `pg_roles has no ${missing.join(", ")}. Spec §9.1 provisions the four roles through doadmin before this step ` +
        "(scripts/ops/provision-db-role-taxonomy.sh). Nothing was changed.",
    );
  }
  const action = (role: PasswordRole): "keep" | "set" | "rotate" =>
    plan.rotate.includes(role) ? "rotate" : seam.hasLine(role) ? "keep" : "set";
  const outcomes: Partial<Record<PasswordRole, RoleOutcome>> = {};
  const record = (role: PasswordRole, outcome: RoleOutcome): void => {
    outcomes[role] = outcome;
    seam.report?.(role, outcome);
  };
  const rotateHint = (failed: readonly PasswordRole[]): string =>
    `Refusing to rotate on its own. To set a new generated password through doadmin, rerun with --rotate ${failed.join(",")}: ` +
    "the old line is kept in $HOME/.env.retired-<timestamp>.";

  // 1. Prove every kept line that can log in now. Any failure: nothing changes.
  const ownerLoginBefore = roles.includes("rm_owner") ? state.get("rm_owner")! : null;
  const failed: { role: PasswordRole; why: string }[] = [];
  const keptNow = roles.filter((role) => action(role) === "keep" && !(role === "rm_owner" && ownerLoginBefore === false));
  for (const role of keptNow) {
    try {
      await seam.proveLogin(role);
    } catch (error) {
      failed.push({ role, why: (error as Error).message });
    }
  }
  if (failed.length > 0) {
    throw new RolePasswordRefused(
      `${failed.map((f) => `${f.role} could not log in with the password in $HOME/.env (${f.why})`).join("; ")}. ` +
        `Nothing was changed. ${rotateHint(failed.map((f) => f.role))}`,
    );
  }
  for (const role of keptNow) record(role, "kept");

  // 2. A kept rm_owner that is NOLOGIN: LOGIN, then the proof.
  if (roles.includes("rm_owner") && action("rm_owner") === "keep" && ownerLoginBefore === false) {
    await seam.assertLockHeld();
    await seam.enableOwnerLogin();
    try {
      await seam.proveLogin("rm_owner");
    } catch (error) {
      throw new RolePasswordRefused(
        `rm_owner could not log in with the password in $HOME/.env (${(error as Error).message}). ` +
          `The role is now LOGIN; its password was not changed. ${rotateHint(["rm_owner"])}`,
      );
    }
    record("rm_owner", "kept");
  }

  // 3. Each role to set or rotate: generate, ALTER with the verifier, persist, prove.
  for (const role of roles) {
    const what = action(role);
    if (what === "keep") continue;
    const password = generate(role);
    const literal = passwordVerifierLiteral(scramSha256Verifier(password));
    const retire = what === "rotate" && seam.hasLine(role);
    await seam.assertLockHeld();
    await seam.setPassword(role, literal);
    await seam.persist(role, password, retire);
    try {
      await seam.proveLogin(role, password);
    } catch (error) {
      throw new Error(
        `${role} could not log in with the generated password just written to $HOME/.env (${(error as Error).message}). ` +
          "The role holds that password. Rerun role-passwords to prove the login again.",
      );
    }
    record(role, retire ? "rotated" : "set");
  }
  return { roles: outcomes, ownerLoginBefore };
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

/** The real command: one doadmin connection, and one short connection per login proof. */
export async function rolePasswords(options: RolePasswordsOptions): Promise<RolePasswordsResult> {
  const { default: postgres } = await import("postgres");
  const { assertStillHeld } = await import("../src/db/target-lock.ts");
  const secrets: string[] = [options.doadminUrl, passwordOf(options.doadminUrl)];
  for (const role of PASSWORD_ROLES) {
    const url = options.currentUrl(role);
    if (url) secrets.push(url, passwordOf(url));
  }
  const admin = postgres(options.doadminUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  const generate = (): string => {
    const password = generatePassword();
    secrets.push(password);
    return password;
  };
  try {
    return await rolePasswordsWith(
      {
        async readLoginState() {
          const rows = await onStatement(admin, readLoginState)<{ rolname: string; rolcanlogin: boolean }>`SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('rm_owner', 'rm_app', 'rm_worker', 'rm_readonly') ORDER BY rolname`;
          return new Map(rows.map((r) => [r.rolname as PasswordRole, r.rolcanlogin === true]));
        },
        hasLine: (role) => options.currentUrl(role) !== undefined,
        async enableOwnerLogin() {
          await onStatement(admin, enableOwner)`ALTER ROLE rm_owner LOGIN`;
        },
        async setPassword(role, literal) {
          switch (role) {
            case "rm_owner":
              await onStatement(admin, setOwnerPassword)`ALTER ROLE rm_owner WITH LOGIN PASSWORD ${literal}`;
              return;
            case "rm_app":
              await onStatement(admin, setAppPassword)`ALTER ROLE rm_app WITH PASSWORD ${literal}`;
              return;
            case "rm_worker":
              await onStatement(admin, setWorkerPassword)`ALTER ROLE rm_worker WITH PASSWORD ${literal}`;
              return;
            case "rm_readonly":
              await onStatement(admin, setReadonlyPassword)`ALTER ROLE rm_readonly WITH PASSWORD ${literal}`;
              return;
          }
        },
        async persist(role, password, retire) {
          await options.persist(role, password, retire);
        },
        async proveLogin(role, password) {
          const url = password === undefined ? options.currentUrl(role) : options.urlWith(role, password);
          if (!url) throw new Error(`no ${role} password to prove`);
          if (password !== undefined) secrets.push(url);
          const db = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
          try {
            await proveAs(db, role);
          } finally {
            await db.end({ timeout: 5 }).catch(() => undefined);
          }
        },
        async assertLockHeld() {
          if (options.lock) await assertStillHeld(options.lock, "role-passwords");
        },
        report: options.report,
      },
      { roles: options.roles, rotate: options.rotate },
      generate,
    );
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error), secrets);
    throw error instanceof RolePasswordRefused ? new RolePasswordRefused(message) : new Error(message);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** `SELECT 1` as `role`, through that role's registered proof site. */
async function proveAs(db: RegistryDb, role: PasswordRole): Promise<void> {
  switch (role) {
    case "rm_owner":
      await onStatement(db, proveOwner)`SELECT 1`;
      return;
    case "rm_app":
      await onStatement(db, proveApp)`SELECT 1`;
      return;
    case "rm_worker":
      await onStatement(db, proveWorker)`SELECT 1`;
      return;
    case "rm_readonly":
      await onStatement(db, proveReadonly)`SELECT 1`;
      return;
  }
}

function passwordOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}
