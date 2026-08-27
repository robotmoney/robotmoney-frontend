// APPEND-ONLY ENFORCEMENT (the historical record is immutable).
//
// The swarm record is meant to behave like a chain: a published take, memo,
// session or member is history, and history is not editable by deletion. Until
// now that was CONVENTION only — `resetSessions()` was removed by hand
// (swarm/domain.ts:1219) with a comment saying "Nothing wipes rows any more",
// and nothing in the database stopped the next caller from re-adding it.
// Convention is not an invariant; a trigger is.
//
// WHAT THESE TESTS DO. For every table declared append-only, they put a real
// row in it and then ATTEMPT TO REMOVE IT — in each form the guard claims to
// cover — and prove that the removal is refused and the row is still there
// afterwards.
//
// WHY THE ASSERTIONS LOOK PEDANTIC. A refusal test is worthless if it can pass
// for a reason other than the thing under test. The first version of this file
// accepted `/…|cannot truncate/i` on the TRUNCATE cases — but
// `cannot truncate a table referenced in a foreign key constraint` is
// PostgreSQL's own RESTRICT cross-check, it carries the same SQLSTATE 0A000,
// and it fires BEFORE any `BEFORE TRUNCATE` statement trigger runs. Three of
// the twelve tables (`swarm_members`, `swarm_sessions`, `swarm_subjects`) have
// inbound foreign keys, so those cases passed on a stock-Postgres restriction
// and would have passed with migration 0032 deleted. Every assertion below now
// matches `rm_append_only_guard()`'s OWN message — table name and TG_OP — so a
// green result can only mean the trigger ran. Verified by neutering
// migrations/0032_append_only_history.sql and watching every case go red.
//
// They run against the fresh ephemeral Postgres tests/preload.ts creates per
// run, in a database cloned for this file alone, so a pass here is a property
// of the migrated schema and nothing else.
import { expect, test, describe, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { APPEND_ONLY_MIGRATIONS, APPEND_ONLY_TABLES, triggerNames } from "../src/db/append-only-guard.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

// Own database, cloned from the migrated template. This file SEEDS the
// protected tables and never cleans up after itself — deleting the fixture is
// the exact operation under test — so it must not do that in a database
// anybody else reads.
useCleanDatabase(import.meta.file);

/**
 * The protected set. Imported, never copied — the canonical list and the full
 * per-table reasoning (including why each sibling history table is protected or
 * deliberately excluded) live in src/db/append-only-guard.ts, next to the
 * runtime check that probes them. Migration 0032 carries its own copy because
 * an applied migration has to be self-contained SQL; the two are held in
 * agreement by an executed test below, not by prose.
 */
export { APPEND_ONLY_TABLES };


type Table = (typeof APPEND_ONLY_TABLES)[number];
type Raised = { message: string; code: string | null } | null;

// One round trip for the whole vector, so "the rows survived" can be asserted
// across EVERY protected table after each attempt — a TRUNCATE ... CASCADE
// that was refused on the named table but had already emptied a cascaded one
// would show up here and nowhere else.
const COUNT_ALL = APPEND_ONLY_TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(" UNION ALL ");

async function counts(): Promise<Record<string, number>> {
  const rows = (await sql.unsafe(COUNT_ALL)) as unknown as { t: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

async function attempt(statement: string): Promise<Raised> {
  try {
    await sql.unsafe(statement);
    return null;
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return { message: err?.message ?? String(e), code: err?.code ?? null };
  }
}

/**
 * The ONLY acceptable reason a removal attempt may fail: the guard itself said
 * no. `rm_append_only_guard()` interpolates the table name and TG_OP into its
 * message, so nothing else in PostgreSQL produces this string.
 */
function expectGuardRefused(raised: Raised, table: string, op: "DELETE" | "TRUNCATE", what: string): void {
  expect(raised, `${what} must raise`).not.toBeNull();
  expect(raised!.message, `${what} must be refused BY THE GUARD, not by anything else`).toMatch(
    new RegExp(`^table "${table}" is append-only: row deletion is not permitted \\(${op}\\)`),
  );
  // 0A000 = feature_not_supported. Asserted as a pair with the message, never
  // instead of it: Postgres's own TRUNCATE-RESTRICT refusal uses 0A000 too.
  expect(raised!.code).toBe("0A000");
}

// Tables with inbound foreign keys. `TRUNCATE t` (implicitly RESTRICT) on one
// of these is refused by heap_truncate_check_FKs() before the trigger stage is
// reached, so for them the plain form cannot be evidence about migration 0032
// — the CASCADE form, which removes that objection, is.
const fkParents = new Set<string>();

// One real row per protected table, so every "the data is still there"
// assertion below is about actual data. `schema_migrations` is already
// populated by the migration runner and is deliberately not touched.
const SUBJECT = "append-only-subject";
const MEMBER = "append-only-member";
let SESSION = "";

beforeAll(async () => {
  SESSION = crypto.randomUUID();
  await sql`INSERT INTO swarm_subjects (id, name) VALUES (${SUBJECT}, 'Append Only Subject')`;
  await sql`INSERT INTO swarm_sessions (id, subject_id) VALUES (${SESSION}, ${SUBJECT})`;
  await sql`INSERT INTO swarm_members (id, name, status) VALUES (${MEMBER}, 'Append Only Member', 'inactive')`;
  await sql`INSERT INTO swarm_briefs (date, subject_id, session_id) VALUES ('2031-01-02', ${SUBJECT}, ${SESSION})`;
  await sql`
    INSERT INTO swarm_recommendations (session_id, member_id, subject_id, date, nonce, stance, payload, signature)
    VALUES (${SESSION}, ${MEMBER}, ${SUBJECT}, '2031-01-02', 'append-only-nonce', 'neutral', '{}'::jsonb, 'sig')`;
  await sql`INSERT INTO swarm_memos (member_id, session_id, body) VALUES (${MEMBER}, ${SESSION}, 'memo body')`;
  await sql`
    INSERT INTO swarm_session_events (session_id, to_state, action, actor)
    VALUES (${SESSION}, 'scheduled', 'convene', 'append-only-test')`;
  // The attendance roster for that same session, and the portfolio state its
  // takes were made about — both added to the protected set in review, and both
  // seeded here so the "the rows survive" assertions below are about real data
  // rather than an empty table (which would pass for the wrong reason).
  await sql`
    INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status)
    VALUES (${SESSION}, ${MEMBER}, 'Append Only Member', 'append-only', 'expected')`;
  await sql`
    INSERT INTO swarm_subject_snapshots (subject_id, date, total_value_usd)
    VALUES (${SUBJECT}, '2031-01-02', 1234.5)`;
  // One consensus-judge run for that session (issue #752, protected by
  // migration 0040). Seeded like every other row here so the "it survived"
  // assertions below are about real data rather than an empty table.
  await sql`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, fallback_reason, prompt_hash, inputs_digest, take_count, min_takes, opinion)
    VALUES (${SESSION}, 'shadow', 'fallback', 'model_unconfigured', 'append-only-prompt-hash',
            'append-only-inputs-digest', 1, 3,
            '{"rationale":"append-only judgement","disagreements":[],"release_safety":{"release":"hold","thinly_supported":true,"take_count":1,"min_takes":3,"concerns":["seeded"]}}'::jsonb)`;
  await sql`INSERT INTO swarm_applications (payload) VALUES ('{}'::jsonb)`;
  await sql`INSERT INTO audit_log (actor, action) VALUES ('append-only-test', 'probe')`;
  await sql`INSERT INTO agent_activity_log (action_type, status) VALUES ('probe', 'success')`;
  await sql`INSERT INTO regime_snapshots (date) VALUES ('2031-01-02')`;

  const parents = (await sql`
    SELECT DISTINCT confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f'
  `) as unknown as { parent: string }[];
  for (const p of parents) fkParents.add(p.parent);
});

describe("append-only: every protected table holds data that cannot be removed", () => {
  test("the fixture actually seeded every protected table — an empty table proves nothing", async () => {
    const n = await counts();
    for (const table of APPEND_ONLY_TABLES) {
      expect(n[table], `${table} must hold at least one row before deletion is attempted`).toBeGreaterThan(0);
    }
  });

  test("BOTH guards are installed on every protected table, at the right level, as ENABLE ALWAYS", async () => {
    // TWO triggers per table, and the pair is the point (issue #684 round 2):
    //
    //   <t>_append_only      STATEMENT — catches TRUNCATE and `DELETE WHERE false`
    //   <t>_append_only_row  ROW       — catches a removal with NO STATEMENT
    //                                    behind it: a logical-replication apply
    //                                    (ExecSimpleRelationDelete) and a delete
    //                                    aimed at an inheritance parent.
    //
    // The first version of migration 0032 had only the statement-level one and
    // claimed, in its own header, to cover replication. It did not: a statement
    // trigger is never FIRED by an apply worker, so `ENABLE ALWAYS` never even
    // came into it. This test pins the level as well as the presence, because
    // "a trigger exists" was exactly the evidence that let the wrong one ship.
    //
    // tgenabled: 'O' = origin only (silently skipped under
    // session_replication_role='replica'), 'D' = disabled, 'R' = replica only,
    // 'A' = ALWAYS. Anything but 'A' is absent during the restore or apply that
    // would erase history. tgtype bit 0 set = FOR EACH ROW.
    const rows = (await sql`
      SELECT c.relname::text AS table_name, t.tgname::text AS trigger_name,
             t.tgenabled::text AS enabled, (t.tgtype & 1) = 1 AS is_row,
             p.proname::text AS function_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal
    `) as unknown as { table_name: string; trigger_name: string; enabled: string; is_row: boolean; function_name: string }[];
    const installed = new Map(rows.map((r) => [`${r.table_name}.${r.trigger_name}`, r]));
    for (const table of APPEND_ONLY_TABLES) {
      const names = triggerNames(table);
      const stmt = installed.get(`${table}.${names.statement}`);
      const row = installed.get(`${table}.${names.row}`);
      expect(stmt, `${table} must carry the STATEMENT-level append-only trigger`).toBeDefined();
      expect(row, `${table} must carry the ROW-level append-only trigger`).toBeDefined();
      expect(stmt!.is_row, `${names.statement} must be FOR EACH STATEMENT`).toBe(false);
      expect(row!.is_row, `${names.row} must be FOR EACH ROW`).toBe(true);
      expect(stmt!.enabled, `${names.statement} must be ENABLE ALWAYS`).toBe("A");
      expect(row!.enabled, `${names.row} must be ENABLE ALWAYS`).toBe("A");
      expect(stmt!.function_name).toBe("rm_append_only_guard");
      expect(row!.function_name).toBe("rm_append_only_guard");
    }
  });

  test("the migrations' protected arrays and src/db/append-only-guard.ts's list are the same set", () => {
    // A migration cannot import the constant — an applied migration is a frozen
    // artefact and its SQL has to be self-contained — so the copies are kept
    // honest here rather than by a comment asking someone to remember. A table
    // added to one and not the other is a table nobody protects.
    //
    // The set spans MORE THAN ONE migration since #752: 0032 installs
    // rm_append_only_guard() and the original set, and a table added later opts
    // in from its own file (editing 0032 would protect nothing on any database
    // that already ran it). Every declaring file is listed in
    // APPEND_ONLY_MIGRATIONS, and the UNION of their arrays is what must match.
    const inMigrations: string[] = [];
    for (const file of APPEND_ONLY_MIGRATIONS) {
      const ddl = readFileSync(join(import.meta.dir, "..", "migrations", file), "utf8");
      const block = ddl.match(/protected text\[\] := ARRAY\[([\s\S]*?)\];/);
      expect(block, `${file} must still declare its protected array in the shape this test reads`).not.toBeNull();
      const names = [...block![1]!.replace(/--.*$/gm, "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
      expect(names.length, `${file}'s array must not have been parsed as empty`).toBeGreaterThan(0);
      inMigrations.push(...names);
    }
    expect(new Set(inMigrations).size, "no table may be declared by two migrations").toBe(inMigrations.length);
    expect([...inMigrations].sort()).toEqual([...APPEND_ONLY_TABLES].sort());
  });

  test("a DELETE through an INHERITANCE PARENT is refused (the row-level trigger's other job)", async () => {
    // A parent-targeted DELETE produces no statement for the child, so the
    // statement-level trigger never fires and `DELETE 2` used to succeed
    // against a protected child with the guard completely silent (measured on
    // 17 and 18; TRUNCATE on the same parent WAS caught). Latent in this schema
    // — pg_inherits is empty after every migration — but it is the same
    // no-statement shape as a replication apply, and the row-level trigger
    // closes both. Built here rather than asserted about, because "no migration
    // uses INHERITS today" is a fact about today.
    await sql.unsafe(`CREATE TABLE rm_inherit_probe (LIKE audit_log)`);
    await sql.unsafe(`ALTER TABLE audit_log INHERIT rm_inherit_probe`);
    try {
      const before = await counts();
      const raised = await attempt(`DELETE FROM rm_inherit_probe`);
      // The refusal names the CHILD (TG_TABLE_NAME is where the row lives),
      // which is also the operator-useful answer.
      expectGuardRefused(raised, "audit_log", "DELETE", "DELETE via an inheritance parent");
      expect(await counts(), "a refused inherited DELETE must not have removed anything").toEqual(before);
    } finally {
      await sql.unsafe(`ALTER TABLE audit_log NO INHERIT rm_inherit_probe`);
      await sql.unsafe(`DROP TABLE rm_inherit_probe`);
    }
  });

  test("the refusal says WHICH trigger refused it, so the two are distinguishable in the field", async () => {
    // The primary message is byte-stable (every assertion in this repo pins it),
    // so the statement/row distinction rides in DETAIL. Without it, a report of
    // "0032 refused something" cannot tell you whether the half that only
    // matters under replication is actually working.
    let detail: string | null = null;
    try {
      await sql.unsafe(`DELETE FROM audit_log WHERE false`);
    } catch (e) {
      detail = (e as { detail?: string }).detail ?? null;
    }
    expect(detail).toMatch(/refused by trigger audit_log_append_only, STATEMENT level/);
  });

  for (const table of APPEND_ONLY_TABLES as readonly Table[]) {
    test(`DELETE FROM ${table} is refused and the rows survive`, async () => {
      const before = await counts();
      const raised = await attempt(`DELETE FROM ${table}`);
      expectGuardRefused(raised, table, "DELETE", `DELETE FROM ${table}`);
      expect(await counts(), "a refused DELETE must not have removed anything").toEqual(before);
    });

    test(`DELETE FROM ${table} WHERE false is refused (the OPERATION, not the match)`, async () => {
      // A DELETE that matches NOTHING must still be refused: the guard is on
      // the operation, not on whether it happened to find a row. Anything
      // narrower can be walked past with a WHERE clause that matches later.
      const before = await counts();
      const raised = await attempt(`DELETE FROM ${table} WHERE false`);
      expectGuardRefused(raised, table, "DELETE", `DELETE FROM ${table} WHERE false`);
      expect(await counts()).toEqual(before);
    });

    test(`TRUNCATE ${table} CASCADE is refused and the rows survive`, async () => {
      // CASCADE is the dangerous form AND the discriminating one: it removes
      // the foreign-key objection, so the guard is the only thing left that
      // can refuse. If migration 0032 were deleted this statement would empty
      // the table and its whole dependent closure.
      const before = await counts();
      const raised = await attempt(`TRUNCATE TABLE ${table} CASCADE`);
      expectGuardRefused(raised, table, "TRUNCATE", `TRUNCATE ${table} CASCADE`);
      expect(await counts(), "a refused TRUNCATE ... CASCADE must not have emptied anything").toEqual(before);
    });

    test(`TRUNCATE ${table} is refused and the rows survive`, async () => {
      const before = await counts();
      const raised = await attempt(`TRUNCATE TABLE ${table}`);
      expect(raised, `TRUNCATE ${table} must raise`).not.toBeNull();
      if (fkParents.has(table)) {
        // Assert the OTHER reason explicitly rather than let a permissive
        // pattern accept either: this branch is a statement about PostgreSQL,
        // not about the guard, and the CASCADE case above is what proves 0032
        // for these tables.
        expect(raised!.message).toMatch(/cannot truncate a table referenced in a foreign key constraint/);
      } else {
        expectGuardRefused(raised, table, "TRUNCATE", `TRUNCATE ${table}`);
      }
      expect(await counts()).toEqual(before);
    });

    test(`a replica-role session cannot delete from ${table}`, async () => {
      // WHAT THIS PROVES, PRECISELY: an ORDINARY SQL SESSION that has set
      // session_replication_role='replica' — `pg_restore --disable-triggers`,
      // and any hand-run psql that sets it — still cannot delete. That setting
      // silently skips ordinary ('O') triggers, so without ENABLE ALWAYS the
      // guard would be absent for exactly that session. 0031 learned this for
      // the handle namespace; it has to hold for EVERY table here.
      //
      // WHAT IT DOES NOT PROVE, and the distinction is the reason this whole
      // round-2 issue exists: it is NOT a logical-replication apply. An apply
      // WORKER shares the replica ROLE setting but not the mechanism — it
      // removes rows through ExecSimpleRelationDelete with NO STATEMENT behind
      // them, so a statement-level trigger is never fired at all, whatever its
      // tgenabled says. Reading this test as covering replication is what let
      // the row-level gap ship. The apply path is a different file:
      // tests/append-only-replication.test.ts, which builds a real
      // publisher/subscriber pair.
      const before = await counts();
      let raised: Raised = null;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL session_replication_role = 'replica'");
          await tx.unsafe(`DELETE FROM ${table}`);
        });
      } catch (e) {
        const err = e as { message?: string; code?: string };
        raised = { message: err?.message ?? String(e), code: err?.code ?? null };
      }
      expectGuardRefused(raised, table, "DELETE", `replica-role DELETE FROM ${table}`);
      expect(await counts()).toEqual(before);
    });
  }

  test("the exact statement this issue exists to prevent is refused", async () => {
    // `resetSessions()`, verbatim (swarm/domain.ts:1219 records its removal).
    // RESTART IDENTITY CASCADE is what makes it total: CASCADE strips the
    // foreign-key objection that would otherwise refuse it, so with migration
    // 0032 absent this one statement empties the takes, the briefs, the
    // sessions, and everything hanging off them.
    const before = await counts();
    const raised = await attempt(
      "TRUNCATE swarm_recommendations, swarm_briefs, swarm_sessions RESTART IDENTITY CASCADE",
    );
    expectGuardRefused(raised, "swarm_recommendations", "TRUNCATE", "resetSessions()'s TRUNCATE");
    expect(await counts(), "resetSessions() must not have emptied anything").toEqual(before);
  });

  test("INSERT and UPDATE still work — append-only, not read-only", async () => {
    // The invariant is "history is not erased", NOT "the table is frozen".
    // A guard that also blocked writes would break every normal flow, so prove
    // the allowed operations still pass.
    const id = `append-only-probe-${crypto.randomUUID()}`;
    await sql`INSERT INTO swarm_members (id, name, status) VALUES (${id}, 'Append Probe', 'inactive')`;
    await sql`UPDATE swarm_members SET name = 'Append Probe 2' WHERE id = ${id}`;
    const [row] = await sql`SELECT name FROM swarm_members WHERE id = ${id}`;
    expect(row.name).toBe("Append Probe 2");
    // Deliberately NOT cleaned up: this database is thrown away at the end of
    // the run, and deleting the probe is the exact operation under test.
  });
});

// ── DOCUMENTED RESIDUALS, EXECUTED ──────────────────────────────────────────
//
// Migration 0032's header states, in prose, what the guard does NOT stop. Prose
// decays; these run. Each test below asserts a LIMIT rather than a guarantee,
// which is unusual and deliberate: the failure mode this whole issue is about
// is a rationale that stopped being true without anyone noticing, and the
// header's replication claim was exactly that. If one of these ever goes red,
// the guard got STRONGER and the header is now understating it — fix the
// header, then delete the test.
describe("append-only: the limits the migration header claims, held to the same standard", () => {
  test("UPDATE can blank every column of every row — 'history rows are not removed' is the claim, not immutability", async () => {
    // The one that most easily gets over-read. A protected table can be emptied
    // of MEANING while its row count never changes, and nothing here detects
    // it. Stated in the header; asserted here so the statement is checkable.
    const id = `append-only-update-residual-${crypto.randomUUID()}`;
    await sql`INSERT INTO swarm_members (id, name, status) VALUES (${id}, 'Original Name', 'inactive')`;
    await sql`UPDATE swarm_members SET name = '', lens = NULL WHERE id = ${id}`;
    const [row] = await sql`SELECT name, lens FROM swarm_members WHERE id = ${id}`;
    expect(row.name).toBe("");
    expect(row.lens).toBeNull();
  });

  test("DELETE FROM jobs is permitted and BLANKS provenance on a protected row it never touched", async () => {
    // `jobs` is deliberately unprotected (queue churn), and it carries
    // ON DELETE SET NULL edges INTO protected tables. So the guard preserves
    // the audit row and loses the fact that row recorded about which job did
    // it. Demonstrated on the real schema rather than reasoned about, because
    // the edge is easy to add and easy to forget.
    const [job] = (await sql`
      INSERT INTO jobs (kind, payload) VALUES ('append-only.residual', '{}'::jsonb) RETURNING id
    `) as unknown as { id: number }[];
    const [entry] = (await sql`
      INSERT INTO audit_log (actor, action, job_id) VALUES ('append-only-test', 'provenance', ${job!.id})
      RETURNING id
    `) as unknown as { id: number }[];

    await sql`DELETE FROM jobs WHERE id = ${job!.id}`;

    const [after] = (await sql`SELECT job_id FROM audit_log WHERE id = ${entry!.id}`) as unknown as
      { job_id: number | null }[];
    expect(after!.job_id, "the audit row survives; the job it names does not, and the link is now NULL").toBeNull();
  });

  test("DROP TABLE is not a DELETE and is not a TRUNCATE — no trigger of either kind fires", async () => {
    // The bluntest bypass, and the reason the header refuses to call any of
    // this tamper-evidence. Run on a table this file creates, so the assertion
    // costs nothing: the point is that the OWNER can do it, not that audit_log
    // specifically is droppable.
    await sql.unsafe(`CREATE TABLE rm_drop_residual (LIKE audit_log)`);
    await sql.unsafe(
      `CREATE TRIGGER rm_drop_residual_append_only BEFORE DELETE OR TRUNCATE ON rm_drop_residual
       FOR EACH STATEMENT EXECUTE FUNCTION rm_append_only_guard()`,
    );
    await sql.unsafe(`ALTER TABLE rm_drop_residual ENABLE ALWAYS TRIGGER rm_drop_residual_append_only`);
    expect(await attempt(`DELETE FROM rm_drop_residual`), "the guard is genuinely armed on it").not.toBeNull();
    // …and it goes anyway.
    expect(await attempt(`DROP TABLE rm_drop_residual`)).toBeNull();
    const [{ gone }] = (await sql`SELECT to_regclass('public.rm_drop_residual') IS NULL AS gone`) as unknown as
      { gone: boolean }[];
    expect(gone).toBe(true);
  });

  test("protecting schema_migrations removes the migration-rollback lever", async () => {
    // Intended, and unmentioned until now: `DELETE FROM schema_migrations
    // WHERE name = '…'` is how you force a migration to re-run, and it now
    // raises. Forcing one requires dropping the trigger first.
    const raised = await attempt(`DELETE FROM schema_migrations WHERE name = '0001_init.sql'`);
    expectGuardRefused(raised, "schema_migrations", "DELETE", "the rollback lever");
  });
});
