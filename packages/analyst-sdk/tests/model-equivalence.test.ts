// Issue 1765, phase 2: a methodology is one model value (proposal section 6.2).
// MODELS holds the published presets, and every legacy per-version table is
// the matching MODELS field, by identity: REGIME_RULES[v] is MODELS[v].rules,
// REGIME_BACKTEST_RULES[v] is MODELS[v].backtest, seriesMappingFor(v) is
// MODELS[v].seriesMapping, and so on. modelOf names a preset by its tag and
// checks a passed model. This is the model-value half of the acceptance test;
// the runModel equivalence and the v4 golden check come with the staged engine.
//
// Excluded by design: REGIME_LINE, REGIME_ARTIFACT_KIND and
// REGIME_PUBLISHED_PANELS. They say where and how a version is published, a
// platform fact and not a model property, so no MODELS field matches them. The
// coverage test below lists them by name, so a new per-version table must be a
// view of the presets or be named a platform table here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as versions from "../src/analyze/regime-versions.ts";
import {
  REGIME_ADOPTION_DATE, REGIME_COMPOSITE_NORMALISATION, REGIME_DERIVED_SERIES, REGIME_KEPT_HISTORY, REGIME_KNOWLEDGE_TIME, REGIME_LABEL_CUT,
  REGIME_LOOKBACK, REGIME_MISSING_PANEL, REGIME_OBSERVATION_WINDOWS, REGIME_REGISTRY, REGIME_RULES, REGIME_VERSIONS, REGIME_WEIGHT_REFRESH,
  adoptionDate, regimeRulesOf, type RegimeVersion,
} from "../src/analyze/regime-versions.ts";
import { REGIME_BACKTEST_RULES } from "../src/analyze/backtest.ts";
import { ALL_PANELS, INDICATORS, PANELS, V5_INDICATORS } from "../src/analyze/indicators.ts";
import { V5_DERIVED_SERIES } from "../src/transform/derived.ts";
import { SERIES_MAPPING, STORED_UNDER, V5_SERIES_MAPPING, V5_STORED_UNDER } from "../src/series-ids.ts";
import { MODELS, PRESETS, modelOf, seriesMappingFor, storedUnderFor, type RegimeModel } from "../src/model/index.ts";
import * as sdk from "../src/index.ts";

const SRC = join(import.meta.dir, "..", "src");

// Each legacy per-version table and the MODELS field it must equal, by identity.
const FIELD_OF_TABLE: Readonly<Record<string, (m: RegimeModel) => unknown>> = {
  REGIME_RULES: (m) => m.rules,
  REGIME_REGISTRY: (m) => m.registry,
  REGIME_DERIVED_SERIES: (m) => m.derived,
  REGIME_KEPT_HISTORY: (m) => m.history === "kept",
  REGIME_LOOKBACK: (m) => m.rules.lookback,
  REGIME_WEIGHT_REFRESH: (m) => m.rules.weightRefresh,
  REGIME_KNOWLEDGE_TIME: (m) => m.rules.knowledgeTime,
  REGIME_OBSERVATION_WINDOWS: (m) => m.rules.observationWindows,
  REGIME_MISSING_PANEL: (m) => m.rules.missingPanel,
  REGIME_LABEL_CUT: (m) => m.rules.labelCut,
  REGIME_ADOPTION_DATE: (m) => m.rules.adoptionDate,
  REGIME_COMPOSITE_NORMALISATION: (m) => m.rules.compositeNormalisation ?? "none",
};
const TABLES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  REGIME_RULES, REGIME_REGISTRY, REGIME_DERIVED_SERIES, REGIME_KEPT_HISTORY, REGIME_LOOKBACK, REGIME_WEIGHT_REFRESH, REGIME_KNOWLEDGE_TIME,
  REGIME_OBSERVATION_WINDOWS, REGIME_MISSING_PANEL, REGIME_LABEL_CUT, REGIME_ADOPTION_DATE, REGIME_COMPOSITE_NORMALISATION,
};
// Platform publication facts: no MODELS field matches them.
const PLATFORM_TABLES = ["REGIME_LINE", "REGIME_PUBLISHED_PANELS"];

