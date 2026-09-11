// Runs the v0.5.0 postflight's real checks against a REALLY migrated
// database (the test harness's own clean clone — every migration through
// 0055 already applied by preload.ts), the same pattern
// aum-snapshot-foundation-migration.test.ts uses for the v0.3.0 postflight's
// checks. This is what actually proves the SQL in postflight.ts is correct —
// tsc only proves it typechecks.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { createChecker } from "../scripts/lib/checks.ts";
import { runChecks as postflightChecks } from "../scripts/upgrades/0.4.0-to-0.5.0/postflight.ts";
import { runChecks as preflightChecks } from "../scripts/upgrades/0.4.0-to-0.5.0/preflight.ts";
import { THIS_RELEASE_MIGRATIONS } from "../scripts/upgrades/0.4.0-to-0.5.0/release.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// PER TEST, not per file: one test inserts a row into swarm_subjects, which
// migration 0032 makes append-only — there is no DELETE that could clean it
// back up for a later test in the same database.
useCleanDatabasePerTest(import.meta.file);

describe("v0.4.0 -> v0.5.0 postflight, against a fully migrated database", () => {
  test("every check passes, or WARNs only for the one legitimately optional case", async () => {
    const checker = createChecker("[test] ");
    await postflightChecks(sql as any, checker);
    const failed = checker.results.filter((r) => r.status === "FAIL");
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    const warned = checker.results.filter((r) => r.status === "WARN");
    // Neither robotmoney-vault nor robotmoney-allocation is part of the test
    // harness's seed data (they are created at runtime, not migrated) — see
    // subject-repair's own "absent is not a failure" note in postflight.ts.
    expect(warned.map((r) => r.name)).toEqual(["subject-repair"]);
  });

  test("subject-repair: FAILs once a subject exists and still reads the clobbered value", async () => {
    await sql`INSERT INTO swarm_subjects (id, name, recommendation_type) VALUES ('robotmoney-vault', 'RM Vault', 'position_actions')`;
    const checker = createChecker("[test] ");
    await postflightChecks(sql as any, checker);
    const row = checker.results.find((r) => r.name === "subject-repair");
    expect(row?.status).toBe("FAIL");
    expect(row?.detail[0]).toContain("robotmoney-vault=position_actions");
  });

  test("the security-relevant checks name what they actually found", async () => {
    const checker = createChecker("[test] ");
    await postflightChecks(sql as any, checker);
    const byName = Object.fromEntries(checker.results.map((r) => [r.name, r]));
    expect(byName["worker-write-allowlist"]?.status).toBe("PASS");
    expect(byName["no-public-schema-privilege"]?.status).toBe("PASS");
    expect(byName["member-keys-append-only"]?.status).toBe("PASS");
  });
});

describe("v0.4.0 -> v0.5.0 preflight, against the same fully migrated database", () => {
  test("correctly reports the target as no longer clean — this database already has v0.5.0 applied", async () => {
    // The inverse of postflight's assertion: preflight is meant to run against
    // a v0.4.0 baseline BEFORE migrating, so pointed at a database that
    // already has all seven migrations, its "nothing yet" checks must FAIL —
    // proving they are not silently vacuous PASSes.
    const checker = createChecker("[test] ");
    await preflightChecks(sql as any, checker);
    const byName = Object.fromEntries(checker.results.map((r) => [r.name, r]));
    expect(byName["clean-target"]?.status).toBe("FAIL");
    expect(byName["clean-target"]?.detail[0]).toContain(THIS_RELEASE_MIGRATIONS[0]);
    expect(byName["v0.4-baseline"]?.status).toBe("PASS");
  });
});
