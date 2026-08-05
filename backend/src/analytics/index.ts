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
import { INDICATORS, PANELS } from "./analyze/indicators.ts";
import { computeRegime, type RegimeComputeResult } from "./analyze/compute.ts";
import { applyTransform } from "./transform/transforms.ts";
import {
  buildDateAxis,
  alignDailyForwardFill,
  alignDailyZeroFill,
  forwardFillAge,
  MAX_FORWARD_FILL_DAYS,
  mergeSeries,
} from "./transform/math.ts";
import { loadRawFloorSeed } from "./extract/floor-seed.ts";
import type { RegimeSnapshotRow } from "./report/regime-projection.ts";
import type { AnalyticsPersistence } from "./persistence.ts";
import { analyticsApiClient } from "./api-client.ts";
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
import { selectEdgarRefreshTier, defaultEdgarRefreshDeadlineMs } from "./edgar-incremental-refresh.ts";
import {
  TelemetryCollector,
  submitTelemetrySafely,
  boundedPreview,
  type TelemetrySink,
  type TelemetryRunStatus,
} from "./telemetry.ts";
import { telemetryHttpSink } from "./telemetry-client.ts";

const BACKFILL_START = "2018-01-01"; // crypto on-chain coverage starts ~2018 cleanly
// R6 follow-up (two-tier EDGAR refresh, see edgar-incremental-refresh.ts):
// the hard-deadline budget the orchestrator grants the live source's EDGAR
// sweep now depends on which tier THIS asof selects — a cheap daily
// incremental sweep needs a fraction of what the periodic full
// reconciliation sweep needs. `selectEdgarRefreshTier`/
// `defaultEdgarRefreshDeadlineMs` are the single source of truth for that
// choice; this orchestrator and refreshEdgarIncremental itself both derive
// the SAME tier from the SAME `asof`, so they can never disagree.

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
// `ANALYTICS_SOURCE` is the only knob the live/demo data path reads (the legacy
// `PROVIDER` env knob and its test scaffolding were removed —
// review-maintainability-011).
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

// Issue #180: research-signal payloads (channel-divergence/late-cycle-signals)
// carry a full multi-year daily series (research-signals.ts::seriesOf), unlike
// results.regime above which is already small scalars. Migration 0018 documents
// research_pipeline_runs.summary as "small result summary ... never a full
// series" — the same bound the artifact previews already get via
// boundedPreview() (telemetry.ts). Apply that same truncation to ONLY the
// research-signal entries of the telemetry summary, leaving regime (and any
// other) entries untouched so regime telemetry behavior is unperturbed.
const RESEARCH_SIGNAL_TELEMETRY_KEYS = ["channel-divergence", "late-cycle-signals"] as const;
function boundedTelemetrySummary(raw: Record<string, unknown>): Record<string, unknown> {
  let out = raw;
  for (const key of RESEARCH_SIGNAL_TELEMETRY_KEYS) {
    if (key in raw) {
      if (out === raw) out = { ...raw };
      out[key] = boundedPreview(raw[key]);
    }
  }
  return out;
}

