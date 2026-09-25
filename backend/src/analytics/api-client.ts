// HTTP implementation of the AnalyticsPersistence port (issue #106): the ONLY
// persistence path the independent producer (and retained legacy handler tests)
// uses. Typed calls to the authenticated /api/analytics/* boundary, presenting
// the analytics-provider bearer credential: analytics-producer's store token,
// read from the file ANALYTICS_TOKEN_FILE names (smoke spec §3). No db/client,
// no SQL — the API process owns all analytics-table SQL behind these endpoints.
//
// SECRET HYGIENE: the token is held in a closure and set only on the outgoing
// Authorization header. It is never logged, never echoed into thrown errors,
// and never returned in any response this client surfaces.
import { ROUTES } from "@robotmoney/contract";
import type { RawIndicatorHistory } from "./types.ts";
import type { RegimeSnapshotRow } from "./report/regime-projection.ts";
import type { ResearchPayload } from "./analyze/research.ts";
import type {
  AnalyticsPersistence,
  FloorSeedResult,
  BeginRunResult,
  FreezeVintageResult,
  TerminalRunPackageResult,
} from "./persistence.ts";
import type { RunLifecycleEvent } from "./run-ledger.ts";
import type { TerminalRunPackageInput } from "./output-snapshots.ts";
import { readFileSync } from "node:fs";

export interface AnalyticsApiConfig {
  baseUrl: string; // e.g. http://api:8787 (compose) / http://localhost:8787
  token: string | null; // analytics-producer's store token; null when no file is named
}

/**
 * The analytics-provider bearer, from the file ANALYTICS_TOKEN_FILE names.
 *
 * The FILE is the only source (smoke spec §3: each service token is "a file
 * the boot places in the instance's state directory"). There is no
 * token-valued env var to fall back on, so a secret can never ride in an
 * env var or an image. A named file that is missing or empty throws: that is a
 * broken delivery, and answering it with "no token" would only move the failure
 * to a 401 somewhere less legible.
 */
export function readAnalyticsToken(env: Record<string, string | undefined> = process.env): string | null {
  const file = env.ANALYTICS_TOKEN_FILE?.trim();
  if (!file) return null;
  const value = readFileSync(file, "utf8").trim();
  if (!value) throw new Error("ANALYTICS_TOKEN_FILE points to an empty token file");
  return value;
}

// Resolve the producer's API wiring from the environment at CALL time (tests
// may inject it per case). ANALYTICS_API_URL points the producer at the API;
// the default matches the single-box API_PORT default.
export function resolveAnalyticsApiConfig(
  env: Record<string, string | undefined> = process.env,
): AnalyticsApiConfig {
  return {
    baseUrl: (env.ANALYTICS_API_URL || `http://localhost:${Number(env.API_PORT ?? 8787)}`).replace(/\/+$/, ""),
    token: readAnalyticsToken(env),
  };
}

// The one authenticated-HTTP call shape every analytics-boundary caller in
// this codebase shares: analyticsApiClient() below (the producer/updater's
// AnalyticsPersistence port) AND triggerParitySweep() (the worker's #979-fix
// call to POST A.paritySweep) both go through this — one fetch/header/error
// implementation, not two.
async function analyticsApiCall<T>(
  cfg: AnalyticsApiConfig,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const res = await fetch(`${cfg.baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    // Surface the server's error text but NEVER the credential.
    const detail = await res.text().catch(() => "");
    throw new Error(`analytics API ${method} ${route} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 500)}` : ""}`);
  }
  return (await res.json()) as T;
}

export function analyticsApiClient(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): AnalyticsPersistence {
  const call = <T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> => analyticsApiCall<T>(cfg, method, route, body);

  return {
    async beginRun(input) {
      return await call<BeginRunResult>("POST", ROUTES.analytics.runs, { run: input });
    },
    async appendRunEvent(runId: string, eventType: RunLifecycleEvent, detail: string | null) {
      await call("POST", ROUTES.analytics.runEvents, { event: { runId, eventType, detail } });
    },
    async freezeVintage(input) {
      return await call<FreezeVintageResult>("POST", ROUTES.analytics.vintages, { vintage: input });
    },
    async submitTerminalRunPackage(input: TerminalRunPackageInput) {
      const wire =
        input.status === "succeeded"
          ? {
              runId: input.runId,
              asof: input.asof,
              status: input.status,
              regimeSnapshots: input.regimeSnapshots ?? [],
              researchSignals: input.researchSignals ?? [],
              reportBase64: Buffer.from(input.reportBytes ?? new Uint8Array()).toString("base64"),
            }
          : {
              runId: input.runId,
              asof: input.asof,
              status: input.status,
              warnings: input.warnings ?? [],
              logs: input.logs ?? [],
              exceptions: input.exceptions ?? [],
            };
      return await call<TerminalRunPackageResult>("POST", ROUTES.analytics.runPackage, { package: wire });
    },
    async saveSourceAcquisition(acquisition) {
      return await call<{ acquisitionId: string; replayed: boolean }>("POST", ROUTES.analytics.sourceAcquisitions, { acquisition });
    },
    async loadRawHistory() {
      const { history } = await call<{ history: RawIndicatorHistory }>("GET", ROUTES.analytics.rawHistory);
      return history;
    },
    async saveRawHistory(byIndicator, source) {
      await call("POST", ROUTES.analytics.rawHistory, { history: byIndicator, source });
    },
    async seedRawHistory(byIndicator) {
      return await call<FloorSeedResult>("POST", ROUTES.analytics.rawHistorySeed, { history: byIndicator });
    },
    // RETIRED (issue #978): saveRegimeSnapshots / saveResearchSignal. The
    // routes they posted to are gone — submitTerminalRunPackage above is the
    // only way the producer publishes either projection, and it carries the
    // run, the immutable artifacts and the report snapshot with it.
    async loadResearchSignalDates(sinceDate: string) {
      const { dates } = await call<{ dates: { signalKey: string; date: string }[] }>(
        "GET",
        `${ROUTES.analytics.researchSignalDates}?since=${encodeURIComponent(sinceDate)}`,
      );
      return dates;
    },
    async loadRawHistoryGapDates(sinceDate: string) {
      const { dates } = await call<{ dates: string[] }>(
        "GET",
        `${ROUTES.analytics.rawHistoryGaps}?since=${encodeURIComponent(sinceDate)}`,
      );
      return dates;
    },
  };
}

export interface ParitySweepSummary {
  domains: number;
  matched: string[];
  mismatched: string[];
}

// Issue #979 fix: the worker's ONLY legitimate way to run the dual-write
// parity sweep. runParitySweep() (analytics/cutover/parity.ts) reads/writes
// Postgres directly through db/client.ts's rm_app-credentialed pool, which
// worker/** must never import — even transitively (that was exactly the
// regression this fixes: worker/handlers/index.ts importing parity.ts
// directly, which pulled db/client.ts into every worker container). This
// goes over the SAME authenticated HTTP boundary as analyticsApiClient()
// above, POSTing to A.paritySweep, which runs the sweep INSIDE the API
// process instead.
export async function triggerParitySweep(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): Promise<ParitySweepSummary> {
  return await analyticsApiCall<ParitySweepSummary>(cfg, "POST", ROUTES.analytics.paritySweep);
}
