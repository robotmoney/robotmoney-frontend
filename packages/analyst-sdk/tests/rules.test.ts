// Rule files (issue 1401): every shipped file validates and fits the universe,
// a broken file fails with an error naming the field, the README example
// validates and runs through `rules:check`, and the files outside the universe
// are refused without `--allow-outside-universe`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  checkHoldings, loadUniverse, parseRuleFile, RuleFileError, ruleHoldings, RULE_STATUSES, validateRuleFile,
} from "../src/index.ts";
import shippedUniverse from "../universe/base-universe.json" with { type: "json" };

const PKG = join(import.meta.dir, "..");
const readJson = (p: string): Record<string, any> => JSON.parse(readFileSync(p, "utf8"));
const filesIn = (dir: string) => readdirSync(join(PKG, dir)).filter((f) => f.endsWith(".json")).map((f) => join(PKG, dir, f));
const RULES = filesIn("rules");
const OUTSIDE = filesIn("rules-outside-universe");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const R1 = readJson(join(PKG, "rules/R1.json"));
const E1 = readJson(join(PKG, "rules/E1.json"));

function readmeExample(): string {
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  const from = readme.indexOf("\n## Rule files\n");
  expect(from).toBeGreaterThan(-1);
  const section = readme.slice(from + 1, readme.indexOf("\n## ", from + 1));
  const m = /```json\n([\s\S]*?)\n```/.exec(section);
  expect(m).not.toBeNull();
  return m![1]!;
}

function runCheck(...args: string[]) {
  const p = Bun.spawnSync(["bun", "run", join(PKG, "bin/check-rule.ts"), ...args], { cwd: PKG, stderr: "pipe", stdout: "pipe" });
  return { code: p.exitCode, err: p.stderr.toString() };
}

describe("shipped rule files", () => {
  test("rules/ holds the reference, the held-still reference, the two-preview variant and the engine versions", () => {
    expect(RULES.map((f) => basename(f, ".json")).sort()).toEqual(["E0", "E1", "E2", "E3", "R1", "R1-frozen", "R2"]);
    expect(OUTSIDE.map((f) => basename(f, ".json")).sort()).toEqual(["E1w", "E2w", "E3w", "P-A1", "P-B", "P-C"]);
  });

  test("every file in rules/ validates, with its id as the file name and an author, date and status", () => {
    for (const f of RULES) {
      const r = readJson(f);
      expect({ file: f, errors: validateRuleFile(r) }).toEqual({ file: f, errors: [] });
      expect(r.id).toBe(basename(f, ".json"));
      expect(r.author.length).toBeGreaterThan(0);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(RULE_STATUSES).toContain(r.status);
      expect(JSON.stringify(r)).not.toMatch(/"caps?"/i);
    }
    expect(readJson(join(PKG, "rules/R1.json")).status).toBe("reference");
  });

  test("every file in rules/ passes checkHoldings against the shipped universe with no findings", () => {
    const u = loadUniverse();
    for (const f of RULES) expect({ file: f, findings: checkHoldings(ruleHoldings(parseRuleFile(readJson(f))), u) }).toEqual({ file: f, findings: [] });
  });

  test("the prototype signal names are ported to the signal grammar", () => {
    const signals = RULES.flatMap((f) => (readJson(f).engine?.sleeves ?? []).map((s: { signal: string }) => s.signal));
    expect(signals).toContain("inverse(composite)");
    expect(signals).toContain("mean(indicator:DFII10,indicator:DXY,indicator:T5YIE)");
    expect(signals).toContain("mean(composite,research:channel_divergence,research:late_cycle)");
    expect(signals.some((s: string) => /counter_composite|real_rates_dollar/.test(s))).toBe(false);
  });

  test("files outside the universe validate in shape but have universe findings", () => {
    for (const f of OUTSIDE) {
      const r = readJson(f);
      expect({ file: f, errors: validateRuleFile(r, { allowOutsideUniverse: true }) }).toEqual({ file: f, errors: [] });
      expect(validateRuleFile(r).length).toBeGreaterThan(0);
    }
    expect(validateRuleFile(readJson(join(PKG, "rules-outside-universe/P-C.json")))).toContain(
      "states.neutral.BIL: neutral: BIL at 23% is not in the universe (cap: none, the asset is not eligible)");
    expect(validateRuleFile(readJson(join(PKG, "rules-outside-universe/E1w.json")))).toContain(
      "engine.sleeves[0].max: max: BTC at 20% is over its cap of 10%");
  });
});

