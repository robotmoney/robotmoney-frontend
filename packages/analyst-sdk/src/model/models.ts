// The model value (issue 1765, phase 2; proposal section 6.2). A methodology is
// one frozen RegimeModel: its rules, its registry, its derived series, whether
// it keeps its history, its panels, the storage it reads and its backtest
// rules. A published tag names a preset in MODELS; a research model is any
// RegimeModel, with no tag. Where a model is published (REGIME_LINE) is a
// platform fact and is not a field.
//
// MODELS is the presets of model/presets.ts plus REGIME_BACKTEST_RULES of each
// tag, every field by identity, so a per-version table of
// analyze/regime-versions.ts and the matching MODELS field are one value
// (tests/model-equivalence.test.ts).
//
// No API route imports this module: the routes reach analyze/regime-versions.ts
// (backend/src/api/routes/analytics.ts, dashboards.ts), and this module reaches
// the backtest calculation.
import { REGIME_BACKTEST_RULES, type ReferenceBacktestOptions } from "../analyze/backtest.ts";
import { isRegimeVersion, regimeRulesOf } from "../analyze/regime-versions.ts";
import { CURRENT_REGIME_VERSION, PRESETS, REGIME_VERSIONS, type ModelFacts, type RegimeVersion } from "./presets.ts";

/** One regime model: a published preset (MODELS) or a research model. */
export interface RegimeModel extends ModelFacts {
  /** The options of the model's reference backtest (computeBacktest). */
  readonly backtest: Readonly<ReferenceBacktestOptions>;
}

/** The published presets, in tag order: each version's facts and its backtest rules. */
export const MODELS: Readonly<Record<RegimeVersion, RegimeModel>> = Object.freeze(
  Object.fromEntries(REGIME_VERSIONS.map((v) => [v, Object.freeze({ ...PRESETS[v], backtest: REGIME_BACKTEST_RULES[v] })])) as Record<RegimeVersion, RegimeModel>,
);

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/**
 * The model a tag names, MODELS[tag] itself; or a passed model, checked and
 * returned as it is. A RangeError names what is wrong: an unknown tag, a field
 * of the wrong shape, a `history` other than "recompute" or "kept", a bad rule
 * (regimeRulesOf), or rules.keptHistory that disagrees with `history`.
 */
export function modelOf(versionOrModel: RegimeVersion | RegimeModel): RegimeModel {
  if (typeof versionOrModel === "string") {
    if (!isRegimeVersion(versionOrModel)) throw new RangeError(`unknown methodology version ${JSON.stringify(versionOrModel)}; expected one of ${REGIME_VERSIONS.join(", ")} or a RegimeModel`);
    return MODELS[versionOrModel];
  }
  const m: unknown = versionOrModel;
  if (!isRecord(m)) throw new RangeError("a model must be a methodology version or a RegimeModel object");
  if (typeof m.id !== "string" || m.id === "") throw new RangeError(`model.id must be a non-empty string, got ${JSON.stringify(m.id)}`);
  if (m.history !== "recompute" && m.history !== "kept") throw new RangeError(`model.history must be "recompute" or "kept", got ${JSON.stringify(m.history)}`);
  if (!isRecord(m.rules)) throw new RangeError("model.rules must be a RegimeRules object");
  // Checked whole: a bad field is named.
  regimeRulesOf(CURRENT_REGIME_VERSION, m.rules as unknown as ModelFacts["rules"]);
  const keptRules = m.rules.keptHistory === true;
  if (keptRules !== (m.history === "kept")) {
    throw new RangeError(`model.history is ${JSON.stringify(m.history)} and rules.keptHistory is ${JSON.stringify(m.rules.keptHistory)}: a kept model sets keptHistory true, a recomputing one leaves it absent or false`);
  }
  for (const k of ["registry", "derived", "seriesMapping"] as const) if (!Array.isArray(m[k])) throw new RangeError(`model.${k} must be an array`);
  const p = m.panels;
  if (!isRecord(p) || !Array.isArray(p.all) || !Array.isArray(p.included)) throw new RangeError("model.panels must be { all, included }, two panel lists");
  if (!isRecord(m.storedUnder)) throw new RangeError("model.storedUnder must be a record of input id to stored id");
  if (!isRecord(m.backtest)) throw new RangeError("model.backtest must be the reference backtest options");
  return versionOrModel;
}
