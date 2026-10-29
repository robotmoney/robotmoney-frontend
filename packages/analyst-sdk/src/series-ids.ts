// Source ids and the storage mapping (decision D74, issue 1423). Pure: no fs,
// env, db or network.
//
// A source series has one id, `<provider>:<symbol>`, for example `yahoo:^GSPC`
// or `fred:DTB3`. Stored rows keep their existing storage keys
// (`raw_indicator_history:<ID>`, `backtest:<symbol>`): nothing is renamed,
// rewritten or migrated. This module is the ONE mapping between the two.
//
// THE MAPPING IS PER CONSUMER. A consumer is one computation that reads source
// data: each registry indicator (`indicator:<ID>`), the correlations and the
// backtest. Each consumer keeps reading exactly the storage keys it reads
// today. Two storage keys may hold different streams for one source id:
// `raw_indicator_history:SPX_TREND` (read by indicator:SPX_TREND) and
// `backtest:^GSPC` (read by the correlations and the backtest) both map to
// `yahoo:^GSPC`, and their same-date values can differ. They stay separate
// streams and are never merged; every observation keeps its storage key as
// provenance. The mapping is ambiguous, and rejected at load, only when ONE
// consumer would read two storage keys for one source id.
//
// RATIOS. A ratio indicator (COPPER_GOLD and the other Yahoo pairs) stores a
// calculated value, not source data, so its storage key maps to the
// indicator id with kind "calculated". A source-only input carries the two
// legs instead, and resolveInputHistory computes the ratio from them with
// mergeRatioSeries (analytics requirements 4.3, SDK-10). A stored ratio, when
// present, is used unchanged.
//
// SDK INPUT NAMES. The computation reads its inputs under the ids it reads
// today (registry ids, and SPX, ETH, TBILL3M for the correlations and the
// backtest), so identical observations give byte-identical reports. An SDK
// input may name a stream by that id, by its storage key, or by its source id;
// resolveInputHistory translates the names. Naming one consumer's stream twice
// in one input (for example SPX_TREND and yahoo:^GSPC) is rejected: the run
// never picks one stream over another silently.
//
// Writes use the reverse mapping: storageKeyForSourceId(consumer, sourceId).
import type { Point, RawIndicatorHistory } from "./types.ts";
import { INDICATORS, type Indicator } from "./analyze/indicators.ts";
import { LEDGER_EXTRA_KEYS } from "./extras.ts";
import { mergeRatioSeries } from "./transform/grid.ts";

export type SeriesKind = "source" | "calculated";

export interface SeriesMapping {
  /** The computation that reads the stream: `indicator:<ID>`, `correlations` or `backtest`. */
  readonly consumer: string;
  /** The key the stream is stored under today (source_value_versions.source_key). */
  readonly storageKey: string;
  /** The canonical source id (`<provider>:<symbol>`), or the indicator id of a calculated ratio. */
  readonly series: string;
  readonly kind: SeriesKind;
  /** The id the computation reads the stream under (registry id, or SPX, ETH, TBILL3M). */
  readonly inputId: string;
  /** A calculated ratio's two source ids, numerator first. */
  readonly legs?: readonly [string, string];
}

export class AmbiguousSeriesMappingError extends Error {
  override readonly name = "AmbiguousSeriesMappingError";
  constructor(readonly consumer: string, readonly series: string, readonly keys: readonly [string, string]) {
    super(`ambiguous series mapping: consumer ${consumer} would read ${series} from two storage keys, ${keys[0]} and ${keys[1]}`);
  }
}

export class AmbiguousInputSeriesError extends Error {
  override readonly name = "AmbiguousInputSeriesError";
  constructor(readonly consumer: string, readonly names: readonly [string, string]) {
    super(`ambiguous input: ${consumer} reads one stream, and the input names it twice, as ${names[0]} and ${names[1]}; keep one name, or name each stream by its storage key`);
  }
}

export class MissingRatioLegError extends Error {
  override readonly name = "MissingRatioLegError";
  constructor(readonly ratio: string, readonly missingLeg: string, readonly presentLeg: string) {
    super(`ratio ${ratio}: the input carries ${presentLeg} and not ${missingLeg}, and no stored ${ratio}; supply both legs, or the stored ratio (--replay)`);
  }
}

export class UnknownSeriesMappingError extends Error {
  override readonly name = "UnknownSeriesMappingError";
  constructor(readonly consumer: string, readonly series: string) {
    super(`no storage key maps to ${series} for consumer ${consumer}`);
  }
}

export const indicatorConsumer = (id: string): string => `indicator:${id}`;

// Providers whose registry entry names no symbol: the one series each reads.
const SYMBOL_OF_PROVIDER: Readonly<Record<string, string>> = {
  defillama_tvl: "total",
  defillama_stables: "total",
  geckoterminal_newpools: "new_pools",
  shiller_cape: "CAPE",
};

