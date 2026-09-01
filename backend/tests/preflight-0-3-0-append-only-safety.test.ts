// v0.3.0 preflight's `append-only-safety` check — graded in BOTH directions.
//
// WHY THIS FILE EXISTS (issue #815). The check used to flag any table in
// `MIGRATION_TOUCHED_TABLES` that carried an `*_append_only` trigger, and print
// that as "this release may destroy protected history". But
// `rm_append_only_guard()` (migration 0032) fires `BEFORE DELETE OR TRUNCATE`
// only, so 0035's `VALIDATE CONSTRAINT` on `swarm_members` and 0039's
// `DROP/ADD CONSTRAINT` on `swarm_sessions` take a LOCK and can never trip it.
// The check asserted "touches" and reported "destroys", v0.3.0 preflight exited
// `1 / BLOCKED` with nothing wrong, and the runbook told the operator to read
// past it — which is a documented instruction to distrust a safety check.
//
// A check that passes everything is no better than the one that failed
// everything, so every fixture below is asserted in a PAIR: the destructive
// shape must turn it red, and the lock-shaped near-miss must leave it green.
//
// Runs against the suite's ephemeral Postgres (tests/preload.ts) — the real
// trigger catalog, not a stub. All queries here are SELECTs; the end-to-end
// case builds its OWN throwaway database on the same instance (the pattern
// db-preflight.test.ts uses) so nothing this file does can disturb a sibling
// test file's fixtures.

import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type CheckResult, createChecker, printVerdict } from "../scripts/lib/checks.ts";
import type { Db } from "../scripts/lib/preflight-utils.ts";
import {
  checkAppendOnlySafety,
  guardedTablesInstalledBy,
  type MigrationSql,
  runChecks,
  scanMigrationSql,
} from "../scripts/upgrades/0.2.2-to-0.3.0/preflight.ts";
import {
  APPEND_ONLY_MIGRATION,
  PRIOR_RELEASE_MIGRATIONS,
  THIS_RELEASE_MIGRATIONS,
} from "../scripts/upgrades/0.2.2-to-0.3.0/release.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(testDir, "..", "migrations");

const DB_URL = process.env.DATABASE_URL;
// Loud, not skipped: this suite is meaningless without the real trigger catalog.
if (!DB_URL) throw new Error("DATABASE_URL is unset — tests/preload.ts must provision the ephemeral Postgres first");

/** The guard migration is the only `applied` entry the check reads. */
const GUARD_APPLIED = new Set<string>([APPEND_ONLY_MIGRATION]);

