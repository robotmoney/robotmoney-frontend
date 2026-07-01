// Analytics orchestrator — the PRODUCTION pipeline. Mirrors agentjuno/robotmoney
// scripts/regime/update.js main() over Postgres:
//
//   1. load the persisted raw floor (raw_indicator_history)
//   2. fetch every registry indicator via the real keyless fetchers
//   3. mergeSeries(persisted, fetched) per id — append-only: the persisted floor
//      is never deleted, the fetched value wins on overlap. Persist the merge back.
//   4. build the 2018-01-01..asof date axis, align (fwd/zero-fill) + applyTransform
//   5. computeRegime for the 2-panel [macro,onchain] composite AND the 3-panel
//      [+factor] extended composite; build the rich snapshot rows and persist them
//   6. compute + persist the two research signals from REAL inputs.
//
// HONESTY MODEL: the production default source is `liveDataSource` (real fetchers,
// NO synthetic data). A failed/empty fetch degrades to the persisted-real floor via
// mergeSeries; an indicator with NO history at all is excluded (all-NaN → weight 0
// by inverseCorrelationWeights' minValidObs) and logged loudly. The seededProvider
// is retained ONLY for the hermetic unit-test tools (analyze/regime.ts etc.) and is
// never referenced on this path. Tests inject a fixture-backed AnalyticsDataSource.
import { INDICATORS } from "./analyze/indicators.ts";
import { computeRegime, type RegimeComputeResult } from "./analyze/compute.ts";
import { applyTransform } from "./transform/transforms.ts";
import { buildDateAxis, alignDailyForwardFill, alignDailyZeroFill, mergeSeries } from "./transform/math.ts";
import { loadRawIndicatorHistory, saveRawIndicatorHistory } from "./store/raw-history-store.ts";
import { seedRawIndicatorFloor } from "./store/floor-seed.ts";
import { saveRegimeSnapshots, type RegimeSnapshotRow } from "./store/regime-store.ts";
import { persistResearchSignal } from "./store/research-store.ts";
import { computeChannelDivergence, computeLateCycle } from "./analyze/research-signals.ts";
import { computeCorrelations, type CorrelationsPayload } from "./analyze/correlations.ts";
import {
  computeBacktest,
  stripDailyFromSnapshot,
  type BacktestPayload,
} from "./analyze/backtest.ts";
import { CURRENT_REGIME_VERSION } from "./analyze/regime-versions.ts";
import { liveDataSource, type AnalyticsDataSource, type Logger } from "./access/data-source.ts";
import { hermeticDataSource } from "./access/hermetic-source.ts";

const BACKFILL_START = "2018-01-01"; // crypto on-chain coverage starts ~2018 cleanly

// ─── The ONE analytics source knob ──────────────────────────────────────────
// `ANALYTICS_SOURCE` is the single, authoritative selector the orchestrator (and
// therefore the worker/api that call runAnalytics) honors:
//
//   unset      → live       (production default: real keyless fetchers)
//   "live"     → live       (explicit opt-in — demos that want REAL numbers)
//   "hermetic" → hermetic   (deterministic, offline seeded — CI + the demo default)
//
// Any other value is REFUSED loudly (fail-closed, mirroring config.ts RM_ENV) so a
// typo like "seeded"/"prod" can never silently fall through to the live network.
//
// The legacy `PROVIDER` / `config.analyticsProvider` knob is NOT consulted here —
// it only fed the retired FetcherProvider test scaffolding (access/fetcher-provider.ts),
// never this orchestrator. See config.ts for its deprecation note. `ANALYTICS_SOURCE`
// is the only knob the live/demo data path reads.
const VALID_ANALYTICS_SOURCES = ["live", "hermetic"] as const;

export function resolveAnalyticsSource(): AnalyticsDataSource {
  const raw = process.env.ANALYTICS_SOURCE;
  if (raw === undefined || raw === "" || raw === "live") return liveDataSource;
  if (raw === "hermetic") return hermeticDataSource;
  throw new Error(
    `invalid ANALYTICS_SOURCE "${raw}" — expected one of ${VALID_ANALYTICS_SOURCES.join(" | ")} (or unset for the production live default)`,
  );
}

