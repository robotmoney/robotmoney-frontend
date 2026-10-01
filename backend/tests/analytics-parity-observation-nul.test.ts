// A raw_indicator_history parity observation whose mismatch keys carry the
// in-memory NUL separator must still be recorded. Postgres jsonb refuses
// \u0000, and before this fix every such observation failed to insert and
// analytics.parity_sweep died (production, 2026-09-23/25).
import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { recordParityObservation } from "../src/analytics/cutover/parity.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const HEX = "a".repeat(64);

test("a mismatch whose natural key holds a NUL is recorded, with a visible separator", async () => {
  const id = await recordParityObservation({
    domain: "raw_indicator_history",
    legacyRowCount: 2,
    ledgerRowCount: 2,
    legacyChecksum: HEX,
    ledgerChecksum: "b".repeat(64),
    matched: false,
    mismatches: [{ naturalKey: "XLP_XLY\u00002026-03-19", reason: "canonical value differs between compatibility and ledger" }],
  });
  const [row] = await sql`SELECT detail FROM analytics_parity_observations WHERE id = ${id}`;
  const key = (row!.detail as { mismatches: { naturalKey: string }[] }).mismatches[0]!.naturalKey;
  expect(key).toBe("XLP_XLY␟2026-03-19");
  expect(key.includes("\u0000")).toBe(false);
});
