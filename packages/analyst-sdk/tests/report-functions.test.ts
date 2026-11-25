// Issue 1751 (gap 6): the report functions the backend used to keep to itself
// are SDK functions, and return what the backend returned.
//
// The fixtures under tests/fixtures/report/ were recorded by running the
// backend's own code at commit ba5d541b9, the last commit before the move:
//   - regime-history-projection.json: rowToSnapshot, forHistory and
//     computeRegimeSnapshotStaleness of backend/src/analytics/report/
//     regime-projection.ts, and the pure tail of fetchRegimeSnapshots
//     (report/projections.ts), over three regime_snapshots rows. The first row
//     is the one backend/tests/regime-history-projection.test.ts projects; that
//     test reads this same file, so there is one copy.
//   - indicator-rows.json: buildRichIndicators and monthlySparkline of
//     backend/src/analytics/index.ts, over the indicator registry and seeded
//     series. A null inside a number array stands for NaN (JSON has no NaN).
// A registry edit that changes a served field (name, source, description) is a
// change to these rows: record the fixture again from the code and say so.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishesOver, selectPublications, type PublicationCandidate } from "../src/report/publication.ts";
import { canonicalArtifactBytes, canonicalStringify } from "../src/report/canonical.ts";
import {
  computeRegimeSnapshotStaleness,
  forHistory,
  rowToSnapshot,
  shapeRegimeSnapshots,
  type RegimeHistoryPoint,
  type RegimeSnapshot,
  type RegimeStaleness,
} from "../src/report/regime-snapshots.ts";
import { buildRichIndicators, monthlySparkline } from "../src/report/indicator-rows.ts";
import { INDICATORS } from "../src/analyze/indicators.ts";
import type { RegimeComputeResult } from "../src/analyze/compute.ts";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/report", name), "utf8")) as T;

describe("selectPublications (D83)", () => {
  const c = (key: string, runId: number, writtenOn: string, artifactId = runId): PublicationCandidate => ({ key, date: key, runId, artifactId, writtenOn });
  const picked = (candidates: PublicationCandidate[]) => Object.fromEntries([...selectPublications(candidates)].map(([k, v]) => [k, [v.runId, v.artifactId]]));

  test("picks the last candidate written during its day", () => {
    expect(picked([c("2026-09-26", 121, "2026-09-26"), c("2026-09-26", 128, "2026-09-26"), c("2026-09-26", 300, "2026-09-30")])).toEqual({ "2026-09-26": [128, 128] });
    // Input order does not matter, and the artifact id breaks a tie within one run.
    expect(picked([c("2026-09-26", 300, "2026-09-30"), c("2026-09-26", 128, "2026-09-26", 7), c("2026-09-26", 128, "2026-09-26", 9), c("2026-09-26", 121, "2026-09-26")])).toEqual({ "2026-09-26": [128, 9] });
  });

  test("otherwise picks the first candidate written after it", () => {
    expect(picked([c("2026-09-28", 249, "2026-09-30"), c("2026-09-28", 243, "2026-09-29"), c("2026-09-28", 243, "2026-09-29", 250)])).toEqual({ "2026-09-28": [243, 243] });
  });

  test("each key is selected on its own, and publishesOver is the pairwise rule", () => {
    const chosen = selectPublications([c("2026-09-21", 20, "2026-09-21"), c("2026-09-21", 65, "2026-09-24"), c("2026-09-28", 243, "2026-09-29")]);
    expect([...chosen.keys()].sort()).toEqual(["2026-09-21", "2026-09-28"]);
    expect(chosen.get("2026-09-21")!.runId).toBe(20);
    expect(publishesOver(c("2026-09-21", 20, "2026-09-21"), c("2026-09-21", 65, "2026-09-24"))).toBe(true);
    expect(publishesOver(c("2026-09-21", 65, "2026-09-24"), c("2026-09-21", 20, "2026-09-21"))).toBe(false);
    expect(selectPublications([]).size).toBe(0);
  });
});

describe("canonicalStringify", () => {
  test("sorts keys recursively, inside arrays too, and keeps array order", () => {
    expect(canonicalStringify({ b: 1, a: { d: [{ z: 1, y: 2 }, 3], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1},3]},"b":1}');
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });

  test("writes a Date as its ISO string, not as {}", () => {
    const at = new Date("2026-09-01T12:34:56.789Z");
    expect(canonicalStringify({ regime: { date: at }, list: [at] })).toBe('{"list":["2026-09-01T12:34:56.789Z"],"regime":{"date":"2026-09-01T12:34:56.789Z"}}');
  });

  test("canonicalArtifactBytes is the UTF-8 bytes of the canonical JSON of the rows", () => {
    const rows = [{ date: "2026-09-01", composite: 0.5, label: "é" }];
    expect(new TextDecoder().decode(canonicalArtifactBytes(rows))).toBe('[{"composite":0.5,"date":"2026-09-01","label":"é"}]');
  });
});