/** The source id a single-series registry indicator reads, or its legs for a ratio. */
export function indicatorSourceIds(ind: Indicator): string | readonly [string, string] {
  const s = ind.series;
  if (Array.isArray(s)) return [`${ind.source}:${s[0]}`, `${ind.source}:${s[1]}`];
  if (typeof s === "string") return `${ind.source}:${s}`;
  if (s && typeof s === "object") return `${ind.source}:${(s as { asset: string }).asset}.${(s as { metric: string }).metric}`;
  const sym = SYMBOL_OF_PROVIDER[ind.source];
  if (!sym) throw new Error(`indicator ${ind.id}: provider ${ind.source} names no series and has no default symbol`);
  return `${ind.source}:${sym}`;
}

// ONE KEY PER SOURCE (D74 amendment, owner, 2026-10-28; issue 1514).
// DEFI_GROWTH and STABLES_GROWTH store the raw DefiLlama level, exactly as
// DEFI_TVL and STABLES do, and apply their change90 transform downstream. They
// read the DEFI_TVL and STABLES stored series, and nothing is written under
// their own keys any more. Their stored history stays as it is; it reaches no
// consumer. Every other indicator reads the key named after it.
export const STORED_UNDER: Readonly<Record<string, string>> = Object.freeze({ DEFI_GROWTH: "DEFI_TVL", STABLES_GROWTH: "STABLES" });

/** The registry id whose raw_indicator_history series an indicator reads. */
export const storedIndicatorId = (id: string): string => STORED_UNDER[id] ?? id;

/** `<provider>:<symbol>` for one backtest extra. */
export const extraSourceId = (x: { provider: string; symbol: string }): string => `${x.provider}:${x.symbol}`;

function buildMapping(): SeriesMapping[] {
  const out: SeriesMapping[] = [];
  for (const ind of INDICATORS) {
    const ids = indicatorSourceIds(ind);
    const base = { consumer: indicatorConsumer(ind.id), storageKey: `raw_indicator_history:${storedIndicatorId(ind.id)}`, inputId: ind.id };
    out.push(typeof ids === "string" ? { ...base, series: ids, kind: "source" } : { ...base, series: ind.id, kind: "calculated", legs: ids });
  }
  const X = LEDGER_EXTRA_KEYS;
  for (const [consumer, extras] of [["correlations", [X.spx, X.eth]], ["backtest", [X.spx, X.eth, X.tbill3m]]] as const) {
    for (const x of extras) out.push({ consumer, storageKey: x.ledgerKey, series: extraSourceId(x), kind: "source", inputId: x.inputId });
  }
  return out;
}

/**
 * Rejects a mapping that is not one-to-one within a consumer: one consumer
 * reading two storage keys for one series (the error names both keys), or one
 * storage key mapped to two series. One input id must also name one storage
 * key, since the computation reads the stream under that id.
 */
export function validateSeriesMapping<T extends readonly SeriesMapping[]>(mapping: T): T {
  const byConsumerSeries = new Map<string, string>();
  const byConsumerKey = new Map<string, string>();
  const keyOfInput = new Map<string, string>();
  for (const m of mapping) {
    const cs = `${m.consumer}\u0001${m.series}`;
    const prior = byConsumerSeries.get(cs);
    if (prior !== undefined && prior !== m.storageKey) throw new AmbiguousSeriesMappingError(m.consumer, m.series, [prior, m.storageKey]);
    byConsumerSeries.set(cs, m.storageKey);
    const ck = `${m.consumer}\u0001${m.storageKey}`;
    const priorSeries = byConsumerKey.get(ck);
    if (priorSeries !== undefined && priorSeries !== m.series) {
      throw new Error(`ambiguous series mapping: consumer ${m.consumer} maps storage key ${m.storageKey} to two series, ${priorSeries} and ${m.series}`);
    }
    byConsumerKey.set(ck, m.series);
    const priorKey = keyOfInput.get(m.inputId);
    if (priorKey !== undefined && priorKey !== m.storageKey) {
      throw new Error(`ambiguous series mapping: input id ${m.inputId} names two storage keys, ${priorKey} and ${m.storageKey}`);
    }
    keyOfInput.set(m.inputId, m.storageKey);
  }
  return mapping;
}

/** The one shared mapping, validated when this module loads. */
export const SERIES_MAPPING: readonly SeriesMapping[] = Object.freeze(validateSeriesMapping(buildMapping()));

