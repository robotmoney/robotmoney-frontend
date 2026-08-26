// The test scripts/lib/swarm/session.ts:30 has always CITED but which never
// existed. Found by the citation gate added alongside the D23 cost-class split
// (scripts/tests/unit/test-path-citations.test.ts): the comment promised this
// file was "unit-testable hermetically" and named it, yet nothing was ever
// written, so the polarity it documents — the one thing standing between the
// smoke driver and a mislabelled security posture — had zero executed
// assertions.
//
// What is being pinned: regimeWriteInsecure() must MIRROR the backend's
// regime-write gate, which is backend/src/api/auth.ts:41-43's isAnalyticsWriter:
//
//   cfg.analyticsToken ? secretEq(bearer, analyticsToken) : cfg.allowInsecure
//
// i.e. the gate opens for an unauthenticated writer only when insecure mode is
// explicitly opted INTO *and* no analytics credential is configured. Hence
// `RM_ALLOW_INSECURE === "1" && !ANALYTICS_TOKEN`. SECURE BY DEFAULT: unset means
// enforced, so a drift toward opt-OUT polarity (the classic inversion bug) is
// caught here rather than in a smoke log line that quietly lies about the posture.
//
// Pure: an injected env record, no process.env mutation, no network, no Docker.
import { describe, expect, test } from "bun:test";
import { regimeWriteInsecure } from "../../lib/swarm/session.ts";

describe("regimeWriteInsecure — opt-IN polarity, mirroring backend isAnalyticsWriter", () => {
  test("SECURE BY DEFAULT: an empty environment reports ENFORCED, not insecure", () => {
    expect(regimeWriteInsecure({})).toBe(false);
  });

  test("insecure ONLY on the explicit opt-in RM_ALLOW_INSECURE=1", () => {
    expect(regimeWriteInsecure({ RM_ALLOW_INSECURE: "1" })).toBe(true);
  });

  test("a configured ANALYTICS_TOKEN closes the gate even with the opt-in set", () => {
    // Mirrors auth.ts: with a token configured, the writer must authenticate —
    // allowInsecure is not consulted at all.
    expect(regimeWriteInsecure({ RM_ALLOW_INSECURE: "1", ANALYTICS_TOKEN: "t" })).toBe(false);
  });

  test("ANALYTICS_TOKEN alone is still enforced", () => {
    expect(regimeWriteInsecure({ ANALYTICS_TOKEN: "t" })).toBe(false);
  });

  // Near-miss values are the whole reason this is `=== "1"` and not truthiness:
  // an opt-in that accepts "true"/"0"/"" is an opt-in that fires by accident.
  for (const value of ["0", "true", "yes", "", "01", " 1"]) {
    test(`RM_ALLOW_INSECURE=${JSON.stringify(value)} does NOT open the gate — only the exact "1" does`, () => {
      expect(regimeWriteInsecure({ RM_ALLOW_INSECURE: value })).toBe(false);
    });
  }

  test("an empty ANALYTICS_TOKEN is not a configured credential — it must not mask the opt-in", () => {
    // `!""` is true, so the gate stays open; asserted so the falsy-vs-absent
    // distinction is a decision on the record rather than an accident.
    expect(regimeWriteInsecure({ RM_ALLOW_INSECURE: "1", ANALYTICS_TOKEN: "" })).toBe(true);
  });
});
