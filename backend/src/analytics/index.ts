// The analytics suite registry. Every regime/research tool registers here, so the
// worker schedules them, the API exposes them, and new tools compose without
// touching call sites. Add a tool = register it (+ its job schedule + a route).
import { Registry } from "./tool.ts";
import { regimeTool } from "./tools/regime.ts";
import { channelDivergenceTool } from "./tools/channel-divergence.ts";
import { lateCycleTool } from "./tools/late-cycle.ts";

export const registry = new Registry()
  .register(regimeTool)
  .register(channelDivergenceTool)
  .register(lateCycleTool);

// Run one tool (and its deps) or the whole suite for `asof`, persisting each.
export async function runAnalytics(asof: string, toolId?: string) {
  return registry.run(asof, toolId);
}

// Back-compat: callers that just want today's regime persisted.
export async function runRegime(asof: string) {
  await registry.run(asof, "regime");
}

export { Registry } from "./tool.ts";
