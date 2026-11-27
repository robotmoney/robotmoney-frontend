import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The robotmoney-regime-read skill (RM-220), moved here from research-workbench#13 with its tests. Served from
// frontend/public/skills/robotmoney-regime-read; these hold the script, its guide and its SKILL.md together.
import { describeSource, facts, formatValue, GUIDE, guideMarkdown, includedPanels, load, markdown, METHODOLOGIES, ordinal, withMethodology, type ApiResponse, type ApiRow } from "../../../frontend/public/skills/robotmoney-regime-read/scripts/regime-read.ts";
import { V5_INDICATORS, INDICATORS } from "../../../packages/analyst-sdk/src/analyze/indicators.ts";

// An experiment build response (the ranked 1/n mean): the latest row in full, the last 120 days of history trimmed to the panel fields.
const FIXTURE = join(import.meta.dir, "..", "fixtures", "regime-read", "experiment-sample.json");
const SKILL = join(import.meta.dir, "..", "..", "..", "frontend", "public", "skills", "robotmoney-regime-read");
const res = JSON.parse(readFileSync(FIXTURE, "utf8")) as ApiResponse;

describe("regime-read facts", () => {
  const x = facts(res, describeSource("build/regime-snapshots.range-4000.backtest.json"));
  test("the composite, model and included panels come from the response", () => {
    expect(x.asOf).toBe(res.latest.date);
    expect(x.model).toBe("experiment-ranked-mean");
    expect(x.experiment).toBe(true);
    expect(markdown(x)).toContain("**Experimental model experiment-ranked-mean: not deployed, not the regime.**");
    expect(x.composite).toBe(res.latest.composite!);
    expect(x.included).toEqual(["macro", "onchain", "factor"]);
    const L = res.latest;
    expect(x.panelMean).toBeCloseTo((L.macroIndex! + L.onchainIndex! + L.factorIndex!) / 3, 12);
  });
  test("every indicator in the response has a guide entry, and its level percentile is the unsigned one", () => {
    const ids = res.latest.indicators!.map((i) => i.id);
    expect(ids.filter((id) => !GUIDE[id])).toEqual([]);
    for (const i of res.latest.indicators!) {
      const f = x.indicators.find((y) => y.id === i.id)!;
      expect(f.rawPercentile).toBe(i.percentile);
      expect(f.modelPercentile).toBe(i.signed_percentile);
      // the sign links the two: a −1 indicator's model reading is 1 minus its level
      expect(i.sign > 0 ? f.modelPercentile : 1 - f.modelPercentile).toBeCloseTo(f.rawPercentile, 6);
    }
  });
  test("pull is weight x (model reading − 0.5) / n, and the lists are ordered by it", () => {
    for (const f of x.indicators) expect(f.pull).toBeCloseTo((f.weight * (f.modelPercentile - 0.5)) / 3, 12);
    const down = x.pullingDown.map((f) => f.pull);
    expect(down.every((p, k) => p < 0 && (k === 0 || down[k - 1]! <= p))).toBe(true);
    const up = x.holdingUp.map((f) => f.pull);
    expect(up.every((p, k) => p > 0 && (k === 0 || up[k - 1]! >= p))).toBe(true);
    expect(Math.min(...x.indicators.map((f) => f.pull))).toBe(down[0]!);
  });
  test("history facts use the panel average, and the markdown has no missing values", () => {
    expect(x.history!.days).toBe(res.history.length);
    expect(x.history!.mean30).not.toBeNull();
    expect(x.history!.mean90).not.toBeNull();
    expect(x.research.drivers.length).toBeGreaterThan(0);
    expect(x.research.window.to).toBe(x.asOf);
    for (const d of x.research.drivers) expect(GUIDE[d.id]).toBeDefined();
    const md = markdown(x);
    expect(md).not.toMatch(/NaN|undefined|n\/a/);
    expect(md).toContain(`model ${x.model}`);
  });
});

