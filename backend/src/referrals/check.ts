// The public referral-code check and the admin view of a member's code (issue
// 1358, Linear RM-174). Canonical: docs/architecture/investment-swarm.md,
// "Referral code check".
//
// WHAT IT ANSWERS. Whether ONE code is on right now, and whose it is: a member's
// handle and name, or a team channel. Nothing else. Every other outcome (an
// unknown code, one never switched on, one not yet on, one switched off, a
// malformed string, a member code whose swarm_members row is gone) is the same
// `null`, which the route turns into one byte-identical 404, so a caller can
// never tell which of those it hit. There is no lookup by prefix, pattern or
// member, so the route cannot be used to list codes or members.
//
// ONE CHECK, NOT TWO. The code format, the lowercase comparison, the lookup and
// the on/off rule all come from PR 1370's helpers (suffix.ts and codes.ts). This
// module holds no pattern of its own, so the deposit skill, the credit report
// and this route cannot disagree about what a code is or when it counts.
//
// NO SCHEMA. The codes are REFERRAL_CODES in backend/src/config.ts and change
// only by PR. The one database read is swarm_members by primary key, as rm_app.
import type { AdminMemberReferral, ReferralCodeCheck } from "@robotmoney/contract";
import { REFERRAL_CODES } from "../config.ts";
import { sql } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";
import { testSeamArmed, testSeamRefusal } from "../test-seam.ts";
import { findReferralCode, referralCodeState, type ReferralCodeEntry } from "./codes.ts";
import { isReferralCodeFormat, normalizeReferralCode } from "./suffix.ts";

const readMemberById = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/referrals/check:checkReferralCode.member",
  purpose: "Read the handle and name of the member an on referral code names, by primary key, for GET /api/referrals/codes/:code.",
  callers: ["src/api/routes/referrals"],
  probe: { statement: "SELECT id, handle, name FROM swarm_members WHERE id = $1", params: ["probe"] },
});

let codes: readonly ReferralCodeEntry[] = REFERRAL_CODES;

/** The referral codes in force: REFERRAL_CODES, unless a test replaced them. */
export function referralCodes(): readonly ReferralCodeEntry[] {
  return codes;
}

/**
 * Replace the codes for this test process; null restores REFERRAL_CODES.
 * Refused outside the test harness (backend/src/test-seam.ts), so a deployed
 * process always answers from config.
 */
export function _setReferralCodesForTests(list: readonly ReferralCodeEntry[] | null): void {
  if (!testSeamArmed()) throw testSeamRefusal("_setReferralCodesForTests", "Referral codes change only by PR to REFERRAL_CODES.");
  codes = list ?? REFERRAL_CODES;
}

/** Unix seconds now. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The public answer for `raw` if it is a code that is on at `atSeconds`, or null
 * for every other case. Null never says why.
 */
export async function checkReferralCode(raw: string, atSeconds: number = nowSeconds()): Promise<ReferralCodeCheck | null> {
  const code = normalizeReferralCode(raw);
  if (!isReferralCodeFormat(code)) return null;
  const entry = findReferralCode(codes, code);
  if (!entry || referralCodeState(entry, atSeconds) !== "on") return null;
  if (entry.channel !== null) return { code: entry.code, channel: entry.channel };
  if (entry.memberId === null) return null;
  const rows = await on(sql, readMemberById)<{ id: string; handle: string | null; name: string }>`SELECT id, handle, name FROM swarm_members WHERE id = ${entry.memberId}`;
  const member = rows[0];
  if (!member) return null;
  return { code: entry.code, member: { handle: member.handle ?? member.id, name: member.name } };
}

/**
 * The member's referral code for the admin surface, or null when the member has
 * none. A member who left and came back can have several codes: the live one
 * (no `disabledAt`) wins, else the last one listed.
 */
export function memberReferral(memberId: string, atSeconds: number = nowSeconds()): AdminMemberReferral | null {
  const mine = codes.filter((entry) => entry.memberId === memberId);
  const entry = mine.find((e) => e.disabledAt === null) ?? mine[mine.length - 1];
  if (!entry) return null;
  return {
    code: entry.code,
    enabled: referralCodeState(entry, atSeconds) === "on",
    termsVersion: entry.termsVersion,
    enabledAt: entry.enabledAt,
    disabledAt: entry.disabledAt,
  };
}
