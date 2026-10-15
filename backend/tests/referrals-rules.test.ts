// The referral credit rules (Linear RM-174): which deposit binds which wallet.
//
// WHAT THIS FILE PROTECTS. Credit is for the life of a wallet, so a wrong rule
// locks in a wrong answer. Each status the rules can give is asserted here on a
// small, readable set of deposits, with the case each rule exists for: a member
// claiming someone else's wallet through a deposit made on their behalf, a
// second member trying to take a wallet that is already bound, a code added
// long after the wallet's first deposit, and the vault legs of one routed
// deposit, which must count once and not as duplicates of themselves.
import { test, expect, describe } from "bun:test";
import { attributeReferrals, REFERRAL_WINDOW_SECONDS, type DepositObservation } from "../src/referrals/rules.ts";
import type { ReferralCodeEntry, ReferralManualCredit } from "../src/referrals/codes.ts";

const LAUNCH = Date.parse("2026-10-20T00:00:00Z") / 1000;
const DAY = 24 * 60 * 60;

const ALICE = "0x" + "a1".repeat(20); // a depositor
const BOB = "0x" + "b0".repeat(20); // another depositor
const MALLORY = "0x" + "ee".repeat(20); // a member's own wallet
const VAULT_USDC = "0x28bf6e6edad526191e8652ee631b56ead4ce7435";
const VAULT_PROTO = "0x28c5ca4df0107679bfcc9b0ad4c2f3f209b8f797";

const codes: ReferralCodeEntry[] = [
  { code: "rm_acme", memberId: "m-acme", channel: null, termsVersion: "2026-10", enabledAt: "2026-10-20T00:00:00Z", disabledAt: null },
  { code: "rm_bolt", memberId: "m-bolt", channel: null, termsVersion: "2026-10", enabledAt: "2026-10-20T00:00:00Z", disabledAt: "2026-12-01T00:00:00Z" },
  { code: "rm_site", memberId: null, channel: "site", termsVersion: null, enabledAt: "2026-10-20T00:00:00Z", disabledAt: null },
  { code: "rm_later", memberId: "m-later", channel: null, termsVersion: "2026-10", enabledAt: "2026-11-15T00:00:00Z", disabledAt: null },
];

let nextBlock = 100;
const deposit = (overrides: Partial<DepositObservation>): DepositObservation => {
  const blockNumber = overrides.blockNumber ?? nextBlock++;
  return {
    txHash: overrides.txHash ?? "0x" + blockNumber.toString(16).padStart(64, "0"),
    logIndex: 0,
    blockNumber,
    blockTime: LAUNCH + DAY,
    wallet: ALICE,
    vault: VAULT_USDC,
    assets: "100000000",
    payer: overrides.wallet ?? ALICE,
    codes: [],
    ...overrides,
  };
};

const run = (deposits: DepositObservation[], manualCredits: ReferralManualCredit[] = []) =>
  attributeReferrals({ deposits, codes, manualCredits, launchTime: LAUNCH });

