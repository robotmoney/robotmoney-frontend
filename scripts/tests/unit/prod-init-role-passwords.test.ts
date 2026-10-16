// `prod-init role-passwords`' database decision (D61, spec §9.1 step 1):
// backend/scripts/role-passwords.ts rolePasswordsWith, over a seam that records
// every statement. No database: the real driver path is the same function with
// postgres behind the seam (backend/tests/role-passwords.test.ts runs it on
// Postgres, and scripts/tests/integration/prod-init-runtime.test.ts runs the CLI).
//
//   every line present and working → all `kept`, zero ALTERs (idempotent rerun).
//   a line absent                  → `set`: vetted verifier ALTER, persist, prove with the new password.
//   a line that fails              → refuse, nothing changed, names --rotate.
//   --rotate <role>                → `rotated`, retiring the old line.
//   rm_owner NOLOGIN, line kept    → `ALTER ROLE rm_owner LOGIN`, then prove.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PASSWORD_ROLES,
  PASSWORD_SET_SQL,
  RolePasswordRefused,
  rolePasswordsWith,
  scrub,
  type PasswordRole,
  type RolePasswordsSeam,
} from "../../../backend/scripts/role-passwords.ts";
import { isVettedVerifierLiteral, scramSha256Verifier } from "../../../backend/src/db/scram-verifier.ts";
import { ROLE_PASSWORD_ROLES } from "../../prod-init.ts";

