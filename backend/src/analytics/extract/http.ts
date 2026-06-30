// Extract stage: the one HTTP primitive every source client shares. A hard
// timeout/abort means an unreachable or slow source fails fast so the caller can
// fall back to seeded for that series.

// Fetch JSON with a hard timeout so an unreachable/slow source falls back fast.
export async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}
