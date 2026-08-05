import { test, expect } from "bun:test";
import { percentileInWindow, applySign } from "../src/analytics/transform/math.ts";
import { seededProvider } from "../src/analytics/access/provider.ts";
import { regimeTool } from "../src/analytics/analyze/regime.ts";

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

test("regime classifier produces valid, bounded snapshots", async () => {
  const ctx = { asof: "2026-06-30", provider: seededProvider, dep: () => undefined };
  const { snapshots } = await regimeTool.compute(ctx as any);
  expect(snapshots.length).toBe(120);
  for (const s of snapshots) {
    expect(s.composite).toBeGreaterThanOrEqual(0);
    expect(s.composite).toBeLessThanOrEqual(1);
    expect(["risk_off", "neutral", "risk_on"]).toContain(s.regime);
    expect(s.indicators.length).toBe(11);
  }
  // determinism across two computes for the same asof
  const again = (await regimeTool.compute(ctx as any)).snapshots.at(-1)!;
  expect(again.composite).toBe(snapshots.at(-1)!.composite);
});

// channel-divergence / late-cycle "compute: bounded gauges, valid reads,
// charted series" tests used to live here, exercising the seeded-random-walk
// shadow tools `analyze/channel-divergence.ts` / `analyze/late-cycle.ts`.
// Those tools shared filenames with (but did not implement) the real v0
// scripts, were registered in no Registry, and this was their only test
// (parity audit 11.9 / Phase R R3). They were deleted rather than fixed —
// the REAL production signals (`computeChannelDivergence` / `computeLateCycle`
// in `analyze/research-signals.ts`) are covered against genuine v0 fixtures
// by `research-fidelity.test.ts` (Phase R R2).
