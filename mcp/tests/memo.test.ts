import { test, expect } from "bun:test";
import { buildMemo, lensKey, type RegimeContext } from "../src/memo.ts";

const regime: RegimeContext = {
  composite: 0.544,
  compositePercentile: 0.56,
  regime: "risk_on",
  macroRegime: "risk_on",
  onchainRegime: "risk_off",
  factorRegime: "risk_on",
  macroPercentile: 0.74,
  onchainPercentile: 0.1,
  factorPercentile: 0.92,
};

test("buildMemo produces a reference-shaped 3-section memo", () => {
  const body = buildMemo({ name: "Athena", lens: "macro risk", subjectId: "woon", stance: "cautious", confidence: 0.72 }, regime);
  expect(body).toContain("**REGIME**");
  expect(body).toContain("**ALLOCATION**");
  expect(body).toContain("**SUBJECT**");
  expect(body).toContain("- "); // bullets
  expect(body).toContain("95/5/0/0"); // allocation mandate
  expect(body.length).toBeGreaterThanOrEqual(900);
  expect(body.length).toBeLessThanOrEqual(1400);
});

test("buildMemo weaves in panel percentiles when present", () => {
  const body = buildMemo({ name: "Boreas", lens: "on-chain flows", subjectId: "woon", stance: "neutral", confidence: 0.6 }, regime);
  expect(body).toContain("10th"); // on-chain percentile
  expect(body).toContain("74th"); // macro percentile
  expect(body).toContain("0.544"); // composite
});

test("buildMemo varies wording by lens (members read distinctly)", () => {
  const macro = buildMemo({ name: "A", lens: "macro risk", subjectId: "woon", stance: "cautious", confidence: 0.7 }, regime);
  const onchain = buildMemo({ name: "B", lens: "on-chain flows", subjectId: "woon", stance: "cautious", confidence: 0.7 }, regime);
  const momentum = buildMemo({ name: "C", lens: "momentum", subjectId: "woon", stance: "cautious", confidence: 0.7 }, regime);
  expect(macro).not.toBe(onchain);
  expect(onchain).not.toBe(momentum);
  expect(lensKey("macro risk")).toBe("macro");
  expect(lensKey("on-chain flows")).toBe("onchain");
  expect(lensKey("some unknown lens")).toBe("default");
});

test("buildMemo degrades gracefully when panels are absent", () => {
  const body = buildMemo({ name: "D", lens: "contrarian", subjectId: "mav", stance: "bullish", confidence: 0.8 }, { composite: 0.6 });
  expect(body).toContain("**REGIME**");
  expect(body).toContain("**ALLOCATION**");
  expect(body).toContain("**SUBJECT**");
  expect(body).toContain("95/5/0/0");
});
