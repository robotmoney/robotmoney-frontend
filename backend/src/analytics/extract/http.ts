// Extract stage: the HTTP primitives every source client shares. A hard
// timeout/abort means an unreachable or slow source fails fast so the caller can
// fall back to seeded / persisted for that series.

const UA = "robotmoney-regime/1.0";

// Fetch JSON with a hard timeout so an unreachable/slow source falls back fast.
export async function fetchJson(
  url: string,
  timeoutMs = 8000,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": UA, accept: "application/json", ...headers },
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Fetch text (CSV / HTML) with the same hard-timeout discipline.
export async function fetchText(
  url: string,
  timeoutMs = 8000,
  headers: Record<string, string> = {},
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": UA, accept: "text/csv,text/plain,*/*", ...headers },
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}
