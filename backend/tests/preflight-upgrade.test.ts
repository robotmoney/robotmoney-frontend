// backend/scripts/preflight-upgrade.ts is deliberately standalone (see its own
// header): it imports nothing from src/, opens exactly one Postgres connection
// on a dedicated read-only role, and only that role's URL — never
// DATABASE_URL. Before issue #622/PR #618, nothing executed any of its logic
// in CI: `bun run typecheck` (backend.yml, backend/tsconfig.json's
// `scripts/**/*.ts` include) proves the file compiles, but a passing typecheck
// is not a passing test — `bun test`'s type-stripping means a renamed export
// or a dropped await would still typecheck-green and run-red, undetected.
//
// This file exercises what CAN be exercised without opening a real database
// connection: `main()`'s guards (all return BEFORE connectReadOnly is ever
// called), and the pure `redactedTarget` / `urlFromReadonlyEnv` helpers. It
// ALSO exercises gateReadOnly's PASS/BLOCKED paths for real, against two roles
// provisioned on the suite's ephemeral Postgres (#677) — those two are the
// only tests here that open a live connection. Everything else
// (checkPendingMigrations, checkWorkerRole, etc.) still requires a live
// read-only role against a fully migrated database and is exercised manually
// per the runbook (docs/runbooks/v0-2-2-rollout.md) — this file does not
// claim to cover them.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { main, redactedTarget, urlFromReadonlyEnv } from "../scripts/preflight-upgrade.ts";

describe("redactedTarget — the only form of the target safe to print", () => {
  test("undefined → explicit unset message, never a blank/misleading string", () => {
    expect(redactedTarget(undefined)).toBe("(no read-only database URL — see .env.readonly)");
  });

  test("a password in the URL is replaced with *** — never printed verbatim", () => {
    const r = redactedTarget("postgres://rm_readonly:s3cr3t@db.example.com:25060/defaultdb?sslmode=require");
    expect(r).not.toContain("s3cr3t");
    expect(r).toBe("rm_readonly@db.example.com:25060/defaultdb");
  });

  test("no password present → username/host/port/path pass through unchanged", () => {
    expect(redactedTarget("postgres://rm_readonly@db.example.com:5432/defaultdb")).toBe(
      "rm_readonly@db.example.com:5432/defaultdb",
    );
  });

  test("missing port falls back to 5432", () => {
    expect(redactedTarget("postgres://rm_readonly:pw@db.example.com/defaultdb")).toBe(
      "rm_readonly@db.example.com:5432/defaultdb",
    );
  });

  test("an unparseable value never throws — it reports itself as unparseable", () => {
    expect(redactedTarget("not-a-url")).toBe("(unparseable read-only database URL)");
  });
});

describe("urlFromReadonlyEnv — discrete .env.readonly keys → a postgres:// URL", () => {
  test("all required keys present → assembles the URL, defaulting sslmode to require", () => {
    const r = urlFromReadonlyEnv({
      host: "db.example.com",
      port: "25060",
      username: "rm_readonly",
      password: "s3cr3t",
      database: "defaultdb",
    });
    expect(r).toEqual({ url: "postgres://rm_readonly:s3cr3t@db.example.com:25060/defaultdb?sslmode=require" });
  });

  test("sslmode key, when present, overrides the default", () => {
    const r = urlFromReadonlyEnv({
      host: "db.example.com",
      port: "25060",
      username: "rm_readonly",
      password: "s3cr3t",
      database: "defaultdb",
      sslmode: "verify-full",
    });
    expect(r).toEqual({ url: "postgres://rm_readonly:s3cr3t@db.example.com:25060/defaultdb?sslmode=verify-full" });
  });

  test("a password with reserved URI characters is escaped, not rejected", () => {
    const r = urlFromReadonlyEnv({
      host: "db.example.com",
      port: "25060",
      username: "rm_readonly",
      password: "p@ss/word#1?",
      database: "defaultdb",
    });
    expect(r).toEqual({ url: "postgres://rm_readonly:p%40ss%2Fword%231%3F@db.example.com:25060/defaultdb?sslmode=require" });
  });

  test("missing keys are reported by name, not just a generic failure", () => {
    const r = urlFromReadonlyEnv({ host: "db.example.com", database: "defaultdb" });
    expect(r).toEqual({ missing: ["port", "username", "password"] });
  });
});

