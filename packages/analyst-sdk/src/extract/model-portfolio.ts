// Extract stage: the model portfolio inputs (issue 1398). One fetch per
// inventory series (inventory/model-portfolio.json), through the same HTTP seam
// as every other source (./http.ts), and a coverage description of what came
// back. Nothing is invented: an empty response is an error, a late start is a
// recorded limitation, and a proxy is never spliced in here.
import type { Point } from "../types.ts";
import { fetchYahoo } from "./yahoo.ts";
import { fetchFred } from "./fred.ts";
import { fetchLlamaYield } from "./defillama-yields.ts";
import { CALENDAR_SLACK_DAYS, type InventorySeries } from "./inventory.ts";

const unix = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The provider answered with no observation for the series (for example a pool or window before inception). */
export class NoObservationsError extends Error {
  override readonly name = "NoObservationsError";
  constructor(readonly id: string, readonly requestedStart: string) {
    super(`${id}: the provider returned no observations from ${requestedStart}`);
  }
}

/** The fetch or the parse failed (HTTP error, malformed body); the cause is kept. */
export class SeriesExtractError extends Error {
  override readonly name = "SeriesExtractError";
  constructor(readonly id: string, override readonly cause: unknown) {
    super(`${id}: extract failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export interface SeriesCoverage {
  id: string;
  requestedStart: string;
  firstDate: string;
  lastDate: string;
  rows: number;
  /** Each way the response falls short of the request, served as it is. Empty when none. */
  limitations: string[];
}

/** The raw provider fetch for one inventory series. Throws on HTTP or parse failure. */
export function fetchInventorySeries(s: InventorySeries): Promise<Point[]> {
  switch (s.provider) {
    case "yahoo":
      return fetchYahoo(s.symbol, unix(s.requestedStart));
    case "fred":
      return fetchFred(s.symbol);
    case "defillama-yields":
      return fetchLlamaYield(s.symbol);
  }
}

/** What `points` cover against the inventory entry. Throws NoObservationsError when there are none. */
export function describeCoverage(s: InventorySeries, points: readonly Point[]): SeriesCoverage {
  if (points.length === 0) throw new NoObservationsError(s.id, s.requestedStart);
  let first = points[0]!.date, last = points[0]!.date;
  for (const p of points) {
    if (p.date < first) first = p.date;
    if (p.date > last) last = p.date;
  }
  const limitations: string[] = [];
  if (first > addDays(s.requestedStart, CALENDAR_SLACK_DAYS)) {
    limitations.push(`${s.id} starts ${first}, after the requested start ${s.requestedStart}${s.limitation ? ` (recorded: ${s.limitation})` : ""}`);
  }
  if (s.inception > s.requestedStart && first > addDays(s.inception, CALENDAR_SLACK_DAYS)) {
    limitations.push(`${s.id} starts ${first}, after its recorded inception ${s.inception}`);
  }
  return { id: s.id, requestedStart: s.requestedStart, firstDate: first, lastDate: last, rows: points.length, limitations };
}

/** Fetch one series and describe its coverage. Every failure names the series; no row is invented. */
export async function extractInventorySeries(s: InventorySeries): Promise<{ id: string; points: Point[]; coverage: SeriesCoverage }> {
  let points: Point[];
  try {
    points = await fetchInventorySeries(s);
  } catch (e) {
    throw new SeriesExtractError(s.id, e);
  }
  return { id: s.id, points, coverage: describeCoverage(s, points) };
}
