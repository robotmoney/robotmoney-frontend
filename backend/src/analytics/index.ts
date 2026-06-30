// The analytics suite registry. Every regime/research tool registers here, so the
// worker schedules them, the API exposes them, and new tools compose without
// touching call sites. Add a tool = register it (+ its job schedule + a route).
import { Registry } from "./tool.ts";
import { regimeTool } from "./tools/regime.ts";
import { channelDivergenceTool } from "./tools/channel-divergence.ts";
import { lateCycleTool } from "./tools/late-cycle.ts";
import { seededProvider, type Provider } from "./provider.ts";
import { createFetcherProvider } from "./providers/fetcher.ts";
import { config } from "../config.ts";

export const registry = new Registry()
  .register(regimeTool)
  .register(channelDivergenceTool)
  .register(lateCycleTool);

// Choose the data source for a run. Default is the hermetic seededProvider; only
// PROVIDER=live opts into the real keyless FetcherProvider (pre-fetched/warmed
// here so the synchronous getSeries contract holds). The seeded default and the
// analytics math are untouched.
async function selectProvider(asof: string): Promise<Provider> {
  if (config.analyticsProvider !== "live") return seededProvider;
  const fetcher = createFetcherProvider();
  await fetcher.warm(asof);
  return fetcher;
}

// Run one tool (and its deps) or the whole suite for `asof`, persisting each.
export async function runAnalytics(asof: string, toolId?: string) {
  return registry.run(asof, toolId, await selectProvider(asof));
}

// Back-compat: callers that just want today's regime persisted.
export async function runRegime(asof: string) {
  await registry.run(asof, "regime", await selectProvider(asof));
}

export { Registry } from "./tool.ts";
