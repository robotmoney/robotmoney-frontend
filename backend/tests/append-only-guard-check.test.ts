// THE RUNTIME CHECK, AGAINST A DATABASE THAT LOOKS PERFECT AND IS DISARMED.
//
// The security review for issue #684 asked for a post-restore verification that
// migration 0032's triggers are present. The reason this file exists is that
// the obvious implementation of that request — count the triggers, read
// `tgenabled` — is worthless, and the only way to keep it from being built that
// way later is to make the disarmed database an executed fixture:
//
//   CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger
//   LANGUAGE plpgsql AS $$ BEGIN … END $$;
//
// One statement. Needs only FUNCTION ownership, which is what the application
// connects as. Afterwards every trigger still exists, still attaches to the
// right table, still names `rm_append_only_guard`, still reports
// `tgenabled = 'A'` — and every DELETE succeeds. The `DISARM` constant below is
// that statement, and the test that uses it requires every inventory-style
// assertion to be SATISFIED by the disarmed database, so nobody can later
// "simplify" the check into a trigger count.
//
// Everything here runs against a database cloned for this file alone
// (tests/support/clean-db.ts), because half of it deliberately breaks the guard
// and one test then deletes real rows.
import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import {
  APPEND_ONLY_MIGRATION,
  APPEND_ONLY_TABLES,
  checkAppendOnlyGuard,
  isAppendOnlyRefusal,
  triggerNames,
} from "../src/db/append-only-guard.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

/** Put the guard function back the way migration 0032 defines it. Re-applying
 *  the migration file would work too, but re-reading the .sql here would make
 *  this file's fixtures depend on parsing it. */
const REARM = `
CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'table "%" is append-only: row deletion is not permitted (%). History rows are not removed; correct a row with an UPDATE or an offsetting row.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000',
          DETAIL = format('refused by trigger %s, %s level (migration 0032)', TG_NAME, TG_LEVEL);
END;
$$;`;

/**
 * The one-statement disarm, named for what it is.
 *
 * The security review's version of this was `BEGIN RETURN NULL; END`, and
 * against the shipped two-trigger guard that is NOT a full disarm — which is
 * worth recording, because it is a second-order effect nobody designed for. A
 * BEFORE ROW trigger returning NULL CANCELS the operation for that row, so a
 * `RETURN NULL` body converts every DELETE into a SILENT NO-OP: the statement
 * reports `DELETE 1` and the row is still there. Deletion still fails
 * (differently, and arguably worse — the caller is now lied to).
 *
 * So the honest strongest attack, and the one used here, branches on TG_LEVEL.
 * It is still ONE statement and still needs only function ownership.
 */
const DISARM = `
CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN IF TG_LEVEL = 'ROW' THEN RETURN OLD; END IF; RETURN NULL; END $$;`;

afterEach(async () => {
  // Every test restores the shipped state, so ordering between them cannot
  // matter and a failure mid-test cannot leave the rest running against a
  // disarmed database and reporting nonsense.
  await sql.unsafe(REARM);
  for (const table of APPEND_ONLY_TABLES) {
    const names = triggerNames(table);
    await sql.unsafe(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${names.statement}`).catch(() => {});
    await sql.unsafe(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${names.row}`).catch(() => {});
  }
});

