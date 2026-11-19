// Issue 1655: the analytics worker under the day rule. Driven
// through the real orchestrator (runAnalytics) with an in-memory persistence
// and a fixture source over the committed regime history:
//   - under require-complete, an explicit as-of day that is incomplete (HY_OAS
//     last observed more than its declared 120 days before it) fails the whole
//     run: no indicator row is written, the terminal package carries no regime
//     snapshot and no report, and the log names each missing indicator, its
//     last observation and the day;
//   - once the day is complete (the HY_OAS rows arrive), it publishes, and two
//     runs over the same complete inputs publish the same numbers;
//   - under require-complete, a run whose as-of day is its own UTC date (what
//     the producer passes) scores the latest complete day on or before it;
//   - under score-newest (shipped), the same incomplete day publishes the
//     figures main publishes for it.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { runAnalytics } from "../src/analytics/index.ts";
import type { AnalyticsPersistence } from "../src/analytics/persistence.ts";
import type { AnalyticsDataSource, ResearchInputs } from "../src/analytics/access/data-source.ts";
import type { TerminalRunPackageInput } from "../src/analytics/output-snapshots.ts";
import type { Indicator } from "../src/analytics/analyze/indicators.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { STORED_UNDER } from "../src/analytics/extras.ts";
import { latestCompleteDay } from "../src/analytics/prepare.ts";
import { TOP7 } from "../src/analytics/analyze/research-signals.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { IncompleteDayError, requireComplete, runRegime } from "../../packages/analyst-sdk/src/run.ts";
import type { Point } from "../src/analytics/types.ts";
import { loadJsonGz, loadRawIndicatorHistory } from "./fixtures/regime/load.ts";

type Rows = Record<string, Point[]>;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const cut = (h: Rows, day: string): Rows => Object.fromEntries(Object.entries(h).map(([id, rows]) => [id, rows.filter((r) => r.date <= day)]));

const history = (await loadRawIndicatorHistory()) as Rows;
const ex: any = await loadJsonGz("regime-extras.json.gz");
// D: a day the fixture holds complete. STALE: HY_OAS has no row after L, more
// than its declared 120 days before D, until its rows arrive.
const D = "2026-08-14";
const L = "2026-03-01";
const STALE_ID = "HY_OAS";
function early(): Rows {
  const h = cut(history, D);
  h[STALE_ID] = h[STALE_ID]!.filter((r) => r.date <= L);
  return h;
}
const lastHy = () => early()[STALE_ID]!.at(-1)!.date;
// An explicit replay of D, made later: require-complete applies its exact-day check.
const REQUIRE = { dayRule: "require-complete" as const, now: new Date("2026-11-19T00:00:00Z") };

function source(raw: Rows): AnalyticsDataSource {
  const research: ResearchInputs = { btc: [], qqq: [], spy: [], rsp: [], top7: TOP7.map(() => [] as Point[]), mna: [], margin: [], conf: [] };
  return {
    async fetchIndicators(indicators: Indicator[]) {
      return Object.fromEntries(indicators.map((ind) => [ind.id, (raw[ind.id] ?? []).map((p) => ({ ...p }))]));
    },
    async fetchResearchInputs() {
      return research;
    },
    async fetchBacktestExtras() {
      return { spx: cut({ x: ex.spx }, D).x!, eth: cut({ x: ex.eth }, D).x!, tbill3m: cut({ x: ex.tbill3m }, D).x! };
    },
  };
}

// An in-memory persistence: the floor, every write to it, and the terminal package.
function memory(floor: Rows = {}) {
  const state = { floor: structuredClone(floor) as Rows, floorWrites: 0, packages: [] as TerminalRunPackageInput[], beganAsof: [] as string[] };
  const persistence: AnalyticsPersistence = {
    beginRun: async (input) => {
      state.beganAsof.push(input.asof);
      return { runId: "1", methodologyVersionId: "1", replayed: false };
    },
    appendRunEvent: async () => {},
    freezeVintage: async () => ({
      vintageId: "1",
      manifest: { methodologyVersionId: "1", buildIdentity: "test", knowledgeTimeCutoff: "", marketTimeCutoff: "", seriesCount: 0, memberCount: 0, seriesFingerprints: {}, manifestDigest: "" },
      memberCount: 0,
      replayed: false,
    }),
    submitTerminalRunPackage: async (input) => {
      state.packages.push(input);
      return { outputSnapshots: [], reportSnapshotId: null, replayed: false };
    },
    loadRawHistory: async () => structuredClone(state.floor),
    saveRawHistory: async (byIndicator) => {
      state.floorWrites++;
      for (const [id, rows] of Object.entries(byIndicator)) {
        const m = new Map((state.floor[id] ?? []).map((p) => [p.date, p.value]));
        for (const p of rows) m.set(p.date, p.value);
        state.floor[id] = [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value }));
      }
    },
    seedRawHistory: async () => ({ seededPoints: 0, existingPoints: 0, indicators: 0 }),
    loadResearchSignalDates: async () => [],
    loadRawHistoryGapDates: async () => [],
  };
  return { state, persistence };
}