describe("regime-read on the deployed model", () => {
  const row = (composite: number): ApiRow => ({ date: "2026-11-16", composite, regime: "risk_off", version: "v3", macroIndex: 0.4, onchainIndex: 0.2, factorIndex: 0.9, panels: ["macro", "onchain", "factor"] });
  test("the included panels are the set whose mean is the composite, whatever the row lists", () => {
    expect(includedPanels(row(0.3))).toEqual(["macro", "onchain"]);
    expect(includedPanels(row(0.5))).toEqual(["macro", "onchain", "factor"]);
  });
  test("a v* name production does not serve, or any other name, is an error that points to the latest skill", () => {
    for (const version of ["v6", "experimental", "experiment-Bad"]) expect(() => includedPanels({ ...row(0.3), version })).toThrow(/neither a production methodology this skill knows .*robotmoney\.network\/skills\/robotmoney-regime-read/);
  });
  test("v4, the line production serves today, is the mean of the panels it lists, found by matching", () => {
    expect(includedPanels({ ...row(0.5), version: "v4" })).toEqual(["macro", "onchain", "factor"]);
    expect(() => includedPanels({ ...row(0.31), version: "v4" })).toThrow(/no set of panels averages to the composite/);
  });
  test("v5 ranks the mean, so it cannot be matched: it uses the panels its row lists, and says how it is built", () => {
    expect(METHODOLOGIES.v5).toBe("ranked-mean");
    expect(includedPanels({ ...row(0.1), version: "v5" })).toEqual(["macro", "onchain", "factor"]);
    const v5: ApiResponse = { ...res, latest: { ...res.latest, version: "v5" }, history: res.history.map((h) => ({ ...h, version: "v5" })) };
    const x = facts(v5, describeSource("https://robotmoney.network/api/dashboards/regime-snapshots?range=400&methodology=v5"));
    expect(x.included).toEqual(["macro", "onchain", "factor"]);
    expect(x.compositeRule).toContain("ranked against every day of the model's record since 2018");
    expect(x.compositeRule).toContain(`today's ${res.latest.composite!.toFixed(2)}`);
    expect(markdown(x)).toContain("methodology v5 as asked");
    expect(markdown(x)).toContain("may be published beside the regime the site shows");
  });
  test("an experiment uses the panels its row lists", () => {
    expect(includedPanels({ ...row(0.1), version: "experiment-x", panels: ["macro", "factor"] })).toEqual(["macro", "factor"]);
  });
  test("no set of panels averaging to the composite is an error, not a guess", () => {
    expect(() => includedPanels(row(0.31))).toThrow(/no set of panels averages to the composite/);
  });
});

describe("regime-read formatting and guide", () => {
  test("levels print in their own units", () => {
    const base = { id: "X", name: "X", panel: "macro", sign: 1, raw_value: 0, transformed_value: 0, percentile: 0.5, signed_percentile: 0.5, panel_weight: 0.1 };
    expect(formatValue({ ...base, unit: "percent", transform: "level", raw_value: 2.912 })).toBe("2.91%");
    expect(formatValue({ ...base, unit: "usd", transform: "level", raw_value: 71119777858 })).toBe("$71.1B");
    expect(formatValue({ ...base, unit: "count", transform: "level", raw_value: 200000 })).toBe("200,000");
    expect(formatValue({ ...base, unit: "percent_change", transform: "change90", transformed_value: -0.0325 })).toBe("−3.3% over 90 days");
    expect(formatValue({ ...base, unit: "index", transform: "trend_50_200", transformed_value: 1.0114 })).toBe("1.011");
    expect([0.01, 0.02, 0.03, 0.11, 0.12, 0.22, 0.93].map(ordinal)).toEqual(["1st", "2nd", "3rd", "11th", "12th", "22nd", "93rd"]);
  });
  test("references/indicators.md is the script's own guide", () => {
    expect(readFileSync(join(SKILL, "references", "indicators.md"), "utf8")).toBe(guideMarkdown());
  });
  test("SKILL.md has the frontmatter the skill validator allows", () => {
    const md = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const front = md.match(/^---\n([\s\S]*?)\n---\n/)![1]!;
    const keys = front.split("\n").filter((l) => /^\S[^:]*:/.test(l)).map((l) => l.split(":")[0]);
    expect(keys).toContain("name");
    expect(keys).toContain("description");
    expect(keys.filter((k) => !["name", "description", "license", "allowed-tools", "metadata", "compatibility"].includes(k!))).toEqual([]);
    expect(front).toContain("name: robotmoney-regime-read");
    // Public: nothing in the skill marks it internal or points at a private repository.
    for (const file of ["SKILL.md", "references/indicators.md", "references/example-read.md", "scripts/regime-read.ts"]) {
      expect(readFileSync(join(SKILL, file), "utf8")).not.toMatch(/research-workbench|Proprietary|internal\./i);
    }
  });
});

