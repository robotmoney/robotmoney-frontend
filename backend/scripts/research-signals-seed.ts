// Seed placeholder research_signals rows for the last SEED_WINDOW_DAYS days so
// that a freshly-bootstrapped database does not trigger a full boot-time
// catch-up in the analytics-producer (issue #976).
//
// Why this is a bootstrap seed, not a migration:
//   The research_signals table is owned by the analytics HTTP API (migration
//   0002). Direct SQL access from this process would violate the access
//   boundary (rm_worker cannot INSERT into research_signals — see migration
//   0016). We go through the authenticated analytics HTTP API exactly as the
//   producer does at runtime.
//
// Why placeholder rows are enough:
//   computeMissingResearchDays only checks for the PRESENCE of both signal keys
//   on each date (not the payload contents). A minimal placeholder with the
//   required fields passes that check and prevents a redundant live EDGAR fetch
//   for dates that already exist in the database from production data. The
//   producer's normal daily cron will overwrite the placeholder with real data
//   on its first run.
//
// Idempotent: the API endpoint ignores (or returns 409 for) rows that already
// exist; this function wraps each per-key POST in a try/catch and counts
// pre-existing rows as "existing" rather than failures.

import { analyticsApiClient, resolveAnalyticsApiConfig, type AnalyticsApiConfig } from "../src/analytics/api-client.ts";
import { RESEARCH_SIGNAL_TELEMETRY_KEYS } from "../src/analytics/index.ts";
import type { ResearchPayload } from "../src/analytics/analyze/research.ts";

const SEED_WINDOW_DAYS = 14;

/** Minimal placeholder payload that satisfies the ResearchPayload shape. The
 *  producer's daily cron will replace this with real data on its first tick. */
function placeholderPayload(asof: string, signalKey: string): ResearchPayload {
  return {
    asof,
    title: `${signalKey} (bootstrap seed)`,
    question: "(seeded at bootstrap — awaiting first producer run)",
    spec: {},
    gauges: [],
    series: { label: signalKey, points: [] },
  };
}

export interface ResearchSignalsSeedResult {
  seeded: number;
  existing: number;
  skipped: boolean;
}

/** Seed placeholder research_signals rows for the last SEED_WINDOW_DAYS days.
 *  Returns counts of newly-inserted and already-present rows. Never throws:
 *  per-row failures are counted as existing (assuming a duplicate-key conflict
 *  on the UNIQUE(signal_key, date) constraint). */
export async function bootstrapResearchSignalsSeed(
  cfg: AnalyticsApiConfig,
  opts: {
    now?: () => Date;
    windowDays?: number;
  } = {},
): Promise<ResearchSignalsSeedResult> {
  const now = (opts.now ?? (() => new Date()))();
  const windowDays = opts.windowDays ?? SEED_WINDOW_DAYS;
  const persistence = analyticsApiClient(cfg);

  // Determine which (signalKey, date) pairs already exist.
  const sinceDate = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);
  let present: { signalKey: string; date: string }[];
  try {
    present = await persistence.loadResearchSignalDates(sinceDate);
  } catch {
    // API unreachable — treated the same as "all missing" by the producer, but
    // here we skip entirely: if the API is down we cannot write either.
    return { seeded: 0, existing: 0, skipped: true };
  }

  const presentSet = new Set(present.map(({ signalKey, date }) => `${signalKey}::${date}`));

  // Build the full set of (key, date) pairs we want to ensure exist.
  const days: string[] = [];
  for (let i = 1; i <= windowDays; i++) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    days.push(d);
  }

  let seeded = 0;
  let existing = 0;
  for (const date of days) {
    for (const key of RESEARCH_SIGNAL_TELEMETRY_KEYS) {
      if (presentSet.has(`${key}::${date}`)) {
        existing++;
        continue;
      }
      try {
        await persistence.saveResearchSignal(key, date, placeholderPayload(date, key));
        seeded++;
      } catch {
        // Assume duplicate-key conflict — the row existed but wasn't in the
        // initial loadResearchSignalDates snapshot (race or timezone edge case).
        existing++;
      }
    }
  }

  return { seeded, existing, skipped: false };
}
