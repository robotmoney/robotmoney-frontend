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

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type CheckResult, createChecker, printVerdict } from "../scripts/lib/checks.ts";
import type { Db } from "../scripts/lib/preflight-utils.ts";
import {
  checkAppendOnlySafety,
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

  test("GREEN: disabling a trigger that is NOT the guard passes", async () => {
    const r = await check({
      file: "9008_disable_unrelated_trigger.sql",
      sql: "ALTER TABLE wallet_balance_samples DISABLE TRIGGER wallet_balance_samples_snapshot_final_guard;",
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

  // ── And the real thing ────────────────────────────────────────────────────

  test("the REAL v0.3.0 migration set passes, and the scan is visibly non-vacuous", async () => {
    const checker = createChecker("");
    await checkAppendOnlySafety(db, checker, GUARD_APPLIED);
    const r = checker.results.find((x) => x.name === "append-only-safety")!;
    expect(r.status).toBe("PASS");
    const detail = r.detail.join("\n");
    // 0036 deletes from wallet_backfill_state; 0037 deletes from both sample
    // tables. The scanner FINDS all three — that is what makes its PASS mean
    // something — and none of the three targets is protected.
    expect(detail).toContain("wallet_backfill_state");
    expect(detail).toContain("wallet_balance_samples");
    expect(detail).toContain("wallet_sleeve_samples");
    // And the two false positives that used to block the release are reported
    // as what they are: locked, not written.
    expect(detail).toContain("swarm_members");
    expect(detail).toContain("swarm_sessions");
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

    // `schema-migrations` is legitimately WARN, not PASS: this release adds a
    // second `0032_`, which sorts before the newest already-applied file. WARN
    // is non-blocking in printVerdict — see the runbook §6.2.
    expect({ name: "schema-migrations", status: byName.get("schema-migrations")!.status }).toEqual({
      name: "schema-migrations",
      status: "WARN",
    });

    // No check may FAIL: that, and only that, is what makes the exit code 0.
    expect(checker.results.filter((r) => r.status === "FAIL").map((r) => `${r.name}: ${r.detail[0]}`)).toEqual([]);

    const exit = printVerdict(checker.results, {
      logPrefix: "",
      okAll: "VERDICT: SAFE TO UPGRADE",
      okWithWarnings: "VERDICT: SAFE TO UPGRADE",
      blocked: "VERDICT: BLOCKED",
    });
    expect({ exit }).toEqual({ exit: 0 });
  }, 60_000);
});
