// Issue 1751, gap 3: every engine rule is one RegimeRules object. The presets
// REGIME_RULES.v3 and REGIME_RULES.v4 are the per-version tables, so a run given
// a preset equals the run given its version; one changed rule changes only what
// that rule decides; and runRegime's in-sample end can follow the version computed.
// Issue 1765: runRegime takes the rules, and rules.keptHistory picks the engine
// (D-g); the main line is computed once when its panels are ALL_PANELS (D-e).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  computeKeptRegime,
  computeRegime,
  knowledgeTimeHistory,
  latestCompleteDay,
  missingOnDay,
  parseRawHistory,
  prepareRegimeInputs,
  regimeLabels,
  regimeRulesOf,
  requireComplete,
  runRegime,
  toHistory,
  ALL_PANELS,
  PANELS,
  REGIME_ADOPTION_DATE,
  REGIME_COMPOSITE_NORMALISATION,
  REGIME_KEPT_HISTORY,
  REGIME_KNOWLEDGE_TIME,
  REGIME_LABEL_CUT,
  REGIME_LOOKBACK,
  REGIME_MISSING_PANEL,
  REGIME_OBSERVATION_WINDOWS,
  REGIME_RULES,
  REGIME_VERSIONS,
  REGIME_WEIGHT_REFRESH,
  type RegimeRules,
  type RegimeVersion,
  type RawIndicatorHistory,
  type RunOptions,
} from "../src/index.ts";
import { ratioDeclarationsFor, ratiosFromLegs } from "../src/transform/ratios.ts";
import { resolveInputHistory, seriesMappingFor, storedUnderFor } from "../src/series-ids.ts";

setDefaultTimeout(120_000);

const raw = toHistory(parseRawHistory(await Bun.file(join(import.meta.dir, "fixtures/raw-indicator-history.json")).text()));
const START = "2018-01-01";
let asof = START;
for (const id in raw) for (const r of raw[id]!) if (r.date > asof) asof = r.date;

const compute = (version: RegimeVersion, rules?: RegimeRules) => {
  const prepared = prepareRegimeInputs(raw, { start: START, asof, version, rules });
  const result = computeRegime(prepared.transformed, prepared.dateAxis, PANELS, prepared.ages, undefined, version, undefined, undefined, { recordWeightFits: true, rules }, prepared.carried);
  return { prepared, result };
};

describe("REGIME_RULES presets (issue 1751)", () => {
  test("each preset is built from the per-version tables", () => {
    for (const v of REGIME_VERSIONS) {
      expect(REGIME_RULES[v]).toEqual({
        knowledgeTime: REGIME_KNOWLEDGE_TIME[v],
        observationWindows: REGIME_OBSERVATION_WINDOWS[v],
        weightRefresh: REGIME_WEIGHT_REFRESH[v],
        missingPanel: REGIME_MISSING_PANEL[v],
        labelCut: REGIME_LABEL_CUT[v],
        lookback: REGIME_LOOKBACK[v],
        adoptionDate: REGIME_ADOPTION_DATE[v]!,
        // Issue 1753: stated only where a version departs from v3 and v4.
        ...(REGIME_COMPOSITE_NORMALISATION[v] === "none" ? {} : { compositeNormalisation: REGIME_COMPOSITE_NORMALISATION[v] }),
        ...(REGIME_KEPT_HISTORY[v] ? { keptHistory: true } : {}),
      });
      expect(regimeRulesOf(v)).toBe(REGIME_RULES[v]);
    }
    expect(Object.keys(REGIME_RULES.v3).sort()).toEqual(Object.keys(REGIME_RULES.v4).sort());
    expect("compositeNormalisation" in REGIME_RULES.v4 || "keptHistory" in REGIME_RULES.v4).toBe(false);
    expect(REGIME_LABEL_CUT).toEqual({ v3: "percentile", v4: "series", v5: "series" });
    expect(regimeRulesOf()).toBe(REGIME_RULES.v4);
  });

  for (const v of REGIME_VERSIONS) {
    test(`prepareRegimeInputs and computeRegime with rules REGIME_RULES.${v} deep-equal the run with version "${v}"`, () => {
      const byVersion = compute(v);
      // The preset wins over the version argument: pass the other version beside it.
      const other = REGIME_VERSIONS.find((x) => x !== v)!;
      const byRules = compute(other, REGIME_RULES[v]);
      expect(byRules.prepared).toEqual(byVersion.prepared);
      expect(byRules.result).toEqual(byVersion.result);
      expect(compute(v, REGIME_RULES[v]).result).toEqual(byVersion.result);
      expect(byVersion.result.regime.filter((l) => l != null).length).toBeGreaterThan(1000);
    });
  }

  test("the two presets give different runs, so the comparison is not vacuous", () => {
    const v3 = compute("v3");
    const v4 = compute("v4");
    expect(v3.prepared.transformed).not.toEqual(v4.prepared.transformed);
    expect(v3.result.regime).not.toEqual(v4.result.regime);
  });

  test("the other functions read the rules: knowledgeTimeHistory, latestCompleteDay, missingOnDay and regimeLabels", () => {
    for (const v of REGIME_VERSIONS) {
      const other = REGIME_VERSIONS.find((x) => x !== v)!;
      expect(knowledgeTimeHistory(raw, { asof, version: other, rules: REGIME_RULES[v] })).toEqual(knowledgeTimeHistory(raw, { asof, version: v }));
      expect(latestCompleteDay(raw, { version: other, rules: REGIME_RULES[v] })).toBe(latestCompleteDay(raw, { version: v }));
      expect(missingOnDay(raw, asof, undefined, other, REGIME_RULES[v])).toEqual(missingOnDay(raw, asof, undefined, v));
    }
    expect(knowledgeTimeHistory(raw, { asof, version: "v3" })).not.toEqual(knowledgeTimeHistory(raw, { asof, version: "v4" }));
    const { result } = compute("v4");
    expect(regimeLabels(result.composite, result.compositePercentile, "v4", REGIME_RULES.v3)).toEqual(regimeLabels(result.composite, result.compositePercentile, "v3"));
    expect(regimeLabels(result.composite, result.compositePercentile, "v3", REGIME_RULES.v4)).toEqual(result.regime);
    expect(regimeLabels(result.composite, result.compositePercentile, "v3")).not.toEqual(result.regime);
  });
});

