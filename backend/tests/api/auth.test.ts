// Credential-role boundary for the admin gate (issue #584, re-cut by D52 (1)
// for issue #1026). This file uses the real ephemeral Postgres from
// tests/preload.ts: Docker/Postgres absence fails this command loudly, so the
// claimed-state branch cannot be mistaken for a silent green.
//
// What changed: the env `ADMIN_TOKEN` (a per-boot setup value, revoked by a
// claim) and the env `AUTOMATION_TOKEN` (an unscoped stack driver credential)
// are gone. The operator's admin credential is a row in the automation-token
// store with the `admin` right (smoke spec §3), and no other holder's row
// carries that right.
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "../../src/db/client.ts";
import { hasAutomationRight, isPrivileged } from "../../src/api/auth.ts";
import { handleSwarmAdmin } from "../../src/api/routes/swarm-admin.ts";
import { useCleanDatabasePerTest } from "../support/clean-db.ts";
import {
  adminHeaders,
  bearerHeaders,
  provisionAnalyticsToken,
  provisionOperatorToken,
  provisionSchedulerToken,
  schedulerHeaders,
} from "../support/automation-auth.ts";

// Each test starts from an unclaimed database of its own, instead of deleting
// the previous test's admin_credential row.
useCleanDatabasePerTest(import.meta.file);

let operator = "";
let scheduler = "";
let analytics = "";
beforeEach(async () => {
  operator = await provisionOperatorToken();
  scheduler = await provisionSchedulerToken();
  analytics = await provisionAnalyticsToken();
});

const request = (headers: Record<string, string>) => new Request("http://localhost/api/admin/auth", { headers });
const PASSWORD = "durable-operator-password";
const claim = () =>
  sql`INSERT INTO admin_credential (id, pass_hash) VALUES (1, ${createHash("sha256").update(PASSWORD).digest("hex")})`;

describe("the admin gate after D52 (1)", () => {
  test("the operator's store token opens it, unclaimed and claimed alike; the claimed password does too", async () => {
    expect(await isPrivileged(request(adminHeaders(operator)))).toBe(true);
    // Presented where every other service token is presented, too.
    expect(await isPrivileged(request(bearerHeaders(operator)))).toBe(true);
    expect(await isPrivileged(request(schedulerHeaders(operator)))).toBe(true);

    await claim();
    expect(await isPrivileged(request(adminHeaders(operator)))).toBe(true);
    expect(await isPrivileged(request(adminHeaders(PASSWORD)))).toBe(true);
    expect(await isPrivileged(request(adminHeaders("not-the-password")))).toBe(false);
  });

  test("no credential, an unknown string, and the other holders' tokens never open it", async () => {
    for (const claimed of [false, true]) {
      if (claimed) await claim();
      expect(await isPrivileged(request({}))).toBe(false);
      expect(await isPrivileged(request(adminHeaders("one-time-human-setup-token")))).toBe(false);
      for (const token of [scheduler, analytics]) {
        for (const headers of [adminHeaders(token), bearerHeaders(token), schedulerHeaders(token)]) {
          expect({ claimed, headers, granted: await isPrivileged(request(headers)) }).toEqual({
            claimed,
            headers,
            granted: false,
          });
        }
      }
    }
  });

  test("hasAutomationRight reads the store only: the operator token carries `admin` and nothing else", async () => {
    expect(await hasAutomationRight(request(schedulerHeaders(operator)), "admin")).toBe(true);
    for (const right of ["read_subjects", "read_sessions", "lifecycle_transitions", "analytics_ingestion"] as const) {
      expect(await hasAutomationRight(request(schedulerHeaders(operator)), right)).toBe(false);
    }
    // A string that was the env AUTOMATION_TOKEN is just a string now.
    expect(await hasAutomationRight(request(schedulerHeaders("dedicated-stack-automation-token")), "read_subjects")).toBe(false);
  });

  test("a swarm admin route admits the operator token and refuses the scheduler's and the producer's", async () => {
    const members = (headers: Record<string, string>) => {
      const req = new Request("http://localhost/api/swarm/admin/members", { headers });
      return handleSwarmAdmin(req, new URL(req.url));
    };
    await claim();
    expect((await members(adminHeaders(operator)))?.status).toBe(200);
    expect((await members(schedulerHeaders(scheduler)))?.status).toBe(403);
    expect((await members(bearerHeaders(analytics)))?.status).toBe(403);
    expect((await members({}))?.status).toBe(403);
  });
});
