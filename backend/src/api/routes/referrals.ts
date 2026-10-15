// GET /api/referrals/codes/:code — the public referral-code check (issue 1358,
// Linear RM-174). The deposit skill asks it before it adds a code to a deposit,
// so a typo is caught before it credits nobody or the wrong member. The answer
// itself is backend/src/referrals/check.ts; this module is the HTTP edge.
//
// It owns the whole /api/referrals/ prefix, so every request under it gets the
// same rate limit and the same 404: a bare /api/referrals/codes, a trailing
// slash, a nested path, a prefix such as rm_ or a wildcard such as rm_% or rm_*
// are all just "not found", indistinguishable from an unknown or switched-off
// code. No route here lists codes or members.
//
// CACHE AND RATE LIMIT. 200 and 404 carry `Cache-Control: public, max-age=60`:
// a code turned on or off reaches callers within a minute. One sliding window
// per client ip, per process (see ../rate-limit.ts): 100 requests a minute, then
// 429 with `Retry-After`, uncached.
import { ROUTES } from "@robotmoney/contract";
import { checkReferralCode } from "../../referrals/check.ts";
import { createRateLimiter } from "../rate-limit.ts";

export const REFERRALS_PREFIX = "/api/referrals/";
export const REFERRAL_RATE_MAX = 100;
export const REFERRAL_RATE_WINDOW_MS = 60_000;
export const REFERRAL_CACHE_CONTROL = "public, max-age=60";

const CODE_PREFIX = ROUTES.referrals.code.slice(0, ROUTES.referrals.code.indexOf(":code"));

const limiter = createRateLimiter({ max: REFERRAL_RATE_MAX, windowMs: REFERRAL_RATE_WINDOW_MS });
/** Forget every client's window. For tests. */
export function _resetReferralRateLimitForTests(): void {
  limiter.reset();
}

function respond(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const notFound = (): Response => respond(404, { error: "not found" }, { "Cache-Control": REFERRAL_CACHE_CONTROL });

/** The code segment of `pathname`, or null when the path is not exactly one code. */
function codeSegment(pathname: string): string | null {
  if (!pathname.startsWith(CODE_PREFIX)) return null;
  const rest = pathname.slice(CODE_PREFIX.length);
  if (rest === "" || rest.includes("/")) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null; // malformed percent-encoding is a malformed code: the same 404
  }
}

/** Answer every request under /api/referrals/. */
export async function handleReferrals(req: Request, url: URL, clientIp: string): Promise<Response> {
  const verdict = limiter.check(clientIp);
  if (verdict.limited) {
    return respond(429, { error: "rate limit exceeded" }, { "Cache-Control": "no-store", "Retry-After": String(verdict.retryAfterSeconds) });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return respond(405, { error: "method not allowed" }, { Allow: "GET", "Cache-Control": "no-store" });
  }
  const raw = codeSegment(url.pathname);
  if (raw === null) return notFound();
  const answer = await checkReferralCode(raw);
  if (!answer) return notFound();
  return respond(200, answer, { "Cache-Control": REFERRAL_CACHE_CONTROL });
}
