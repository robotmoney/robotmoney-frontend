// Analytics orchestrator — the PRODUCTION pipeline of one run (issue 1765,
// phase 3: a thin wrapper over the stage modules). Mirrors agentjuno/robotmoney
// scripts/regime/update.js main() over Postgres:
//
//   extract.ts  load the persisted raw floor once, fetch every series via the
//               source in one acquisition pass, merge, and write back only
//               the points that change the floor;
//   inputs.ts   the day rule, the committed ledger read (AN-16), the model's
//               slice of it (or the committed floor), the ratio step and the
//               input evidence;
//   compute.ts  one runModel call and one publishedRows call for the regime
//               model (the SDK's engine and row builder), and the two research
//               signals from REAL inputs;
//   publish.ts  begin the ledger run before any source call, freeze the
//               vintage, submit telemetry and the one terminal package.
//
// A producer regime tick runs every live model over ONE extract and ONE
// committed read (producer/index.ts runRegimeTick); runAnalytics runs one model
// (and the research signals) for one run, as every worker, script and test
// caller does.
//
// Run semantics (as-of, forward-fill, replay): docs/technical/regime-engine.md
// section 8.1. The preparation seam is D59 in docs/decisions.md: the SDK's
// runModel reaches prepareRegimeInputs through its prepare stage.
//
// HONESTY MODEL: the production default source is `liveDataSource` (real fetchers,
// NO synthetic data). A failed/empty fetch degrades to the persisted-real floor via
// mergeSeries; an indicator with NO history at all is excluded (all-NaN → weight 0
// by inverseCorrelationWeights' minValidObs) and logged loudly. The seededProvider
// is retained ONLY for the hermetic unit-test tools (analyze/regime.ts etc.) and is
// never referenced on this path. Tests inject a fixture-backed AnalyticsDataSource.
import { DAY_RULE, type DayRule, type Panel } from "./analyze/indicators.ts";
import { CURRENT_REGIME_VERSION, REGIME_LINE, type RegimeVersion } from "./analyze/regime-versions.ts";
import { modelOf } from "../../../packages/analyst-sdk/src/model/models.ts";
import { liveDataSource, type AnalyticsDataSource, type Logger } from "./access/data-source.ts";
import { hermeticDataSource } from "./access/hermetic-source.ts";
import type { AnalyticsPersistence } from "./persistence.ts";
import { analyticsApiClient } from "./api-client.ts";
import { telemetryHttpSink } from "./telemetry-client.ts";
import type { TelemetrySink } from "./telemetry.ts";
import { extract, sourceLabelOf, type Extraction } from "./extract.ts";
import { dayRuleInput, modelInputs, readCommitted, reportInputEvidence, scoredDay, type ModelInputs } from "./inputs.ts";
import { computeModel, computeResearch } from "./compute.ts";
import { RESEARCH_SIGNAL_TELEMETRY_KEYS, beginLedgerRun, finishLedgerRun, freezeRunVintage } from "./publish.ts";

export { RESEARCH_SIGNAL_TELEMETRY_KEYS };

// ─── The ONE analytics source knob ──────────────────────────────────────────
// `ANALYTICS_SOURCE` is the single, authoritative selector the orchestrator (and
// therefore the worker/api that call runAnalytics) honors:
//
//   unset      → live       (production default: real keyless fetchers)
//   "live"     → live       (explicit opt-in — smokes that want REAL numbers)
//   "hermetic" → hermetic   (deterministic, offline seeded — CI + the smoke default)
//
// Any other value is REFUSED loudly (fail-closed, mirroring config.ts RM_ENV) so a
// typo like "seeded"/"prod" can never silently fall through to the live network.
//
// `ANALYTICS_SOURCE` is the only knob the live/smoke data path reads (the legacy
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

// `toolId` alias meaning "both research signals in ONE run" (issue #509).
// Not a tool in its own right — it produces no output of its own; it selects
// the same two tools the per-tool ids select, but inside a single
// orchestrator invocation so the shared research-input fetch (and its live
// EDGAR sweep) is paid for exactly once. Also the telemetry `kind` for such a
// run: research_pipeline_runs.kind is free text, so 'research' is a new,
// distinct value rather than an overload of an existing one.
export const RESEARCH_TOOL_GROUP = "research";