describe("MODELS: the published presets (issue 1765)", () => {
  test("MODELS has one frozen model per tag, in tag order, each named by its tag", () => {
    expect(Object.keys(MODELS)).toEqual([...REGIME_VERSIONS]);
    expect(Object.isFrozen(MODELS)).toBe(true);
    for (const v of REGIME_VERSIONS) {
      expect(MODELS[v].id).toBe(v);
      expect(Object.isFrozen(MODELS[v]), v).toBe(true);
      expect(Object.isFrozen(MODELS[v].rules), v).toBe(true);
      expect(Object.keys(MODELS[v])).toEqual(["id", "rules", "registry", "derived", "history", "panels", "seriesMapping", "storedUnder", "backtest"]);
    }
  });

  test("each model is its preset plus the version's backtest rules, every field by identity", () => {
    for (const v of REGIME_VERSIONS) {
      const { backtest, ...facts } = MODELS[v];
      expect(backtest).toBe(REGIME_BACKTEST_RULES[v]);
      for (const [k, value] of Object.entries(facts)) expect(value, `${v}.${k}`).toBe(PRESETS[v][k as keyof (typeof PRESETS)[RegimeVersion]]);
    }
  });

  test("the presets state the registry, the derived series, the history, the panels and the storage of each version", () => {
    for (const v of ["v3", "v4"] as const) {
      expect(MODELS[v].registry).toBe(INDICATORS);
      expect(MODELS[v].derived).toEqual([]);
      expect(MODELS[v].history).toBe("recompute");
      expect(MODELS[v].seriesMapping).toBe(SERIES_MAPPING);
      expect(MODELS[v].storedUnder).toBe(STORED_UNDER);
    }
    expect(MODELS.v5.registry).toBe(V5_INDICATORS);
    expect(MODELS.v5.derived).toBe(V5_DERIVED_SERIES);
    expect(MODELS.v5.history).toBe("kept");
    expect(MODELS.v5.seriesMapping).toBe(V5_SERIES_MAPPING);
    expect(MODELS.v5.storedUnder).toBe(V5_STORED_UNDER);
    // runRegime's default panels: every panel computed, PANELS averaged.
    for (const v of REGIME_VERSIONS) expect(MODELS[v].panels).toEqual({ all: ALL_PANELS, included: PANELS });
  });

  test("history and rules.keptHistory state one fact: only a kept model sets keptHistory, and v3 and v4 rules keep their shape", () => {
    for (const v of REGIME_VERSIONS) expect(MODELS[v].rules.keptHistory === true, v).toBe(MODELS[v].history === "kept");
    for (const v of ["v3", "v4"] as const) {
      expect("keptHistory" in MODELS[v].rules).toBe(false);
      expect("compositeNormalisation" in MODELS[v].rules).toBe(false);
    }
  });
});

describe("every legacy per-version table equals the matching MODELS field", () => {
  for (const [name, field] of Object.entries(FIELD_OF_TABLE)) {
    test(`${name}[v] is MODELS[v]'s field for every version`, () => {
      const table = TABLES[name]!;
      expect(Object.keys(table)).toEqual([...REGIME_VERSIONS]);
      expect(Object.isFrozen(table)).toBe(true);
      for (const v of REGIME_VERSIONS) expect(table[v], `${name}.${v}`).toBe(field(MODELS[v]));
    });
  }

  test("REGIME_BACKTEST_RULES, regimeRulesOf, adoptionDate, seriesMappingFor and storedUnderFor read the same model fields", () => {
    for (const v of REGIME_VERSIONS) {
      expect(REGIME_BACKTEST_RULES[v]).toBe(MODELS[v].backtest as (typeof REGIME_BACKTEST_RULES)[RegimeVersion]);
      expect(regimeRulesOf(v)).toBe(MODELS[v].rules);
      expect(adoptionDate(v)).toBe(MODELS[v].rules.adoptionDate);
      expect(seriesMappingFor(v)).toBe(MODELS[v].seriesMapping);
      expect(storedUnderFor(v)).toBe(MODELS[v].storedUnder);
    }
  });

  test("every per-version table regime-versions.ts exports is a model view above or a named platform table", () => {
    const keyedByVersion = Object.entries(versions)
      .filter(([, value]) => value !== null && typeof value === "object" && !Array.isArray(value))
      .filter(([, value]) => JSON.stringify(Object.keys(value as object).sort()) === JSON.stringify([...REGIME_VERSIONS].sort()))
      .map(([name]) => name)
      .sort();
    expect(keyedByVersion).toEqual([...Object.keys(FIELD_OF_TABLE), ...PLATFORM_TABLES].sort());
  });

  test("the package entry exports the model value beside the tables", () => {
    expect(sdk.MODELS).toBe(MODELS);
    expect(sdk.modelOf).toBe(modelOf);
    expect(sdk.seriesMappingFor).toBe(seriesMappingFor);
    expect(sdk.storedUnderFor).toBe(storedUnderFor);
    expect(sdk.REGIME_RULES).toBe(REGIME_RULES);
  });
});

