// `csvb backup --source api` (issue 1436): fill a backup repo from the public archive routes, for anyone without
// read replica credentials. It reads only `GET /api/public/analytics/archive/backups` (the sealed backups, paged by
// `nextCursor`, oldest first) and `GET /api/public/analytics/archive/<path>` (a backup's record, then every file it
// lists). It writes files only and never runs git.
//
//   * The local copy must be a prefix of the served list. A local backup id the list lacks stops the run before any
//     body is fetched.
//   * Each file is verified before it is kept (gzip size against `bytes_gz` when the record carries it, inflated size,
//     inflated SHA-256 and row count). A backup is assembled in `<repo>/.api-fill` and renamed to `csv/<id>` only after
//     every file verifies, so no partial backup directory ever exists under `csv/`. The record is kept byte for byte.
//   * Pacing: one request in flight, starts at least 1 s apart, and within the public token and byte budgets of
//     `@robotmoney/contract` in any minute. 429 and 503 wait their Retry-After; a network error or another 5xx waits a
//     full-jitter backoff of 1 to 60 s; any other 4xx fails at once. A request is retried at most 5 times.
//   * Every request, retries included, counts toward `maxRequests`. The run stops before the request that would pass
//     it, keeping every complete backup (exit 3).
//
// The budgets are read from the contract package beside this one. The scheduled backup image copies only
// packages/csvb and packages/analyst-sdk, so cli.ts loads this module only for `--source api`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  PUBLIC_ANALYTICS_BYTES_PER_MINUTE,
  PUBLIC_ANALYTICS_HEAVY_COST,
  PUBLIC_ANALYTICS_LIST_COST,
  PUBLIC_ANALYTICS_TOKENS_PER_MINUTE,
} from "../../../contract/src/public-analytics.js";
import pkg from "../package.json" with { type: "json" };
import { BACKUP_ID_RE, CSV_DIR } from "./model.ts";
import { frontendCheckoutAround } from "./repo.ts";

export const USER_AGENT = `csvb/${(pkg as { version: string }).version}`;
export const DEFAULT_API = "https://robotmoney.network";
export const DEFAULT_MAX_REQUESTS = 500;
/** Retries of one request; the sixth failure fails the run. */
export const MAX_RETRIES = 5;
export const MIN_SPACING_MS = 1000;
const MINUTE_MS = 60_000;
/** Client-side margin on the server's sliding minute, so a request's later arrival never lands inside it. */
const WINDOW_MS = MINUTE_MS + 1000;
/** Largest inflated file accepted (a part is at most 90 MB, `--part-mb`); bounds memory against a hostile record. */
const MAX_RAW_BYTES = 100 * 1024 * 1024;
const ARCHIVE = "/api/public/analytics/archive/";
/** The temporary directory a backup is assembled in, inside the repo. */
export const TMP_DIR = ".api-fill";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiFillOptions {
  repo: string;
  /** Base URL of the site, e.g. https://robotmoney.network. */
  api?: string;
  maxRequests?: number;
  fetch?: Fetch;
  /** Milliseconds; a fake clock in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Aborted on SIGINT or SIGTERM. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface ApiFillResult {
  /** Backups added by this run, oldest first. */
  added: string[];
  /** "capped": the request cap stopped the run with `remaining` backups still to fetch (null: the list was not read). */
  status: "complete" | "capped";
  remaining: number | null;
}

/** The run stopped before a request that would pass `--max-requests`. */
class CapReached extends Error {}
class Interrupted extends Error {}
/** A refusal no retry can fix (a 4xx other than 429). */
class Refused extends Error {}

interface Charge {
  at: number;
  tokens: number;
  bytes: number;
}

/** Request pacing: spacing between starts and the contract's per-minute token and byte budgets. */
export class Pacer {
  private log: Charge[] = [];
  constructor(
    private now: () => number,
    private sleep: (ms: number) => Promise<void>,
    private tokensPerMinute = PUBLIC_ANALYTICS_TOKENS_PER_MINUTE,
    private bytesPerMinute = PUBLIC_ANALYTICS_BYTES_PER_MINUTE,
  ) {}

  /** Wait until a request of `tokens` and `bytes` (known in advance for an archive) may start; record its start. */
  async before(tokens: number, bytes: number, aborted: () => boolean): Promise<Charge> {
    for (;;) {
      if (aborted()) throw new Interrupted("interrupted");
      const now = this.now();
      this.log = this.log.filter((c) => c.at > now - WINDOW_MS);
      let wait = 0;
      const last = this.log[this.log.length - 1];
      if (last) wait = Math.max(wait, last.at + MIN_SPACING_MS - now);
      wait = Math.max(wait, this.waitFor((c) => c.tokens, tokens, this.tokensPerMinute, now));
      // An archive larger than the whole budget is still admitted alone (the server admits while any budget is left).
      if (this.log.some((c) => c.bytes > 0)) wait = Math.max(wait, this.waitFor((c) => c.bytes, bytes, this.bytesPerMinute, now));
      if (wait <= 0) {
        const c = { at: now, tokens, bytes };
        this.log.push(c);
        return c;
      }
      await this.sleep(wait);
    }
  }