// The floor holds stored series only: DEFI_GROWTH and STABLES_GROWTH are read from DEFI_TVL and STABLES.
const stored = (h: Rows): Rows => Object.fromEntries(Object.entries(h).filter(([id]) => !Object.hasOwn(STORED_UNDER, id)));

// Console capture for this file only: installed before its tests and restored
// after them, so no other test file in the same process sees it.
const logs: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];
beforeAll(() => {
  spies = [spyOn(console, "error"), spyOn(console, "log"), spyOn(console, "warn")];
  for (const s of spies) s.mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
});
afterAll(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
});
afterEach(() => void (logs.length = 0));

describe("the analytics worker publishes only complete days", () => {
  test("the scenario: D is complete with every row, and the early inputs' latest complete day is HY_OAS's horizon", () => {
    expect(latestCompleteDay(cut(history, D), { notAfter: D })).toBe(D);
    expect(latestCompleteDay(early(), { notAfter: D })).toBe(addDays(lastHy(), 120));
    expect(INDICATORS.find((i) => i.id === STALE_ID)!.fill).toEqual({ kind: "forward", maxAgeDays: 120 });
  });

  test("an incomplete as-of day fails the run, persists no indicator row, composite, label or report, and logs the missing indicators and the day", async () => {
    const { state, persistence } = memory();
    const err = await runAnalytics(D, "regime", source(early()), persistence, noopTelemetrySink, undefined, undefined, REQUIRE).then((): unknown => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteDayError);
    expect((err as IncompleteDayError).incomplete).toEqual({ kind: "incomplete", asof: D, missing: [{ id: STALE_ID, lastObserved: lastHy() }] });
    // No indicator row was written.
    expect(state.floorWrites).toBe(0);
    expect(state.floor).toEqual({});
    // The one terminal package is a failure: no regime snapshot (composite, label) and no report.
    expect(state.packages.length).toBe(1);
    const pkg = state.packages[0]! as any;
    expect(pkg.status).toBe("failed");
    expect(pkg.regimeSnapshots).toBeUndefined();
    expect(pkg.reportBytes).toBeUndefined();
    // The log names each missing indicator and the affected day.
    const line = logs.find((l) => l.includes("is not complete"));
    expect(line).toBeDefined();
    expect(line).toContain(D);
    expect(line).toContain(`${STALE_ID} (last ${lastHy()})`);
  }, 300_000);

  test("once the day is complete, two runs over the same inputs publish the same numbers", async () => {
    const runs = [];
    for (let k = 0; k < 2; k++) {
      const { state, persistence } = memory();
      const results: any = await runAnalytics(D, "regime", source(cut(history, D)), persistence, noopTelemetrySink, undefined, undefined, REQUIRE);
      expect(state.packages.length).toBe(1);
      const pkg = state.packages[0]! as any;
      expect(pkg.status).toBe("succeeded");
      runs.push({ results, rows: pkg.regimeSnapshots, report: new TextDecoder().decode(pkg.reportBytes) });
    }
    expect(runs[0]!.results.regime.asof).toBe(D);
    expect(Number.isFinite(runs[0]!.results.regime.composite)).toBe(true);
    expect(runs[0]!.rows.at(-1).date).toBe(D);
    expect(JSON.stringify(runs[1]!.results)).toBe(JSON.stringify(runs[0]!.results));
    expect(JSON.stringify(runs[1]!.rows)).toBe(JSON.stringify(runs[0]!.rows));
    expect(runs[1]!.report).toBe(runs[0]!.report);
  }, 600_000);

  test("under require-complete, a run on its own UTC date scores the latest complete day on or before it, HY_OAS's horizon day", async () => {
    const { state, persistence } = memory();
    const now = new Date(`${D}T21:30:00Z`);
    const results: any = await runAnalytics(D, "regime", source(early()), persistence, noopTelemetrySink, undefined, undefined, { dayRule: "require-complete", now });
    const scored = addDays(lastHy(), 120);
    expect(state.beganAsof).toEqual([D]);
    expect(results.regime.asof).toBe(scored);
    const pkg = state.packages[0]! as any;
    expect(pkg.status).toBe("succeeded");
    expect(pkg.regimeSnapshots.at(-1).date).toBe(scored);
  }, 300_000);

  test("under score-newest (shipped), the same incomplete day publishes the figures main publishes for it", async () => {
    const { state, persistence } = memory();
    const results: any = await runAnalytics(D, "regime", source(early()), persistence, noopTelemetrySink);
    expect(results.regime.asof).toBe(D);
    const pkg = state.packages[0]! as any;
    expect(pkg.status).toBe("succeeded");
    const rows = pkg.regimeSnapshots;
    expect(rows.at(-1).date).toBe(D);
    // The SDK on the same inputs under the shipped values: main's figures (the
    // golden and equivalence tests pin those against main).
    const sdk = requireComplete(runRegime(early(), { asof: D }));
    expect(rows.at(-1).composite).toBe(sdk.result.composite.at(-1));
    expect(rows.at(-1).regime).toBe(sdk.result.regime.at(-1) ?? null);
    const hy = rows.at(-1).indicators.find((i: any) => i.id === STALE_ID);
    expect(hy.forward_fill_expired).toBe(true);
  }, 300_000);
});
