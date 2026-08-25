// Independent analytics/research producer (issue #361 Phase 4).
// This process has no DATABASE_URL and imports no queue/SQL module. It computes
// on its own side and submits through the authenticated analytics REST boundary.
import parser from "cron-parser";
import { ROUTES } from "@robotmoney/contract";
import { runAnalytics, resolveAnalyticsSource, RESEARCH_TOOL_GROUP, RESEARCH_SIGNAL_TELEMETRY_KEYS } from "../analytics/index.ts";
import { analyticsApiClient, resolveAnalyticsApiConfig, type AnalyticsApiConfig } from "../analytics/api-client.ts";
import { bootstrapEdgarSeed } from "../analytics/edgar-seed-loader.ts";
import type { AnalyticsPersistence } from "../analytics/persistence.ts";
import type { AnalyticsDataSource } from "../analytics/access/data-source.ts";
import { INDICATORS } from "../analytics/analyze/indicators.ts";
import type { RawIndicatorHistory } from "../analytics/types.ts";
import { writeHeartbeat } from "../ops/heartbeat.ts";

export type ProducerKind = "regime" | "research";

type Runner = (asof: string, tool: string, source: AnalyticsDataSource, persistence: AnalyticsPersistence) => Promise<Record<string, unknown>>;

export function requireProducerApiConfig(
  env: Record<string, string | undefined> = process.env,
): AnalyticsApiConfig {
  const cfg = resolveAnalyticsApiConfig(env);
  if (!cfg.token) {
    throw new Error(
      "analytics producer requires ANALYTICS_TOKEN or a non-empty ANALYTICS_TOKEN_FILE before startup",
    );
  }
  return cfg;
}

export async function runProducerOnce(
  kind: ProducerKind,
  asof: string,
  deps: { runner?: Runner; source?: AnalyticsDataSource; persistence?: AnalyticsPersistence } = {},
): Promise<Record<string, unknown>> {
  const persistence = deps.persistence ?? analyticsApiClient();
  const source = deps.source ?? resolveAnalyticsSource();
  const runner: Runner = deps.runner ?? ((date, tool, src, store) => runAnalytics(date, tool, src, store));
  if (kind === "regime") return runner(asof, "regime", source, persistence);
  // ONE invocation for both research signals (issue #509). They share a
  // single fetchResearchInputs call — and therefore a single live EDGAR
  // sweep. Looping the research tool ids here ran that sweep once PER TOOL: two
  // full ~200-request reconciliation crawls every full-sweep day, the first
  // of which was discarded entirely (only the late-cycle-signals branch
  // persists the fetched rows), and whose degrade never reached the
  // telemetry collector.
  return runner(asof, RESEARCH_TOOL_GROUP, source, persistence);
}

// ── Catch-up (issue #614 AC4) ────────────────────────────────────────────────
// "The producer has no catch-up at all — producer/index.ts:132-148 computes
// `next` from `new Date()`, fires, re-arms. Miss 22:30 and that day never
// runs." This repairs research_signals specifically: regime does NOT need
// this — analytics/index.ts rewrites the whole date axis from BACKFILL_START
// on every run, so regime_snapshots cannot have interior gaps by
// construction (issue #614's Scope). research_signals IS gap-prone (one row
// per (signal_key, date)) and replaying a past `asof` is deterministic
// (analyze/research-signals.ts), so this is the one series the producer
// itself must actively repair.
//
// This is also the mechanism that makes "a degraded EDGAR refresh is
// retry-later, not success" (analytics/index.ts's late-cycle-signals skip)
// actually true: a degraded day leaves NO research_signals row for
// late-cycle-signals that date (even though channel-divergence may have
// written fine), so it shows up here as missing and gets re-attempted on the
// next catch-up pass — without depending on worker/loop.ts's retry
// machinery, which this D25-retired execution path never runs through.
//
// Bounded lookback: each missed day re-runs a real, rate-limited EDGAR sweep,
// so this must never attempt an unbounded historical crawl. 14 days
// comfortably covers a downtime window (a weekend outage, a bad deploy) while
// staying cheap; a gap older than that is visible on GET /api/admin/gaps
// (AC3) for an operator to backfill deliberately via the CLI
// (`bun run src/producer/index.ts research <date>`).
const CATCHUP_WINDOW_DAYS = 14;

