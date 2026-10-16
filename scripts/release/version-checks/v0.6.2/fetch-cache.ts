// V08-fetch-cache (PR 1349): the HTTP fetch cache evicts, so it can no longer
// fill the host's disk.
//
// backend/src/analytics/extract/fetch-cache.ts keeps its entries in
// FETCH_CACHE_DIR (else <tmp>/robotmoney-fetch-cache, /tmp in a container) and,
// after every write, sweeps the directory back to HTTP_FETCH_CACHE_MAX_BYTES
// (default 256 MB). The check reads every running container of the instance
// whose environment carries the cache's knobs (compose hands them to the
// services that fetch), resolves its directory and bound exactly as the module
// does, and measures the directory with `du -sb` inside the container. A
// directory that does not exist is a cache that never wrote: in bound.
import { DEFAULT_FETCH_CACHE_MAX_BYTES, HTTP_FETCH_CACHE_MAX_BYTES_ENV, HTTP_FETCH_CACHE_TTL_ENV, resolveHttpFetchCacheMaxBytes } from "../../../../backend/src/analytics/extract/fetch-cache.ts";
import type { VersionCheck } from "../../version-check.ts";

/** The module's default directory inside a container (Bun's tmpdir() is /tmp there). */
export const DEFAULT_CONTAINER_CACHE_DIR = "/tmp/robotmoney-fetch-cache";

/** The only environment names this check reads. Their values are paths and sizes, never secrets. */
export const CACHE_ENV_NAMES = Object.freeze(["FETCH_CACHE_DIR", HTTP_FETCH_CACHE_MAX_BYTES_ENV, HTTP_FETCH_CACHE_TTL_ENV]);

export interface CacheEnv { readonly dir: string; readonly maxBytes: number | null; readonly maxRaw: string | null }

/** PURE. A container's cache directory and bound from its `Config.Env`, or null when it runs no fetch cache. */
export function cacheEnvOf(env: readonly string[]): CacheEnv | null {
  const pick: Record<string, string> = {};
  for (const line of env) {
    const i = line.indexOf("=");
    const name = i < 0 ? line : line.slice(0, i);
    if (CACHE_ENV_NAMES.includes(name)) pick[name] = i < 0 ? "" : line.slice(i + 1);
  }
  if (!(HTTP_FETCH_CACHE_TTL_ENV in pick) && !(HTTP_FETCH_CACHE_MAX_BYTES_ENV in pick) && !("FETCH_CACHE_DIR" in pick)) return null;
  let maxBytes: number | null;
  try { maxBytes = resolveHttpFetchCacheMaxBytes(pick); } catch { maxBytes = null; }
  return { dir: pick.FETCH_CACHE_DIR || DEFAULT_CONTAINER_CACHE_DIR, maxBytes, maxRaw: pick[HTTP_FETCH_CACHE_MAX_BYTES_ENV] ?? null };
}

/** PURE. `du -sb` output (or the word `absent`) as bytes, `absent`, or null when unreadable. */
export function parseDu(code: number, stdout: string): number | "absent" | null {
  if (code !== 0) return null;
  const t = stdout.trim();
  if (t === "absent") return "absent";
  const n = Number(t.split(/\s+/)[0]);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export interface CacheRow { readonly container: string; readonly dir: string; readonly maxBytes: number | null; readonly bytes: number | "absent" | null }

/** PURE. Every container whose cache is over its bound, unmeasurable or misconfigured. */
export function fetchCacheProblems(rows: readonly CacheRow[], containers: number): string[] {
  const out: string[] = [];
  if (containers === 0) out.push("no running container of the instance to read");
  for (const r of rows) {
    if (r.maxBytes === null) out.push(`${r.container}: ${HTTP_FETCH_CACHE_MAX_BYTES_ENV} is not a non-negative integer, so the cache has no bound`);
    if (r.bytes === null) out.push(`${r.container}: the size of ${r.dir} could not be read`);
    else if (r.bytes !== "absent" && r.maxBytes !== null && r.bytes > r.maxBytes) out.push(`${r.container}: ${r.dir} holds ${r.bytes} bytes, over its ${r.maxBytes}-byte bound`);
  }
  return out;
}

export default (async (ctx) => {
  const project = ctx.project();
  const names = ctx.docker(["ps", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  const rows: CacheRow[] = [];
  for (const container of names) {
    const inspect = ctx.docker(["inspect", "-f", "{{json .Config.Env}}", container]);
    if (inspect.code !== 0) {
      rows.push({ container, dir: "(unknown)", maxBytes: DEFAULT_FETCH_CACHE_MAX_BYTES, bytes: null });
      continue;
    }
    const env = cacheEnvOf(JSON.parse(inspect.stdout) as string[]);
    if (env === null) continue;
    const du = ctx.docker(["exec", container, "sh", "-c", 'if [ -d "$1" ]; then du -sb "$1"; else echo absent; fi', "sh", env.dir]);
    rows.push({ container, dir: env.dir, maxBytes: env.maxBytes, bytes: parseDu(du.code, du.stdout) });
  }
  return { found: { project, containers: names.length, caches: rows }, problems: fetchCacheProblems(rows, names.length) };
}) satisfies VersionCheck;
