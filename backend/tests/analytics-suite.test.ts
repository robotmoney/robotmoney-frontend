// End-to-end analytics suite (DB round-trip; ephemeral Postgres via preload.ts).
// Drives the REAL orchestrator (runAnalytics) with a FIXTURE-backed data source
// injected in place of the live fetchers, for the fixed ground-truth `asof`, then
// asserts:
//   1. regime_snapshots + both research_signals rows LANDED,
//   2. the persisted as-of composite / percentile / panel indices / regime match
//      the committed regime-history.csv (+ regime-snapshot.json) within the SAME
//      tolerances the fidelity tests use — tying the persistence path back to
//      methodology fidelity,
//   3. the append-only merge persisted raw_indicator_history (and a re-run with an
//      empty fetch NEVER erases the persisted real floor — the honesty invariant).
// Deterministic + network-free. Loud-fails if the DB is absent (preload never skips).
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import type { Point } from "../src/analytics/types.ts";
import type { Indicator } from "../src/analytics/analyze/indicators.ts";
import type { AnalyticsDataSource, ResearchInputs } from "../src/analytics/access/data-source.ts";
import { TOP7 } from "../src/analytics/analyze/research-signals.ts";
import { loadRawIndicatorHistory, loadRegimeHistory, loadJsonGz } from "./fixtures/regime/load.ts";

type JsonPt = { date: string; value: number | null };
const finitePts = (pts: JsonPt[] | undefined): Point[] =>
  (pts ?? [])
    .filter((p) => p.value != null && Number.isFinite(p.value))
    .map((p) => ({ date: p.date, value: p.value as number }));

// A fixture-backed source: regime indicators come from the vendored
// raw-indicator-history.csv (the aligned RAW floor); research inputs come from the
// committed channel-divergence / late-cycle JSON (whatever is embedded). Inputs not
// in the fixtures (RSP, the top-7 basket, SPY daily) are supplied empty — the
// research signals still LAND (their reproducible gauges are covered strictly by
// tests/research-fidelity.test.ts); this suite's strict ground-truth assertion is
// on the REGIME persistence path.
async function fixtureSource(): Promise<AnalyticsDataSource> {
  const raw = await loadRawIndicatorHistory();
  const cd: any = await loadJsonGz("channel-divergence.json.gz");
  const lc: any = await loadJsonGz("late-cycle-signals.json.gz");
  const research: ResearchInputs = {
    btc: finitePts(cd.btc_price),
    qqq: finitePts(cd.qqq_price),
    spy: finitePts(lc.spy_price),
    rsp: [],
    top7: TOP7.map(() => [] as Point[]),
    mna: finitePts(lc.indicators.mna_s4_monthly),
    margin: finitePts(lc.indicators.margin_debt_level),
    conf: finitePts(lc.indicators.consumer_conf_level),
  };
  return {
    async fetchIndicators(indicators: Indicator[]): Promise<Record<string, Point[]>> {
      const out: Record<string, Point[]> = {};
      for (const ind of indicators) out[ind.id] = (raw[ind.id] ?? []).map((p) => ({ date: p.date, value: p.value }));
      return out;
    },
    async fetchResearchInputs(): Promise<ResearchInputs> {
      return research;
    },
  };
}

