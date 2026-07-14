// Hermetic unit tests for src/e2e.ts regimeWriteInsecure (review finding 031).
// RM_ALLOW_INSECURE used to have OPPOSITE default polarity in its two readers:
// backend config.ts is opt-IN insecure (insecure only on explicit ==="1"),
// while this e2e driver was opt-OUT (insecure unless ==="0") — a fail-open
// idiom waiting to be copied into new code. The resolver now mirrors the
// backend contract: SECURE BY DEFAULT, insecure only on an explicit
// RM_ALLOW_INSECURE === "1" and never when ANALYTICS_TOKEN is set. Importing
// src/e2e.ts is safe: main() is entry-point guarded (no backend needed).
import { describe, expect, test } from "bun:test";
import { regimeWriteInsecure } from "../src/e2e.ts";

describe("regimeWriteInsecure — opt-IN insecure, mirroring backend config.ts allowInsecure", () => {
  test("secure by default: an empty env is NOT insecure", () => {
    expect(regimeWriteInsecure({})).toBe(false);
  });

  test('the old opt-out values no longer open the gate (unset / "0" / any non-"1")', () => {
    // Under the previous `!== "0"` polarity every one of these resolved
    // insecure=true — the exact fail-open default the flip removes.
    expect(regimeWriteInsecure({ RM_ALLOW_INSECURE: "0" })).toBe(false);
    expect(regimeWriteInsecure({ RM_ALLOW_INSECURE: "" })).toBe(false);
    expect(regimeWriteInsecure({ RM_ALLOW_INSECURE: "true" })).toBe(false);
    expect(regimeWriteInsecure({ RM_ALLOW_INSECURE: "yes" })).toBe(false);
  });

  test('insecure ONLY on the explicit opt-in RM_ALLOW_INSECURE === "1" with no ANALYTICS_TOKEN', () => {
    expect(regimeWriteInsecure({ RM_ALLOW_INSECURE: "1" })).toBe(true);
  });

  test("a configured ANALYTICS_TOKEN closes the gate even with the opt-in set", () => {
    expect(
      regimeWriteInsecure({ RM_ALLOW_INSECURE: "1", ANALYTICS_TOKEN: "tok_analytics" }),
    ).toBe(false);
    expect(regimeWriteInsecure({ ANALYTICS_TOKEN: "tok_analytics" })).toBe(false);
  });
});