describe("one changed rule (issue 1751)", () => {
  test("v4 with missingPanel rebase changes the composite on the days a panel is missing, and no weight", () => {
    const v4 = compute("v4").result;
    const rebased = compute("v4", { ...REGIME_RULES.v4, missingPanel: "rebase" }).result;
    const missingDays = v4.dateAxis.flatMap((_, i) => {
      const finite = PANELS.filter((p) => Number.isFinite(v4.panelIndices[p]![i])).length;
      return finite > 0 && finite < PANELS.length ? [i] : [];
    });
    expect(missingDays.length).toBeGreaterThan(0);
    for (const i of missingDays) {
      expect(v4.composite[i]).toBeNaN();
      const finite = PANELS.map((p) => rebased.panelIndices[p]![i]!).filter(Number.isFinite);
      expect(rebased.composite[i]).toBeCloseTo(finite.reduce((a, b) => a + b, 0) / finite.length, 12);
    }
    const missing = new Set(missingDays);
    for (let i = 0; i < v4.dateAxis.length; i++) if (!missing.has(i)) expect(Object.is(rebased.composite[i], v4.composite[i])).toBe(true);
    // Nothing else in the weights: every fit, the fit date, the ranks and the panel indices are the same.
    expect(rebased.weightFits).toEqual(v4.weightFits);
    expect(rebased.weightsByPanel).toEqual(v4.weightsByPanel);
    expect(rebased.weightFitDate).toBe(v4.weightFitDate);
    expect(rebased.signed).toEqual(v4.signed);
    expect(rebased.panelIndices).toEqual(v4.panelIndices);
  });

  test("a lookback argument overrides the lookback of the rules; a malformed rules object is a RangeError naming the field", () => {
    const { prepared } = compute("v4");
    const short = { rank: { kind: "trailing", days: 400 }, weight: { kind: "trailing", days: 400 }, percentile: { kind: "trailing", days: 400 } } as const;
    const run = (lookback: typeof short | undefined, rules?: RegimeRules) =>
      computeRegime(prepared.transformed, prepared.dateAxis, PANELS, prepared.ages, undefined, "v4", lookback, undefined, { rules }, prepared.carried);
    expect(run(undefined, { ...REGIME_RULES.v4, lookback: short })).toEqual(run(short));
    expect(run(short, REGIME_RULES.v4)).toEqual(run(short));
    expect(run(short).composite).not.toEqual(run(undefined).composite);
    const bad = (patch: object, field: RegExp) => {
      const call = () => regimeRulesOf("v4", { ...REGIME_RULES.v4, ...patch } as RegimeRules);
      expect(call).toThrow(RangeError);
      expect(call).toThrow(field);
    };
    bad({ missingPanel: "skip" }, /rules\.missingPanel/);
    bad({ labelCut: "rank" }, /rules\.labelCut/);
    bad({ knowledgeTime: "yes" }, /rules\.knowledgeTime/);
    bad({ observationWindows: 1 }, /rules\.observationWindows/);
    bad({ weightRefresh: { intervalDays: 0, anchor: "2018-01-01", refitOnLastDay: false } }, /rules\.weightRefresh/);
    bad({ adoptionDate: "July" }, /rules\.adoptionDate/);
    expect(() => prepareRegimeInputs(raw, { start: START, asof, rules: { ...REGIME_RULES.v4, missingPanel: "skip" } as never })).toThrow(/rules\.missingPanel/);
  });
});

