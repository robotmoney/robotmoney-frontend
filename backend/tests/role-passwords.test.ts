// `prod-init role-passwords` on a real Postgres (D61): the kept, set and
// rotated paths of backend/scripts/role-passwords.ts, driven through the real
// `rolePasswords` against the suite's cluster.
//
// THE PROOF THIS FILE OWES. Postgres accepts the SCRAM-SHA-256 verifier
// src/db/scram-verifier.ts computes: set it, then log in with the plaintext.
// The RFC 7677 vector (scripts/tests/unit/scram-verifier.test.ts) proves the
// arithmetic. This file proves the server agrees, that the plaintext never
// reaches it (pg_authid holds the verifier exactly as sent), that a rerun
// changes nothing, and that a runtime role's attributes never change.
//
// `doadmin` is stood in for the way tests/db-registry-execution.test.ts does: a
// LOGIN CREATEROLE role holding ADMIN on the four roles, not a superuser. The
// roles are cluster roles, so the suite's baseline (LOGIN, shared password) is
// restored after the file (tests/support/cluster.ts restoreRoleBaseline).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { PASSWORD_ROLES, rolePasswords, RolePasswordRefused, type PasswordRole, type RolePasswordsOptions } from "../scripts/role-passwords.ts";
import { passwordVerifierLiteral, scramSha256Verifier } from "../src/db/scram-verifier.ts";
import { parseEnvFile } from "../../scripts/lib/env-role.ts";
import { writeEnvSecret } from "../../scripts/lib/home-env-secret.ts";
import { adminExec, restoreRoleBaseline, ROLE_PASSWORD, roleUrl } from "./support/cluster.ts";

const DOADMIN = "rm_role_passwords_doadmin_standin";
const SCRATCH = "rm_scram_verifier_scratch";
const home = mkdtempSync(join(tmpdir(), "rm-role-passwords-home-"));
const envPath = join(home, ".env");
const HEADER = "# panel\nhost = h\nport = 5432\ndatabase = robotmoney\n";