describe("append-only-safety tells a LOCK apart from a WRITE", () => {
  let db: Db;

  beforeAll(() => {
    db = postgres(DB_URL, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await db?.end({ timeout: 5 });
  });

  /** Run the CHECK ITSELF (not a re-implementation of its rules) over a set of
   *  fixture migrations, and hand back its recorded result. */
  async function check(...migrations: MigrationSql[]): Promise<CheckResult> {
    const checker = createChecker("");
    await checkAppendOnlySafety(db, checker, GUARD_APPLIED, async () => migrations);
    const result = checker.results.find((r) => r.name === "append-only-safety");
    expect(result).toBeDefined();
    return result!;
  }

  // ── The issue's test plan, item 1: both directions on the same table ──────

  test("RED: a migration issuing DELETE FROM swarm_members fails the check", async () => {
    const r = await check({
      file: "9001_delete_from_protected.sql",
      sql: "DELETE FROM swarm_members WHERE id = 'x';",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("9001_delete_from_protected.sql: DELETE swarm_members");
  });

  test("GREEN: a migration issuing ALTER TABLE swarm_members VALIDATE CONSTRAINT passes", async () => {
    // This is 0035's real shape. It takes a lock on a protected table and
    // removes nothing, which is exactly what the old check could not express.
    const r = await check({
      file: "9002_validate_constraint.sql",
      sql: "ALTER TABLE swarm_members VALIDATE CONSTRAINT swarm_members_handle_fk;",
    });
    expect(r.status).toBe("PASS");
  });

  test("GREEN: 0039's constraint swap on swarm_sessions passes", async () => {
    const r = await check({
      file: "9003_constraint_swap.sql",
      sql: [
        "ALTER TABLE swarm_sessions DROP CONSTRAINT IF EXISTS swarm_sessions_state_check;",
        "ALTER TABLE swarm_sessions ADD CONSTRAINT swarm_sessions_state_check",
        "  CHECK (state IN ('scheduled', 'judged', 'published'));",
      ].join("\n"),
    });
    expect(r.status).toBe("PASS");
  });

  // ── The issue's test plan, item 2: guard tampering ────────────────────────

  test("RED: ALTER TABLE ... DISABLE TRIGGER ..._append_only fails the check", async () => {
    const r = await check({
      file: "9004_disable_trigger.sql",
      sql: "ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_append_only;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("DISABLE TRIGGER swarm_members.swarm_members_append_only");
  });

  test("RED: dropping an append-only trigger fails the check", async () => {
    const r = await check({
      file: "9005_drop_trigger.sql",
      sql: "DROP TRIGGER IF EXISTS swarm_members_append_only_row ON swarm_members;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("DROP TRIGGER");
  });

  test("RED: demoting the guard from ENABLE ALWAYS to ENABLE REPLICA fails the check", async () => {
    // 0032 installs the guard ENABLE ALWAYS precisely so a
    // `session_replication_role = replica` apply cannot bypass it. Demoting it
    // re-opens that door without the word DISABLE ever appearing.
    const r = await check({
      file: "9006_enable_replica.sql",
      sql: "ALTER TABLE swarm_sessions ENABLE REPLICA TRIGGER swarm_sessions_append_only;",
    });
    expect(r.status).toBe("FAIL");
  });

  test("RED: replacing rm_append_only_guard()'s body fails the check", async () => {
    const r = await check({
      file: "9007_replace_guard_fn.sql",
      sql: "CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN OLD; END; $body$;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("GUARD FUNCTION");
  });

  test("RED: disabling a TABLE-SPECIFIC immutability guard fails too", async () => {
    // Not every guard is 0032's. 0037/0038 install per-table `<t>_immutable`
    // pairs driven by their own guard functions, on tables the append-only
    // roster does not contain, and a migration adding a newly protected table
    // follows that same shape. A check that only knew `_append_only` would
    // watch one of the three and call it coverage.
    const r = await check({
      file: "9008_disable_table_specific_guard.sql",
      sql: "ALTER TABLE wallet_balance_sample_evidence DISABLE TRIGGER wallet_balance_sample_evidence_immutable_row;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("DISABLE TRIGGER");
  });

  test("RED: replacing a table-specific guard FUNCTION fails", async () => {
    const r = await check({
      file: "9008b_replace_table_guard_fn.sql",
      sql: "CREATE OR REPLACE FUNCTION rm_aum_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN RETURN NEW; END; $b$;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("GUARD FUNCTION rm_aum_evidence_guard");
  });

  test("GREEN: disabling an ordinary trigger on an unprotected table passes", async () => {
    // The near-miss for the two RED cases above: neither the name nor the table
    // says "immutability guard", so this is ordinary DDL and must stay green.
    // `job_schedules` is deliberate — it is in MIGRATION_TOUCHED_TABLES but in
    // neither guard roster, so it is the honest "unprotected" example.
    const r = await check({
      file: "9008c_disable_unrelated_trigger.sql",
      sql: "ALTER TABLE job_schedules DISABLE TRIGGER job_schedules_touch_updated_at;",
    });
    expect(r.status).toBe("PASS");
  });

  test("RED: DISABLE TRIGGER ALL on a protected table fails, whatever the guard is called", async () => {
    const r = await check({
      file: "9008d_disable_all.sql",
      sql: "ALTER TABLE swarm_recommendations DISABLE TRIGGER ALL;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("swarm_recommendations.ALL");
  });

  test("GREEN: a trigger whose NAME starts with the word ALL is not the ALL keyword", async () => {
    const r = await check({
      file: "9008e_all_prefixed_name.sql",
      sql: "ALTER TABLE job_schedules DISABLE TRIGGER all_events_notify;",
    });
    expect(r.status).toBe("PASS");
  });

  // ── Detection quality: the false positives and negatives a naive substring
  //    match would have. Each of these is a rule stated in preflight.ts's
  //    header block, executed rather than asserted in prose.

  test("RED: a DELETE hidden inside a DO $$ ... $$ block still fails", async () => {
    const r = await check({
      file: "9009_do_block.sql",
      sql: "DO $$ BEGIN DELETE FROM swarm_sessions WHERE state = 'cancelled'; END $$;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("DELETE swarm_sessions");
  });

  test("RED: a DELETE inside a data-modifying CTE still fails", async () => {
    const r = await check({
      file: "9010_cte.sql",
      sql: "WITH gone AS (DELETE FROM swarm_memos WHERE id = 'x' RETURNING id) INSERT INTO audit_log (id) SELECT id FROM gone;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("DELETE swarm_memos");
  });

  test("RED: TRUNCATE of a protected table fails", async () => {
    const r = await check({
      file: "9011_truncate.sql",
      sql: "TRUNCATE TABLE public.swarm_briefs, audit_log RESTART IDENTITY CASCADE;",
    });
    expect(r.status).toBe("FAIL");
    const detail = r.detail.join("\n");
    expect(detail).toContain("TRUNCATE swarm_briefs");
    expect(detail).toContain("TRUNCATE audit_log");
  });

  test("RED: dropping a protected table fails — it takes the guard with it", async () => {
    const r = await check({ file: "9012_drop_table.sql", sql: "DROP TABLE IF EXISTS swarm_subjects CASCADE;" });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("DROP TABLE swarm_subjects");
  });

  test("GREEN: the words in a comment or a string literal are not statements", async () => {
    const r = await check({
      file: "9013_prose_only.sql",
      sql: [
        "-- DELETE FROM swarm_members is exactly what this migration must never do.",
        "/* TRUNCATE swarm_sessions; would abort the boot. */",
        "COMMENT ON TABLE swarm_members IS 'never DELETE FROM swarm_members here';",
      ].join("\n"),
    });
    expect(r.status).toBe("PASS");
  });

  test("GREEN: REVOKE ... DELETE ON <protected> is a grant change, not a removal", async () => {
    // 0040's real last line. A naive `\bDELETE\b` match reddens on it.
    const r = await check({
      file: "9014_revoke.sql",
      sql: "REVOKE INSERT, UPDATE, DELETE ON swarm_session_judgements FROM rm_worker;",
    });
    expect(r.status).toBe("PASS");
  });

  test("GREEN: a trigger EVENT list naming DELETE OR TRUNCATE is not a removal", async () => {
    // 0038's real shape, and the reason TRUNCATE must lead its statement to
    // count while DELETE FROM may appear anywhere.
    const r = await check({
      file: "9015_create_trigger.sql",
      sql: "CREATE TRIGGER swarm_members_probe BEFORE UPDATE OR DELETE OR TRUNCATE ON swarm_members FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard();",
    });
    expect(r.status).toBe("PASS");
  });

  test("a table this release protects for the first time counts as protected", async () => {
    // `swarm_session_judgements` does not exist on a v0.2.2 database, so the
    // live trigger catalog cannot know about it — 0040 creates its guard inside
    // this very release. The declared roster is unioned in for exactly this.
    const r = await check({
      file: "9016_delete_from_new_protected.sql",
      sql: "DELETE FROM swarm_session_judgements WHERE applied = false;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("DELETE swarm_session_judgements");
  });

  // ── The guards this release installs on ITS OWN tables ────────────────────
  //
  // The live catalog reads `%_append_only` triggers only, so it cannot see the
  // table-specific pairs 0037/0038 install; and it is read against a v0.2.2
  // database, so it cannot see a table this release creates. Both gaps graded
  // real protected tables as UNPROTECTED, and `main`'s over-broad rule would
  // have caught them — a detection regression hidden by main's noise.

  test("RED: DELETE FROM wallet_balance_sample_evidence fails — 0037 guards it inside this release", async () => {
    const r = await check({
      file: "9017_delete_from_evidence.sql",
      sql: "DELETE FROM wallet_balance_sample_evidence WHERE sample_date < '2020-01-01';",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("DELETE wallet_balance_sample_evidence");
  });

  test("GREEN: the near-miss — ALTERing that same evidence table passes", async () => {
    const r = await check({
      file: "9018_alter_evidence.sql",
      sql: "ALTER TABLE wallet_balance_sample_evidence ADD COLUMN note text;",
    });
    expect(r.status).toBe("PASS");
  });

  test("RED: TRUNCATE of wallet_aum_snapshot_runs and the sleeve evidence table fails", async () => {
    const r = await check({
      file: "9019_truncate_aum.sql",
      sql: "TRUNCATE wallet_aum_snapshot_runs, wallet_sleeve_sample_evidence;",
    });
    expect(r.status).toBe("FAIL");
    const d = r.detail.join("\n");
    expect(d).toContain("TRUNCATE wallet_aum_snapshot_runs");
    expect(d).toContain("TRUNCATE wallet_sleeve_sample_evidence");
  });

  // ── Protection is ORDERED, and the order is computed, not assumed ──────────

  test("a removal AFTER the migration that installs the guard fails; the same removal BEFORE it passes", async () => {
    // This is 0037/0038's real relationship, reduced. 0037 deletes from
    // wallet_balance_samples and 0038 guards that table afterwards; grading
    // against the end-state roster alone would re-block the release for a guard
    // that does not exist yet when the delete runs. Both directions asserted, so
    // the ordering is a checked fact rather than a coincidence.
    const installer: MigrationSql = {
      file: "9020_installs_guard.sql",
      sql: [
        "DO $$ DECLARE t text; BEGIN",
        "  FOREACH t IN ARRAY ARRAY['wallet_balance_samples'] LOOP",
        "    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION rm_x()', t || '_immutable', t);",
        "  END LOOP;",
        "END $$;",
      ].join("\n"),
    };
    const remover: MigrationSql = {
      file: "9021_removes_rows.sql",
      sql: "DELETE FROM wallet_balance_samples WHERE sample_date < '2020-01-01';",
    };

    const after = await check(installer, remover);
    expect({ order: "install then delete", status: after.status }).toEqual({
      order: "install then delete",
      status: "FAIL",
    });

    const before = await check(remover, installer);
    expect({ order: "delete then install", status: before.status }).toEqual({
      order: "delete then install",
      status: "PASS",
    });
    // …and the PASS must say WHY it is safe, naming the file that guards it.
    expect(before.detail.join("\n")).toContain("guarded from 9020_installs_guard.sql");
  });

  test("a removal that is safe only by ordering is never called UNPROTECTED", async () => {
    // The string that used to be the operator-facing lie. `wallet_balance_samples`
    // carries a BEFORE DELETE guard by the end of this release, so no line of
    // this check may describe it as a table no guard covers.
    const r = await check(
      { file: "9022_remove_then_guard.sql", sql: "DELETE FROM wallet_balance_samples WHERE true;" },
      {
        file: "9023_guard.sql",
        sql: "DO $$ BEGIN EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION rm_x()', 'wallet_balance_samples_immutable', 'wallet_balance_samples'); END $$;",
      },
    );
    expect(r.status).toBe("PASS");
    const d = r.detail.join("\n");
    expect(d).toContain("run BEFORE this release installs the guard");
    // The "no guard covers" bucket must not claim this table.
    const unguardedLine = r.detail.find((l) => l.includes("no guard covers")) ?? "";
    expect(unguardedLine).not.toContain("wallet_balance_samples");
  });

  // ── Blocker 2: the anchored rules must see inside a DO $$ … $$ block ───────
  //
  // stripSqlNoise() unwraps a dollar-quoted body so its contents are scanned,
  // but the unwrapped text begins `BEGIN …`, not the statement. DELETE FROM is
  // matched anywhere and survived that; TRUNCATE, DROP TABLE, DISABLE TRIGGER
  // and DROP TRIGGER were anchored and were invisible in every DO block — while
  // the comment claimed DO blocks were handled and only the DELETE case was
  // asserted. 0037, 0038 and 0040 all do their trigger DDL inside one.

  test.each([
    ["TRUNCATE", "DO $$ BEGIN TRUNCATE swarm_briefs; END $$;", "TRUNCATE swarm_briefs"],
    ["DROP TABLE", "DO $$ BEGIN DROP TABLE swarm_subjects; END $$;", "DROP TABLE swarm_subjects"],
    [
      "DISABLE TRIGGER",
      "DO $$ BEGIN ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_append_only; END $$;",
      "DISABLE TRIGGER",
    ],
    [
      "DROP TRIGGER",
      "DO $$ BEGIN DROP TRIGGER swarm_members_append_only ON swarm_members; END $$;",
      "DROP TRIGGER",
    ],
    [
      "TRUNCATE inside IF",
      "DO $$ BEGIN IF to_regclass('public.audit_log') IS NOT NULL THEN TRUNCATE TABLE audit_log; END IF; END $$;",
      "TRUNCATE audit_log",
    ],
    [
      "TRUNCATE inside FOREACH LOOP",
      "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['x'] LOOP TRUNCATE swarm_memos; END LOOP; END $$;",
      "TRUNCATE swarm_memos",
    ],
  ])("RED: %s inside a DO $$ ... $$ block fails", async (_label, sql, expected) => {
    const r = await check({ file: "9024_do_block_shapes.sql", sql });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain(expected);
  });

  test("GREEN: a DO block that only CREATEs guards is still clean", async () => {
    // 0040's real shape, and the near-miss for every RED case above: peeling
    // block openers must not turn a guard INSTALLATION into a guard removal.
    const r = await check({
      file: "9025_do_block_installs.sql",
      sql: [
        "DO $$ DECLARE t text; BEGIN",
        "  FOREACH t IN ARRAY ARRAY['swarm_session_judgements'] LOOP",
        "    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard()', t || '_append_only', t);",
        "    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only');",
        "  END LOOP;",
        "END $$;",
      ].join("\n"),
    });
    expect(r.status).toBe("PASS");
  });

  // ── Installing a guard is not removing one ────────────────────────────────
  //
  // 0032, 0040 and 0042 all install idempotently with
  // `DROP TRIGGER IF EXISTS x; CREATE TRIGGER x …`, and 0042 opens with
  // `CREATE OR REPLACE FUNCTION rm_consensus_receipt_immutable()` to define its
  // OWN new guard. Reading either as tampering would block the release for
  // ADDING protection. Both exemptions are narrow and both are asserted against
  // their near-miss, so neither can quietly swallow a real removal.

  test("GREEN: DROP TRIGGER followed by CREATE TRIGGER in the SAME migration is an install", async () => {
    const r = await check({
      file: "9026_install_idiom.sql",
      sql: [
        "DROP TRIGGER IF EXISTS swarm_consensus_receipts_immutable ON swarm_consensus_receipts;",
        "CREATE TRIGGER swarm_consensus_receipts_immutable",
        "  BEFORE UPDATE ON swarm_consensus_receipts",
        "  FOR EACH STATEMENT EXECUTE FUNCTION rm_consensus_receipt_immutable();",
      ].join("\n"),
    });
    expect(r.status).toBe("PASS");
    // Seen and reported, not silently ignored.
    expect(r.detail.join("\n")).toContain("dropped and re-created by the SAME migration");
  });

  test("RED: the near-miss — DROP TRIGGER with NO re-creation still fails", async () => {
    const r = await check({
      file: "9027_drop_without_recreate.sql",
      sql: "DROP TRIGGER IF EXISTS swarm_consensus_receipts_immutable ON swarm_consensus_receipts;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("DROP TRIGGER");
  });

  test("RED: a re-creation on a DIFFERENT table does not excuse the drop", async () => {
    const r = await check({
      file: "9028_recreate_elsewhere.sql",
      sql: [
        "DROP TRIGGER IF EXISTS swarm_members_append_only ON swarm_members;",
        "CREATE TRIGGER swarm_briefs_append_only BEFORE DELETE ON swarm_briefs",
        "  FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard();",
      ].join("\n"),
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("swarm_members.swarm_members_append_only");
  });

  test("GREEN: CREATE OR REPLACE FUNCTION defining a NEW guard is protection being added", async () => {
    // 0042's real opening line. The function does not exist on the database and
    // no earlier migration defines it, so this defines a guard rather than
    // swapping a live one's body.
    const r = await check({
      file: "9029_define_new_guard_fn.sql",
      sql: "CREATE OR REPLACE FUNCTION rm_brand_new_thing_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'no'; END; $fn$;",
    });
    expect(r.status).toBe("PASS");
  });

  test("RED: the near-miss — CREATE OR REPLACE of a guard function that ALREADY exists fails", async () => {
    // `rm_append_only_guard()` is on the database (0032), so replacing its body
    // swaps a live guard out from under every trigger pointing at it.
    const r = await check({
      file: "9030_replace_live_guard_fn.sql",
      sql: "CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN OLD; END; $fn$;",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("GUARD FUNCTION rm_append_only_guard");
  });

  test("RED: defining a guard function then REPLACING it later in the same release fails", async () => {
    const r = await check(
      {
        file: "9031_defines.sql",
        sql: "CREATE FUNCTION rm_late_defined_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'no'; END; $fn$;",
      },
      {
        file: "9032_replaces.sql",
        sql: "CREATE OR REPLACE FUNCTION rm_late_defined_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN OLD; END; $fn$;",
      },
    );
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("9032_replaces.sql: GUARD FUNCTION rm_late_defined_guard");
  });

  test("RED: DROP FUNCTION of a guard always fails — you cannot drop what was never there", async () => {
    const r = await check({
      file: "9033_drop_guard_fn.sql",
      sql: "DROP FUNCTION IF EXISTS rm_consensus_receipt_immutable();",
    });
    expect(r.status).toBe("FAIL");
    expect(r.detail.join("\n")).toContain("GUARD FUNCTION");
  });

  // ── And the real thing ────────────────────────────────────────────────────

  // NOTE. The REAL migration set is graded in the end-to-end block below, not
  // here. It has to be: this describe runs against the suite's database, which
  // is FULLY MIGRATED — 0042 is applied, so `rm_consensus_receipt_immutable()`
  // already exists and 0042's own `CREATE OR REPLACE FUNCTION` reads as
  // replacing a live guard. That is the correct answer to the question asked,
  // and the wrong question: a preflight grades a database that has NOT had this
  // release applied, and one that had would fail `schema-migrations` first. The
  // v0.2.2 baseline below is the only honest premise for the real set.

  test("the guard-installation map derived from the REAL migrations is exact", () => {
    // The ordering above is only trustworthy if this map is. Pinned against the
    // files rather than asserted in prose, and covering both shapes the repo
    // uses: a static CREATE TRIGGER (0038's snapshot-run pair) and a DO block
    // that builds the trigger with format() over an ARRAY of table names
    // (0037, 0038's constituent guards, 0040).
    const expected: Record<string, string[]> = {
      "0037_aum_repairable_quarantine.sql": ["wallet_balance_sample_evidence", "wallet_sleeve_sample_evidence"],
      "0038_wallet_aum_snapshot_foundation.sql": [
        "wallet_aum_snapshot_runs",
        "wallet_balance_sample_evidence",
        "wallet_balance_samples",
        "wallet_sleeve_sample_evidence",
        "wallet_sleeve_samples",
      ],
      "0040_swarm_judgements_append_only.sql": ["swarm_session_judgements"],
      // 0042 installs its guard pair statically (`CREATE TRIGGER
      // swarm_consensus_receipts_immutable … ON swarm_consensus_receipts`) AND
      // names the table in a DO block's `protected text[]` — both branches see
      // it, and the set dedupes to one entry.
      "0042_swarm_consensus_receipts.sql": ["swarm_consensus_receipts"],
    };
    const actual: Record<string, string[]> = {};
    for (const file of THIS_RELEASE_MIGRATIONS) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const tables = [...guardedTablesInstalledBy(sql)].sort();
      if (tables.length > 0) actual[file] = tables;
    }
    expect(actual).toEqual(expected);
  });

  test("the guard-missing and guard-gone failures are unchanged", async () => {
    const notApplied = createChecker("");
    await checkAppendOnlySafety(db, notApplied, new Set(), async () => []);
    expect(notApplied.results[0]!.status).toBe("FAIL");
    expect(notApplied.results[0]!.detail[0]).toContain(APPEND_ONLY_MIGRATION);
  });
});

describe("scanMigrationSql — the units behind the check", () => {
  const PROTECTED = new Set(["swarm_members"]);

  test("a row removal from an UNPROTECTED table is reported but does not block", () => {
    const f = scanMigrationSql("x.sql", "DELETE FROM wallet_backfill_state WHERE status = 'exhausted';", PROTECTED);
    expect(f).toEqual([{ file: "x.sql", kind: "DELETE", target: "wallet_backfill_state", blocking: false }]);
  });

  test("schema qualification and ONLY do not hide the table", () => {
    const f = scanMigrationSql("x.sql", 'DELETE FROM ONLY public."swarm_members" WHERE true;', PROTECTED);
    expect(f).toEqual([{ file: "x.sql", kind: "DELETE", target: "swarm_members", blocking: true }]);
  });

  test("dynamic SQL is the documented blind spot, not an accident", () => {
    // Stated in preflight.ts's header block and executed here so the limit
    // cannot be quietly lost: migration 0040 rebuilds append-only triggers with
    // EXECUTE format(...), and this scanner sees a string literal.
    const f = scanMigrationSql(
      "x.sql",
      "DO $$ BEGIN EXECUTE format('DELETE FROM %I', 'swarm_members'); END $$;",
      PROTECTED,
    );
    expect(f).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// END TO END. The whole preflight, against a database built to the real v0.2.2
// baseline, asserting the exit code the operator will actually see.
//
// THE BASELINE. `backend/migrations` minus `THIS_RELEASE_MIGRATIONS` is exactly
// the 41 files `git archive v0.2.2 backend/migrations` produces, byte for byte —
// migrations are append-only artefacts, so nothing v0.2.2 shipped has changed
// since. It is built that way rather than from the tag because
// `actions/checkout@v4` fetches no tags, so a `git archive v0.2.2` here would
// pass locally and fail in CI. It is also self-maintaining: a migration added
// to the release roster leaves the baseline alone, and one added WITHOUT being
// declared is caught by rollout-steps-0-3-0.test.ts's drift guard.
// ─────────────────────────────────────────────────────────────────────────────

describe("v0.3.0 preflight, end to end on a v0.2.2 baseline database", () => {
  let admin: ReturnType<typeof postgres>;
  let baselineDb: Db;
  let dbName: string;

  beforeAll(async () => {
    admin = postgres(DB_URL, { max: 1, onnotice: () => {} });
    dbName = `tmp_preflight_v022_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await admin.unsafe(`CREATE DATABASE ${dbName}`);

    const url = new URL(DB_URL);
    url.pathname = `/${dbName}`;
    baselineDb = postgres(url.toString(), { max: 1, onnotice: () => {} });

    const release = new Set<string>(THIS_RELEASE_MIGRATIONS);
    const baseline = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql") && !release.has(f)).sort();
    expect(baseline.length).toBeGreaterThan(0);

    // Byte-for-byte the runner's own loop (src/db/migrate.ts:39-53): filename
    // order, one transaction per file, the full basename as the ledger key.
    await baselineDb`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    for (const file of baseline) {
      const ddl = await readFile(join(migrationsDir, file), "utf8");
      await baselineDb.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
    }

    // The two schedules `seed()` maintains on every boot (src/db/seed.ts:67-68).
    // They are rows, not DDL, so replaying the migrations alone would leave
    // job_schedules empty — and `catchup-baseline` would WARN that the two kinds
    // 0034 rewrites are absent, which is true of this database and false of the
    // production one it stands in for. Seeded here so the run below produces the
    // exact warning set the runbook §6.2 tells the operator to expect: one, on
    // schema-migrations.
    await baselineDb`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled, next_run_at)
      VALUES ('wallet.sample_balances', '* * * * *', '{}'::jsonb, 'UTC', true, now() + interval '1 minute'),
             ('wallet.sample_sleeves',  '* * * * *', '{}'::jsonb, 'UTC', true, now() + interval '1 minute')
    `;
  }, 120_000);

  afterAll(async () => {
    await baselineDb?.end({ timeout: 5 });
    if (dbName) await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end({ timeout: 5 });
  });

  test("the baseline really is v0.2.2: every prior-release migration is applied, none of this release's is", async () => {
    const rows = (await baselineDb`SELECT name FROM schema_migrations`) as unknown as { name: string }[];
    const applied = new Set(rows.map((r) => r.name));
    for (const m of PRIOR_RELEASE_MIGRATIONS) expect({ m, applied: applied.has(m) }).toEqual({ m, applied: true });
    for (const m of THIS_RELEASE_MIGRATIONS) expect({ m, applied: applied.has(m) }).toEqual({ m, applied: false });
  });

  test("append-only-safety PASSes and the run exits 0", async () => {
    const checker = createChecker("");
    await runChecks(baselineDb, checker);

    const byName = new Map(checker.results.map((r) => [r.name, r]));
    const appendOnly = byName.get("append-only-safety")!;
    expect({ name: "append-only-safety", status: appendOnly.status }).toEqual({
      name: "append-only-safety",
      status: "PASS",
    });

    // …and the PASS is non-vacuous. This release DOES issue row removals — 0036
    // on wallet_backfill_state, 0037 on both sample tables — and each lands in
    // the bucket that is TRUE of it. A PASS listing nothing would mean the scan
    // is not reading the files.
    const detail = appendOnly.detail.join("\n");
    const unguardedLine = appendOnly.detail.find((l) => l.includes("no guard covers")) ?? "";
    expect(unguardedLine).toContain("wallet_backfill_state");
    // 0038 guards both sample tables LATER in this same release, so neither may
    // ever appear in the unguarded bucket — that string was the operator-facing
    // lie this check exists to remove.
    expect(unguardedLine).not.toContain("wallet_balance_samples");
    expect(unguardedLine).not.toContain("wallet_sleeve_samples");
    expect(detail).toContain("run BEFORE this release installs the guard");
    expect(detail).toContain("0037_aum_repairable_quarantine.sql: DELETE wallet_balance_samples");
    expect(detail).toContain("0037_aum_repairable_quarantine.sql: DELETE wallet_sleeve_samples");
    expect(detail).toContain("guarded from 0038_wallet_aum_snapshot_foundation.sql");
    // 0042's idempotent install idiom is seen and reported, not silently ignored.
    expect(detail).toContain("dropped and re-created by the SAME migration");
    // And the two false positives that used to BLOCK the release are reported as
    // what they are: locked, not written.
    expect(detail).toContain("swarm_members");
    expect(detail).toContain("swarm_sessions");

    // `schema-migrations` is legitimately WARN, not PASS: this release adds a
    // second `0032_`, which sorts before the newest already-applied file. WARN
    // is non-blocking in printVerdict — see the runbook §6.2.
    expect({ name: "schema-migrations", status: byName.get("schema-migrations")!.status }).toEqual({
      name: "schema-migrations",
      status: "WARN",
    });

    // No check may FAIL: that, and only that, is what makes the exit code 0.
    expect(checker.results.filter((r) => r.status === "FAIL").map((r) => `${r.name}: ${r.detail[0]}`)).toEqual([]);

    // And EXACTLY the one warning §6.2 documents — a second one would mean the
    // baseline is not the shape v0.2.2 leaves behind.
    expect(checker.results.filter((r) => r.status === "WARN").map((r) => r.name)).toEqual(["schema-migrations"]);

    const exit = printVerdict(checker.results, {
      logPrefix: "",
      okAll: "VERDICT: SAFE TO UPGRADE",
      okWithWarnings: "VERDICT: SAFE TO UPGRADE",
      blocked: "VERDICT: BLOCKED",
    });
    expect({ exit }).toEqual({ exit: 0 });
  }, 60_000);
});
