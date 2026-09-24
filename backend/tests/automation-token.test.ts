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
// D52 amended §3 to three holders — "`system-scheduler` ..., `analytics-producer`
// (the analytics ingestion routes), and the operator (the admin routes)" — each
// "a store-issued row with hash and rights". Migration 0078 keyed the store on
// (instance, holder); the last block below proves three holders coexist on one
// instance, each confined to its own rights, and that rotating one leaves the
// other two valid. Wiring the API's admin and analytics routes to those rights,
// and retiring ADMIN_TOKEN / ANALYTICS_TOKEN, is not this file's subject.
//
// The DELIVERY half — the boot placing a per-instance file in the state
// directory, journalled, never rotated by a rerun — is W1's criterion in
// scripts/tests/unit/smoke-state.test.ts. This file owns the API side only.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { automationTokenGrant, hasAutomationRight } from "../src/api/auth.ts";
import {
  AUTOMATION_HOLDERS,
  AUTOMATION_RIGHTS,
  HOLDER_RIGHTS,
  lookupAutomationToken,
  provisionAutomationToken,
} from "../src/db/automation-tokens.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

// The scheduler's three rights (scheduler spec §7). Every case below that
// predates migration 0078 provisions the default holder, `system-scheduler`,
// which may hold these and nothing else.
const SCHEDULER_RIGHTS = HOLDER_RIGHTS["system-scheduler"];

// A configuration in which NOTHING is waved through: no env automation token,
// no insecure mode. The store is then the only thing that can authorize.
const LOCKED = { adminToken: "admin-secret", automationToken: null, allowInsecure: false };

const req = (token: string | null) =>
  new Request("http://test/api/swarm/admin/epochs/turnover", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

test("provisioning stores the hash and the rights, never the secret", async () => {
  const { token } = await provisionAutomationToken("rm_prod_scheduler", [...SCHEDULER_RIGHTS]);
  expect(token.length).toBeGreaterThan(20);

  const [row] = await sql<{ token_hash: string; rights: string[] }[]>`
    SELECT token_hash, rights FROM automation_tokens WHERE instance = 'rm_prod_scheduler'`;
  expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.rights.sort()).toEqual([...SCHEDULER_RIGHTS].sort());

  // The secret appears nowhere in the row, in any column.
  const [all] = await sql<Record<string, unknown>[]>`
    SELECT * FROM automation_tokens WHERE instance = 'rm_prod_scheduler'`;
  expect(JSON.stringify(all)).not.toContain(token);
});

test("a presented bearer is validated against the store", async () => {
  const { token } = await provisionAutomationToken("rm_stage_scheduler", [...SCHEDULER_RIGHTS]);
  const grant = await automationTokenGrant(req(token));
  expect(grant).not.toBeNull();
  expect(grant!.instance).toBe("rm_stage_scheduler");
  expect(await hasAutomationRight(req(token), "lifecycle_transitions", LOCKED)).toBe(true);
});

test("a file on disk grants nothing by itself: an unknown token is refused", async () => {
  await provisionAutomationToken("rm_known", [...SCHEDULER_RIGHTS]);
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
  const first = await provisionAutomationToken("rm_ci_a", [...SCHEDULER_RIGHTS]);
  const second = await provisionAutomationToken("rm_ci_b", [...SCHEDULER_RIGHTS]);
  expect(first.token).not.toBe(second.token);
  expect(await hasAutomationRight(req(first.token), "lifecycle_transitions", LOCKED)).toBe(true);
  expect(await hasAutomationRight(req(second.token), "lifecycle_transitions", LOCKED)).toBe(true);
  expect((await automationTokenGrant(req(first.token)))!.instance).toBe("rm_ci_a");
  expect((await automationTokenGrant(req(second.token)))!.instance).toBe("rm_ci_b");
});

test("rotation is a re-provision: the new token works and the old one stops", async () => {
  const before = await provisionAutomationToken("rm_rotate", [...SCHEDULER_RIGHTS]);
  const after = await provisionAutomationToken("rm_rotate", [...SCHEDULER_RIGHTS]);
  expect(after.token).not.toBe(before.token);
  expect(await hasAutomationRight(req(after.token), "lifecycle_transitions", LOCKED)).toBe(true);
  expect(await hasAutomationRight(req(before.token), "lifecycle_transitions", LOCKED)).toBe(false);
  // One row per instance — a rotation replaces, it does not accumulate.
  const rows = await sql`SELECT 1 FROM automation_tokens WHERE instance = 'rm_rotate'`;
  expect(rows.length).toBe(1);
});

