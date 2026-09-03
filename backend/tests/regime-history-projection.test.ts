// forHistory (issue #866a): the projection applied to every entry of GET
// /api/dashboards/regime-snapshots' `history[]`, dropping the fields that
// only ever carry data on the asof/latest row (backtest, correlations,
// indicators) plus one that's per-row but unread off a history entry
// (percentiles). Pure function, no DB needed.
import { expect, test } from "bun:test";
import { forHistory, rowToSnapshot } from "../src/analytics/report/regime-projection.ts";
import type { RegimeSnapshot } from "@robotmoney/contract";

function fullSnapshot(overrides: Partial<RegimeSnapshot> = {}): RegimeSnapshot {
  return {
    date: "2026-09-01",
    composite: 0.5,
    compositePercentile: 60,
    regime: "neutral",
    macroRegime: "neutral",
    onchainRegime: "risk_on",
    factorRegime: null,
    macroIndex: 0.4,
    onchainIndex: 0.6,
    factorIndex: null,
    macroPercentile: 55,
    onchainPercentile: 65,
    factorPercentile: null,
    panelWeights: { macro: { x: 1 } },
    version: "v2",
    source: "live",
    percentiles: { test_indicator: 61 },
    indicators: [{ id: "TEST", percentile: 61 } as never],
    panels: ["macro", "onchain"],
    bucketThresholds: { risk_off: 0.3, risk_on: 0.7 },
    backtest: { some: "payload" } as never,
    correlations: { forward: {}, concurrent: {} },
    extras: { some_series: [] },
    ...overrides,
  };
}

test("forHistory drops backtest, correlations, indicators and percentiles", () => {
  const projected = forHistory(fullSnapshot());
  expect(projected).not.toHaveProperty("backtest");
  expect(projected).not.toHaveProperty("correlations");
  expect(projected).not.toHaveProperty("indicators");
  expect(projected).not.toHaveProperty("percentiles");
});

test("forHistory keeps every field regime.js's charts read off a history row", () => {
  const projected = forHistory(fullSnapshot());
  expect(projected.date).toBe("2026-09-01");
  expect(projected.composite).toBe(0.5);
  expect(projected.regime).toBe("neutral");
  expect(projected.macroIndex).toBe(0.4);
  expect(projected.onchainIndex).toBe(0.6);
  expect(projected.factorIndex).toBeNull();
});

test("forHistory keeps every OTHER field too (panels, bucketThresholds, extras, panelWeights, version, source) — only the four named fields are dropped", () => {
  const projected = forHistory(fullSnapshot());
  expect(projected.panels).toEqual(["macro", "onchain"]);
  expect(projected.bucketThresholds).toEqual({ risk_off: 0.3, risk_on: 0.7 });
  expect(projected.extras).toEqual({ some_series: [] });
  expect(projected.panelWeights).toEqual({ macro: { x: 1 } });
  expect(projected.version).toBe("v2");
  expect(projected.source).toBe("live");
});

test("forHistory is idempotent-shaped over a row that already has null/empty asof-only fields (the ordinary history-row case)", () => {
  const historyShapedRow = rowToSnapshot({
    date: "2026-09-01",
    composite: "0.5",
    composite_percentile: "60",
    regime: "neutral",
    macro_regime: "neutral",
    onchain_regime: null,
    factor_regime: null,
    percentiles: { test_indicator: 61 }, // genuinely per-row in the DB
    indicators: null, // NULL on every non-asof row
    backtest: null,
    correlations: null,
  });
  const projected = forHistory(historyShapedRow);
  expect(projected).not.toHaveProperty("percentiles");
  expect(projected).not.toHaveProperty("indicators");
  expect(projected.date).toBe("2026-09-01");
  expect(projected.composite).toBe(0.5);
});
