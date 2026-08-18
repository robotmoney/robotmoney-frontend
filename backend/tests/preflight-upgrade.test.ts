// backend/scripts/preflight-upgrade.ts is deliberately standalone (see its own
// header): it imports nothing from src/, opens exactly one Postgres connection
// on a dedicated read-only role, and only that role's URL — never
// DATABASE_URL. Before issue #622/PR #618, nothing executed any of its logic
// in CI: `bun run typecheck` (backend.yml, backend/tsconfig.json's
// `scripts/**/*.ts` include) proves the file compiles, but a passing typecheck
// is not a passing test — `bun test`'s type-stripping means a renamed export
// or a dropped await would still typecheck-green and run-red, undetected.
//
// Without a database: main()'s two upfront guards and the pure
// redactedTarget helper.
//
// Against the live ephemeral Postgres (since #633/PR #677, bd0e20b): a
// SELECT-only role PASSES gateReadOnly (main() → 0); an INSERT/UPDATE/DELETE
// role trips it (main() → 1). Because that DB is fully migrated, the passing
// run also executes every downstream check — checkServerVersion,
// checkExtensions, checkPendingMigrations, checkWorkerRole,
// checkHandleNamespace, checkAdminCredential, checkSwarmMembersSize,
// checkBlockingActivity, checkHandleShape — all PASS (admin-credential WARNs
// on 0 rows, which doesn't move the exit code).
//
// Runbook-only (docs/runbooks/v0-2-2-rollout.md): every non-PASS branch of
// those checks (a fresh near-empty DB can't produce them), gateReadOnly's
// other two rejection paths (writeable session; privileged role),
// PREFLIGHT_ALLOW_PRIVILEGED=1's WARN downgrade, the pooled-port fallback,
// and the cannot-connect → 2 path.
import { afterEach, afterAll, beforeAll, describe, expect, test } from "bun:test";
import { main, redactedTarget } from "../scripts/preflight-upgrade.ts";
import postgres from "postgres";

describe("redactedTarget — the only form of the target safe to print", () => {
  test("undefined → explicit unset message, never a blank/misleading string", () => {
    expect(redactedTarget(undefined)).toBe("(PREFLIGHT_DATABASE_URL unset)");
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
    expect(redactedTarget("not-a-url")).toBe("(unparseable PREFLIGHT_DATABASE_URL)");
  });
});

describe("main() — the two guards that must reject BEFORE any connection is opened", () => {
  const savedPreflightUrl = process.env.PREFLIGHT_DATABASE_URL;
  const savedDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (savedPreflightUrl === undefined) delete process.env.PREFLIGHT_DATABASE_URL;
    else process.env.PREFLIGHT_DATABASE_URL = savedPreflightUrl;
    process.env.DATABASE_URL = savedDatabaseUrl;
  });

  test("PREFLIGHT_DATABASE_URL unset → exit code 2, could-not-run, no connection attempted", async () => {
    delete process.env.PREFLIGHT_DATABASE_URL;
    // Resolves fast: if this ever tried to connect (e.g. a future refactor
    // reordering the guard after connectReadOnly) it would either hang on a
    // real network call or throw ECONNREFUSED, not return cleanly.
    await expect(main()).resolves.toBe(2);
  });

  test("PREFLIGHT_DATABASE_URL identical to DATABASE_URL → refuses with exit code 2, never adopts the app's writer role", async () => {
    // DATABASE_URL is set by backend/tests/preload.ts to the suite's real
    // ephemeral Postgres — a genuinely live, connectable URL. If this guard
    // were ever removed or reordered after connectReadOnly, this test would
    // start actually connecting (and PASS-through) instead of refusing, so it
    // is a real negative control, not a string-equality tautology in isolation.
    process.env.PREFLIGHT_DATABASE_URL = process.env.DATABASE_URL;
    await expect(main()).resolves.toBe(2);
  });
});

describe("main() against live Postgres roles", () => {
  const savedPreflightUrl = process.env.PREFLIGHT_DATABASE_URL;
  let dbUrl: URL;

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

  afterAll(() => {
    if (savedPreflightUrl === undefined) delete process.env.PREFLIGHT_DATABASE_URL;
    else process.env.PREFLIGHT_DATABASE_URL = savedPreflightUrl;
  });

  test("genuinely read-only role PASSES gateReadOnly (main() returns 0)", async () => {
    dbUrl.username = "rm_readonly_test";
    dbUrl.password = "testpass";
    process.env.PREFLIGHT_DATABASE_URL = dbUrl.toString();

    // Since the ephemeral DB is fully migrated and rm_worker exists, main() should pass completely
    // and return 0 (SAFE TO UPGRADE). It will test the PASS paths of gateReadOnly.
    await expect(main()).resolves.toBe(0);
  });

  test("genuinely writable role BLOCKS in gateReadOnly (main() returns 1)", async () => {
    dbUrl.username = "rm_writer_test";
    dbUrl.password = "testpass";
    process.env.PREFLIGHT_DATABASE_URL = dbUrl.toString();

    // The writable role has INSERT grants, so gateReadOnly will fail its role-write-grants check,
    // print VERDICT: BLOCKED, and main() will return 1.
    await expect(main()).resolves.toBe(1);
  });
});
