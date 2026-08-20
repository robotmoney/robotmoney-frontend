// HY_OAS / FRED truncation coverage (issue #634). fred.ts is deliberately
// KEYLESS (its own header comment) and pins `cosd=2010-01-01` to defeat FRED's
// default ~3y truncation — EXCEPT for BAMLH0A0HYM2 (HY_OAS), which the
// data-integrity review's finding D7 (docs/code-review/
// 20260814-review-data-integrity-macro-index-discrepancy.md §14.4) verified
// directly ignores `cosd` and serves a trailing ~3y window regardless. This
// file pins that documented behavior against a MOCKED response (no live
// network — see tests/fetchers-live.test.ts, RUN_LIVE_FETCHERS=1, for the
// real-endpoint check) and proves the production merge
// (analytics/index.ts's `mergeSeries(persisted floor, fetched)`, mirrored here
// via the same pure `mergeSeries`) recovers the pre-truncation span from the
// committed floor seed — no live key required.
import { test, expect } from "bun:test";
import { fetchFred, fredUrl } from "../../src/analytics/extract/fred.ts";
import { fetchOne } from "../../src/analytics/extract/sources.ts";
import { INDICATORS } from "../../src/analytics/analyze/indicators.ts";
import { mergeSeries } from "../../src/analytics/transform/math.ts";
import { loadRawFloorSeed, DEFAULT_FLOOR_SEED_PATH } from "../../src/analytics/extract/floor-seed.ts";

const HY_OAS = INDICATORS.find((i) => i.id === "HY_OAS")!;

// FRED's real observed HY_OAS response to `cosd=2010-01-01`: starts
// 2023-08-15, not 2010 (the D7 finding's captured evidence). Three rows are
// enough to prove the truncation boundary without vendoring the real ~787-row
// response.
const TRUNCATED_CSV = ["DATE,BAMLH0A0HYM2", "2023-08-15,3.85", "2023-08-16,3.84", "2026-08-13,2.80"].join("\n");

function mockFetchText(csv: string) {
  return (async (url: string) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => csv,
  })) as unknown as typeof fetch;
}

test("fetchFred requests the cosd=2010-01-01 override (the fix that works for every OTHER FRED series)", () => {
  expect(fredUrl("BAMLH0A0HYM2")).toBe(
    "https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2&cosd=2010-01-01",
  );
});

test("executing the fetcher: HY_OAS's live response truncates to its trailing window despite cosd=2010-01-01", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetchText(TRUNCATED_CSV);
  try {
    const live = await fetchOne(HY_OAS);
    expect(live).toEqual([
      { date: "2023-08-15", value: 3.85 },
      { date: "2023-08-16", value: 3.84 },
      { date: "2026-08-13", value: 2.80 },
    ]);
    // The defect this test pins: nothing in the live response predates
    // 2023-08-15, even though cosd asked for 2010-01-01.
    expect(live.every((p) => p.date >= "2023-08-15")).toBe(true);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchFred (generic path) is unaffected — same mocked truncated CSV, same fetcher code, HY_OAS is a source quirk not a fetcher bug", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetchText(TRUNCATED_CSV);
  try {
    const rows = await fetchFred("BAMLH0A0HYM2");
    expect(rows.length).toBe(3);
  } finally {
    globalThis.fetch = orig;
  }
});

// The acceptance criterion (issue #634): "fetching HY_OAS returns data older
// than 3 years". A bare live fetch cannot do that (proven above) — the
// pipeline's append-only merge against the persisted/committed floor is what
// does. This mirrors analytics/index.ts's `mergeSeries(floor[id], fetched[id])`
// exactly, using the SAME committed floor seed production cold-boots from
// (extract/floor-seed.ts::loadRawFloorSeed, DEFAULT_FLOOR_SEED_PATH).
test("merged with the persisted floor, HY_OAS carries data older than 3 years — the acceptance criterion this issue asks for", async () => {
  const floor = await loadRawFloorSeed(DEFAULT_FLOOR_SEED_PATH);
  const persisted = floor.HY_OAS ?? [];
  expect(persisted.length).toBeGreaterThan(0);

  // Overlap the mocked live fetch's tail on the floor's OWN last date (not a
  // literal date/value pinned to today's vendored fixture, which regenerates
  // over time) with a deliberately different value, so the overlap proves
  // fetched-wins-on-overlap without hardcoding the fixture's real number.
  const floorLast = persisted[persisted.length - 1];
  const revisedTailValue = floorLast.value + 5;
  const csv = ["DATE,BAMLH0A0HYM2", "2023-08-15,3.85", "2023-08-16,3.84", `${floorLast.date},${revisedTailValue}`].join(
    "\n",
  );

  const orig = globalThis.fetch;
  globalThis.fetch = mockFetchText(csv);
  let merged: { date: string; value: number }[];
  try {
    const live = await fetchOne(HY_OAS);
    merged = mergeSeries(persisted, live);
  } finally {
    globalThis.fetch = orig;
  }

  const threeYearsAgo = new Date();
  threeYearsAgo.setUTCFullYear(threeYearsAgo.getUTCFullYear() - 3);
  const cutoff = threeYearsAgo.toISOString().slice(0, 10);

  const olderThanThreeYears = merged.filter((p) => p.date < cutoff);
  expect(olderThanThreeYears.length).toBeGreaterThan(0);
  // And a live-truncated year (2023) specifically, matching the issue's own
  // "asserts data older than 2023 exists" test-plan wording.
  expect(merged.some((p) => p.date < "2024-01-01")).toBe(true);
  // Fetched still wins on overlap (mergeSeries' documented contract) — the
  // revised tail value, not the floor's original copy of that date.
  const tail = merged[merged.length - 1];
  expect(tail).toEqual({ date: floorLast.date, value: revisedTailValue });
});
