// Store stage (DB round-trip; ephemeral Postgres via preload.ts — loud-fails if
// Docker/Postgres is absent, never skips). Persist then read back; upsert on the
// natural key overwrites rather than duplicates.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import {
  saveRegimeSnapshots,
  loadRegimeSnapshot,
  type RegimeSnapshotRow,
} from "../src/analytics/store/regime-store.ts";
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

test("saveRegimeSnapshots: round-trips the full v2 row (panel fields, weights, version, rich indicators)", async () => {
  const RDATE = "1990-02-20"; // unique date, no collision with other tests/seeds
  await sql`DELETE FROM regime_snapshots WHERE date = ${RDATE}`;

  const richIndicators = [
    {
      id: "T10Y2Y",
      name: "10y-2y yield curve",
      panel: "macro",
      raw_value: 0.41,
      raw_date: "1990-02-19",
      transformed_value: 0.41,
      percentile: 0.62,
      signed_percentile: 0.62,
      panel_weight: 0.18,
      sparkline: [0.38, 0.39, 0.4, 0.41],
    },
    {
      id: "DEFI_TVL",
      name: "DeFi TVL",
      panel: "onchain",
      raw_value: 95e9,
      raw_date: "1990-02-19",
      transformed_value: 0.0567,
      percentile: 0.71,
      signed_percentile: 0.71,
      panel_weight: 0.22,
      sparkline: [0.05, 0.052, 0.055, 0.0567],
    },
  ];
  const panelWeights = {
    macro: { T10Y2Y: 0.18, HY_OAS: 0.25 },
    onchain: { DEFI_TVL: 0.22, STABLES: 0.19 },
    factor: { CONCENTRATION: 0.31 },
  };

  const bucketThresholds = { risk_off: 0.33, risk_on: 0.67 };
  const panels = ["macro", "onchain", "factor"];
  const backtest = { eth: { composite: { final_value: 2.4, equity_curve: [{ date: "1990-02-19", value: 1 }, { date: "1990-02-20", value: 1.02 }] } } };
  const correlations = { forward: { factor: { spx_30d: { rho: 0.12, n: 900 } } }, concurrent: {} };
  const extras = { spx: [{ date: "1990-02-19", value: 4000 }], eth: [{ date: "1990-02-19", value: 2500 }] };

  const row: RegimeSnapshotRow = {
    date: RDATE,
    composite: 0.5321,
    compositePercentile: 0.6789,
    regime: "risk_on",
    macroRegime: "neutral",
    onchainRegime: "risk_on",
    factorRegime: "risk_off",
    macroIndex: 0.48,
    onchainIndex: 0.58,
    factorIndex: 0.29,
    macroPercentile: 0.55,
    onchainPercentile: 0.72,
    factorPercentile: 0.21,
    panelWeights,
    version: "v2-2026.07",
    percentiles: { T10Y2Y: 0.62, DEFI_TVL: 0.71 },
    indicators: richIndicators,
    panels,
    bucketThresholds,
    backtest,
    correlations,
    extras,
  };

  await saveRegimeSnapshots([row]);
  const back = await loadRegimeSnapshot(RDATE);
  expect(back).not.toBeNull();
  expect(back!.date).toBe(RDATE);
  expect(back!.composite).toBeCloseTo(0.5321, 9);
  expect(back!.compositePercentile).toBeCloseTo(0.6789, 9);
  expect(back!.regime).toBe("risk_on");
  expect(back!.macroRegime).toBe("neutral");
  expect(back!.onchainRegime).toBe("risk_on");
  expect(back!.factorRegime).toBe("risk_off");
  expect(back!.macroIndex).toBeCloseTo(0.48, 9);
  expect(back!.onchainIndex).toBeCloseTo(0.58, 9);
  expect(back!.factorIndex).toBeCloseTo(0.29, 9);
  expect(back!.macroPercentile).toBeCloseTo(0.55, 9);
  expect(back!.onchainPercentile).toBeCloseTo(0.72, 9);
  expect(back!.factorPercentile).toBeCloseTo(0.21, 9);
  expect(back!.version).toBe("v2-2026.07");
  expect(back!.panelWeights).toEqual(panelWeights);
  expect(back!.percentiles).toEqual({ T10Y2Y: 0.62, DEFI_TVL: 0.71 });
  expect(back!.indicators).toEqual(richIndicators);
  // Dashboard-level blobs round-trip on the asof row (snake_case preserved inside).
  expect(back!.panels).toEqual(panels);
  expect(back!.bucketThresholds).toEqual(bucketThresholds);
  expect(back!.backtest).toEqual(backtest);
  expect(back!.correlations).toEqual(correlations);
  expect(back!.extras).toEqual(extras);

  // re-save with a mutated composite → overwrite, exactly one row.
  await saveRegimeSnapshots([{ ...row, composite: 0.1 }]);
  const rows = await sql`SELECT composite FROM regime_snapshots WHERE date = ${RDATE}`;
  expect(rows.length).toBe(1);
  expect(Number(rows[0].composite)).toBeCloseTo(0.1, 9);
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
