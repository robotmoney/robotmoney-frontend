// The extract stage of an analytics run (issue 1765, phase 3; proposal section
// 6.4). Mirrors agentjuno/robotmoney scripts/regime/update.js main() over
// Postgres:
//
//   1. load the persisted raw floor (raw_indicator_history), ONCE;
//   2. fetch every series any live model reads (collectionRegistry: the
//      registry and the collected series, which include v5's five) via the
//      source, in ONE acquisition pass;
//   3. mergeSeries(persisted, fetched) per id: keys are never deleted, the
//      fetched value wins on overlap;
//   4. write back only the points that change the floor: a point with no
//      stored value, or one beyond its key's D56 tolerance of the stored value
//      (source-tolerance.ts, the store's own rule). A point within tolerance
//      keeps the stored value, so the floor as committed is built here from
//      the same rule, with no second read;
//   5. the backtest extras (cut at the as-of day) and the model portfolio
//      inventory, collected into the source ledger;
//   6. for a research run, the research inputs and the fresh MNA rows.
//
// Issue 1421: extract is the ONLY stage that calls the source, and it runs to
// completion before any computation. Everything downstream consumes the
// committed dataset it hands over (the committed floor and the ledger heads
// after the D56 tolerance decision), never the values the provider just
// served, and never calls the source again. Pinned by
// tests/analytics-offline-replay.test.ts and
// tests/analytics-source-tolerance.test.ts.
//
// A producer tick extracts once for every model it runs (producer/index.ts);
// a single run (runAnalytics, index.ts) extracts for itself. The raw floor is
// not a regime input on the ledger path (the analytics requirements: "the raw
// indicator table is not a regime compute input"). Its other readers read the
// table itself, never this run's copy: the store's own tolerance check
// (store/raw-history-store.ts), the floor seed (store/floor-seed.ts), the seed
// provenance and admin views, the public analytics archive, the gap detector,
// the cutover parity check and the series registry.
import { INDICATORS } from "./analyze/indicators.ts";
import { RATIO_IDS, STORED_RATIO_IDS, STORED_UNDER } from "./extras.ts";
import { mergeSeries } from "./transform/math.ts";
import { loadRawFloorSeed } from "./extract/floor-seed.ts";
import { COLLECTED_SERIES, collectionRegistry } from "./extract/collected-series.ts";
import { cutAtAsof } from "./prepare.ts";
import { rawIndicatorSourceKey, withinTolerance } from "./source-tolerance.ts";
import { selectEdgarRefreshTier, defaultEdgarRefreshDeadlineMs } from "./edgar-incremental-refresh.ts";
import { hermeticDataSource } from "./access/hermetic-source.ts";
import { liveDataSource, type AnalyticsDataSource, type BacktestExtras, type Logger, type ResearchInputs } from "./access/data-source.ts";
import type { AnalyticsPersistence } from "./persistence.ts";
import { emptyInputEvidence, evidenceSink, type InputEvidence, type StageLog } from "./inputs.ts";
import type { RawIndicatorHistory } from "./types.ts";

/** The provenance label of a source: what every row and run of it is tagged with (issue #397). */
export function sourceLabelOf(source: AnalyticsDataSource): string {
  return source === hermeticDataSource ? "hermetic" : source === liveDataSource ? "live" : "fixture";
}

/** One stage log written to several runs' collectors: a tick's one extract shows in every run's telemetry. */
export function fanOut(logs: readonly StageLog[]): StageLog {
  return {
    stage: (...a) => logs.forEach((l) => l.stage(...a)),
    warn: (...a) => logs.forEach((l) => l.warn(...a)),
    artifact: (...a) => logs.forEach((l) => l.artifact(...a)),
  };
}

/**
 * The points of `merged` the store would write over `floor`: each finite value
 * with no stored point, or one beyond its key's D56 tolerance of the stored
 * value. The same rule store/raw-history-store.ts applies, so a point left out
 * here is one the store would have skipped.
 */
