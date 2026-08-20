// One-time production seed-provenance verify/cleanup (issue #616 / D6),
// against the SAME ephemeral Postgres the rest of the suite uses (per-PR CI,
// no network). Exercises the CLI script's exit-code contract directly.
import { test, expect, beforeEach } from "bun:test";
import { main, runSeedProvenanceVerify } from "../scripts/seed-provenance-verify.ts";
import { sql } from "../src/db/client.ts";
import { saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";

beforeEach(async () => {
  await sql`DELETE FROM raw_indicator_history WHERE indicator IN ('ICSA','DXY','T10Y2Y')`;
});

test("exits 0 on a clean DB (no calendar-invalid source='seed' rows)", async () => {
  await saveRawIndicatorHistory({ ICSA: [{ date: "2026-08-08", value: 209000 }] }, sql, "seed"); // Saturday — valid
  expect(await main([])).toBe(0);
});

test("exits non-zero and reports rows after inserting calendar-invalid source='seed' rows", async () => {
  await saveRawIndicatorHistory({ ICSA: [{ date: "2026-08-10", value: 215000 }] }, sql, "seed"); // Monday — INVALID
  expect(await main([])).toBe(1);
  // No --clean was passed — the invalid row is untouched.
  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM raw_indicator_history WHERE indicator = 'ICSA' AND source = 'seed'`;
  expect(n).toBe(1);
});

test("--clean deletes exactly the calendar-invalid seed rows, leaving valid seed and non-seed rows intact", async () => {
  await saveRawIndicatorHistory(
    {
      ICSA: [
        { date: "2026-08-08", value: 209000 }, // Saturday — valid, must SURVIVE
        { date: "2026-08-10", value: 215000 }, // Monday — INVALID, must be DELETED
      ],
    },
    sql,
    "seed",
  );
  // A live-tagged row on the SAME invalid date must survive — --clean only
  // ever touches source='seed' rows.
  await saveRawIndicatorHistory({ T10Y2Y: [{ date: "2026-08-10", value: 0.55 }] }, sql, "live");

  expect(await main(["--clean"])).toBe(0);

  const remaining = await sql`
    SELECT indicator, date::text AS date, source FROM raw_indicator_history
    WHERE indicator IN ('ICSA','T10Y2Y') ORDER BY indicator, date`;
  expect([...remaining]).toEqual([
    { indicator: "ICSA", date: "2026-08-08", source: "seed" },
    { indicator: "T10Y2Y", date: "2026-08-10", source: "live" },
  ]);
});

// Issue #638: this script previously had no production caller — only the CLI
// main() this test file already exercised above. The real caller is
// prod-bootstrap.ts's "seed-provenance:verify" step (tests/prod-bootstrap.test.ts
// covers that wiring end-to-end); this asserts the callable core itself,
// independent of main()'s console/exit-code CLI shell.
test("runSeedProvenanceVerify is a callable core, independent of the CLI's console/exit-code shell", async () => {
  await saveRawIndicatorHistory({ ICSA: [{ date: "2026-08-10", value: 215000 }] }, sql, "seed"); // Monday — INVALID

  const report = await runSeedProvenanceVerify(true);
  expect(report.invalid).toEqual([{ indicatorId: "ICSA", date: "2026-08-10", value: 215000 }]);
  expect(report.deleted).toBe(1);

  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM raw_indicator_history WHERE indicator = 'ICSA' AND source = 'seed'`;
  expect(n).toBe(0);
});
