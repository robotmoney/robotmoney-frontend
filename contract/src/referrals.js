// Referral codes (issue 1371). Canonical: docs/technical/referrals-spec.md §3.
//
// THE ONE CODE-FORMAT RULE. The public lookup, the deposit skill's fixtures and
// the attribution report all normalize through `normalizeReferralCode` below, so
// they cannot disagree about what a code is. Import-free on purpose, like
// routes.js: it can be vendored into the buildless frontend verbatim.
//
// Normalizing user input is two steps, and only two: trim surrounding
// whitespace, then lowercase ASCII letters. Interior whitespace and every
// non-ASCII character stay in the string, so they fail the pattern rather than
// being removed: no requested code is ever silently turned into another one.

/** `rm_` then lowercase ASCII slug segments joined by single hyphens. */
export const REFERRAL_CODE_PATTERN = /^rm_[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The longest code, in ASCII characters, `rm_` included. */
export const REFERRAL_CODE_MAX_LENGTH = 32;

/** `Cache-Control` on the public lookup's 200 and 404 (spec §6). */
export const REFERRAL_LOOKUP_CACHE_CONTROL = "public, max-age=60";

/** Requests per client ip per window on the public lookup (spec §6). */
export const REFERRAL_LOOKUP_RATE_MAX = 100;

/** The public lookup's sliding window, in milliseconds (spec §6). */
export const REFERRAL_LOOKUP_RATE_WINDOW_MS = 60_000;

/**
 * The normalized code for `raw`, or null when `raw` is not a code.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeReferralCode(raw) {
  if (typeof raw !== "string") return null;
  const lowered = raw.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (lowered.length > REFERRAL_CODE_MAX_LENGTH) return null;
  return REFERRAL_CODE_PATTERN.test(lowered) ? lowered : null;
}

/**
 * True when `value` is already a normalized code. A code read from chain
 * evidence must pass this, not `normalizeReferralCode`: a carrier value that
 * only becomes valid after trimming or lowercasing is `invalid_code`, because
 * the report never repairs what a depositor recorded (spec §3).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNormalizedReferralCode(value) {
  return typeof value === "string" && normalizeReferralCode(value) === value;
}
