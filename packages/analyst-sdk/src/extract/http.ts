// Extract stage: the HTTP primitives every source client shares. A hard
// timeout/abort means an unreachable or slow source fails fast so the caller can
// fall back to seeded / persisted for that series.
//
// The SDK owns no fetch policy. `fetch` is injectable and two optional hooks
// let a host add behaviour around each GET: `cache` (the backend wires its
// on-disk TTL cache, fetch-cache.ts) and `recordFetch` (the backend wires its
// source ledger, source-ledger.ts). With no hooks configured every GET is a
// plain uncached `globalThis.fetch`, resolved at call time so a test that
// swaps globalThis.fetch is honoured. Issue #1095 part B.

export const UA = "robotmoney-regime/1.0";

export type CacheStatus = "disabled" | "hit" | "miss";

export interface FetchRecord {
  url: string;
  headers?: Record<string, string>;
  cacheStatus: CacheStatus;
  responseStatus?: number | null;
  payload?: Uint8Array | null;
  providerReleaseId?: string | null;
  error?: unknown;
}

export interface HttpHooks {
  /** Replaces globalThis.fetch for every extractor request. */
  fetch?: typeof fetch;
  /** Memoizes `load` under (kind,url); reports hit/miss/disabled through onStatus. */
  cache?: <T>(kind: "json" | "text", url: string, load: () => Promise<T>, opts: { onStatus: (s: CacheStatus) => void }) => Promise<T>;
  /** Observes each attempted GET (success, HTTP error or transport failure). */
  recordFetch?: (record: FetchRecord) => void;
}

let hooks: HttpHooks = {};

/** Install hooks (replacing any previous set). Returns the previous set so a caller can restore it. */
export function configureHttp(next: HttpHooks): HttpHooks {
  const previous = hooks;
  hooks = next;
  return previous;
}

/** The configured fetch, else the current globalThis.fetch. */
export function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  return (hooks.fetch ?? globalThis.fetch)(input, init);
}

/** Forward a fetch record to the configured ledger hook, if any. */
export function recordFetch(record: FetchRecord): void {
  hooks.recordFetch?.(record);
}

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
    const load = async (): Promise<CachedResponse> => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await httpFetch(url, { signal: ac.signal, headers });
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (!r.ok) {
          recordFetch({ url, headers, cacheStatus, responseStatus: r.status, payload: bytes,
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
    };
    const cached = hooks.cache
      ? await hooks.cache<CachedResponse>(kind, url, load, { onStatus: (status) => { cacheStatus = status; } })
      : await load();
    const bytes = new Uint8Array(Buffer.from(cached.payloadBase64, "base64"));
    recordFetch({ url, headers, cacheStatus, responseStatus: cached.status, payload: bytes, providerReleaseId: cached.releaseId });
    return bytes;
  } catch (error) {
    // HTTP errors with response bytes were recorded above. Transport failures
    // have no response payload but are still evidence for this attempt.
    if (!(error instanceof Error && /\bfor https?:\/\//.test(error.message))) {
      recordFetch({ url, headers, cacheStatus, error });
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
