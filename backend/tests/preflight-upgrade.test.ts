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
// connection: `main()`'s two upfront guards (both return BEFORE
// connectReadOnly is ever called) and the pure `redactedTarget` helper. The
// gated checks themselves (gateReadOnly, checkPendingMigrations, etc.) all
// require a live read-only role against a migrated database and are exercised
// manually per the runbook (docs/runbooks/v0-2-2-rollout.md) — this test does
// not claim to cover them.
import { afterEach, describe, expect, test } from "bun:test";
import { main, redactedTarget } from "../scripts/preflight-upgrade.ts";

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