describe("main() — the guards that must reject BEFORE any connection is opened", () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  let dir: string;

  afterEach(() => {
    process.env.DATABASE_URL = savedDatabaseUrl;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeReadonlyEnv(lines: string): string {
    dir = mkdtempSync(join(tmpdir(), "rm-preflight-readonly-"));
    const path = join(dir, ".env.readonly");
    writeFileSync(path, lines, "utf8");
    return path;
  }

  test("no .env.readonly at the given path → exit code 2, no connection attempted", async () => {
    dir = mkdtempSync(join(tmpdir(), "rm-preflight-readonly-"));
    const path = join(dir, ".env.readonly");
    // Resolves fast: if this ever tried to connect (e.g. a future refactor
    // reordering the guard after connectReadOnly) it would either hang on a
    // real network call or throw ECONNREFUSED, not return cleanly.
    await expect(main(path)).resolves.toBe(2);
  });

  test(".env.readonly missing required keys → exit code 2, no connection attempted", async () => {
    const path = writeReadonlyEnv("host=db.example.com\ndatabase=defaultdb\n");
    await expect(main(path)).resolves.toBe(2);
  });

  test("assembled URL identical to DATABASE_URL → refuses with exit code 2, never adopts the app's writer role", async () => {
    // DATABASE_URL is set by backend/tests/preload.ts to the suite's real
    // ephemeral Postgres — a genuinely live, connectable URL. Reuse its own
    // pieces (via URL, not string-splitting) so the discrete .env.readonly
    // this test writes assembles back to something the guard can compare
    // against. If this guard were ever removed or reordered after
    // connectReadOnly, this test would start actually connecting instead of
    // refusing, so it is a real negative control, not a string-equality
    // tautology in isolation.
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
    const resolved = urlFromReadonlyEnv({
      host: real.hostname,
      port: real.port || "5432",
      username: decodeURIComponent(real.username),
      password: decodeURIComponent(real.password),
      database: real.pathname.replace(/^\//, ""),
    });
    if (!("url" in resolved)) throw new Error("test setup: expected a resolved URL");
    process.env.DATABASE_URL = resolved.url;
    await expect(main(path)).resolves.toBe(2);
  });
});

describe("main() against live Postgres roles — gateReadOnly's PASS/BLOCKED paths for real (#677)", () => {
  let dbUrl: URL;
  let dir: string;

  beforeAll(async () => {
    // DATABASE_URL is set by preload.ts to the suite's real ephemeral Postgres.
    // It runs as the database owner, so it has permission to create roles.
    const sql = postgres(process.env.DATABASE_URL as string);
    await sql`DROP ROLE IF EXISTS rm_readonly_test`;
    await sql`DROP ROLE IF EXISTS rm_writer_test`;

    // 1. Genuinely read-only role (mimics the production dump role)
    await sql`CREATE ROLE rm_readonly_test LOGIN PASSWORD 'testpass'`;
    await sql`GRANT CONNECT ON DATABASE robotmoney TO rm_readonly_test`;
    await sql`GRANT USAGE ON SCHEMA public TO rm_readonly_test`;
    await sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO rm_readonly_test`;

    // 2. Genuinely writable role (has INSERT/UPDATE/DELETE)
    await sql`CREATE ROLE rm_writer_test LOGIN PASSWORD 'testpass'`;
    await sql`GRANT CONNECT ON DATABASE robotmoney TO rm_writer_test`;
    await sql`GRANT USAGE ON SCHEMA public TO rm_writer_test`;
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rm_writer_test`;

    await sql.end();
    dbUrl = new URL(process.env.DATABASE_URL as string);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // sslmode=disable, not the require default: the ephemeral test Postgres
  // (preload.ts) speaks plain TCP, no TLS configured.
  function writeReadonlyEnvFor(username: string): string {
    dir = mkdtempSync(join(tmpdir(), "rm-preflight-readonly-live-"));
    const path = join(dir, ".env.readonly");
    writeFileSync(
      path,
      [
        `host=${dbUrl.hostname}`,
        `port=${dbUrl.port || "5432"}`,
        `username=${username}`,
        "password=testpass",
        `database=${dbUrl.pathname.replace(/^\//, "")}`,
        "sslmode=disable",
      ].join("\n"),
      "utf8",
    );
    return path;
  }

  test("genuinely read-only role PASSES gateReadOnly (main() returns 0)", async () => {
    const path = writeReadonlyEnvFor("rm_readonly_test");
    // Since the ephemeral DB is fully migrated and rm_worker exists, main()
    // should pass completely and return 0 (SAFE TO UPGRADE). Exercises the
    // PASS paths of gateReadOnly.
    await expect(main(path)).resolves.toBe(0);
  });

  test("genuinely writable role BLOCKS in gateReadOnly (main() returns 1)", async () => {
    const path = writeReadonlyEnvFor("rm_writer_test");
    // The writable role has INSERT grants, so gateReadOnly fails its
    // role-write-grants check, prints VERDICT: BLOCKED, and main() returns 1.
    await expect(main(path)).resolves.toBe(1);
  });
});
