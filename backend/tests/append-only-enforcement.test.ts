// APPEND-ONLY ENFORCEMENT (the historical record is immutable).
//
// The swarm record is meant to behave like a chain: a published take, memo,
// session or member is history, and history is not editable by deletion. Until
// now that was CONVENTION only — `resetSessions()` was removed by hand
// (swarm/domain.ts:1219) with a comment saying "Nothing wipes rows any more",
// and nothing in the database stopped the next caller from re-adding it.
// Convention is not an invariant; a trigger is.
//
// These tests prove the DATABASE refuses, not that the application declines to
// ask. They run against the fresh ephemeral Postgres tests/preload.ts creates
// per run (never a reused database), so a pass here is a property of the
// migrated schema and nothing else.
import { expect, test, describe } from "bun:test";
import { sql } from "../src/db/client.ts";

/**
 * Tables holding the immutable record. A row here is a historical fact:
 * signed takes and the memos they cite, the sessions that produced them, the
 * members who authored them, the audit trail, the analytics series other
 * numbers are derived from, and the migration ledger itself.
 *
 * NOT listed, and each for a stated reason — this list is the spec, so an
 * exclusion has to justify itself here rather than be silently absent:
 *
 *  - `admin_session`, `admin_webauthn_challenge`, `swarm_claim_challenges`:
 *    ephemeral auth state whose PURPOSE is to be consumed or expire. A
 *    WebAuthn challenge that cannot be deleted is a replay window.
 *  - `swarm_member_keys`: rotated on re-registration (swarm/domain.ts).
 *  - `jobs`, `job_runs`, `job_schedules`: queue/coordination churn.
 *  - `raw_indicator_history`: re-derivable from its external sources, and it
 *    has a live repair path that deletes calendar-invalid rows —
 *    `verifySeedProvenance(db, clean = true)`
 *    (analytics/store/seed-provenance.ts:59), a documented one-time
 *    production cleanup. Protecting this table breaks that tool, and the data
 *    it holds can be re-fetched; signed takes cannot.
 *
 * Extending the list is one edit here plus one line in the migration — if the
 * boundary should move, move it deliberately.
 */
export const APPEND_ONLY_TABLES = [
  "swarm_members",
  "swarm_recommendations",
  "swarm_memos",
  "swarm_sessions",
  "swarm_briefs",
  "swarm_subjects",
  "swarm_session_events",
  "swarm_applications",
  "audit_log",
  "agent_activity_log",
  "regime_snapshots",
  "schema_migrations",
] as const;

describe("append-only: the database refuses row deletion", () => {
  for (const table of APPEND_ONLY_TABLES) {
    test(`DELETE on ${table} is rejected`, async () => {
      // A DELETE that matches NOTHING must still be refused: the guard is on
      // the operation, not on whether it happened to find a row. Anything
      // narrower can be walked past with a WHERE clause that matches later.
      let raised: string | null = null;
      try {
        await sql.unsafe(`DELETE FROM ${table} WHERE false`);
      } catch (e) {
        raised = e instanceof Error ? e.message : String(e);
      }
      expect(raised, `DELETE FROM ${table} WHERE false must raise`).not.toBeNull();
      expect(raised).toMatch(/append-only|not permitted|immutable/i);
    });

    test(`TRUNCATE on ${table} is rejected`, async () => {
      let raised: string | null = null;
      try {
        await sql.unsafe(`TRUNCATE TABLE ${table}`);
      } catch (e) {
        raised = e instanceof Error ? e.message : String(e);
      }
      expect(raised, `TRUNCATE ${table} must raise`).not.toBeNull();
      expect(raised).toMatch(/append-only|not permitted|immutable|cannot truncate/i);
    });
  }

  test("the guard survives a session that claims to be a replica", async () => {
    // session_replication_role='replica' is what a restore or a logical-apply
    // runs as, and it silently skips ordinary triggers. 0031 already learned
    // this lesson for the handle namespace (ENABLE ALWAYS); the append-only
    // guard has to hold under the same condition or a restore can erase
    // history without raising.
    let raised: string | null = null;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.unsafe("DELETE FROM swarm_recommendations WHERE false");
      });
    } catch (e) {
      raised = e instanceof Error ? e.message : String(e);
    }
    expect(raised, "a replica-role session must not bypass the guard").not.toBeNull();
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
