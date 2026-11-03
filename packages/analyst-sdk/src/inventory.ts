// The model portfolio inventory (issue 1398): every source series the model
// portfolio workflow reads, as data in inventory/model-portfolio.json. Pure:
// the shipped file is a static JSON import, and a caller with another file
// passes its parsed JSON (src/ may not read files, see
// scripts/tests/unit/analyst-sdk-purity.test.ts).
//
// The inventory is the contract between extract and its consumers. Extract
// fetches the series whose storageKey is their own id (the others are already
// collected under an existing key, D74 storage mapping) and serves every series
// as the provider published it. A gap, a late inception or a proxy is recorded
// here, never repaired downstream: requireCoverage names the missing series and
// date range, and nothing after extract fetches.
//
// Two inventories ship (issue 1514): model-portfolio.json and
// research-series.json, the series the SDK's research clients read. The
// backend's background collection reads both, and fetches each storage key once.
import type { Point } from "./types.ts";
import shipped from "../inventory/model-portfolio.json";
import researchShipped from "../inventory/research-series.json";

/**
 * The earliest date every background source fetch requests (issue 1514). A
 * fetch whose existing start is earlier (the 2010-01-01 starts of SPY, RSP,
 * the top seven, ^GSPC and ETH-USD) keeps it. This is the COLLECTION start
 * only: computation starts (the regime backfill, the research-signals axis)
 * stay where they are, so the stored history gets longer and no published
 * output changes. Research reads trailing windows before 2018 (a covariance
 * window of up to two years ending at the 2018 axis), so a new consumer never
 * needs a one-off backfill.
 */
export const COLLECTION_START = "2016-01-01";

export const INVENTORY_PROVIDERS = ["yahoo", "fred", "defillama-yields"] as const;
export type InventoryProvider = (typeof INVENTORY_PROVIDERS)[number];
export const INVENTORY_KINDS = ["price", "lending_yield", "rate"] as const;
export type InventoryKind = (typeof INVENTORY_KINDS)[number];

export interface InventoryProxy {
  /** The source id served in this series' place before its inception. */
  id: string;
  from: string;
  to: string;
  provenance: string;
}

export interface InventorySeries {
  /** `<provider>:<symbol>` (D74). */
  id: string;
  provider: InventoryProvider;
  symbol: string;
  kind: InventoryKind;
  units: string;
  requestedStart: string;
  /** The first date the provider serves for this series. */
  inception: string;
  proxy: InventoryProxy | null;
  /** A known gap or limitation, served as it is. Null when there is none. */
  limitation: string | null;
  /** The source_value_versions key the series is recorded under. */
  storageKey: string;
}

export interface Inventory {
  workflow: string;
  series: InventorySeries[];
}

/** Every field a series entry must carry, in file order. */
export const INVENTORY_FIELDS = [
  "id", "provider", "symbol", "kind", "units", "requestedStart", "inception", "proxy", "limitation", "storageKey",
] as const satisfies readonly (keyof InventorySeries)[];

