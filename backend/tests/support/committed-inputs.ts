// Issue 1421 (review finding AN-15): the shared harness for the committed-input
// tests (tests/analytics-offline-replay.test.ts, tests/analytics-source-
// tolerance.test.ts). It drives the production orchestrator over real
// persistence with a source that acquires every series through the production
// captureSourceAcquisition path (so the ledger, its D56 tolerance decision and
// the committed values the sink hands back are all real), and that poisons
// every HTTP client and every acquisition seam the moment extract completes.
//
// Two observation sets:
//   base    — what the ledger and the floor hold after the first run;
//   second  — what the provider serves on the second run: within-tolerance
//             jitter on whole Yahoo series (VIX, SPX, BTC-USD) and one
//             material revision each on an exact registry key (T10Y2Y), an
//             extras key (ETH) and a research key (QQQ).
import type { AnalyticsDataSource, ResearchInputs } from "../../src/analytics/access/data-source.ts";
import { hermeticDataSource } from "../../src/analytics/access/hermetic-source.ts";
import { captureSourceAcquisition, type AcquisitionSink, type CommittedSourceValue, type SourceAcquisitionEvidence } from "../../src/analytics/source-ledger.ts";
import { TOP7 } from "../../src/analytics/analyze/research-signals.ts";
import type { Point, RawIndicatorHistory } from "../../src/analytics/types.ts";
import type { TelemetryRunSubmission, TelemetrySink } from "../../src/analytics/telemetry.ts";
import { variantInputs } from "./originals-source.ts";
import { poisonNetwork, type NetworkPoison } from "./network-poison.ts";

export const ASOF = "2026-08-15";
export const JITTER = 5e-7; // inside Yahoo's 1e-6 float32 tolerance (D56)

export interface Observations {
  registry: RawIndicatorHistory;
  /** The persisted MNA floor (EDGAR filing counts), seeded before the first run. */
  mna: Point[];
  extras: { spx: Point[]; eth: Point[]; tbill3m: Point[] };
  research: Omit<ResearchInputs, "mna" | "mnaRefresh">;
}

const scale = (pts: readonly Point[], f: number) => pts.map((p) => ({ date: p.date, value: p.value * f }));
const bumpLast = (pts: readonly Point[], f: (v: number) => number) =>
  pts.map((p, i) => (i === pts.length - 1 ? { date: p.date, value: f(p.value) } : { ...p }));

export async function baseObservations(): Promise<Observations> {
  const v = variantInputs("production");
  const r = await hermeticDataSource.fetchResearchInputs(ASOF);
  return {
    registry: v.registry,
    mna: r.mna,
    extras: v.extras,
    research: { btc: r.btc, qqq: r.qqq, spy: r.spy, rsp: r.rsp, top7: r.top7, margin: r.margin, conf: r.conf },
  };
}

/** The second run's provider output: jitter within tolerance plus one material revision per handoff. */
export function secondObservations(base: Observations): Observations {
  return {
    mna: base.mna,
    registry: {
      ...base.registry,
      VIX: scale(base.registry.VIX!, 1 + JITTER),
      T10Y2Y: bumpLast(base.registry.T10Y2Y!, (x) => x + 0.25),
    },
    extras: { ...base.extras, spx: scale(base.extras.spx, 1 + JITTER), eth: bumpLast(base.extras.eth, (x) => x * 1.01) },
    research: { ...base.research, btc: scale(base.research.btc, 1 + JITTER), qqq: bumpLast(base.research.qqq, (x) => x * 1.01) },
  };
}

/** What the ledger and floor hold after the second run: the base, plus only the material revisions. */
export function committedAfterSecond(base: Observations, second: Observations): Observations {
  return {
    mna: base.mna,
    registry: { ...base.registry, T10Y2Y: second.registry.T10Y2Y! },
    extras: { ...base.extras, eth: second.extras.eth },
    research: { ...base.research, qqq: second.research.qqq },
  };
}

export interface Acquired {
  evidence: SourceAcquisitionEvidence;
  committed: CommittedSourceValue[];
}

