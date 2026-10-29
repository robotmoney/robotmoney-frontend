// Q48-referral-lookup/C36-referral-lookup (PR 1424, issue 1492): the referral
// feature is live on the target. docs/technical/referrals-spec.md §6 defines one
// public, unauthenticated, read-only route, GET /api/referrals/codes/:code. A
// 200 needs an active code, and a read-only check holds none, so this proves the
// part every target answers the same way: a code that is not active, a malformed
// one, a wildcard and the bare prefix all return 404 with the identical body
// {"error":"not found"} and Cache-Control "public, max-age=60", set no cookie,
// and never list. A target without the feature answers these differently (the
// site's generic 404 has other headers or a body that is not the envelope).
// The 200 shapes are covered by backend/tests/api/referrals.test.ts. The route
// has its own rate limiter (100 a minute), so these four GETs do not touch the
// public analytics budget Q47 spends. Reads only: GETs.
import { getWithRetry, realNet, type Net } from "../../public-analytics-read.ts";
import type { VersionCheck } from "../../version-check.ts";

export const REFERRAL_CODES = "/api/referrals/codes";
export const NOT_FOUND_BODY = '{"error":"not found"}';
export const LOOKUP_CACHE_CONTROL = "public, max-age=60";

/** Paths that spec §6 says all answer the same uniform 404. */
export const PROBES: readonly { readonly name: string; readonly path: string }[] = [
  { name: "unknown code", path: `${REFERRAL_CODES}/rm_release-check-no-such-code` },
  { name: "malformed code", path: `${REFERRAL_CODES}/NOT%20A%20CODE` },
  { name: "wildcard", path: `${REFERRAL_CODES}/rm_%25` },
  { name: "bare prefix (no list route)", path: REFERRAL_CODES },
];

export interface Answer {
  readonly name: string;
  readonly status: number;
  readonly cacheControl: string | null;
  readonly setCookie: string | null;
  readonly body: string;
}

/** PURE. Why the answers are not the spec's uniform 404; empty when they are. */
export function referralLookupProblems(answers: readonly Answer[]): string[] {
  if (answers.length === 0) return ["no answer to read"];
  const out: string[] = [];
  for (const a of answers) {
    if (a.status !== 404) out.push(`${a.name}: answered ${a.status}, not 404`);
    if (a.body !== NOT_FOUND_BODY) out.push(`${a.name}: body is ${JSON.stringify(a.body.slice(0, 80))}, not ${NOT_FOUND_BODY}`);
    if (a.cacheControl !== LOOKUP_CACHE_CONTROL) out.push(`${a.name}: Cache-Control is ${JSON.stringify(a.cacheControl)}, not ${JSON.stringify(LOOKUP_CACHE_CONTROL)}`);
    if (a.setCookie !== null) out.push(`${a.name}: the response sets a cookie; the lookup depends on none`);
  }
  return out;
}

export async function referralLookup(net: Net): Promise<{ found: Record<string, unknown>; problems: string[] }> {
  const answers: Answer[] = [];
  for (const p of PROBES) {
    const res = await getWithRetry(net, p.path);
    answers.push({ name: p.name, status: res.status, cacheControl: res.headers.get("cache-control"), setCookie: res.headers.get("set-cookie"), body: await res.text() });
  }
  return { found: { statuses: answers.map((a) => a.status), cacheControl: answers[0]?.cacheControl ?? null }, problems: referralLookupProblems(answers) };
}

export default ((ctx) => referralLookup(realNet(ctx.origin))) satisfies VersionCheck;