/** Does `role` log in with `password` on the suite's cluster? */
async function canLogIn(role: string, password: string): Promise<boolean> {
  const db = postgres(urlWith(role, password), { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    await db`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await db.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function rolpassword(role: string): Promise<string> {
  const [row] = await adminExec(`SELECT rolpassword FROM pg_authid WHERE rolname = '${role}'`);
  return String(row?.rolpassword);
}

/** Every attribute a runtime role must keep. */
async function attributes(role: string): Promise<string> {
  const [row] = await adminExec(
    `SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = '${role}'`,
  );
  return JSON.stringify(row);
}

function urlWith(role: string, password: string): string {
  const url = new URL(roleUrl(role));
  url.password = encodeURIComponent(password);
  return url.toString();
}

const lines = (): Record<string, string> => parseEnvFile(readFileSync(envPath, "utf8"));

/** The options prod-init builds, over a real file standing in for ~/.env. */
function options(over: Partial<RolePasswordsOptions> = {}): RolePasswordsOptions & { reported: [PasswordRole, string][] } {
  const reported: [PasswordRole, string][] = [];
  return {
    doadminUrl: roleUrl(DOADMIN),
    roles: [...PASSWORD_ROLES],
    rotate: [],
    currentUrl: (role) => (lines()[role] ? urlWith(role, lines()[role]!) : undefined),
    urlWith,
    persist: (role, password, retire) => {
      writeEnvSecret(envPath, role, password, { retire });
    },
    report: (role, outcome) => reported.push([role, outcome]),
    reported,
    ...over,
  };
}

/** Count the ALTER ROLE statements the server saw, by the role's password changing. */
async function passwords(): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(PASSWORD_ROLES.map(async (r) => [r, await rolpassword(r)] as const)));
}

beforeAll(async () => {
  // cluster admin: CREATE ROLE and role membership are the provider's acts.
  await adminExec(`DROP ROLE IF EXISTS ${DOADMIN}`);
  await adminExec(`CREATE ROLE ${DOADMIN} LOGIN CREATEROLE NOINHERIT PASSWORD '${ROLE_PASSWORD()}'`);
  for (const role of PASSWORD_ROLES) await adminExec(`GRANT ${role} TO ${DOADMIN} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
  await adminExec(`DROP ROLE IF EXISTS ${SCRATCH}`);
  await adminExec(`CREATE ROLE ${SCRATCH} LOGIN`);
  // Production's pre-state: rm_owner NOLOGIN with no line; the runtime lines present and working.
  await adminExec("ALTER ROLE rm_owner NOLOGIN");
  const pw = ROLE_PASSWORD();
  writeFileSync(envPath, `${HEADER}rm_app = ${pw}\nrm_worker = ${pw}\nrm_readonly = ${pw}\n`, { mode: 0o600 });
});

afterAll(async () => {
  await restoreRoleBaseline();
  await adminExec(`DROP ROLE IF EXISTS ${SCRATCH}`);
  await adminExec(`DROP ROLE IF EXISTS ${DOADMIN}`);
  rmSync(home, { recursive: true, force: true });
});

describe("Postgres accepts the client-side SCRAM-SHA-256 verifier", () => {
  test("set the verifier, then log in with the plaintext; pg_authid holds the verifier exactly", async () => {
    const plaintext = "scratch-plaintext-Qm3xY8";
    const verifier = scramSha256Verifier(plaintext);
    await adminExec(`ALTER ROLE ${SCRATCH} PASSWORD ${passwordVerifierLiteral(verifier).sql}`);
    expect(await rolpassword(SCRATCH)).toBe(verifier);
    expect(await canLogIn(SCRATCH, plaintext)).toBe(true);
  });

  test("RED CONTROL: a wrong password is refused, so the login above was a real SCRAM check", async () => {
    expect(await canLogIn(SCRATCH, "scratch-plaintext-Qm3xY9")).toBe(false);
  });
});

describe("rolePasswords on a real cluster (D61)", () => {
  let ownerPassword = "";
  const runtimeAttributes: Record<string, string> = {};

  test("production's pre-state: rm_owner is set (LOGIN + verifier, line written, login proven); the working runtime lines are kept", async () => {
    for (const r of ["rm_app", "rm_worker", "rm_readonly"]) runtimeAttributes[r] = await attributes(r);
    const before = readFileSync(envPath, "utf8");
    const runtimeBefore = await passwords();
    const o = options();
    const result = await rolePasswords(o);
    expect(result).toEqual({ roles: { rm_app: "kept", rm_worker: "kept", rm_readonly: "kept", rm_owner: "set" }, ownerLoginBefore: false });
    ownerPassword = lines().rm_owner!;
    expect(ownerPassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(envPath, "utf8")).toBe(`${before}rm_owner = ${ownerPassword}\n`);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const [row] = await adminExec("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'");
    expect(row?.rolcanlogin).toBe(true);
    const stored = await rolpassword("rm_owner");
    expect(stored).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(stored).not.toContain(ownerPassword);
    expect(await canLogIn("rm_owner", ownerPassword)).toBe(true);
    // The kept runtime roles: not one ALTER, not one attribute changed.
    const runtimeAfter = await passwords();
    for (const r of ["rm_app", "rm_worker", "rm_readonly"]) {
      expect(runtimeAfter[r], r).toBe(runtimeBefore[r]!);
      expect(await attributes(r), r).toBe(runtimeAttributes[r]!);
    }
  });

  test("the rerun: every role kept, zero ALTERs (no rolpassword moves), ~/.env byte-identical", async () => {
    const text = readFileSync(envPath, "utf8");
    const before = await passwords();
    const result = await rolePasswords(options());
    expect(result.roles).toEqual({ rm_owner: "kept", rm_app: "kept", rm_worker: "kept", rm_readonly: "kept" });
    expect(await passwords()).toEqual(before);
    expect(readFileSync(envPath, "utf8")).toBe(text);
  });

  test("an absent runtime line is set without widening the role: password only, every attribute unchanged", async () => {
    const text = readFileSync(envPath, "utf8").replace(/^rm_worker = .*\n/m, "");
    writeFileSync(envPath, text, { mode: 0o600 });
    const result = await rolePasswords(options());
    expect(result.roles.rm_worker).toBe("set");
    const worker = lines().rm_worker!;
    expect(await canLogIn("rm_worker", worker)).toBe(true);
    expect(await canLogIn("rm_worker", ROLE_PASSWORD())).toBe(false);
    expect(await attributes("rm_worker")).toBe(runtimeAttributes.rm_worker!);
  });

  test("a line that does not log in refuses, names --rotate, changes nothing, and prints no secret", async () => {
    const good = readFileSync(envPath, "utf8");
    const wrong = "wrong-app-password-AbC123";
    writeFileSync(envPath, good.replace(/^rm_app = .*$/m, `rm_app = ${wrong}`), { mode: 0o600 });
    const before = await passwords();
    const error = await rolePasswords(options()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RolePasswordRefused);
    expect((error as Error).message).toContain("--rotate rm_app");
    for (const secret of [wrong, ROLE_PASSWORD(), ownerPassword]) expect((error as Error).message).not.toContain(secret);
    expect(await passwords()).toEqual(before);
    writeFileSync(envPath, good, { mode: 0o600 });
  });

  test("--rotate rm_owner: a new password works, the old one does not, the old line is retired 0600", async () => {
    const result = await rolePasswords(options({ roles: ["rm_owner"], rotate: ["rm_owner"] }));
    expect(result.roles).toEqual({ rm_owner: "rotated" });
    const rotated = lines().rm_owner!;
    expect(rotated).not.toBe(ownerPassword);
    expect(await canLogIn("rm_owner", rotated)).toBe(true);
    expect(await canLogIn("rm_owner", ownerPassword)).toBe(false);
    const retired = readdirSync(home).filter((f) => f.startsWith(".env.retired-"));
    expect(retired.length).toBe(1);
    expect(readFileSync(join(home, retired[0]!), "utf8")).toContain(`rm_owner = ${ownerPassword}`);
    expect(statSync(join(home, retired[0]!)).mode & 0o777).toBe(0o600);
  });
});
