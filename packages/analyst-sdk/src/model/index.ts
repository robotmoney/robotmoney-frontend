// The model module (issue 1765, phase 2): the published presets and the model value.
export {
  REGIME_VERSIONS, CURRENT_REGIME_VERSION, WEIGHT_REFRESH_ANCHOR, PRESETS, seriesMappingFor, storedUnderFor,
  type RegimeVersion, type RegimeRules, type RegimeLookback, type LookbackWindow, type WeightRefresh, type MissingPanelRule,
  type CompositeNormalisation, type LabelCut, type ModelHistory, type ModelPanels, type ModelFacts, type PresetSeries,
} from "./presets.ts";
export { MODELS, modelOf, type RegimeModel } from "./models.ts";
