// Regime-staleness INTEGRATION layer (issue #126): prove the backend PRODUCES a
// correct `staleness` object from real `regime_snapshots` rows — closing the gap
// between the pure-classifier unit tests (tests/regime-staleness.test.ts) and the
// frontend banner specs, which inject a hand-crafted `staleness` via a route stub.
//
// Same discipline as tests/api/dashboards-live.test.ts: runs against the REAL
// (ephemeral) Postgres provisioned by tests/preload.ts. Postgres is REQUIRED:
// preload throws (loud, not skip) when it is absent, so every assertion below is
// genuine coverage under the test-coverage policy — no .skip / env-gate.
//
// The HTTP layer is exercised through `getRegimeSnapshots(url)` — the exact
// handler api/index.ts registers for GET /api/dashboards/regime-snapshots (whose
// body is `JSON.stringify(await getRegimeSnapshots(url))`) — with the JSON
// round-trip applied so the assertions run over the serialized response body a
// client receives. Path registration itself is pinned by
// api-routes-contract.test.ts.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { fetchRegimeSnapshots } from "../../src/analytics/report/projections.ts";
import { getRegimeSnapshots } from "../../src/api/routes/dashboards.ts";
import { saveRegimeSnapshots } from "../../src/analytics/store/regime-store.ts";
import { REGIME_STALE_THRESHOLD_DAYS } from "../../src/analytics/report/regime-projection.ts";

// fetchRegimeSnapshots measures freshness against the real server clock (UTC
// today), so seed dates are computed relative to that same clock.
const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const today = () => daysAgo(0);

// Minimal-but-real snapshot row, persisted through the SAME store writer the
// analytics pipeline uses (saveRegimeSnapshots), so the test covers the actual
// write→read path rather than a hand-rolled INSERT.
const snapRow = (date: string) => ({
  date,
  composite: 0.42,
  compositePercentile: 61,
  regime: "neutral",
  macroRegime: "neutral",
  onchainRegime: null,
  factorRegime: null,
  percentiles: { test_indicator: 61 },
  indicators: [],
});

// Each test owns the table. report.test.ts already uses the same full-table
// reset, and every other regime test seeds its own dates, so this is safe.
beforeEach(async () => {
  await sql`DELETE FROM regime_snapshots`;
});
afterAll(async () => {
  await sql`DELETE FROM regime_snapshots`;
});

// ── fetchRegimeSnapshots (producer over real DB state) ──────────────────────
test("a today-dated snapshot row yields staleness.stale === false with correct asof/ageDays", async () => {
  await saveRegimeSnapshots([snapRow(today())]);
  const r = await fetchRegimeSnapshots(30);
  expect(r.latest?.date).toBe(today());
  expect(r.history).toHaveLength(1);
  expect(r.staleness.stale).toBe(false);
  expect(r.staleness.asof).toBe(today());
  expect(r.staleness.ageDays).toBe(0);
  expect(r.staleness.thresholdDays).toBe(REGIME_STALE_THRESHOLD_DAYS);
});

test("a snapshot frozen >3 days back yields staleness.stale === true with the real age", async () => {
  // The reported deployment symptom (#123): served data frozen at an old seed
  // floor while the clock moved on — must read loudly stale, not current.
  await saveRegimeSnapshots([snapRow(daysAgo(10))]);
  const r = await fetchRegimeSnapshots(30);
  expect(r.latest?.date).toBe(daysAgo(10));
  expect(r.staleness.stale).toBe(true);
  expect(r.staleness.asof).toBe(daysAgo(10));
  expect(r.staleness.ageDays).toBe(10);
});

