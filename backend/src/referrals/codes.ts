// Referral codes and manual credits as config entries (Linear RM-174).
//
// WHY CONFIG AND NOT A TABLE. v1 records which member referred which wallet,
// and a member's code changes a handful of times a year: once when the member
// accepts the referral terms, once if they leave. A list in
// backend/src/config.ts, changed by PR, gives every change a reviewer and a
// history in git, and needs no migration, no write route and no admin surface.
// A table earns its place only when referral data needs records that last
// beyond a rerun of the report.
//
// THE RULES FOR EDITING THE LIST. Entries are never deleted and a code is never
// reissued; the only edit allowed after merge is setting `disabledAt`. That is
// what lets the credit report be a pure function of the chain and this file: a
// rerun months later sees the same code switched on over the same window.
// validateReferralConfig enforces what it can (shape, uniqueness, dates); "never
// deleted" is a review rule.
import { isReferralCodeFormat, normalizeReferralCode } from "./suffix.ts";

/** One referral code: a member's, or a team channel's (which only tracks a source). */
export type ReferralCodeEntry = {
  /** `rm_` plus a handle-shaped slug, lowercase, at most 32 characters. */
  code: string;
  /** The member's `swarm_members.id`; null for a team channel. */
  memberId: string | null;
  /** The team channel this code tracks (for example `site`); null for a member. */
  channel: string | null;
  /** The referral terms version the member accepted; null for a team channel. */
  termsVersion: string | null;
  /** When the code started counting (ISO 8601). Null: listed but never switched on. */
  enabledAt: string | null;
  /** When the code stopped counting for new deposits (ISO 8601). Wallets it already bound stay bound. */
  disabledAt: string | null;
};

/**
 * A credit we add by hand, for a deposit made without a code. The depositor's
 * wallet signs a message naming the code; we keep the message and signature
 * here so anyone can check the claim.
 */
export type ReferralManualCredit = {
  /** The depositing wallet, lowercase. */
  wallet: string;
  code: string;
  /** The deposit transaction the credit is for. */
  txHash: string;
  /** The exact message the wallet signed. */
  message: string;
  /** The wallet's signature over `message`, 0x-prefixed hex. */
  signature: string;
  /** When we added the credit (ISO 8601); credit runs from this time. */
  addedAt: string;
};

export type ReferralCodeState = "on" | "off";

/** Whether `entry` counts for a deposit made at `atSeconds` (unix time). */
export function referralCodeState(entry: ReferralCodeEntry, atSeconds: number): ReferralCodeState {
  const enabled = toSeconds(entry.enabledAt);
  const disabled = toSeconds(entry.disabledAt);
  if (enabled === null || atSeconds < enabled) return "off";
  if (disabled !== null && atSeconds >= disabled) return "off";
  return "on";
}

/** The entry for `code`, compared in lowercase, or undefined. */
export function findReferralCode(
  codes: readonly ReferralCodeEntry[],
  code: string,
): ReferralCodeEntry | undefined {
  const wanted = normalizeReferralCode(code);
  return codes.find((entry) => entry.code === wanted);
}

const WALLET_RE = /^0x[0-9a-f]{40}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]+$/;

/** Every problem with the referral config, as readable lines. Empty when the config is sound. */
export function validateReferralConfig(
  codes: readonly ReferralCodeEntry[],
  manualCredits: readonly ReferralManualCredit[],
): string[] {
  const errors: string[] = [];
  const seenCodes = new Set<string>();
  const liveCodeByMember = new Map<string, string>();

  for (const entry of codes) {
    const label = `referral code ${JSON.stringify(entry.code)}`;
    if (entry.code !== normalizeReferralCode(entry.code)) {
      errors.push(`${label}: must be written in lowercase with no surrounding spaces`);
    }
    if (!isReferralCodeFormat(entry.code)) {
      errors.push(`${label}: must be rm_ plus a lowercase slug, 32 characters at most`);
    }
    if (seenCodes.has(entry.code)) errors.push(`${label}: listed more than once`);
    seenCodes.add(entry.code);

    const isMember = entry.memberId !== null;
    const isChannel = entry.channel !== null;
    if (isMember === isChannel) {
      errors.push(`${label}: needs exactly one of memberId or channel`);
    }
    if (isMember && entry.memberId!.trim() === "") errors.push(`${label}: memberId is empty`);
    if (isChannel && entry.channel!.trim() === "") errors.push(`${label}: channel is empty`);
    if (isChannel && entry.termsVersion !== null) {
      errors.push(`${label}: a team channel code has no terms version`);
    }
    if (isMember && entry.enabledAt !== null && !entry.termsVersion) {
      errors.push(`${label}: a member code needs the accepted terms version before it is switched on`);
    }

    const enabled = toSeconds(entry.enabledAt);
    const disabled = toSeconds(entry.disabledAt);
    if (entry.enabledAt !== null && enabled === null) errors.push(`${label}: enabledAt is not a date`);
    if (entry.disabledAt !== null && disabled === null) errors.push(`${label}: disabledAt is not a date`);
    if (entry.disabledAt !== null && entry.enabledAt === null) {
      errors.push(`${label}: disabledAt is set but the code was never switched on`);
    }
    if (enabled !== null && disabled !== null && disabled <= enabled) {
      errors.push(`${label}: disabledAt must come after enabledAt`);
    }

    // A member who leaves and comes back gets a new code, so the same member may
    // appear more than once, but only one of their codes may still be live.
    if (isMember && entry.disabledAt === null) {
      const other = liveCodeByMember.get(entry.memberId!);
      if (other !== undefined) {
        errors.push(`${label}: member ${entry.memberId} already has a live code (${other})`);
      }
      liveCodeByMember.set(entry.memberId!, entry.code);
    }
  }

  const creditedWallets = new Set<string>();
  for (const credit of manualCredits) {
    const label = `manual credit for ${JSON.stringify(credit.wallet)}`;
    if (!WALLET_RE.test(credit.wallet)) errors.push(`${label}: wallet must be a lowercase 0x address`);
    if (creditedWallets.has(credit.wallet)) errors.push(`${label}: wallet credited more than once`);
    creditedWallets.add(credit.wallet);
    if (!seenCodes.has(credit.code)) errors.push(`${label}: code ${credit.code} is not in the codes list`);
    if (!TX_HASH_RE.test(credit.txHash)) errors.push(`${label}: txHash must be a lowercase 0x hash`);
    if (credit.message.trim() === "") errors.push(`${label}: the signed message is empty`);
    if (!SIGNATURE_RE.test(credit.signature)) errors.push(`${label}: signature must be 0x-prefixed hex`);
    if (toSeconds(credit.addedAt) === null) errors.push(`${label}: addedAt is not a date`);
  }

  return errors;
}

/** Unix seconds for an ISO 8601 string, or null when absent or unparseable. */
export function toSeconds(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