const nn = (v: number | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// Run the analytics suite (or one tool) for `asof`, persisting each output.
// `source` defaults to the real live fetchers; tests inject a fixture source.
export async function runAnalytics(
  asof: string,
  toolId?: string,
  source: AnalyticsDataSource = resolveAnalyticsSource(),
): Promise<Record<string, unknown>> {
  const logger: Logger = console;
  const want = (id: string) => !toolId || toolId === id;
  const results: Record<string, unknown> = {};

  let persisted: Awaited<ReturnType<typeof loadRawIndicatorHistory>> | null = null;
  const getPersisted = async () => (persisted ??= await loadRawIndicatorHistory());
  let mergedRaw: Record<string, { date: string; value: number }[]> | null = null;

  // ── REGIME ────────────────────────────────────────────────────────────────
  if (want("regime")) {
    // Opt-in cold-DB floor seed (issue #13): on the real-live demo path a fresh DB
    // would re-fetch years of history (esp. ~200 EDGAR requests) before the first
    // classify. ANALYTICS_FLOOR_SEED=1 loads the vendored real floor ONCE (idempotent
    // gap-fill; no-op once warm) so getPersisted() below sees it. Off by default →
    // CI/hermetic runs never touch it.
    if (process.env.ANALYTICS_FLOOR_SEED === "1") {
      await seedRawIndicatorFloor({ logger });
    }
    const floor = await getPersisted();
    const fetched = await source.fetchIndicators(INDICATORS, logger);

    const merged: Record<string, { date: string; value: number }[]> = {};
    let emptyFetches = 0;
    let excluded = 0;
    for (const ind of INDICATORS) {
      const prior = floor[ind.id] ?? [];
      const f = fetched[ind.id] ?? [];
      const m = mergeSeries(prior, f);
      merged[ind.id] = m;
      if (f.length === 0 && prior.length > 0) {
        emptyFetches++;
        logger.warn?.(`[analytics] ${ind.id}: fetch returned 0 rows — using persisted ${prior.length} rows (real floor, no synthetic fallback)`);
      }
      if (m.length === 0) {
        excluded++;
        logger.warn?.(`[analytics] ${ind.id}: NO history at all — excluded from composite (all-NaN → weight 0)`);
      }
    }
    if (emptyFetches > 0) logger.warn?.(`[analytics] ${emptyFetches} indicator(s) fell back to the persisted real floor`);
    if (excluded > 0) logger.warn?.(`[analytics] ${excluded} indicator(s) excluded entirely (no data)`);

    // Persist the append-only merged floor back before computing.
    await saveRawIndicatorHistory(merged);
    mergedRaw = merged;

    const dateAxis = buildDateAxis(BACKFILL_START, asof);
    const transformed: Record<string, number[]> = {};
    const lastRaw: Record<string, { date: string; value: number } | null> = {};
    for (const ind of INDICATORS) {
      const s = merged[ind.id] ?? [];
      lastRaw[ind.id] = s.length ? s[s.length - 1] : null;
      const aligner = ind.align === "zero_fill" ? alignDailyZeroFill : alignDailyForwardFill;
      transformed[ind.id] = applyTransform(ind.transform, aligner(s, dateAxis));
    }

    const r2 = computeRegime(transformed, dateAxis); // [macro, onchain]
    const r3 = computeRegime(transformed, dateAxis, ["macro", "onchain", "factor"]); // +factor

    // Predictive correlations + regime backtest — computed from the SAME 2-panel
    // composite the original main snapshot uses, over the chart-overlay extras
    // (SPX/ETH price levels + DTB3 yield; NOT registry indicators). A failed
    // extras fetch degrades to []: correlations/backtest simply carry fewer/no
    // pairs rather than throwing. Baked onto the latest snapshot row (asof view).
    const extras = await source.fetchBacktestExtras(logger);
    let backtest: BacktestPayload | null = null;
    let correlations: CorrelationsPayload | null = null;
    try {
      correlations = computeCorrelations(dateAxis, r2, extras);
      backtest = stripDailyFromSnapshot(computeBacktest(dateAxis, r2, extras));
    } catch (e: any) {
      logger.error?.(`[analytics] backtest/correlations failed: ${e?.message ?? e}`);
    }

    const rows = buildSnapshotRows(dateAxis, r2, r3, transformed, lastRaw, backtest, correlations);
    await saveRegimeSnapshots(rows);

    const last = dateAxis.length - 1;
    results.regime = {
      asof,
      rows: rows.length,
      composite: nn(r2.composite[last]),
      compositePercentile: nn(r2.compositePercentile[last]),
      regime: r2.regime[last] ?? null,
    };
    logger.log?.(`[analytics] regime asof ${asof}: composite=${nn(r2.composite[last])} regime=${r2.regime[last] ?? "insufficient_history"} (${rows.length} rows)`);
  }

  // ── RESEARCH SIGNALS ────────────────────────────────────────────────────────
  if (want("channel-divergence") || want("late-cycle-signals")) {
    const inputs = await source.fetchResearchInputs(asof, logger);

    if (want("channel-divergence")) {
      // STABLES is a registry indicator → source it from the persisted raw floor
      // (matching channel-divergence.js, which reads raw-indicator-history.csv).
      const stables = mergedRaw?.STABLES ?? (await getPersisted()).STABLES ?? [];
      const payload = computeChannelDivergence(
        { btc: inputs.btc, qqq: inputs.qqq, spy: inputs.spy, stables },
        asof,
      );
      await persistResearchSignal("channel-divergence", asof, payload);
      results["channel-divergence"] = payload;
    }

    if (want("late-cycle-signals")) {
      const payload = computeLateCycle(
        { spy: inputs.spy, rsp: inputs.rsp, top7: inputs.top7, mna: inputs.mna, margin: inputs.margin, conf: inputs.conf },
        asof,
      );
      await persistResearchSignal("late-cycle-signals", asof, payload);
      results["late-cycle-signals"] = payload;
    }
  }

  return results;
}

// Back-compat: callers that just want today's regime persisted.
export async function runRegime(asof: string): Promise<void> {
  await runAnalytics(asof, "regime");
}

// ─── snapshot-row builder (mirrors update.js writeFullHistoryCsv + writeSnapshot) ─

function buildSnapshotRows(
  dateAxis: string[],
  r2: RegimeComputeResult,
  r3: RegimeComputeResult,
  transformed: Record<string, number[]>,
  lastRaw: Record<string, { date: string; value: number } | null>,
  backtest: BacktestPayload | null = null,
  correlations: CorrelationsPayload | null = null,
): RegimeSnapshotRow[] {
  const rows: RegimeSnapshotRow[] = [];
  const lastIdx = dateAxis.length - 1;
  for (let i = 0; i < dateAxis.length; i++) {
    if (!r2.regime[i]) continue; // days without enough history to classify are skipped
    const isLatest = i === lastIdx;

    // sign-aligned per-indicator percentile map (small; kept for every row).
    const percentiles: Record<string, number> = {};
    for (const ind of INDICATORS) {
      const s = r2.signed[ind.id]?.[i];
      if (typeof s === "number" && Number.isFinite(s)) percentiles[ind.id] = Number(s.toFixed(6));
    }

    // The full rich per-indicator objects (with sparkline + point-in-time panel
    // weight) are the asof-snapshot view — expensive and only meaningful for the
    // latest refresh (computeRegime exposes weights for the final refresh only).
    // Historical rows carry the numeric columns + percentiles map, matching the
    // original (regime-history.csv is per-date; regime-snapshot.json is asof-only).
    const indicators = isLatest ? buildRichIndicators(i, r2, r3, transformed, lastRaw, dateAxis) : [];
    const panelWeights = isLatest
      ? { macro: r2.weightsByPanel.macro, onchain: r2.weightsByPanel.onchain, factor: r3.weightsByPanel.factor }
      : null;

    rows.push({
      date: dateAxis[i],
      composite: nn(r2.composite[i]),
      compositePercentile: nn(r2.compositePercentile[i]),
      regime: r2.regime[i] ?? null,
      macroRegime: r2.macroRegime?.[i] ?? null,
      onchainRegime: r2.onchainRegime?.[i] ?? null,
      factorRegime: r3.factorRegime?.[i] ?? null,
      macroIndex: nn(r2.macroIndex?.[i]),
      onchainIndex: nn(r2.onchainIndex?.[i]),
      factorIndex: nn(r3.factorIndex?.[i]),
      macroPercentile: nn(r2.macroPercentile?.[i]),
      onchainPercentile: nn(r2.onchainPercentile?.[i]),
      factorPercentile: nn(r3.factorPercentile?.[i]),
      panelWeights,
      version: CURRENT_REGIME_VERSION,
      percentiles,
      indicators,
      // Backtest + predictive correlations are asof-only (baked on the latest row,
      // matching the original snapshot); historical rows carry null.
      backtest: isLatest ? backtest : null,
      correlations: isLatest ? correlations : null,
    });
  }
  return rows;
}

function buildRichIndicators(
  i: number,
  r2: RegimeComputeResult,
  r3: RegimeComputeResult,
  transformed: Record<string, number[]>,
  lastRaw: Record<string, { date: string; value: number } | null>,
  dateAxis: string[],
) {
  return INDICATORS.map((ind) => {
    const weight =
      ind.panel === "factor" ? r3.weightsByPanel.factor?.[ind.id] : r2.weightsByPanel[ind.panel]?.[ind.id];
    return {
      id: ind.id,
      name: ind.name,
      panel: ind.panel,
      source: ind.source,
      sign: ind.sign,
      transform: ind.transform,
      unit: ind.unit ?? null,
      raw_value: lastRaw[ind.id]?.value ?? null,
      raw_date: lastRaw[ind.id]?.date ?? null,
      transformed_value: nn(transformed[ind.id]?.[i]),
      percentile: nn(r2.ranks[ind.id]?.[i]),
      signed_percentile: nn(r2.signed[ind.id]?.[i]),
      panel_weight: weight ?? null,
      sparkline: monthlySparkline(r2.signed[ind.id], dateAxis, 24),
    };
  });
}

// Trailing `months` calendar months → the last finite value in each month
// (oldest → newest). Missing months become null. Ported from update.js.
function monthlySparkline(series: number[] | undefined, dateAxis: string[], months: number): (number | null)[] {
  if (!series || series.length === 0) return [];
  const lastDate = dateAxis[dateAxis.length - 1];
  const [ly, lm] = lastDate.split("-").map(Number);
  const monthLast = new Map<string, number>();
  for (let i = 0; i < dateAxis.length; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) continue;
    monthLast.set(dateAxis[i].slice(0, 7), v);
  }
  const out: (number | null)[] = [];
  for (let k = months - 1; k >= 0; k--) {
    let y = ly;
    let m = lm - k;
    while (m <= 0) { m += 12; y -= 1; }
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const v = monthLast.get(ym);
    out.push(typeof v === "number" && Number.isFinite(v) ? v : null);
  }
  return out;
}
