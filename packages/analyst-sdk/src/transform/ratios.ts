// The ratio step of a source-only run (analytics requirements 4.3, review
// findings SDK-10 and AN-4). Pure: no fs, env, db or network.
//
// A ratio indicator (COPPER_GOLD and the other Yahoo pairs) is a calculated
// value. A source-only input carries its two legs, each by its source id or
// its storage key (RATIO_LEG_MAPPING), and this step calculates the ratio with
// mergeRatioSeries and nothing else: no other rounding or reordering. A stored
// ratio, when the input has one (the historical replay contract), is used
// unchanged. One leg without the other is a missing input and throws
// MissingRatioLegError. No leg and no stored ratio leaves the ratio missing
// (the 4.2 rule: the indicator carries no weight).
import type { RawIndicatorHistory } from "../types.ts";
import { AmbiguousInputSeriesError, MissingRatioLegError, RATIO_LEG_MAPPING, type SeriesMapping } from "../series-ids.ts";
import { mergeRatioSeries } from "./grid.ts";

// Each ratio id to its two legs, numerator first.
const RATIO_LEGS: ReadonlyMap<string, readonly SeriesMapping[]> = (() => {
  const m = new Map<string, SeriesMapping[]>();
  for (const leg of RATIO_LEG_MAPPING) {
    const ratio = leg.consumer.slice("indicator:".length);
    (m.get(ratio) ?? m.set(ratio, []).get(ratio)!).push(leg);
  }
  return m;
})();

/**
 * `resolved` (resolveInputHistory(input)) with every ratio it does not store
 * calculated from the legs `input` names. Legs are read from `input`, since
 * resolution renames a leg another consumer also reads (backtest:ETH-USD is
 * the backtest's ETH). Returns `resolved` itself when no ratio is added.
 */
export function ratiosFromLegs(input: RawIndicatorHistory, resolved: RawIndicatorHistory): RawIndicatorHistory {
  let out = resolved;
  for (const [ratio, legs] of RATIO_LEGS) {
    if (Object.hasOwn(resolved, ratio)) continue;
    const [num, den] = legs.map((leg) => {
      const names = [leg.series, leg.storageKey].filter((n, i, a) => a.indexOf(n) === i && Object.hasOwn(input, n));
      if (names.length > 1) throw new AmbiguousInputSeriesError(leg.consumer, [names[0]!, names[1]!]);
      return names.length === 0 ? undefined : input[names[0]!]!;
    });
    if (num && den) {
      if (out === resolved) out = { ...resolved };
      out[ratio] = mergeRatioSeries(num, den);
    } else if (num || den) {
      throw new MissingRatioLegError(ratio, legs[num ? 1 : 0]!.series, legs[num ? 0 : 1]!.series);
    }
  }
  return out;
}