export class InventoryError extends Error {
  override readonly name = "InventoryError";
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string =>
  typeof v === "string" && ISO_DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function checkSeries(raw: unknown, i: number): InventorySeries {
  const o = (raw ?? {}) as Record<string, unknown>;
  const where = `inventory series ${i + 1}${isText(o.id) ? ` (${o.id})` : ""}`;
  for (const f of INVENTORY_FIELDS) if (!(f in o)) throw new InventoryError(`${where}: missing field ${f}`);
  if (!INVENTORY_PROVIDERS.includes(o.provider as InventoryProvider)) throw new InventoryError(`${where}: provider must be one of ${INVENTORY_PROVIDERS.join(", ")}`);
  if (!isText(o.symbol)) throw new InventoryError(`${where}: symbol must be a non-empty string`);
  if (o.id !== `${o.provider}:${o.symbol}`) throw new InventoryError(`${where}: id must be <provider>:<symbol>, ${o.provider}:${o.symbol}`);
  if (!INVENTORY_KINDS.includes(o.kind as InventoryKind)) throw new InventoryError(`${where}: kind must be one of ${INVENTORY_KINDS.join(", ")}`);
  if (!isText(o.units)) throw new InventoryError(`${where}: units must be a non-empty string`);
  for (const f of ["requestedStart", "inception"] as const) if (!isDay(o[f])) throw new InventoryError(`${where}: ${f} must be a real YYYY-MM-DD date`);
  if (o.requestedStart !== COLLECTION_START) throw new InventoryError(`${where}: requestedStart must be COLLECTION_START (${COLLECTION_START}), not ${o.requestedStart}`);
  if (o.limitation !== null && !isText(o.limitation)) throw new InventoryError(`${where}: limitation must be null or a non-empty string`);
  if (!isText(o.storageKey)) throw new InventoryError(`${where}: storageKey must be a non-empty string`);
  // A series whose inception is after its requested start leaves a gap that
  // only a recorded limitation or proxy may explain.
  if ((o.inception as string) > (o.requestedStart as string) && o.limitation === null && o.proxy === null) {
    throw new InventoryError(`${where}: inception ${o.inception} is after requestedStart ${o.requestedStart}; record the limitation or a proxy`);
  }
  let proxy: InventoryProxy | null = null;
  if (o.proxy !== null) {
    const p = (o.proxy ?? {}) as Record<string, unknown>;
    for (const f of ["id", "from", "to", "provenance"] as const) if (!(f in p)) throw new InventoryError(`${where}: proxy is missing field ${f}`);
    if (!isText(p.id) || !isDay(p.from) || !isDay(p.to) || !isText(p.provenance) || p.from > p.to) {
      throw new InventoryError(`${where}: proxy needs an id, a from <= to date range and its provenance`);
    }
    proxy = { id: p.id, from: p.from, to: p.to, provenance: p.provenance };
  }
  return {
    id: o.id as string, provider: o.provider as InventoryProvider, symbol: o.symbol as string, kind: o.kind as InventoryKind,
    units: o.units as string, requestedStart: o.requestedStart as string, inception: o.inception as string, proxy,
    limitation: o.limitation as string | null, storageKey: o.storageKey as string,
  };
}

/** The shipped inventory, or `data` (another inventory's parsed JSON), validated. Throws InventoryError naming the entry and field. */
export function loadInventory(data: unknown = shipped): Inventory {
  const o = (data ?? {}) as Record<string, unknown>;
  if (!isText(o.workflow)) throw new InventoryError("inventory: workflow must be a non-empty string");
  if (!Array.isArray(o.series) || o.series.length === 0) throw new InventoryError("inventory: series must be a non-empty array");
  const series = o.series.map(checkSeries);
  const ids = new Set<string>();
  for (const s of series) {
    if (ids.has(s.id)) throw new InventoryError(`inventory: series ${s.id} is listed twice`);
    ids.add(s.id);
  }
  for (const s of series) {
    if (s.proxy && !ids.has(s.proxy.id)) throw new InventoryError(`inventory series ${s.id}: proxy ${s.proxy.id} is not in the inventory`);
  }
  return { workflow: o.workflow, series };
}

/** True when extract collects this series under its own id (no existing collector holds it). */
export function collectedByInventory(s: InventorySeries): boolean {
  return s.storageKey === s.id;
}

/** The shipped research-series inventory (issue 1514), validated. */
export function loadResearchSeriesInventory(): Inventory {
  return loadInventory(researchShipped);
}

/**
 * The series the background collection fetches for these inventories: the
 * entries no other collector holds, one per storage key (the first inventory
 * that lists a key wins), so a key listed in two inventories is fetched once.
 */
export function inventoryCollection(inventories: readonly Inventory[] = [loadInventory(), loadResearchSeriesInventory()]): InventorySeries[] {
  const seen = new Set<string>();
  const out: InventorySeries[] = [];
  for (const inv of inventories) {
    for (const s of inv.series) {
      if (!collectedByInventory(s) || seen.has(s.storageKey)) continue;
      seen.add(s.storageKey);
      out.push(s);
    }
  }
  return out;
}

export interface CoverageGap {
  id: string;
  /** Missing range, inclusive. */
  from: string;
  to: string;
}

export class InventoryCoverageError extends Error {
  override readonly name = "InventoryCoverageError";
  constructor(readonly gaps: CoverageGap[]) {
    super(`missing required input coverage: ${gaps.map((g) => `${g.id} ${g.from}..${g.to}`).join("; ")}`);
  }
}

/** Days a series may start after, or end before, the wanted range and still cover it: a provider calendar (weekend, holiday) is not a gap. */
export const CALENDAR_SLACK_DAYS = 7;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Checks that `history` (source id -> points) covers every listed series from
 * max(from, inception) to `to`. A series that is absent, starts more than
 * CALENDAR_SLACK_DAYS late or ends more than CALENDAR_SLACK_DAYS early is a
 * gap; the error names each series and its missing range. Interior gaps
 * (weekends, holidays) are not checked: they are the provider's calendar and
 * are served as they are. Never fetches.
 */
export function requireCoverage(
  series: readonly InventorySeries[],
  history: Readonly<Record<string, readonly Point[]>>,
  range: { from: string; to: string },
): void {
  const gaps: CoverageGap[] = [];
  for (const s of series) {
    const want = s.inception > range.from ? s.inception : range.from;
    if (want > range.to) continue;
    const pts = history[s.id] ?? [];
    if (pts.length === 0) {
      gaps.push({ id: s.id, from: want, to: range.to });
      continue;
    }
    let first = pts[0]!.date, last = pts[0]!.date;
    for (const p of pts) {
      if (p.date < first) first = p.date;
      if (p.date > last) last = p.date;
    }
    if (first > addDays(want, CALENDAR_SLACK_DAYS)) gaps.push({ id: s.id, from: want, to: addDays(first, -1) });
    if (last < addDays(range.to, -CALENDAR_SLACK_DAYS)) gaps.push({ id: s.id, from: addDays(last, 1), to: range.to });
  }
  if (gaps.length) throw new InventoryCoverageError(gaps);
}