// Run the analytics suite (or one tool) for `asof`, persisting each output.
// `source` defaults to the real live fetchers; tests inject a fixture source.
//
// PERSISTENCE BOUNDARY (issue #106): this orchestrator never writes SQL. Every
// read/write of the analytics tables goes through the injected
// AnalyticsPersistence port. The DEFAULT is the authenticated HTTP client
// (analytics/api-client.ts) — what the independent producer uses, wired from
// ANALYTICS_API_URL + its scoped bearer at call time. The API process (its
// swarm regime routes), tests, and demo tooling inject the API-owned direct
// service (analytics/store/direct.ts) instead.
//
// TELEMETRY (issue #151): every access/extract/transform/analyze/store/report
// boundary this call actually executes is recorded into a TelemetryCollector
// and submitted ONCE at the end through the injected TelemetrySink — same
// port/default-HTTP/direct-SQL-for-API-and-tests split as AnalyticsPersistence
// above. Submission is STRICTLY best-effort (submitTelemetrySafely never
// throws): a telemetry outage can never affect the canonical analytics rows
// already written above, nor this function's return value. The outcome is
// attached to the returned object as a non-enumerable `__telemetry` property
// (invisible to `Object.keys`/JSON shape assertions) so callers that care —
// the worker handlers, which fold it into job_runs.output — can still see it.
export async function runAnalytics(
  asof: string,
  toolId?: string,
  source: AnalyticsDataSource = resolveAnalyticsSource(),
  persistence: AnalyticsPersistence = analyticsApiClient(),
  telemetry: TelemetrySink = telemetryHttpSink(),
  jobId?: number,
): Promise<Record<string, unknown>> {
  const logger: Logger = console;
  const want = (id: string) => !toolId || toolId === id;
  const results: Record<string, unknown> = {};
  const sourceLabel = source === hermeticDataSource ? "hermetic" : source === liveDataSource ? "live" : "fixture";
  const collector = new TelemetryCollector();
  let runFailed: unknown = null;

  let persisted: Awaited<ReturnType<AnalyticsPersistence["loadRawHistory"]>> | null = null;
  const getPersisted = async () => (persisted ??= await persistence.loadRawHistory());
  let mergedRaw: Record<string, { date: string; value: number }[]> | null = null;

  try {
  // ── REGIME ────────────────────────────────────────────────────────────────
  if (want("regime")) {
    // Opt-in cold-DB floor seed (issue #13): on the real-live demo path a fresh DB
    // would re-fetch years of history (esp. ~200 EDGAR requests) before the first
    // classify. ANALYTICS_FLOOR_SEED=1 parses the vendored real floor and submits
    // it through the seed-ingestion port (server-side gap-fill: existing rows win,
    // idempotent, no-op once warm) so getPersisted() below sees it. Off by
    // default → CI/hermetic runs never touch it.
    if (process.env.ANALYTICS_FLOOR_SEED === "1") {
      const res = await persistence.seedRawHistory(await loadRawFloorSeed());
      if (res.seededPoints > 0) {
        logger.log?.(`[analytics] floor seed: wrote ${res.seededPoints} real rows across ${res.indicators} indicator(s) (cold-DB gap fill); ${res.existingPoints} already present`);
      } else {
        logger.log?.(`[analytics] floor seed: no-op — floor already warm (${res.existingPoints} rows present)`);
      }
    }
    let t0 = new Date();
    const floor = await getPersisted();
    const fetched = await source.fetchIndicators(INDICATORS, logger);
    collector.stage("access", "ok", `fetched ${INDICATORS.length} registry indicator(s) from the ${sourceLabel} source`, t0);

    t0 = new Date();
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
        collector.warn("extract", `${ind.id}: fetch returned 0 rows — using persisted ${prior.length} rows (real floor, no synthetic fallback)`);
      }
      if (m.length === 0) {
        excluded++;
        logger.warn?.(`[analytics] ${ind.id}: NO history at all — excluded from composite (all-NaN → weight 0)`);
        collector.warn("extract", `${ind.id}: no history at all — excluded from composite`);
      }
    }
    if (emptyFetches > 0) logger.warn?.(`[analytics] ${emptyFetches} indicator(s) fell back to the persisted real floor`);
    if (excluded > 0) logger.warn?.(`[analytics] ${excluded} indicator(s) excluded entirely (no data)`);
    collector.stage(
      "extract",
      excluded > 0 ? "warn" : emptyFetches > 0 ? "warn" : "ok",
      `merged persisted floor with fetched data: ${emptyFetches} fallback, ${excluded} excluded (of ${INDICATORS.length})`,
      t0,
    );

    // Persist the append-only merged floor back before computing. Tag every
    // row with which AnalyticsDataSource actually produced it this run
    // (issue #397 provenance).
    t0 = new Date();
    await persistence.saveRawHistory(merged, sourceLabel);
    mergedRaw = merged;
    collector.stage("store", "ok", "persisted append-only merged raw indicator floor", t0);

    t0 = new Date();
    const dateAxis = buildDateAxis(BACKFILL_START, asof);
    const transformed: Record<string, number[]> = {};
    const lastRaw: Record<string, { date: string; value: number } | null> = {};
    // #402: forward-fill age per indicator (days since the last REAL observation).
    // zero_fill indicators aren't forward-filled — a gap there is a real "no flow"
    // 0, not a carried-forward stale value — so they're left out of `ages` entirely
    // and computeRegime never caps them.
    const ages: Record<string, number[]> = {};
    for (const ind of INDICATORS) {
      const s = merged[ind.id] ?? [];
      lastRaw[ind.id] = s.length ? s[s.length - 1] : null;
      const isZeroFill = ind.align === "zero_fill";
      const aligner = isZeroFill ? alignDailyZeroFill : alignDailyForwardFill;
      transformed[ind.id] = applyTransform(ind.transform, aligner(s, dateAxis));
      if (!isZeroFill) ages[ind.id] = forwardFillAge(s, dateAxis);
    }
    collector.stage("transform", "ok", `built ${dateAxis.length}-day date axis and aligned/transformed ${INDICATORS.length} indicator(s)`, t0);

    t0 = new Date();
    const r2 = computeRegime(transformed, dateAxis, PANELS, ages); // [macro, onchain]
    const r3 = computeRegime(transformed, dateAxis, ["macro", "onchain", "factor"], ages); // +factor

    // Predictive correlations + regime backtest — computed from the SAME 2-panel
    // composite the original main snapshot uses, over the chart-overlay extras
    // (SPX/ETH price levels + DTB3 yield; NOT registry indicators). A failed
    // extras fetch degrades to []: correlations/backtest simply carry fewer/no
    // pairs rather than throwing. Baked onto the latest snapshot row (asof view).
    const extras = await source.fetchBacktestExtras(logger);
    let backtest: BacktestPayload | null = null;
    let correlations: CorrelationsPayload | null = null;
    let analyzeStatus: "ok" | "warn" = "ok";
    try {
      correlations = computeCorrelations(dateAxis, r2, extras);
      backtest = stripDailyFromSnapshot(computeBacktest(dateAxis, r2, extras));
    } catch (e: any) {
      logger.error?.(`[analytics] backtest/correlations failed: ${e?.message ?? e}`);
      collector.warn("analyze", `backtest/correlations failed: ${e?.message ?? e}`);
      analyzeStatus = "warn";
    }
    const last = dateAxis.length - 1;
    collector.stage(
      "analyze",
      analyzeStatus,
      `computed regime composite=${nn(r2.composite[last])} regime=${r2.regime[last] ?? "insufficient_history"}`,
      t0,
    );
    collector.artifact("analyze", "regime-composite", {
      composite: nn(r2.composite[last]),
      compositePercentile: nn(r2.compositePercentile[last]),
      regime: r2.regime[last] ?? null,
    });

    t0 = new Date();
    const rows = buildSnapshotRows(dateAxis, r2, r3, transformed, lastRaw, ages, backtest, correlations, sourceLabel);
    collector.stage("report", "ok", `built ${rows.length} snapshot row(s) for persistence`, t0);

    t0 = new Date();
    await persistence.saveRegimeSnapshots(rows);
    collector.stage("store", "ok", `persisted ${rows.length} regime snapshot row(s)`, t0);

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
    // Two-tier EDGAR refresh (R6 follow-up, docs/v0-v1-quant-platform-parity-
    // report.md finding 1.10): hand the live source its persisted MNA floor
    // + one hard deadline, sized to whichever tier THIS asof selects — a
    // cheap incremental sweep most days, a full [EDGAR_FLOOR_START, asof]
    // reconciliation sweep periodically (see selectEdgarRefreshTier in
    // edgar-incremental-refresh.ts) so an EDGAR back-revision to any
    // historical month still lands, just not on every single run. Hermetic/
    // fixture sources ignore this context entirely.
    let t0 = new Date();
    const floor = await getPersisted();
    const edgarTier = selectEdgarRefreshTier(asof);
    const inputs = await source.fetchResearchInputs(asof, logger, {
      persistedMna: floor.MNA ?? [],
      deadlineAt: Date.now() + defaultEdgarRefreshDeadlineMs(edgarTier),
    });
    collector.stage("access", "ok", `fetched research inputs from the ${sourceLabel} source`, t0);

    if (want("channel-divergence")) {
      t0 = new Date();
      // STABLES is a registry indicator → source it from the persisted raw floor
      // (matching channel-divergence.js, which reads raw-indicator-history.csv).
      const stables = mergedRaw?.STABLES ?? floor.STABLES ?? [];
      const bundle = { btc: inputs.btc, qqq: inputs.qqq, spy: inputs.spy, stables };
      collector.stage(
        "transform",
        "ok",
        `assembled channel-divergence input bundle (btc=${bundle.btc.length}, qqq=${bundle.qqq.length}, spy=${bundle.spy.length}, stables=${bundle.stables.length} points)`,
        t0,
      );

      t0 = new Date();
      const payload = computeChannelDivergence(bundle, asof);
      collector.stage("analyze", "ok", "computed channel-divergence signal", t0);
      collector.artifact("report", "channel-divergence-signal", payload);

      t0 = new Date();
      await persistence.saveResearchSignal("channel-divergence", asof, payload);
      collector.stage("store", "ok", "persisted channel-divergence research signal", t0);

      results["channel-divergence"] = payload;
    }

    if (want("late-cycle-signals")) {
      const refresh = inputs.mnaRefresh;
      if (refresh) {
        logger.log?.(
          `[analytics] EDGAR MNA refresh: status=${refresh.status} planned=${refresh.plannedMonths} ` +
            `new=${refresh.newMonths} revised=${refresh.revisedMonths} fetched=${refresh.fetchedMonths} ` +
            `missing=${refresh.missingMonths} rejected=${refresh.rejectedMonths}`,
        );
      }
      t0 = new Date();
      const bundle = { spy: inputs.spy, rsp: inputs.rsp, top7: inputs.top7, mna: inputs.mna, margin: inputs.margin, conf: inputs.conf };
      collector.stage("transform", "ok", `assembled late-cycle-signals input bundle (mna=${bundle.mna.length} points)`, t0);

      if (refresh?.status === "degraded") {
        // HONESTY (issue #109 AC5): an incomplete incremental refresh must
        // NEVER turn into a recomputed/published late-cycle signal — no
        // partial history, no partial signal. Retain the last-good
        // persisted floor AND signal untouched this run.
        logger.warn?.(
          `[analytics] late-cycle-signals: EDGAR refresh degraded (${refresh.reason}) — ` +
            "retaining last-good signal, NOT recomputing/publishing this run",
        );
        collector.warn("analyze", `EDGAR MNA refresh degraded (${refresh.reason}) — retaining last-good signal, not recomputing`);
        collector.stage("analyze", "warn", `skipped recompute: EDGAR refresh degraded (${refresh.reason})`, t0);
        collector.stage("store", "warn", "skipped — retained last-good persisted signal, nothing new written", new Date());
        results["late-cycle-signals"] = { skipped: true, reason: refresh.reason };
      } else {
        // Submit ONLY the freshly-fetched rows (a small idempotent upsert
        // batch on (date, indicator)) — never the whole merged series —
        // BEFORE computing/publishing the dependent signal, so a signal is
        // never published against data that was never durably persisted.
        if (refresh && refresh.newRows.length > 0) {
          t0 = new Date();
          await persistence.saveRawHistory({ MNA: refresh.newRows }, sourceLabel);
          collector.stage("store", "ok", `persisted ${refresh.newRows.length} freshly-fetched MNA row(s)`, t0);
        }
        t0 = new Date();
        const payload = computeLateCycle(bundle, asof);
        collector.stage("analyze", "ok", "computed late-cycle-signals signal", t0);
        collector.artifact("report", "late-cycle-signals-signal", payload);

        t0 = new Date();
        await persistence.saveResearchSignal("late-cycle-signals", asof, payload);
        collector.stage("store", "ok", "persisted late-cycle-signals research signal", t0);
        results["late-cycle-signals"] = payload;
      }
    }
  }
  } catch (e) {
    runFailed = e;
  }

  // ── TELEMETRY SUBMISSION (issue #151, best-effort, non-fatal) ──────────────
  const overallStatus: TelemetryRunStatus = runFailed
    ? "failed"
    : collector.warnings.length > 0
      ? "degraded"
      : "succeeded";
  const submission = collector.build({
    kind: toolId ?? "suite",
    asof,
    source: sourceLabel,
    status: overallStatus,
    summary: runFailed ? { error: (runFailed as any)?.message ?? String(runFailed) } : boundedTelemetrySummary(results),
    jobId: jobId ?? null,
  });
  const telemetryOutcome = await submitTelemetrySafely(telemetry, submission, logger);
  // Non-enumerable so `Object.keys(results)`/JSON-shape assertions of the
  // canonical tool outputs are never affected by telemetry outcome exposure.
  Object.defineProperty(results, "__telemetry", { value: telemetryOutcome, enumerable: false, writable: true, configurable: true });

  if (runFailed) throw runFailed;
  return results;
}

