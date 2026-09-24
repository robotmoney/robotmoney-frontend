// `deployment_identity` is written by rm_owner and by nobody else — issue
// #1026, docs/technical/smoke-production-spec.md §4.2 and D52.
//
// §4.2 makes the one-row enrollment "writable only by rm_owner": it is the row
// that decides whether production guards arm (§4.3), so a runtime role that
// could write it could enrol a production database as a rehearsal and switch
// every production guard off from inside the application. Migration 0063
// revokes ALL from the three runtime roles and grants SELECT back, and
// backend/schema/grants.sql re-asserts that on every reconciliation.
//
// WHAT THIS FILE PROVES, AND HOW. Each runtime role is refused INSERT, UPDATE,
// DELETE and TRUNCATE BY GRANT — SQLSTATE 42501, raised by the executor's
// privilege check before any row or trigger is looked at — over a real login
// connection AS THAT ROLE. Not a `has_table_privilege` query and not a
// TypeScript role check: the statement is attempted and the database refuses
// it. It is proved twice: on the migrated schema, and again after a run of the
// REAL roles-and-grants part of the snapshot (the file every migrate run
// applies), because the historical failure in this repository is a
// reconciliation sweep that quietly widened a table a migration had narrowed.
//
// SELECT is asserted for each role as well. Without it, a role that could not
// even connect would pass every refusal below.
//
// What this file does NOT prove: that the smoke's blank bootstrap and dump
// restore each leave the row `rehearsal` at runtime. The blank-bootstrap half is
// executed against the real snapshot in schema-snapshot.test.ts; wiring both
// into the smoke's `--local` modes is later work.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const RUNTIME_ROLES = ["rm_app", "rm_worker", "rm_readonly"] as const;
type RuntimeRole = (typeof RUNTIME_ROLES)[number];

const PASSWORD: Record<RuntimeRole, string> = {
  rm_app: "rm_app_identity_test",
  rm_worker: "rm_worker_identity_test",
  rm_readonly: "rm_readonly_identity_test",
};

/** Each write a runtime role might attempt, spelled so that the privilege
 *  check is the ONLY thing that can refuse it: the INSERT would violate the
 *  one-row key, the UPDATE and DELETE match the one row, and TRUNCATE has no
 *  WHERE at all. A 42501 therefore cannot be a constraint or an empty match. */
const WRITES = {
  INSERT: "INSERT INTO deployment_identity (kind) VALUES ('production')",
  UPDATE: "UPDATE deployment_identity SET kind = 'production'",
  DELETE: "DELETE FROM deployment_identity",
  TRUNCATE: "TRUNCATE deployment_identity",
} as const;

const connections = new Map<RuntimeRole, postgres.Sql<{}>>();

beforeAll(async () => {
  const [{ db }] = (await sql`SELECT current_database() AS db`) as unknown as { db: string }[];
  for (const role of RUNTIME_ROLES) {
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${PASSWORD[role]}'`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${db}`;
    url.username = role;
    url.password = PASSWORD[role];
    connections.set(role, postgres(url.toString(), { max: 1, onnotice: () => {} }));
  }
  // The enrollment a blank bootstrap writes, so every refusal below is refusing
  // a write to a real row.
  await sql`INSERT INTO deployment_identity (kind) VALUES ('rehearsal') ON CONFLICT (id) DO NOTHING`;
});

afterAll(async () => {
  for (const connection of connections.values()) await connection.end({ timeout: 5 });
});

async function sqlstate(role: RuntimeRole, statement: string): Promise<string | null> {
  try {
    await connections.get(role)!.unsafe(statement);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-sqlstate";
  }
}

async function assertEveryWriteRefusedByGrant(): Promise<void> {
  for (const role of RUNTIME_ROLES) {
    // The connection is real and the table is readable: a refusal below is
    // about writing, not about reaching the database.
    const [who] = (await connections.get(role)!`SELECT current_user AS role`) as unknown as { role: string }[];
    expect(who?.role).toBe(role);
    const rows = (await connections.get(role)!`SELECT kind FROM deployment_identity`) as unknown as { kind: string }[];
    expect(rows.map((r) => r.kind)).toEqual(["rehearsal"]);

    for (const [verb, statement] of Object.entries(WRITES)) {
      expect({ role, verb, sqlstate: await sqlstate(role, statement) }).toEqual({ role, verb, sqlstate: "42501" });
    }
  }
  // And nothing moved.
  const after = await sql<{ kind: string }[]>`SELECT kind FROM deployment_identity`;
  expect(after.map((r) => r.kind)).toEqual(["rehearsal"]);
}

describe("deployment_identity refuses every runtime role's write by grant (§4.2, D52)", () => {
  test("on the migrated schema: rm_app, rm_worker and rm_readonly each get 42501 for INSERT, UPDATE, DELETE and TRUNCATE", async () => {
    await assertEveryWriteRefusedByGrant();
  });

  test("after the real roles-and-grants reconciliation runs, still 42501 for every role and every write", async () => {
    // The file every migrate run applies (§8.3: "always, even with nothing
    // pending"), as the role that applies it.
    const snapshot = await loadSnapshot();
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(snapshot.grantsSql);
    });
    await assertEveryWriteRefusedByGrant();
  });
});
