// The read-only rm_owner login proof of release step R1.2
// (backend/scripts/owner-login-check.ts): exactly SELECT 1 through the
// registry, a refusal that names `bun run role-passwords --target <target>`,
// and no password in any message.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerLoginRefusal, proveOwnerLogin, type OwnerConnection } from "../../../backend/scripts/owner-login-check.ts";

const PW = "owner-s3cret/pw";
const URL_ = `postgres://rm_owner:${encodeURIComponent(PW)}@db.example:25060/rm?sslmode=require`;

function fake(fail?: string): { issued: string[]; closed: () => boolean; connect: (url: string) => OwnerConnection } {
  const issued: string[] = [];
  let closed = false;
  const tag = (strings: TemplateStringsArray) => {
    issued.push(strings.join("?"));
    return fail ? Promise.reject(new Error(fail)) : Promise.resolve([{ "?column?": 1 }]);
  };
  return {
    issued,
    closed: () => closed,
    connect: () => ({ db: tag as unknown as OwnerConnection["db"], close: async () => { closed = true; } }),
  };
}

describe("proveOwnerLogin (release step R1.2)", () => {
  test("issues exactly SELECT 1 and closes the connection", async () => {
    const f = fake();
    await proveOwnerLogin(URL_, "stage", f.connect);
    expect(f.issued).toEqual(["SELECT 1"]);
    expect(f.closed()).toBe(true);
  });

  test("red: a failed login refuses with the role-passwords fix for the target, without the URL or the password, and still closes", async () => {
    const f = fake(`password authentication failed for ${URL_} (${PW})`);
    const err = await proveOwnerLogin(URL_, "prod", f.connect).then(() => null, (e: Error) => e);
    expect(err?.message).toStartWith("rm_owner cannot log in; run `bun run role-passwords --target prod` first");
    expect(err?.message).not.toContain(PW);
    expect(err?.message).not.toContain(encodeURIComponent(PW));
    expect(f.closed()).toBe(true);
  });

  test("the refusal text is the owner's wording", () => {
    expect(ownerLoginRefusal("stage")).toBe("rm_owner cannot log in; run `bun run role-passwords --target stage` first");
  });

  test("the statement is the registry's rm_owner connectionCheck, and the module never names doadmin as a role", async () => {
    const { registeredStatements } = await import("../../../backend/src/db/registry.ts");
    const mine = registeredStatements().filter((d) => d.site.startsWith("scripts/owner-login-check:")).map((d) => [d.site, d.role, d.shape, d.callers]);
    expect(mine).toEqual([["scripts/owner-login-check:proveOwnerLogin", "rm_owner", "connectionCheck", ["scripts/owner-login-check"]]]);
    const source = readFileSync(join(import.meta.dir, "../../../backend/scripts/owner-login-check.ts"), "utf8");
    expect(source).not.toMatch(/\brole\s*:\s*["'`]doadmin["'`]/);
    expect(source).not.toMatch(/\.unsafe\(/);
  });
});
