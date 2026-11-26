// The inputs stage of a regime run (issue 1765, phase 3; proposal section 6.4).
//
// What one model computes from, and the evidence of it. extract.ts hands over
// what the tick collected (the floor it read once, the fetch, the merge, the
// floor as committed and the backtest extras); this module turns it into one
// model's input:
//
//   - the day rule (issue 1655): the day each model scores, checked on the
//     collected registry before anything is written;
//   - the committed read (AN-16): ONE read per tick, at one database-clock
//     cutoff, for the union of every live model's storage keys;
//   - slice: one model's share of that read, inputHistoryFromStorage of the
//     values under its own read keys (readKeysOf of its series mapping), and
//     the version ids its vintage freezes;
//   - the floor fallback: a source that records no acquisition (hermetic,
//     fixture) has no ledger input, and the model computes from the committed
//     floor extract.ts built;
//   - the ratio step (issue 1644) with the ratios it drops as stored-only
//     (D-h, the run's __droppedRatios);
//   - the input evidence (issue 1421): what was collected against what the run
//     computed from.
//
// Nothing here calls a source or writes: everything downstream of extract
// computes from committed data only (tests/analytics-offline-replay.test.ts).
import { INDICATORS, V5_INPUT_IDS, type DayRule } from "./analyze/indicators.ts";
import { LEDGER_EXTRA_KEYS, RATIO_IDS, inputHistoryFromStorage, readKeysOf, storedIndicatorId } from "./extras.ts";
import { derivedInputIds } from "../../../packages/analyst-sdk/src/transform/derived.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "../../../packages/analyst-sdk/src/transform/ratios.ts";
import { IncompleteDayError } from "../../../packages/analyst-sdk/src/run.ts";
import { BACKFILL_START } from "../../../packages/analyst-sdk/src/engine/run-model.ts";
import type { RegimeModel } from "../../../packages/analyst-sdk/src/model/models.ts";
import { latestCompleteDay, missingOnDay } from "./prepare.ts";
import type { RegimeVersion } from "./analyze/regime-versions.ts";
import type { AnalyticsPersistence, CommittedInputs } from "./persistence.ts";
import type { BacktestExtras, Logger } from "./access/data-source.ts";
import type { AcquisitionSink, SaveSourceAcquisitionResult, SourceAcquisitionEvidence } from "./source-ledger.ts";
import type { TelemetryCollector } from "./telemetry.ts";
import { sha256Hex } from "./run-ledger.ts";
import type { RawIndicatorHistory } from "./types.ts";

/** The stage-recording half of a run's TelemetryCollector. */
export type StageLog = Pick<TelemetryCollector, "stage" | "warn" | "artifact">;

// ─── committed-input evidence (issue 1421, review finding AN-15) ───────────
// What the run COLLECTED from its source against what it COMPUTED from: the
// committed floor and ledger heads. A within-tolerance re-observation keeps
// the stored value, so a mismatch here is jitter the ingestion boundary
// discarded (or a revision another writer committed first), never a value
// downstream saw. With an acquisition sink the swap happens at the ledger
// (captureSourceAcquisition), so the mismatch shows under `acquisitions`;
// `registry` catches a floor that disagrees with what was fetched.
// `versionsSha256` fingerprints the ledger versions consumed (source key and
// version id, sorted); the run's frozen vintage holds those same versions.
// Compact on purpose: telemetry previews are bounded (4 kB).
interface AcquisitionMismatch {
  mismatched: number;
  first: { date: string | null; collected: number; committed: number };
}

export interface InputEvidence {
  registry: { mismatched: number; indicators: Record<string, number> } | null;
  acquisitions: Record<string, AcquisitionMismatch>;
  acquiredKeys: number;
  acquiredValues: number;
  consumed: string[];
}

export const emptyInputEvidence = (): InputEvidence => ({ registry: null, acquisitions: {}, acquiredKeys: 0, acquiredValues: 0, consumed: [] });

