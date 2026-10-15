// The referral codes config (Linear RM-174): the live lists in
// backend/src/config.ts, and the validator that guards them.
//
// WHAT THIS FILE PROTECTS. Codes and manual credits change only by PR, so CI is
// the one place a malformed entry can be caught before it reaches the deposit
// skill or the credit report. The first test runs the validator over the lists
// that ship; the rest pin each rule the validator enforces, so a later edit to
// it cannot quietly stop checking one.
import { test, expect, describe } from "bun:test";
import { REFERRAL_CODES, REFERRAL_MANUAL_CREDITS } from "../src/config.ts";
import {
  findReferralCode,
  referralCodeState,
  validateReferralConfig,
  type ReferralCodeEntry,
  type ReferralManualCredit,
} from "../src/referrals/codes.ts";

const member = (overrides: Partial<ReferralCodeEntry> = {}): ReferralCodeEntry => ({
  code: "rm_acme",
  memberId: "8f3c1e0a-0000-4000-8000-000000000001",
  channel: null,
  termsVersion: "2026-10",
  enabledAt: "2026-10-20T00:00:00Z",
  disabledAt: null,
  ...overrides,
});

const credit = (overrides: Partial<ReferralManualCredit> = {}): ReferralManualCredit => ({
  wallet: "0x" + "ab".repeat(20),
  code: "rm_acme",
  txHash: "0x" + "cd".repeat(32),
  message: "I was referred to Robot Money by rm_acme",
  signature: "0x" + "ef".repeat(65),
  addedAt: "2026-11-01T00:00:00Z",
  ...overrides,
});

test("the shipped referral config is valid", () => {
  expect(validateReferralConfig(REFERRAL_CODES, REFERRAL_MANUAL_CREDITS)).toEqual([]);
});

describe("validateReferralConfig", () => {
  test("accepts a member code, a team code and a manual credit", () => {
    const team = member({ code: "rm_site", memberId: null, channel: "site", termsVersion: null });
    expect(validateReferralConfig([member(), team], [credit()])).toEqual([]);
  });

  test("rejects a code that is not lowercase or not rm_ plus a slug", () => {
    expect(validateReferralConfig([member({ code: "RM_ACME" })], []).length).toBeGreaterThan(0);
    expect(validateReferralConfig([member({ code: "acme" })], []).length).toBeGreaterThan(0);
  });

  test("rejects a code listed twice", () => {
    expect(validateReferralConfig([member(), member({ memberId: "other", disabledAt: null })], [])).toContain(
      'referral code "rm_acme": listed more than once',
    );
  });

  test("needs exactly one of memberId or channel", () => {
    expect(validateReferralConfig([member({ channel: "site" })], [])).toContain(
      'referral code "rm_acme": needs exactly one of memberId or channel',
    );
    expect(validateReferralConfig([member({ memberId: null })], [])).toContain(
      'referral code "rm_acme": needs exactly one of memberId or channel',
    );
  });

  test("a member code needs a terms version before it is switched on", () => {
    expect(validateReferralConfig([member({ termsVersion: null })], [])).toHaveLength(1);
    expect(validateReferralConfig([member({ termsVersion: null, enabledAt: null })], [])).toEqual([]);
  });

  test("checks the dates", () => {
    expect(validateReferralConfig([member({ enabledAt: "soon" })], [])).toContain(
      'referral code "rm_acme": enabledAt is not a date',
    );
    expect(validateReferralConfig([member({ disabledAt: "2026-10-01T00:00:00Z" })], [])).toContain(
      'referral code "rm_acme": disabledAt must come after enabledAt',
    );
    expect(validateReferralConfig([member({ enabledAt: null, disabledAt: "2026-11-01T00:00:00Z" })], [])).toContain(
      'referral code "rm_acme": disabledAt is set but the code was never switched on',
    );
  });

  test("lets a member who came back hold a second code only once the first is switched off", () => {
    const first = member({ code: "rm_acme", disabledAt: "2026-12-01T00:00:00Z" });
    const second = member({ code: "rm_acme-2", enabledAt: "2027-01-01T00:00:00Z" });
    expect(validateReferralConfig([first, second], [])).toEqual([]);
    expect(validateReferralConfig([member(), second], []).join("\n")).toContain("already has a live code");
  });

  test("checks manual credits", () => {
    expect(validateReferralConfig([member()], [credit({ code: "rm_nobody" })]).join("\n")).toContain(
      "is not in the codes list",
    );
    expect(validateReferralConfig([member()], [credit({ wallet: "0xABC" })]).length).toBeGreaterThan(0);
    expect(validateReferralConfig([member()], [credit(), credit()]).join("\n")).toContain("credited more than once");
    expect(validateReferralConfig([member()], [credit({ message: " " })]).length).toBeGreaterThan(0);
  });
});

describe("referralCodeState", () => {
  const at = (iso: string) => Date.parse(iso) / 1000;

  test("is off before enabledAt, on from it, and off again from disabledAt", () => {
    const entry = member({ disabledAt: "2026-12-01T00:00:00Z" });
    expect(referralCodeState(entry, at("2026-10-19T23:59:59Z"))).toBe("off");
    expect(referralCodeState(entry, at("2026-10-20T00:00:00Z"))).toBe("on");
    expect(referralCodeState(entry, at("2026-11-30T23:59:59Z"))).toBe("on");
    expect(referralCodeState(entry, at("2026-12-01T00:00:00Z"))).toBe("off");
  });

  test("is off when the code was never switched on", () => {
    expect(referralCodeState(member({ enabledAt: null }), at("2027-01-01T00:00:00Z"))).toBe("off");
  });

  test("findReferralCode compares in lowercase", () => {
    expect(findReferralCode([member()], " RM_ACME ")?.code).toBe("rm_acme");
    expect(findReferralCode([member()], "rm_bolt")).toBeUndefined();
  });
});
