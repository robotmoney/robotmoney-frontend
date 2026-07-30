import { describe, expect, test } from "bun:test";
import { assertAuthoredTakes } from "../../lib/committee/session.ts";
import { promptFor } from "../../lib/committee/inference.ts";

const take = (memberId: string, body: string) => ({
  memberId,
  body,
  stance: "neutral",
  confidence: 0.5,
});

const body = (detail: string) => [
  "**REGIME**", `- ${detail} regime`,
  "**ALLOCATION**", `- ${detail} allocation`,
  "**SUBJECT**", `- ${detail} subject`,
].join("\n");

describe("assertAuthoredTakes — every present member requires live prose", () => {
  test("accepts distinct structured takes for every present member", () => {
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
      take("boreas", body("Boreas")),
    ], ["athena", "boreas"])).not.toThrow();
  });

  test("fails loudly when a present member did not author a take", () => {
    expect(() => assertAuthoredTakes("session", [
      take("athena", body("Athena")),
    ], ["athena", "boreas"])).toThrow("present member boreas has no live-authored take");
  });

  test("rejects the retired deterministic template fingerprint", () => {
    expect(() => assertAuthoredTakes("session", [
      take("athena", `${body("Athena")}\n- the spread, not the composite, is where the signal lives`),
    ], ["athena"])).toThrow("retired template fingerprint");
  });
});

describe("promptFor — builds well-formed prompt", () => {
  test("generates expected persona prompt structure", () => {
    const prompt = promptFor(
      { memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1 },
      { composite: 0.5 },
      "woon",
    );
    expect(prompt).toContain("You are Athena");
    expect(prompt).toContain("macro risk lens");
    expect(prompt).toContain("Subject under review: woon");
    expect(prompt).toContain("**REGIME**");
    expect(prompt).toContain("**ALLOCATION**");
    expect(prompt).toContain("**SUBJECT**");
    expect(prompt).toContain("STANCE:");
  });
});


