// Which host a GeckoTerminal call goes to, and with what credential (issue 1062).
//
// GeckoTerminal is CoinGecko's. Keyless, it is `api.geckoterminal.com/api/v2` at about 10 calls a minute per IP. With a
// paid CoinGecko plan the same data is served from `pro-api.coingecko.com/api/v3/onchain/...` under the
// `x-cg-pro-api-key` header, and the paths after the base are the same. Which calls a plan includes depends on the plan.
// Our key answers every call here on the Pro host, the pool reading and pool OHLCV included (verified 2026-10-08:
// HTTP 200 with data for tokens/{address}/pools, pools/{address} and pools/{address}/ohlcv/day with the production key),
// so every call but new_pools is in PRO_CALLS. A call the plan stops covering gets 401/403 and falls back to the free
// host (below). new_pools is keyless only (issue 1654): the new-pools collector reads it every 60 s, about 5,000
// requests a day, which must never spend paid credits; the legacy NEW_TOKENS sweep reads the same keyless feed, whose
// 10-page limit is the Pro host's too.
//
// COINGECKO_API_KEY unset or blank → every URL and header is exactly what it was before this module.
//
// A 401 or 403 from the Pro host (a plan that lacks the endpoint, a revoked key), or a 429 whose body carries a quota
// error_code (10006: the account's monthly credit is spent, issue 1664), must not stop data: the caller falls back to
// the free host for the same request, and this module remembers for ten minutes so the next calls do not each pay a
// failed round trip. A 429 with no quota error_code is per-minute throttling and keeps the caller's retry with backoff
// on the Pro host. The cooldown is shared with CoinGecko's own coins API (projects/access/live-source.ts), because one
// key and one credit pool serve both. The key only ever lands in the request headers; nothing here logs or returns it.
// `pool` is one pool's own reading (liquidity, volume), used by the token page (RM-156) and read by the worker
// (worker/handlers/token-market.ts), never the api.
export type GeckoCall = "new_pools" | "token_pools" | "token_price" | "ohlcv" | "pool";

import { takeProCall } from "./gecko-rate-limit.ts";

const FREE_BASE = "https://api.geckoterminal.com/api/v2";
// CoinGecko's own API: the Pro root serves both the onchain (GeckoTerminal) paths and the coins paths.
const CG_PRO_ROOT = "https://pro-api.coingecko.com/api/v3";
const CG_PUBLIC_ROOT = "https://api.coingecko.com/api/v3";
const PRO_BASE = `${CG_PRO_ROOT}/onchain`;
const PRO_HOST = new URL(PRO_BASE).host;
const FREE_HOST = new URL(FREE_BASE).host;

/** CoinGecko error_codes that mean the paid account itself is out of credit, not per-minute throttling. */
const QUOTA_ERROR_CODES: ReadonlySet<number> = new Set([10006]);

/** The calls sent to the Pro host when a key is set: every call our plan includes (verified with the production key,
 *  2026-10-08) except new_pools, which always goes to the keyless host (issue 1654). */
export const PRO_CALLS: ReadonlySet<GeckoCall> = new Set<GeckoCall>(["token_pools", "token_price", "ohlcv", "pool"]);

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
  return url.startsWith(`${CG_PRO_ROOT}/`) || url.startsWith(`${CG_PRO_ROOT}?`);
}

/** False while the Pro host is in its refusal cooldown: every CoinGecko call then goes to the free host. */
export function proAvailable(now: number = Date.now()): boolean {
  return now >= proRejectedUntil;
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

/** The free-host equivalent of a Pro URL (same path and query): GeckoTerminal for onchain paths, the public
 *  CoinGecko host for the coins API. */
export function freeUrlFor(url: string): string {
  if (url.startsWith(`${PRO_BASE}/`) || url.startsWith(`${PRO_BASE}?`)) return `${FREE_BASE}${url.slice(PRO_BASE.length)}`;
  return isProUrl(url) ? `${CG_PUBLIC_ROOT}${url.slice(CG_PRO_ROOT.length)}` : url;
}

/** CoinGecko's error body, `{"status":{"error_code":10006,"error_message":"..."}}` (or the same fields at the top
 *  level). Missing or unparseable → both null. */
export function geckoErrorBody(body: string): { code: number | null; message: string | null } {
  try {
    const j = JSON.parse(body) as { status?: Record<string, unknown>; error_code?: unknown; error_message?: unknown };
    const src = j && typeof j.status === "object" && j.status !== null ? j.status : (j as Record<string, unknown>);
    const code = Number(src?.error_code);
    const message = typeof src?.error_message === "string" ? src.error_message : null;
    return { code: Number.isFinite(code) ? code : null, message };
  } catch {
    return { code: null, message: null };
  }
}

/** ` (error_code N: message)` for an error line, or "" when the body carries neither. The key is never included:
 *  should the vendor echo it, it is redacted. */
export function geckoErrorDetail(body: string, rawKey: string | undefined = process.env.COINGECKO_API_KEY): string {
  const { code, message } = geckoErrorBody(body);
  if (code === null && message === null) return "";
  let text = `error_code ${code ?? "none"}: ${(message ?? "").slice(0, 300)}`;
  const key = (rawKey ?? "").trim();
  if (key) text = text.split(key).join("[REDACTED]");
  return ` (${text})`;
}

/**
 * The Pro host refused this request (401, 403, or a quota 429). Remember it for ten minutes and return the free-host
 * URL to retry. Logs once per cooldown, with the status, the error_code and the call but never the key.
 */
export function fallBackToFree(url: string, status: number, label: string, log: Log = console, now = Date.now(), body = ""): string {
  const free = freeUrlFor(url);
  if (now >= proRejectedUntil) {
    log.warn?.(
      `[gecko] ${PRO_HOST} answered HTTP ${status}${geckoErrorDetail(body)} for ${label}; ` +
        `using ${new URL(free).host} for ${PRO_REJECTED_COOLDOWN_MS / 60_000} min`,
    );
  }
  proRejectedUntil = now + PRO_REJECTED_COOLDOWN_MS;
  return free;
}

/** True when a response from a Pro URL means "not for this key, plan or month" (401, 403, or 429 with a quota
 *  error_code), as opposed to per-minute throttling or an outage. */
export function proRefused(url: string, status: number, body = ""): boolean {
  if (!isProUrl(url)) return false;
  if (status === 401 || status === 403) return true;
  if (status !== 429) return false;
  const { code } = geckoErrorBody(body);
  return code !== null && QUOTA_ERROR_CODES.has(code);
}

/** The URL to actually send: `url` itself, or its free-host twin when this process has spent its per-minute Pro-call
 *  budget (gecko-rate-limit.ts takeProCall, GECKO_PRO_CALLS_PER_MIN). Logs once per process. */
export function budgetedTarget(url: string, now: number = Date.now(), log: Log = console): string {
  if (!isProUrl(url) || takeProCall(now)) return url;
  if (!loggedTier.has("budget")) {
    loggedTier.add("budget");
    log.warn?.(`[gecko] per-process Pro-call budget (GECKO_PRO_CALLS_PER_MIN) spent; overflow calls use the free host`);
  }
  return freeUrlFor(url);
}

/** Test-only hygiene. */
export function _resetGeckoEndpointForTests(): void {
  proRejectedUntil = 0;
  warnedInvalidKey = false;
  loggedTier.clear();
}
