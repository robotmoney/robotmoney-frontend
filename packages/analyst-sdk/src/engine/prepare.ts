// The prepare stage of the regime engine (issue 1765, phase 2; proposal section
// 6.3). Pure: no fs, env, db or network.
//
// A model's run input, cut at the as-of day, becomes the arrays the engine
// scores through the one preparation seam, prepareRegimeInputs (D59): the daily
// axis, the carry-forward, the transform and the fill policy of each registry
// indicator. A model with derived series (v5) computes them first from their
// raw inputs as known on the as-of day (withDerivedSeries).
import type { Point, RawIndicatorHistory } from "../types.ts";
import type { Indicator } from "../analyze/indicators.ts";
import type { RegimeRules } from "../analyze/regime-versions.ts";
import { deriveSeries, derivedInputIds, type DerivedSeries } from "../transform/derived.ts";
import { cutAtAsof, prepareRegimeInputs, type PreparedRegimeInputs } from "../prepare.ts";

/**
 * `raw` cut at `asof`, plus each derived series computed from its raw inputs as
 * known on `asof` and dated by its publication rule, so the day reads no
 * derived value dated after it. A declaration whose input is absent gives an
 * empty series: its indicator is missing under its fill policy.
 */
export function withDerivedSeries(raw: RawIndicatorHistory, asof: string, derived: readonly DerivedSeries[]): RawIndicatorHistory {
  const out: RawIndicatorHistory = {};
  for (const id in raw) out[id] = cutAtAsof(raw[id]!, asof);
  for (const d of derived) {
    if (Object.hasOwn(raw, d.id)) throw new RangeError(`derived series ${d.id} is already an input of the run: it is computed from its raw inputs, never read as stored`);
  }
  for (const d of derived) {
    const inputs: Record<string, Point[]> = {};
    let complete = true;
    for (const id of derivedInputIds(d)) {
      if (!Object.hasOwn(raw, id)) complete = false;
      else inputs[id] = out[id]!;
    }
    out[d.id] = complete ? cutAtAsof(deriveSeries(d, inputs), asof) : [];
  }
  return out;
}

/** What the prepare stage reads of a model. */
export interface PrepareModel {
  readonly registry: readonly Indicator[];
  readonly derived: readonly DerivedSeries[];
  readonly rules: RegimeRules;
}

/**
 * The prepare stage: `raw` (the run's input under the ids the model reads) on
 * the daily axis `start`..`asof`, through prepareRegimeInputs under the model's
 * registry and rules. withDerivedSeries runs only when the model declares
 * derived series. prepareRegimeInputs cuts every registry series at `asof`
 * itself, so the result is the same whether `raw` is cut or not.
 */
export function prepareModel(raw: RawIndicatorHistory, model: PrepareModel, opts: { start: string; asof: string }): PreparedRegimeInputs {
  const input = model.derived.length > 0 ? withDerivedSeries(raw, opts.asof, model.derived) : raw;
  return prepareRegimeInputs(input, { start: opts.start, asof: opts.asof, indicators: model.registry, rules: model.rules });
}
