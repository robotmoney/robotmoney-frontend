// Issue 1660 (D86): an external judge computes `inputsDigest` from the recipe
// in the swarm-onboarding skill. Under `derivation-v2` that recipe digests
// `regimeSummary.composite`, so the `jq` command it prints must give the
// digest the server computes, or every external judge is refused 409.
//
// The recipe is RUN, not grepped: the skill's bash block is executed over a
// judge input shaped as the API serves it, and compared with
// `inputsDigest(input, "derivation-v2")` from backend/src/swarm/judge.ts.
// jq and shasum are on the ubuntu-latest runner unit.yml uses; a missing one
// fails the test loudly.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inputsDigest, type JudgeInput } from "../../../backend/src/swarm/judge.ts";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const SKILL = read("frontend/public/skills/swarm-onboarding/SKILL.md");
const PARTICIPATION = read("frontend/public/views/docs/investment-swarm/participation.html");
const DECISIONS = read("docs/decisions.md");

// A judge input as served: the stored regime_summary whole (history and all),
// a brief object, member weights, and stance counts in jsonb's own key order.
const SERVED: JudgeInput = JSON.parse(JSON.stringify({
  sessionId: "1dacd25a-ed31-475a-a7a3-2ec686056290",
  date: "2026-11-16",
  subjectId: "treasury",
  subjectLabel: "Treasury",
  brief: { regime: { composite: 0.3767, regime: "risk_off" }, note: "a brief" },
  takes: [
    {
      member_id: "m_a", member_name: "Alpha", revision: 2, stance: "cautious", confidence: 0.7,
      body: "risk is rising; \"quotes\" and unicode é stay exact",
      weights: [{ bucket: "hard_assets", weight: 40 }, { bucket: "real_world_assets", weight: 60 }],
    },
    { member_id: "m_b", member_name: null, revision: 1, stance: "neutral", confidence: null, body: "hold", weights: null },
  ],
  minTakes: 3,
  byStance: { neutral: 1, cautious: 5 },
  meanConfidence: 0.6,
  regimeSummary: {
    composite: 0.3767,
    composite_percentile: null,
    regime: "risk_off",
    macro_percentile: 0.41,
    history: [{ date: "2026-11-15", composite: 0.39, composite_percentile: null, regime: "risk_off" }],
    method: "v4",
  },
}));

/** The bash block that follows "With the item's `input` saved to `./input.json`". */
function skillRecipe(): string {
  const at = SKILL.indexOf("With the item's `input` saved to `./input.json`");
  expect(at, "the skill no longer introduces the digest recipe").toBeGreaterThan(-1);
  const block = /```bash\n([\s\S]*?)```/.exec(SKILL.slice(at));
  expect(block, "no bash block follows the digest recipe").not.toBeNull();
  return block![1]!;
}

function runRecipe(input: unknown): string {
  // The recipe reads ./input.json; it is fed the same bytes on stdin instead,
  // so the jq program and the hash pipeline run exactly as printed.
  const recipe = skillRecipe();
  expect(recipe).toContain(" ./input.json");
  const proc = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", recipe.replace(" ./input.json", "")], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode, `recipe failed: ${proc.stderr.toString()}`).toBe(0);
  return proc.stdout.toString().trim();
}

describe("the judge digest recipe (derivation-v2)", () => {
  test("the skill's jq recipe gives the digest the server computes under derivation-v2", () => {
    const digest = runRecipe(SERVED);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(inputsDigest(SERVED, "derivation-v2"));
    expect(digest).not.toBe(inputsDigest(SERVED, "derivation-v1"));
  });

  test("it agrees when the session has no brief and no regime summary", () => {
    const bare = { ...SERVED, brief: null, regimeSummary: null };
    expect(runRecipe(bare)).toBe(inputsDigest(bare, "derivation-v2"));
  });

  test("the skill and participation.html name regimeSummary.composite, not its percentile", () => {
    expect(SKILL).toContain("`input.regimeSummary.composite`, or `null`");
    expect(SKILL).not.toContain("regimeSummary.composite_percentile");
    expect(PARTICIPATION).toContain("regimeComposite: i.regimeSummary?.composite ?? null");
    expect(PARTICIPATION).not.toContain("regimeSummary?.composite_percentile");
  });

  test("docs/decisions.md records derivation-v2 and regimeSummary.composite", () => {
    const heading = /^## D\d+ — Digest scheme `derivation-v2`[^\n]*$/m.exec(DECISIONS);
    expect(heading, "no decisions entry for derivation-v2").not.toBeNull();
    const entry = DECISIONS.slice(heading!.index, DECISIONS.indexOf("\n## ", heading!.index + 1) >>> 0);
    expect(entry).toContain("derivation-v2");
    expect(entry).toContain("regimeSummary.composite");
  });
});