function recordAcquisitionEvidence(out: InputEvidence, evidence: SourceAcquisitionEvidence, saved: SaveSourceAcquisitionResult): void {
  const key = evidence.values[0]?.sourceKey;
  if (!key) return;
  const committed = saved.committed ?? [];
  out.acquiredKeys++;
  out.acquiredValues += evidence.values.length;
  evidence.values.forEach((v, i) => {
    const c = committed[i];
    if (!c) return;
    out.consumed.push(`${v.sourceKey}:${c.versionId}`);
    if (c.value === v.value) return;
    const m = (out.acquisitions[key] ??= { mismatched: 0, first: { date: v.marketDate ?? v.marketInstant, collected: v.value, committed: c.value } });
    m.mismatched++;
  });
}

/**
 * The persistence's acquisition sink, recording what each save committed into
 * `evidence` (issue 1421): every acquisition's collected values are compared
 * with the committed values the ledger hands back. Undefined when the
 * persistence records no acquisition.
 */
export function evidenceSink(persistence: AnalyticsPersistence, evidence: InputEvidence): AcquisitionSink | undefined {
  const save = persistence.saveSourceAcquisition?.bind(persistence);
  if (!save) return undefined;
  return {
    async saveSourceAcquisition(acquisition) {
      const saved = await save(acquisition);
      recordAcquisitionEvidence(evidence, acquisition, saved);
      return saved;
    },
  };
}

/**
 * `resolved` with each ratio set by its declared ratioInput and ratioClose from
 * the legs `input` carries (analytics requirements 4.3, issue 1644), under the
 * model's rules. A ratio with nothing to read is [] (missing, no weight).
 * `dropped` (issue 1765, D-h) collects each ratio declared ratioInput "legs"
 * that is dropped because the input carries its stored ratio and neither leg,
 * through the same onStoredOnly hook the SDK's runRegime records droppedRatios
 * with (run.ts, transform/ratios.ts).
 */
export function withRatios(
  input: RawIndicatorHistory,
  resolved: RawIndicatorHistory,
  model: Pick<RegimeModel, "rules">,
  dropped?: string[],
): RawIndicatorHistory {
  // A stored ratio the fetch left empty is no stored ratio: on the platform an
  // empty stored ratio counts as absent, so it is never listed as dropped. A
  // source cannot tell "stored but empty" from "missing" (the committed floor
  // gives every indicator [] when it holds nothing).
  const present = Object.fromEntries(Object.entries(resolved).filter(([id, pts]) => !RATIO_IDS.has(id) || pts.length > 0));
  const out = { ...ratiosFromLegs(input, present, ratioDeclarationsFor(model.rules), (id) => void dropped?.push(id)) };
  for (const id of RATIO_IDS) out[id] ??= [];
  return out;
}

function registryEvidence(collected: RawIndicatorHistory, committed: RawIndicatorHistory): InputEvidence["registry"] {
  const indicators: Record<string, number> = {};
  let mismatched = 0;
  for (const [id, pts] of Object.entries(collected)) {
    const stored = new Map((committed[id] ?? []).map((p) => [p.date, p.value]));
    let n = 0;
    for (const p of pts) if (Number.isFinite(p.value) && stored.get(p.date) !== p.value) n++;
    if (n > 0) indicators[id] = n;
    mismatched += n;
  }
  return { mismatched, indicators };
}

/** Log the input evidence of one run and record it as the run's committed-input-evidence artifact. */
export function reportInputEvidence(evidence: InputEvidence, log: StageLog, logger: Logger): void {
  const acquiredMismatched = Object.values(evidence.acquisitions).reduce((n, a) => n + a.mismatched, 0);
  const registryMismatched = evidence.registry?.mismatched ?? 0;
  if (registryMismatched > 0 || acquiredMismatched > 0) {
    logger.log?.(
      `[analytics] committed inputs: ${registryMismatched} registry point(s) and ${acquiredMismatched} acquired value(s) ` +
        `across ${Object.keys(evidence.acquisitions).length} source key(s) differ from what was collected; downstream uses the committed values`,
    );
  }
  log.artifact("extract", "committed-input-evidence", {
    registry: evidence.registry,
    acquisitions: evidence.acquisitions,
    acquiredKeys: evidence.acquiredKeys,
    acquiredValues: evidence.acquiredValues,
    versionsSha256: evidence.consumed.length > 0 ? sha256Hex([...evidence.consumed].sort().join(",")) : null,
  });
}