  /** Milliseconds until the window's `pick` total plus `add` fits `cap`. */
  private waitFor(pick: (c: Charge) => number, add: number, cap: number, now: number): number {
    let total = this.log.reduce((n, c) => n + pick(c), 0);
    if (total + add <= cap) return 0;
    for (const c of this.log) {
      total -= pick(c);
      if (total + add <= cap) return c.at + WINDOW_MS - now;
    }
    return 0;
  }
}

interface FileEntry {
  path: string;
  rows: number;
  bytes_raw: number;
  sha256_raw: string;
  bytes_gz?: number;
}

/** Inflated bytes, then rows (CSV records after the header; a quoted newline is not a record end). */
function countRows(raw: Uint8Array): number {
  let lines = 0;
  let inQ = false;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (b === 0x22) inQ = !inQ;
    else if (b === 0x0a && !inQ) lines += 1;
  }
  return Math.max(0, lines - 1);
}

/** Why a served file does not match its record entry, or null when it does. */
export function checkFile(f: FileEntry, gz: Uint8Array): string | null {
  if (f.bytes_gz !== undefined && gz.length !== f.bytes_gz) return `${f.path}: ${gz.length} gzip bytes, record says ${f.bytes_gz}`;
  let raw: Uint8Array;
  try {
    raw = gunzipSync(gz, { maxOutputLength: f.bytes_raw + 1 });
  } catch (e) {
    return `${f.path}: does not inflate within its bytes_raw (${(e as Error).message})`;
  }
  if (raw.length !== f.bytes_raw) return `${f.path}: ${raw.length} inflated bytes, record says ${f.bytes_raw}`;
  if (createHash("sha256").update(raw).digest("hex") !== f.sha256_raw) return `${f.path}: inflated SHA-256 differs from the record`;
  const rows = countRows(raw);
  if (rows !== f.rows) return `${f.path}: ${rows} rows, record says ${f.rows}`;
  return null;
}

/** Every file a record lists, each checked to be a plain file of that backup. */
function filesOf(id: string, rec: unknown): FileEntry[] {
  const r = rec as { format?: unknown; backup?: unknown; source?: unknown; consistency?: unknown; append_only?: Record<string, { files?: unknown[] }>; revisions?: Record<string, { file?: unknown }> };
  if (r.format !== 1 || r.backup !== id) throw new Error(`csv/${id}/backup.json: not the format 1 record of backup ${id}`);
  if (r.source !== "api" || r.consistency !== "paged") throw new Error(`csv/${id}/backup.json: not an API record (source "api", consistency "paged")`);
  const all = [...Object.values(r.append_only ?? {}).flatMap((t) => t.files ?? []), ...Object.values(r.revisions ?? {}).flatMap((t) => (t.file ? [t.file] : []))];
  const safe = new RegExp(`^csv/${id}/(data|revisions)/[A-Za-z0-9_][A-Za-z0-9._-]*\\.csv\\.gz$`);
  return all.map((x) => {
    const f = x as FileEntry;
    if (typeof f.path !== "string" || !safe.test(f.path)) throw new Error(`csv/${id}/backup.json: bad path ${JSON.stringify(f.path)}`);
    for (const k of ["rows", "bytes_raw"] as const) {
      if (!Number.isSafeInteger(f[k]) || f[k] < 0) throw new Error(`${f.path}: bad ${k} ${JSON.stringify(f[k])}`);
    }
    if (f.bytes_gz !== undefined && (!Number.isSafeInteger(f.bytes_gz) || f.bytes_gz < 0)) throw new Error(`${f.path}: bad bytes_gz ${JSON.stringify(f.bytes_gz)}`);
    if (f.bytes_raw > MAX_RAW_BYTES) throw new Error(`${f.path}: bytes_raw ${f.bytes_raw} is over ${MAX_RAW_BYTES}`);
    if (typeof f.sha256_raw !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256_raw)) throw new Error(`${f.path}: bad sha256_raw`);
    return f;
  });
}

