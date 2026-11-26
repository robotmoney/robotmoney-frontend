// The stage cache of the regime engine (issue 1765, phase 2; proposal section
// 6.6). Pure: no fs, env, db or network (node:crypto hashes, as
// allocate/labels.ts does).
//
// A cache is a plain Map the caller owns, plus hit and miss counters per stage.
// runModel stores each stage's value under
//
//   `${inputDigest}|${stage}|${canonicalStringify(stageParams)}`
//
// The input digest is the sha256 of the raw input runModel was given, computed
// once per input object and remembered in a WeakMap, so the input object must
// not change after its first cached run. A stage's params name everything its
// value is computed from: its own rules and its upstream stage's params (the
// prepare stage's params are in every key). A stage output is never hashed:
// canonical JSON turns NaN into null, so a digest of an output could not tell
// two outputs apart. In a key, a NaN, an infinity or a negative zero is written
// as a tagged string for the same reason.
//
// Cached values are shared: every run that hits an entry reads the same arrays
// and objects, so no caller may write to a run's result.
import { createHash } from "node:crypto";
import { canonicalStringify } from "../report/canonical.ts";
import type { RawIndicatorHistory } from "../types.ts";
import type { StageMemo, StageName } from "./history.ts";

export type { StageName } from "./history.ts";

/** The stages a cache counts, in run order. */
export const STAGES: readonly StageName[] = Object.freeze(["prepare", "score", "fit", "combine"]);

/** A caller-owned stage cache: the entries, and per stage the lookups that found one and the ones that did not. */
export interface StageCache {
  /** Every entry, by key. Clear it to drop the cache. */
  readonly entries: Map<string, unknown>;
  /** The value under `key`, counted as a hit or a miss of the key's stage. */
  get(key: string): unknown;
  /** Store `value` under `key`; returns `value`. */
  set<T>(key: string, value: T): T;
  readonly hits: Record<StageName, number>;
  readonly misses: Record<StageName, number>;
}

const counters = (): Record<StageName, number> => ({ prepare: 0, score: 0, fit: 0, combine: 0 });

/** A new stage cache over `entries` (default a new Map). */
export function stageCache(entries: Map<string, unknown> = new Map()): StageCache {
  const hits = counters();
  const misses = counters();
  return {
    entries,
    hits,
    misses,
    get(key) {
      const stage = stageOfKey(key);
      if (entries.has(key)) {
        hits[stage]++;
        return entries.get(key);
      }
      misses[stage]++;
      return undefined;
    },
    set(key, value) {
      stageOfKey(key);
      entries.set(key, value);
      return value;
    },
  };
}

// The stage a key names; a RangeError for a key of another shape.
function stageOfKey(key: string): StageName {
  const parts = key.split("|", 3);
  const stage = parts[1] as StageName;
  if (parts.length < 3 || !STAGES.includes(stage)) throw new RangeError(`a stage cache key is "<input digest>|<stage>|<params>" with stage one of ${STAGES.join(", ")}, got ${JSON.stringify(key.slice(0, 80))}`);
  return stage;
}

const digests = new WeakMap<object, string>();

// A number as a key writes it: canonical JSON for a finite one, a tag for the rest.
const tagNumber = (v: number): string | number => (Number.isNaN(v) ? "\u0000NaN" : v === Infinity ? "\u0000+Infinity" : v === -Infinity ? "\u0000-Infinity" : Object.is(v, -0) ? "\u0000-0" : v);

function tagged(value: unknown): unknown {
  if (typeof value === "number") return tagNumber(value);
  if (Array.isArray(value)) return value.map(tagged);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = tagged(v);
    return out;
  }
  return value;
}

/** The sha256 of a raw input: every series by id, its rows in order, every field of a row. Remembered per input object. */
export function inputDigest(raw: RawIndicatorHistory): string {
  const seen = digests.get(raw);
  if (seen !== undefined) return seen;
  // canonicalStringify orders the series by id (their order changes no figure); rows keep their order.
  const digest = createHash("sha256").update(canonicalStringify(tagged(raw))).digest("hex");
  digests.set(raw, digest);
  return digest;
}

/** The key of one stage's value for one input. */
export function stageKey(raw: RawIndicatorHistory, stage: StageName, params: unknown): string {
  return `${inputDigest(raw)}|${stage}|${canonicalStringify(tagged(params))}`;
}

/**
 * A driver memo over `cache` for one input. Every key carries `prepare`, the
 * prepare stage's params, beside the stage's own: every stage reads the
 * prepared arrays.
 */
export function cacheMemo(cache: StageCache, raw: RawIndicatorHistory, prepare: object): StageMemo {
  return <T>(stage: StageName, params: () => object, compute: () => T): T => {
    const key = stageKey(raw, stage, { prepare, ...params() });
    const hit = cache.get(key);
    if (hit !== undefined) return hit as T;
    return cache.set(key, compute());
  };
}
