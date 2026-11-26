// screen: one model's rules varied over a grid, every variant run and ranked
// (issue 1765, phase 5; proposal section 6.6). Pure: no fs, env, db or network.
//
// A grid is a list of rule variants. Each one is a Partial<RegimeRules> merged
// over the base model's rules, one level deep: a variant that sets
// weightRefresh sets the whole weightRefresh object. The merge is this
// driver's own step. runModel and RunOptions.rules always take a full rules
// object.
//
// Every variant runs through runModel with one shared stage cache
// (engine/cache.ts), so a stage whose params a variant leaves alone is computed
// once for the whole grid. A grid that varies only the weight refresh and the
// label cut scores the registry once; a variant that changes the rank window
// scores it again. The variants are ranked by the caller's metric, highest
// first.
//
// Every variant's run may share arrays with the other runs and with the cache.
// No caller may write to a run's result.
import type { RawIndicatorHistory } from "../types.ts";
import { isRegimeVersion, type RegimeRules, type RegimeVersion } from "../analyze/regime-versions.ts";
import { MODELS, modelOf, type RegimeModel } from "../model/models.ts";
import { stageCache, type StageCache } from "../engine/cache.ts";
import { runModel, type ModelRun, type RunModelOptions } from "../engine/run-model.ts";

/** One variant of a grid: the rules it changes, merged over the base model's rules one level deep. */
export type RuleVariant = Partial<RegimeRules>;

/** A variant's score: higher ranks first. NaN ranks after every number. */
export type ScreenMetric = (run: ModelRun) => number;

/**
 * runModel's options for every variant (`asof` is required). `cache` defaults
 * to a new stage cache for this call. `version` defaults to the base model's id
 * when that id is a published tag (a variant's own id never is).
 */
export type ScreenOptions = RunModelOptions;

/** One ranked variant. */
export interface ScreenEntry {
  /** The grid entry, as given. */
  readonly variant: RuleVariant;
  /** The variant's model: the base model with id `${base.id}+variant<i>` (i its grid index) and the merged rules. */
  readonly model: RegimeModel;
  /** runModel of `model`, stamped with the base's version (ScreenOptions.version). */
  readonly run: ModelRun;
  /** metric(run). */
  readonly score: number;
}

// Every rule name a preset states. A variant key outside it would merge as a
// rule no stage reads, so the variant would silently equal its base.
const RULE_NAMES: ReadonlySet<string> = new Set(Object.values(MODELS).flatMap((m) => Object.keys(m.rules)));

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * Run `baseModel` once per variant of `grid` over `input` (runModel's input:
 * the run input under the ids the model reads, after the ratio step), and rank
 * the variants by `metric`, highest first. Ties keep their grid order; a NaN
 * score ranks after every number. Each variant's model is checked by modelOf.
 * A RangeError names a grid that is not a list, a variant that is not an
 * object, a variant key that names no rule, or a metric that does not return a
 * number.
 */
export function screen(
  input: RawIndicatorHistory,
  baseModel: RegimeVersion | RegimeModel,
  grid: readonly RuleVariant[],
  metric: ScreenMetric,
  opts: ScreenOptions,
): ScreenEntry[] {
  const base = modelOf(baseModel);
  if (!Array.isArray(grid)) throw new RangeError("grid must be a list of rule variants");
  if (typeof metric !== "function") throw new RangeError("metric must be a function of a run");
  if (opts === null || typeof opts !== "object") throw new RangeError("screen needs runModel's options, with at least { asof }");
  grid.forEach((variant, i) => {
    if (!isRecord(variant)) throw new RangeError(`grid[${i}] must be an object of rules, got ${JSON.stringify(variant)}`);
    for (const k of Object.keys(variant)) {
      if (!RULE_NAMES.has(k)) throw new RangeError(`grid[${i}].${k} names no rule; the rules are ${[...RULE_NAMES].join(", ")}`);
    }
  });
  const cache: StageCache = opts.cache ?? stageCache();
  // A variant's id names no published tag, so runModel would stamp it with the
  // current version. It keeps its base's: a v3 or v5 variant is read by the v3
  // or v5 row tables (src/replay/rows.ts), never by the v4 ones.
  const version = opts.version ?? (isRegimeVersion(base.id) ? base.id : undefined);
  const entries = grid.map((variant, i) => {
    const model = modelOf({ ...base, id: `${base.id}+variant${i}`, rules: { ...base.rules, ...variant } });
    const run = runModel(model, input, { ...opts, cache, ...(version === undefined ? {} : { version }) });
    const score = metric(run);
    if (typeof score !== "number") throw new RangeError(`metric must return a number; for grid[${i}] it returned ${JSON.stringify(score)}`);
    return { entry: { variant, model, run, score } satisfies ScreenEntry, i };
  });
  entries.sort((a, b) => {
    const x = a.entry.score;
    const y = b.entry.score;
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) === Number.isNaN(y) ? a.i - b.i : Number.isNaN(x) ? 1 : -1;
    if (x !== y) return x > y ? -1 : 1;
    return a.i - b.i;
  });
  return entries.map((e) => e.entry);
}
