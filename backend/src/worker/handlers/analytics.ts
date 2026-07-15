import { runAnalytics } from "../../analytics/index.ts";

// Distinct analytics job kinds (issue #107): regime classification and the
// research-signal refreshes are SEPARATE jobs with separate schedules and
// dedupe keys — a slow research fetch never rides along on (and is never
// implicitly rerun by) a regime job, and each kind is claimed by its own
// execution lane (see ../lanes.ts). Both delegate to the real orchestrator
// (analytics/index.ts runAnalytics → live keyless fetchers, append-only merge,
// no synthetic data), scoped to exactly the tools of their kind.
export const REGIME_TOOL = "regime";
export const RESEARCH_TOOLS = ["channel-divergence", "late-cycle-signals"] as const;

export type AnalyticsRunner = (asof: string, toolId?: string) => Promise<Record<string, unknown>>;

const asofOf = (payload: Record<string, unknown>): string =>
  (payload.asof as string) ?? new Date().toISOString().slice(0, 10);

// Factory so tests can inject a recording runner and prove each handler invokes
// ONLY its scoped tools; production registration (handlers/index.ts) uses the
// real orchestrator.
export function makeAnalyticsHandlers(run: AnalyticsRunner = runAnalytics) {
  return {
    // `regime.classify` — regime-only classification → regime_snapshots.
    regimeClassify: async (payload: Record<string, unknown>): Promise<unknown> => {
      const asof = asofOf(payload);
      const results = await run(asof, REGIME_TOOL);
      return { asof, tools: Object.keys(results) };
    },
    // `research.refresh` — research signals only → research_signals. Runs each
    // research tool explicitly; never the regime tool, never the full suite.
    researchRefresh: async (payload: Record<string, unknown>): Promise<unknown> => {
      const asof = asofOf(payload);
      const results: Record<string, unknown> = {};
      for (const tool of RESEARCH_TOOLS) Object.assign(results, await run(asof, tool));
      return { asof, tools: Object.keys(results) };
    },
  };
}