// RATIO LEGS (issue 1514, analytics requirements 4.3). Each run records both
// legs of every Yahoo ratio as source data, from the fetch that produces the
// stored ratio. A leg another collector already records keeps that key
// (yahoo:SPY is research:SPY, yahoo:BTC-USD is research:BTC-USD, yahoo:ETH-USD
// is backtest:ETH-USD); every other leg is stored under its own source id.
// Production still reads the stored ratio, so these entries are not in
// SERIES_MAPPING: they say where each leg's stream is stored, per ratio, and
// which names resolveInputHistory reads a leg under (its source id or its
// storage key) when the input stores no ratio.
const LEG_KEYS_HELD_ELSEWHERE: Readonly<Record<string, string>> = {
  "yahoo:SPY": "research:SPY",
  "yahoo:BTC-USD": "research:BTC-USD",
  [extraSourceId(LEDGER_EXTRA_KEYS.eth)]: LEDGER_EXTRA_KEYS.eth.ledgerKey,
};

/** The storage key a ratio leg (a source id) is recorded under. */
export function ratioLegStorageKey(sourceId: string): string {
  return LEG_KEYS_HELD_ELSEWHERE[sourceId] ?? sourceId;
}

/** Each ratio's two legs as source streams, under their storage keys, validated when this module loads. */
export const RATIO_LEG_MAPPING: readonly SeriesMapping[] = Object.freeze(validateSeriesMapping(
  SERIES_MAPPING.filter((m) => m.kind === "calculated" && m.legs).flatMap((m) =>
    m.legs!.map((leg): SeriesMapping => ({ consumer: m.consumer, storageKey: ratioLegStorageKey(leg), series: leg, kind: "source", inputId: leg }))),
));

// Each ratio id to its two legs (numerator first), from RATIO_LEG_MAPPING.
const RATIO_LEGS: ReadonlyMap<string, readonly SeriesMapping[]> = (() => {
  const m = new Map<string, SeriesMapping[]>();
  for (const leg of RATIO_LEG_MAPPING) {
    const ratio = leg.consumer.slice("indicator:".length);
    (m.get(ratio) ?? m.set(ratio, []).get(ratio)!).push(leg);
  }
  return m;
})();

/** Every consumer's storage keys, sorted: what each consumer reads. */
export function consumerStorageKeys(mapping: readonly SeriesMapping[] = SERIES_MAPPING): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of mapping) (out[m.consumer] ??= []).push(m.storageKey);
  for (const c in out) out[c]!.sort();
  return out;
}

/** Forward mapping: the series a consumer reads from a storage key, or null when it does not read that key. */
export function sourceIdForStorageKey(consumer: string, storageKey: string, mapping: readonly SeriesMapping[] = SERIES_MAPPING): string | null {
  return mapping.find((m) => m.consumer === consumer && m.storageKey === storageKey)?.series ?? null;
}

/** Reverse mapping, for writes: the storage key a consumer's series is stored under. */
export function storageKeyForSourceId(consumer: string, series: string, mapping: readonly SeriesMapping[] = SERIES_MAPPING): string {
  const m = mapping.find((x) => x.consumer === consumer && x.series === series);
  if (!m) throw new UnknownSeriesMappingError(consumer, series);
  return m.storageKey;
}

/** One stored observation, in the shape the run ledger reads (FrozenSourceValue). */
export interface StoredObservation {
  readonly sourceKey: string;
  readonly marketDate: string | null;
  readonly value: number;
  readonly versionId?: string;
}

/** One observation as a consumer receives it: the source id, plus the storage key as provenance. */
export interface ConsumerObservation {
  readonly series: string;
  readonly storageKey: string;
  readonly date: string;
  readonly value: number;
  readonly versionId?: string;
}

/**
 * The observations one consumer reads, in input order: only rows under its own
 * storage keys. A row under another key with the same source id is a different
 * stream and is never included, merged or substituted.
 */
export function selectConsumerObservations(rows: readonly StoredObservation[], consumer: string, mapping: readonly SeriesMapping[] = SERIES_MAPPING): ConsumerObservation[] {
  const seriesOf = new Map(mapping.filter((m) => m.consumer === consumer).map((m) => [m.storageKey, m.series]));
  const out: ConsumerObservation[] = [];
  for (const r of rows) {
    const series = seriesOf.get(r.sourceKey);
    if (series === undefined || r.marketDate === null) continue;
    out.push({ series, storageKey: r.sourceKey, date: r.marketDate, value: r.value, ...(r.versionId === undefined ? {} : { versionId: r.versionId }) });
  }
  return out;
}

/**
 * Stored rows to the history the computation reads (keyed by input id), through
 * the mapping. Rows under keys no consumer reads are left out. Points ascend by
 * date; a repeated (key, date) keeps the last row, the loader's rule.
 */
