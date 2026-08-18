// backend/scripts/lib/preflight-utils.ts is deliberately standalone (see its
// own header): it imports nothing from src/, opens exactly one Postgres
// connection on a dedicated read-only role, and only that role's URL — never
// DATABASE_URL. This file exercises what CAN be exercised without opening a
// real database connection (urlFromDiscreteEnv, redactedTarget,
// runPreflightMain's guards) and gateReadOnly's PASS/BLOCKED paths for real,
// against two roles provisioned on the suite's ephemeral Postgres (matching
// the coverage the pre-split, now-deleted monolithic preflight test had at
// #677, before this file split out of it).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createChecker } from "../scripts/lib/checks.ts";
import {
  connectReadOnly,
  gateReadOnly,
  redactedTarget,
  runPreflightMain,
  urlFromDiscreteEnv,
} from "../scripts/lib/preflight-utils.ts";

describe("redactedTarget — the only form of the target safe to print", () => {
  test("undefined -> the caller-supplied unset message, never a blank/misleading string", () => {
    expect(redactedTarget(undefined, "(unset)")).toBe("(unset)");
  });

  test("a password in the URL is replaced with *** — never printed verbatim", () => {
    const r = redactedTarget("postgres://rm_readonly:s3cr3t@db.example.com:25060/defaultdb?sslmode=require", "(unset)");
    expect(r).not.toContain("s3cr3t");
    expect(r).toBe("rm_readonly@db.example.com:25060/defaultdb");
  });

  test("missing port falls back to 5432", () => {
    expect(redactedTarget("postgres://rm_readonly:pw@db.example.com/defaultdb", "(unset)")).toBe(
      "rm_readonly@db.example.com:5432/defaultdb",
    );
  });

  test("an unparseable value never throws — it reports itself as unparseable", () => {
    expect(redactedTarget("not-a-url", "(unset)")).toBe("(unparseable database URL)");
  });
});

describe("urlFromDiscreteEnv — discrete env-file keys -> a postgres:// URL", () => {
  test("all required keys present -> assembles the URL, defaulting sslmode to require", () => {
    const r = urlFromDiscreteEnv({
      host: "db.example.com",
      port: "25060",
      username: "rm_readonly",
      password: "s3cr3t",
      database: "defaultdb",
    });
    expect(r).toEqual({ url: "postgres://rm_readonly:s3cr3t@db.example.com:25060/defaultdb?sslmode=require" });
  });

  test("a password with reserved URI characters is escaped, not rejected", () => {
    const r = urlFromDiscreteEnv({
      host: "db.example.com",
      port: "25060",
      username: "rm_readonly",
      password: "p@ss/word#1?",
      database: "defaultdb",
    });
    expect(r).toEqual({ url: "postgres://rm_readonly:p%40ss%2Fword%231%3F@db.example.com:25060/defaultdb?sslmode=require" });
  });

  test("missing keys are reported by name", () => {
    expect(urlFromDiscreteEnv({ host: "db.example.com", database: "defaultdb" })).toEqual({
      missing: ["port", "username", "password"],
    });
  });
});