/** Pure: which of the last `windowDays` days (excluding today — the normal
 *  cron owns today) are missing at least one of the two research signals. */
export function computeMissingResearchDays(
  presentDates: { signalKey: string; date: string }[],
  now: Date,
  windowDays: number = CATCHUP_WINDOW_DAYS,
): string[] {
  const bySignal = new Map<string, Set<string>>();
  for (const k of RESEARCH_SIGNAL_TELEMETRY_KEYS) bySignal.set(k, new Set());
  for (const { signalKey, date } of presentDates) {
    bySignal.get(signalKey)?.add(date);
  }
  const missing: string[] = [];
  for (let i = windowDays; i >= 1; i--) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const complete = RESEARCH_SIGNAL_TELEMETRY_KEYS.every((k) => bySignal.get(k)!.has(d));
    if (!complete) missing.push(d);
  }
  return missing;
}

export interface ResearchCatchUpDeps {
  persistence?: AnalyticsPersistence;
  runner?: Runner;
  source?: AnalyticsDataSource;
  now?: () => Date;
}

/** Best-effort: a read or repair failure here must never take down the
 *  producer's boot or its normal daily tick (the same "never crash on an
 *  ops nice-to-have" rule src/ops/heartbeat.ts follows) — it is retried on
 *  the next catch-up pass regardless. Returns the days it attempted to
 *  repair (whether or not each individual repair actually succeeded). */
