// Issue #345: /regime and /committee on staging were serving rows dated ~9
// months in the future (regime "As of 2027-04-25"; 21 committee sessions dated
// April 2027). Root cause: scripts/lib/demo-schedule.ts's sessionDateFor()
// derived each committee session's (and, via runRegimeClassify, each regime
// snapshot's) date by walking FORWARD from the wall clock — a demo that never
// tears down (the standing --stage deployment) has no bound on how many runs
// accumulate, so the offset eventually crossed into the real future. Fixed
// there by walking backward instead (see that file's doc for the exact
// argument); THIS file is the durable, DB-level invariant the issue itself
// specified: no seeded or classified row in either table may ever carry a
// date after "now", proven non-vacuous by a planted violation so the guard
// cannot silently rot into a no-op.
//
// Runs against the REAL (ephemeral) Postgres provisioned by tests/preload.ts
// (loud-fail, not skip, when Docker/Postgres is unavailable — test-coverage
// policy) and cleans up only the marker rows it plants, so it never disturbs
// fixtures other test files in this shared database rely on.
import { afterEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";

// A subject id no other test uses, so cleanup can be scoped precisely instead
// of touching the whole (shared, cross-file) committee_sessions table.
const MARKER_SUBJECT = "__issue345_future_marker__";
const FUTURE_DATE = "2099-01-01";

afterEach(async () => {
  await sql`DELETE FROM committee_sessions WHERE subject_id = ${MARKER_SUBJECT}`;
  await sql`DELETE FROM committee_subjects WHERE id = ${MARKER_SUBJECT}`;
  await sql`DELETE FROM regime_snapshots WHERE date = ${FUTURE_DATE}`;
});

interface NewestRow {
  t: string;
  newest: string | null;
}

// Exactly the two-table comparison the issue's own scope specifies, adjusted
// to this schema's real column name (`date` on both tables, not
// `session_date` / `sampled_at`).
const newestDates = () =>
  sql<NewestRow[]>`
    SELECT 'committee_sessions' AS t, max(date)::text AS newest FROM committee_sessions
    UNION ALL
    SELECT 'regime_snapshots'  AS t, max(date)::text AS newest FROM regime_snapshots
  `;

test("no seeded or classified committee_sessions/regime_snapshots row is ever dated in the future", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await newestDates();
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    expect(r.newest === null || r.newest <= today).toBe(true);
  }
});

test("red control: a planted future-dated row in EITHER table registers as a violation (the guard above is not vacuous)", async () => {
  const today = new Date().toISOString().slice(0, 10);
  expect(FUTURE_DATE > today).toBe(true); // sanity: the marker really is in the future from any real clock

  // committee_sessions.subject_id FKs to committee_subjects — plant the parent
  // row too, under the same marker id, so this insert is a genuinely valid row
  // rather than one that would fail for an unrelated reason.
  await sql`INSERT INTO committee_subjects (id, name) VALUES (${MARKER_SUBJECT}, 'issue #345 future-date control')`;
  await sql`
    INSERT INTO committee_sessions (date, subject_id, subject_name, state)
    VALUES (${FUTURE_DATE}, ${MARKER_SUBJECT}, 'issue #345 future-date control', 'scheduled')`;
  await sql`INSERT INTO regime_snapshots (date) VALUES (${FUTURE_DATE})`;

  const rows = await newestDates();
  const byTable = Object.fromEntries(rows.map((r) => [r.t, r.newest]));
  // What the production guard test above would see with these rows present:
  // both newest dates now compare AFTER today, i.e. the assertion it makes
  // (`newest <= today`) would fail — confirming the guard actually detects
  // this exact failure mode rather than passing regardless of the data.
  expect(byTable.committee_sessions! > today).toBe(true);
  expect(byTable.regime_snapshots! > today).toBe(true);
});
