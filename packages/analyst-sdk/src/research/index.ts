// The research driver (issue 1765, phase 5; proposal section 6.6). Pure: no
// fs, env, db or network.
//
//   stageCache   the caller-owned stage cache (engine/cache.ts): keyed by input
//                digest, stage and stage params, a plain Map the caller owns
//   screen       one model's rules varied over a grid, every variant run
//                through runModel with one shared cache, ranked by a metric
//   custom op    a DerivedSeries written as a pure function with a declared
//                publication lag (transform/derived.ts), so a new indicator
//                needs no SDK release
//
// The frozen research comparisons live in legacy/ with their verbatim headers.
// They are not part of this driver.
//
// The package entry ('.') exports all of these.
export { stageCache, STAGES, type StageCache, type StageName } from "../engine/cache.ts";
export { screen, type RuleVariant, type ScreenEntry, type ScreenMetric, type ScreenOptions } from "./screen.ts";
export type { DerivedCustom, DeriveOptions } from "../transform/derived.ts";
