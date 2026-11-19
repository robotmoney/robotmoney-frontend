// The ratio-legs inputs shared by tests/prepare.test.ts and
// tests/rank-weights-equivalence.test.ts. The committed fixture stores the
// eight ratios. `sourceOnly` drops them and carries each ratio's two legs under
// their source ids instead. Each numerator is the stored ratio times its
// denominator, so the legs are real-shaped data; `stored` stores
// mergeRatioSeries(legs), the value a collector would have stored from the
// same legs. No bun:test import: this is a plain module.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeRatioSeries } from "../../src/transform/grid.ts";
import { parseRawHistory, toHistory } from "../../src/input/load.ts";
import { RATIO_IDS, RATIO_LEG_KEYS, olderAdjustedLegNames } from "../../src/series-ids.ts";
import { INDICATORS } from "../../src/analyze/indicators.ts";
import type { RawIndicatorHistory } from "../../src/types.ts";

export const fixture: RawIndicatorHistory = toHistory(parseRawHistory(readFileSync(join(import.meta.dir, "..", "fixtures", "raw-indicator-history.csv"), "utf8")));
export const RATIOS = [...RATIO_IDS];
// Each leg by its source id, except the one leg another indicator also reads.
const ETH_LEG = "backtest:ETH-USD";
// Issue 1644: the older names of the adjusted legs (yahoo:<SYMBOL>), still accepted.
export const legsOf = (ratio: string) =>
  (INDICATORS.find((i) => i.id === ratio)!.series as string[]).map((sym) => olderAdjustedLegNames("yahoo", sym).find((n) => n === ETH_LEG) ?? `yahoo:${sym}`) as [string, string];

// BTC_ETH's denominator leg is the fixture's ETH stream, named by its storage
// key backtest:ETH-USD (yahoo:ETH-USD alone would also name ETH_TREND's). Every other denominator is 4 on each ratio date.
export function legInputs(): { legs: RawIndicatorHistory; sourceOnly: RawIndicatorHistory; stored: RawIndicatorHistory } {
  const legs: RawIndicatorHistory = {};
  const dens = new Map<string, Map<string, number>>();
  const eth = new Map(fixture.ETH!.map((p) => [p.date, p.value]));
  for (const ratio of RATIOS) {
    const [, den] = legsOf(ratio);
    const d = dens.get(den) ?? dens.set(den, new Map()).get(den)!;
    for (const p of fixture[ratio]!) if (den !== ETH_LEG) d.set(p.date, 4);
  }
  dens.set(ETH_LEG, eth);
  for (const [den, m] of dens) legs[den] = [...m].map(([date, value]) => ({ date, value })).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const ratio of RATIOS) {
    const [num, den] = legsOf(ratio);
    const d = dens.get(den)!;
    legs[num] = fixture[ratio]!.filter((p) => d.has(p.date)).map((p) => ({ date: p.date, value: p.value * d.get(p.date)! }));
  }
  const base: RawIndicatorHistory = {};
  // The fixture's own legs (issue 1644) are left out: these inputs carry the synthetic legs only.
  for (const [k, v] of Object.entries(fixture)) if (!RATIOS.includes(k) && k !== "ETH" && !RATIO_LEG_KEYS.has(k)) base[k] = v;
  const sourceOnly = { ...base, ...legs };
  const stored: RawIndicatorHistory = { ...base, [ETH_LEG]: legs[ETH_LEG]! };
  for (const ratio of RATIOS) stored[ratio] = mergeRatioSeries(legs[legsOf(ratio)[0]]!, legs[legsOf(ratio)[1]]!);
  return { legs, sourceOnly, stored };
}
