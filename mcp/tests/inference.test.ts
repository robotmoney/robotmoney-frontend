import { test, expect, afterEach } from "bun:test";
import {
  parseStanceFromBody,
  authorTake,
  type RegimeContext,
} from "../src/inference.ts";

// ── parseStanceFromBody: control line extracted + stripped ──────────────────
test("parseStanceFromBody extracts stance+confidence and strips the control line", () => {
  const body = [
    "**REGIME**",
    "- Composite 0.544 at the 56th percentile reads risk-on.",
    "",
    "**ALLOCATION**",
    "- Targets stay 95/5/0/0.",
    "",
    "**SUBJECT**",
    "- Woon carries most of its book on a single stream.",
    "STANCE: cautious | CONFIDENCE: 0.72",
  ].join("\n");

  const parsed = parseStanceFromBody(body);
  expect(parsed.stance).toBe("cautious");
  expect(parsed.confidence).toBe(0.72);
  // The STANCE/CONFIDENCE control line must NOT survive into the stored body.
  expect(parsed.body).not.toContain("STANCE:");
  expect(parsed.body).not.toContain("CONFIDENCE:");
  // But the authored sections must remain intact.
  expect(parsed.body).toContain("**REGIME**");
  expect(parsed.body).toContain("**SUBJECT**");
});

test("parseStanceFromBody clamps confidence into [0,1] and lowercases stance", () => {
  const parsed = parseStanceFromBody("**REGIME**\n- x\nSTANCE: Bullish | CONFIDENCE: 1.4");
  expect(parsed.stance).toBe("bullish");
  expect(parsed.confidence).toBe(1);
});

test("parseStanceFromBody degrades to neutral/0.5 when no control line is present", () => {
  const body = "**REGIME**\n- Just prose, no control line.";
  const parsed = parseStanceFromBody(body);
  expect(parsed.stance).toBe("neutral");
  expect(parsed.confidence).toBe(0.5);
  expect(parsed.body).toBe(body);
});

// ── loud-skip contract: authorTake throws when ANTHROPIC_API_KEY is absent ──
// This proves the inference wrapper NEVER returns a templated fallback when the
// external resource (the API key) is missing — it fails loudly instead.
const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

test("authorTake throws (no fallback) when ANTHROPIC_API_KEY is unset", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const regime: RegimeContext = { composite: 0.544, compositePercentile: 0.56, regime: "risk_on" };
  await expect(
    authorTake({ memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1 }, regime, "woon"),
  ).rejects.toThrow(/ANTHROPIC_API_KEY/);
});