const ALL = [...PASSWORD_ROLES];
const gen = (role: PasswordRole): string => `generated-${role}-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

interface Recorded {
  calls: string[];
  literals: Map<PasswordRole, { sql: string }>;
  persisted: [PasswordRole, string, boolean][];
  reported: [PasswordRole, string][];
  seam: RolePasswordsSeam;
}

/** `lines`: roles with a ~/.env line. `failing`: roles whose line does not log in. */
function seam(opts: { lines?: PasswordRole[]; failing?: PasswordRole[]; login?: Partial<Record<PasswordRole, boolean>>; missing?: PasswordRole[] } = {}): Recorded {
  const lines = new Set(opts.lines ?? ALL);
  const r: Recorded = { calls: [], literals: new Map(), persisted: [], reported: [], seam: undefined as never };
  r.seam = {
    async readLoginState() {
      r.calls.push("read");
      return new Map(ALL.filter((x) => !(opts.missing ?? []).includes(x)).map((x) => [x, opts.login?.[x] ?? true] as const));
    },
    hasLine: (role) => lines.has(role),
    async enableOwnerLogin() {
      r.calls.push("enableOwnerLogin");
    },
    async setPassword(role, literal) {
      r.calls.push(`set:${role}`);
      r.literals.set(role, literal);
    },
    async persist(role, password, retire) {
      r.calls.push(`persist:${role}`);
      r.persisted.push([role, password, retire]);
    },
    async proveLogin(role, password) {
      r.calls.push(`prove:${role}${password === undefined ? "" : ":new"}`);
      if (password === undefined && (opts.failing ?? []).includes(role)) throw new Error(`password authentication failed for user "${role}"`);
    },
    async assertLockHeld() {
      r.calls.push("lock");
    },
    report: (role, outcome) => {
      r.reported.push([role, outcome]);
    },
  };
  return r;
}
const ALTERS = /^(set:|enableOwnerLogin|persist:)/;

describe("rolePasswordsWith", () => {
  test("every line present and working: all kept, zero ALTERs, nothing persisted (the idempotent rerun)", async () => {
    const s = seam();
    const result = await rolePasswordsWith(s.seam, { roles: ALL, rotate: [] }, gen);
    expect(result).toEqual({ roles: { rm_owner: "kept", rm_app: "kept", rm_worker: "kept", rm_readonly: "kept" }, ownerLoginBefore: true });
    expect(s.calls.filter((c) => ALTERS.test(c))).toEqual([]);
    expect(s.calls).toEqual(["read", "prove:rm_owner", "prove:rm_app", "prove:rm_worker", "prove:rm_readonly"]);
  });

  test("absent lines are set: lock, the role's ALTER with a vetted verifier literal, persist, prove with the new password", async () => {
    const s = seam({ lines: ["rm_app"], login: { rm_owner: false } });
    const result = await rolePasswordsWith(s.seam, { roles: ALL, rotate: [] }, gen);
    expect(result).toEqual({ roles: { rm_app: "kept", rm_owner: "set", rm_worker: "set", rm_readonly: "set" }, ownerLoginBefore: false });
    expect(s.calls).toEqual([
      "read", "prove:rm_app",
      "lock", "set:rm_owner", "persist:rm_owner", "prove:rm_owner:new",
      "lock", "set:rm_worker", "persist:rm_worker", "prove:rm_worker:new",
      "lock", "set:rm_readonly", "persist:rm_readonly", "prove:rm_readonly:new",
    ]);
    expect(s.persisted).toEqual([["rm_owner", gen("rm_owner"), false], ["rm_worker", gen("rm_worker"), false], ["rm_readonly", gen("rm_readonly"), false]]);
    for (const [role, literal] of s.literals) {
      expect(isVettedVerifierLiteral(literal)).toBe(true);
      expect(literal.sql).not.toContain(gen(role));
      const salt = Buffer.from(/^'SCRAM-SHA-256\$4096:([^$]+)\$/.exec(literal.sql)![1]!, "base64");
      expect(literal.sql).toBe(`'${scramSha256Verifier(gen(role), { salt })}'`);
    }
  });

  test("RED CONTROL: a line that does not log in refuses, names --rotate, and changes nothing at all", async () => {
    const s = seam({ lines: ["rm_owner", "rm_app", "rm_worker"], failing: ["rm_app"] });
    const error = await rolePasswordsWith(s.seam, { roles: ALL, rotate: [] }, gen).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RolePasswordRefused);
    expect((error as Error).message).toMatch(/rm_app could not log in/);
    expect((error as Error).message).toMatch(/--rotate rm_app/);
    expect((error as Error).message).toMatch(/Nothing was changed/);
    // rm_readonly had no line: it is not set either, because the refusal comes first.
    expect(s.calls.filter((c) => ALTERS.test(c))).toEqual([]);
  });

  test("--rotate: the role gets a new password and its old line is retired, even though the line works", async () => {
    const s = seam();
    const result = await rolePasswordsWith(s.seam, { roles: ALL, rotate: ["rm_owner", "rm_worker"] }, gen);
    expect(result.roles).toEqual({ rm_app: "kept", rm_readonly: "kept", rm_owner: "rotated", rm_worker: "rotated" });
    expect(s.persisted).toEqual([["rm_owner", gen("rm_owner"), true], ["rm_worker", gen("rm_worker"), true]]);
  });

  test("--rotate is what replaces a failing line", async () => {
    const s = seam({ failing: ["rm_app"] });
    const result = await rolePasswordsWith(s.seam, { roles: ALL, rotate: ["rm_app"] }, gen);
    expect(result.roles.rm_app).toBe("rotated");
  });

  test("a kept rm_owner that is NOLOGIN: the others are proven first, then LOGIN, then its proof", async () => {
    const s = seam({ login: { rm_owner: false } });
    const result = await rolePasswordsWith(s.seam, { roles: ALL, rotate: [] }, gen);
    expect(result).toEqual({ roles: { rm_app: "kept", rm_worker: "kept", rm_readonly: "kept", rm_owner: "kept" }, ownerLoginBefore: false });
    expect(s.calls).toEqual(["read", "prove:rm_app", "prove:rm_worker", "prove:rm_readonly", "lock", "enableOwnerLogin", "prove:rm_owner"]);
  });

  test("a kept rm_owner whose line fails after LOGIN refuses, saying the password was not changed", async () => {
    const s = seam({ login: { rm_owner: false }, failing: ["rm_owner"] });
    await expect(rolePasswordsWith(s.seam, { roles: ALL, rotate: [] }, gen)).rejects.toThrow(/now LOGIN; its password was not changed.*--rotate rm_owner/);
    expect(s.calls.filter((c) => c.startsWith("set:") || c.startsWith("persist:"))).toEqual([]);
  });

  test("a runtime role is never given LOGIN: only rm_owner's paths touch LOGIN", async () => {
    const s = seam({ login: { rm_app: false }, failing: ["rm_app"] });
    await expect(rolePasswordsWith(s.seam, { roles: ALL, rotate: [] }, gen)).rejects.toThrow(RolePasswordRefused);
    expect(s.calls).not.toContain("enableOwnerLogin");
    expect(PASSWORD_SET_SQL.rm_app).not.toMatch(/LOGIN|SUPERUSER|CREATE/);
    expect(PASSWORD_SET_SQL.rm_worker).not.toMatch(/LOGIN|SUPERUSER|CREATE/);
    expect(PASSWORD_SET_SQL.rm_readonly).not.toMatch(/LOGIN|SUPERUSER|CREATE/);
    expect(PASSWORD_SET_SQL.rm_owner).toBe("ALTER ROLE rm_owner WITH LOGIN PASSWORD $1");
  });

  test("--roles narrows the set; a role outside it is never read, proven or set", async () => {
    const s = seam({ lines: [] });
    const result = await rolePasswordsWith(s.seam, { roles: ["rm_owner"], rotate: [] }, gen);
    expect(result.roles).toEqual({ rm_owner: "set" });
    expect(s.calls.some((c) => /rm_app|rm_worker|rm_readonly/.test(c))).toBe(false);
  });

  test("a missing role refuses with nothing run", async () => {
    const s = seam({ missing: ["rm_worker"] });
    await expect(rolePasswordsWith(s.seam, { roles: ALL, rotate: [] }, gen)).rejects.toThrow(/pg_roles has no rm_worker/);
    expect(s.calls).toEqual(["read"]);
  });

  test("a proof that fails after a set says the password is set and the rerun proves it", async () => {
    const s = seam({ lines: [] });
    s.seam.proveLogin = async () => {
      throw new Error("boom");
    };
    await expect(rolePasswordsWith(s.seam, { roles: ["rm_app"], rotate: [] }, gen)).rejects.toThrow(/generated password just written/);
  });

  test("the default generator is crypto-random base64url of 32 bytes, different per role", async () => {
    const s = seam({ lines: [] });
    await rolePasswordsWith(s.seam, { roles: ALL, rotate: [] });
    const passwords = s.persisted.map(([, p]) => p);
    for (const p of passwords) expect(p).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(passwords).size).toBe(4);
  });
});

describe("the statements, read from source", () => {
  const source = readFileSync(join(import.meta.dir, "../../../backend/scripts/role-passwords.ts"), "utf8");

  test("every statement goes through the registry: no raw statement, no quoted password, the one interpolation is the vetted literal", () => {
    expect(source).not.toMatch(/PASSWORD\s*'/i);
    expect(source).not.toMatch(/\.unsafe\(/);
    const issued = [...source.matchAll(/onStatement\((\w+), (\w+)\)(?:<[^>]*>)?`([^`]*)`/g)].map((m) => [m[1], m[2], m[3]!]);
    const interpolations = issued.flatMap(([, , text]) => [...text!.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]));
    expect([...new Set(interpolations)]).toEqual(["literal"]);
    expect(issued.map(([db, site]) => `${db}:${site}`)).toEqual([
      "admin:readLoginState",
      "admin:enableOwner",
      "admin:setOwnerPassword",
      "admin:setAppPassword",
      "admin:setWorkerPassword",
      "admin:setReadonlyPassword",
      "db:proveOwner",
      "db:proveApp",
      "db:proveWorker",
      "db:proveReadonly",
    ]);
  });

  test("the doadmin sites are the registry's provisioning shapes, and each proof is declared as the role it proves", async () => {
    const { registeredStatements } = await import("../../../backend/src/db/registry.ts");
    const mine = registeredStatements()
      .filter((d) => d.site.startsWith("scripts/role-passwords:"))
      .map((d) => [d.site.split(":")[1], d.role, d.shape]);
    expect(mine).toEqual([
      ["readLoginState", "doadmin", "rolesLoginState"],
      ["enableOwnerLogin", "doadmin", "ownerLoginEnable"],
      ["setOwnerPassword", "doadmin", "ownerPasswordSet"],
      ["setAppPassword", "doadmin", "appPasswordSet"],
      ["setWorkerPassword", "doadmin", "workerPasswordSet"],
      ["setReadonlyPassword", "doadmin", "readonlyPasswordSet"],
      ["proveOwnerLogin", "rm_owner", "connectionCheck"],
      ["proveAppLogin", "rm_app", "connectionCheck"],
      ["proveWorkerLogin", "rm_worker", "connectionCheck"],
      ["proveReadonlyLogin", "rm_readonly", "connectionCheck"],
    ]);
  });

  test("prod-init's role list equals the module's", () => {
    expect([...ROLE_PASSWORD_ROLES]).toEqual([...PASSWORD_ROLES]);
  });
});

