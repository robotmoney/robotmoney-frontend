// Q34b-archive-records/C22a-archive-records (PR 1524 part "archive record timeout", issue 1508; PR
// 1526, D80): every public archive request answers inside the 5 s api budget, and the sealed
// backups' records build and answer 200 with format 1.
//
// v0.7.0's production cutover failed C23-archive-routes: every record answered 503 because the
// members chain step ran past publicRead's statement timeout (issue 1508). Stage had passed Q35
// because nothing else loaded its database. This check runs after Q34a-analytics-load, so the
// stage database has just carried a scheduled analytics run, and before Q35-archive-routes/C23,
// so the records those steps read are already built when they ask.
//
//   1. The backups listing. Its first request is timed on its own, with no retry: after a restart
//      the api's first archive request also runs the junction check (public-archive-store.ts
//      loadRowsFollowJunction, a 4 s bounded read over every row past the D80 junction), so a
//      listing that is not 200, or is over budget, the first time is the risk PR 1526 left open.
//      The rest of the listing is read with 429/503 waited out.
//   2. The records of the first backup, the legacy junction (2026-10-28T180400Z, when listed) and
//      the newest backup. A record not built yet answers 503 with Retry-After within the route's
//      own 4 s wait; the check waits it out and asks again, up to RECORD_WAIT_MS per record. Each
//      200 must carry format 1 and an X-Content-SHA256 equal to the sha256 of the bytes.
// Every request is timed; one at or over BUDGET_MS is a problem. Reads only: GETs of the public
// archive routes.
import { LEGACY_JUNCTION } from "../../../../packages/analyst-sdk/src/archive/format1-legacy.ts";
import { PUBLIC_API, retryAfterMs, sha256Hex } from "../../public-analytics-read.ts";
import type { VersionCheck } from "../../version-check.ts";

/** The api's slow-request line and the owner's budget for any api request (the request limit stays 10 s). */
export const BUDGET_MS = 5_000;
export const RECORD_WAIT_MS = 20 * 60_000;
const LIST_TRIES = 6;

export interface Answer {
  readonly status: number;
  readonly ms: number;
  readonly retryAfter: string | null;
  readonly xsha: string | null;
  readonly bytes: Uint8Array;
}

export interface Attempt {
  readonly path: string;
  readonly status: number;
  readonly ms: number;
}

export interface RecordResult {
  readonly backup: string;
  readonly attempts: readonly Attempt[];
  /** Set when the record answered 200: its format, whether X-Content-SHA256 is the bytes' hash, and the wait from the first request. */
  readonly built?: { format: unknown; shaMatches: boolean; xsha: string | null; bytes: number; waitedMs: number };
  /** Set when the record answered a status the route never sends for a record it serves or builds. */
  readonly refused?: number;
}

export interface ArchiveReport {
  readonly firstListing: Attempt | null;
  readonly listingStatus: number;
  readonly backups: readonly string[];
  readonly junctionListed: boolean;
  readonly records: readonly RecordResult[];
}

/** PURE. The backups whose records the check builds: the first, the junction when listed, the newest. */
export function chosenBackups(backups: readonly string[]): string[] {
  const out = [backups[0], backups.includes(LEGACY_JUNCTION.id) ? LEGACY_JUNCTION.id : undefined, backups.at(-1)];
  return [...new Set(out.filter((b): b is string => b !== undefined))];
}

/** PURE. Every way the archive did not answer within budget or a record did not build; empty when it did. */
export function archiveProblems(r: ArchiveReport): string[] {
  const out: string[] = [];
  if (r.firstListing && r.firstListing.status !== 200) {
    out.push(`the first ${PUBLIC_API}/archive/backups request answered ${r.firstListing.status} in ${Math.round(r.firstListing.ms)} ms: the junction check (public-archive-store.ts loadRowsFollowJunction) did not finish inside its bound`);
  }
  if (r.listingStatus !== 200) out.push(`${PUBLIC_API}/archive/backups never answered 200 (last ${r.listingStatus})`);
  else if (r.backups.length === 0) out.push(`${PUBLIC_API}/archive/backups lists no sealed backup`);
  else if (!r.junctionListed) out.push(`the legacy junction backup ${LEGACY_JUNCTION.id} is not listed (D80): a production-shaped target serves it between the day cuts around it`);
  const all = [...(r.firstListing ? [r.firstListing] : []), ...r.records.flatMap((x) => x.attempts)];
  for (const a of all) if (a.ms >= BUDGET_MS) out.push(`GET ${a.path} answered ${a.status} in ${Math.round(a.ms)} ms, at or over the ${BUDGET_MS} ms budget`);
  for (const rec of r.records) {
    const at = `the record of backup ${rec.backup}`;
    if (rec.refused !== undefined) out.push(`${at} answered ${rec.refused}, neither 200 nor a 503 while it builds`);
    else if (!rec.built) out.push(`${at} did not answer 200 within ${RECORD_WAIT_MS / 60_000} minutes (${rec.attempts.length} request(s), last ${rec.attempts.at(-1)?.status ?? "none"})`);
    else {
      if (rec.built.format !== 1) out.push(`${at} carries format ${JSON.stringify(rec.built.format)}, not 1`);
      if (!rec.built.shaMatches) out.push(`${at}: X-Content-SHA256 ${rec.built.xsha} is not the sha256 of the bytes it sent`);
    }
  }
  return out;
}