export function changedPoints(floor: RawIndicatorHistory, merged: RawIndicatorHistory): RawIndicatorHistory {
  const out: RawIndicatorHistory = {};
  for (const [id, pts] of Object.entries(merged)) {
    const stored = new Map((floor[id] ?? []).map((p) => [p.date, p.value]));
    const key = rawIndicatorSourceKey(id);
    const changed = pts.filter((p) => {
      if (!Number.isFinite(p.value)) return false;
      const prior = stored.get(p.date);
      return prior === undefined || !withinTolerance(key, prior, p.value);
    });
    if (changed.length > 0) out[id] = changed;
  }
  return out;
}

/** `floor` with `changed` written over it, each series by date: what a read of the floor returns after the write. */
export function committedFloorOf(floor: RawIndicatorHistory, changed: RawIndicatorHistory): RawIndicatorHistory {
  const out: RawIndicatorHistory = { ...floor };
  for (const [id, pts] of Object.entries(changed)) {
    const byDate = new Map((floor[id] ?? []).map((p) => [p.date, p.value]));
    for (const p of pts) byDate.set(p.date, p.value);
    out[id] = [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([date, value]) => ({ date, value }));
  }
  return out;
}

/** What one extract hands the inputs stage. */
export interface Extraction {
  /** The persisted raw floor, read once (null when no stage read it). */
  floor: RawIndicatorHistory | null;
  /** What the registry fetch handed back: with an acquisition sink, the ledger's committed values. Null without a regime. */
  fetched: RawIndicatorHistory | null;
  /** The floor merged with the fetch, per stored series: what was COLLECTED, before the D56 decision. */
  merged: RawIndicatorHistory | null;
  /** The floor after the write, built locally under the store's tolerance rule. */
  committedFloor: RawIndicatorHistory | null;
  /** The backtest extras, cut at the as-of day. */
  extras: BacktestExtras | null;
  /** The acquisitions of this extract (input evidence without a registry comparison). */
  inputEvidence: InputEvidence;
  /** Whether the registry fetch recorded its values in the source ledger (AN-16): the regime then computes from the ledger. */
  registryInLedger: boolean;
  /** The research inputs, for a research run. */
  research: ResearchInputs | null;
  /** How many floor points the write sent (0 when nothing changed and no write was made). */
  savedPoints: number;
}

export interface ExtractOptions {
  asof: string;
  /** The run-scoped source (AnalyticsDataSource.forRun), so the run makes one provider request per series. */
  source: AnalyticsDataSource;
  persistence: AnalyticsPersistence;
  sourceLabel: string;
  jobId: number | null;
  logger: Logger;
  /** Where the stages are recorded: one run's collector, or every run of a tick (fanOut). */
  log: StageLog;
  /** Collect the regime's series (registry, collected series, extras, inventory). */
  regime: boolean;
  /** Collect the research inputs; `lateCycle` also writes the fresh MNA rows. */
  research: { lateCycle: boolean } | null;
  /**
   * Checked on the collected registry before anything is written (the day
   * rule, issue 1655): a throw fails the extract, and the floor is not written.
   */
  checkDay?: (merged: RawIndicatorHistory, startedAt: Date) => void;
}

