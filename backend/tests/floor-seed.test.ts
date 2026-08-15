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
import { loadRawFloorSeed, DEFAULT_FLOOR_SEED_PATH } from "../src/analytics/extract/floor-seed.ts";
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

test("cold DB: seeded rows are tagged source='seed' (issue #397 provenance)", async () => {
  const path = writeSeed();
  try {
    await applyRawFloorSeed(await loadRawFloorSeed(path));
    const rows = await sql`SELECT indicator, source FROM raw_indicator_history WHERE indicator IN ('AAA','BBB') ORDER BY indicator, date`;
    expect(rows.length).toBe(5);
    expect(rows.every((r: any) => r.source === "seed")).toBe(true);
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

// ── Issue #400: the ACTUAL committed vendored gzip carries real BTC_MVRV ──────
// history (regenerated via `bun run floor-seed:regenerate`, #127's Coinmetrics
// CapMVRVCur repoint) — not the tiny synthetic seed above. These tests load the
// real ~580 KB fixture directly so a future regeneration that drops/corrupts
// BTC_MVRV fails loudly here, not just in the full regime-fidelity replay.
beforeEach(async () => {
  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'BTC_MVRV'`;
});

test("committed vendored floor seed contains finite, ordered BTC_MVRV observations", async () => {
  const seed = await loadRawFloorSeed(DEFAULT_FLOOR_SEED_PATH);
  const mvrv = seed.BTC_MVRV;
  expect(mvrv).toBeDefined();
  // Multi-year daily history, not a token/placeholder handful of rows.
  expect(mvrv.length).toBeGreaterThan(2000);
  for (const p of mvrv) {
    expect(Number.isFinite(p.value), `BTC_MVRV@${p.date} must be finite`).toBe(true);
  }
  for (let i = 1; i < mvrv.length; i++) {
    expect(mvrv[i].date > mvrv[i - 1].date, `BTC_MVRV must be strictly date-ordered ascending`).toBe(true);
  }
  // MVRV is a market-cap/realized-cap ratio: sane historical bound (all-time
  // range is roughly 0.4-4.7), a loose sanity check against a corrupted regen.
  for (const p of mvrv) {
    expect(p.value, `BTC_MVRV@${p.date} outside plausible MVRV range`).toBeGreaterThan(0);
    expect(p.value, `BTC_MVRV@${p.date} outside plausible MVRV range`).toBeLessThan(20);
  }
});

test("cold DB: the committed floor seeds BTC_MVRV once; a second run is a no-op (idempotent)", async () => {
  const seed = await loadRawFloorSeed(DEFAULT_FLOOR_SEED_PATH);
  const mvrvSeed = seed.BTC_MVRV;
  expect(mvrvSeed.length).toBeGreaterThan(2000);

  const first = await applyRawFloorSeed(seed);
  expect(first.seededPoints).toBeGreaterThan(0);

  const [{ n: afterFirst }] = await sql`
    SELECT COUNT(*)::int AS n FROM raw_indicator_history WHERE indicator = 'BTC_MVRV'`;
  expect(afterFirst).toBe(mvrvSeed.length);

  // Idempotent: every (date, BTC_MVRV) is now present → the second run adds none.
  await applyRawFloorSeed(seed);
  const [{ n: afterSecond }] = await sql`
    SELECT COUNT(*)::int AS n FROM raw_indicator_history WHERE indicator = 'BTC_MVRV'`;
  expect(afterSecond).toBe(mvrvSeed.length);
  expect(afterSecond).toBe(afterFirst);
  // Issue #631: two full applyRawFloorSeed passes against the ENTIRE committed
  // seed (119k+ rows across 26 indicators post-#630 full-universe purge, not
  // just BTC_MVRV) — the first pass is a cold bulk insert of the whole seed.
  // That comfortably outgrew bun test's 5000ms default (observed 5020.96ms
  // timeout on CI, PR #628 run 31856254000/job 94941492948); give it real
  // headroom against ordinary runner load variance, not just a hair over 5s.
}, 30000);

test("append-only floor: an existing real BTC_MVRV DB value is never overwritten by the seed", async () => {
  const seed = await loadRawFloorSeed(DEFAULT_FLOOR_SEED_PATH);
  const mvrvSeed = seed.BTC_MVRV;
  const overlapDate = mvrvSeed[0].date;
  const realValue = 9.87654321; // a distinguishable "already fetched live" value

  await saveRawIndicatorHistory({ BTC_MVRV: [{ date: overlapDate, value: realValue }] });

  const res = await applyRawFloorSeed(seed);
  // Every BTC_MVRV date except the one pre-seeded overlap is newly written.
  expect(res.seededPoints).toBeGreaterThanOrEqual(mvrvSeed.length - 1);

  const [{ value }] = await sql`
    SELECT value FROM raw_indicator_history WHERE indicator = 'BTC_MVRV' AND date = ${overlapDate}`;
  expect(Number(value)).toBeCloseTo(realValue, 6);

  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM raw_indicator_history WHERE indicator = 'BTC_MVRV'`;
  expect(n).toBe(mvrvSeed.length);
  // Issue #631: another full applyRawFloorSeed pass over the entire committed
  // (119k+ row, 26-indicator) seed — give it the same CI-load headroom as the
  // idempotency test above rather than relying on the 5000ms default.
}, 15000);
