// Issue 1751, gap 3: every engine rule is one RegimeRules object. The presets
// REGIME_RULES.v3 and REGIME_RULES.v4 are the per-version tables, so a run given
// a preset equals the run given its version; one changed rule changes only what
// that rule decides; and runRegime's in-sample end can follow the version computed.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
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
  type RunOptions,
} from "../src/index.ts";

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

  test("an unknown RunOptions key or value is a RangeError naming it", () => {
    const bad = (o: unknown, field: RegExp) => {
      const call = () => runRegime(raw, o as RunOptions);
      expect(call).toThrow(RangeError);
      expect(call).toThrow(field);
    };
    bad({ insampleEnd: "computed-version" }, /unknown option "insampleEnd"/);
    bad({ rules: REGIME_RULES.v3 }, /unknown option "rules"/);
    bad({ inSampleEnd: "v3" }, /inSampleEnd/);
    bad({ storedOnlyRatio: "warn" }, /storedOnlyRatio/);
  });
});
