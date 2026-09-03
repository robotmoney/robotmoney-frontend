// Regime-staleness INTEGRATION layer (issue #126, revised #398): prove the
// backend PRODUCES a correct `staleness` object from real `regime_snapshots`
// rows — closing the gap between the pure-classifier unit tests
// (tests/regime-staleness.test.ts) and the frontend banner specs, which
// inject a hand-crafted `staleness` via a route stub.
//
// #398: staleness must be derived from the REAL per-indicator `raw_date`
// observations carried on the asof row's `indicators` array — never from the
// row's own `date` column, which the pipeline forward-fills to today on EVERY
// run regardless of whether the underlying sources actually refreshed. The
// dedicated regression test below plants exactly that scenario (today-dated
// row, stale indicators) and would have failed against the pre-fix
// `computeRegimeStaleness(snapshotRow.date, today)` implementation.
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
import { expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { fetchRegimeSnapshots } from "../../src/analytics/report/projections.ts";
import { getRegimeSnapshots, getRegimeSnapshotsSummary } from "../../src/api/routes/dashboards.ts";
import { saveRegimeSnapshots } from "../../src/analytics/store/regime-store.ts";
import { REGIME_STALE_THRESHOLD_DAYS, type JsonValue } from "../../src/analytics/report/regime-projection.ts";
import { useCleanDatabasePerTest } from "../support/clean-db.ts";

// Own database per TEST, cloned from the migrated template: these tests each
// start from an empty table, which used to mean wiping one the previous test
// filled. See support/clean-db.ts.
useCleanDatabasePerTest(import.meta.file);

// fetchRegimeSnapshots measures freshness against the real server clock (UTC
// today), so seed dates are computed relative to that same clock.
const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const today = () => daysAgo(0);

// Minimal-but-real rich per-indicator objects (the shape analytics/index.ts's
// buildRichIndicators produces, sourced from the persisted
// `raw_indicator_history` floor) covering both live panels, each carrying
// `rawDate` as its REAL observation date. Real registry ids (indicators.ts)
// so the shape matches production; the test never persists to
// raw_indicator_history itself since staleness is computed purely from this
// embedded `indicators` array, not by re-querying that table on the read path.
const freshIndicators = (rawDate: string): JsonValue[] => [
  { id: "T10Y2Y", panel: "macro", raw_date: rawDate },
  { id: "DEFI_TVL", panel: "onchain", raw_date: rawDate },
];

// Minimal-but-real snapshot row, persisted through the SAME store writer the
// analytics pipeline uses (saveRegimeSnapshots), so the test covers the actual
// write→read path rather than a hand-rolled INSERT. `indicators` defaults to
// two fresh (same-date) indicators so tests that don't care about staleness
// mechanics get an unsurprising "fresh" row; staleness-focused tests below
// override it to exercise forward-fill / missing / invalid observation dates.
const snapRow = (date: string, indicators: readonly JsonValue[] = freshIndicators(date)) => ({
  date,
  composite: 0.42,
  compositePercentile: 61,
  regime: "neutral",
  macroRegime: "neutral",
  onchainRegime: null,
  factorRegime: null,
  source: "live",
  percentiles: { test_indicator: 61 },
  indicators,
});


// ── fetchRegimeSnapshots (producer over real DB state) ──────────────────────
test("a today-dated snapshot row with current indicator observations yields staleness.stale === false with correct asof/ageDays", async () => {
  await saveRegimeSnapshots([snapRow(today())]);
  const r = await fetchRegimeSnapshots(30);
  expect(r.latest?.date).toBe(today());
  expect(r.history).toHaveLength(1);
  expect(r.staleness.stale).toBe(false);
  expect(r.staleness.asof).toBe(today());
  expect(r.staleness.ageDays).toBe(0);
  expect(r.staleness.thresholdDays).toBe(REGIME_STALE_THRESHOLD_DAYS);
  expect(r.staleness.panelObservationDates).toEqual({ macro: today(), onchain: today() });
  // Row-level provenance (issue #397) reaches the served DTO unchanged.
  expect(r.latest?.source).toBe("live");
});

test("a snapshot whose indicator observations are frozen >3 days back yields staleness.stale === true with the real age", async () => {
  // The reported deployment symptom (#123): served data frozen at an old seed
  // floor while the clock moved on — must read loudly stale, not current.
  const old = daysAgo(10);
  await saveRegimeSnapshots([snapRow(old, freshIndicators(old))]);
  const r = await fetchRegimeSnapshots(30);
  expect(r.latest?.date).toBe(old);
  expect(r.staleness.stale).toBe(true);
  expect(r.staleness.asof).toBe(old);
  expect(r.staleness.ageDays).toBe(10);
});

// ── issue #398 core regression: forward-fill must not masquerade as fresh ───
test("#398 regression: a TODAY-dated (forward-filled) snapshot whose indicators carry OLD raw observation dates is reported stale — staleness comes from real observations, not the write date", async () => {
  const old = daysAgo(10);
  // The pipeline forward-fills `date` to today on every run even when the
  // underlying sources haven't produced a new point — exactly this shape.
  await saveRegimeSnapshots([snapRow(today(), freshIndicators(old))]);
  const r = await fetchRegimeSnapshots(30);
  expect(r.latest?.date).toBe(today()); // the row's own (forward-filled) date IS today
  expect(r.staleness.stale).toBe(true); // yet the real observations are 10 days old
  expect(r.staleness.asof).toBe(old);
  expect(r.staleness.ageDays).toBe(10);
  expect(r.staleness.panelObservationDates).toEqual({ macro: old, onchain: old });
});

test("#398: current panel observations remain fresh under the existing threshold even when embedded in a same-day row", async () => {
  await saveRegimeSnapshots([snapRow(today(), freshIndicators(today()))]);
  const r = await fetchRegimeSnapshots(30);
  expect(r.staleness.stale).toBe(false);
  expect(r.staleness.ageDays).toBe(0);
});

test("#398: missing raw_date on every indicator fails closed as stale even though the snapshot's own date is today", async () => {
  const noDates = [
    { id: "T10Y2Y", panel: "macro", raw_date: null },
    { id: "DEFI_TVL", panel: "onchain", raw_date: null },
  ];
  await saveRegimeSnapshots([snapRow(today(), noDates)]);
  const r = await fetchRegimeSnapshots(30);
  expect(r.latest?.date).toBe(today());
  expect(r.staleness.stale).toBe(true);
  expect(r.staleness.asof).toBeNull();
  expect(r.staleness.panelObservationDates).toEqual({ macro: null, onchain: null });
});

test("#398: an invalid (unparseable) raw_date on one panel fails the WHOLE snapshot closed, even if another panel is current", async () => {
  const mixed = [
    { id: "T10Y2Y", panel: "macro", raw_date: "not-a-date" },
    { id: "DEFI_TVL", panel: "onchain", raw_date: today() },
  ];
  await saveRegimeSnapshots([snapRow(today(), mixed)]);
  const r = await fetchRegimeSnapshots(30);
  // macro's only indicator has no valid observation date -> macro panel is
  // null -> the oldest-panel-wins gate fails the overall verdict closed,
  // rather than reporting fresh off the onchain panel alone.
  expect(r.staleness.stale).toBe(true);
  expect(r.staleness.asof).toBeNull();
  expect(r.staleness.panelObservationDates).toEqual({ macro: null, onchain: today() });
});

test("a future-dated row never shadows the real latest — fetchRegimeSnapshots enforces date <= today", async () => {
  // Regression for #382: a future-dated row (smoke/seed bug, manual insert, or
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
test("GET regime-snapshots response body carries a staleness object with asof, ageDays, stale, thresholdDays, panelObservationDates", async () => {
  await saveRegimeSnapshots([snapRow(today())]);
  const url = new URL(`http://backend.test${ROUTES.dashboards.regimeSnapshots}?range=1`);
  // json() in api/index.ts serializes the handler result verbatim; round-trip
  // through JSON so we assert on the body a client actually receives.
  const body = JSON.parse(JSON.stringify(await getRegimeSnapshots(url)));
  expect(body.latest.date).toBe(today());
  expect(Array.isArray(body.history)).toBe(true);
  const s = body.staleness;
  expect(s).toBeDefined();
  expect(Object.keys(s).sort()).toEqual([
    "ageDays",
    "asof",
    "panelObservationDates",
    "serverDate",
    "stale",
    "thresholdDays",
  ]);
  expect(s.asof).toBe(today());
  expect(s.ageDays).toBe(0);
  expect(s.stale).toBe(false);
  expect(s.thresholdDays).toBe(REGIME_STALE_THRESHOLD_DAYS);
  expect(s.panelObservationDates).toEqual({ macro: today(), onchain: today() });
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

// ── ?view=summary (issue #866c): the read an agent actually makes ──────────
test("GET regime-snapshots?view=summary returns only the composite/panel read, not history or the heavy latest fields", async () => {
  await saveRegimeSnapshots([snapRow(today())]);
  const body = JSON.parse(JSON.stringify(await getRegimeSnapshotsSummary()));
  expect(body.history).toBeUndefined();
  expect(body.latest).toBeUndefined();
  expect(Object.keys(body)).toEqual(["summary"]);
  expect(Object.keys(body.summary).sort()).toEqual([
    "compositePercentile",
    "composite",
    "date",
    "factorIndex",
    "factorRegime",
    "macroIndex",
    "macroRegime",
    "onchainIndex",
    "onchainRegime",
    "regime",
    "staleness",
  ].sort());
  expect(body.summary.date).toBe(today());
  expect(body.summary.composite).toBe(0.42);
  expect(body.summary.compositePercentile).toBe(61);
  expect(body.summary.regime).toBe("neutral");
  expect(body.summary.macroRegime).toBe("neutral");
  expect(body.summary.onchainRegime).toBeNull();
  expect(body.summary.factorRegime).toBeNull();
  expect(body.summary.macroIndex).toBeNull();
  expect(body.summary.staleness.stale).toBe(false);
});

test("GET regime-snapshots?view=summary over an empty table returns { summary: null }, never a 5xx-shaped hole", async () => {
  const body = JSON.parse(JSON.stringify(await getRegimeSnapshotsSummary()));
  expect(body).toEqual({ summary: null });
});

test("GET regime-snapshots?view=summary reads the true latest row regardless of how many rows exist", async () => {
  await saveRegimeSnapshots([snapRow("2020-01-01"), snapRow(today())]);
  const body = JSON.parse(JSON.stringify(await getRegimeSnapshotsSummary()));
  expect(body.summary.date).toBe(today());
});

// The route wires ?view=summary to a dedicated function BEFORE calling
// getRegimeSnapshots, so this asserts the dispatch itself, not just the
// summary function in isolation. api-routes-contract.test.ts covers path
// registration; this covers the view= branch inside it.
test("GET regime-snapshots without ?view=summary still returns the full { latest, history, staleness } shape", async () => {
  await saveRegimeSnapshots([snapRow(today())]);
  const url = new URL(`http://backend.test${ROUTES.dashboards.regimeSnapshots}?range=1`);
  const body = JSON.parse(JSON.stringify(await getRegimeSnapshots(url)));
  expect(body.summary).toBeUndefined();
  expect(Array.isArray(body.history)).toBe(true);
});
