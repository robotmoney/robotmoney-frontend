// Extract stage: the HTTP primitives every source client shares. A hard
// timeout/abort means an unreachable or slow source fails fast so the caller can
// fall back to seeded / persisted for that series.
//
// Callers configured with a positive HTTP_FETCH_CACHE_TTL_MS memoize each GET
// body via fetch-cache.ts. Production and smoke default to uncached; normal
// smoke orchestration supplies one hour to protect shared-host provider quotas.

import { withFetchCache } from "./fetch-cache.ts";
import { recordSourceFetch, type CacheStatus } from "../source-ledger.ts";

export const UA = "robotmoney-regime/1.0";

interface CachedResponse {
  payloadBase64: string;
  status: number;
  releaseId: string | null;
}

async function fetchBytes(
  kind: "json" | "text",
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<Uint8Array> {
  let cacheStatus: CacheStatus = "disabled";
  try {
    const cached = await withFetchCache<CachedResponse>(kind, url, async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ac.signal, headers });
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (!r.ok) {
          recordSourceFetch({ url, headers, cacheStatus, responseStatus: r.status, payload: bytes,
            providerReleaseId: r.headers.get("etag") ?? r.headers.get("last-modified"),
            error: `${r.status} ${r.statusText}` });
          throw new Error(`${r.status} ${r.statusText} for ${url}`);
        }
        return {
          payloadBase64: Buffer.from(bytes).toString("base64"),
          status: r.status,
          releaseId: r.headers.get("etag") ?? r.headers.get("last-modified") ?? r.headers.get("x-release-id"),
        };
      } finally {
        clearTimeout(timer);
      }
    }, { onStatus: (status) => { cacheStatus = status; } });
    const bytes = new Uint8Array(Buffer.from(cached.payloadBase64, "base64"));
    recordSourceFetch({ url, headers, cacheStatus, responseStatus: cached.status, payload: bytes, providerReleaseId: cached.releaseId });
    return bytes;
  } catch (error) {
    // HTTP errors with response bytes were recorded above. Transport failures
    // have no response payload but are still evidence for this attempt.
    if (!(error instanceof Error && /\bfor https?:\/\//.test(error.message))) {
      recordSourceFetch({ url, headers, cacheStatus, error });
    }
    throw error;
  }
}

// Fetch JSON with a hard timeout so an unreachable/slow source falls back fast.
export async function fetchJson(
  url: string,
  timeoutMs = 8000,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const requestHeaders = { "user-agent": UA, accept: "application/json", ...headers };
  const bytes = await fetchBytes("json", url, timeoutMs, requestHeaders);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Fetch text (CSV / HTML) with the same hard-timeout discipline.
export async function fetchText(
  url: string,
  timeoutMs = 8000,
  headers: Record<string, string> = {},
): Promise<string> {
  const requestHeaders = { "user-agent": UA, accept: "text/csv,text/plain,*/*", ...headers };
  return new TextDecoder().decode(await fetchBytes("text", url, timeoutMs, requestHeaders));
}
