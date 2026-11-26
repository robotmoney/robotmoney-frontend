// Issue 1431: replay one published production regime run from its frozen
// inputs and compare it with the row the run published for its as-of day.
//
// A thin adapter over the analyst SDK (issue 1765): the run is the SDK's
// runRegime with factor figures on, its rows are the SDK's publishedRows (the
// one row builder, the rows the producer freezes), and the comparison of the
// as-of rows is the SDK's compareRows. No tolerance: every compared field is
// compared exactly, in a fixed order, and the first field that differs is the
// run's result. Decision D78 (compensated arithmetic) moves numbers in their
// last bits, so a run published before it differs from its replay in those
// bits; `beyondRounding` names the fields that differ by more than that.
//
// The inputs are the run's vintage exactly as the SDK's format 1 reader writes
// them (`bun run inputs`, src/archive/format1.ts): stored value text, ratios as
// kind `calculated`, parsed with the replay contract. A replay over an archive
// copy reads the same vintage with the SDK's replayRun instead.
import { parseInput } from "../../../packages/analyst-sdk/src/input/load.ts";
import { requireComplete, runRegime } from "../../../packages/analyst-sdk/src/run.ts";
import { compareRows, publishedRows } from "../../../packages/analyst-sdk/src/replay/index.ts";
import { CURRENT_REGIME_VERSION, REGIME_PUBLISHED_PANELS, type RegimeVersion } from "../../../packages/analyst-sdk/src/analyze/regime-versions.ts";
import type { Panel } from "../../../packages/analyst-sdk/src/analyze/indicators.ts";
import type { RawIndicatorHistory } from "../../src/analytics/types.ts";

// The fields a replay compares, in order: the SDK's one list, re-exported here.
export { COMPARED_FIELDS } from "../../../packages/analyst-sdk/src/replay/index.ts";

// The as-of row of a published regime_snapshots artifact (the SDK's
// publishedRows), the fields a replay recomputes.
export interface PublishedAsofRow {
  date: string;
  regime: string | null;
  composite: number | null;
  compositePercentile: number | null;
  macroRegime: string | null;
  onchainRegime: string | null;
  factorRegime: string | null;
  macroIndex: number | null;
  onchainIndex: number | null;
  factorIndex: number | null;
  macroPercentile: number | null;
  onchainPercentile: number | null;
  factorPercentile: number | null;
  percentiles: Record<string, number>;
  correlations: unknown;
  backtest: unknown;
}

export interface ReplayOutcome {
  asof: string;
  match: boolean;
  // The first field in COMPARED_FIELDS that differs, with both values (canonical JSON).
  firstDiff: { field: string; published: string; replay: string } | null;
  // The as-of label on each side.
  publishedLabel: string | null;
  replayLabel: string | null;
  // Every differing field, for the report.
  differing: string[];
  // The differing fields whose difference is more than rounding (D78): a
  // changed label, null, key or integer, or a number moved by more than 1e-9
  // of its size. A field missing here but in `differing` moved only by rounding.
  beyondRounding: string[];
  // SHA-256 of the canonical JSON of every compared replay field: pins the
  // whole replayed row, so a recorded outcome can be asserted exactly. Null
  // when the replay labels no row for the as-of day.
  replaySha256: string | null;
  // Each compared field of the replayed row, as canonical JSON.
  fields: Record<string, string>;
}

/**
 * Replay a run's input file (replay contract text) as of `asof` and compare
 * with its published as-of row. `version` is the methodology version the run
 * was stamped with (issue 1652); a run replays under its own version.
 */
export function replayPublishedRun(inputText: string, asof: string, published: PublishedAsofRow | null, version?: RegimeVersion, panels?: readonly Panel[]): ReplayOutcome {
  return replayPublishedHistory(parseInput(inputText, { replay: true }).history, asof, published, version, panels);
}

// Every production run published before issue 1708 (D89) averaged macro and
// onchain only: the SDK's REGIME_PUBLISHED_PANELS.v3, the default of a v3
// replay. A caller that replays such a run under another version passes it.
export const PRODUCTION_PANELS: Panel[] = [...REGIME_PUBLISHED_PANELS.v3];

/**
 * The same replay from an input history already in memory (the backend's
 * vintage read through the D74 mapping). `version` defaults to the current
 * one, and `panels` to the panels that version's published runs average
 * (REGIME_PUBLISHED_PANELS).
 */
export function replayPublishedHistory(history: RawIndicatorHistory, asof: string, published: PublishedAsofRow | null, version?: RegimeVersion, panels?: readonly Panel[]): ReplayOutcome {
  const v = version ?? CURRENT_REGIME_VERSION;
  const run = requireComplete(runRegime(history, { asof, factor: true, version: v, panels: panels ?? REGIME_PUBLISHED_PANELS[v] }));
  const last = run.dateAxis.length - 1;
  if (run.dateAxis[last] !== asof) throw new Error(`replay date axis ends ${run.dateAxis[last]}, not the run's as-of day ${asof}`);
  const replay = publishedRows(run).find((r) => r.date === asof) ?? null;
  const c = compareRows(published, replay);
  return {
    asof,
    match: c.match,
    firstDiff: c.firstDiff,
    publishedLabel: published?.regime ?? null,
    replayLabel: replay?.regime ?? null,
    differing: c.differing,
    beyondRounding: c.beyondRounding,
    replaySha256: c.replaySha256,
    fields: c.fields,
  };
}
