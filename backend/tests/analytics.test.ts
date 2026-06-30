import { test, expect } from "bun:test";
import { percentileInWindow, applySign } from "../src/analytics/transform/math.ts";
import { seededProvider } from "../src/analytics/access/provider.ts";
import { regimeTool } from "../src/analytics/analyze/regime.ts";
import { channelDivergenceTool } from "../src/analytics/analyze/channel-divergence.ts";
import { lateCycleTool } from "../src/analytics/analyze/late-cycle.ts";

test("transforms: percentile + sign", () => {
  expect(percentileInWindow(3, [1, 2, 3, 4])).toBeCloseTo(0.75, 5);
  expect(applySign(0.7, 1)).toBeCloseTo(0.7, 5);
  expect(applySign(0.7, -1)).toBeCloseTo(0.3, 5);
});

test("seededProvider is asof-stable: a calendar date's value is identical across runs", () => {
  const spec = { id: "VIX", base: 17, vol: 0.08 };
  const a = seededProvider.getSeries(spec, "2026-06-30", 120);
  const b = seededProvider.getSeries(spec, "2026-07-10", 200);
  const da = a.find((p) => p.date === "2026-06-20");
  const db = b.find((p) => p.date === "2026-06-20");
  expect(da).toBeDefined();
  expect(db).toBeDefined();
  expect(da!.value).toBeCloseTo(db!.value, 9);
});

test("regime classifier produces valid, bounded snapshots", () => {
  const ctx = { asof: "2026-06-30", provider: seededProvider, dep: () => undefined };
  const { snapshots } = regimeTool.compute(ctx as any);
  expect(snapshots.length).toBe(120);
  for (const s of snapshots) {
    expect(s.composite).toBeGreaterThanOrEqual(0);
    expect(s.composite).toBeLessThanOrEqual(1);
    expect(["risk_off", "neutral", "risk_on"]).toContain(s.regime);
    expect(s.indicators.length).toBe(11);
  }
  // determinism across two computes for the same asof
  const again = regimeTool.compute(ctx as any).snapshots.at(-1)!;
  expect(again.composite).toBe(snapshots.at(-1)!.composite);
});

const ASOF = "2024-01-15";
const ctx = { asof: ASOF, provider: seededProvider, dep: () => undefined } as any;

test("channel-divergence compute: bounded gauges, valid reads, charted series", async () => {
  const payload = await channelDivergenceTool.compute(ctx);
  expect(payload.asof).toBe(ASOF);
  expect(payload.gauges.length).toBeGreaterThan(0);
  for (const g of payload.gauges) {
    expect(g.percentile).toBeGreaterThanOrEqual(0);
    expect(g.percentile).toBeLessThanOrEqual(1);
    expect(["channel intact", "softening", "breaking down"]).toContain(g.read);
  }
  expect(payload.series.points.length).toBeGreaterThan(0);
});

test("late-cycle compute: bounded gauges, valid reads, charted series", async () => {
  const payload = await lateCycleTool.compute(ctx);
  expect(payload.asof).toBe(ASOF);
  expect(payload.gauges.length).toBeGreaterThan(0);
  for (const g of payload.gauges) {
    expect(g.percentile).toBeGreaterThanOrEqual(0);
    expect(g.percentile).toBeLessThanOrEqual(1);
    expect(["benign", "elevated", "saturated (late-cycle)"]).toContain(g.read);
  }
  expect(payload.series.points.length).toBeGreaterThan(0);
});