describe("modelOf", () => {
  test("a tag names its preset itself", () => {
    expect(modelOf("v4")).toBe(MODELS.v4);
    for (const v of REGIME_VERSIONS) expect(modelOf(v)).toBe(MODELS[v]);
  });

  test("a passed model is checked and returned as it is: a preset, or a research model with no tag", () => {
    expect(modelOf(MODELS.v5)).toBe(MODELS.v5);
    const research: RegimeModel = { ...MODELS.v4, id: "research-percentile-cut", rules: { ...MODELS.v4.rules, labelCut: "percentile" } };
    expect(modelOf(research)).toBe(research);
    // keptHistory false says the same as an absent one.
    const explicit: RegimeModel = { ...MODELS.v4, rules: { ...MODELS.v4.rules, keptHistory: false } };
    expect(modelOf(explicit)).toBe(explicit);
  });

  test("an unknown tag throws RangeError naming the tags", () => {
    expect(() => modelOf("v9" as RegimeVersion)).toThrow(RangeError);
    expect(() => modelOf("v9" as RegimeVersion)).toThrow(/v3, v4, v5/);
    expect(() => modelOf("" as RegimeVersion)).toThrow(RangeError);
  });

  test("a history other than recompute or kept throws RangeError", () => {
    expect(() => modelOf({ ...MODELS.v4, history: "bogus" } as unknown as RegimeModel)).toThrow(RangeError);
    expect(() => modelOf({ ...MODELS.v4, history: "bogus" } as unknown as RegimeModel)).toThrow(/history/);
    expect(() => modelOf({ ...MODELS.v4, history: undefined } as unknown as RegimeModel)).toThrow(RangeError);
  });

  test("rules.keptHistory that disagrees with history throws RangeError", () => {
    expect(() => modelOf({ ...MODELS.v4, history: "kept" })).toThrow(RangeError);
    expect(() => modelOf({ ...MODELS.v5, history: "recompute" })).toThrow(/keptHistory/);
    expect(() => modelOf({ ...MODELS.v4, rules: { ...MODELS.v4.rules, keptHistory: true } })).toThrow(RangeError);
    const { keptHistory: _dropped, ...v5Rules } = MODELS.v5.rules;
    expect(() => modelOf({ ...MODELS.v5, rules: v5Rules })).toThrow(RangeError);
  });

  test("a bad rule or a missing field throws RangeError naming it", () => {
    expect(() => modelOf({ ...MODELS.v4, rules: { ...MODELS.v4.rules, missingPanel: "zero" } } as unknown as RegimeModel)).toThrow(/missingPanel/);
    expect(() => modelOf({ ...MODELS.v4, rules: undefined } as unknown as RegimeModel)).toThrow(/rules/);
    expect(() => modelOf({ ...MODELS.v4, id: "" })).toThrow(/id/);
    expect(() => modelOf({ ...MODELS.v4, registry: undefined } as unknown as RegimeModel)).toThrow(/registry/);
    expect(() => modelOf({ ...MODELS.v4, panels: { all: ALL_PANELS } } as unknown as RegimeModel)).toThrow(/panels/);
    expect(() => modelOf(null as unknown as RegimeModel)).toThrow(RangeError);
    expect(() => modelOf(42 as unknown as RegimeModel)).toThrow(RangeError);
  });
});

// The version facts live in the presets: the modules that pick a preset's
// storage or build the model branch on no version literal.
const VERSION_BRANCH = [/[!=]==?\s*['"]v\d+['"]/, /['"]v\d+['"]\s*[!=]==?/, /case\s+['"]v\d+['"]/];
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const branches = (src: string): string[] => code(src).split("\n").filter((line) => VERSION_BRANCH.some((re) => re.test(line)));
const importsOf = (src: string): string[] => [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gms)].map((m) => m[1]!).sort();

describe("no version branch outside the presets (issue 1765)", () => {
  for (const file of ["series-ids.ts", "model/preset-series.ts", "model/presets.ts", "model/models.ts", "analyze/regime-versions.ts"]) {
    test(`${file} branches on no version literal`, () => {
      expect(branches(readFileSync(join(SRC, file), "utf8"))).toEqual([]);
    });
  }

  test("red control: a planted comparison with a version literal is flagged, in either order and as a case", () => {
    expect(branches('return version === "v5" ? A : B;')).toHaveLength(1);
    expect(branches("if ('v4' !== v) return;")).toHaveLength(1);
    expect(branches('  case "v3":')).toHaveLength(1);
    expect(branches('// version === "v5" in prose')).toEqual([]);
  });

  test("the presets are leaves: presets.ts and preset-series.ts never reach regime-versions.ts or backtest.ts", () => {
    // backtest.ts calls adoptionDate() as it loads, so a preset module that reached it would be read before it is defined.
    expect(importsOf(readFileSync(join(SRC, "model/presets.ts"), "utf8"))).toEqual(["../analyze/indicators.ts", "../series-ids.ts", "../transform/derived.ts", "./preset-series.ts", "./preset-series.ts"]);
    // The archive format reads this one, so it must reach no calculation code (backend/tests/api/public-analytics-archives.test.ts).
    expect(importsOf(readFileSync(join(SRC, "model/preset-series.ts"), "utf8"))).toEqual(["../series-ids.ts"]);
    expect(importsOf(readFileSync(join(SRC, "archive/format1.ts"), "utf8"))).not.toContain("../model/presets.ts");
  });
});