describe("onStatement's password slot (the registry stays closed)", () => {
  /** A fake db that records what the registry hands it, so nothing connects. */
  function fakeDb(): { db: never; issued: unknown[][]; unsafe: string[] } {
    const issued: unknown[][] = [];
    const unsafe: string[] = [];
    const fn = (_strings: TemplateStringsArray, ...values: unknown[]) => {
      issued.push(values);
      return Promise.resolve([]);
    };
    (fn as unknown as { unsafe(text: string): unknown }).unsafe = (text: string) => {
      unsafe.push(text);
      return { fragment: text };
    };
    return { db: fn as never, issued, unsafe };
  }

  /** The registered rm_app password site, re-registered with the identical declaration (registration is idempotent). */
  async function appSite() {
    await import("../../../backend/scripts/role-passwords.ts");
    const { registerStatement } = await import("../../../backend/src/db/registry.ts");
    return registerStatement({
      role: "doadmin",
      shape: "appPasswordSet",
      site: "scripts/role-passwords:setAppPassword",
      purpose: "Sets rm_app's password to one generated on the host, sent only as its SCRAM-SHA-256 verifier; no attribute changes (D61).",
      callers: ["scripts/role-passwords"],
    });
  }

  test("a vetted literal fills the slot as an inlined fragment", async () => {
    const { onStatement } = await import("../../../backend/src/db/registry.ts");
    const { passwordVerifierLiteral } = await import("../../../backend/src/db/scram-verifier.ts");
    const site = await appSite();
    const f = fakeDb();
    const literal = passwordVerifierLiteral(scramSha256Verifier("pencil"));
    await onStatement(f.db, site)`ALTER ROLE rm_app WITH PASSWORD ${literal}`;
    expect(f.unsafe).toEqual([literal.sql]);
    expect(f.issued).toEqual([[{ fragment: literal.sql }]]);
  });

  test("RED CONTROL: a plaintext, a raw verifier string or a look-alike in the slot refuses before the database sees it", async () => {
    const { onStatement } = await import("../../../backend/src/db/registry.ts");
    const site = await appSite();
    const verifier = scramSha256Verifier("pencil");
    for (const bad of ["pencil", verifier, `'${verifier}'`, { kind: "scram-sha-256-verifier-literal", sql: `'${verifier}'` }]) {
      const f = fakeDb();
      expect(() => onStatement(f.db, site)`ALTER ROLE rm_app WITH PASSWORD ${bad}`).toThrow(/did not vet/);
      expect(f.issued).toEqual([]);
      expect(f.unsafe).toEqual([]);
    }
  });
});

describe("scrub", () => {
  test("removes raw and URL-encoded secrets", () => {
    const pw = "p@ss/w:rd";
    expect(scrub(`url postgres://doadmin:${encodeURIComponent(pw)}@h/db and ${pw}`, [pw])).toBe("url postgres://doadmin:***@h/db and ***");
  });

  test("red control: an empty secret list leaves the text alone", () => {
    expect(scrub("nothing secret", [""])).toBe("nothing secret");
  });
});
