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

/** The roles whose READ access is repaired and defaulted by 0062. Writes stay
 *  fail-closed for all of them (0053's rule), so only SELECT is asserted. */
const READERS = ["rm_readonly", "rm_app", "rm_worker"] as const;

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

  test("0062 drops rm_readonly_test, and guards the drop so a boot cannot fail on it", () => {
    // DROP ROLE needs CREATEROLE. 0053 sets rm_owner NOCREATEROLE and
    // migrate.ts runs every migration from 0054 on as rm_owner, so an
    // unguarded DROP would fail the deploy. The exception handler is what lets
    // one file serve both paths: the provisioning script (doadmin) performs
    // the drop, the boot skips it with a notice.
    const sql = readFileSync(join(MIGRATIONS, "0062_rm_readonly_sequence_select.sql"), "utf8");
    expect(sql).toMatch(/DROP ROLE rm_readonly_test/);
    expect(sql).toMatch(/DROP OWNED BY rm_readonly_test/);
    expect(sql).toMatch(/EXCEPTION\s+WHEN\s+insufficient_privilege\s+THEN/i);
    // The DROP must be inside the guard, never a bare top-level statement.
    const bare = sql.split("\n").filter((l) => /^\s*DROP (ROLE|OWNED)/i.test(l));
    expect(bare).toEqual([]);
  });

  test("0062 repairs AND defaults SELECT for every reader role", () => {
    // The audit that prompted this found holes in all three, not just
    // rm_readonly: rm_worker was missing 16 tables (1,214 dead production jobs)
    // and rm_app one. A repair that fixed only the role that happened to be
    // noticed would have left the same bug live under two other names.
    const sql = readFileSync(join(MIGRATIONS, "0062_rm_readonly_sequence_select.sql"), "utf8");
    const flat = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
    for (const role of READERS) {
      const repaired = new RegExp(`GRANT SELECT ON ALL (TABLES|SEQUENCES) IN SCHEMA public TO [^;]*\\b${role}\\b`, "i").test(flat);
      const defaulted = new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT ON (TABLES|SEQUENCES) TO [^;]*\\b${role}\\b`, "i").test(flat);
      expect({ role, repaired, defaulted }).toEqual({ role, repaired: true, defaulted: true });
    }
  });

  test("0062's only write grant is the named-table allow-list that fixes the outage", () => {
    // NOT "0062 grants no writes" — an earlier version of this case asserted
    // exactly that, and it was wrong in a way that would have shipped a
    // migration which did not fix the incident it was written for. The live
    // failure is `permission denied for table asset_prices` at
    // writeAssetPrice() — an INSERT ... ON CONFLICT DO UPDATE, not a read.
    //
    // What must stay true is that writes are NAMED, never blanket: 0053's rule
    // is that every runtime write capability is spelled out by a migration, so
    // a missing grant fails closed instead of being silently covered.
    const sql = readFileSync(join(MIGRATIONS, "0062_rm_readonly_sequence_select.sql"), "utf8");
    const flat = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
    const WRITE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|USAGE)\b/i;

    for (const stmt of flat.match(/(GRANT|ALTER DEFAULT PRIVILEGES)[^;]*;/gi) ?? []) {
      // The guarded loop's EXECUTE format(...) is the named-table grant; it is
      // not a top-level GRANT statement and is checked by its own case above.
      if (!WRITE.test(stmt)) continue;
      // A write may not be granted over ALL objects...
      expect({ stmt: stmt.trim(), blanket: /ON ALL (TABLES|SEQUENCES)/i.test(stmt) })
        .toEqual({ stmt: stmt.trim(), blanket: false });
      // ...nor as a default, which would cover tables nobody has reviewed.
      expect({ stmt: stmt.trim(), viaDefault: /ALTER DEFAULT PRIVILEGES/i.test(stmt) })
        .toEqual({ stmt: stmt.trim(), viaDefault: false });
    }
  });

  test("the write grant covers every table production proved rm_worker needs", () => {
    // Taken from the empirical oracle — the distinct `permission denied for
    // table X` values in jobs.last_error across the whole incident — not from
    // grepping the source, which was too noisy to trust. asset_price_floors is
    // the one code-evidence addition: asset-prices.ts:152 writes it from the
    // same function that dies at line 116, so it has never been reached, and
    // granting only the observed two would move the outage rather than end it.
    const sql = readFileSync(join(MIGRATIONS, "0062_rm_readonly_sequence_select.sql"), "utf8");
    const flat = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
    // The grant is issued from a guarded loop, not a bare statement — a plain
    // `GRANT ... ON asset_prices` aborts the migration on any database built
    // to an earlier baseline. So the table list is read from the loop's array.
    const loop = (flat.match(/FOREACH t IN ARRAY ARRAY\[[^\]]*\]/i) ?? [""])[0];
    for (const t of ["asset_prices", "asset_price_floors", "chain_address_floors"]) {
      expect({ table: t, granted: loop.includes(`'${t}'`) }).toEqual({ table: t, granted: true });
    }
    expect(flat).toMatch(/GRANT INSERT, UPDATE ON public\.%I TO rm_worker/i);
    // DELETE is deliberately absent: nothing deletes from these three.
    expect(loop).not.toMatch(/\bDELETE\b/i);
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
