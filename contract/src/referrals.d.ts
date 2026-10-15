// Referral codes (issue 1358, Linear RM-174). A deposit made through the deposit
// skill can carry a swarm member's referral code as an ERC-8021 suffix on its
// calldata. The codes live in backend config (REFERRAL_CODES), never in a table.

/**
 * GET /api/referrals/codes/:code — the answer for one code that is on right now.
 * A member code names the member; a team code names its channel. Never both.
 *
 * Every code that is not on (unknown, never switched on, not yet on, switched
 * off, malformed, or whose member row is gone) answers the same
 * `404 { error: "not found" }`, so the response never says which. The route
 * answers one code per request and no route lists codes or members.
 */
export type ReferralCodeCheck = ReferralMemberCodeCheck | ReferralChannelCodeCheck;

export interface ReferralMemberCodeCheck {
  /** The code, lowercase. */
  code: string;
  member: { handle: string; name: string };
}

export interface ReferralChannelCodeCheck {
  /** The code, lowercase. */
  code: string;
  /** The team channel the code tracks, for example `site`. */
  channel: string;
}

/**
 * A member's referral code as the admin surface sees it (AdminMember.referral).
 * Never on a public member response.
 */
export interface AdminMemberReferral {
  code: string;
  /** Whether the code counts for a deposit made now. */
  enabled: boolean;
  /** The referral terms version the member accepted; null until accepted. */
  termsVersion: string | null;
  /** ISO 8601; null when the code was never switched on. */
  enabledAt: string | null;
  /** ISO 8601; null while the code has not been switched off. */
  disabledAt: string | null;
}