describe("runRegime in-sample end (issue 1751)", () => {
  const split = (opts: RunOptions) => {
    const run = requireComplete(runRegime(raw, opts));
    const lines = Object.values(run.backtest!).flatMap((market) => Object.values(market));
    expect(lines.length).toBeGreaterThan(20);
    const dates = new Set(lines.map((l) => l.sample_split_date));
    expect(dates.size).toBe(1);
    return { date: [...dates][0]!, composite: run.backtest!.eth!.composite!, run };
  };

  test("version v3 with inSampleEnd computed-version reports in_sample ending 2026-07-01", () => {
    const { date, composite } = split({ version: "v3", inSampleEnd: "computed-version" });
    expect(date).toBe("2026-07-01");
    expect(composite.in_sample.end_date).toBe("2026-07-01");
    expect(composite.out_of_sample.start_date).toBe("2026-07-02");
    expect(composite.out_of_sample.n_days).toBeGreaterThan(0);
  });

  test("with no inSampleEnd, and with current-version, it reports 2026-11-17 as in 0.8.0", () => {
    const dflt = split({ version: "v3" });
    expect(dflt.date).toBe("2026-11-17");
    expect(dflt.composite.out_of_sample.n_days).toBe(0);
    expect(split({ version: "v3", inSampleEnd: "current-version" }).run).toEqual(dflt.run);
    // Under the current version both choices name the same date.
    expect(split({ inSampleEnd: "computed-version" }).run).toEqual(split({}).run);
  });

  test("computed-version splits on the adoption date of the rules in force (issue 1765)", () => {
    const { date, composite } = split({ version: "v4", rules: { ...REGIME_RULES.v4, adoptionDate: "2025-01-01" }, inSampleEnd: "computed-version" });
    expect(date).toBe("2025-01-01");
    expect(composite.in_sample.end_date).toBe("2025-01-01");
    // current-version keeps the current version's adoption date whatever the rules.
    expect(split({ version: "v4", rules: { ...REGIME_RULES.v4, adoptionDate: "2025-01-01" } }).date).toBe("2026-11-17");
  });

  test("an unknown RunOptions key or value is a RangeError naming it; a full rules object is a known option", () => {
    const bad = (o: unknown, field: RegExp) => {
      const call = () => runRegime(raw, o as RunOptions);
      expect(call).toThrow(RangeError);
      expect(call).toThrow(field);
    };
    bad({ insampleEnd: "computed-version" }, /unknown option "insampleEnd"/);
    // Issue 1765: rules is a known option, checked whole by regimeRulesOf.
    expect(requireComplete(runRegime(raw, { version: "v3", rules: REGIME_RULES.v3 }))).toEqual(requireComplete(runRegime(raw, { version: "v3" })));
    bad({ rules: { ...REGIME_RULES.v4, labelCut: "bogus" } }, /rules\.labelCut/);
    bad({ rules: "v4" }, /rules must be a RegimeRules object/);
    bad({ inSampleEnd: "v3" }, /inSampleEnd/);
    bad({ storedOnlyRatio: "warn" }, /storedOnlyRatio/);
  });
});

// The input runRegime hands its engine under version v4: storage names resolved
// and each ratio set from its legs as the rules' knowledgeTime declares.
const runInputOf = (rules: RegimeRules): RawIndicatorHistory =>
  ratiosFromLegs(raw, resolveInputHistory(raw, seriesMappingFor("v4"), storedUnderFor("v4")), ratioDeclarationsFor(rules));

// v4 under rules the kept engine accepts: calendar-day windows, labels cut on
// the series, a daily refit, and keptHistory.
const KEPT_V4: RegimeRules = {
  ...REGIME_RULES.v4,
  observationWindows: false,
  labelCut: "series",
  weightRefresh: { ...REGIME_RULES.v4.weightRefresh, intervalDays: 1 },
  keptHistory: true,
};
const { keptHistory: _kept, ...RECOMPUTE_V4 } = KEPT_V4;

