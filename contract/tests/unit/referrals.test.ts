// The shared referral-code normalizer (issue 1371, docs/technical/referrals-spec.md
// §3 and the §9 row "` RM_ALICE ` versus `rm_a lice`"). Offline: pure functions
// over the shared fixture file the backend and skill tests also read.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REFERRAL_CODE_MAX_LENGTH,
  ROUTES,
  isNormalizedReferralCode,
  normalizeReferralCode,
} from "../../src/index.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "../../src/__fixtures__/referral-codes.json"), "utf8")) as {
  cases: { input: string; normalized: string | null; carrierValid: boolean }[];
};

describe("normalizeReferralCode", () => {
  for (const c of fixture.cases) {
    test(`${JSON.stringify(c.input)} -> ${JSON.stringify(c.normalized)}`, () => {
      expect(normalizeReferralCode(c.input)).toBe(c.normalized);
      expect(isNormalizedReferralCode(c.input)).toBe(c.carrierValid);
    });
  }

  test("the spec's own pair: the first normalizes, the second fails unchanged", () => {
    expect(normalizeReferralCode(" RM_ALICE ")).toBe("rm_alice");
    expect(normalizeReferralCode("rm_a lice")).toBeNull();
  });

  test("a normalized code is a fixed point, and a non-string is never a code", () => {
    for (const c of fixture.cases) {
      if (c.normalized !== null) expect(normalizeReferralCode(c.normalized)).toBe(c.normalized);
    }
    for (const v of [null, undefined, 1, {}, ["rm_alice"]]) expect(normalizeReferralCode(v)).toBeNull();
  });

  test("the length cap counts `rm_` and is 32", () => {
    expect(REFERRAL_CODE_MAX_LENGTH).toBe(32);
    expect(normalizeReferralCode("rm_" + "a".repeat(29))).toBe("rm_" + "a".repeat(29));
    expect(normalizeReferralCode("rm_" + "a".repeat(30))).toBeNull();
  });

  test("the lookup route is one code per request, with no list route", () => {
    expect(ROUTES.referrals).toEqual({ code: "/api/referrals/codes/:code" });
  });
});
