// The ratio step of a run (analytics requirements 4.3, review findings SDK-10
// and AN-4, issue 1644). Pure: no fs, env, db or network.
//
// A ratio indicator (COPPER_GOLD and the other Yahoo pairs) is a calculated
// value over two symbols. Each symbol has two legs, one per Yahoo close:
// `yahoo:<SYMBOL>.close` and `yahoo:<SYMBOL>.adjclose`. Two declared
// parameters per ratio (analyze/indicators.ts) decide what the run reads:
//   - ratioInput "stored": a stored ratio in the input is used unchanged (the
//     historical replay contract); without one the ratio is calculated from
//     the selected legs.
//   - ratioInput "legs": the ratio is always calculated from the selected
//     legs, and a stored ratio is ignored.
//   - ratioClose "adjusted" selects the `.adjclose` legs, "raw" the `.close`
//     legs. An adjusted leg may also be named as before issue 1644
//     (`yahoo:<SYMBOL>`, or `research:SPY`, `research:BTC-USD`,
//     `backtest:ETH-USD`); the `.adjclose` key wins when both are present.
// The ratio is mergeRatioSeries of the two selected legs and nothing else. One
// selected leg without the other is a missing input (MissingRatioLegError);
// the unselected close may be absent. No selected leg and no usable stored
// ratio leaves the ratio missing (the 4.2 rule: it carries no weight).
import type { Point, RawIndicatorHistory } from "../types.ts";
import { INDICATORS, isRatioIndicator, type Indicator } from "../analyze/indicators.ts";
import { AmbiguousInputSeriesError, MissingRatioLegError, indicatorConsumer, olderAdjustedLegNames, ratioLegSourceId } from "../series-ids.ts";
import { mergeRatioSeries } from "./grid.ts";
import { REGIME_KNOWLEDGE_TIME, type RegimeVersion } from "../analyze/regime-versions.ts";

/**
 * The ratio declarations a methodology version reads (issue 1733). A version
 * that reads by knowledge time reads the registry as declared (the equity
 * ratios from raw closes, so a later dividend never changes a past ratio).
 * Any other version (v3) reads every ratio as it was declared before:
 * ratioInput "stored", ratioClose "adjusted", so its runs replay byte for byte.
 */
export function ratioDeclarationsFor(version: RegimeVersion, indicators: readonly Indicator[] = INDICATORS): readonly Indicator[] {
  if (REGIME_KNOWLEDGE_TIME[version]) return indicators;
  return indicators.map((ind) => (isRatioIndicator(ind) ? { ...ind, ratioInput: "stored" as const, ratioClose: "adjusted" as const } : ind));
}

// One selected leg of a ratio: its `.close`/`.adjclose` id and, for an
// adjusted leg, its older names.
// `id` names the leg in an error: its new key, or its older source id when the
// input names its legs the older way.
function selectedLeg(input: RawIndicatorHistory, ind: Indicator, symbol: string): { id: string; older: string | null; points: Point[] | undefined } {
  const adjusted = ind.ratioClose !== "raw";
  const id = ratioLegSourceId(ind.source, symbol, adjusted ? "adjclose" : "close");
  if (Object.hasOwn(input, id)) return { id, older: null, points: input[id] };
  if (!adjusted) return { id, older: null, points: undefined };
  const names = olderAdjustedLegNames(ind.source, symbol);
  const older = names.filter((n) => Object.hasOwn(input, n));
  if (older.length > 1) throw new AmbiguousInputSeriesError(indicatorConsumer(ind.id), [older[0]!, older[1]!]);
  return { id, older: names[0]!, points: older.length === 0 ? undefined : input[older[0]!] };
}

/**
 * `resolved` (resolveInputHistory(input)) with each ratio set by its declared
 * ratioInput and ratioClose (`indicators`, default the registry). Legs are
 * read from `input`, since resolution renames a leg another consumer also
 * reads (backtest:ETH-USD is the backtest's ETH). Returns `resolved` itself
 * when no ratio changes.
 */
export function ratiosFromLegs(input: RawIndicatorHistory, resolved: RawIndicatorHistory, indicators: readonly Indicator[] = INDICATORS): RawIndicatorHistory {
  let out = resolved;
  const write = (id: string, pts: Point[] | undefined) => {
    if (out === resolved) out = { ...resolved };
    if (pts === undefined) delete out[id];
    else out[id] = pts;
  };
  for (const ind of indicators) {
    if (!isRatioIndicator(ind)) continue;
    const stored = ind.ratioInput !== "legs";
    if (stored && Object.hasOwn(resolved, ind.id)) continue;
    const [num, den] = (ind.series as string[]).map((sym) => selectedLeg(input, ind, sym)) as [ReturnType<typeof selectedLeg>, ReturnType<typeof selectedLeg>];
    if (num.points && den.points) write(ind.id, mergeRatioSeries(num.points, den.points));
    else if (num.points || den.points) {
      const [present, missing] = num.points ? [num, den] : [den, num];
      const olderNames = present.older !== null && !Object.hasOwn(input, present.id);
      throw new MissingRatioLegError(ind.id, olderNames ? missing.older! : missing.id, olderNames ? present.older! : present.id);
    }
    else {
      // Only the other close is present: the selected legs are a missing input.
      const other = (ind.series as string[]).flatMap((sym) => [ratioLegSourceId(ind.source, sym, ind.ratioClose === "raw" ? "adjclose" : "close")]).find((n) => Object.hasOwn(input, n));
      if (other !== undefined) throw new MissingRatioLegError(ind.id, num.id, other);
      // "legs" ignores a stored ratio: with no selected leg the ratio is missing.
      if (!stored && Object.hasOwn(resolved, ind.id)) write(ind.id, undefined);
    }
  }
  return out;
}