export async function catchUpMissedResearchDays(deps: ResearchCatchUpDeps = {}): Promise<string[]> {
  const persistence = deps.persistence ?? analyticsApiClient();
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - CATCHUP_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  let present: { signalKey: string; date: string }[];
  try {
    present = await persistence.loadResearchSignalDates(since);
  } catch (err) {
    console.error(`[analytics-producer] catch-up: could not read recent research-signal dates, skipping this pass: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  const missing = computeMissingResearchDays(present, now);
  for (const day of missing) {
    console.log(`[analytics-producer] catch-up: repairing missed research day ${day}`);
    try {
      await runProducerOnce("research", day, { runner: deps.runner, source: deps.source, persistence });
    } catch (err) {
      console.error(`[analytics-producer] catch-up for ${day} failed (will retry next pass): ${err instanceof Error ? err.message : err}`);
    }
  }
  return missing;
}

// ── Indicator catch-up (issue #646, closing #614 AC4's Class A bullet) ──────
// "a detected gap triggers a re-fetch that fills only missing keys" — never
// implemented for raw_indicator_history despite the criterion being ticked on
// the closed #614 (docs/technical/markets-asset-pricing-ingest.md §9's standing warning
// about exactly this pattern). raw_indicator_history is API-owned (#106): the
// shared worker where `ops.repair_gaps` runs holds no ANALYTICS_TOKEN by
// design (D25), so — same as Class B's research_signals self-heal above —
// this belongs in the independent producer, the one process that both
// computes indicator data and holds the analytics-provider credential.
//
// TARGETED, not a recompute: unlike Class B (a full re-run of one asof) this
// re-fetches the whole live registry once, then keeps ONLY the points whose
// date is an actual gap. seedRawHistory (floor-seed.ts::applyRawFloorSeed) is
// the gap-fill-only write — existing rows always win — so handing it a wider
// batch than the gap set would be harmless, but filtering here keeps the
// write's intent legible and matches AC4's literal wording ("fills only
// missing keys") rather than leaning on the store's idempotency to paper over
// a sloppier caller.
//
// Bounded lookback, same rationale as CATCHUP_WINDOW_DAYS: a live registry
// fetch (FRED/Yahoo/DefiLlama/blockchain.com/Coinmetrics/GeckoTerminal/
// Shiller) is comfortably cheap to repeat, but this must never become an
// unbounded historical crawl. A gap older than the window is still visible on
// GET /api/admin/gaps for an operator to close deliberately.
const INDICATOR_CATCHUP_WINDOW_DAYS = 14;

export interface IndicatorCatchUpDeps {
  persistence?: AnalyticsPersistence;
  source?: AnalyticsDataSource;
  now?: () => Date;
}

/** Best-effort, same contract as catchUpMissedResearchDays: never throws,
 *  retried on the next pass regardless of what failed. Returns the days it
 *  found missing (whether or not this pass actually filled each one) — a
 *  source with no historical backfill capability for a given date leaves that
 *  date unfilled and it is simply picked up again next pass. */
export async function catchUpMissedIndicatorDays(deps: IndicatorCatchUpDeps = {}): Promise<string[]> {
  const persistence = deps.persistence ?? analyticsApiClient();
  const source = deps.source ?? resolveAnalyticsSource();
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - INDICATOR_CATCHUP_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  let missing: string[];
  try {
    missing = await persistence.loadRawHistoryGapDates(since);
  } catch (err) {
    console.error(`[analytics-producer] indicator catch-up: could not read recent raw-history gap dates, skipping this pass: ${err instanceof Error ? err.message : err}`);
    return [];
  }
  // No fetch at all when there is nothing to fill — avoids double-fetching the
  // live registry against the daily regime cron, which already fetches it.
  if (missing.length === 0) return [];

  console.log(`[analytics-producer] indicator catch-up: ${missing.length} raw_indicator_history day(s) missing since ${since}, re-fetching the registry`);
  const missingSet = new Set(missing);
  let fetched: Record<string, { date: string; value: number }[]>;
  try {
    fetched = await source.fetchIndicators(INDICATORS, console);
  } catch (err) {
    console.error(`[analytics-producer] indicator catch-up: registry fetch failed (will retry next pass): ${err instanceof Error ? err.message : err}`);
    return missing;
  }

  const onlyMissing: RawIndicatorHistory = {};
  let matched = 0;
  for (const [id, pts] of Object.entries(fetched)) {
    const hits = pts.filter((p) => missingSet.has(p.date));
    if (hits.length > 0) {
      onlyMissing[id] = hits;
      matched += hits.length;
    }
  }
  if (matched === 0) {
    console.warn(`[analytics-producer] indicator catch-up: this fetch covered none of the ${missing.length} missing day(s) — source has no history that far back for them; will retry next pass`);
    return missing;
  }

  try {
    const result = await persistence.seedRawHistory(onlyMissing);
    console.log(`[analytics-producer] indicator catch-up: filled ${result.seededPoints} point(s) across ${result.indicators} indicator(s)`);
  } catch (err) {
    console.error(`[analytics-producer] indicator catch-up: seed write failed (will retry next pass): ${err instanceof Error ? err.message : err}`);
  }
  return missing;
}

async function waitForApi(cfg: AnalyticsApiConfig): Promise<void> {
  const base = cfg.baseUrl;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const healthy = await fetch(`${base}${ROUTES.health}`).then((r) => r.ok).catch(() => false);
    if (healthy) {
      const readiness = await fetch(`${base}${ROUTES.analytics.readiness}`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      }).catch(() => null);
      if (readiness?.ok) return;
      if (readiness?.status === 401 || readiness?.status === 403) {
        throw new Error(`analytics producer credential was rejected by ${base}`);
      }
    }
    await Bun.sleep(500);
  }
  throw new Error(`analytics producer could not reach ${base}/health within 120s`);
}

export interface ProducerCommandDeps {
  env?: Record<string, string | undefined>;
  waitUntilReady?: (cfg: AnalyticsApiConfig) => Promise<void>;
  bootstrapSeed?: (cfg: AnalyticsApiConfig) => Promise<unknown>;
  runner?: Runner;
  source?: AnalyticsDataSource;
  persistence?: AnalyticsPersistence;
}

/**
 * Execute one finite producer command. `seed` deliberately includes an
 * immediate producer-owned research refresh: a fresh stack must serve both
 * research signals without resurrecting a consumer-DB schedule or queue job.
 */
export async function runProducerCommand(
  command: "seed" | ProducerKind,
  asof: string,
  deps: ProducerCommandDeps = {},
): Promise<Record<string, unknown>> {
  const cfg = requireProducerApiConfig(deps.env);
  await (deps.waitUntilReady ?? waitForApi)(cfg);
  const persistence = deps.persistence ?? analyticsApiClient(cfg);
  if (command === "seed") {
    await (deps.bootstrapSeed ?? bootstrapEdgarSeed)(cfg);
    return runProducerOnce("research", asof, {
      runner: deps.runner,
      source: deps.source,
      persistence,
    });
  }
  return runProducerOnce(command, asof, {
    runner: deps.runner,
    source: deps.source,
    persistence,
  });
}

// What each armed cron currently is, as seen by the process itself. This is the
// producer's equivalent of the worker's drain-loop position: it is the only
// in-process fact that distinguishes "waiting for 22:30" from "the timer was
// lost" or "the 22:30 run has been stuck for six hours". Read by
// checkProducerProgress below.
export interface ScheduleState {
  /** Epoch ms the cron is next due (or was due, while `running`). */
  nextFireAt: number;
  running: boolean;
  /** Epoch ms the in-flight run started. Only meaningful while `running`. */
  runningSince: number;
  /** The pending timer, so tests can disarm a schedule they armed for real. */
  timer?: ReturnType<typeof setTimeout>;
}
const armedSchedules = new Map<ProducerKind, ScheduleState>();

/** Read-only view of what this process currently has armed. */
export function armedScheduleSnapshot(): ReadonlyMap<ProducerKind, ScheduleState> {
  return new Map(armedSchedules);
}

/** Test seam: cancel and forget every armed schedule. Without the clearTimeout
 *  a test that arms a real cron would leave a live timer holding the runner. */
export function resetProducerSchedules(): void {
  for (const state of armedSchedules.values()) if (state.timer) clearTimeout(state.timer);
  armedSchedules.clear();
}

function schedule(kind: ProducerKind, cron: string): void {
  const arm = () => {
    const next = parser.parseExpression(cron, { tz: "UTC", currentDate: new Date() }).next().toDate();
    const timer = setTimeout(async () => {
      armedSchedules.set(kind, { nextFireAt: next.getTime(), running: true, runningSince: Date.now() });
      try {
        // issue #614 AC4: "on boot/tick it repairs missed asof days". Boot is
        // covered by startProducerSchedules below; this covers TICK — every
        // daily research fire first re-checks the last CATCHUP_WINDOW_DAYS
        // for a backlog (a day this process was down for, or a day that
        // degraded and was correctly skipped rather than published) before
        // running today. Best-effort: catchUpMissedResearchDays never throws.
        if (kind === "research") await catchUpMissedResearchDays();
        // issue #646, closing #614 AC4's Class A bullet: same "on boot/tick"
        // shape, paired with the "regime" tick because that is the run that
        // owns fetchIndicators — the same registry fetch this catch-up
        // re-issues on a gap. Best-effort: catchUpMissedIndicatorDays never
        // throws.
        if (kind === "regime") await catchUpMissedIndicatorDays();
        await runProducerOnce(kind, next.toISOString().slice(0, 10));
      } catch (err) {
        console.error(`[analytics-producer] ${kind} failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        arm();
      }
    }, Math.max(0, next.getTime() - Date.now()));
    armedSchedules.set(kind, { nextFireAt: next.getTime(), running: false, runningSince: 0, timer });
  };
  arm();
}