export function inputHistoryFromStorage(rows: readonly StoredObservation[], mapping: readonly SeriesMapping[] = SERIES_MAPPING): RawIndicatorHistory {
  // One storage key may feed several input ids (raw_indicator_history:DEFI_TVL
  // feeds DEFI_TVL and DEFI_GROWTH, D74 amendment).
  const inputsOf = new Map<string, string[]>();
  for (const m of mapping) {
    const ids = inputsOf.get(m.storageKey) ?? [];
    if (!ids.includes(m.inputId)) ids.push(m.inputId);
    inputsOf.set(m.storageKey, ids);
  }
  const byId = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const ids = inputsOf.get(r.sourceKey);
    if (ids === undefined || r.marketDate === null) continue;
    for (const id of ids) {
      let m = byId.get(id);
      if (!m) byId.set(id, (m = new Map()));
      m.set(r.marketDate, r.value);
    }
  }
  const out: RawIndicatorHistory = {};
  for (const [id, m] of byId) {
    const pts: Point[] = [...m].map(([date, value]) => ({ date, value }));
    pts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    out[id] = pts;
  }
  return out;
}

/**
 * SDK input names to the ids the computation reads. A consumer's stream may be
 * named by its input id, its storage key or (for source data) its source id.
 * A source id alone feeds every consumer that reads it. One consumer's stream
 * named twice is rejected with both names. Names no consumer reads pass
 * through unchanged. An input that already uses the input ids comes back with
 * the same keys and the same arrays. A ratio the input does not store is
 * calculated from its two legs (mergeRatioSeries); one leg alone throws
 * MissingRatioLegError.
 */
export function resolveInputHistory(input: RawIndicatorHistory, mapping: readonly SeriesMapping[] = SERIES_MAPPING): RawIndicatorHistory {
  const resolved = new Map<string, string>(); // inputId -> the input name it is read from
  const consumed = new Set<string>();
  for (const m of mapping) {
    // A growth indicator stored under another's key (D74 amendment) is named
    // only by its own id: its storage key and source id name the base
    // indicator's stream, which feeds it below when the input omits it.
    const aliased = Object.hasOwn(STORED_UNDER, m.inputId);
    const names = (aliased ? [m.inputId] : [m.inputId, m.storageKey, ...(m.kind === "source" ? [m.series] : [])]).filter((n, i, a) => a.indexOf(n) === i && Object.hasOwn(input, n));
    if (names.length > 1) throw new AmbiguousInputSeriesError(m.consumer, [names[0]!, names[1]!]);
    if (names.length === 0) continue;
    const name = names[0]!;
    const prior = resolved.get(m.inputId);
    // Two consumers that share an input id (correlations and backtest read SPX)
    // must resolve it from the same name.
    if (prior !== undefined && prior !== name) throw new AmbiguousInputSeriesError(m.consumer, [prior, name]);
    resolved.set(m.inputId, name);
    consumed.add(name);
  }
  const out: RawIndicatorHistory = {};
  for (const name of Object.keys(input)) if (!consumed.has(name)) out[name] = input[name]!;
  for (const [inputId, name] of resolved) out[inputId] = input[name]!;
  // Analytics requirements 4.3 (SDK-10): a ratio the input does not store is
  // calculated from its two legs, with mergeRatioSeries and nothing else. A
  // stored ratio is used unchanged. One leg alone is an explicit error; no leg
  // and no stored ratio leaves the ratio missing (the 4.2 rule).
  for (const [ratio, legs] of RATIO_LEGS) {
    if (Object.hasOwn(out, ratio)) continue;
    const found = legs.map((leg) => {
      const names = [leg.series, leg.storageKey].filter((n, i, a) => a.indexOf(n) === i && Object.hasOwn(input, n));
      if (names.length > 1) throw new AmbiguousInputSeriesError(leg.consumer, [names[0]!, names[1]!]);
      return names.length === 0 ? undefined : input[names[0]!]!;
    });
    const [num, den] = found;
    if (num && den) out[ratio] = mergeRatioSeries(num, den);
    else if (num || den) throw new MissingRatioLegError(ratio, legs[num ? 1 : 0]!.series, legs[num ? 0 : 1]!.series);
  }
  // D74 amendment: an input that carries DEFI_TVL (or STABLES) and not
  // DEFI_GROWTH (or STABLES_GROWTH) feeds the growth indicator from it, the
  // series it is stored under. An input that names the growth id keeps it.
  for (const [id, stored] of Object.entries(STORED_UNDER)) {
    if (!Object.hasOwn(out, id) && Object.hasOwn(out, stored)) out[id] = out[stored]!;
  }
  return out;
}

/** The storage keys the backtest extras are written under: the reverse mapping, never a second literal. */
export const EXTRA_WRITE_KEYS = {
  spx: storageKeyForSourceId("backtest", extraSourceId(LEDGER_EXTRA_KEYS.spx)),
  eth: storageKeyForSourceId("backtest", extraSourceId(LEDGER_EXTRA_KEYS.eth)),
  tbill3m: storageKeyForSourceId("backtest", extraSourceId(LEDGER_EXTRA_KEYS.tbill3m)),
} as const;
