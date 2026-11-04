import { describe, expect, test } from "bun:test";
import { REGIME_BANDS_MARKER, REGIME_BANDS_PATH, regimeBandProblems } from "../../release/version-checks/v0.7.2/regime-bands.ts";

describe("v0.7.2 regime-bands check (PR 1560)", () => {
  test("a served shared module that carries the risk-off wash passes", () => {
    const body = `export const REGIME_BAND_BG = {};\n  ${REGIME_BANDS_MARKER}, hatch: null },\n`;
    expect(regimeBandProblems(200, body)).toEqual([]);
  });

  test("a v0.7.1 module without the wash fails and names PR 1560", () => {
    const problems = regimeBandProblems(200, "export const REGIME_BAND_BG = {};\n");
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("PR 1560");
    expect(problems[0]).toContain(REGIME_BANDS_PATH);
  });

  test("a non-200 answer fails, so the SPA shell cannot pass for the module", () => {
    expect(regimeBandProblems(404, REGIME_BANDS_MARKER)).toEqual([`GET ${REGIME_BANDS_PATH} answered 404, not 200`]);
  });
});

import { SWARM_POST_MARKER, SWARM_POST_PATH, swarmPostProblems } from "../../release/version-checks/v0.7.2/swarm-post.ts";

describe("v0.7.2 swarm-post check (PR 1558)", () => {
  test("the served post with its headline passes", () => {
    expect(swarmPostProblems(200, `<h1>${SWARM_POST_MARKER}, ShodAI</h1>`)).toEqual([]);
  });
  test("red: a 404, or a page without the headline, fails", () => {
    expect(swarmPostProblems(404, "")).toEqual([`GET ${SWARM_POST_PATH} answered 404, not 200`]);
    expect(swarmPostProblems(200, "<html>shell</html>")[0]).toContain("PR 1558");
  });
});
