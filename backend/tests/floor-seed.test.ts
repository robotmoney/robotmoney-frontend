// Integration coverage for the cold-DB raw floor seed (issue #13), against the SAME
// ephemeral Postgres the rest of the suite uses (per-PR CI, no network). Proves the
// seed loader is:
//   • idempotent  — running twice writes the second time nothing (no-op once warm),
//   • append-only — pre-existing DB rows WIN on (date,indicator) overlap; the seed
//     only fills gaps (the honest mergeSeries floor semantics),
// using a tiny in-test CSV.gz so the assertions are exact (not the ~530 KB vendored
// fixture). A missing seed file must FAIL LOUDLY, never silent-skip.
import { test, expect, beforeEach } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRawFloorSeed } from "../src/analytics/store/floor-seed.ts";
import { loadRawFloorSeed } from "../src/analytics/extract/floor-seed.ts";
import { loadRawIndicatorHistory, saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";
import { sql } from "../src/db/client.ts";

// A tiny two-indicator seed CSV → gz file on disk.
function writeSeed(): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-floor-seed-"));
  const csv = [
    "date,indicator,value",
    "2020-01-01,AAA,1",
    "2020-01-02,AAA,2",
    "2020-01-03,AAA,3",
    "2020-01-01,BBB,10",
    "2020-01-02,BBB,20",
    "", // trailing newline
  ].join("\n");
  const path = join(dir, "seed.csv.gz");
  writeFileSync(path, gzipSync(Buffer.from(csv, "utf8")));
  return path;
}

beforeEach(async () => {
  await sql`DELETE FROM raw_indicator_history WHERE indicator IN ('AAA','BBB')`;
});

test("loadRawFloorSeed parses a gzipped date,indicator,value CSV", async () => {
  const path = writeSeed();
  try {
    const seed = await loadRawFloorSeed(path);
    expect(seed.AAA).toEqual([
      { date: "2020-01-01", value: 1 },
      { date: "2020-01-02", value: 2 },
      { date: "2020-01-03", value: 3 },
    ]);
    expect(seed.BBB.length).toBe(2);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("missing seed file fails loudly (never silent-skip)", async () => {
  await expect(loadRawFloorSeed("/nonexistent/seed.csv.gz")).rejects.toThrow(/floor seed not found/);
});

test("cold DB: seed writes every row; a second run is a no-op (idempotent)", async () => {
  const path = writeSeed();
  try {
    const first = await applyRawFloorSeed(await loadRawFloorSeed(path));
    expect(first.seededPoints).toBe(5); // 3 AAA + 2 BBB
    expect(first.existingPoints).toBe(0);
    expect(first.indicators).toBe(2);

    const afterFirst = await loadRawIndicatorHistory();
    expect(afterFirst.AAA.map((p) => p.value)).toEqual([1, 2, 3]);
    expect(afterFirst.BBB.map((p) => p.value)).toEqual([10, 20]);

    // Idempotent: second run finds every (date,indicator) present → writes nothing.
    const second = await applyRawFloorSeed(await loadRawFloorSeed(path));
    expect(second.seededPoints).toBe(0);
    expect(second.existingPoints).toBe(5);

    const afterSecond = await loadRawIndicatorHistory();
    expect(afterSecond.AAA.map((p) => p.value)).toEqual([1, 2, 3]);
    expect(afterSecond.BBB.map((p) => p.value)).toEqual([10, 20]);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("append-only floor: pre-existing DB rows win on overlap; seed only fills gaps", async () => {
  const path = writeSeed();
  try {
    // Simulate a warm DB where AAA@2020-01-02 already holds a REAL fetched value (99).
    await saveRawIndicatorHistory({ AAA: [{ date: "2020-01-02", value: 99 }] });

    const res = await applyRawFloorSeed(await loadRawFloorSeed(path));
    // AAA: only 01-01 and 01-03 are missing (01-02 already present) → 2; BBB: both → 2.
    expect(res.seededPoints).toBe(4);
    expect(res.existingPoints).toBe(1);

    const floor = await loadRawIndicatorHistory();
    // The existing 01-02 value (99) is preserved — the seed did NOT overwrite it.
    expect(floor.AAA).toEqual([
      { date: "2020-01-01", value: 1 },
      { date: "2020-01-02", value: 99 },
      { date: "2020-01-03", value: 3 },
    ]);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});