describe("runPreflightMain — the guards that must reject BEFORE any connection is opened", () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  let dir: string;

  afterEach(() => {
    process.env.DATABASE_URL = savedDatabaseUrl;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeReadonlyEnv(lines: string): string {
    dir = mkdtempSync(join(tmpdir(), "rm-preflight-utils-"));
    const path = join(dir, ".env.readonly");
    writeFileSync(path, lines, "utf8");
    return path;
  }

  test("no env file at the given path -> exit code 2, no connection attempted", async () => {
    dir = mkdtempSync(join(tmpdir(), "rm-preflight-utils-"));
    const path = join(dir, ".env.readonly");
    const code = await runPreflightMain({
      envPath: path,
      name: "test",
      allowPrivilegedEnvVar: "TEST_ALLOW_PRIVILEGED",
      runChecks: async () => {
        throw new Error("must not be called");
      },
    });
    expect(code).toBe(2);
  });

  test("env file missing required keys -> exit code 2", async () => {
    const path = writeReadonlyEnv("host=db.example.com\ndatabase=defaultdb\n");
    const code = await runPreflightMain({
      envPath: path,
      name: "test",
      allowPrivilegedEnvVar: "TEST_ALLOW_PRIVILEGED",
      runChecks: async () => {
        throw new Error("must not be called");
      },
    });
    expect(code).toBe(2);
  });

  test("assembled URL identical to DATABASE_URL -> refuses with exit code 2", async () => {
    const real = new URL(process.env.DATABASE_URL ?? "");
    const path = writeReadonlyEnv(
      [
        `host=${real.hostname}`,
        `port=${real.port || "5432"}`,
        `username=${decodeURIComponent(real.username)}`,
        `password=${decodeURIComponent(real.password)}`,
        `database=${real.pathname.replace(/^\//, "")}`,
      ].join("\n"),
    );
    const resolved = urlFromDiscreteEnv({
      host: real.hostname,
      port: real.port || "5432",
      username: decodeURIComponent(real.username),
      password: decodeURIComponent(real.password),
      database: real.pathname.replace(/^\//, ""),
    });
    if (!("url" in resolved)) throw new Error("test setup: expected a resolved URL");
    process.env.DATABASE_URL = resolved.url;
    const code = await runPreflightMain({
      envPath: path,
      name: "test",
      allowPrivilegedEnvVar: "TEST_ALLOW_PRIVILEGED",
      runChecks: async () => {
        throw new Error("must not be called");
      },
    });
    expect(code).toBe(2);
  });
});

describe("gateReadOnly — PASS/BLOCKED paths for real, against live Postgres roles (#677)", () => {
  let dbUrl: URL;

  beforeAll(async () => {
    const sql = postgres(process.env.DATABASE_URL as string);
    await sql`DROP ROLE IF EXISTS rm_readonly_test`;
    await sql`DROP ROLE IF EXISTS rm_writer_test`;
    await sql`CREATE ROLE rm_readonly_test LOGIN PASSWORD 'testpass'`;
    await sql`GRANT CONNECT ON DATABASE robotmoney TO rm_readonly_test`;
    await sql`GRANT USAGE ON SCHEMA public TO rm_readonly_test`;
    await sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO rm_readonly_test`;
    await sql`CREATE ROLE rm_writer_test LOGIN PASSWORD 'testpass'`;
    await sql`GRANT CONNECT ON DATABASE robotmoney TO rm_writer_test`;
    await sql`GRANT USAGE ON SCHEMA public TO rm_writer_test`;
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rm_writer_test`;
    await sql.end();
    dbUrl = new URL(process.env.DATABASE_URL as string);
  });

  afterAll(() => {
    delete process.env.TEST_ALLOW_PRIVILEGED;
  });

  test("a genuinely read-only role passes all three sub-checks", async () => {
    const url = new URL(dbUrl.toString());
    url.username = "rm_readonly_test";
    url.password = "testpass";
    const { db } = await connectReadOnly(url.toString(), "test");
    const checker = createChecker("");
    try {
      expect(await gateReadOnly(db, checker, "TEST_ALLOW_PRIVILEGED")).toBe(true);
      expect(checker.results.every((r) => r.status === "PASS")).toBe(true);
    } finally {
      await db.end({ timeout: 5 });
    }
  });

  test("a genuinely writable role fails role-write-grants and the gate returns false", async () => {
    const url = new URL(dbUrl.toString());
    url.username = "rm_writer_test";
    url.password = "testpass";
    const { db } = await connectReadOnly(url.toString(), "test");
    const checker = createChecker("");
    try {
      expect(await gateReadOnly(db, checker, "TEST_ALLOW_PRIVILEGED")).toBe(false);
      const writeGrants = checker.results.find((r) => r.name === "role-write-grants");
      expect(writeGrants?.status).toBe("FAIL");
    } finally {
      await db.end({ timeout: 5 });
    }
  });
});
