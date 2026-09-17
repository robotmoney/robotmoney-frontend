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
import {
  LEDGER_FAMILIES,
  analyticsLedgerGuardRefusalLines,
  checkAnalyticsLedgerGuard,
  ledgerTriggerNames,
} from "../src/db/analytics-ledger-guard.ts";
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

// Issue #979 AC6: the production startup guard for the Phase A LEDGER's own
// immutability triggers — a DIFFERENT trigger family from rm_append_only_guard
// above (source/run/output/cutover ledgers, migrations 0057-0060), each of
// which blocks UPDATE too. Same "probe, don't just inventory" discipline: a
// neutered trigger FUNCTION disarms every table in its family while the
// catalog still reports every trigger present, ENABLE ALWAYS, and correctly
// named — so this suite removes/disables real guards and requires the
// checker's own probe to catch it, never merely a trigger count.
describe("the analytics ledger immutability guard's runtime check (issue #979)", () => {
  afterEach(async () => {
    // Restore every family's function to its shipped, migration-defined body.
    for (const family of LEDGER_FAMILIES) {
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION public.${family.functionName}() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
        BEGIN
          RAISE EXCEPTION '${family.label} is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
            USING ERRCODE = 'feature_not_supported';
        END;
        $fn$;`);
      for (const table of family.tables) {
        const names = ledgerTriggerNames(table);
        await sql.unsafe(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${names.statement}`).catch(() => {});
        await sql.unsafe(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${names.row}`).catch(() => {});
      }
    }
  });

  test("reports 'armed' on a freshly migrated database", async () => {
    const result = await checkAnalyticsLedgerGuard(sql);
    expect(result.problems).toEqual([]);
    expect(result.status).toBe("armed");
  });

  test("a neutered function disarms an ENTIRE family (UPDATE, DELETE, AND TRUNCATE) while the catalog still looks perfect", async () => {
    const family = LEDGER_FAMILIES.find((f) => f.functionName === "rm_source_ledger_immutable")!;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION public.${family.functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF TG_LEVEL = 'ROW' THEN RETURN COALESCE(NEW, OLD); END IF; RETURN NULL; END $$;`);

    // The catalog is untouched: every trigger still exists, still names the
    // right function, still reports ENABLE ALWAYS.
    const rows = (await sql`
      SELECT c.relname::text AS table_name, t.tgenabled::text AS enabled, p.proname::text AS function_name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND c.relname = ANY(${[...family.tables]}::text[])`) as unknown as
      { table_name: string; enabled: string; function_name: string }[];
    expect(rows.length).toBe(family.tables.length * 2);
    expect(rows.every((r) => r.enabled === "A" && r.function_name === family.functionName)).toBe(true);

    // And a real row in a real table of this family can now be rewritten AND
    // removed — proved by doing it.
    const acquisition = crypto.randomUUID();
    await sql`INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity) VALUES (${acquisition}, 'fixture', '1', 'guard-check')`;
    await sql.unsafe(`UPDATE source_acquisitions SET cache_identity = 'rewritten' WHERE id = '${acquisition}'`);
    await sql.unsafe(`DELETE FROM source_acquisitions WHERE id = '${acquisition}'`);
    const left = await sql`SELECT 1 FROM source_acquisitions WHERE id = ${acquisition}`;
    expect(left.length, "a disarmed guard let the row be rewritten AND removed").toBe(0);

    // The real check catches it on every table in the family, for every
    // operation the family is supposed to block.
    const result = await checkAnalyticsLedgerGuard(sql);
    expect(result.status).toBe("disarmed");
    for (const table of family.tables) {
      expect(result.problems.some((p) => p.startsWith(`${table}: a UPDATE was ACCEPTED`))).toBe(true);
      expect(result.problems.some((p) => p.startsWith(`${table}: a DELETE was ACCEPTED`))).toBe(true);
    }
  });

  test("catches a single DROPPED trigger on one table of one family, in a database that is otherwise armed", async () => {
    await sql.unsafe(`DROP TRIGGER analytics_ledger_runs_immutable_row ON analytics_ledger_runs`);
    try {
      const result = await checkAnalyticsLedgerGuard(sql);
      expect(result.status).toBe("disarmed");
      expect(result.problems.some((p) => p.includes("analytics_ledger_runs: the row-level analytics run ledger trigger 'analytics_ledger_runs_immutable_row' is MISSING"))).toBe(true);
    } finally {
      await sql.unsafe(
        `CREATE TRIGGER analytics_ledger_runs_immutable_row BEFORE UPDATE OR DELETE ON analytics_ledger_runs
         FOR EACH ROW EXECUTE FUNCTION rm_analytics_run_ledger_immutable()`,
      );
      await sql.unsafe(`ALTER TABLE analytics_ledger_runs ENABLE ALWAYS TRIGGER analytics_ledger_runs_immutable_row`);
    }
  });

  test("catches ENABLE REPLICA TRIGGER on the output ledger family, which a 'try one delete' hand-check would NOT catch", async () => {
    await sql.unsafe(`ALTER TABLE analytics_report_snapshots ENABLE REPLICA TRIGGER analytics_report_snapshots_immutable`);
    try {
      const result = await checkAnalyticsLedgerGuard(sql);
      expect(result.status).toBe("disarmed");
      const joined = result.problems.join("\n");
      expect(joined).toContain("tgenabled='R'");
    } finally {
      await sql.unsafe(`ALTER TABLE analytics_report_snapshots ENABLE ALWAYS TRIGGER analytics_report_snapshots_immutable`);
    }
  });

  // Issue #979 AC6, literally: EACH required trigger, ONE AT A TIME. The three
  // tests above are the interesting shapes (a neutered function, one drop, one
  // ENABLE REPLICA); this one is the exhaustive sweep that keeps a later
  // migration from adding a table to a family — or renaming one trigger —
  // without the checker noticing.
  //
  // Note what a SINGLE drop does and does not remove. Migrations 0057-0060
  // install two OVERLAPPING triggers per table: `<t>_immutable` is BEFORE
  // UPDATE OR DELETE OR TRUNCATE FOR EACH STATEMENT, `<t>_immutable_row` is
  // BEFORE UPDATE OR DELETE FOR EACH ROW. So dropping either one alone leaves
  // UPDATE and DELETE still refused by the other — which is exactly why a
  // "try an UPDATE and see it fail" hand-check is not a sufficient guard
  // check, and why the inventory half has to exist. What a lone drop really
  // costs is proved by the two tests after this one: the statement trigger is
  // the TRUNCATE protection, and a neutered FUNCTION is what takes UPDATE and
  // DELETE with it on every table of a family at once.
  test("EVERY required ledger trigger, dropped ONE AT A TIME, is named by the checker with the protection it lost", async () => {
    for (const family of LEDGER_FAMILIES) {
      for (const table of family.tables) {
        const names = ledgerTriggerNames(table);
        for (const [level, name] of [["statement", names.statement], ["row", names.row]] as const) {
          // Recreate it afterwards from Postgres's own definition rather than
          // a hand-written CREATE TRIGGER, so this sweep cannot drift from
          // whatever the migration actually installed.
          const [defRow] = (await sql`
            SELECT pg_get_triggerdef(t.oid)::text AS def
            FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE NOT t.tgisinternal AND c.relname = ${table} AND t.tgname = ${name}
          `) as unknown as { def: string }[];
          expect(defRow?.def, `${table}.${name} must exist before it can be dropped`).toBeTruthy();

          await sql.unsafe(`DROP TRIGGER ${name} ON public.${table}`);
          try {
            const result = await checkAnalyticsLedgerGuard(sql);
            expect(result.status, `${table}.${name} dropped`).toBe("disarmed");
            expect(
              result.problems.some((p) =>
                p.startsWith(`${table}: the ${level}-level ${family.label} trigger '${name}' is MISSING`),
              ),
              `${table}.${name}: ${JSON.stringify(result.problems)}`,
            ).toBe(true);

            // The message names the migration that reinstalls it, so the
            // refusal is actionable rather than merely true.
            expect(result.problems.some((p) => p.includes(`re-apply backend/migrations/${family.migration}`)), table).toBe(true);

            // A disarmed check is what the boot refuses on, and the refusal an
            // operator reads names the missing trigger — not just "unarmed".
            const refusal = analyticsLedgerGuardRefusalLines(result.problems, "[api]").join("\n");
            expect(refusal).toContain("REFUSING the boot: the analytics ledger immutability guard");
            expect(refusal).toContain(name);
          } finally {
            await sql.unsafe(defRow!.def);
            await sql.unsafe(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${name}`);
          }
        }
      }
    }
    // And the database is back to fully armed, so the sweep proved something
    // about each drop rather than about a cumulatively broken database.
    expect((await checkAnalyticsLedgerGuard(sql)).status).toBe("armed");
  }, 120_000);

  // Issue #979 AC6's UPDATE and DELETE half, for EVERY family — not just the
  // source ledger the shaped test above uses. Each family's function is
  // neutered in turn (one statement, catalog untouched), and the checker must
  // report the accepted UPDATE and the accepted DELETE on every table of THAT
  // family, and stay silent about the others.
  test("EACH family's function neutered in turn: the checker names the lost UPDATE and DELETE protection, table by table", async () => {
    for (const family of LEDGER_FAMILIES) {
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION public.${family.functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN IF TG_LEVEL = 'ROW' THEN RETURN COALESCE(NEW, OLD); END IF; RETURN NULL; END $$;`);
      try {
        const result = await checkAnalyticsLedgerGuard(sql);
        expect(result.status, family.label).toBe("disarmed");
        for (const table of family.tables) {
          expect(result.problems.some((p) => p.startsWith(`${table}: a UPDATE was ACCEPTED`)), `${family.label}/${table}`).toBe(true);
          expect(result.problems.some((p) => p.startsWith(`${table}: a DELETE was ACCEPTED`)), `${family.label}/${table}`).toBe(true);
        }
        // No other family is implicated — the report points at the one that broke.
        const otherTables = LEDGER_FAMILIES.filter((f) => f !== family).flatMap((f) => f.tables);
        for (const table of otherTables) {
          expect(result.problems.some((p) => p.startsWith(`${table}:`)), `${table} must not be implicated`).toBe(false);
        }
      } finally {
        // afterEach re-arms too, but a later family in this same loop must not
        // run against a database the previous one left broken.
        await sql.unsafe(`
          CREATE OR REPLACE FUNCTION public.${family.functionName}() RETURNS trigger
          LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
          BEGIN
            RAISE EXCEPTION '${family.label} is immutable: % is not permitted on %', TG_OP, TG_TABLE_NAME
              USING ERRCODE = 'feature_not_supported';
          END;
          $fn$;`);
      }
    }
    expect((await checkAnalyticsLedgerGuard(sql)).status).toBe("armed");
  }, 60_000);

  test("the statement-level trigger really is the TRUNCATE protection — with it dropped, TRUNCATE goes through", async () => {
    // The probe half of the checker only issues UPDATE/DELETE (a TRUNCATE
    // probe cannot be made harmless with `WHERE false`), so the statement-level
    // trigger's contribution is asserted here instead, by doing the TRUNCATE —
    // inside a transaction that is rolled back, because TRUNCATE is
    // transactional in PostgreSQL and this clone's rows are still needed.
    const table = "analytics_parity_observations";
    await sql`
      INSERT INTO analytics_parity_observations
        (domain, legacy_row_count, ledger_row_count, legacy_checksum, ledger_checksum, matched, detail)
      VALUES ('raw_indicator_history', 1, 1, ${"7".repeat(64)}, ${"7".repeat(64)}, true, '{}'::jsonb)`;
    const [{ n: before }] = (await sql`SELECT count(*)::int AS n FROM analytics_parity_observations`) as unknown as { n: number }[];
    expect(before).toBeGreaterThan(0);

    // Armed: TRUNCATE is refused by the cutover ledger's own guard.
    let armedRefusal: { code?: string; message?: string } | null = null;
    try {
      await sql.unsafe(`TRUNCATE public.${table}`);
    } catch (e) {
      armedRefusal = e as { code?: string; message?: string };
    }
    expect(armedRefusal?.code).toBe("0A000");
    expect(armedRefusal?.message).toMatch(/^analytics cutover ledger is immutable: TRUNCATE is not permitted on analytics_parity_observations/);

    const [defRow] = (await sql`
      SELECT pg_get_triggerdef(t.oid)::text AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = ${table} AND t.tgname = ${ledgerTriggerNames(table).statement}
    `) as unknown as { def: string }[];
    await sql.unsafe(`DROP TRIGGER ${ledgerTriggerNames(table).statement} ON public.${table}`);
    try {
      let truncated = false;
      await sql
        .begin(async (tx) => {
          await tx.unsafe(`TRUNCATE public.${table}`);
          const [{ n }] = (await tx.unsafe(`SELECT count(*)::int AS n FROM ${table}`)) as unknown as { n: number }[];
          truncated = n === 0;
          throw new Error("rollback: the evidence must survive this test");
        })
        .catch(() => {});
      expect(truncated, "with the statement-level trigger gone, TRUNCATE erased the ledger").toBe(true);

      const result = await checkAnalyticsLedgerGuard(sql);
      expect(result.status).toBe("disarmed");
      expect(
        result.problems.some((p) =>
          p.startsWith(`${table}: the statement-level analytics cutover ledger trigger '${table}_immutable' is MISSING`),
        ),
        JSON.stringify(result.problems),
      ).toBe(true);
    } finally {
      await sql.unsafe(defRow!.def);
      await sql.unsafe(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${ledgerTriggerNames(table).statement}`);
    }
    const [{ n: after }] = (await sql`SELECT count(*)::int AS n FROM analytics_parity_observations`) as unknown as { n: number }[];
    expect(after, "the rolled-back TRUNCATE left the evidence intact").toBe(before);
  });

  test("the api process REFUSES to start against a disarmed ledger — a real boot, a real nonzero exit code", async () => {
    // Everything above proves the CHECKER sees it. AC6 also asks that the
    // production startup guard REFUSE, and `process.exit(1)` cannot be
    // asserted in-process — so this boots a real Bun process on the real
    // entrypoint function, pointed at this file's clone with one family
    // neutered, and requires a nonzero exit with the operator-facing refusal
    // on stderr. afterEach re-arms the function afterwards.
    const family = LEDGER_FAMILIES.find((f) => f.functionName === "rm_analytics_cutover_immutable")!;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION public.${family.functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN IF TG_LEVEL = 'ROW' THEN RETURN COALESCE(NEW, OLD); END IF; RETURN NULL; END $$;`);

    const [{ current_database: dbName }] = (await sql`SELECT current_database()`) as unknown as { current_database: string }[];
    const base = new URL(process.env.DATABASE_URL!);
    const cloneUrl = `postgres://${base.username}:${base.password}@${base.host}/${dbName}`;
    const guardModule = new URL("../src/db/analytics-ledger-guard.ts", import.meta.url).pathname;

    const proc = Bun.spawnSync(
      [
        "bun",
        "-e",
        `const { assertAnalyticsLedgerGuardArmed } = await import(${JSON.stringify(guardModule)});
         await assertAnalyticsLedgerGuardArmed();
         console.log("BOOTED");`,
      ],
      { env: { ...process.env, DATABASE_URL: cloneUrl }, stdout: "pipe", stderr: "pipe" },
    );
    const stderr = proc.stderr.toString();
    expect(proc.stdout.toString(), `the boot must not get past the guard.\nstderr:\n${stderr}`).not.toContain("BOOTED");
    expect(proc.exitCode, `stderr:\n${stderr}`).toBe(1);
    expect(stderr).toContain("REFUSING the boot: the analytics ledger immutability guard");
    expect(stderr).toContain("The api will NOT start");
    expect(stderr).toContain("analytics_parity_observations");
  }, 60_000);
});