describe("validateRuleFile names the field", () => {
  test("weights summing to 99, in a state and in an engine's neutral portfolio", () => {
    const r = clone(R1);
    r.states.neutral.BTC = 4;
    expect(validateRuleFile(r)).toEqual(["states.neutral: weights sum to 99, not 100"]);
    const e = clone(E1);
    e.engine.neutral.AAVE = 27;
    expect(validateRuleFile(e)).toEqual(["engine.neutral: weights sum to 99, not 100"]);
  });

  test("a band that excludes its neutral weight", () => {
    const e = clone(E1);
    e.engine.sleeves[0].min = 6;
    expect(validateRuleFile(e)).toEqual(["engine.sleeves[0]: band 6..10 does not contain the neutral weight 5 (engine.neutral.BTC)"]);
  });

  test("an unknown signal name, including the prototype's old names", () => {
    for (const bad of ["counter_composite", "real_rates_dollar", "indicator:NOPE", "mean(composite)"]) {
      const e = clone(E1);
      e.engine.sleeves[1].signal = bad;
      const errors = validateRuleFile(e);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toStartWith("engine.sleeves[1].signal: ");
      expect(errors[0]).toContain(JSON.stringify(bad));
    }
  });

  test("a caps field is refused: caps come from the universe", () => {
    const r = clone(R1);
    r.caps = { Bitcoin: 10 };
    expect(validateRuleFile(r)).toEqual(["caps: unknown field (caps come from the universe, not the rule file)"]);
  });

  test("states: a missing state, a fixed rule with more than neutral, a negative weight, an unknown label", () => {
    const missing = clone(R1); delete missing.states.risk_on;
    expect(validateRuleFile(missing)).toEqual(["states.risk_on: missing"]);
    const fixed = clone(R1); fixed.label = "fixed";
    expect(validateRuleFile(fixed)).toEqual(["states.risk_off: a fixed rule holds only neutral", "states.risk_on: a fixed rule holds only neutral"]);
    const neg = clone(R1); neg.states.risk_on.BTC = -1; neg.states.risk_on.AAVE = 28 + 10;
    expect(validateRuleFile(neg)).toContain("states.risk_on.BTC: weight -1 is negative");
    const label = clone(R1); label.label = "vibes";
    expect(validateRuleFile(label)[0]).toStartWith("label: ");
  });

  test("states or engine, never both or neither", () => {
    const both = { ...clone(R1), engine: E1.engine };
    expect(validateRuleFile(both)).toContain("states/engine: a rule file has states or engine, not both");
    const neither = clone(R1); delete neither.states; delete neither.label;
    expect(validateRuleFile(neither)).toContain("states/engine: a rule file needs states or engine");
  });

  test("engine: every holding has one role, the scale is positive, the dollar book is in the universe", () => {
    const stray = clone(E1); stray.engine.dollarBook.instruments = stray.engine.dollarBook.instruments.filter((h: string) => h !== "COMP");
    expect(validateRuleFile(stray)).toEqual(["engine.neutral.COMP: not a sleeve, the buffer or a dollar-book instrument"]);
    const twice = clone(E1); twice.engine.dollarBook.instruments.push("BTC");
    expect(validateRuleFile(twice)).toEqual(["engine.dollarBook.instruments[6]: BTC is already engine.sleeves[0].holding"]);
    const scale = clone(E1); scale.engine.sleeves[0].scale = 0;
    expect(validateRuleFile(scale)).toEqual(["engine.sleeves[0].scale: must be a number above 0"]);
    const outside = clone(E1); outside.engine.dollarBook.instruments.push("DOGE");
    expect(validateRuleFile(outside)).toEqual(["engine.dollarBook.instruments[6]: DOGE is not in the universe"]);
    expect(validateRuleFile(outside, { allowOutsideUniverse: true })).toEqual([]);
  });

  test("top-level fields: date, status, drift", () => {
    const r = clone(R1);
    r.date = "2026-02-30"; r.status = "ablation"; r.drift.byHolding = { DOGE: 3 }; delete r.author;
    expect(validateRuleFile(r)).toEqual([
      "author: missing",
      "date: must be a YYYY-MM-DD date",
      "status: must be one of reference, hypothesis, comparison",
      "drift.byHolding.DOGE: not a holding of this rule file",
    ]);
    expect(validateRuleFile([])).toEqual(["(root): a rule file must be a JSON object"]);
  });

  test("a holding over its universe cap names the state, the holding and the cap", () => {
    const r = clone(R1);
    r.states.risk_on.BTC = 12; r.states.risk_on.AAVE = 25;
    expect(validateRuleFile(r)).toEqual([
      "states.risk_on.BTC: risk_on: BTC at 12% is over its cap of 10%",
      "states.risk_on: risk_on: group Bitcoin (BTC, TBTC, LBTC, WBTC) at 12% is over its cap of 10%",
    ]);
  });

  test("a universe of your own is honoured", () => {
    const u = clone(shippedUniverse) as Record<string, any>;
    u.assets = u.assets.filter((a: { id: string }) => a.id !== "GOLD");
    u.groups = u.groups.filter((g: { id: string }) => g.id !== "gold");
    expect(validateRuleFile(R1, { universe: loadUniverse(u) })[0]).toStartWith("states.risk_off.GOLD: ");
  });

  test("parseRuleFile returns the typed file or throws RuleFileError with every error", () => {
    expect(parseRuleFile(R1).id).toBe("R1");
    const r = clone(R1); r.states.neutral.BTC = 4; r.status = "draft";
    try {
      parseRuleFile(r);
      throw new Error("parseRuleFile accepted a bad file");
    } catch (e) {
      expect(e).toBeInstanceOf(RuleFileError);
      expect((e as RuleFileError).errors).toHaveLength(2);
    }
  });
});

