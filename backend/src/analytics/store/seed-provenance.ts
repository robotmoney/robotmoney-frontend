// Store stage: one-time production verification/cleanup for the raw floor
// seed's provenance (issue #616 / D6). The vendored seed historically embedded
// calendar-invalid rows — fabricated observations on dates a source could
// never publish (docs/code-review/20260814-review-data-integrity-macro-index-
// discrepancy.md). applyRawFloorSeed's DB-rows-win gap fill means a database
// seeded BEFORE the #616 purge regeneration landed may still carry those
// rows, tagged source='seed' (issue #397 provenance). This module finds them
// and, on request, deletes exactly those rows — never touching genuine
// live-tagged rows or calendar-valid seed rows.
//
// API-OWNED (issue #106): SQL access lives here so migration/operator tooling
// (backend/scripts/seed-provenance-verify.ts) can call it without any
// analytics/** updater module gaining direct DB access.
import { sql, type DbHandle } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { validateFloorCalendar } from "../extract/floor-seed-calendar.ts";
import type { RawIndicatorHistory } from "../types.ts";

export interface SeedProvenanceRow {
  indicatorId: string;
  date: string;
  value: number;
}

// Both statements are registered queries (smoke-production-spec.md §7.1). The
// operator CLI reaches them directly and through prod-bootstrap's
// seed-provenance:verify step. Both run as `rm_owner`: prod-bootstrap migrates
// on the same credential, and backend/schema/grants.sql gives `rm_app` no
// DELETE on ordinary tables, so the --clean DELETE is an owner's statement.
const CALLERS = ["scripts/seed-provenance-verify", "scripts/prod-bootstrap"];

const loadSeedRows = registerQuery({
  role: "rm_owner",
  object: "raw_indicator_history",
  privileges: ["SELECT"],
  site: "src/analytics/store/seed-provenance:loadSeedTaggedFloor",
  purpose: "Read every source='seed' floor row so the calendar validator can find fabricated dates.",
  callers: CALLERS,
  probe: {
    statement: `SELECT indicator, date::text AS date, value FROM raw_indicator_history
      WHERE source = 'seed' ORDER BY indicator, date`,
  },
});

const deleteInvalidSeedRow = registerQuery({
  role: "rm_owner",
  object: "raw_indicator_history",
  // SELECT because the WHERE and RETURNING read the row.
  privileges: ["DELETE", "SELECT"],
  site: "src/analytics/store/seed-provenance:verifySeedProvenance.clean",
  purpose: "Delete one calendar-invalid source='seed' row on an operator's --clean, never a live-tagged one.",
  callers: CALLERS,
  probe: {
    statement: `DELETE FROM raw_indicator_history
      WHERE indicator = $1 AND date = $2::date AND source = 'seed'
      RETURNING indicator`,
    params: ["probe_indicator", "2026-01-01"],
  },
});

// Load every source='seed' row, grouped for the calendar validator.
async function loadSeedTaggedFloor(db: DbHandle): Promise<RawIndicatorHistory> {
  const rows = await on(db, loadSeedRows)<{ indicator: string; date: string; value: number }>`
    SELECT indicator, date::text AS date, value
    FROM raw_indicator_history
    WHERE source = 'seed'
    ORDER BY indicator, date`;
  const out: RawIndicatorHistory = {};
  for (const r of rows) (out[r.indicator] ??= []).push({ date: r.date, value: Number(r.value) });
  return out;
}

export interface VerifyResult {
  invalid: SeedProvenanceRow[]; // calendar-invalid source='seed' rows found
  deleted: number; // rows actually deleted (only nonzero when clean=true)
}

// Scan production's source='seed' rows for calendar-invalid dates. With
// clean=true, delete exactly those (indicator,date) rows (source='seed' only
// — a live-tagged row on the same date is never touched) and return the
// deleted count; with clean=false (default), report only. The DB is
// untouched either way when `invalid` is empty.
export async function verifySeedProvenance(db: DbHandle = sql, clean = false): Promise<VerifyResult> {
  const seedFloor = await loadSeedTaggedFloor(db);
  const violations = validateFloorCalendar(seedFloor);
  const invalid: SeedProvenanceRow[] = violations.map((v) => ({
    indicatorId: v.indicatorId,
    date: v.date,
    value: seedFloor[v.indicatorId].find((p) => p.date === v.date)!.value,
  }));

  let deleted = 0;
  if (clean) {
    for (const row of invalid) {
      const res = await on(db, deleteInvalidSeedRow)<{ indicator: string }>`
        DELETE FROM raw_indicator_history
        WHERE indicator = ${row.indicatorId} AND date = ${row.date} AND source = 'seed'
        RETURNING indicator`;
      deleted += res.length;
    }
  }
  return { invalid, deleted };
}
