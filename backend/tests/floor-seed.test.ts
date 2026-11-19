// Integration coverage for the cold-DB raw floor seed (issue #13), against the SAME
// ephemeral Postgres the rest of the suite uses (per-PR CI, no network). Proves the
// seed loader is:
//   • idempotent  — running twice writes the second time nothing (no-op once warm),
//   • append-only — pre-existing DB rows WIN on (date,indicator) overlap; the seed
//     only fills gaps (the honest mergeSeries floor semantics),
// using a tiny in-test CSV.gz so the assertions are exact (not the ~530 KB vendored
// fixture). A missing seed file must FAIL LOUDLY, never silent-skip.
import { test, expect, beforeEach } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRawFloorSeed } from "../src/analytics/store/floor-seed.ts";
import { loadRawFloorSeed, DEFAULT_FLOOR_SEED_PATH } from "../src/analytics/extract/floor-seed.ts";
import { loadRawIndicatorHistory, saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";
import { sql } from "../src/db/client.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { createHash } from "node:crypto";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { RATIO_IDS, RATIO_LEG_KEYS, RATIO_LEG_MAPPING } from "../src/analytics/extras.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import type { AnalyticsDataSource } from "../src/analytics/access/data-source.ts";
import { COLLECTED_SERIES } from "../src/analytics/extract/collected-series.ts";

// Issue 1644: the last tests below need a clean database each (the seed's
// leg rows land in the source ledger, which no test may delete from).
useCleanDatabasePerTest(import.meta.file);

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
  await fixtureDb`DELETE FROM raw_indicator_history WHERE indicator IN ('AAA','BBB')`;
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
    const first = await applyRawFloorSeed(await loadRawFloorSeed(path), fixtureDb);
    expect(first.seededPoints).toBe(5); // 3 AAA + 2 BBB
    expect(first.existingPoints).toBe(0);
    expect(first.indicators).toBe(2);

    const afterFirst = await loadRawIndicatorHistory();
    expect(afterFirst.AAA.map((p) => p.value)).toEqual([1, 2, 3]);
    expect(afterFirst.BBB.map((p) => p.value)).toEqual([10, 20]);

    // Idempotent: second run finds every (date,indicator) present → writes nothing.
    const second = await applyRawFloorSeed(await loadRawFloorSeed(path), fixtureDb);
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
    await applyRawFloorSeed(await loadRawFloorSeed(path), fixtureDb);
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
    await saveRawIndicatorHistory({ AAA: [{ date: "2020-01-02", value: 99 }] }, fixtureDb);

    const res = await applyRawFloorSeed(await loadRawFloorSeed(path), fixtureDb);
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
  await fixtureDb`DELETE FROM raw_indicator_history WHERE indicator = 'BTC_MVRV'`;
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

  const first = await applyRawFloorSeed(seed, fixtureDb);
  expect(first.seededPoints).toBeGreaterThan(0);

  const [{ n: afterFirst }] = await sql`
    SELECT COUNT(*)::int AS n FROM raw_indicator_history WHERE indicator = 'BTC_MVRV'`;
  expect(afterFirst).toBe(mvrvSeed.length);

  // Idempotent: every (date, BTC_MVRV) is now present → the second run adds none.
  await applyRawFloorSeed(seed, fixtureDb);
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

  await saveRawIndicatorHistory({ BTC_MVRV: [{ date: overlapDate, value: realValue }] }, fixtureDb);

  const res = await applyRawFloorSeed(seed, fixtureDb);
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

// ── Issue 1644: the committed floor carries both closes of every ratio symbol ─
// Every other row is the seed on origin/main byte for byte: the sha256 of the
// decompressed seed without its leg lines, in file order, is main's. The
// collected series' backfilled rows (BAA10Y, issue 1653) are left out too.
const MAIN_SEED_SHA256 = "c9c0b12fa3c3bcc8f016292de362ed186f72608f414cffb1c957b15fa4c21fd6";

test("issue 1644: every stored ratio date of the committed floor has all four legs, and every non-leg row is main's byte for byte", async () => {
  const text = gunzipSync(readFileSync(DEFAULT_FLOOR_SEED_PATH)).toString("utf8");
  const collected = new Set(COLLECTED_SERIES.map((s) => s.id));
  const withoutLegs = text.split("\n").filter((l) => !RATIO_LEG_KEYS.has(l.split(",")[1] ?? "") && !collected.has(l.split(",")[1] ?? "")).join("\n");
  expect(createHash("sha256").update(withoutLegs).digest("hex")).toBe(MAIN_SEED_SHA256);
  const seed = await loadRawFloorSeed(DEFAULT_FLOOR_SEED_PATH);
  expect(RATIO_LEG_KEYS.size).toBe(28);
  for (const key of RATIO_LEG_KEYS) expect(seed[key]?.length ?? 0, key).toBeGreaterThan(1000);
  expect(RATIO_IDS.size).toBe(8);
  for (const ratio of RATIO_IDS) {
    const legs = RATIO_LEG_MAPPING.filter((m) => m.consumer === `indicator:${ratio}`);
    expect(legs).toHaveLength(4);
    const stored = seed[ratio]!;
    expect(stored.length, ratio).toBeGreaterThan(1000);
    for (const leg of legs) {
      const dates = new Set(seed[leg.storageKey]!.map((p) => p.date));
      expect({ ratio, leg: leg.storageKey, missing: stored.filter((p) => !dates.has(p.date)).map((p) => p.date) }).toEqual({ ratio, leg: leg.storageKey, missing: [] });
    }
  }
});

test("issue 1644: ANALYTICS_FLOOR_SEED=1 writes the ratio rows as on main, no leg row to raw_indicator_history, and each leg's seed rows to the ledger under its key", async () => {
  // The run stops at the registry fetch; the seed is written before it.
  const stop: AnalyticsDataSource = {
    async fetchIndicators() { throw new Error("stop after the floor seed"); },
    async fetchBacktestExtras() { throw new Error("unused"); },
    async fetchResearchInputs() { throw new Error("unused"); },
  };
  const prior = process.env.ANALYTICS_FLOOR_SEED;
  process.env.ANALYTICS_FLOOR_SEED = "1";
  try {
    await runAnalytics("2026-08-15", "regime", stop, directAnalyticsPersistence, noopTelemetrySink).catch(() => {});
  } finally {
    if (prior === undefined) delete process.env.ANALYTICS_FLOOR_SEED;
    else process.env.ANALYTICS_FLOOR_SEED = prior;
  }
  const raw = await loadRawIndicatorHistory();
  const seed = await loadRawFloorSeed(DEFAULT_FLOOR_SEED_PATH);
  for (const id of RATIO_IDS) expect({ id, rows: raw[id]?.length ?? 0 }).toEqual({ id, rows: seed[id]!.length });
  for (const key of RATIO_LEG_KEYS) expect(raw[key], key).toBeUndefined();
  const rows = await sql<{ source_key: string; n: number; provenances: string[] }[]>`
    SELECT source_key, COUNT(*)::int AS n, array_agg(DISTINCT provenance) AS provenances FROM source_value_versions
    WHERE source_key = ANY(${[...RATIO_LEG_KEYS]}::text[]) GROUP BY source_key ORDER BY source_key`;
  expect(rows.map((r) => r.source_key)).toEqual([...RATIO_LEG_KEYS].sort());
  for (const r of rows) expect({ key: r.source_key, n: r.n, provenances: r.provenances }).toEqual({ key: r.source_key, n: seed[r.source_key]!.length, provenances: ["seed"] });
}, 180_000);
