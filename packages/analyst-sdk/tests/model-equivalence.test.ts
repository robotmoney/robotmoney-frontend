// Issue 1765, phase 2: a methodology is one model value (proposal section 6.2).
// MODELS holds the published presets, and every legacy per-version table is
// the matching MODELS field, by identity: REGIME_RULES[v] is MODELS[v].rules,
// REGIME_BACKTEST_RULES[v] is MODELS[v].backtest, seriesMappingFor(v) is
// MODELS[v].seriesMapping, and so on. modelOf names a preset by its tag and
// checks a passed model. The staged engine half (issue 1765, AC 9): runModel
// over each preset equals the engine it replaces day for day (computeRegime
// under REGIME_RULES.v3 and .v4, computeKeptRegime under .v5), the v4 report
// runModel gives is the committed golden byte for byte, the positional
// computeRegime wrapper equals its options form, and a two-panel run reads no
// weight of the panel it leaves out from the fit every panel shares.
//
// Excluded by design: REGIME_LINE, REGIME_ARTIFACT_KIND and
// REGIME_PUBLISHED_PANELS. They say where and how a version is published, a
// platform fact and not a model property, so no MODELS field matches them. The
// coverage test below lists them by name, so a new per-version table must be a
// view of the presets or be named a platform table here.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
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
import { computeRegime, type ComputeRegimeOptions } from "../src/analyze/compute.ts";
import { computeKeptRegime } from "../src/analyze/kept-regime.ts";
import { prepareRegimeInputs } from "../src/prepare.ts";
import { buildReport, requireComplete, runRegime } from "../src/run.ts";
import { runModel } from "../src/engine/run-model.ts";
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import { resolveInputHistory } from "../src/series-ids.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "../src/transform/ratios.ts";
import type { Panel } from "../src/analyze/indicators.ts";
import type { RawIndicatorHistory } from "../src/types.ts";

setDefaultTimeout(300_000);

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

// ── The staged engine (issue 1765, AC 9) ─────────────────────────────────────

const FIXTURES = join(import.meta.dir, "fixtures");
const csv = readFileSync(join(FIXTURES, "raw-indicator-history.csv"), "utf8");
const goldenText = readFileSync(join(import.meta.dir, "golden", "regime-report.json"), "utf8");
const raw = toHistory(parseRawHistory(csv));
const START = "2018-01-01";
// The golden's as-of day: runRegime's default, the newest row the run reads.
const ASOF = (JSON.parse(goldenText) as { asof: string }).asof;
// The run input a model reads: storage names resolved, each ratio set as its rules declare (runRegime's ratio step).
const inputOf = (m: RegimeModel): RawIndicatorHistory => ratiosFromLegs(raw, resolveInputHistory(raw, m.seriesMapping, m.storedUnder), ratioDeclarationsFor(m.rules));
const same = (a: number, b: number) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
const TWO: Panel[] = ALL_PANELS.filter((p) => p !== "factor");

// computeRegime over prepared inputs under a preset's rules, in the positional form callers use today.
function positional(v: "v3" | "v4", panels: Panel[] = [...PANELS]) {
  const m = MODELS[v];
  const p = prepareRegimeInputs(inputOf(m), { start: START, asof: ASOF, indicators: m.registry, rules: REGIME_RULES[v] });
  return { p, result: computeRegime(p.transformed, p.dateAxis, panels, p.ages, undefined, v, undefined, undefined, undefined, p.carried) };
}

