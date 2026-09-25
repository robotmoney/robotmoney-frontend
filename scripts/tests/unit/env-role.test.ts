// scripts/tests/unit/env-role.test.ts — pins THE ONE shared resolver every
// member of the smoke/twin/preflight/rollout family imports (issue #703).
//
// The contract under test (scripts/lib/env-role.ts is THE single resolver):
//
//   * ONE FILE. `.env` — the SAME `.env` a .env.example describes — lives at
//     the ROOT OF $HOME (`/root/.env` on a production deployment, on the
//     staging host `/home/stage-server/.env`). It is THE credential file for
//     the whole family. There is no `.env.readonly` any more, no second
//     discrete-keys file alongside it, and no repo-root `.env` either: the
//     ONLY thing the checkout carries is `.env.example`.
//
//   * DISCRETE TOKENS + ONE ROLE LINE PER ROLE. The DigitalOcean connection
//     panel prints `host port database sslmode` plus a username/password pair;
//     the file carries the SAME discrete tokens as its load-bearing keys plus,
//     per role, a `role = password` line (e.g. `rm_readonly = <the role's
//     password>`). The ROLE NAME IS THE USERNAME; its line's VALUE is that
//     role's password. `urlForRole` turns the discrete tokens + ONE role's
//     password into the ONE `postgres://…` URL that role is allowed to use. It
//     NEVER assembles a URL for more than one role from one call, so a single
//     file can hold rm_app / rm_worker / rm_readonly lines without any of them
//     being confused for another's connection.
//
//   * WHY DISCRETE, NOT A `DATABASE_URL`. Two reasons, both load-bearing.
//     (1) The digitalocean.com panel's panel prints discrete tokens; an
//     operator pastes them in and the file WORKS with no URL hand-assembly,
//     and (2) a role taxonomy exists precisely so that a read-only
//     rehearsing/twinning pair NEVER sees a writer credential. A committed
//     repo-root `.env`/`.env.readonly` that carried a full `DATABASE_URL` made
//     "which role was that, actually?" a question with a wrong-answer option.
//     The discrete form keeps the read-only role's line in the SAME file as
//     the writer's — one file, one taxonomy — while still letting
//     `urlForRole` prove at assembly time which one got used.
//
//   * IMPORT DISCIPLINE THE TEST CAN ASSERT. This file runs under
//     `bun test scripts/tests/unit` and imports the module at its real path
//     (`./env-role.ts` on disk); it needs nothing from src/. The tested module
//     is deliberately side-effect free apart from the explicit readFileSync in
//     loadEnvFile() — no process.env reads, no spawning — because the SMOKE
//     family (which imports it) may never read a credential off an ambient
//     environment, and this test suite drives every branch without a smoke
//     boot (same rule scripts/lib/smoke-external-pg.ts and smoke-main.ts's
//     header hold).
import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  CONNECTION_TOKENS,
  DATABASE_NAME_KEYS,
  HOME_ENV_FILE,
  databaseName,
  ROLES,
  homeEnvFilePath,
  loadEnvFile,
  parseEnvFile,
  redactPostgresUrl,
  urlForRole,
  redactedTarget,
} from "../../lib/env-role.ts";

const base: Record<string, string> = {
  host: "db-rm-app-x.do-user-12345-0.b.db.ondigitalocean.com",
  port: "25060",
  database: "defaultdb",
  sslmode: "require",
  rm_app: "app-pw-1",
  rm_worker: "worker-pw-2",
  rm_readonly: "readonly-pw-3",
};

describe("the file's identity — ONE file, its name, its one location", () => {
  test("HOME_ENV_FILE is exactly .env — there is no .env.readonly, ever", () => {
    expect(HOME_ENV_FILE).toBe(".env");
  });

  test("homeEnvFilePath() resolves to $HOME/.env for any home root", () => {
    expect(homeEnvFilePath("/root")).toBe("/root/.env");
    expect(homeEnvFilePath("/home/stage-server")).toBe(
      "/home/stage-server/.env",
    );
    expect(homeEnvFilePath()).toBe(join(homedir(), ".env"));
  });

  test("CONNECTION_TOKENS are exactly the discrete DO-panel tokens", () => {
    expect([...CONNECTION_TOKENS]).toEqual(["host", "port", "database", "sslmode"]);
  });

  test("ROLES is the one taxonomy this family can assemble", () => {
    expect([...ROLES]).toEqual(["rm_app", "rm_worker", "rm_readonly"]);
  });
});

