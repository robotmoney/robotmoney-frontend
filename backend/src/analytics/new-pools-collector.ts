// The new-pools collector (issue 1654). Runs in the analytics producer on its
// own fixed timer, separate from every analytics run: one poll every 60 s,
// measured from the start of the previous poll, and a tick that comes while a
// poll is still running is skipped. Armed only when the analytics source is
// live (producer/index.ts).
//
// WHY. The legacy NEW_TOKENS sweep (extract/geckoterminal.ts) stored a computed
// 24-hour count that was the feed's 10-page fetch cap, not a reading: the feed
// shows about 48 new pools a minute, and 10 pages of 20 hold about 4 minutes of
// them. This collector stores the source data instead, every pool once, and
// the analyst SDK counts unique pools per gap-free UTC day
// (packages/analyst-sdk/src/transform/new-pools.ts).
//
// ONE POLL. Read GET /networks/new_pools?page=N from page 1 upward, and stop at
// the first of: a page whose oldest pool was created at or before the previous
// stored poll's newest pool (the overlap), page 10 (the feed's hard limit), or
// an empty page. Every request goes to the keyless host with no key header
// (new_pools is not in PRO_CALLS: about 5,000 requests a day must never spend
// paid credits), paced through serialized(fn, "free") at least 6 s apart, and a
// 429 or 5xx is retried with throttleWaitMs (Retry-After first, then backoff).
// A poll has a 55 s budget so polls never stack; when the budget ends before
// the overlap, the poll stores the pages it read and its oldest pool sets the
// coverage check. A record without a parseable pool_created_at is refused, not
// stored, and counted in the poll's log line.
//
// WHY 60 s. At 48 pools a minute a 60 s poll needs about 3 pages to reach the
// previous poll: 4 times headroom inside 10 pages. 3 to 4 requests at 6 s
// spacing take about 24 s, inside the 55 s budget and the 10-a-minute pace.
//
// The store (store/new-pools-store.ts, through the analytics REST boundary)
// marks a coverage gap when a poll does not overlap the previous stored poll;
// this module logs it: `[new-pools] coverage gap <from> to <to>`.
import { randomUUID } from "node:crypto";
import { geckoUrl } from "../chain/gecko-endpoint.ts";
import { serialized } from "../chain/gecko-rate-limit.ts";
import { throttleWaitMs } from "./extract/geckoterminal.ts";
import { UA } from "./extract/http.ts";
import { payloadChecksum, redactRequestIdentity, type SourceAcquisitionEvidence, type SourceFetchEvidence } from "./source-ledger.ts";
import {
  NEW_POOLS_PARSER_VERSION,
  NEW_POOLS_PROVIDER,
  type AnalyticsPersistence,
  type NewPoolPollResult,
  type NewPoolPollSubmission,
} from "./persistence.ts";
import { NEW_POOL_RECORDS_STORAGE_KEY } from "./extras.ts";
import { newPoolDailyCounts } from "../../../packages/analyst-sdk/src/transform/new-pools.ts";
import { captureSourceAcquisition, type AcquisitionSink } from "./source-ledger.ts";

export const NEW_POOLS_INTERVAL_MS = 60_000;
export const NEW_POOLS_POLL_BUDGET_MS = 55_000;
export const NEW_POOLS_MAX_PAGES = 10;
const TRANSIENT = (status: number) => status === 429 || status >= 500;
const MAX_ATTEMPTS_PER_PAGE = 5;
const REQUEST_TIMEOUT_MS = 15_000;

type Logger = { log?: (m: string) => void; warn?: (m: string) => void };

export interface PollNewPoolsDeps {
  persistence: Pick<AnalyticsPersistence, "saveNewPoolPoll" | "loadNewPoolHead">;
  logger?: Logger;
  /** The clock the 55 s budget is measured on. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How each request is paced. Default: serialized(fn, "free"), the keyless 10-a-minute pace. */
  pace?: <T>(fn: () => Promise<T>) => Promise<T>;
  budgetMs?: number;
}

interface ParsedPool {
  id: string;
  network: string;
  createdAt: string;
  ms: number;
}

