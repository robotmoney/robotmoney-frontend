// Extract stage: supplementary series (analyst SDK requirements section 4; D79).
// The platform cannot carry the full history of every asset an analyst wants, so
// the SDK ships source clients for the common providers instead of making each
// analyst write one. `fetchSupplementary("yahoo:GC=F", { start, end })` returns
// the observations in the window and says what they are (`field`). It writes
// nothing: `bun run fetch` (bin/fetch.ts) stores the result in the supplementary
// directory. Like every source client it reaches the network only through
// ./http.ts.
import type { Point } from "../types.ts";
import { splitSourceId, SupplementaryError } from "../input/supplementary.ts";
import { fetchFred } from "./fred.ts";
import { fetchYahoo, yfUrl } from "./yahoo.ts";
import { NoObservationsError } from "./model-portfolio.ts";

export interface SupplementaryWindow {
  /** First date to keep, `YYYY-MM-DD`. */
  start: string;
  /** Last date to keep, `YYYY-MM-DD`, inclusive. */
  end: string;
}

export interface FetchedSeries {
  points: Point[];
  /** What each value is. */
  field: string;
  /** The endpoint, for the manifest's `fetched_by`. */
  endpoint: string;
}

const unix = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The providers `fetchSupplementary` has a source client for. */
export const SUPPLEMENTARY_PROVIDERS = ["yahoo", "fred"] as const;

/** Fetch one supplementary series over `window`. Throws SupplementaryError for a provider with no client and
 *  NoObservationsError when the window holds no observation. */
export async function fetchSupplementary(id: string, window: SupplementaryWindow): Promise<FetchedSeries> {
  const { provider, symbol } = splitSourceId(id);
  if (!(window.start <= window.end)) throw new SupplementaryError(`${id}: start ${window.start} is after end ${window.end}`);
  let fetched: FetchedSeries;
  if (provider === "yahoo") {
    // period2 is exclusive at the second: ask through the day after `end`
    const [p1, p2] = [unix(window.start), unix(addDays(window.end, 1))];
    fetched = {
      points: await fetchYahoo(symbol, p1, p2),
      field: "adjusted close (the close where Yahoo gives no adjusted close)",
      endpoint: yfUrl(symbol, p1, p2),
    };
  } else if (provider === "fred") {
    fetched = { points: await fetchFred(symbol, 15000, window.start), field: "value", endpoint: `FRED fredgraph.csv?id=${symbol}` };
  } else {
    throw new SupplementaryError(`${id}: no source client for provider ${provider}; the SDK fetches ${SUPPLEMENTARY_PROVIDERS.join(" and ")}`);
  }
  // one point per date, ascending; a repeated date keeps the later observation (the input loaders' rule)
  const byDate = new Map<string, number>();
  for (const p of fetched.points) if (window.start <= p.date && p.date <= window.end) byDate.set(p.date, p.value);
  const points = [...byDate].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, value]) => ({ date, value }));
  if (points.length === 0) throw new NoObservationsError(id, window.start);
  return { ...fetched, points };
}
