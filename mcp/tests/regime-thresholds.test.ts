// Issue #129 / maintainability finding 002: the memo builder's composite-derived
// regime fallback used its own diverged 0.45/0.55 thresholds. It now consumes
// the canonical shared classifier (@robotmoney/contract, canon =
// backend/src/analytics/analyze/regime.ts's 0.33/0.67 rule) and only hyphenates
// the vocabulary for prose ("risk_on" → "risk-on").
import { test, expect } from "bun:test";
import { classifyRegime } from "@robotmoney/contract";
import { buildMemo } from "../src/memo.ts";

// The memo interpolates the label verbatim into this deterministic sentence.
const labelSentence = (body: string) => body.match(/Trajectory reads (\S+) by label/)?.[1];

const memoFor = (composite: number, regime?: string) =>
  buildMemo(
    { name: "T", lens: "macro risk", subjectId: "woon", stance: "neutral", confidence: 0.6 },
    { composite, regime: regime ?? null },
  );

test("composite-derived fallback labels agree with the canonical classifier (0.60 → neutral)", () => {
  // The AC triple: 0.60 was "risk-on" under the old diverged 0.45/0.55 rule and
  // must now render the canonical "neutral"; 0.70/0.30 stay risk-on/risk-off.
  expect(labelSentence(memoFor(0.6))).toBe("neutral");
  expect(labelSentence(memoFor(0.7))).toBe("risk-on");
  expect(labelSentence(memoFor(0.3))).toBe("risk-off");

  // Cross-package agreement: hyphenated render of the shared classifier.
  for (const c of [0.6, 0.7, 0.3, 0.33, 0.67, 0.45, 0.55]) {
    expect(labelSentence(memoFor(c))).toBe(classifyRegime(c).replace(/_/g, "-"));
  }
});

test("a passed-in regime label still wins over the composite-derived fallback", () => {
  // Contrarian pairing on purpose: the stored/reported label must be echoed
  // (hyphenated), never reclassified from the composite.
  expect(labelSentence(memoFor(0.9, "risk_off"))).toBe("risk-off");
  expect(labelSentence(memoFor(0.1, "risk_on"))).toBe("risk-on");
});
