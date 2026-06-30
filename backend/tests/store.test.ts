// Store stage (DB round-trip; ephemeral Postgres via preload.ts — loud-fails if
// Docker/Postgres is absent, never skips). Persist then read back; upsert on the
// natural key overwrites rather than duplicates.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { saveRegimeSnapshots } from "../src/analytics/store/regime-store.ts";
import type { RegimeSnapshot } from "../src/analytics/analyze/regime.ts";
import { persistResearchSignal } from "../src/analytics/store/research-store.ts";
import type { ResearchPayload } from "../src/analytics/analyze/research.ts";

const DATE = "1990-01-15"; // unique date, no collision with seeded/suite rows

function snap(composite: number): RegimeSnapshot {
  return {
    date: DATE,
    composite,
    compositePercentile: 0.42,
    regime: "neutral",
    macroRegime: "risk_on",
    onchainRegime: "risk_off",
    factorRegime: null,
    percentiles: { VIX: 0.3, BTC: 0.7 },
    indicators: [{ id: "VIX", name: "vol", panel: "macro", sign: -1, value: 17, score: 0.3, weight: 1.1 }],
  };
}

test("saveRegimeSnapshots: round-trips and upserts (no duplicate on re-save)", async () => {
  await sql`DELETE FROM regime_snapshots WHERE date = ${DATE}`;
  await saveRegimeSnapshots([snap(0.5)]);

  const [row] = await sql`SELECT * FROM regime_snapshots WHERE date = ${DATE}`;
  expect(row).toBeDefined();
  expect(Number(row.composite)).toBeCloseTo(0.5, 9);
  expect(Number(row.composite_percentile)).toBeCloseTo(0.42, 9);
  expect(row.regime).toBe("neutral");
  expect(row.macro_regime).toBe("risk_on");
  expect(row.onchain_regime).toBe("risk_off");
  expect(row.percentiles).toEqual({ VIX: 0.3, BTC: 0.7 });
  expect(row.indicators).toEqual([{ id: "VIX", name: "vol", panel: "macro", sign: -1, value: 17, score: 0.3, weight: 1.1 }]);

  // re-save same date with a new composite → overwrite, still exactly one row.
  await saveRegimeSnapshots([snap(0.9)]);
  const rows = await sql`SELECT composite FROM regime_snapshots WHERE date = ${DATE}`;
  expect(rows.length).toBe(1);
  expect(Number(rows[0].composite)).toBeCloseTo(0.9, 9);
});

test("persistResearchSignal: round-trips and upserts on (signal_key, date)", async () => {
  const KEY = "test-store-signal";
  await sql`DELETE FROM research_signals WHERE signal_key = ${KEY}`;
  const payload = (v: number): ResearchPayload => ({
    asof: DATE,
    title: "T",
    question: "Q?",
    spec: { window: v },
    gauges: [{ id: "G", name: "g", value: v, percentile: 0.5, read: "softening" }],
    series: { label: "L", points: [{ date: DATE, value: v }] },
  });

  await persistResearchSignal(KEY, DATE, payload(1));
  const [row] = await sql`SELECT payload FROM research_signals WHERE signal_key = ${KEY} AND date = ${DATE}`;
  expect(row).toBeDefined();
  expect(row.payload).toEqual(payload(1) as any);

  // upsert overwrites, no duplicate.
  await persistResearchSignal(KEY, DATE, payload(2));
  const rows = await sql`SELECT payload FROM research_signals WHERE signal_key = ${KEY} AND date = ${DATE}`;
  expect(rows.length).toBe(1);
  expect((rows[0].payload as any).spec.window).toBe(2);
});
