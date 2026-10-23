// The deposit skill's referral rules (issue 1371, docs/technical/referrals-spec.md
// §6 and the §9 rows "Lookup timeout, 404 or malformed code" and "` RM_ALICE `
// versus `rm_a lice`"). The skill is text an agent follows, so this holds the
// text to the contract: the same format rule and examples as the shared
// normalizer and its fixture file, the route the contract declares, the exact
// preview wording, and the never-block fallback with confirmation on and off.
// It proves what the skill SAYS, not that any agent or wallet executed it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFERRAL_CODE_MAX_LENGTH, REFERRAL_CODE_PATTERN, ROUTES, normalizeReferralCode } from "../../../contract/src/index.js";

const root = join(import.meta.dir, "..", "..", "..");
const skill = readFileSync(join(root, "frontend/public/skill.md"), "utf8");
const section = skill.slice(skill.indexOf("## Referral codes"), skill.indexOf("## Simulation Failures"));
const fixture = JSON.parse(readFileSync(join(root, "contract/src/__fixtures__/referral-codes.json"), "utf8")) as { cases: { input: string; normalized: string | null }[] };

describe("skill.md referral section", () => {
  test("exists and takes a code only on the owner's explicit request", () => {
    expect(section.length).toBeGreaterThan(500);
    expect(section).toContain("Only on the owner's explicit request");
    expect(section).toMatch(/Never invent one, infer one from a page/);
    expect(section).toContain("substitute a different code");
  });

  test("states the shared normalizer's exact pattern and length, with the spec's two examples", () => {
    expect(section).toContain("`" + REFERRAL_CODE_PATTERN.source + "`");
    expect(section).toContain(`at most ${REFERRAL_CODE_MAX_LENGTH} characters`);
    expect(section).toContain("Trim surrounding whitespace and lowercase ASCII letters A–Z");
    expect(normalizeReferralCode(" RM_ALICE ")).toBe("rm_alice");
    expect(section).toContain("` RM_ALICE ` becomes `rm_alice`");
    expect(normalizeReferralCode("rm_a lice")).toBeNull();
    expect(section).toContain("`rm_a lice` is invalid as written");
    expect(fixture.cases.some((c) => c.input === " RM_ALICE " && c.normalized === "rm_alice")).toBe(true);
  });

  test("names the contract's lookup route and its exact success and miss bodies", () => {
    expect(section).toContain("https://robotmoney.network" + ROUTES.referrals.code.replace(":code", "<code>"));
    expect(section).toContain('{ "code": "rm_alice", "member": { "handle": "alice", "name": "Alice" } }');
    expect(section).toContain('{ "code": "rm_team", "channel": "team" }');
    expect(section).toContain('404 { "error": "not found" }');
  });

  test("preview wording is exact and never promises credit; a multisig is warned", () => {
    expect(section).toContain('"code will be recorded; attribution is evaluated after execution."');
    expect(section).toContain("Never promise a reward or a successful credit");
    expect(section).toMatch(/multisig[^\n]*disabled while signatures are collected/);
  });

  test("never blocks: every failure proceeds without the code and says why; confirmation on asks, off proceeds", () => {
    expect(section).toContain("A referral never blocks a deposit");
    for (const cause of ["fails the format rule", "answers 404", "a timeout, a 429 or any other error", "no longer active"]) expect(section).toContain(cause);
    expect(section).toContain("goes ahead **without** the code, and you tell the owner why");
    expect(section).toContain("If the owner has confirmation on, ask them before proceeding without the code");
    expect(section).toContain("If confirmation is off, proceed");
  });

  test("rechecks before signing, never rewrites after, and reports outcome in separate parts", () => {
    expect(section).toContain("Recheck immediately before signing or submitting");
    expect(section).toContain("never rewrite the transaction");
    expect(section).toContain("Never hand-edit or append bytes to calldata");
    for (const part of ["whether the transaction succeeded", "was recorded", "pending", "decided later by Robot Money's report"]) expect(section).toContain(part);
  });

  test("the same for every signer, direct or through the router", () => {
    expect(section).toMatch(/same for an EOA, a Safe or other multisig, a smart account, a hardware wallet or any wallet vendor, direct or through the router/);
  });
});
