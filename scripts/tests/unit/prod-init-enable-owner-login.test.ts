// `prod-init enable-owner-login`'s database decision (D61, spec §9.1 step 1):
// backend/scripts/enable-owner-login.ts enableOwnerLoginWith, over a seam that
// records every statement. No database: the real driver path is the same
// function with postgres behind the seam.
//
//   NOLOGIN        → exactly `ALTER ROLE rm_owner LOGIN`, then the rm_owner login is proven.
//   already LOGIN  → no ALTER, the login is still proven (idempotent).
//   no role        → refuses, nothing runs.
//   login fails    → refuses after the ALTER, saying the password was not changed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALTER_OWNER_LOGIN_SQL,
  enableOwnerLoginWith,
  scrub,
  type EnableOwnerLoginSeam,
} from "../../../backend/scripts/enable-owner-login.ts";

function seam(canLogin: boolean | null, loginWorks = true): { calls: string[]; seam: EnableOwnerLoginSeam } {
  const calls: string[] = [];
  return {
    calls,
    seam: {
      async readCanLogin() {
        calls.push("read");
        return canLogin;
      },
      async alterLogin() {
        calls.push("alter");
      },
      async proveOwnerLogin() {
        calls.push("prove");
        if (!loginWorks) throw new Error("password authentication failed for user \"rm_owner\"");
      },
      async assertLockHeld() {
        calls.push("lock");
      },
    },
  };
}

describe("enableOwnerLoginWith", () => {
  test("NOLOGIN: the lock is proven, the ALTER runs, then the login is verified", async () => {
    const s = seam(false);
    expect(await enableOwnerLoginWith(s.seam)).toEqual({ rolcanloginBefore: false, altered: true, verified: true });
    expect(s.calls).toEqual(["read", "lock", "alter", "prove"]);
  });

  test("already LOGIN: no ALTER; the login is still verified", async () => {
    const s = seam(true);
    expect(await enableOwnerLoginWith(s.seam)).toEqual({ rolcanloginBefore: true, altered: false, verified: true });
    expect(s.calls).toEqual(["read", "prove"]);
  });

  test("no rm_owner role refuses with nothing run", async () => {
    const s = seam(null);
    await expect(enableOwnerLoginWith(s.seam)).rejects.toThrow(/pg_roles has no rm_owner role/);
    expect(s.calls).toEqual(["read"]);
  });

  test("a login that fails refuses, saying the password was not changed", async () => {
    const s = seam(false, false);
    await expect(enableOwnerLoginWith(s.seam)).rejects.toThrow(/now LOGIN; its password was not changed/);
    const t = seam(true, false);
    await expect(enableOwnerLoginWith(t.seam)).rejects.toThrow(/already LOGIN/);
  });

  test("the ALTER is exactly `ALTER ROLE rm_owner LOGIN`: no password clause, nothing else", () => {
    expect(ALTER_OWNER_LOGIN_SQL).toBe("ALTER ROLE rm_owner LOGIN");
    const source = readFileSync(join(import.meta.dir, "../../../backend/scripts/enable-owner-login.ts"), "utf8");
    expect(source).not.toMatch(/PASSWORD\s*'/i);
    // The driver runs only the two declared statements and a SELECT 1.
    const unsafe = [...source.matchAll(/\.unsafe\(([^)]*)\)/g)].map((m) => m[1]);
    expect(unsafe).toEqual(["READ_OWNER_LOGIN_SQL", "ALTER_OWNER_LOGIN_SQL", '"SELECT 1"']);
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