describe("parseEnvFile — permissive about the DO panel's spacing, strict about nothing else", () => {
  test("parses host with spaces around '=' as the panel prints it", () => {
    const env = parseEnvFile(
      "host = db-rm-app-x.do-user-12345-0.b.db.ondigitalocean.com\n" +
        "port = 25060\n" +
        "database = defaultdb\n" +
        "sslmode = require\n",
    );
    expect(env.host).toBe("db-rm-app-x.do-user-12345-0.b.db.ondigitalocean.com");
    expect(env.port).toBe("25060");
    expect(env.database).toBe("defaultdb");
    expect(env.sslmode).toBe("require");
  });

  test("skips comments and blank lines; strips quotes around a value", () => {
    const env = parseEnvFile(
      "# a comment\n\nhost = \"db-x.a.db.ondigitalocean.com\"\nport = '25060'\n",
    );
    expect(env.host).toBe("db-x.a.db.ondigitalocean.com");
    expect(env.port).toBe("25060");
  });

  test("an export prefix is tolerated", () => {
    const env = parseEnvFile("export host = db-x.a.db.ondigitalocean.com\n");
    expect(env.host).toBe("db-x.a.db.ondigitalocean.com");
  });
});

describe("urlForRole — ONE role, ONE assembled URL, never a second role's", () => {
  test("assembles the rm_readonly URL from the discrete tokens + its own role line", () => {
    const url = urlForRole(base, "rm_readonly");
    expect(url).toBeDefined();
    const u = new URL(url!);
    expect(u.protocol).toBe("postgres:");
    expect(u.username).toBe("rm_readonly");
    expect(u.password).toBe("readonly-pw-3");
    expect(u.hostname).toBe("db-rm-app-x.do-user-12345-0.b.db.ondigitalocean.com");
    expect(u.port).toBe("25060");
    expect(u.pathname).toBe("/defaultdb");
    expect(u.searchParams.get("sslmode")).toBe("require");
  });

  test("the SAME call never names two roles' URLs", () => {
    const appUrl = urlForRole(base, "rm_app");
    const roUrl = urlForRole(base, "rm_readonly");
    expect(new URL(appUrl!).username).toBe("rm_app");
    expect(new URL(roUrl!).username).toBe("rm_readonly");
    expect(new URL(appUrl!).password).not.toBe(new URL(roUrl!).password);
  });

  test("a role whose password line is absent yields undefined — never a default", () => {
    const withoutRo = { ...base };
    delete withoutRo.rm_readonly;
    expect(urlForRole(withoutRo, "rm_readonly")).toBeUndefined();
  });

  test("a half-specified connection yields undefined — never a half URL", () => {
    const noHost = { ...base };
    delete noHost.host;
    expect(urlForRole(noHost, "rm_app")).toBeUndefined();
  });

  test("sslmode defaults to require when the file omits it", () => {
    const noSsl = { ...base };
    delete noSsl.sslmode;
    const u = new URL(urlForRole(noSsl, "rm_app")!);
    expect(u.searchParams.get("sslmode")).toBe("require");
  });
});

describe("the database name — both spellings preflight check 4 accepts (criterion 150 residual)", () => {
  test("DATABASE_NAME_KEYS is the panel's `database` and spec §3's `dbname`", () => {
    expect([...DATABASE_NAME_KEYS]).toEqual(["database", "dbname"]);
  });

  test("a ~/.env written with the spec's `dbname` spelling assembles a URL", () => {
    // Red control: before the residual was fixed urlForRole read only
    // `env.database`, so this file passed check 4 and could not connect.
    const { database: _panel, ...rest } = base;
    const env = { ...rest, dbname: "specdb" };
    expect(databaseName(env)).toBe("specdb");
    const u = new URL(urlForRole(env, "rm_readonly")!);
    expect(u.pathname).toBe("/specdb");
  });

  test("`database` wins when both are present; neither is a refusal, not a default", () => {
    expect(databaseName({ database: "panel", dbname: "spec" })).toBe("panel");
    expect(databaseName({ dbname: "" })).toBeUndefined();
    const { database: _panel, ...rest } = base;
    expect(urlForRole(rest, "rm_readonly")).toBeUndefined();
  });
});

describe("redactPostgresUrl + redactedTarget — the only forms safe to print", () => {
  test("redactPostgresUrl masks the password", () => {
    const url = urlForRole(base, "rm_app")!;
    const redacted = redactPostgresUrl(url);
    expect(redacted).not.toContain("app-pw-1");
    expect(redacted).toContain("rm_app");
    expect(redacted).toContain("db-rm-app-x.do-user-12345-0.b.db.ondigitalocean.com");
  });

  test("redactedTarget names role@host:port/database without the password", () => {
    const url = urlForRole(base, "rm_readonly")!;
    const t = redactedTarget(url, "rm_readonly");
    expect(t).toBe(
      "rm_readonly@db-rm-app-x.do-user-12345-0.b.db.ondigitalocean.com:25060/defaultdb",
    );
    expect(t).not.toContain("readonly-pw-3");
  });

  test("redactedTarget on an unparseable URL degrades to the ROLE name — never a throw, never invents", () => {
    expect(redactedTarget("not-a-url", "rm_readonly")).toBe("rm_readonly");
    expect(redactedTarget(undefined, "rm_app")).toBe("rm_app");
  });
});

describe("loadEnvFile — reads only on request", () => {
  test("a missing file is undefined, not a throw", () => {
    expect(loadEnvFile("/nonexistent/.env")).toBeUndefined();
  });
});