test("the store authorizes the epoch lifecycle routes, and a rightless token does not", async () => {
  const { handleSwarmAdmin } = await import("../src/api/routes/swarm-admin.ts");
  const full = await provisionAutomationToken("rm_route_full", [...SCHEDULER_RIGHTS]);
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

// ─────────────────────────────────────────────────────────────────────────────
// Three holders per instance (smoke spec §3 as amended by D52, migration 0078)
// ─────────────────────────────────────────────────────────────────────────────

/** Provision all three holders on one instance, each with its full list. */
async function provisionAllHolders(instance: string) {
  const scheduler = await provisionAutomationToken(instance, [...HOLDER_RIGHTS["system-scheduler"]]);
  const producer = await provisionAutomationToken(instance, [...HOLDER_RIGHTS["analytics-producer"]], {
    holder: "analytics-producer",
  });
  const operator = await provisionAutomationToken(instance, [...HOLDER_RIGHTS.operator], { holder: "operator" });
  return { scheduler, producer, operator };
}

test("one instance holds three tokens, one row per holder, each with only its own rights", async () => {
  const { scheduler, producer, operator } = await provisionAllHolders("rm_three_holders");

  const rows = await sql<{ holder: string; rights: string[] }[]>`
    SELECT holder, rights FROM automation_tokens WHERE instance = 'rm_three_holders' ORDER BY holder`;
  expect(rows.map((r) => ({ holder: r.holder, rights: [...r.rights].sort() }))).toEqual([
    { holder: "analytics-producer", rights: ["analytics_ingestion"] },
    { holder: "operator", rights: ["admin"] },
    { holder: "system-scheduler", rights: [...HOLDER_RIGHTS["system-scheduler"]].sort() },
  ]);

  // Each presented secret resolves to its own holder, and to nothing wider.
  expect(await lookupAutomationToken(scheduler.token)).toEqual({
    instance: "rm_three_holders",
    holder: "system-scheduler",
    rights: [...HOLDER_RIGHTS["system-scheduler"]],
  });
  expect(await lookupAutomationToken(producer.token)).toEqual({
    instance: "rm_three_holders",
    holder: "analytics-producer",
    rights: ["analytics_ingestion"],
  });
  expect(await lookupAutomationToken(operator.token)).toEqual({
    instance: "rm_three_holders",
    holder: "operator",
    rights: ["admin"],
  });

  // Enforced through the same gate the routes use, for every right any holder
  // may carry: a token authorizes exactly its holder's list.
  for (const [holder, token] of [
    ["system-scheduler", scheduler.token],
    ["analytics-producer", producer.token],
    ["operator", operator.token],
  ] as const) {
    for (const right of AUTOMATION_RIGHTS) {
      const expected = (HOLDER_RIGHTS[holder] as readonly string[]).includes(right);
      expect({ holder, right, granted: await hasAutomationRight(req(token), right, LOCKED) }).toEqual({
        holder,
        right,
        granted: expected,
      });
    }
  }
});

test("re-provisioning one holder rotates that holder only — the other two stay valid", async () => {
  const before = await provisionAllHolders("rm_rotate_one_holder");
  const rotated = await provisionAutomationToken("rm_rotate_one_holder", ["admin"], { holder: "operator" });

  expect(rotated.token).not.toBe(before.operator.token);
  expect(await lookupAutomationToken(before.operator.token)).toBeNull();
  expect((await lookupAutomationToken(rotated.token))?.holder).toBe("operator");
  expect((await lookupAutomationToken(before.scheduler.token))?.holder).toBe("system-scheduler");
  expect((await lookupAutomationToken(before.producer.token))?.holder).toBe("analytics-producer");
  expect(await hasAutomationRight(req(before.scheduler.token), "lifecycle_transitions", LOCKED)).toBe(true);
  expect(await hasAutomationRight(req(before.producer.token), "analytics_ingestion", LOCKED)).toBe(true);

  const [count] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM automation_tokens WHERE instance = 'rm_rotate_one_holder'`;
  expect(count?.n).toBe(3);
});

test("a holder cannot be provisioned another holder's right — the module refuses and so does the table", async () => {
  // Module half: the scheduler holds one API credential and no other kind (§3).
  await expect(provisionAutomationToken("rm_cross_rights", ["admin"])).rejects.toThrow("system-scheduler");
  await expect(
    provisionAutomationToken("rm_cross_rights", ["lifecycle_transitions"], { holder: "analytics-producer" }),
  ).rejects.toThrow("analytics-producer");
  await expect(
    provisionAutomationToken("rm_cross_rights", ["analytics_ingestion"], { holder: "operator" }),
  ).rejects.toThrow("operator");
  await expect(
    provisionAutomationToken("rm_cross_rights", ["admin"], { holder: "someone-else" as never }),
  ).rejects.toThrow("holder");

  // Table half: a statement that bypasses the module is still refused by
  // migration 0078's constraints — 23514 is check_violation.
  const hash = "a".repeat(64);
  for (const [holder, rights] of [
    ["system-scheduler", ["admin"]],
    ["analytics-producer", ["read_subjects"]],
    ["operator", ["lifecycle_transitions"]],
    ["someone-else", ["admin"]],
  ] as const) {
    const error = await sql`
      INSERT INTO automation_tokens (instance, holder, token_hash, rights)
      VALUES ('rm_cross_rights', ${holder}, ${hash}, ${[...rights]})`.catch((e: { code?: string }) => e);
    expect({ holder, code: (error as { code?: string }).code }).toEqual({ holder, code: "23514" });
  }
  expect((await sql`SELECT 1 FROM automation_tokens WHERE instance = 'rm_cross_rights'`).length).toBe(0);
});

test("a row written with no holder is the scheduler's — the default keeps pre-0078 inserts meaning what they meant", async () => {
  const hash = "b".repeat(64);
  await sql`
    INSERT INTO automation_tokens (instance, token_hash, rights)
    VALUES ('rm_legacy_insert', ${hash}, ${["read_subjects"]})`;
  const [row] = await sql<{ holder: string }[]>`
    SELECT holder FROM automation_tokens WHERE instance = 'rm_legacy_insert'`;
  expect(row?.holder).toBe("system-scheduler");
  expect([...AUTOMATION_HOLDERS]).toEqual(["system-scheduler", "analytics-producer", "operator"]);
});
