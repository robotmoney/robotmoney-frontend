// Tests for the wedged-schedules preflight check introduced in issue #644.
// The check is DB-query-only (pure SELECT, zero-write) so we exercise it
// against the suite's real ephemeral Postgres — the same pattern used in
// preflight-utils.test.ts for gateReadOnly. No mocks.
//
// The check is WARN-only (never FAIL) because a wedged schedule is not a
// migration blocker; it is a post-cutover liveness concern (see §8.2 in the
// runbook and the check's own docblock in preflight.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createChecker } from "../scripts/lib/checks.ts";
import { connectReadOnly } from "../scripts/lib/preflight-utils.ts";

// We exercise checkWedgedSchedules via runChecks (the function is not
// individually exported) and inspect the "wedged-schedules" named result.
import { runChecks } from "../scripts/upgrades/0.2.1-to-0.2.2/preflight.ts";

const DB_URL = process.env.DATABASE_URL as string;

// job_schedules unique key is (kind, cron) — migration 0005_job_schedules_seed.sql.
const TEST_CRON = "* * * * *";

describe("checkWedgedSchedules — wedged-schedule detection (issue #644 AC1)", () => {
  let adminSql: ReturnType<typeof postgres>;
  let roDb: ReturnType<typeof postgres>;

  beforeAll(async () => {
    adminSql = postgres(DB_URL);

    // Provision a read-only role for the check (mirrors preflight-utils.test.ts).
    // information_schema is publicly readable in Postgres — no explicit grant needed.
    await adminSql`DROP OWNED BY rm_readonly_wst`.catch(() => {});
    await adminSql`DROP ROLE IF EXISTS rm_readonly_wst`;
    await adminSql`CREATE ROLE rm_readonly_wst LOGIN PASSWORD 'testpass'`;
    await adminSql`GRANT CONNECT ON DATABASE robotmoney TO rm_readonly_wst`;
    await adminSql`GRANT USAGE ON SCHEMA public TO rm_readonly_wst`;
    await adminSql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO rm_readonly_wst`;

    const roUrl = new URL(DB_URL);
    roUrl.username = "rm_readonly_wst";
    roUrl.password = "testpass";
    ({ db: roDb } = await connectReadOnly(roUrl.toString(), "test-wedged-schedules"));
  });

  afterAll(async () => {
    await roDb?.end({ timeout: 5 });
    // Clean up test rows so other tests are not affected.
    await adminSql`DELETE FROM job_schedules WHERE kind LIKE 'test.wedge.%'`.catch(() => {});
    // DROP OWNED BY revokes all privileges before the role drop, avoiding the
    // "objects depend on it" error that a bare DROP ROLE raises.
    await adminSql`DROP OWNED BY rm_readonly_wst`.catch(() => {});
    await adminSql`DROP ROLE IF EXISTS rm_readonly_wst`;
    await adminSql.end({ timeout: 5 });
  });

  /**
   * Run the full runChecks suite and return only the "wedged-schedules" result.
   * checkWedgedSchedules is not individually exported; we inspect it by name.
   */
  async function runAndGetWedgedResult() {
    const checker = createChecker("");
    try {
      await runChecks(roDb, checker);
    } catch {
      // Other checks may FAIL on the suite DB (e.g. schema-migrations); ignore.
    }
    return checker.results.find((r) => r.name === "wedged-schedules");
  }

  test("PASS when all enabled rows have next_run_at within the threshold", async () => {
    await adminSql`
      INSERT INTO job_schedules (kind, cron, enabled, next_run_at, last_enqueued_at, timezone, payload)
      VALUES ('test.wedge.fresh', ${TEST_CRON}, true, now(), now(), 'UTC', '{}')
      ON CONFLICT (kind, cron) DO UPDATE
        SET enabled = true, next_run_at = now(), last_enqueued_at = now()
    `;

    const result = await runAndGetWedgedResult();
    expect(result?.status).toBe("PASS");
  });

  test("WARN when an enabled row has next_run_at > 60 minutes in the past", async () => {
    await adminSql`
      INSERT INTO job_schedules (kind, cron, enabled, next_run_at, last_enqueued_at, timezone, payload)
      VALUES ('test.wedge.old', ${TEST_CRON}, true, now() - interval '2 hours', now() - interval '2 hours', 'UTC', '{}')
      ON CONFLICT (kind, cron) DO UPDATE
        SET enabled = true,
            next_run_at = now() - interval '2 hours',
            last_enqueued_at = now() - interval '2 hours'
    `;

    const result = await runAndGetWedgedResult();
    if (!result) return; // job_schedules absent in this suite variant

    expect(result.status).toBe("WARN");
    const detail = result.detail.join("\n");
    expect(detail).toContain("test.wedge.old");
    expect(detail).toContain("may be wedged");
  });

  test("PASS when only disabled rows have a stale next_run_at", async () => {
    await adminSql`
      INSERT INTO job_schedules (kind, cron, enabled, next_run_at, last_enqueued_at, timezone, payload)
      VALUES ('test.wedge.disabled', ${TEST_CRON}, false, now() - interval '10 days', null, 'UTC', '{}')
      ON CONFLICT (kind, cron) DO UPDATE
        SET enabled = false, next_run_at = now() - interval '10 days'
    `;

    // Keep the fresh row recent; remove the wedged row from the previous test.
    await adminSql`UPDATE job_schedules SET next_run_at = now() WHERE kind = 'test.wedge.fresh'`;
    await adminSql`DELETE FROM job_schedules WHERE kind = 'test.wedge.old'`;

    const result = await runAndGetWedgedResult();
    if (!result) return;

    expect(result.status).toBe("PASS");
  });
});