// ─── the day rule (issue 1655) ─────────────────────────────────────────────

/** The registry series the day rule reads: each registry indicator from the collected floor, under its stored id. */
export function dayRuleInput(merged: RawIndicatorHistory): RawIndicatorHistory {
  const byInput: RawIndicatorHistory = {};
  for (const ind of INDICATORS) byInput[ind.id] = merged[storedIndicatorId(ind.id)] ?? [];
  return byInput;
}

/**
 * The day a model's regime scores. Under "score-newest" (DAY_RULE, declared)
 * the as-of day. Under "require-complete", when `asof` is the run's own UTC
 * date (what the producer passes) the latest complete day on or before it; an
 * explicit earlier day (a replay or catch-up) that is not complete throws
 * IncompleteDayError naming each missing indicator, after recording the error
 * on the run's extract stage. The caller checks it before the collected floor
 * is written, so an incomplete day persists nothing.
 */
export function scoredDay(
  byInput: RawIndicatorHistory,
  version: RegimeVersion,
  model: Pick<RegimeModel, "rules">,
  opts: { asof: string; dayRule: DayRule; now: Date; log: StageLog; logger: Logger; startedAt: Date },
): string {
  const { asof, dayRule, logger } = opts;
  if (dayRule === "score-newest") return asof;
  const runDate = opts.now.toISOString().slice(0, 10);
  const scored = asof === runDate ? latestCompleteDay(byInput, { notAfter: asof, notBefore: BACKFILL_START, version, rules: model.rules }) : null;
  if (scored !== null) {
    if (scored !== asof) logger.log?.(`[analytics] regime: ${asof} is not complete; scoring the latest complete day on or before it, ${scored}`);
    return scored;
  }
  const missing = missingOnDay(byInput, asof, undefined, version, model.rules);
  if (missing.length > 0) {
    const err = new IncompleteDayError({ kind: "incomplete", asof, missing });
    logger.error?.(`[analytics] regime ${err.message}; the run fails and persists nothing`);
    opts.log.stage("extract", "error", err.message, opts.startedAt);
    throw err;
  }
  return asof;
}

// ─── the committed read (AN-16) ────────────────────────────────────────────

/**
 * The database clock and, at it, the ledger heads of every storage key the
 * named models read, dated on or before `asof`: ONE read for a whole tick.
 * `methodology` is what the persistence names (none: the main-line keys). A
 * run for a day before its own UTC date is a replay: it reads each value known
 * by the end of that day, never a later revision (issue 1733).
 */
export async function readCommitted(
  persistence: AnalyticsPersistence,
  asof: string,
  now: Date,
  methodology?: string | readonly string[],
): Promise<CommittedInputs> {
  const today = now.toISOString().slice(0, 10);
  const knownBy = asof < today ? asof : undefined;
  return methodology === undefined ? persistence.loadCommittedInputs!(asof, knownBy) : persistence.loadCommittedInputs!(asof, knownBy, methodology);
}

/** One model's share of a committed read: the values under its own read keys, in read order. */
export function sliceValues(committed: CommittedInputs, model: Pick<RegimeModel, "seriesMapping">): CommittedInputs["values"] {
  const keys = new Set(readKeysOf(model.seriesMapping));
  return committed.values.filter((v) => keys.has(v.sourceKey));
}

/** One model's input history from its share of a committed read: inputHistoryFromStorage under its own mapping. */
export function slice(values: CommittedInputs["values"], model: Pick<RegimeModel, "seriesMapping">): RawIndicatorHistory {
  return inputHistoryFromStorage(values, model.seriesMapping);
}

