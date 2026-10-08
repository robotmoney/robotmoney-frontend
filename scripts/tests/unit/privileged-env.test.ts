// scripts/lib/privileged-env.ts — D61's two rules, every branch:
//   - the privileged passwords come from `~/.env` lines, and a missing line
//     refuses naming the key and the file, never a value;
//   - `--confirm-target` must equal exactly the `host:port/database` `~/.env`
//     resolves to; nothing is normalized, and a mismatch prints both.
import { describe, expect, test } from "bun:test";
import {
  CONFIRM_TARGET_FLAG,
  ConfirmTargetRefused,
  confirmTargetFlag,
  homeEnvTarget,
  PrivilegedCredentialMissing,
  requireConfirmTarget,
  requirePrivilegedPassword,
} from "../../lib/privileged-env.ts";

const ENV_FILE = "/home/operator/.env";

describe("homeEnvTarget — the target exactly as ~/.env spells it", () => {
  test("host:port/database, port 5432 when absent, dbname accepted", () => {
    expect(homeEnvTarget({ host: "db.example", port: "25060", database: "rm" })).toBe("db.example:25060/rm");
    expect(homeEnvTarget({ host: "db.example", database: "rm" })).toBe("db.example:5432/rm");
    expect(homeEnvTarget({ host: "db.example", port: "25060", dbname: "rm" })).toBe("db.example:25060/rm");
  });

  test("nothing is normalized: the host's case is kept", () => {
    expect(homeEnvTarget({ host: "DB.Example", port: "25060", database: "rm" })).toBe("DB.Example:25060/rm");
  });

  test("no host or no database: undefined", () => {
    expect(homeEnvTarget({ database: "rm" })).toBeUndefined();
    expect(homeEnvTarget({ host: "db.example" })).toBeUndefined();
  });
});

describe("confirmTargetFlag — the flag's value from argv", () => {
  test("both spellings", () => {
    expect(confirmTargetFlag(["--confirm-target", "h:1/d"])).toBe("h:1/d");
    expect(confirmTargetFlag(["--confirm-target=h:1/d"])).toBe("h:1/d");
  });

  test("absent is undefined; a missing value or another flag is the empty string, which never matches", () => {
    expect(confirmTargetFlag(["--instance", "x"])).toBeUndefined();
    expect(confirmTargetFlag(["--confirm-target"])).toBe("");
    expect(confirmTargetFlag(["--confirm-target", "--instance", "x"])).toBe("");
  });
});

describe("requireConfirmTarget — the D61 replacement for the `y`", () => {
  const RESOLVED = "db.example:25060/rm";

  test("the exact target proceeds", () => {
    expect(() => requireConfirmTarget(RESOLVED, RESOLVED, "migrate")).not.toThrow();
  });

  test("no flag refuses, naming the flag and the target to confirm", () => {
    expect(() => requireConfirmTarget(undefined, RESOLVED, "migrate")).toThrow(ConfirmTargetRefused);
    expect(() => requireConfirmTarget(undefined, RESOLVED, "migrate")).toThrow(`Pass ${CONFIRM_TARGET_FLAG} ${RESOLVED}`);
  });

  test("a mismatch refuses and prints both", () => {
    let message = "";
    try {
      requireConfirmTarget("db.example:25060/other", RESOLVED, "migrate");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('"db.example:25060/other"');
    expect(message).toContain(`"${RESOLVED}"`);
  });

  test("nothing is normalized: case, whitespace, a trailing slash, a default port, an empty value all refuse", () => {
    for (const near of ["DB.EXAMPLE:25060/rm", ` ${RESOLVED}`, `${RESOLVED} `, `${RESOLVED}/`, "db.example/rm", "db.example:5432/rm", ""]) {
      expect(() => requireConfirmTarget(near, RESOLVED, "migrate")).toThrow(ConfirmTargetRefused);
    }
  });
});

describe("requirePrivilegedPassword — from the ~/.env line only", () => {
  test("returns the line's value", () => {
    expect(requirePrivilegedPassword({ rm_owner: "pw" }, "rm_owner", ENV_FILE)).toBe("pw");
    expect(requirePrivilegedPassword({ doadmin: "da" }, "doadmin", ENV_FILE)).toBe("da");
  });

  test("a missing or empty line, or no file, refuses naming the key and the file", () => {
    for (const env of [{}, { rm_owner: "" }, undefined]) {
      expect(() => requirePrivilegedPassword(env, "rm_owner", ENV_FILE)).toThrow(PrivilegedCredentialMissing);
      expect(() => requirePrivilegedPassword(env, "rm_owner", ENV_FILE)).toThrow(`${ENV_FILE} has no rm_owner line`);
    }
    expect(() => requirePrivilegedPassword({ rm_owner: "pw" }, "doadmin", ENV_FILE)).toThrow(`${ENV_FILE} has no doadmin line`);
  });

  test("a refusal never holds another line's value", () => {
    const secret = "the-rm-owner-value";
    let message = "";
    try {
      requirePrivilegedPassword({ rm_owner: secret }, "doadmin", ENV_FILE);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(secret);
  });

  test("it reads no environment variable: an exported value is not a source", () => {
    const before = process.env.rm_owner;
    process.env.rm_owner = "from-the-environment";
    try {
      expect(() => requirePrivilegedPassword({}, "rm_owner", ENV_FILE)).toThrow(PrivilegedCredentialMissing);
    } finally {
      if (before === undefined) delete process.env.rm_owner;
      else process.env.rm_owner = before;
    }
  });
});