describe("rules pick the engine (issue 1765, D-g)", () => {
  // Computed once, inside the first test that reads it.
  let keptMemo: ReturnType<typeof requireComplete> | undefined;
  const keptRunOf = () => (keptMemo ??= requireComplete(runRegime(raw, { version: "v4", rules: KEPT_V4, asof, start: START })));

  test("custom rules with keptHistory on version v4 run the kept engine, equal day for day to computeKeptRegime", () => {
    expect(REGIME_KEPT_HISTORY.v4).toBe(false);
    const keptRun = keptRunOf();
    const direct = computeKeptRegime(runInputOf(KEPT_V4), { version: "v4", rules: KEPT_V4, asof, start: START });
    expect(keptRun.version).toBe("v4");
    expect(keptRun.dateAxis).toEqual(direct.dateAxis);
    expect(keptRun.result.composite).toEqual(direct.record.composite);
    expect(keptRun.result.regime).toEqual(direct.record.regime);
    for (const p of PANELS) expect(keptRun.result.panelIndices[p]).toEqual(direct.record.panelIndices[p]!);
    expect(keptRun.result.compositeMean).toEqual(direct.record.compositeMean);
    expect(keptRun.result.weightsByPanel).toEqual(direct.fit.weightsByPanel);
    // The kept engine computes no trailing percentile of the composite.
    expect(keptRun.result.compositePercentile.every(Number.isNaN)).toBe(true);
    expect(keptRun.result.regime.filter((l) => l != null).length).toBeGreaterThan(1000);
  });

  test("the same rules without keptHistory run the recompute engine, which reads them", () => {
    const rec = requireComplete(runRegime(raw, { version: "v4", rules: RECOMPUTE_V4, asof, start: START }));
    const prepared = prepareRegimeInputs(runInputOf(RECOMPUTE_V4), { start: START, asof, version: "v4", rules: RECOMPUTE_V4 });
    const direct = computeRegime(prepared.transformed, prepared.dateAxis, PANELS, prepared.ages, undefined, "v4", undefined, undefined, { rules: RECOMPUTE_V4 }, prepared.carried);
    expect(rec.result).toEqual(direct);
    // The recompute engine keeps the trailing percentile; the kept engine has none and states its mean.
    expect(rec.result.compositePercentile.filter(Number.isFinite).length).toBeGreaterThan(1000);
    expect(rec.result.compositeMean).toBeUndefined();
    expect(keptRunOf().result.compositeMean).toBeDefined();
    // The rules are read, not the v4 preset: the daily refit gives other weights.
    const preset = requireComplete(runRegime(raw, { version: "v4", asof, start: START }));
    expect(rec.result.panelIndices).not.toEqual(preset.result.panelIndices);
  });

  test("a kept rules object whose weightRefresh.intervalDays is not 1 is a RangeError", () => {
    const every21 = { ...KEPT_V4, weightRefresh: REGIME_RULES.v4.weightRefresh };
    // The object is valid rules; only the kept engine, which fits every day, refuses it.
    expect(regimeRulesOf("v4", every21)).toBe(every21);
    for (const call of [
      () => runRegime(raw, { version: "v4", rules: every21, asof, start: START }),
      () => computeKeptRegime(runInputOf(every21), { version: "v4", rules: every21, asof, start: START }),
    ]) {
      expect(call).toThrow(RangeError);
      expect(call).toThrow(/rules\.weightRefresh\.intervalDays must be 1, got 21/);
    }
  });
});

describe("runRegime computes the main line once (issue 1765, D-e)", () => {
  const overAll = (rules: RegimeRules = REGIME_RULES.v4) => {
    const prepared = prepareRegimeInputs(runInputOf(rules), { start: START, asof, version: "v4" });
    return computeRegime(prepared.transformed, prepared.dateAxis, ALL_PANELS, prepared.ages, undefined, "v4", undefined, undefined, undefined, prepared.carried);
  };

  test("with the default panels factor is result itself, and deep-equals a separate computeRegime over ALL_PANELS", () => {
    expect(PANELS).toEqual(ALL_PANELS);
    const run = requireComplete(runRegime(raw, { factor: true, asof, start: START }));
    expect(run.factor).toBe(run.result);
    expect(run.factor).toEqual(overAll());
  });

  test("with panels macro and onchain factor is a second computation over ALL_PANELS", () => {
    const run = requireComplete(runRegime(raw, { factor: true, panels: ["macro", "onchain"], asof, start: START }));
    expect(run.factor).not.toBe(run.result);
    expect(run.result.panels).toEqual(["macro", "onchain"]);
    expect(run.factor).toEqual(overAll());
  });
});