describe("the append-only guard's runtime check", () => {
  test("reports 'armed' on a freshly migrated database", async () => {
    const result = await checkAppendOnlyGuard(sql);
    expect(result.problems).toEqual([]);
    expect(result.status).toBe("armed");
  });

  test("A TRIGGER INVENTORY IS SATISFIED BY A FULLY DISARMED DATABASE — the probe is not", async () => {
    // THE WHOLE POINT OF THIS FILE. Replace the function body; change nothing
    // else.
    await sql.unsafe(DISARM);

    // 1. The catalog is untouched and every inventory-style assertion passes.
    const rows = (await sql`
      SELECT c.relname::text AS table_name, t.tgname::text AS trigger_name,
             t.tgenabled::text AS enabled, p.proname::text AS function_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND t.tgname LIKE '%\\_append\\_only%'
    `) as unknown as { table_name: string; trigger_name: string; enabled: string; function_name: string }[];
    expect(rows.length, "both triggers on every protected table are still there").toBe(APPEND_ONLY_TABLES.length * 2);
    for (const r of rows) {
      expect(r.enabled, `${r.trigger_name} still reports ENABLE ALWAYS`).toBe("A");
      expect(r.function_name, `${r.trigger_name} still names the right function`).toBe("rm_append_only_guard");
    }

    // 2. And deletion is completely unguarded. Proved by DOING it — this is a
    //    clone, so a real row really goes.
    await sql`INSERT INTO audit_log (actor, action) VALUES ('append-only-disarm-probe', 'probe')`;
    await sql.unsafe(`DELETE FROM audit_log WHERE actor = 'append-only-disarm-probe'`);
    const left = (await sql`SELECT 1 FROM audit_log WHERE actor = 'append-only-disarm-probe'`) as unknown as unknown[];
    expect(left.length, "a disarmed guard lets the row go; the inventory above did not notice").toBe(0);

    // 3. The check catches it, because it PROBES.
    const result = await checkAppendOnlyGuard(sql);
    expect(result.status).toBe("disarmed");
    expect(result.problems.length).toBe(APPEND_ONLY_TABLES.length);
    for (const table of APPEND_ONLY_TABLES) {
      expect(result.problems.some((p) => p.startsWith(`${table}: a DELETE was ACCEPTED`))).toBe(true);
    }
  });

  test("catches a single DROPPED trigger, on one table, in a database that is otherwise armed", async () => {
    await sql.unsafe(`DROP TRIGGER swarm_recommendations_append_only_row ON swarm_recommendations`);
    try {
      const result = await checkAppendOnlyGuard(sql);
      expect(result.status).toBe("disarmed");
      // Only the ROW-level trigger is gone, so the probe (a statement-level
      // event) is still refused on every table — the inventory is the only half
      // that can see this, which is why both halves exist.
      expect(result.problems).toEqual([
        expect.stringContaining("swarm_recommendations: the row-level trigger 'swarm_recommendations_append_only_row' is MISSING"),
      ]);
    } finally {
      await sql.unsafe(
        `CREATE TRIGGER swarm_recommendations_append_only_row BEFORE DELETE ON swarm_recommendations
         FOR EACH ROW EXECUTE FUNCTION rm_append_only_guard()`,
      );
      await sql.unsafe(`ALTER TABLE swarm_recommendations ENABLE ALWAYS TRIGGER swarm_recommendations_append_only_row`);
    }
  });

  test("catches ENABLE REPLICA TRIGGER, which a 'try deleting a row' check would NOT catch", async () => {
    // tgenabled='R' is the sneakiest DDL bypass: the trigger still exists, still
    // names the right function, and is skipped in exactly the replica-role
    // session a restore or a replication apply runs as. Applied here to the
    // STATEMENT-level trigger only, which produces a database where the obvious
    // hand-check passes and the guarantee is gone.
    await sql.unsafe(`ALTER TABLE audit_log ENABLE REPLICA TRIGGER audit_log_append_only`);

    // The obvious hand-check — delete a REAL row and see it refused — is
    // satisfied, because the row-level trigger is still ALWAYS and still fires.
    await sql`INSERT INTO audit_log (actor, action) VALUES ('append-only-replica-probe', 'probe')`;
    let handCheck: unknown = null;
    try {
      await sql.unsafe(`DELETE FROM audit_log WHERE actor = 'append-only-replica-probe'`);
    } catch (e) {
      handCheck = e;
    }
    expect(
      isAppendOnlyRefusal(handCheck, "audit_log"),
      "deleting a real row is still refused here — which is exactly why that is not a sufficient check",
    ).toBe(true);

    // The real check catches it twice over: the catalog sees 'R', and the probe
    // (a statement-level event, matching no rows) is now ACCEPTED.
    const result = await checkAppendOnlyGuard(sql);
    expect(result.status).toBe("disarmed");
    const joined = result.problems.join("\n");
    expect(joined).toContain("tgenabled='R'");
    expect(joined).toContain("audit_log: a DELETE was ACCEPTED");
  });

  test("'not_applied' — never 'disarmed' — when the migration was never applied here", async () => {
    // A first boot against a database that predates 0032 must not be refused:
    // migrate() is what installs the guard. The distinction is the whole reason
    // the api can afford to fail closed on "disarmed".
    await sql.unsafe(`ALTER TABLE schema_migrations DISABLE TRIGGER USER`);
    try {
      await sql`DELETE FROM schema_migrations WHERE name = ${APPEND_ONLY_MIGRATION}`;
      const result = await checkAppendOnlyGuard(sql);
      expect(result.status).toBe("not_applied");
      expect(result.problems).toEqual([]);
    } finally {
      await sql`INSERT INTO schema_migrations (name) VALUES (${APPEND_ONLY_MIGRATION})
                ON CONFLICT (name) DO NOTHING`;
      await sql.unsafe(`ALTER TABLE schema_migrations ENABLE ALWAYS TRIGGER schema_migrations_append_only`);
      await sql.unsafe(`ALTER TABLE schema_migrations ENABLE ALWAYS TRIGGER schema_migrations_append_only_row`);
    }
  });

  test("isAppendOnlyRefusal rejects PostgreSQL's own 0A000 — SQLSTATE alone is a false green", async () => {
    // heap_truncate_check_FKs() raises `cannot truncate a table referenced in a
    // foreign key constraint` with SQLSTATE 0A000, BEFORE the trigger stage. On
    // a table with an inbound FK, a SQLSTATE-only assertion is therefore green
    // against a database where migration 0032 was never applied at all. Build
    // that exact error and require the recogniser to reject it.
    await sql.unsafe(`ALTER TABLE swarm_members DISABLE TRIGGER USER`);
    let raised: unknown = null;
    try {
      await sql.unsafe(`TRUNCATE TABLE swarm_members`);
    } catch (e) {
      raised = e;
    } finally {
      const names = triggerNames("swarm_members");
      await sql.unsafe(`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER ${names.statement}`);
      await sql.unsafe(`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER ${names.row}`);
    }
    const err = raised as { code?: string; message?: string };
    expect(err?.code, "the fixture must really be a 0A000 from Postgres itself").toBe("0A000");
    expect(err?.message).toMatch(/cannot truncate a table referenced in a foreign key constraint/);
    expect(isAppendOnlyRefusal(raised, "swarm_members"), "0A000 is not evidence; the message is").toBe(false);
  });
});
