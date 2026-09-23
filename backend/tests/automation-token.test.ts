// W4.5 — the API automation-token store (issue #1026).
//
// AUTHORITY: docs/technical/smoke-production-spec.md §3, and
// docs/technical/system-scheduler-spec.md §7.
//
//   "The token is issued by the API's own automation-token store: a row holding
//    the token's hash and its rights (read subjects and sessions, perform
//    lifecycle transitions), written by the same authorized preparation that
//    writes `deployment_identity`. The API validates a presented token against
//    that row; a file on disk establishes nothing by itself ... Each instance
//    holds its own token, so provisioning one never invalidates another's.
//    Rotation is a re-provision and a container restart."
//
// The DELIVERY half — the boot placing a per-instance file in the state
// directory, journalled, never rotated by a rerun — is W1's criterion in
// scripts/tests/unit/smoke-state.test.ts. This file owns the API side only.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { automationTokenGrant, hasAutomationRight } from "../src/api/auth.ts";
import { provisionAutomationToken, AUTOMATION_RIGHTS } from "../src/db/automation-tokens.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

// A configuration in which NOTHING is waved through: no env automation token,
// no insecure mode. The store is then the only thing that can authorize.
const LOCKED = { adminToken: "admin-secret", automationToken: null, allowInsecure: false };

const req = (token: string | null) =>
  new Request("http://test/api/swarm/admin/epochs/turnover", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

test("provisioning stores the hash and the rights, never the secret", async () => {
  const { token } = await provisionAutomationToken("rm_prod_scheduler", [...AUTOMATION_RIGHTS]);
  expect(token.length).toBeGreaterThan(20);

  const [row] = await sql<{ token_hash: string; rights: string[] }[]>`
    SELECT token_hash, rights FROM automation_tokens WHERE instance = 'rm_prod_scheduler'`;
  expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.rights.sort()).toEqual([...AUTOMATION_RIGHTS].sort());

  // The secret appears nowhere in the row, in any column.
  const [all] = await sql<Record<string, unknown>[]>`
    SELECT * FROM automation_tokens WHERE instance = 'rm_prod_scheduler'`;
  expect(JSON.stringify(all)).not.toContain(token);
});

test("a presented bearer is validated against the store", async () => {
  const { token } = await provisionAutomationToken("rm_stage_scheduler", [...AUTOMATION_RIGHTS]);
  const grant = await automationTokenGrant(req(token));
  expect(grant).not.toBeNull();
  expect(grant!.instance).toBe("rm_stage_scheduler");
  expect(await hasAutomationRight(req(token), "lifecycle_transitions", LOCKED)).toBe(true);
});

test("a file on disk grants nothing by itself: an unknown token is refused", async () => {
  await provisionAutomationToken("rm_known", [...AUTOMATION_RIGHTS]);
  const forged = "rmat_" + "f".repeat(40);
  expect(await automationTokenGrant(req(forged))).toBeNull();
  expect(await hasAutomationRight(req(forged), "lifecycle_transitions", LOCKED)).toBe(false);
  expect(await hasAutomationRight(req(null), "lifecycle_transitions", LOCKED)).toBe(false);
});

test("rights are enforced, not merely recorded", async () => {
  const { token } = await provisionAutomationToken("rm_reader", ["read_subjects", "read_sessions"]);
  expect(await hasAutomationRight(req(token), "read_sessions", LOCKED)).toBe(true);
  expect(await hasAutomationRight(req(token), "lifecycle_transitions", LOCKED)).toBe(false);
});

test("an unknown right cannot be provisioned", async () => {
  await expect(
    provisionAutomationToken("rm_bad_rights", ["drop_the_database" as never]),
  ).rejects.toThrow();
  expect((await sql`SELECT 1 FROM automation_tokens WHERE instance = 'rm_bad_rights'`).length).toBe(0);
});

test("a token with no rights at all cannot be provisioned", async () => {
  await expect(provisionAutomationToken("rm_no_rights", [])).rejects.toThrow();
});

test("provisioning one instance never invalidates another's", async () => {
  const first = await provisionAutomationToken("rm_ci_a", [...AUTOMATION_RIGHTS]);
  const second = await provisionAutomationToken("rm_ci_b", [...AUTOMATION_RIGHTS]);
  expect(first.token).not.toBe(second.token);
  expect(await hasAutomationRight(req(first.token), "lifecycle_transitions", LOCKED)).toBe(true);
  expect(await hasAutomationRight(req(second.token), "lifecycle_transitions", LOCKED)).toBe(true);
  expect((await automationTokenGrant(req(first.token)))!.instance).toBe("rm_ci_a");
  expect((await automationTokenGrant(req(second.token)))!.instance).toBe("rm_ci_b");
});

test("rotation is a re-provision: the new token works and the old one stops", async () => {
  const before = await provisionAutomationToken("rm_rotate", [...AUTOMATION_RIGHTS]);
  const after = await provisionAutomationToken("rm_rotate", [...AUTOMATION_RIGHTS]);
  expect(after.token).not.toBe(before.token);
  expect(await hasAutomationRight(req(after.token), "lifecycle_transitions", LOCKED)).toBe(true);
  expect(await hasAutomationRight(req(before.token), "lifecycle_transitions", LOCKED)).toBe(false);
  // One row per instance — a rotation replaces, it does not accumulate.
  const rows = await sql`SELECT 1 FROM automation_tokens WHERE instance = 'rm_rotate'`;
  expect(rows.length).toBe(1);
});

test("the store authorizes the epoch lifecycle routes, and a rightless token does not", async () => {
  const { handleSwarmAdmin } = await import("../src/api/routes/swarm-admin.ts");
  const full = await provisionAutomationToken("rm_route_full", [...AUTOMATION_RIGHTS]);
  const reader = await provisionAutomationToken("rm_route_reader", ["read_sessions"]);

  const call = (token: string) => {
    const url = new URL("http://test/api/swarm/admin/epochs/turnover");
    return handleSwarmAdmin(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId: "nope", expectedSessionId: "00000000-0000-4000-8000-000000000000" }),
      }),
      url,
      LOCKED,
    );
  };

  // The rightless token never reaches the handler.
  expect((await call(reader.token))!.status).toBe(403);
  // The full token does, and is refused on the MERITS instead.
  expect((await call(full.token))!.status).not.toBe(403);
});