export interface PoisonedSource extends AnalyticsDataSource {
  /** Source method calls, in order. */
  calls: string[];
  /** Every acquisition the sink saved, with the committed values it handed back. */
  acquired: Acquired[];
  /** Calls to any source method or to the acquisition sink after extract completed. */
  afterExtract: string[];
  poison: NetworkPoison | null;
  restore(): void;
}

/**
 * A source that acquires `obs` through captureSourceAcquisition and, once the
 * `extractCalls`-th source call returns, poisons every HTTP client and turns
 * every further source call and sink save into a recorded, throwing call.
 * The MNA series is the persisted floor handed in edgarCtx (the live source's
 * no-new-months outcome), so it too is committed data.
 */
export function poisonedSource(obs: Observations, extractCalls: number): PoisonedSource {
  const calls: string[] = [];
  const acquired: Acquired[] = [];
  const afterExtract: string[] = [];
  let extracted = false;
  const self: PoisonedSource = {
    calls,
    acquired,
    afterExtract,
    poison: null,
    restore() {
      self.poison?.restore();
    },
    fetchIndicators: (_inds, _logger, sink) => step("fetchIndicators", async () => {
      const out: Record<string, Point[]> = {};
      for (const [id, pts] of Object.entries(obs.registry)) out[id] = await acquire(sink, `raw_indicator_history:${id}`, pts);
      return out;
    }),
    fetchBacktestExtras: (_logger, sink) => step("fetchBacktestExtras", async () => ({
      spx: await acquire(sink, "backtest:^GSPC", obs.extras.spx),
      eth: await acquire(sink, "backtest:ETH-USD", obs.extras.eth),
      tbill3m: await acquire(sink, "backtest:DTB3", obs.extras.tbill3m),
    })),
    fetchResearchInputs: (_asof, _logger, edgarCtx, sink) => step("fetchResearchInputs", async (): Promise<ResearchInputs> => ({
      btc: await acquire(sink, "research:BTC-USD", obs.research.btc),
      qqq: await acquire(sink, "research:QQQ", obs.research.qqq),
      spy: await acquire(sink, "research:SPY", obs.research.spy),
      rsp: await acquire(sink, "research:RSP", obs.research.rsp),
      top7: await Promise.all(TOP7.map((sym, i) => acquire(sink, `research:${sym}`, obs.research.top7[i]!))),
      mna: edgarCtx?.persistedMna ?? [],
      margin: await acquire(sink, "research:MARGIN", obs.research.margin),
      conf: await acquire(sink, "research:CONF", obs.research.conf),
    })),
  };

  async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
    calls.push(name);
    if (extracted) {
      afterExtract.push(name);
      throw new Error(`AnalyticsDataSource.${name} called after extract: downstream stages never acquire`);
    }
    const result = await run();
    if (calls.length === extractCalls) {
      extracted = true;
      self.poison = poisonNetwork();
    }
    return result;
  }

  async function acquire(sink: AcquisitionSink | undefined, sourceKey: string, points: readonly Point[]): Promise<Point[]> {
    if (!sink) throw new Error("the committed-input harness needs the orchestrator's acquisition sink");
    const recording: AcquisitionSink = {
      async saveSourceAcquisition(evidence) {
        if (extracted) {
          afterExtract.push(`saveSourceAcquisition ${sourceKey}`);
          throw new Error("acquisition saved after extract");
        }
        const saved = await sink.saveSourceAcquisition(evidence);
        acquired.push({ evidence, committed: saved.committed ?? [] });
        return saved;
      },
    };
    return captureSourceAcquisition(
      { provider: "fixture", sourceKey, parserVersion: "committed-inputs-fixture:1", cacheIdentity: sourceKey },
      recording,
      async () => points.map((p) => ({ date: p.date, value: p.value })),
    );
  }

  return self;
}

/** A telemetry sink that keeps every submission, so a test can read the input evidence artifact. */
export function capturingTelemetry(): TelemetrySink & { runs: TelemetryRunSubmission[] } {
  const runs: TelemetryRunSubmission[] = [];
  return { runs, async submitRun(run) { runs.push(run); return { ok: true }; } };
}
