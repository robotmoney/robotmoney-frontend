import { runAnalytics } from "../../analytics/index.ts";

// Generic analytics handler: runs one tool (payload.tool) or the whole suite,
// for payload.asof (default today). Replaces the bespoke regime handler.
export async function analyticsRun(payload: Record<string, unknown>): Promise<unknown> {
  const asof = (payload.asof as string) ?? new Date().toISOString().slice(0, 10);
  const tool = payload.tool as string | undefined;
  const results = await runAnalytics(asof, tool);
  return { asof, tools: Object.keys(results) };
}