export interface ProducerServeDeps {
  env?: Record<string, string | undefined>;
  waitUntilReady?: (cfg: AnalyticsApiConfig) => Promise<void>;
  scheduleKind?: (kind: ProducerKind, cron: string) => void;
  /** Test seam: override the boot-time catch-up call. Defaults to the real
   *  catchUpMissedResearchDays against the resolved API config. */
  catchUp?: (persistence: AnalyticsPersistence) => Promise<unknown>;
  /** Test seam: override the boot-time indicator catch-up call (issue #646).
   *  Defaults to the real catchUpMissedIndicatorDays against the resolved API
   *  config — same shape as `catchUp` above, one per class. */
  catchUpIndicators?: (persistence: AnalyticsPersistence) => Promise<unknown>;
}

/** Validate reachability + provider authorization before arming any cron.
 *  Returns the resolved config so serve() can hand it straight to the liveness
 *  loop rather than re-reading the token file. */
export async function startProducerSchedules(deps: ProducerServeDeps = {}): Promise<AnalyticsApiConfig> {
  const cfg = requireProducerApiConfig(deps.env);
  await (deps.waitUntilReady ?? waitForApi)(cfg);
  // issue #614 AC4 ("on boot/tick"): repair any research day missed while
  // this process was down BEFORE arming today's crons — a restarted producer
  // must not wait for the next scheduled tick to notice a gap it could close
  // right now. Best-effort: never blocks/fails the boot on a catch-up hiccup.
  const persistence = analyticsApiClient(cfg);
  await (deps.catchUp ?? ((p: AnalyticsPersistence) => catchUpMissedResearchDays({ persistence: p })))(persistence);
  // issue #646: the Class A counterpart, same "before arming today's crons"
  // reasoning — a restarted producer must not wait for the next regime tick
  // to notice an indicator gap it could close right now.
  await (deps.catchUpIndicators ?? ((p: AnalyticsPersistence) => catchUpMissedIndicatorDays({ persistence: p })))(persistence);
  const scheduleKind = deps.scheduleKind ?? schedule;
  scheduleKind("regime", deps.env?.PRODUCER_REGIME_CRON || process.env.PRODUCER_REGIME_CRON || "30 22 * * *");
  scheduleKind("research", deps.env?.PRODUCER_RESEARCH_CRON || process.env.PRODUCER_RESEARCH_CRON || "0 23 * * *");
  return cfg;
}

