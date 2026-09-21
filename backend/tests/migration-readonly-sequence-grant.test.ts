// A migration must never take sequence access away from rm_readonly.
//
// WHY THIS TEST IS THE REAL FIX. 0062 repairs the twelve sequences that
// 0056-0060 revoked, but a repair migration is worthless against a pattern:
// the next migration written from the same template revokes again, and the
// only symptom is that the NEXT release's backup gate fails, months later,
// far from the change that caused it. That is precisely how this reached
// production unnoticed -- nothing at runtime reads those sequences as
// rm_readonly, so no test, no boot and no page could see it. pg_dump is the
// sole consumer.
//
// THE RULE, stated once. rm_readonly is the BACKUP role
// (rollout-procedure.md §5.1). pg_dump reads every sequence's last_value.
// A role that can already SELECT a table's rows learns nothing new from that
// table's counter, so denying it is not a privilege boundary -- it is the same
// boundary spelled twice, once correctly and once as a denial that breaks the
// backup.
//
// Scanned as TEXT rather than executed, deliberately: the defect is in what a
// migration SAYS, and a migration already applied everywhere would never run
// again to be caught by a behavioural check.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

/** Migrations that already shipped this defect. 0062 repairs their effect;
 *  they stay on the list because rewriting an applied migration's bytes is
 *  worse than recording what it did. NOTHING MAY BE ADDED HERE -- a new entry
 *  means someone reintroduced the pattern and edited the test to pass. */
const GRANDFATHERED = new Set([
  "0056_analytics_overwrite_events.sql",
  "0057_source_acquisition_ledger.sql",
  "0058_analytics_run_ledger.sql",
  "0059_analytics_output_and_report_snapshots.sql",
  "0060_analytics_ledger_cutover.sql",
  // 0053 is the other half: it revokes the DEFAULT on sequences and restores
  // only the table default. 0062 restores the sequence default.
  "0053_database_role_taxonomy.sql",
]);

function sqlFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();
}

/** Every `REVOKE ... ON SEQUENCE ... FROM ...` statement, whitespace-folded so
 *  a multi-line list (0058, 0059) is matched as one statement. */
function sequenceRevokes(sql: string): string[] {
  const flat = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
  return flat.match(/REVOKE\s+[^;]*?\bON\s+(?:ALL\s+SEQUENCES|SEQUENCE)\b[^;]*?;/gi) ?? [];
}

describe("no migration may revoke sequence access from rm_readonly", () => {
  test("RED CONTROL: the matcher finds the statements that caused this", () => {
    // Guards the case below against passing because the regex matches nothing.
    const revokes = sequenceRevokes(readFileSync(join(MIGRATIONS, "0058_analytics_run_ledger.sql"), "utf8"));
    expect(revokes.length).toBeGreaterThan(0);
    expect(revokes.join(" ")).toContain("rm_readonly");
    // And that a multi-line statement is folded into ONE match, not five.
    expect(revokes.length).toBe(1);
  });

  test("no NEW migration strips rm_readonly's sequence access", () => {
    const offenders: string[] = [];
    for (const file of sqlFiles()) {
      if (GRANDFATHERED.has(file)) continue;
      for (const stmt of sequenceRevokes(readFileSync(join(MIGRATIONS, file), "utf8"))) {
        if (/\brm_readonly\b/i.test(stmt)) offenders.push(`${file}: ${stmt.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("0062 both repairs the existing sequences and restores the default", () => {
    // Two statements, two jobs. A repair without the default leaves the next
    // implicitly-created sequence unreadable; a default without the repair
    // leaves the twelve broken.
    const sql = readFileSync(join(MIGRATIONS, "0062_rm_readonly_sequence_select.sql"), "utf8");
    expect(sql).toMatch(/GRANT\s+SELECT\s+ON\s+ALL\s+SEQUENCES\s+IN\s+SCHEMA\s+public\s+TO\s+rm_readonly/i);
    expect(sql).toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+rm_owner\s+IN\s+SCHEMA\s+public\s+GRANT\s+SELECT\s+ON\s+SEQUENCES\s+TO\s+rm_readonly/i);
    expect(sequenceRevokes(sql)).toEqual([]);
  });

  test("the grandfather list is closed — every entry still exists and still offends", () => {
    // Stops the list rotting into a permanent exemption for files that no
    // longer need it, and stops it being padded with innocents.
    for (const file of GRANDFATHERED) {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      const offends =
        sequenceRevokes(sql).some((s) => /\brm_readonly\b/i.test(s)) ||
        /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*REVOKE[^;]*ON\s+SEQUENCES[^;]*rm_readonly/is.test(sql);
      expect({ file, offends }).toEqual({ file, offends: true });
    }
  });
});