describe("attributeReferrals", () => {
  test("binds a wallet that pays for its own deposit with a code that is on", () => {
    const { bindings, attributions } = run([deposit({ codes: ["rm_acme"] })]);
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({ status: "bound", code: "rm_acme", memberId: "m-acme" });
    expect(bindings).toEqual([
      expect.objectContaining({ wallet: ALICE, code: "rm_acme", memberId: "m-acme", source: "calldata", boundAt: LAUNCH + DAY }),
    ]);
  });

  test("an uncoded deposit gives no row and no credit", () => {
    expect(run([deposit({})])).toEqual({ bindings: [], attributions: [], skippedManualCredits: [] });
  });

  test("a team channel code binds like a member code, with its channel and no member", () => {
    const { bindings } = run([deposit({ codes: ["rm_site"] })]);
    expect(bindings[0]).toMatchObject({ code: "rm_site", memberId: null, channel: "site" });
  });

  test("review: the transaction carries 2 codes", () => {
    const { bindings, attributions } = run([deposit({ codes: ["rm_acme", "rm_bolt"] })]);
    expect(attributions[0]).toMatchObject({ status: "review", code: null });
    expect(bindings).toEqual([]);
  });

  test("unknown_code: a code nobody holds, including a malformed one", () => {
    expect(run([deposit({ codes: ["rm_nobody"] })]).attributions[0]?.status).toBe("unknown_code");
    expect(run([deposit({ codes: ["rm_acme!"] })]).attributions[0]?.status).toBe("unknown_code");
  });

  test("inactive_code: before the code was switched on, after it was switched off, or before launch", () => {
    const before = deposit({ codes: ["rm_later"], blockTime: Date.parse("2026-11-01T00:00:00Z") / 1000 });
    const after = deposit({ wallet: BOB, codes: ["rm_bolt"], blockTime: Date.parse("2026-12-02T00:00:00Z") / 1000 });
    const prelaunch = deposit({ wallet: MALLORY, codes: ["rm_acme"], blockTime: LAUNCH - DAY });
    const { attributions, bindings } = run([before, after, prelaunch]);
    expect(attributions.map((a) => a.status)).toEqual(["inactive_code", "inactive_code", "inactive_code"]);
    expect(bindings).toEqual([]);
  });

  test("review: a member deposits for someone else's wallet to claim it", () => {
    // Mallory pays 1 USDC into Alice's wallet with her own code, before Alice deposits.
    const squat = deposit({ wallet: ALICE, payer: MALLORY, assets: "1000000", codes: ["rm_acme"] });
    const alicesOwn = deposit({ wallet: ALICE, payer: ALICE, codes: ["rm_site"] });
    const { attributions, bindings } = run([squat, alicesOwn]);
    expect(attributions[0]).toMatchObject({ status: "review" });
    expect(attributions[0]?.reason).toContain(MALLORY);
    expect(bindings).toEqual([expect.objectContaining({ wallet: ALICE, code: "rm_site" })]);
  });

  test("review: no USDC transfer into the router or the vault was found", () => {
    expect(run([deposit({ payer: null, codes: ["rm_acme"] })]).attributions[0]?.status).toBe("review");
  });

  test("duplicate: the first valid code wins", () => {
    const first = deposit({ codes: ["rm_acme"] });
    const second = deposit({ codes: ["rm_site"], blockTime: LAUNCH + 2 * DAY });
    const { attributions, bindings } = run([second, first]); // input order does not matter
    expect(attributions.map((a) => a.status)).toEqual(["bound", "duplicate"]);
    expect(bindings).toEqual([expect.objectContaining({ code: "rm_acme" })]);
  });

  test("the vault legs of one routed deposit all count as bound, once", () => {
    const tx = "0x" + "99".repeat(32);
    const legs = [
      deposit({ txHash: tx, blockNumber: 500, logIndex: 3, vault: VAULT_USDC, codes: ["rm_acme"] }),
      deposit({ txHash: tx, blockNumber: 500, logIndex: 7, vault: VAULT_PROTO, codes: ["rm_acme"] }),
    ];
    const { attributions, bindings } = run(legs);
    expect(attributions.map((a) => a.status)).toEqual(["bound", "bound"]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ txHash: tx, logIndex: 3 });
  });

  test("late: a code more than 30 days after the wallet's first deposit", () => {
    const firstUncoded = deposit({ blockTime: LAUNCH + DAY });
    const withinWindow = deposit({ wallet: BOB, blockTime: LAUNCH + DAY });
    const bobsCode = deposit({ wallet: BOB, codes: ["rm_acme"], blockTime: LAUNCH + DAY + REFERRAL_WINDOW_SECONDS });
    const alicesCode = deposit({ codes: ["rm_acme"], blockTime: LAUNCH + DAY + REFERRAL_WINDOW_SECONDS + 1 });
    const { attributions, bindings } = run([firstUncoded, withinWindow, bobsCode, alicesCode]);
    expect(attributions.map((a) => [a.wallet, a.status])).toEqual([
      [BOB, "bound"],
      [ALICE, "late"],
    ]);
    expect(bindings.map((b) => b.wallet)).toEqual([BOB]);
  });

  test("a wallet that deposited before launch gets its 30 days from launch", () => {
    const prelaunch = deposit({ blockTime: LAUNCH - 90 * DAY });
    const coded = deposit({ codes: ["rm_acme"], blockTime: LAUNCH + 29 * DAY });
    expect(run([prelaunch, coded]).attributions[0]?.status).toBe("bound");
  });

  test("manual credits apply after the chain rules, only to wallets the chain left unbound", () => {
    const manual = (wallet: string, code: string): ReferralManualCredit => ({
      wallet,
      code,
      txHash: "0x" + "12".repeat(32),
      message: `I was referred to Robot Money by ${code}`,
      signature: "0x" + "34".repeat(65),
      addedAt: "2026-11-05T00:00:00Z",
    });
    const { bindings, skippedManualCredits } = run(
      [deposit({ wallet: ALICE, codes: ["rm_acme"] })],
      [manual(ALICE, "rm_site"), manual(BOB, "rm_acme")],
    );
    expect(bindings.map((b) => [b.wallet, b.code, b.source])).toEqual([
      [ALICE, "rm_acme", "calldata"],
      [BOB, "rm_acme", "manual"],
    ]);
    expect(skippedManualCredits).toEqual([expect.objectContaining({ wallet: ALICE, code: "rm_site" })]);
  });

  test("wallets compare in lowercase", () => {
    const upper = "0x" + "A1".repeat(20);
    const { bindings } = run([deposit({ wallet: upper, payer: ALICE, codes: ["rm_acme"] })]);
    expect(bindings[0]?.wallet).toBe(ALICE);
  });
});
