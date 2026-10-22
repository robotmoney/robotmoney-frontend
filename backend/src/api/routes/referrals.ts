// GET /api/referrals/codes/:code — the public referral-code lookup (issue 1371,
// docs/technical/referrals-spec.md §6). The answer is referrals/lookup.ts; this
// module is the HTTP edge.
//
// It owns the whole /api/referrals/ prefix, so every request under it shares the
// limit and the uniform 404: a bare /api/referrals/codes, a trailing slash, a
// nested path, a prefix such as rm_ or a wildcard such as rm_% are all "not
// found", indistinguishable from an unknown or disabled code. No route lists.
//
// HEADERS. 200 and 404 carry `Cache-Control: public, max-age=60` and depend on
// nothing but the path: no cookie, no authorization header is read. 429 and 503
// are `no-store`. Bodies use the API's `{ "error": "<string>" }` envelope with
// the public analytics routes' strings.
//
// RATE LIMIT. Its OWN instance of the shared sliding-window limiter
// (../rate-limit.ts): 100 requests per 60 s per trusted client ip
// (../client-ip.ts resolved it before this handler runs), per process, in
// memory. Retry-After is whole seconds until the oldest request ages out.
import {
  REFERRAL_LOOKUP_CACHE_CONTROL,
  REFERRAL_LOOKUP_RATE_MAX,
  REFERRAL_LOOKUP_RATE_WINDOW_MS,
  ROUTES,
} from "@robotmoney/contract";
import { lookupReferralCode } from "../../referrals/lookup.ts";
import { createRateLimiter } from "../rate-limit.ts";

export const REFERRALS_PREFIX = "/api/referrals/";
const CODE_PREFIX = ROUTES.referrals.code.slice(0, ROUTES.referrals.code.indexOf(":code"));

const limiter = createRateLimiter({ max: REFERRAL_LOOKUP_RATE_MAX, windowMs: REFERRAL_LOOKUP_RATE_WINDOW_MS });

/** Forget every client's window. For tests. */
export function _resetReferralRateLimitForTests(): void {
  limiter.reset();
}

function respond(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const notFound = () => respond(404, { error: "not found" }, { "Cache-Control": REFERRAL_LOOKUP_CACHE_CONTROL });

/** The raw code segment, or null when the path is not exactly one segment under the code prefix. */
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
  if (verdict.limited) return respond(429, { error: "rate limit exceeded" }, { "Cache-Control": "no-store", "Retry-After": String(verdict.retryAfterSeconds) });
  if (req.method !== "GET") return respond(405, { error: "method not allowed" }, { Allow: "GET", "Cache-Control": "no-store" });
  const raw = codeSegment(url.pathname);
  if (raw === null) return notFound();
  let answer;
  try {
    answer = await lookupReferralCode(raw);
  } catch (err) {
    console.error("referral lookup failed:", err);
    return respond(503, { error: "service unavailable" }, { "Cache-Control": "no-store" });
  }
  return answer ? respond(200, answer, { "Cache-Control": REFERRAL_LOOKUP_CACHE_CONTROL }) : notFound();
}