export async function extract(o: ExtractOptions): Promise<Extraction> {
  const { asof, source, persistence, sourceLabel, logger, log } = o;
  const jobId = o.jobId;
  const inputEvidence = emptyInputEvidence();
  const sink = evidenceSink(persistence, inputEvidence);
  const out: Extraction = { floor: null, fetched: null, merged: null, committedFloor: null, extras: null, inputEvidence, registryInLedger: false, research: null, savedPoints: 0 };
  const readFloor = async () => (out.floor ??= await persistence.loadRawHistory());

  if (o.regime) {
    // Opt-in cold-DB floor seed (issue #13): on the real-live smoke path a fresh DB
    // would re-fetch years of history (esp. ~200 EDGAR requests) before the first
    // classify. ANALYTICS_FLOOR_SEED=1 parses the vendored real floor and submits
    // it through the seed-ingestion port (server-side gap-fill: existing rows win,
    // idempotent, no-op once warm) so the floor read below sees it. Off by
    // default → CI/hermetic runs never touch it.
    if (process.env.ANALYTICS_FLOOR_SEED === "1") {
      // The vendored floor still carries the *_GROWTH ids; they are no longer written (D74 amendment).
      // Issue 1644: a ratio declared ratioInput "legs" is not written; the ratio
      // legs go to the source ledger only (store/floor-seed.ts).
      const seed = Object.fromEntries(Object.entries(await loadRawFloorSeed()).filter(([id]) => !Object.hasOwn(STORED_UNDER, id) && !(RATIO_IDS.has(id) && !STORED_RATIO_IDS.has(id))));
      const res = await persistence.seedRawHistory(seed);
      if (res.seededPoints > 0) {
        logger.log?.(`[analytics] floor seed: wrote ${res.seededPoints} real rows across ${res.indicators} indicator(s) (cold-DB gap fill); ${res.existingPoints} already present`);
      } else {
        logger.log?.(`[analytics] floor seed: no-op — floor already warm (${res.existingPoints} rows present)`);
      }
    }
    let t0 = new Date();
    const floor = await readFloor();
    const acquiredBefore = inputEvidence.acquiredKeys;
    // Issue 1653: the registry and the collected series (BAA10Y, and the five
    // series v5's derived indicators read) are fetched alike, once.
    const fetched = await source.fetchIndicators(collectionRegistry(), logger, sink, jobId);
    out.registryInLedger = inputEvidence.acquiredKeys > acquiredBefore;
    log.stage("access", "ok", `fetched ${INDICATORS.length} registry indicator(s) from the ${sourceLabel} source`, t0);

    t0 = new Date();
    const merged: RawIndicatorHistory = {};
    let emptyFetches = 0;
    let excluded = 0;
    for (const ind of INDICATORS) {
      // D74 amendment (issue 1514): DEFI_GROWTH and STABLES_GROWTH are read
      // from the DEFI_TVL and STABLES series below; nothing is written for them.
      if (Object.hasOwn(STORED_UNDER, ind.id)) continue;
      // Issue 1644: a ratio declared ratioInput "legs" is never stored.
      if (RATIO_IDS.has(ind.id) && !STORED_RATIO_IDS.has(ind.id)) continue;
      const prior = floor[ind.id] ?? [];
      const f = fetched[ind.id] ?? [];
      const m = mergeSeries(prior, f);
      merged[ind.id] = m;
      if (f.length === 0 && prior.length > 0) {
        emptyFetches++;
        logger.warn?.(`[analytics] ${ind.id}: fetch returned 0 rows — using persisted ${prior.length} rows (real floor, no synthetic fallback)`);
        log.warn("extract", `${ind.id}: fetch returned 0 rows — using persisted ${prior.length} rows (real floor, no synthetic fallback)`);
      }
      if (m.length === 0) {
        excluded++;
        logger.warn?.(`[analytics] ${ind.id}: NO history at all — excluded from composite (all-NaN → weight 0)`);
        log.warn("extract", `${ind.id}: no history at all — excluded from composite`);
      }
    }
    // Issue 1653: a collected series is merged and stored like a registry
    // indicator, through the same D56 tolerance writer, but nothing scores it.
    // A failed or empty fetch is a warning on its own key only: it counts in no
    // fallback or exclusion, and changes no outcome, report or figure.
    const collectedOnly: RawIndicatorHistory = {};
    for (const s of COLLECTED_SERIES) {
      const prior = floor[s.id] ?? [];
      const f = fetched[s.id] ?? [];
      collectedOnly[s.id] = mergeSeries(prior, f);
      if (f.length === 0) logger.warn?.(`[analytics] ${s.id}: collected series fetch returned 0 rows — keeping persisted ${prior.length} rows (not scored)`);
    }
    if (emptyFetches > 0) logger.warn?.(`[analytics] ${emptyFetches} indicator(s) fell back to the persisted real floor`);
    if (excluded > 0) logger.warn?.(`[analytics] ${excluded} indicator(s) excluded entirely (no data)`);
    log.stage(
      "extract",
      excluded > 0 ? "warn" : emptyFetches > 0 ? "warn" : "ok",
      `merged persisted floor with fetched data: ${emptyFetches} fallback, ${excluded} excluded (of ${INDICATORS.length})`,
      t0,
    );

    // Issue 1655: the day rule reads the inputs this run collected, before the
    // floor is written, so an incomplete day persists no indicator row.
    o.checkDay?.(merged, t0);

    // Write back only what changes the floor, tagged with the source that
    // produced it (issue #397 provenance). Issue 1421 (review finding AN-15):
    // the run computes from the committed floor, never from a discarded jitter
    // value; the collected-versus-committed difference is reported in the input
    // evidence (inputs.ts).
    t0 = new Date();
    const all = { ...merged, ...collectedOnly };
    const changed = changedPoints(floor, all);
    out.savedPoints = Object.values(changed).reduce((n, pts) => n + pts.length, 0);
    if (out.savedPoints > 0) await persistence.saveRawHistory(changed, sourceLabel);
    out.fetched = fetched;
    out.merged = merged;
    out.committedFloor = committedFloorOf(floor, changed);
    log.stage("store", "ok", `persisted ${out.savedPoints} changed raw indicator point(s) of the merged floor`, t0);

    // Predictive correlations + regime backtest overlays (SPX/ETH price
    // levels + DTB3 yield; NOT registry indicators). A failed extras fetch
    // degrades to []: correlations/backtest simply carry fewer/no pairs
    // rather than throwing. Cut at asof like every other input (issue #1162
    // Part 0): a run for a past as-of day must not read prices dated after
    // it. Live runs have no such rows, so this changes nothing on the live
    // path; regime-sdk-equivalence pins it. With an acquisition sink these are
    // the ledger's committed values (captureSourceAcquisition, issue 1421).
    t0 = new Date();
    const fetchedExtras = await source.fetchBacktestExtras(logger, sink, jobId);
    out.extras = { spx: cutAtAsof(fetchedExtras.spx, asof), eth: cutAtAsof(fetchedExtras.eth, asof), tbill3m: cutAtAsof(fetchedExtras.tbill3m, asof) };
    log.stage("access", "ok", `fetched backtest extras from the ${sourceLabel} source`, t0);
    // Issue 1398: the model portfolio inputs are collected into the source
    // ledger in extract, on the same run. The regime reads none of them, so
    // the outcome is only logged and no number downstream changes.
    if (source.collectModelPortfolioInputs) {
      const collected = await source.collectModelPortfolioInputs(logger, sink, jobId);
      logger.log?.(`[analytics] model portfolio inputs: ${collected.map((c) => `${c.id}=${c.error ? "FAILED" : c.rows}`).join(" ")}`);
    }
  }

  if (o.research) {
    // Two-tier EDGAR refresh (R6 follow-up, docs/v0-v1-quant-platform-parity-
    // report.md finding 1.10): hand the live source its persisted MNA floor
    // + one hard deadline, sized to whichever tier THIS asof selects — a
    // cheap incremental sweep most days, a full [EDGAR_FLOOR_START, asof]
    // reconciliation sweep periodically (see selectEdgarRefreshTier in
    // edgar-incremental-refresh.ts) so an EDGAR back-revision to any
    // historical month still lands, just not on every single run. Hermetic/
    // fixture sources ignore this context entirely.
    const t0 = new Date();
    const floor = await readFloor();
    const edgarTier = selectEdgarRefreshTier(asof);
    const inputs = await source.fetchResearchInputs(asof, logger, {
      persistedMna: floor.MNA ?? [],
      deadlineAt: Date.now() + defaultEdgarRefreshDeadlineMs(edgarTier),
    }, sink, jobId);
    out.research = inputs;
    log.stage("access", "ok", `fetched research inputs from the ${sourceLabel} source`, t0);

    // Submit ONLY the freshly-fetched MNA rows (a small idempotent upsert
    // batch on (date, indicator)) — never the whole merged series — BEFORE
    // computing/publishing the dependent signal, so a signal is never
    // published against data that was never durably persisted. A degraded
    // refresh persists nothing (issue #109 AC5, handled downstream).
    const refresh = inputs.mnaRefresh;
    if (o.research.lateCycle && refresh && refresh.status !== "degraded" && refresh.newRows.length > 0) {
      const s0 = new Date();
      await persistence.saveRawHistory({ MNA: refresh.newRows }, sourceLabel);
      log.stage("store", "ok", `persisted ${refresh.newRows.length} freshly-fetched MNA row(s)`, s0);
    }
  }
  return out;
}