describe("regime-snapshots response shaping", () => {
  interface Shaped {
    latest: RegimeSnapshot | null;
    history: RegimeHistoryPoint[];
    staleness: RegimeStaleness;
  }
  const f = fixture<{
    sqlRows: unknown[];
    today: string;
    snapshots: RegimeSnapshot[];
    history: RegimeHistoryPoint[];
    response: Shaped;
    responseWithBacktest: Shaped;
    empty: Shaped;
  }>("regime-history-projection.json");

  test("rowToSnapshot and forHistory return the committed projection fixtures", () => {
    expect(f.sqlRows.length).toBe(3);
    const snapshots = f.sqlRows.map(rowToSnapshot);
    expect(snapshots).toEqual(f.snapshots);
    expect(snapshots.map(forHistory)).toEqual(f.history);
    for (const key of ["backtest", "correlations", "indicators", "percentiles"]) expect(f.history[2]).not.toHaveProperty(key);
  });

  test("shapeRegimeSnapshots returns { latest, history, staleness } equal to the fixtures", () => {
    const shaped = shapeRegimeSnapshots(f.snapshots, f.today);
    expect(Object.keys(shaped)).toEqual(["latest", "history", "staleness"]);
    expect(shaped).toEqual(f.response);
    // Byte for byte, key order included: what the endpoint serialises.
    expect(JSON.stringify(shaped)).toBe(JSON.stringify(f.response));
    expect(shaped.latest!.backtest).toBeNull();
    expect(shaped.staleness).toEqual(computeRegimeSnapshotStaleness(f.snapshots[2]!.indicators, f.today));
  });

  test("includeBacktest keeps latest.backtest, and no rows gives a null latest that reads stale", () => {
    const withBacktest = shapeRegimeSnapshots(f.snapshots, f.today, true);
    expect(JSON.stringify(withBacktest)).toBe(JSON.stringify(f.responseWithBacktest));
    expect(withBacktest.latest!.backtest).toEqual(f.snapshots[2]!.backtest!);
    const empty = shapeRegimeSnapshots([], f.today);
    expect(JSON.stringify(empty)).toBe(JSON.stringify(f.empty));
    expect(empty).toMatchObject({ latest: null, history: [], staleness: { asof: null, stale: true } });
  });
});

describe("per-indicator row detail", () => {
  type Series = Record<string, (number | null)[]>;
  const f = fixture<{
    inputs: {
      i: number;
      dateAxis: string[];
      r2: { weightsByPanel: Record<string, Record<string, number>>; ranks: Series; signed: Series };
      r3: { weightsByPanel: Record<string, Record<string, number>> };
      transformed: Series;
      lastRaw: Record<string, { date: string; value: number } | null>;
      ages: Series;
    };
    expected: Record<string, unknown>[];
    withoutAges: Record<string, unknown>[];
    sparklines: { series: (number | null)[]; months: number; expected: (number | null)[] }[];
  }>("indicator-rows.json");
  const nan = (xs: (number | null)[]): number[] => xs.map((v) => (v === null ? NaN : v));
  const revive = (s: Series): Record<string, number[]> => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, nan(v)]));
  const { i, dateAxis, lastRaw } = f.inputs;
  const r2 = { ...f.inputs.r2, ranks: revive(f.inputs.r2.ranks), signed: revive(f.inputs.r2.signed) } as unknown as RegimeComputeResult;
  const r3 = f.inputs.r3 as unknown as RegimeComputeResult;
  const transformed = revive(f.inputs.transformed);
  // What JSON serialisation writes, which is what the backend stores and serves.
  const served = (rows: unknown) => JSON.parse(JSON.stringify(rows)) as unknown;

  test("buildRichIndicators returns the rows the backend returned for the same inputs", () => {
    const rows = buildRichIndicators(i, r2, r3, transformed, lastRaw, dateAxis, revive(f.inputs.ages));
    expect(rows.map((r) => r.id)).toEqual(INDICATORS.map((ind) => ind.id));
    expect(served(rows)).toEqual(f.expected);
    expect(JSON.stringify(rows)).toBe(JSON.stringify(f.expected));
    // Not vacuous: the fixture holds an expired forward fill, a missing weight and a missing raw value.
    expect(rows.some((r) => r.forward_fill_expired)).toBe(true);
    expect(rows.some((r) => r.panel_weight === null)).toBe(true);
    expect(rows.some((r) => r.raw_value === null)).toBe(true);
  });

  test("buildRichIndicators without forward-fill ages reports no age and no expiry", () => {
    const rows = buildRichIndicators(i, r2, r3, transformed, lastRaw, dateAxis);
    expect(JSON.stringify(rows)).toBe(JSON.stringify(f.withoutAges));
    expect(rows.every((r) => r.forward_fill_age_days === null && r.forward_fill_expired === false)).toBe(true);
  });

  test("monthlySparkline returns the last finite value of each trailing month, null for a month without one", () => {
    expect(f.sparklines.length).toBe(4);
    for (const s of f.sparklines) expect(monthlySparkline(nan(s.series), dateAxis, s.months)).toEqual(s.expected);
    expect(f.sparklines[0]!.expected.length).toBe(24);
    expect(f.sparklines[0]!.expected).toContain(null);
    expect(monthlySparkline(undefined, dateAxis, 24)).toEqual([]);
    // Hand-checked: two values in January, none in February, one in March.
    expect(monthlySparkline([1, 2, NaN, 4], ["2026-01-05", "2026-01-20", "2026-02-10", "2026-03-02"], 4)).toEqual([null, 2, null, 4]);
  });
});
