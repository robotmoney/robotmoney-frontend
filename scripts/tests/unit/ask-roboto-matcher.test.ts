// Unit coverage for matchAgents() — the deterministic, non-LLM rule-based
// matcher behind /ask-mr-roboto (issue #394,
// docs/bot-analytics-ui-port-plan.md §5.18 & §9 D4/D5, P5.1). This is the
// entire "AI recommendation" surface: no network call, no randomness, no
// LLM, so bun:test can import the production module directly and assert on
// exact match sets/ordering — same "import a pure helper straight out of an
// alpine/ module" pattern frontend-routes.test.ts already uses for
// alpine/static-views.js's camelSubject/takeHref/etc, and the same "pure
// function, zero DOM dependency" design sparkline.test.ts exercises for
// alpine/lib/sparkline.js.
import { describe, expect, test } from "bun:test";
import { matchAgents } from "../../../frontend/public/assets/js/app/alpine/views/dash-ask-roboto.js";

const AGENTS = [
  { id: "a1", name: "Alpha Trader", protocol: "x402", isFacilitator: false, active: true, score: 90, x402Txns: 40, x402VolumeUsd: 5000, balanceUsd: 8000 },
  { id: "a2", name: "Beta Bot", protocol: "olas", isFacilitator: false, active: false, score: 40, x402Txns: 2, x402VolumeUsd: 100, balanceUsd: 500 },
  { id: "f1", name: "Gamma Facilitator", protocol: "facilitator", isFacilitator: true, active: true, score: 60, x402Txns: 10, x402VolumeUsd: 900, balanceUsd: 1200 },
];

describe("matchAgents — protocol + status filters", () => {
  test("filters by protocol AND active status, explains both filters, sorts by default score", () => {
    const { matches, filters, sortLabel, usedFallback } = matchAgents("Find an active x402 agent", AGENTS);
    expect(matches.map((a) => a.id)).toEqual(["a1"]);
    expect(filters).toEqual(["protocol: x402", "active only"]);
    expect(sortLabel).toBe("composite score");
    expect(usedFallback).toBe(false);
  });

  test("'facilitator(s)' token takes priority over any protocol keyword and filters on isFacilitator", () => {
    const { matches, filters } = matchAgents("show me facilitators", AGENTS);
    expect(matches.map((a) => a.id)).toEqual(["f1"]);
    expect(filters).toEqual(["facilitators only"]);
  });

  test("idle/inactive token filters to active === false", () => {
    const { matches, filters } = matchAgents("idle olas agent", AGENTS);
    expect(matches.map((a) => a.id)).toEqual(["a2"]);
    expect(filters).toEqual(["protocol: olas", "idle only"]);
  });

  test("a protocol with zero matching rows falls back to the full roster, sorted by score, and says so", () => {
    const { matches, filters, usedFallback } = matchAgents("acp agent please", AGENTS);
    expect(usedFallback).toBe(true);
    expect(matches.map((a) => a.id)).toEqual(["a1", "f1", "a2"]); // score 90, 60, 40
    // The acp filter was attempted but produced nothing — it must not appear
    // as though it silently succeeded.
    expect(filters).toContain("protocol: acp");
  });
});

describe("matchAgents — sort-rule keywords", () => {
  test("'highest volume agent' sorts by x402VolumeUsd desc with no filters applied", () => {
    const { matches, filters, sortLabel } = matchAgents("highest volume agent", AGENTS);
    expect(filters).toEqual([]);
    expect(sortLabel).toBe("x402 volume");
    expect(matches.map((a) => a.id)).toEqual(["a1", "f1", "a2"]); // 5000, 900, 100
  });

  test("'richest' sorts by balanceUsd desc", () => {
    const { matches, sortLabel } = matchAgents("who is the richest", AGENTS);
    expect(sortLabel).toBe("wallet balance");
    expect(matches.map((a) => a.id)).toEqual(["a1", "f1", "a2"]); // 8000, 1200, 500
  });

  test("'transactions' sorts by x402Txns desc", () => {
    const { matches, sortLabel } = matchAgents("most transactions", AGENTS);
    expect(sortLabel).toBe("x402 transactions");
    expect(matches.map((a) => a.id)).toEqual(["a1", "f1", "a2"]); // 40, 10, 2
  });
});

describe("matchAgents — name search", () => {
  test("a query naming an agent directly narrows to that agent, ignoring filler stopwords", () => {
    const { matches, filters } = matchAgents("Tell me about Alpha", AGENTS);
    expect(matches.map((a) => a.id)).toEqual(["a1"]);
    expect(filters).toEqual(['name contains "alpha"']);
  });

  test("generic filler words never trigger a spurious name match (the 'agent'-in-every-name trap)", () => {
    // No protocol/status/sort keyword, and "find"/"me"/"an"/"agent" are all
    // stopwords — this must fall through to the full-roster default sort,
    // not narrow to nothing (every name contains neither "find" nor "me").
    const { matches, filters, usedFallback } = matchAgents("find me an agent", AGENTS);
    expect(filters).toEqual([]);
    expect(usedFallback).toBe(false);
    expect(matches.map((a) => a.id)).toEqual(["a1", "f1", "a2"]); // default score sort
  });
});

describe("matchAgents — defaults, ties, and edge cases", () => {
  test("empty/no-keyword query returns the full roster sorted by composite score desc", () => {
    const { matches, filters, sortLabel, usedFallback } = matchAgents("who should I use", AGENTS);
    expect(filters).toEqual([]);
    expect(sortLabel).toBe("composite score");
    expect(usedFallback).toBe(false);
    expect(matches.map((a) => a.id)).toEqual(["a1", "f1", "a2"]);
  });

  test("caps at 3 matches even when the roster is larger", () => {
    const many = [
      ...AGENTS,
      { id: "a4", name: "Delta", protocol: "x402", isFacilitator: false, active: true, score: 20, x402Txns: 1, x402VolumeUsd: 1, balanceUsd: 1 },
    ];
    const { matches } = matchAgents("", many);
    expect(matches).toHaveLength(3);
  });

  test("a tie in the sort key breaks alphabetically by name, deterministically", () => {
    const tied = [
      { id: "z1", name: "Zulu", protocol: "x402", isFacilitator: false, active: true, score: 50, x402Txns: 1, x402VolumeUsd: 1, balanceUsd: 1 },
      { id: "b1", name: "Bravo", protocol: "x402", isFacilitator: false, active: true, score: 50, x402Txns: 1, x402VolumeUsd: 1, balanceUsd: 1 },
    ];
    const { matches } = matchAgents("top agent", tied);
    expect(matches.map((a) => a.id)).toEqual(["b1", "z1"]);
  });

  test("an empty agent list never throws and returns no matches, no fallback", () => {
    const { matches, usedFallback } = matchAgents("anything", []);
    expect(matches).toEqual([]);
    expect(usedFallback).toBe(false);
  });

  test("a null/undefined balanceUsd sorts behind every finite value, never NaN/throws", () => {
    const withNull = [
      { id: "n1", name: "NullBalance", protocol: "x402", isFacilitator: false, active: true, score: 10, x402Txns: 1, x402VolumeUsd: 1, balanceUsd: null },
      { id: "n2", name: "RealBalance", protocol: "x402", isFacilitator: false, active: true, score: 10, x402Txns: 1, x402VolumeUsd: 1, balanceUsd: 5 },
    ];
    const { matches } = matchAgents("richest", withNull);
    expect(matches.map((a) => a.id)).toEqual(["n2", "n1"]);
  });
});
