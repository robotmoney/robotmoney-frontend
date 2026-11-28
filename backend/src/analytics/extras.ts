export * from "../../../packages/analyst-sdk/src/extras.ts";
export * from "../../../packages/analyst-sdk/src/series-ids.ts";
// Which mapping a methodology version reads is a fact of its preset (issue 1765): the storage half of the presets.
export { seriesMappingFor, storedUnderFor } from "../../../packages/analyst-sdk/src/model/preset-series.ts";