// ---------------------------------------------------------------------------
// Liveness (src/ops/heartbeat.ts)
//
// WHY THIS SERVICE NEEDS A DIFFERENT MECHANISM FROM THE WORKER LANES
// A lane has a drain loop, so "the loop completed a cycle" is a signal that
// falls out of the work itself. This process has no loop: it arms two cron
// timers that fire once a day and otherwise sits on an idle event loop. A
// heartbeat written by the WORK here would tick twice in twenty-four hours,
// which is not a liveness signal at any threshold worth having.
//
// So the producer reports on the two things that actually have to hold for it
// to do its job at 22:30, and re-establishes both on every tick:
//
//   1. BOTH crons are armed, and each is either waiting on a future fire time
//      or executing a run that has not overrun its budget. A producer whose
//      timer was lost, or whose nightly run wedged, fails here.
//   2. The analytics API answers. This process holds no DATABASE_URL — the REST
//      submission gate is the ONLY channel through which its work can become
//      durable, so a producer that cannot reach it cannot make progress by
//      definition.
//
// This is a loop, not a `setInterval`, for the same reason the worker's beat
// lives inside its drain loop: the failure mode is a blocked event loop, and a
// blocked event loop stops an awaited sleep exactly as it stops a cron timer.
// The check does real work (a live HTTP round trip to the dependency every
// submission flows through) rather than asserting its own existence.

const PRODUCER_WRITER = "analytics-producer";

/** Tolerance for a cron whose fire time has just passed but whose callback has
 *  not been entered yet — timer dispatch is not instantaneous. */
const FIRE_SLACK_MS = 60_000;

export interface ProducerProgress {
  ok: boolean;
  reason: string;
}

/**
 * Pure-ish verdict over the armed schedules. Exported for tests: the stall
 * cases below are the ones that must flip the container red, and they are
 * unreasonable to provoke through a real 22:30 cron.
 */
export function checkArmedSchedules(
  now: number,
  runBudgetMs: number,
  schedules: ReadonlyMap<ProducerKind, ScheduleState> = armedSchedules,
): ProducerProgress {
  const kinds: ProducerKind[] = ["regime", "research"];
  const notes: string[] = [];
  for (const kind of kinds) {
    const state = schedules.get(kind);
    if (!state) return { ok: false, reason: `${kind} cron is not armed` };
    if (state.running) {
      const elapsed = now - state.runningSince;
      if (elapsed > runBudgetMs) {
        return {
          ok: false,
          reason: `${kind} run has been executing ${Math.round(elapsed / 1000)}s (budget ${Math.round(runBudgetMs / 1000)}s) — stalled`,
        };
      }
      notes.push(`${kind} running ${Math.round(elapsed / 1000)}s`);
      continue;
    }
    if (state.nextFireAt < now - FIRE_SLACK_MS) {
      return {
        ok: false,
        reason: `${kind} cron fire time passed ${Math.round((now - state.nextFireAt) / 1000)}s ago and was never re-armed`,
      };
    }
    notes.push(`${kind} due in ${Math.round((state.nextFireAt - now) / 1000)}s`);
  }
  return { ok: true, reason: notes.join(", ") };
}