/** One feed entry to a pool record, or null when it has no id or no parseable pool_created_at. */
export function parseNewPool(entry: unknown): ParsedPool | null {
  const e = entry as { id?: unknown; attributes?: { pool_created_at?: unknown }; relationships?: { network?: { data?: { id?: unknown } } } } | null;
  const id = typeof e?.id === "string" && e.id ? e.id : null;
  const raw = e?.attributes?.pool_created_at;
  const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (id === null || !Number.isFinite(ms)) return null;
  const net = e?.relationships?.network?.data?.id;
  const network = typeof net === "string" && net ? net : id.includes("_") ? id.slice(0, id.indexOf("_")) : "unknown";
  return { id, network, createdAt: new Date(ms).toISOString(), ms };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One poll: read the feed down to the previous stored poll, store what it read,
 * and log the outcome. Returns the store's answer.
 */
export async function pollNewPools(deps: PollNewPoolsDeps): Promise<NewPoolPollResult> {
  const { persistence } = deps;
  if (!persistence.saveNewPoolPoll || !persistence.loadNewPoolHead) throw new Error("[new-pools] the persistence has no new-pools store");
  const logger = deps.logger ?? console;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const pace = deps.pace ?? (<T>(fn: () => Promise<T>) => serialized(fn, "free"));
  const deadline = now() + (deps.budgetMs ?? NEW_POOLS_POLL_BUDGET_MS);

  const previousNewest = await persistence.loadNewPoolHead();
  const stopAt = previousNewest === null ? null : Date.parse(previousNewest.replace(/(\.\d{3})\d+/, "$1"));
  const fetches: SourceFetchEvidence[] = [];
  const pools = new Map<string, ParsedPool>();
  let refused = 0;
  let pagesRead = 0;
  let failure: string | null = null;
  let stopReason = "page limit";

  pages: for (let page = 1; page <= NEW_POOLS_MAX_PAGES; page++) {
    if (now() >= deadline) {
      stopReason = "poll budget";
      break;
    }
    const url = geckoUrl("new_pools", `/networks/new_pools?page=${page}`, { log: logger });
    const headers = { "user-agent": UA, accept: "application/json" };
    let body: unknown = null;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await pace(async () => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
          try {
            return await fetch(url, { headers, signal: ac.signal });
          } finally {
            clearTimeout(timer);
          }
        });
      } catch (err) {
        fetches.push(fetchEvidence(fetches.length + 1, url, headers, null, null, String((err as Error)?.message ?? err)));
        failure = `page ${page}: ${(err as Error)?.message ?? err}`;
        break pages;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      fetches.push(fetchEvidence(fetches.length + 1, url, headers, res.status, bytes, res.ok ? null : `${res.status} ${res.statusText}`));
      if (res.ok) {
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          failure = `page ${page}: the body is not JSON`;
          break pages;
        }
        break;
      }
      const wait = TRANSIENT(res.status) && attempt < MAX_ATTEMPTS_PER_PAGE ? throttleWaitMs(attempt, res.headers.get("retry-after"), deadline - now(), now()) : null;
      if (wait === null) {
        failure = `page ${page}: HTTP ${res.status} after ${attempt} attempt(s)`;
        break pages;
      }
      logger.warn?.(`[new-pools] page ${page}: HTTP ${res.status}; retrying in ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS_PER_PAGE})`);
      await sleep(wait);
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      failure = `page ${page}: missing data[]`;
      break;
    }
    if (data.length === 0) {
      stopReason = "empty page";
      break;
    }
    pagesRead = page;
    let oldestOnPage = Infinity;
    for (const entry of data) {
      const p = parseNewPool(entry);
      if (!p) {
        refused++;
        continue;
      }
      if (!pools.has(p.id)) pools.set(p.id, p);
      if (p.ms < oldestOnPage) oldestOnPage = p.ms;
    }
    if (stopAt !== null && oldestOnPage <= stopAt) {
      stopReason = "overlap";
      break;
    }
  }

  // A failure on page 1 is a failed poll: its acquisition is recorded with a
  // failed event and no poll row. A failure on a later page keeps what was read.
  const failedPoll = failure !== null && pagesRead === 0;
  if (failure !== null && !failedPoll) {
    logger.warn?.(`[new-pools] ${failure}; storing the ${pagesRead} page(s) read`);
    stopReason = "page failure";
  }
  const list = failedPoll ? [] : [...pools.values()];
  let oldest: ParsedPool | null = null;
  let newest: ParsedPool | null = null;
  for (const p of list) {
    if (!oldest || p.ms < oldest.ms) oldest = p;
    if (!newest || p.ms > newest.ms) newest = p;
  }
  const acquisition: SourceAcquisitionEvidence = {
    id: randomUUID(),
    provider: NEW_POOLS_PROVIDER,
    parserVersion: NEW_POOLS_PARSER_VERSION,
    cacheIdentity: "geckoterminal:new_pools",
    requestedByRunId: null,
    events: [{ type: "started", detail: null }, failedPoll ? { type: "failed", detail: failure!.slice(0, 2000) } : { type: "succeeded", detail: null }],
    fetches,
    values: [],
  };
  const poll: NewPoolPollSubmission = {
    acquisition,
    pools: list.map(({ id, network, createdAt }) => ({ id, network, createdAt })),
    oldestCreatedAt: oldest?.createdAt ?? null,
    newestCreatedAt: newest?.createdAt ?? null,
    pagesRead: failedPoll ? 0 : pagesRead,
  };
  const result = await persistence.saveNewPoolPoll(poll);
  if (failedPoll) {
    logger.warn?.(`[new-pools] poll failed: ${failure}; recorded the acquisition, no poll row`);
  } else {
    logger.log?.(`[new-pools] poll: pages=${pagesRead} seen=${result.poolsSeen} new=${result.poolsNew} refused=${refused} stop=${stopReason}`);
  }
  if (result.gap) logger.warn?.(`[new-pools] coverage gap ${result.gap.from} to ${result.gap.to}`);
  return result;
}