describe("runModel over each preset equals the engine it replaces (issue 1765, AC 9)", () => {
  for (const v of ["v3", "v4"] as const) {
    test(`runModel(MODELS.${v}) equals computeRegime under REGIME_RULES.${v}, every array of the result, day for day`, () => {
      const run = runModel(MODELS[v], inputOf(MODELS[v]), { asof: ASOF, start: START });
      const { p, result } = positional(v);
      expect(run.version).toBe(v);
      expect(run.model).toBe(MODELS[v]);
      expect(run.dateAxis).toEqual(p.dateAxis);
      expect(run.result).toEqual(result);
      const days = result.dateAxis.length;
      expect(days).toBeGreaterThan(3000);
      for (let i = 0; i < days; i++) {
        expect(same(run.result.composite[i]!, result.composite[i]!), `composite ${i}`).toBe(true);
        expect(same(run.result.compositePercentile[i]!, result.compositePercentile[i]!), `compositePercentile ${i}`).toBe(true);
        expect(run.result.regime[i], `regime ${i}`).toBe(result.regime[i]!);
        for (const panel of PANELS) {
          expect(same(run.result.panelIndices[panel]![i]!, result.panelIndices[panel]![i]!), `${panel} ${i}`).toBe(true);
          expect(run.result.panelRegimes[panel]![i], `${panel} label ${i}`).toBe(result.panelRegimes[panel]![i]!);
        }
      }
      // The prepared inputs runModel carries are the seam's.
      expect(run.prepared.transformed).toEqual(p.transformed);
      expect(run.result.regime.filter((l) => l != null).length).toBeGreaterThan(1000);
    });
  }

  test("runModel(MODELS.v5) equals computeKeptRegime day for day: the scores, every computed day, the as-of fit and the record", () => {
    const input = inputOf(MODELS.v5);
    const run = runModel(MODELS.v5, input, { asof: ASOF, start: START });
    const direct = computeKeptRegime(input, { asof: ASOF, start: START });
    const kept = run.keptRun!;
    expect(kept.version).toBe("v5");
    expect(kept.dateAxis).toEqual(direct.dateAxis);
    expect(kept.scores).toEqual(direct.scores);
    expect(kept.fit).toEqual(direct.fit);
    expect(kept.computed).toEqual(direct.computed);
    expect(kept.record).toEqual(direct.record);
    const { record } = direct;
    for (let i = 0; i < record.dateAxis.length; i++) {
      expect(same(run.result.composite[i]!, record.composite[i]!), `composite ${i}`).toBe(true);
      expect(same(run.result.compositeMean![i]!, record.compositeMean[i]!), `compositeMean ${i}`).toBe(true);
      expect(run.result.regime[i], `regime ${i}`).toBe(record.regime[i]!);
      for (const panel of PANELS) expect(same(run.result.panelIndices[panel]![i]!, record.panelIndices[panel]![i]!), `${panel} ${i}`).toBe(true);
    }
    expect(run.result.weightsByPanel).toEqual(direct.fit.weightsByPanel);
    expect(run.registry).toBe(MODELS.v5.registry);
    expect(record.regime.filter((l) => l != null).length).toBeGreaterThan(1000);
  });

  test("the v4 report runModel gives is tests/golden/regime-report.json byte for byte", () => {
    const run = runModel(MODELS.v4, inputOf(MODELS.v4), { asof: ASOF });
    expect(JSON.stringify(buildReport(run), null, 2) + "\n").toBe(goldenText);
    // runRegime, now a wrapper over runModel, gives the same bytes and the same JSON run.
    const viaRegime = requireComplete(runRegime(raw));
    expect(JSON.stringify(buildReport(viaRegime), null, 2) + "\n").toBe(goldenText);
    expect(JSON.stringify(run)).toBe(JSON.stringify(viaRegime));
  });

  test("the positional computeRegime wrapper equals the options form", () => {
    const { p, result } = positional("v4");
    const opts: ComputeRegimeOptions = { panels: [...PANELS], ages: p.ages, rules: REGIME_RULES.v4, carried: p.carried };
    expect(computeRegime(p.transformed, p.dateAxis, opts)).toEqual(result);
    // v3 through each form, and the weight fits each records.
    const v3 = positional("v3");
    const fits = { recordWeightFits: true, rules: REGIME_RULES.v3 };
    expect(computeRegime(v3.p.transformed, v3.p.dateAxis, { panels: [...PANELS], ages: v3.p.ages, carried: v3.p.carried, ...fits }))
      .toEqual(computeRegime(v3.p.transformed, v3.p.dateAxis, [...PANELS], v3.p.ages, undefined, "v3", undefined, undefined, fits, v3.p.carried));
    // Two arguments read every default in both forms; a misspelt option is refused, never ignored.
    expect(computeRegime(p.transformed, p.dateAxis, {})).toEqual(computeRegime(p.transformed, p.dateAxis));
    expect(() => computeRegime(p.transformed, p.dateAxis, { panel: TWO } as unknown as ComputeRegimeOptions)).toThrow(/unknown computeRegime option "panel"/);
    // An undefined third argument with more after it is the positional form (fill-policy.test.ts calls it so).
    expect(computeRegime(p.transformed, p.dateAxis, undefined, p.ages, undefined, "v4", undefined, undefined, undefined, p.carried)).toEqual(result);
  });

  test("with panels macro and onchain, runModel equals positional computeRegime over the whole object, and the report bytes are equal", () => {
    // The fit covers every panel (`panels` defaults to every panel); the two-panel result reads only its own.
    const run = runModel(MODELS.v4, inputOf(MODELS.v4), { asof: ASOF, start: START, included: TWO, factor: true });
    const two = positional("v4", [...TWO]).result;
    expect(run.result).toEqual(two);
    expect(Object.keys(run.result.weightsByPanel)).toEqual(TWO);
    expect("factorIndex" in run.result).toBe(false);
    expect(run.factor).toEqual(positional("v4", [...ALL_PANELS]).result);
    expect(run.panelSets.map((s) => s.panels)).toEqual([TWO, ALL_PANELS]);
    // The report runRegime gives over the two panels (a fit over those two only) has the same bytes.
    const viaRegime = requireComplete(runRegime(raw, { panels: TWO, factor: true }));
    expect(JSON.stringify(buildReport(run))).toBe(JSON.stringify(buildReport(viaRegime)));
    expect(JSON.stringify(buildReport(run, { full: true }))).toBe(JSON.stringify(buildReport(viaRegime, { full: true })));
    const noFactor = runModel(MODELS.v4, inputOf(MODELS.v4), { asof: ASOF, start: START, included: TWO });
    expect(JSON.stringify(buildReport(noFactor))).toBe(JSON.stringify(buildReport(requireComplete(runRegime(raw, { panels: TWO })))));
  });

  test("a bad option is a RangeError naming it", () => {
    const input = inputOf(MODELS.v4);
    const bad = (o: unknown, re: RegExp) => expect(() => runModel(MODELS.v4, input, o as never)).toThrow(re);
    bad({ asof: ASOF, panel: TWO }, /unknown option "panel"/);
    bad({ asof: "2026-02-30" }, /asof must be a real date/);
    bad({ asof: ASOF, included: ["macro", "macro"] }, /included must be a non-empty list/);
    bad({ asof: ASOF, panels: TWO }, /included panels factor are not in panels/);
    bad({ asof: ASOF, kept: [{ date: "2026-01-01", panelIndices: {} }] }, /recomputes its history: it reads no kept days/);
    expect(() => runModel("v9" as never, input, { asof: ASOF })).toThrow(/unknown methodology version/);
  });
});