test("a future-dated row never shadows the real latest — fetchRegimeSnapshots enforces date <= today", async () => {
  // Regression for #382: a future-dated row (demo/seed bug, manual insert, or
  // clock skew on whatever produced it) sorts FIRST under `ORDER BY date DESC`
  // and, without the `date <= today` boundary, would be served as `latest` —
  // shadowing the real current snapshot and reading falsely fresh. Planted
  // violation control: with the boundary removed this test fails (latest.date
  // would be the future row, and it would appear in history), proving the
  // assertion is not vacuous.
  await saveRegimeSnapshots([snapRow(today()), snapRow(daysAgo(-5))]);
  const r = await fetchRegimeSnapshots(30);
  expect(r.latest?.date).toBe(today());
  expect(r.history.map((h) => h.date)).not.toContain(daysAgo(-5));
  expect(r.staleness.stale).toBe(false);
  expect(r.staleness.asof).toBe(today());
});

test("GET regime-snapshots response body also excludes a future-dated row from latest/history", async () => {
  await saveRegimeSnapshots([snapRow(today()), snapRow(daysAgo(-5))]);
  const url = new URL(`http://backend.test${ROUTES.dashboards.regimeSnapshots}?range=30`);
  const body = JSON.parse(JSON.stringify(await getRegimeSnapshots(url)));
  expect(body.latest.date).toBe(today());
  expect(body.history.map((h: { date: string }) => h.date)).not.toContain(daysAgo(-5));
});

test("an empty regime_snapshots table yields staleness.stale === true with asof === null", async () => {
  const r = await fetchRegimeSnapshots(30);
  expect(r.latest).toBeNull();
  expect(r.history).toEqual([]);
  expect(r.staleness.stale).toBe(true);
  expect(r.staleness.asof).toBeNull();
  expect(r.staleness.ageDays).toBeNull();
});

test("staleness is derived from the NEWEST row even when `range` clamps history to 1", async () => {
  // Old + fresh rows together: range=1 serves only the newest row, and the
  // staleness verdict must follow that served row (fresh), not the stale tail.
  await saveRegimeSnapshots([snapRow(daysAgo(20)), snapRow(today())]);
  const r = await fetchRegimeSnapshots(1);
  expect(r.history).toHaveLength(1);
  expect(r.latest?.date).toBe(today());
  expect(r.staleness.stale).toBe(false);
  expect(r.staleness.asof).toBe(today());
});

// ── GET /api/dashboards/regime-snapshots (route handler → response body) ────
test("GET regime-snapshots response body carries a staleness object with asof, ageDays, stale, thresholdDays", async () => {
  await saveRegimeSnapshots([snapRow(today())]);
  const url = new URL(`http://backend.test${ROUTES.dashboards.regimeSnapshots}?range=1`);
  // json() in api/index.ts serializes the handler result verbatim; round-trip
  // through JSON so we assert on the body a client actually receives.
  const body = JSON.parse(JSON.stringify(await getRegimeSnapshots(url)));
  expect(body.latest.date).toBe(today());
  expect(Array.isArray(body.history)).toBe(true);
  const s = body.staleness;
  expect(s).toBeDefined();
  expect(Object.keys(s).sort()).toEqual(["ageDays", "asof", "serverDate", "stale", "thresholdDays"]);
  expect(s.asof).toBe(today());
  expect(s.ageDays).toBe(0);
  expect(s.stale).toBe(false);
  expect(s.thresholdDays).toBe(REGIME_STALE_THRESHOLD_DAYS);
});

test("GET regime-snapshots over an empty table still returns a well-formed stale verdict (never a 5xx-shaped hole)", async () => {
  const url = new URL(`http://backend.test${ROUTES.dashboards.regimeSnapshots}?range=180`);
  const body = JSON.parse(JSON.stringify(await getRegimeSnapshots(url)));
  expect(body.latest).toBeNull();
  expect(body.history).toEqual([]);
  expect(body.staleness.stale).toBe(true);
  expect(body.staleness.asof).toBeNull();
  expect(body.staleness.ageDays).toBeNull();
  expect(body.staleness.thresholdDays).toBe(REGIME_STALE_THRESHOLD_DAYS);
});