/** Seconds of a Retry-After header (delta seconds or an HTTP date), as milliseconds; null when absent or unreadable. */
function retryAfterMs(h: string | null, now: number): number | null {
  if (h === null) return null;
  if (/^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/** Backup ids under `<repo>/csv/`, oldest first. */
function localIds(repo: string): string[] {
  const d = join(repo, CSV_DIR);
  return existsSync(d) ? readdirSync(d).filter((n) => BACKUP_ID_RE.test(n)).sort() : [];
}

export async function apiFill(o: ApiFillOptions): Promise<ApiFillResult> {
  const repo = o.repo;
  const checkout = frontendCheckoutAround(repo);
  if (checkout) throw new Error(`refusing to write backups into ${repo}: it is inside the robotmoney-frontend checkout at ${checkout}; name a separate data checkout with --repo`);
  const base = (o.api ?? DEFAULT_API).replace(/\/+$/, "");
  const maxRequests = o.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? (() => Date.now());
  const signal = o.signal;
  const aborted = () => signal?.aborted ?? false;
  const sleep =
    o.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done);
      }));
  const random = o.random ?? Math.random;
  const log = o.log ?? ((l: string) => console.log(l));
  const pacer = new Pacer(now, sleep);
  let sent = 0;

  /** GET one archive route, with pacing, retries and the cap. `check` refuses a body (counted as a failure). */
  async function get(rel: string, tokens: number, bytes: number, check?: (body: Uint8Array) => string | null): Promise<Uint8Array> {
    let failures = 0;
    for (;;) {
      if (aborted()) throw new Interrupted("interrupted");
      if (sent >= maxRequests) throw new CapReached();
      const charge = await pacer.before(tokens, bytes, aborted);
      sent += 1;
      let why: string;
      let wait = 0;
      const backoff = () => {
        const cap = Math.min(60_000, 2000 * 2 ** failures); // 2, 4, 8, 16, 32 s caps; never under 1 s
        return 1000 + random() * (cap - 1000);
      };
      try {
        const res = await doFetch(`${base}${ARCHIVE}${rel}`, { headers: { "User-Agent": USER_AGENT }, signal });
        if (res.status === 200) {
          const body = new Uint8Array(await res.arrayBuffer());
          if (bytes === 0) charge.bytes = body.length; // a list or record is charged as sent
          const bad = check?.(body) ?? null;
          if (bad === null) return body;
          why = bad;
        } else if (res.status === 429 || res.status === 503) {
          why = `HTTP ${res.status}`;
          wait = retryAfterMs(res.headers.get("retry-after"), now()) ?? backoff();
        } else if (res.status >= 500) {
          why = `HTTP ${res.status}`;
          wait = backoff();
        } else {
          throw new Refused(`GET ${ARCHIVE}${rel}: HTTP ${res.status}`);
        }
      } catch (e) {
        if (aborted()) throw new Interrupted("interrupted");
        if (e instanceof Refused) throw e;
        why = `network error (${(e as Error).message})`;
        wait = backoff();
      }
      failures += 1;
      if (failures > MAX_RETRIES) throw new Error(`GET ${ARCHIVE}${rel}: failed ${failures} times, last: ${why}`);
      log(`GET ${ARCHIVE}${rel}: ${why}; retry ${failures} of ${MAX_RETRIES}${wait > 0 ? ` in ${Math.ceil(wait / 1000)} s` : ""}`);
      if (wait > 0) await sleep(wait);
    }
  }

  const tmp = join(repo, TMP_DIR);
  rmSync(tmp, { recursive: true, force: true }); // left by a killed run
  const added: string[] = [];
  let todo: string[] | null = null;
  try {
    // The served list, oldest first.
    const served: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = `backups?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = JSON.parse(new TextDecoder().decode(await get(q, PUBLIC_ANALYTICS_LIST_COST, 0))) as { backups?: { backup?: unknown }[]; nextCursor?: unknown };
      for (const b of page.backups ?? []) {
        if (typeof b.backup !== "string" || !BACKUP_ID_RE.test(b.backup)) throw new Error(`the backups list names a bad backup id ${JSON.stringify(b.backup)}`);
        if (served.length && b.backup <= served[served.length - 1]!) throw new Error(`the backups list is not in order at ${b.backup}`);
        served.push(b.backup);
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor !== null);

    // The local copy must be a prefix of it.
    const local = localIds(repo);
    for (const id of local) if (!served.includes(id)) throw new Error(`the local copy holds backup ${id}, which the archive does not serve; nothing was fetched`);
    for (const [i, id] of local.entries()) {
      if (served[i] !== id) throw new Error(`the local copy is not a prefix of the served backups: it lacks ${served[i]} before ${id}; nothing was fetched`);
    }
    todo = served.slice(local.length);
    log(`${served.length} backup(s) served, ${local.length} held, ${todo.length} to fetch`);

    for (const id of todo) {
      const recRel = `csv/${id}/backup.json`;
      let files: FileEntry[] = [];
      const recBytes = await get(recRel, PUBLIC_ANALYTICS_LIST_COST, 0, (b) => {
        try {
          files = filesOf(id, JSON.parse(new TextDecoder().decode(b)));
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      });
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(join(tmp, id), { recursive: true });
      for (const f of files) {
        const gz = await get(f.path, PUBLIC_ANALYTICS_HEAVY_COST, f.bytes_raw, (b) => checkFile(f, b));
        const to = join(tmp, f.path.slice(`${CSV_DIR}/`.length));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, gz);
      }
      writeFileSync(join(tmp, id, "backup.json"), recBytes);
      mkdirSync(join(repo, CSV_DIR), { recursive: true });
      renameSync(join(tmp, id), join(repo, CSV_DIR, id));
      added.push(id);
      log(`added backup ${id} (${files.length} file(s))`);
    }
    return { added, status: "complete", remaining: 0 };
  } catch (e) {
    if (e instanceof CapReached) {
      const remaining = todo === null ? null : todo.length - added.length;
      log(`stopped at the request cap (${maxRequests}): ${added.length} backup(s) added, ${remaining ?? "an unknown number of"} backup(s) remain; run again to continue`);
      return { added, status: "capped", remaining };
    }
    throw e;
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // never a partial backup
  }
}
