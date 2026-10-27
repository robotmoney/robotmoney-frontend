// Referral codes (issue 1371). Canonical: docs/technical/referrals-spec.md.
// Attribution only: nothing here is a payment, reward or promise of credit.

export const REFERRAL_CODE_PATTERN: RegExp;
export const REFERRAL_CODE_MAX_LENGTH: number;
export const REFERRAL_LOOKUP_CACHE_CONTROL: string;
export const REFERRAL_LOOKUP_RATE_MAX: number;
export const REFERRAL_LOOKUP_RATE_WINDOW_MS: number;
/** Trim surrounding whitespace, lowercase ASCII, then require the pattern. Null when not a code. */
export function normalizeReferralCode(raw: unknown): string | null;
/** True when `value` is already a normalized code (how chain evidence is judged). */
export function isNormalizedReferralCode(value: unknown): boolean;

/**
 * GET /api/referrals/codes/:code — a code that is active right now. A member
 * code names the member; a team channel code names its channel. Never both.
 *
 * Every other code (unknown, malformed, draft, scheduled, disabled, a
 * deactivated member's, a missing member's) answers the identical
 * `404 { error: "not found" }`. The answer says nothing about a wallet's
 * eligibility, launch status or credit.
 */
export type ReferralCodeCheck = ReferralMemberCodeCheck | ReferralChannelCodeCheck;

export interface ReferralMemberCodeCheck {
  /** The normalized code. */
  code: string;
  member: { handle: string; name: string };
}

export interface ReferralChannelCodeCheck {
  /** The normalized code. */
  code: string;
  /** The team channel the code tracks, for example `site`. */
  channel: string;
}

/** A registry record's lifecycle state at one instant (spec §5). */
export type ReferralCodeState = "draft" | "scheduled" | "active" | "disabled";

/**
 * AdminMember.referral: the member's code selected for the admin page (spec
 * §5): the code active now, else the nearest scheduled one, else the most
 * recently disabled, else a draft. Read-only: codes change only by a reviewed
 * registry change shipped in a release. Never on a public member response.
 */
export interface AdminMemberReferral {
  code: string;
  state: ReferralCodeState;
  /** Exactly `state === "active"`. */
  enabled: boolean;
  /** The terms version the member accepted; null until recorded. */
  termsVersion: string | null;
  /** ISO 8601 UTC; null for a draft. */
  enabledAt: string | null;
  /** ISO 8601 UTC; null while no disable is recorded. */
  disabledAt: string | null;
}

/** One admin correction as the admin panel shows it (spec §4). */
export interface AdminReferralCorrection {
  /** The log identifier the report cites. */
  id: string;
  kind: "verified" | "override";
  chainId: number;
  wallet: string;
  code: string;
  deposit: { transactionHash: string; logIndex: number };
  /** ISO 8601 UTC. The correction takes effect at this time, never earlier. */
  recordedAt: string;
  recordedBy: string;
  reason: string;
  /** Verified only: the signed payload's facts. Null for an override. */
  signature: null | {
    scheme: "eip191" | "eip1271";
    expiresAt: string;
    nonce: string;
    /** The exact message the wallet signed. */
    message: string;
    signature: string;
  };
  revocation: null | { id: string; recordedAt: string; recordedBy: string; reason: string };
  /**
   * What the panel could check without chain history: the signature (EIP-191
   * locally, EIP-1271 by one read of the wallet contract), nonce, expiry, code
   * and payload. `accepted` here is not a binding: whether the wallet was
   * unbound and the deposit self-funded is decided by the report at its
   * pinned snapshot (spec §4, §7).
   */
  check: { status: "accepted" | "rejected" | "unverifiable"; problems: string[] };
}

/** GET /api/admin/referrals/corrections — the correction log, read-only. */
export interface AdminReferralCorrectionsResponse {
  corrections: AdminReferralCorrection[];
  /** sha256 of the canonical correction log the report reads. */
  logDigest: string;
}