// Run the analytics suite (or one tool) for `asof`, persisting each output.
// `source` defaults to the real live fetchers; tests inject a fixture source.
//
// PERSISTENCE BOUNDARY (issue #106): this orchestrator never writes SQL. Every
// read/write of the analytics tables goes through the injected
// AnalyticsPersistence port. The DEFAULT is the authenticated HTTP client
// (analytics/api-client.ts) — what the independent producer uses, wired from
// ANALYTICS_API_URL + its scoped bearer at call time. The API process (its
// swarm regime routes), tests, and smoke tooling inject the API-owned direct
// service (analytics/store/direct.ts) instead.
//
// TELEMETRY (issue #151): every access/extract/transform/analyze/store/report
// boundary this call actually executes is recorded into a TelemetryCollector
// and submitted ONCE at the end through the injected TelemetrySink — same
// port/default-HTTP/direct-SQL-for-API-and-tests split as AnalyticsPersistence
// above. Submission is STRICTLY best-effort (publish.ts finishLedgerRun). The
// outcome is attached to the returned object as a non-enumerable `__telemetry`
// property (invisible to `Object.keys`/JSON shape assertions) so callers that
// care — the worker handlers, which fold it into job_runs.output — can still
// see it.
//
// METHODOLOGY (issue 1652): `regimeVersion` is the regime methodology the run
// computes and stamps (methodology label, every row's `version`). The main-line
// run never passes it, so it is CURRENT_REGIME_VERSION (v4). A replay of a run
// stamped with an earlier version passes that version (v3) and computes it
// exactly as published. The version names its model (the SDK's MODELS): the
// model's history picks the engine (compute.ts).
//
// BESIDE THE MAIN LINE (issue 1753, decision D96): a run of a methodology
// REGIME_LINE declares `beside` (v5) is a normal run: it begins a ledger run
// stamped with that version, reads its committed inputs (the main-line regime
// keys plus the five collected keys its derived indicators read), freezes its
// vintage and submits one terminal package. A model that keeps its history
// reads the kept days before its as-of day and computes only that day (the
// first run walks every day). The API freezes its rows under
// `regime_beside_snapshots` and writes none to regime_snapshots.
// `opts.runSource` hands the run a source another run already took, so the
// two make one provider request per series.
export async function runAnalytics(
  asof: string,
  toolId?: string,
  source: AnalyticsDataSource = resolveAnalyticsSource(),
  persistence: AnalyticsPersistence = analyticsApiClient(),
  telemetry: TelemetrySink = telemetryHttpSink(),
  jobId?: number,
  regimeVersion: RegimeVersion = CURRENT_REGIME_VERSION,
  // Issue 1655, the day rule (default DAY_RULE, "score-newest": score `asof`,
  // as before). Under "require-complete": when `asof` is the run's UTC date
  // (what the producer passes), score the latest complete day on or before it;
  // an explicit earlier day (a replay or catch-up) that is not complete fails
  // the whole run. `now` is the run time, a parameter so tests pin it.
  // `panels` is the composite's panel set (default PANELS, issue 1708); a test
  // replaying an older composite passes its set explicitly.
  opts: { dayRule?: DayRule; now?: Date; panels?: Panel[]; runSource?: AnalyticsDataSource } = {},
): Promise<Record<string, unknown>> {
  const logger: Logger = console;
  // `toolId` is one tool id, the RESEARCH_TOOL_GROUP alias, or omitted (whole
  // suite). The alias exists because the two research signals SHARE one
  // `fetchResearchInputs` call — and therefore one live EDGAR sweep. Running
  // them as two separate runAnalytics invocations paid for that sweep twice
  // per cycle (~400 requests and up to 2×15min every full-sweep day) and
  // threw the first result away, since only the late-cycle-signals branch
  // persists it (issue #509).
  const wanted = toolId === RESEARCH_TOOL_GROUP ? new Set<string>(RESEARCH_SIGNAL_TELEMETRY_KEYS) : null;
  const want = (id: string) => (wanted ? wanted.has(id) : !toolId || toolId === id);
  const regime = want("regime");
  const research = { channelDivergence: want("channel-divergence"), lateCycle: want("late-cycle-signals") };
  const wantsResearch = research.channelDivergence || research.lateCycle;
  const sourceLabel = sourceLabelOf(source);
  // Issue 1514: one provider request per symbol for the whole run. The live
  // source shares one fetch memo across the collectors this run calls.
  const runSource = opts.runSource ?? source.forRun?.({ regime, research: wantsResearch }) ?? source;
  const model = modelOf(regimeVersion);
  if (model.history === "kept" && !persistence.loadKeptRegimeDays) {
    throw new Error(`regime methodology ${regimeVersion} keeps its history: the persistence must read its kept days (loadKeptRegimeDays)`);
  }

  // ── ISSUE #977: the immutable run ledger ────────────────────────────────
  // beginRun MUST succeed BEFORE `source` is ever called; deliberately outside
  // the try/catch below (publish.ts beginLedgerRun).
  const run = await beginLedgerRun(persistence, { asof, toolId: toolId ?? "suite", sourceLabel, version: regimeVersion, jobId: jobId ?? null });
  const now = opts.now ?? new Date();

  try {
    // ══ EXTRACT ════════════════════════════════════════════════════════════
    // The day the regime scores: `asof`, or under require-complete the latest
    // complete day on or before it (issue 1655), checked before anything is written.
    let day = asof;
    const ex: Extraction = await extract({
      asof,
      source: runSource,
      persistence,
      sourceLabel,
      jobId: jobId ?? null,
      logger,
      log: run.collector,
      regime,
      research: wantsResearch ? { lateCycle: research.lateCycle } : null,
      checkDay: (merged, startedAt) => {
        day = scoredDay(dayRuleInput(merged), regimeVersion, model, { asof, dayRule: opts.dayRule ?? DAY_RULE, now, log: run.collector, logger, startedAt });
      },
    });

    // ══ DOWNSTREAM: committed data only, no `source` call below ════════════
    // AN-16 (owner decision): the regime computes from the ledger heads, read at
    // one database-clock cutoff after every acquisition of this run; the
    // vintage freezes that cutoff and the exact versions read (issue 1534). A
    // source whose registry fetch records no acquisition (the hermetic and
    // fixture sources) has no ledger input: the regime computes from the
    // committed floor.
    let inputs: ModelInputs | null = null;
    if (regime && ex.fetched && ex.merged && ex.committedFloor && ex.extras) {
      const collected = { fetched: ex.fetched, merged: ex.merged, committedFloor: ex.committedFloor, extras: ex.extras };
      const t0 = new Date();
      // Issue 1753: a run beside the main line names its methodology, so the
      // read (and the vintage) also covers the collected keys it reads.
      const committed = persistence.loadCommittedInputs && ex.registryInLedger
        ? await readCommitted(persistence, asof, now, REGIME_LINE[regimeVersion] === "beside" ? regimeVersion : undefined)
        : null;
      inputs = modelInputs(collected, committed, model, ex.inputEvidence);
      run.droppedRatios = inputs.droppedRatios;
      if (committed) run.collector.stage("store", "ok", `read ${committed.values.length} ledger head(s) at ${committed.knowledgeTimeCutoff}, the cutoff the vintage freezes`, t0);
    }
    const evidence = inputs?.evidence ?? ex.inputEvidence;
    if (evidence.registry || evidence.acquiredKeys > 0) reportInputEvidence(evidence, run.collector, logger);

    // ── REGIME: one model, one runModel and one publishedRows ───────────────
    if (inputs) await computeModel(run, { version: regimeVersion, model, day, inputs, panels: opts.panels, persistence, logger });

    // ── RESEARCH SIGNALS ────────────────────────────────────────────────────
    if (wantsResearch && ex.research && ex.floor) {
      computeResearch(run, { inputs: ex.research, floor: ex.floor, regimeInput: inputs?.registry ?? null, wanted: research, logger });
    }

    // ── ISSUE #977: freeze the data vintage (publish.ts) ────────────────────
    await freezeRunVintage(persistence, run, { knowledgeTimeCutoff: inputs?.knowledgeTimeCutoff ?? null, ...(inputs?.regimeVersionIds ? { regimeVersionIds: inputs.regimeVersionIds } : {}) });
  } catch (e) {
    run.failed = e;
  }
  return finishLedgerRun(persistence, telemetry, run, logger);
}
