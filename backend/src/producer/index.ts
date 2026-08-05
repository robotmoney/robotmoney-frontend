// Independent analytics/research producer (issue #361 Phase 4).
// This process has no DATABASE_URL and imports no queue/SQL module. It computes
// on its own side and submits through the authenticated analytics REST boundary.
import parser from "cron-parser";
import { ROUTES } from "@robotmoney/contract";
import { runAnalytics, resolveAnalyticsSource, RESEARCH_TOOL_GROUP } from "../analytics/index.ts";
import { analyticsApiClient, resolveAnalyticsApiConfig, type AnalyticsApiConfig } from "../analytics/api-client.ts";
import { bootstrapEdgarSeed } from "../analytics/edgar-seed-loader.ts";
import type { AnalyticsPersistence } from "../analytics/persistence.ts";
import type { AnalyticsDataSource } from "../analytics/access/data-source.ts";

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

function schedule(kind: ProducerKind, cron: string): void {
  const arm = () => {
    const next = parser.parseExpression(cron, { tz: "UTC", currentDate: new Date() }).next().toDate();
    setTimeout(async () => {
      try {
        await runProducerOnce(kind, next.toISOString().slice(0, 10));
      } catch (err) {
        console.error(`[analytics-producer] ${kind} failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        arm();
      }
    }, Math.max(0, next.getTime() - Date.now()));
  };
  arm();
}

export interface ProducerServeDeps {
  env?: Record<string, string | undefined>;
  waitUntilReady?: (cfg: AnalyticsApiConfig) => Promise<void>;
  scheduleKind?: (kind: ProducerKind, cron: string) => void;
}

/** Validate reachability + provider authorization before arming any cron. */
export async function startProducerSchedules(deps: ProducerServeDeps = {}): Promise<void> {
  const cfg = requireProducerApiConfig(deps.env);
  await (deps.waitUntilReady ?? waitForApi)(cfg);
  const scheduleKind = deps.scheduleKind ?? schedule;
  scheduleKind("regime", deps.env?.PRODUCER_REGIME_CRON || process.env.PRODUCER_REGIME_CRON || "30 22 * * *");
  scheduleKind("research", deps.env?.PRODUCER_RESEARCH_CRON || process.env.PRODUCER_RESEARCH_CRON || "0 23 * * *");
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const asof = process.argv[3] ?? new Date().toISOString().slice(0, 10);
  if (command === "seed" || command === "regime" || command === "research") {
    await runProducerCommand(command, asof);
    return;
  }
  if (command !== "serve") throw new Error(`usage: producer <serve|seed|regime|research> [YYYY-MM-DD]`);
  await startProducerSchedules();
  await new Promise<never>(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[analytics-producer] fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
