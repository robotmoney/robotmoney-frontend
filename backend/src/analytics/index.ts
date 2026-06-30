// The analytics suite registry. Every regime/research tool registers here, so the
// worker schedules them, the API exposes them, and new tools compose without
// touching call sites. Add a tool = register it (+ its job schedule + a route).
import { Registry } from "./analyze/tool.ts";
import { regimeTool } from "./analyze/regime.ts";
import { channelDivergenceTool } from "./analyze/channel-divergence.ts";
import { lateCycleTool } from "./analyze/late-cycle.ts";
import { selectProvider } from "./access/select.ts";

export const registry = new Registry()
  .register(regimeTool)
  .register(channelDivergenceTool)
  .register(lateCycleTool);

// Run one tool (and its deps) or the whole suite for `asof`, persisting each.
// Source selection (seeded default vs opt-in live) lives in access/select.ts.
export async function runAnalytics(asof: string, toolId?: string) {
  return registry.run(asof, toolId, await selectProvider(asof));
}

// Back-compat: callers that just want today's regime persisted.
export async function runRegime(asof: string) {
  await registry.run(asof, "regime", await selectProvider(asof));
}

export { Registry } from "./analyze/tool.ts";
