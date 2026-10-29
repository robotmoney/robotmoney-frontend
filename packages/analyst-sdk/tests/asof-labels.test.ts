// As-of regime labels (issue 1399): one regime run per decision date, cut at
// its as-of day; a repeat call with the same input and cache makes no run; every
// indicator percentile is a number or null, never NaN; and on the 8-year
// fixture (tests/fixtures/PROVENANCE.md) exactly 1 of 419 weekly as-of labels
// differs from one full-history run, as published with the prototype (PR 1397).
import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as run from "../src/run.ts";
import {
  asofLabels,
  decisionDates,
  hindsight,
  INDICATORS,
  labelCacheKey,
  parseRawHistory,
  runRegime,
  toHistory,
  type AsofLabel,
  type RawIndicatorHistory,
} from "../src/index.ts";

const FIXTURE_8Y = join(import.meta.dir, "fixtures/allocate/raw-indicator-history-8y.csv");
const text8y = readFileSync(FIXTURE_8Y, "utf8");
const raw8y = toHistory(parseRawHistory(text8y));
const START = "2018-10-07";
const END = "2026-10-07";
// One as-of run over the 8-year input takes about half a second.
setDefaultTimeout(120_000);

/** A Map that counts its traffic. */
function countingCache() {
  const m = new Map<string, AsofLabel>();
  const n = { get: 0, hit: 0, set: 0 };
  return {
    n,
    get(k: string) {
      n.get++;
      const v = m.get(k);
      if (v) n.hit++;
      return v;
    },
    set(k: string, v: AsofLabel) {
      n.set++;
      m.set(k, v);
    },
  };
}

describe("decisionDates", () => {
  test("weekly: the start as-of the day before, then every Monday as-of the Friday before", () => {
    const d = decisionDates(START, END);
    expect(d.length).toBe(419);
    expect(d[0]).toEqual({ date: "2018-10-07", asof: "2018-10-06" });
    expect(d[1]).toEqual({ date: "2018-10-08", asof: "2018-10-05" });
    expect(d[d.length - 1]).toEqual({ date: "2026-10-05", asof: "2026-10-02" });
    for (const x of d.slice(1)) {
      expect(new Date(`${x.date}T00:00:00Z`).getUTCDay()).toBe(1);
      expect(new Date(`${x.asof}T00:00:00Z`).getUTCDay()).toBe(5);
    }
  });

  test("daily: every day, as-of the day before", () => {
    expect(decisionDates("2026-01-01", "2026-01-03", "daily")).toEqual([
      { date: "2026-01-01", asof: "2025-12-31" },
      { date: "2026-01-02", asof: "2026-01-01" },
      { date: "2026-01-03", asof: "2026-01-02" },
    ]);
  });

  test("a bad date, a reversed window or an unknown cadence throws", () => {
    expect(() => decisionDates("2026-02-30", END)).toThrow(RangeError);
    expect(() => decisionDates(END, START)).toThrow(RangeError);
    expect(() => decisionDates(START, END, "monthly" as never)).toThrow(RangeError);
  });
});