describe("regime-read source and staleness", () => {
  test("only an https robotmoney.network URL is the live production regime", () => {
    expect(describeSource("https://robotmoney.network/api/dashboards/regime-snapshots?range=400").live).toBe(true);
    expect(describeSource("http://robotmoney.network/api/dashboards/regime-snapshots?range=400").live).toBe(false);
    expect(describeSource("https://robotmoney.network.example.com/x").live).toBe(false);
    expect(describeSource("http://localhost:8080/api/dashboards/regime-snapshots?range=400").live).toBe(false);
    expect(describeSource("build/regime-snapshots.range-4000.backtest.json").live).toBe(false);
  });
  test("the fact sheet names the source, and warns when it is not production or has no staleness check", () => {
    const local = markdown(facts({ ...res, staleness: null }, describeSource("out.json")));
    expect(local).toContain("Source: out.json. **Not the live production regime:**");
    expect(local).toContain("**The response has no staleness check.**");
    const live = markdown(facts({ ...res, staleness: { stale: false } }, describeSource("https://robotmoney.network/api/dashboards/regime-snapshots?range=400")));
    expect(live).toContain("This is the published regime.");
    expect(live).not.toContain("Not the live production regime");
    expect(live).not.toContain("no staleness check");
  });
});

describe("regime-read against the platform", () => {
  test("the guide explains every indicator the production methodologies read, v5's four included", () => {
    const ids = [...new Set([...INDICATORS, ...V5_INDICATORS].map((i) => i.id))];
    expect(ids.filter((id) => !GUIDE[id])).toEqual([]);
    for (const id of ["FISCAL", "VIX_TERM", "SKEW", "UPVOL_SHARE"]) expect(GUIDE[id]).toBeDefined();
  });
  test("a share prints as a percentage", () => {
    const base = { id: "UPVOL_SHARE", name: "S&P 500 up-volume share", panel: "factor", sign: 1, raw_value: 0.5512, transformed_value: 0.5512, percentile: 0.5, signed_percentile: 0.5, panel_weight: 0.1 };
    expect(formatValue({ ...base, unit: "share", transform: "level" })).toBe("55%");
  });
  test("--methodology asks the live API for that line", () => {
    expect(withMethodology("https://robotmoney.network/api/dashboards/regime-snapshots?range=400", "v5")).toBe("https://robotmoney.network/api/dashboards/regime-snapshots?range=400&methodology=v5");
    expect(describeSource("https://robotmoney.network/api/dashboards/regime-snapshots?range=400&methodology=v5").methodology).toBe("v5");
    expect(describeSource("https://robotmoney.network/api/dashboards/regime-snapshots?range=400").methodology).toBeNull();
  });
  test("an API that ignores the methodology asked for, or refuses it, is an error, never read as that line", async () => {
    const answers: Record<string, unknown> = {
      "/ignores": { latest: { ...res.latest, version: "v4" }, history: [] },
      "/serves": { ...res, methodology: "v5" },
      "/refuses": { error: "methodology must be one of v3, v4, v5", allowed: ["v3", "v4", "v5"] },
    };
    const server = Bun.serve({ port: 0, fetch: (req) => Response.json(answers[new URL(req.url).pathname] ?? {}) });
    try {
      const at = (path: string) => `http://127.0.0.1:${server.port}${path}?range=400&methodology=v5`;
      await expect(load(at("/ignores"))).rejects.toThrow(/did not serve it/);
      await expect(load(at("/refuses"))).rejects.toThrow(/refused the request/);
      expect((await load(at("/serves"))).latest.date).toBe(res.latest.date);
    } finally {
      server.stop(true);
    }
  });
});
