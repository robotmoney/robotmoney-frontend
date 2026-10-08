// Which host a GeckoTerminal call goes to, and with what credential (issue 1062).
//
// GeckoTerminal is CoinGecko's. Keyless, it is `api.geckoterminal.com/api/v2` at about 10 calls a minute per IP. With a
// paid CoinGecko plan the same data is served from `pro-api.coingecko.com/api/v3/onchain/...` under the
// `x-cg-pro-api-key` header, and the paths after the base are the same. Which calls a plan includes depends on the plan:
// OUR plan is Basic, which covers new_pools, tokens/{address}/pools and simple/.../token_price but NOT the pool OHLCV
// endpoint (Analyst and above). So OHLCV always goes to the free host. Moving to Analyst is one line in PRO_CALLS.
//
// COINGECKO_API_KEY unset or blank → every URL and header is exactly what it was before this module.
//
// A 401 or 403 from the Pro host (a plan that lacks the endpoint, a revoked key) must not stop data: the caller falls
// back to the free host for the same request, and this module remembers for ten minutes so the next calls do not each
// pay a failed round trip. The key only ever lands in the request headers; nothing here logs or returns it.
// `pool` is one pool's own reading (liquidity, volume), used by the token page (RM-156) and read by the worker
// (worker/handlers/token-market.ts), never the api; like OHLCV it stays on the free host until it is added to PRO_CALLS.
export type GeckoCall = "new_pools" | "token_pools" | "token_price" | "ohlcv" | "pool";

const FREE_BASE = "https://api.geckoterminal.com/api/v2";
const PRO_BASE = "https://pro-api.coingecko.com/api/v3/onchain";
const PRO_HOST = new URL(PRO_BASE).host;
const FREE_HOST = new URL(FREE_BASE).host;

/** The calls our CoinGecko plan (Basic) includes on the Pro host. */
export const PRO_CALLS: ReadonlySet<GeckoCall> = new Set<GeckoCall>(["new_pools", "token_pools", "token_price"]);

export const PRO_REJECTED_COOLDOWN_MS = 10 * 60_000;

type Log = { warn?: (m: string) => void };

let proRejectedUntil = 0;
let warnedInvalidKey = false;
const loggedTier = new Set<string>();

/** The configured key when it is usable as a header value, else null. A pasted secret with a stray newline would make
 *  fetch throw an error that copies the value into a log, so it is refused here and never sent. */
function usableKey(raw: string | undefined, log: Log): string | null {
  const key = (raw ?? "").trim();
  if (!key) return null;
  if (!/^[\x21-\x7e]+$/.test(key)) {
    if (!warnedInvalidKey) {
      warnedInvalidKey = true;
      log.warn?.(`[gecko] COINGECKO_API_KEY is not a valid header value (non-printable or non-ASCII character); using ${FREE_HOST}`);
    }
    return null;
  }
  return key;
}

/** The URL for `call`. `path` starts with `/` and is relative to the base (`/networks/new_pools?page=1`). */
export function geckoUrl(
  call: GeckoCall,
  path: string,
  opts: { key?: string | undefined; now?: number; log?: Log } = {},
): string {
  const now = opts.now ?? Date.now();
  const log = opts.log ?? console;
  const key = usableKey("key" in opts ? opts.key : process.env.COINGECKO_API_KEY, log);
  const pro = key !== null && PRO_CALLS.has(call) && now >= proRejectedUntil;
  const url = `${pro ? PRO_BASE : FREE_BASE}${path}`;
  const tag = `${call}:${pro ? "pro" : "free"}`;
  if (!loggedTier.has(tag)) {
    loggedTier.add(tag);
    log.warn?.(`[gecko] ${call} via ${pro ? "pro" : "free"} tier (${pro ? PRO_HOST : FREE_HOST})`);
  }
  return url;
}

export function isProUrl(url: string): boolean {
  return url.startsWith(`${PRO_BASE}/`) || url.startsWith(`${PRO_BASE}?`);
}

/** The tier a URL is served from, for pacing. */
export function tierOf(url: string): "pro" | "free" {
  return isProUrl(url) ? "pro" : "free";
}

/** Headers that authenticate `url`: the key for a Pro URL, nothing for any other. Merge over the caller's own. */
export function geckoAuthHeaders(url: string, rawKey: string | undefined = process.env.COINGECKO_API_KEY): Record<string, string> {
  if (!isProUrl(url)) return {};
  const key = usableKey(rawKey, console);
  return key ? { "x-cg-pro-api-key": key } : {};
}

/** The free-host equivalent of a Pro URL (same path and query). */
export function freeUrlFor(url: string): string {
  return isProUrl(url) ? `${FREE_BASE}${url.slice(PRO_BASE.length)}` : url;
}

/**
 * The Pro host refused this request (401 or 403). Remember it for ten minutes and return the free-host URL to retry.
 * Logs once per cooldown, with the status and call but never the key.
 */
export function fallBackToFree(url: string, status: number, label: string, log: Log = console, now = Date.now()): string {
  if (now >= proRejectedUntil) {
    log.warn?.(`[gecko] ${PRO_HOST} answered HTTP ${status} for ${label}; using ${FREE_HOST} for ${PRO_REJECTED_COOLDOWN_MS / 60_000} min`);
  }
  proRejectedUntil = now + PRO_REJECTED_COOLDOWN_MS;
  return freeUrlFor(url);
}

/** True when a response status from a Pro URL means "not for this key or plan", as opposed to throttling or an outage. */
export function proRefused(url: string, status: number): boolean {
  return isProUrl(url) && (status === 401 || status === 403);
}

/** Test-only hygiene. */
export function _resetGeckoEndpointForTests(): void {
  proRejectedUntil = 0;
  warnedInvalidKey = false;
  loggedTier.clear();
}
