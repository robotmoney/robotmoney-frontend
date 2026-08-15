// HTTP implementation of the AnalyticsPersistence port (issue #106): the ONLY
// persistence path the independent producer (and retained legacy handler tests)
// uses. Typed calls to the authenticated /api/analytics/* boundary, presenting
// the analytics-provider bearer credential (ANALYTICS_TOKEN). No db/client, no
// SQL — the API process owns all analytics-table SQL behind these endpoints.
//
// SECRET HYGIENE: the token is held in a closure and set only on the outgoing
// Authorization header. It is never logged, never echoed into thrown errors,
// and never returned in any response this client surfaces.
import { ROUTES } from "@robotmoney/contract";
import type { RawIndicatorHistory } from "./types.ts";
import type { RegimeSnapshotRow } from "./report/regime-projection.ts";
import type { ResearchPayload } from "./analyze/research.ts";
import type { AnalyticsPersistence, FloorSeedResult } from "./persistence.ts";
import { envSecret } from "../lib/env-secret.ts";

export interface AnalyticsApiConfig {
  baseUrl: string; // e.g. http://api:8787 (compose) / http://localhost:8787
  token: string | null; // ANALYTICS_TOKEN; null only in insecure/ephemeral envs
}

// Resolve the producer's API wiring from the environment at CALL time (tests
// may inject it per case). ANALYTICS_API_URL points the producer at the API;
// the default matches the single-box API_PORT default.
export function resolveAnalyticsApiConfig(
  env: Record<string, string | undefined> = process.env,
): AnalyticsApiConfig {
  return {
    baseUrl: (env.ANALYTICS_API_URL || `http://localhost:${Number(env.API_PORT ?? 8787)}`).replace(/\/+$/, ""),
    token: envSecret("ANALYTICS_TOKEN", env),
  };
}

// Fail-loud startup guard (issue #106 AC): an analytics producer configured to
// run in demo/prod MUST have its analytics-provider credential. Without it every
// submission would 401 at the boundary — refusing to boot is the honest failure.
// `allowInsecure` (RM_ENV=ephemeral or explicit RM_ALLOW_INSECURE=1) is the only
// opt-out, mirroring the API-side gate in config.ts/api auth.
export function assertAnalyticsUpdaterCredentials(cfg: {
  env: string;
  allowInsecure: boolean;
  analyticsToken: string | null;
}): void {
  if (!cfg.allowInsecure && !cfg.analyticsToken) {
    throw new Error(
      `analytics updater is configured for RM_ENV=${cfg.env} without ANALYTICS_TOKEN — ` +
        "set the analytics-provider bearer credential (or RM_ALLOW_INSECURE=1 for a local throwaway demo)",
    );
  }
}

export function analyticsApiClient(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): AnalyticsPersistence {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  async function call<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
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

  return {
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
    async saveRegimeSnapshots(rows: RegimeSnapshotRow[]) {
      await call("POST", ROUTES.analytics.regimeSnapshots, { snapshots: rows });
    },
    async saveResearchSignal(key: string, asof: string, payload: ResearchPayload) {
      await call("POST", ROUTES.analytics.researchSignals, { signals: [{ key, date: asof, payload }] });
    },
    async loadResearchSignalDates(sinceDate: string) {
      const { dates } = await call<{ dates: { signalKey: string; date: string }[] }>(
        "GET",
        `${ROUTES.analytics.researchSignalDates}?since=${encodeURIComponent(sinceDate)}`,
      );
      return dates;
    },
  };
}
