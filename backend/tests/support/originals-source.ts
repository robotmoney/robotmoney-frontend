// Issue 1421: the fixture AnalyticsDataSource and in-memory persistence the
// backend originals were captured with (backend/scripts/capture-analytics-
// originals.ts), shared with the tests that compare against those originals.
//
// The source supplies one input variant (packages/analyst-sdk/tests/support/
// originals.ts): the registry indicators as raw history and SPX/ETH/TBILL3M as
// the backtest extras. It never touches the network, and every call is
// recorded so a test can assert when acquisition happened.
import type { AnalyticsDataSource, BacktestExtras, ResearchInputs } from "../../src/analytics/access/data-source.ts";
import type { AnalyticsPersistence } from "../../src/analytics/persistence.ts";
import type { TerminalRunPackageInput } from "../../src/analytics/output-snapshots.ts";
import type { Point, RawIndicatorHistory } from "../../src/analytics/types.ts";
import { INDICATORS } from "../../src/analytics/analyze/indicators.ts";
import { mergeSeries } from "../../src/analytics/transform/math.ts";
import { parseRawHistory, toHistory } from "../../../packages/analyst-sdk/src/input/load.ts";
import { variantCsv, type Variant } from "../../../packages/analyst-sdk/tests/support/originals.ts";

export interface VariantInputs {
  asof: string;
  registry: RawIndicatorHistory;
  extras: BacktestExtras;
}

export function variantInputs(variant: Variant): VariantInputs {
  const h = toHistory(parseRawHistory(variantCsv(variant)));
  const registry: RawIndicatorHistory = {};
  for (const ind of INDICATORS) if (h[ind.id]) registry[ind.id] = h[ind.id]!;
  let asof = "";
  for (const id in h) for (const p of h[id]!) if (p.date > asof) asof = p.date;
  return { asof, registry, extras: { spx: h.SPX ?? [], eth: h.ETH ?? [], tbill3m: h.TBILL3M ?? [] } };
}

export type SourceCall = "fetchIndicators" | "fetchBacktestExtras" | "fetchResearchInputs";

/** A network-free source over one variant; `calls` records every acquisition in order. */
export function variantSource(inputs: VariantInputs): AnalyticsDataSource & { calls: SourceCall[] } {
  const calls: SourceCall[] = [];
  const copy = (pts: readonly Point[]) => pts.map((p) => ({ date: p.date, value: p.value }));
  return {
    calls,
    async fetchIndicators() {
      calls.push("fetchIndicators");
      const out: Record<string, Point[]> = {};
      for (const [id, pts] of Object.entries(inputs.registry)) out[id] = copy(pts);
      return out;
    },
    async fetchBacktestExtras() {
      calls.push("fetchBacktestExtras");
      return { spx: copy(inputs.extras.spx), eth: copy(inputs.extras.eth), tbill3m: copy(inputs.extras.tbill3m) };
    },
    async fetchResearchInputs(): Promise<ResearchInputs> {
      calls.push("fetchResearchInputs");
      throw new Error("the originals were captured for toolId 'regime' only");
    },
  };
}

/** Persistence with no database: what the originals were captured through. */
export function inMemoryPersistence(): AnalyticsPersistence & { packages: TerminalRunPackageInput[]; floor: RawIndicatorHistory } {
  const floor: RawIndicatorHistory = {};
  const packages: TerminalRunPackageInput[] = [];
  return {
    floor,
    packages,
    async beginRun() { return { runId: "1", methodologyVersionId: "1", replayed: false }; },
    async appendRunEvent() {},
    async freezeVintage() {
      return { vintageId: "1", manifest: {} as never, memberCount: 0, replayed: false };
    },
    async submitTerminalRunPackage(input) {
      packages.push(input);
      return { outputSnapshots: [], reportSnapshotId: null, replayed: false };
    },
    async loadRawHistory() {
      const out: RawIndicatorHistory = {};
      for (const [id, pts] of Object.entries(floor)) out[id] = pts.map((p) => ({ ...p }));
      return out;
    },
    async saveRawHistory(byIndicator) {
      for (const [id, pts] of Object.entries(byIndicator)) floor[id] = mergeSeries(floor[id] ?? [], pts.filter((p) => Number.isFinite(p.value)));
    },
    async seedRawHistory() { return { seededPoints: 0, existingPoints: 0, indicators: 0 }; },
    async loadResearchSignalDates() { return []; },
    async loadRawHistoryGapDates() { return []; },
  };
}