// ─── one model's input ─────────────────────────────────────────────────────

/** What one model computes from, and what its vintage freezes. */
export interface ModelInputs {
  /** The model's input under the ids it reads: every registry indicator id and the raw inputs of its derived series. */
  registry: RawIndicatorHistory;
  /** The correlations' and the backtest's price levels. */
  extras: BacktestExtras;
  /** The ratios the ratio step dropped as stored-only (D-h). */
  droppedRatios: string[];
  /** This model's input evidence: the tick's acquisitions and its own registry comparison. */
  evidence: InputEvidence;
  /** The committed read's database clock (null for the floor fallback, which freezes at NOW). */
  knowledgeTimeCutoff: string | null;
  /** The versions this model computed from (its own read keys only), absent for the floor fallback. */
  regimeVersionIds?: string[];
}

/** What extract.ts hands the inputs stage. */
export interface CollectedRegime {
  fetched: RawIndicatorHistory;
  merged: RawIndicatorHistory;
  committedFloor: RawIndicatorHistory;
  extras: BacktestExtras;
}

const derivedInputsOf = (model: Pick<RegimeModel, "derived">): string[] => [...new Set(model.derived.flatMap(derivedInputIds))];

/**
 * One model's input from the tick's committed read (`committed`), or, with
 * none, from the committed floor. Collected and committed are compared under
 * the same ratio declarations (issue 1733: a v4 equity ratio is its raw legs'
 * ratio, not the stored one).
 */
export function modelInputs(
  collected: CollectedRegime,
  committed: CommittedInputs | null,
  model: RegimeModel,
  acquisitions: InputEvidence,
): ModelInputs {
  const collectedRegistry = withRatios(collected.fetched, collected.merged, model);
  const derived = derivedInputsOf(model);
  const dropped: string[] = [];
  let registry: RawIndicatorHistory = {};
  let extras: BacktestExtras;
  if (committed) {
    // Issue 1644: each ratio under its declared parameters (transform/ratios.ts).
    const values = sliceValues(committed, model);
    const ledgerInput = slice(values, model);
    const fromLedger = withRatios(ledgerInput, ledgerInput, model, dropped);
    for (const ind of INDICATORS) registry[ind.id] = fromLedger[ind.id] ?? [];
    for (const id of derived) registry[id] = fromLedger[id] ?? [];
    const X = LEDGER_EXTRA_KEYS;
    extras = { spx: fromLedger[X.spx.inputId] ?? [], eth: fromLedger[X.eth.inputId] ?? [], tbill3m: fromLedger[X.tbill3m.inputId] ?? [] };
    return {
      registry,
      extras,
      droppedRatios: dropped,
      evidence: { ...acquisitions, registry: registryEvidence(collectedRegistry, registry) },
      knowledgeTimeCutoff: committed.knowledgeTimeCutoff,
      regimeVersionIds: values.map((v) => v.versionId),
    };
  }
  // The floor fallback: the registry from the committed floor, and the raw
  // inputs of the model's derived series under their stored ids (the collected
  // series, and VIX under the denominator's id).
  const floor = collected.committedFloor;
  for (const ind of INDICATORS) registry[ind.id] = floor[storedIndicatorId(ind.id)] ?? [];
  for (const id of derived) {
    if (id === V5_INPUT_IDS.close) continue; // the backtest's ^GSPC closes, from the extras below
    registry[id] = floor[model.storedUnder[id] ?? id] ?? [];
  }
  // Issue 1644: each ratio under its declared parameters, from the legs this
  // source served when the ratio is not read as stored.
  registry = withRatios(collected.fetched, registry, model, dropped);
  const evidence = { ...acquisitions, registry: registryEvidence(collectedRegistry, registry) };
  extras = collected.extras;
  if (derived.includes(V5_INPUT_IDS.close)) registry[V5_INPUT_IDS.close] = extras.spx;
  return { registry, extras, droppedRatios: dropped, evidence, knowledgeTimeCutoff: null };
}