describe("asofLabels", () => {
  // Ten weekly decisions in 2024, well inside the fixture.
  const ten = decisionDates("2024-03-04", "2024-05-13").slice(1, 11);

  test("10 weekly dates give the same labels as 10 separate runRegime(..., { asof }) calls", () => {
    expect(ten.length).toBe(10);
    const labels = asofLabels(raw8y, { dates: ten });
    expect(labels.map((l) => l.date)).toEqual(ten.map((d) => d.date));
    for (const [i, d] of ten.entries()) {
      const r = runRegime(raw8y, { asof: d.asof });
      const last = r.dateAxis.length - 1;
      expect(r.dateAxis[last]).toBe(d.asof);
      expect(labels[i]!.asof).toBe(d.asof);
      expect(labels[i]!.label).toBe(r.result.regime[last] as never);
      expect(labels[i]!.compositePercentile).toBe(r.result.compositePercentile[last]!);
      for (const p of r.result.panels) {
        expect(labels[i]!.panels[p]!.label).toBe(r.result.panelRegimes[p]![last] as never);
        expect(labels[i]!.panels[p]!.percentile).toBe(r.result.panelPercentiles[p]![last]!);
      }
      for (const ind of INDICATORS) {
        const v = r.result.signed[ind.id]![last]!;
        expect(labels[i]!.indicators[ind.id]).toBe(Number.isFinite(v) ? v : null);
      }
    }
    // Not a constant: the labels are the regime's, which moves over the window.
    expect(labels.every((l) => l.label !== null)).toBe(true);
  });

  test("a second call with the same input and cache makes zero runRegime calls", () => {
    const cache = countingCache();
    const first = asofLabels(raw8y, { dates: ten, cache });
    expect(cache.n.set).toBe(10);
    const spy = spyOn(run, "runRegime");
    try {
      const second = asofLabels(raw8y, { dates: ten, cache });
      expect(spy).toHaveBeenCalledTimes(0);
      expect(cache.n.hit).toBe(10);
      expect(cache.n.set).toBe(10);
      expect(second).toEqual(first);
    } finally {
      spy.mockRestore();
    }
  });

  test("the spy sees runs: a cache miss calls runRegime once per date (control for the zero above)", () => {
    const spy = spyOn(run, "runRegime");
    try {
      asofLabels(raw8y, { dates: ten.slice(0, 2), cache: new Map() });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("a changed input invalidates the cache", () => {
    const cache = countingCache();
    const two = ten.slice(0, 2);
    asofLabels(raw8y, { dates: two, cache });
    const changed: RawIndicatorHistory = { ...raw8y, VIX: raw8y.VIX!.map((p, i) => (i === 0 ? { ...p, value: p.value + 1 } : p)) };
    const spy = spyOn(run, "runRegime");
    try {
      asofLabels(changed, { dates: two, cache });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(cache.n.hit).toBe(0);
      expect(cache.n.set).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  test("the cache key names the as-of day and the input hash", () => {
    const a = labelCacheKey("2024-03-01", "aa");
    expect(a).not.toBe(labelCacheKey("2024-03-08", "aa"));
    expect(a).not.toBe(labelCacheKey("2024-03-01", "bb"));
  });

  test("every indicator is present per date, a number or null, never NaN; a missing indicator is null", () => {
    const { VIX: _drop, ...noVix } = raw8y;
    const labels = asofLabels(noVix, { dates: ten.slice(0, 3) });
    for (const l of labels) {
      expect(Object.keys(l.indicators).sort()).toEqual(INDICATORS.map((i) => i.id).sort());
      for (const v of Object.values(l.indicators)) {
        if (v !== null) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
      expect(l.indicators.VIX).toBeNull();
      expect(Object.values(l.indicators).filter((v) => v !== null).length).toBeGreaterThan(10);
      expect(JSON.stringify(l)).not.toContain("NaN");
    }
  });
});

describe("hindsight on the 8-year fixture", () => {
  test("the fixture is the file PROVENANCE.md records", () => {
    const prov = readFileSync(join(import.meta.dir, "fixtures/PROVENANCE.md"), "utf8");
    const sha = createHash("sha256").update(text8y).digest("hex");
    expect(prov).toContain(`\`allocate/raw-indicator-history-8y.csv\` sha256 \`${sha}\``);
  });

  test(
    "1 of 419 weekly as-of labels differs from one full-history run, as published",
    () => {
      const labels = asofLabels(raw8y, { dates: decisionDates(START, END) });
      expect(labels.length).toBe(419);
      const h = hindsight(raw8y, labels, END);
      expect(h.compared).toBe(419);
      expect(h.differ).toBe(1);
      expect(h.dates).toEqual(["2018-10-22"]);
    },
    { timeout: 900_000 },
  );
});