export interface ArchiveDeps {
  get(path: string): Promise<Answer>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(m: string): void;
  recordWaitMs?: number;
}

export async function archiveRecords(deps: ArchiveDeps): Promise<ArchiveReport> {
  const first = await deps.get(`${PUBLIC_API}/archive/backups?limit=1000`);
  const firstListing: Attempt = { path: `${PUBLIC_API}/archive/backups?limit=1000`, status: first.status, ms: first.ms };
  deps.log(`[archive-records] first listing: ${first.status} in ${Math.round(first.ms)} ms`);
  const backups: string[] = [];
  let cursor: string | null = null;
  let page: Answer = first;
  let listingStatus = first.status;
  for (let n = 0; n < 50; n++) {
    const path = `${PUBLIC_API}/archive/backups?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    if (n > 0 || page.status !== 200) page = await deps.get(path);
    for (let i = 1; i < LIST_TRIES && (page.status === 429 || page.status === 503); i++) {
      await deps.sleep(retryAfterMs(page.retryAfter));
      page = await deps.get(path);
    }
    listingStatus = page.status;
    if (page.status !== 200) break;
    const body = JSON.parse(new TextDecoder().decode(page.bytes)) as { backups?: { backup: string }[]; nextCursor?: string | null };
    backups.push(...(body.backups ?? []).map((b) => b.backup));
    cursor = body.nextCursor ?? null;
    if (cursor === null) break;
  }
  const records: RecordResult[] = [];
  for (const backup of listingStatus === 200 ? chosenBackups(backups) : []) {
    const path = `${PUBLIC_API}/archive/csv/${backup}/backup.json`;
    const attempts: Attempt[] = [];
    const t0 = deps.now();
    let result: RecordResult | undefined;
    while (result === undefined) {
      const a = await deps.get(path);
      attempts.push({ path, status: a.status, ms: a.ms });
      if (a.status === 200) {
        let format: unknown;
        try { format = (JSON.parse(new TextDecoder().decode(a.bytes)) as { format?: unknown }).format; } catch { format = "not JSON"; }
        const sha = sha256Hex(a.bytes);
        result = { backup, attempts, built: { format, shaMatches: a.xsha === sha, xsha: a.xsha, bytes: a.bytes.length, waitedMs: deps.now() - t0 } };
      } else if (a.status !== 503 && a.status !== 429) {
        result = { backup, attempts, refused: a.status };
      } else if (deps.now() - t0 >= (deps.recordWaitMs ?? RECORD_WAIT_MS)) {
        result = { backup, attempts };
      } else {
        await deps.sleep(retryAfterMs(a.retryAfter));
      }
    }
    deps.log(`[archive-records] ${backup}: ${result.built ? `200 after ${Math.round(result.built.waitedMs / 1000)} s` : `not built (${attempts.at(-1)?.status})`}, ${attempts.length} request(s)`);
    records.push(result);
  }
  return { firstListing, listingStatus, backups, junctionListed: backups.includes(LEGACY_JUNCTION.id), records };
}

/** The real network: one GET, timed to the end of its body, never retried here. */
export function realGet(origin: string): ArchiveDeps["get"] {
  const base = origin.replace(/\/+$/, "");
  return async (path) => {
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(60_000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, ms: performance.now() - t0, retryAfter: res.headers.get("retry-after"), xsha: res.headers.get("x-content-sha256"), bytes };
    } catch {
      // A request that never answered: status 0, timed as it ran.
      return { status: 0, ms: performance.now() - t0, retryAfter: null, xsha: null, bytes: new Uint8Array() };
    }
  };
}

export default (async (ctx) => {
  const report = await archiveRecords({
    get: realGet(ctx.origin),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
  });
  const { backups, ...rest } = report;
  return { found: { ...rest, backupCount: backups.length, firstBackup: backups[0] ?? null, newestBackup: backups.at(-1) ?? null }, problems: archiveProblems(report) };
}) satisfies VersionCheck;