// ─── snapshot-row builder (mirrors update.js writeFullHistoryCsv + writeSnapshot) ─

function buildSnapshotRows(
  dateAxis: string[],
  r2: RegimeComputeResult,
  r3: RegimeComputeResult,
  transformed: Record<string, number[]>,
  lastRaw: Record<string, { date: string; value: number } | null>,
  ages: Record<string, number[]> = {},
  backtest: BacktestPayload | null = null,
  correlations: CorrelationsPayload | null = null,
  source: string | null = null,
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
    const indicators = isLatest ? buildRichIndicators(i, r2, r3, transformed, lastRaw, dateAxis, ages) : [];
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
      source,
      percentiles,
      indicators,
      // Panel index cards rendered by the /regime view. Three panels: the 2-panel
      // composite (macro + on-chain) plus the display-only Equity factor index.
      // Asof-only, matching the other dashboard-level blobs below.
      panels: isLatest ? ["macro", "onchain", "factor"] : null,
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
  ages: Record<string, number[]> = {},
) {
  return INDICATORS.map((ind) => {
    const weight =
      ind.panel === "factor" ? r3.weightsByPanel.factor?.[ind.id] : r2.weightsByPanel[ind.panel]?.[ind.id];
    // #402: surface the forward-fill age/expiry alongside the existing raw_date
    // provenance so an indicator whose contribution has been capped reads as
    // visibly degraded — not silently dropped — in the same snapshot payload the
    // dashboard already renders raw_value/raw_date from.
    const ageDays = ages[ind.id]?.[i];
    const forwardFillExpired = Number.isFinite(ageDays) && (ageDays as number) > MAX_FORWARD_FILL_DAYS;
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
      forward_fill_age_days: Number.isFinite(ageDays) ? ageDays : null,
      forward_fill_expired: forwardFillExpired,
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