test(
  "runAnalytics (fixture source) persists regime + both research signals AND matches ground truth",
  async () => {
    const snap: any = await loadJsonGz("regime-snapshot.json.gz");
    const ASOF: string = snap.asof; // 2026-06-29 — the committed ground-truth as-of
    const expected = await loadRegimeHistory();
    const gt = expected[expected.length - 1]; // the freshly-computed (non-frozen) as-of row
    expect(gt.date).toBe(ASOF);

    await sql`DELETE FROM regime_snapshots`;
    await sql`DELETE FROM raw_indicator_history`;
    await sql`DELETE FROM research_signals WHERE date = ${ASOF}`;

    const results = await runAnalytics(ASOF, undefined, await fixtureSource());
    expect(Object.keys(results).sort()).toEqual(["channel-divergence", "late-cycle-signals", "regime"]);

    // ── (1) regime_snapshots landed; latest persisted row IS the as-of day ──
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM regime_snapshots`;
    expect(count).toBeGreaterThan(2900);
    const [latest] = await sql`
      SELECT date::text AS date, composite, composite_percentile, regime,
             macro_index, onchain_index, macro_percentile, onchain_percentile,
             macro_regime, onchain_regime, factor_index, panel_weights, version,
             indicators
      FROM regime_snapshots ORDER BY date DESC LIMIT 1`;
    expect(latest.date).toBe(ASOF);

    // ── (2) ground-truth fidelity of the persisted as-of row (same <1e-6 bound) ──
    const TOL = 1e-6;
    expect(Math.abs(Number(latest.composite) - gt.composite)).toBeLessThan(TOL);
    expect(Math.abs(Number(latest.composite_percentile) - gt.composite_percentile)).toBeLessThan(TOL);
    expect(Math.abs(Number(latest.macro_index) - gt.macro_index)).toBeLessThan(TOL);
    expect(Math.abs(Number(latest.onchain_index) - gt.onchain_index)).toBeLessThan(TOL);
    expect(Math.abs(Number(latest.macro_percentile) - gt.macro_percentile)).toBeLessThan(TOL);
    expect(Math.abs(Number(latest.onchain_percentile) - gt.onchain_percentile)).toBeLessThan(TOL);
    expect(latest.macro_regime).toBe(gt.macro_regime);
    expect(latest.onchain_regime).toBe(gt.onchain_regime);
    expect(latest.regime).toBe(gt.regime);

    // also matches the committed regime-snapshot.json; the 3-panel [+factor] path
    // ran and persisted (factor_index + panel_weights.factor present).
    expect(Math.abs(Number(latest.composite) - snap.composite)).toBeLessThan(TOL);
    expect(latest.version).toBe("v3");
    expect(latest.factor_index).not.toBeNull();
    expect(latest.panel_weights?.factor).toBeDefined();
    // the as-of row carries the rich per-indicator objects (macro+onchain+factor)
    expect(Array.isArray(latest.indicators)).toBe(true);
    expect((latest.indicators as any[]).length).toBeGreaterThan(15);

    // ── (3) both research signals landed with a gauges array + richer payload ──
    for (const key of ["channel-divergence", "late-cycle-signals"]) {
      const rows = await sql`SELECT payload FROM research_signals WHERE signal_key = ${key} AND date = ${ASOF}`;
      expect(rows.length).toBe(1);
      const payload = rows[0].payload as any;
      expect(payload.asof).toBe(ASOF);
      expect(Array.isArray(payload.gauges)).toBe(true);
      expect(payload.gauges.length).toBeGreaterThan(0);
      expect(payload.indicators).toBeDefined(); // richer original-shaped series map
    }

    // ── (4) append-only raw floor persisted; a later EMPTY fetch never erases it ──
    const raw = await loadRawIndicatorHistory();
    const [{ n: t10Rows }] = await sql`SELECT COUNT(*)::int AS n FROM raw_indicator_history WHERE indicator = 'T10Y2Y'`;
    expect(t10Rows).toBe(raw.T10Y2Y.length);
    expect(t10Rows).toBeGreaterThan(0);

    // Re-run with a source whose fetch is EMPTY for every indicator → the merge must
    // preserve the persisted floor (honesty: degrade to real floor, never delete).
    const emptySource: AnalyticsDataSource = {
      async fetchIndicators(indicators: Indicator[]) {
        const out: Record<string, Point[]> = {};
        for (const ind of indicators) out[ind.id] = [];
        return out;
      },
      async fetchResearchInputs(): Promise<ResearchInputs> {
        return { btc: [], qqq: [], spy: [], rsp: [], top7: TOP7.map(() => []), mna: [], margin: [], conf: [] };
      },
    };
    await runAnalytics(ASOF, "regime", emptySource);
    const [{ n: t10After }] = await sql`SELECT COUNT(*)::int AS n FROM raw_indicator_history WHERE indicator = 'T10Y2Y'`;
    expect(t10After).toBe(t10Rows); // floor intact — nothing erased by an empty fetch
  },
  { timeout: 180_000 },
);