function fetchEvidence(sequence: number, url: string, headers: Record<string, string>, status: number | null, bytes: Uint8Array | null, error: string | null): SourceFetchEvidence {
  return {
    id: randomUUID(),
    sequence,
    requestIdentity: redactRequestIdentity(url, headers),
    cacheStatus: "disabled",
    responseStatus: status,
    responseChecksum: bytes ? payloadChecksum(bytes) : null,
    providerReleaseId: null,
    errorDetail: error,
  };
}

// ── the fixed timer ──────────────────────────────────────────────────────────

export interface NewPoolsTicker {
  /** One tick: starts a poll unless one is running. True when it started one. */
  tick(): boolean;
  /** Settles when the running poll (if any) settles. */
  idle(): Promise<void>;
  stop(): void;
}

/**
 * A fixed timer, one tick every `intervalMs` measured from the start of the
 * previous tick. A tick while a poll is still running starts no second poll.
 * A poll that throws is logged; the timer keeps running.
 */
export function newPoolsTicker(
  poll: () => Promise<unknown>,
  opts: { intervalMs?: number; logger?: Logger; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = {},
): NewPoolsTicker {
  const logger = opts.logger ?? console;
  let running: Promise<void> | null = null;
  const tick = (): boolean => {
    if (running) {
      logger.warn?.("[new-pools] tick skipped: the previous poll is still running");
      return false;
    }
    running = (async () => {
      try {
        await poll();
      } catch (err) {
        logger.warn?.(`[new-pools] poll threw: ${(err as Error)?.message ?? err}`);
      } finally {
        running = null;
      }
    })();
    return true;
  };
  const timer = (opts.setInterval ?? setInterval)(tick, opts.intervalMs ?? NEW_POOLS_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    tick,
    idle: () => running ?? Promise.resolve(),
    stop: () => (opts.clearInterval ?? clearInterval)(timer),
  };
}

// ── the regime run's NEW_TOKENS input (issue 1654) ───────────────────────────

/**
 * Count NEW_TOKENS from the stored pool records and record the daily series in
 * the source ledger under new_pool_records:NEW_TOKENS, so the run's committed
 * read and its frozen vintage hold it. The records are read at the database
 * clock (the store's knowledge-time cutoff); the count is the analyst SDK's
 * newPoolDailyCounts over them. A day already recorded with the same count
 * writes nothing (exact tolerance). Returns the series, or null when the
 * persistence has no pool store.
 */
export async function recordNewPoolDailyCounts(
  persistence: Pick<AnalyticsPersistence, "loadNewPoolInputs">,
  sink: AcquisitionSink,
  requestedByRunId: number | null,
): Promise<{ knowledgeTimeCutoff: string; points: { date: string; value: number }[] } | null> {
  if (!persistence.loadNewPoolInputs) return null;
  const inputs = await persistence.loadNewPoolInputs();
  const counts = newPoolDailyCounts({ dayTallies: inputs.dayTallies, polls: inputs.polls });
  // No gap-free day yet: nothing to record, and NEW_TOKENS has no reading.
  if (counts.length === 0) return { knowledgeTimeCutoff: inputs.knowledgeTimeCutoff, points: [] };
  const points = await captureSourceAcquisition(
    {
      provider: "new_pool_records",
      sourceKey: NEW_POOL_RECORDS_STORAGE_KEY,
      parserVersion: "new-pool-daily-counts:1",
      cacheIdentity: `new_pool_records@${inputs.knowledgeTimeCutoff}`,
      requestedByRunId,
    },
    sink,
    async () => counts,
  );
  return { knowledgeTimeCutoff: inputs.knowledgeTimeCutoff, points };
}