describe("the README example and rules:check", () => {
  test("the README section's JSON example validates with no errors", () => {
    const example = JSON.parse(readmeExample());
    expect(validateRuleFile(example)).toEqual([]);
    expect(checkHoldings(ruleHoldings(parseRuleFile(example)), loadUniverse())).toEqual([]);
  });

  test("the README example runs through `rules:check` with exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-test-"));
    const file = join(dir, "example.json");
    writeFileSync(file, readmeExample());
    const r = runCheck(file);
    expect(r.err).toContain("ok: example (hypothesis) is a valid rule file, inside the universe");
    expect(r.code).toBe(0);
  });

  test("rules:check exits 2 on an invalid file and on universe findings, 0 with --allow-outside-universe", () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-test-"));
    const bad = clone(R1); bad.states.neutral.BTC = 4;
    writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
    const invalid = runCheck(join(dir, "bad.json"));
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain("invalid: states.neutral: weights sum to 99, not 100");
    const outside = join(PKG, "rules-outside-universe/P-B.json");
    const refused = runCheck(outside);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("refused: states.neutral.SPY: ");
    const allowed = runCheck(outside, "--allow-outside-universe");
    expect(allowed.code).toBe(0);
    expect(allowed.err).toContain("warning (allowed by --allow-outside-universe): states.neutral.SPY: ");
    // --allow-outside-universe never lets a malformed file through.
    expect(runCheck(join(dir, "bad.json"), "--allow-outside-universe").code).toBe(2);
    expect(runCheck("--universe").code).toBe(2);
  });
});
