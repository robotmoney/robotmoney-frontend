// HTTP implementation of the TelemetrySink port (issue #151) — the default
// updater-process path, mirroring analytics/api-client.ts's AnalyticsPersistence
// HTTP client exactly (same ANALYTICS_API_URL + ANALYTICS_TOKEN wiring, same
// secret hygiene: the token never appears in a thrown error).
import { ROUTES } from "@robotmoney/contract";
import { resolveAnalyticsApiConfig, type AnalyticsApiConfig } from "./api-client.ts";
import type { TelemetryRunSubmission, TelemetrySink, TelemetrySubmitResult } from "./telemetry.ts";

export function telemetryHttpSink(cfg: AnalyticsApiConfig = resolveAnalyticsApiConfig()): TelemetrySink {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  return {
    async submitRun(run: TelemetryRunSubmission): Promise<TelemetrySubmitResult> {
      const res = await fetch(`${cfg.baseUrl}${ROUTES.analytics.telemetry}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ run }),
      });
      if (!res.ok) {
        // Surface the server's error text but NEVER the credential.
        const detail = await res.text().catch(() => "");
        return { ok: false, error: `telemetry POST ${ROUTES.analytics.telemetry} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 500)}` : ""}` };
      }
      const body = (await res.json()) as { runId: number };
      return { ok: true, runId: body.runId };
    },
  };
}