// Probes the SAME authenticated submission gate `waitForApi` checks at boot
// (ROUTES.analytics.readiness, Bearer cfg.token) — not the unauthenticated
// ROUTES.health, which only proves the API can reach its own database and
// says nothing about whether THIS producer's credential still works. A
// producer whose token has been rotated/revoked would otherwise beat happily
// forever while every real submission 401s. Any non-ok response (down server,
// 401, 403, ...) reads as unreachable; the ongoing loop only needs a boolean,
// unlike waitForApi's boot-time distinction between "down" and "credential
// rejected" (which throws to fail the boot loudly).
async function apiReachable(cfg: AnalyticsApiConfig, timeoutMs: number): Promise<boolean> {
  return fetch(`${cfg.baseUrl}${ROUTES.analytics.readiness}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
    .then((r) => r.ok)
    .catch(() => false);
}

export interface ProducerLivenessDeps {
  env?: Record<string, string | undefined>;
  reachable?: (cfg: AnalyticsApiConfig, timeoutMs: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  beat?: (rec: { phase: "armed"; staleAfterMs: number; writer: string; detail: string }) => Promise<void>;
  /** Schedules to judge. Defaults to this process's own armed crons. */
  schedules?: ReadonlyMap<ProducerKind, ScheduleState>;
  /** Stop after this many ticks. Tests bound the loop; serve() runs forever. */
  ticks?: number;
}

export async function runProducerLiveness(cfg: AnalyticsApiConfig, deps: ProducerLivenessDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const tickMs = Number(env.PRODUCER_LIVENESS_TICK_MS ?? 30_000);
  // A nightly research sweep is a long, heavy job (~200 EDGAR requests under
  // rate limiting, plus regime compute). An hour clears it comfortably; past
  // that the run is not slow, it is stuck.
  const runBudgetMs = Number(env.PRODUCER_RUN_PROGRESS_TIMEOUT_MS ?? 3_600_000);
  const probeTimeoutMs = Number(env.PRODUCER_LIVENESS_PROBE_TIMEOUT_MS ?? 5_000);
  // The heartbeat has to survive a tick being late; four of them is generous
  // without letting a genuinely dead loop hide for long.
  const staleAfterMs = tickMs * 4;
  // A rolling `api` restart must not paint this container red. Only a dependency
  // that stays unreachable across several ticks — i.e. long enough that the
  // producer really could not submit — withholds the beat.
  const unreachableTolerance = Number(env.PRODUCER_LIVENESS_UNREACHABLE_TICKS ?? 3);

  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? (() => Date.now());
  const reachable = deps.reachable ?? apiReachable;
  const beat = deps.beat ?? ((rec) => writeHeartbeat(rec));

  let consecutiveUnreachable = 0;
  for (let tick = 0; deps.ticks === undefined || tick < deps.ticks; tick++) {
    const schedules = checkArmedSchedules(now(), runBudgetMs, deps.schedules ?? armedSchedules);
    const up = await reachable(cfg, probeTimeoutMs);
    consecutiveUnreachable = up ? 0 : consecutiveUnreachable + 1;

    if (!schedules.ok) {
      console.error(`[analytics-producer] not progressing: ${schedules.reason}`);
    } else if (consecutiveUnreachable >= unreachableTolerance) {
      console.error(
        `[analytics-producer] not progressing: ${cfg.baseUrl} unreachable for ${consecutiveUnreachable} consecutive checks — nothing can be submitted`,
      );
    } else {
      if (!up) console.warn(`[analytics-producer] ${cfg.baseUrl} unreachable (${consecutiveUnreachable}/${unreachableTolerance})`);
      await beat({ phase: "armed", staleAfterMs, writer: PRODUCER_WRITER, detail: schedules.reason });
    }
    await sleep(tickMs);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const asof = process.argv[3] ?? new Date().toISOString().slice(0, 10);
  if (command === "seed" || command === "regime" || command === "research") {
    await runProducerCommand(command, asof);
    return;
  }
  if (command !== "serve") throw new Error(`usage: producer <serve|seed|regime|research> [YYYY-MM-DD]`);
  const cfg = await startProducerSchedules();
  // Replaces a bare `new Promise<never>(() => {})`: the process still parks
  // here forever, but now it parks doing the liveness work above.
  await runProducerLiveness(cfg);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[analytics-producer] fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
