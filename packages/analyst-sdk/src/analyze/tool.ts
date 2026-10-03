// The composable unit of the analytics suite. Regime and every research signal
// are instances of AnalyticTool, so they share scheduling, persistence, and API
// exposure. Tools may compose other tools via `dependsOn` (the registry resolves
// run order), which is how a future "regime tempered by channel-divergence" would
// be expressed without special-casing.
import type { Provider } from "../access/provider.ts";
import { seededProvider } from "../access/provider.ts";

export interface ToolContext {
  asof: string;
  provider: Provider;
  dep<R = unknown>(toolId: string): R | undefined; // resolved output of a dependency
}

export interface AnalyticTool<R = unknown> {
  id: string; // "regime", "channel-divergence", "late-cycle-signals"
  title: string;
  kind: "regime" | "research";
  inputs: string[]; // series ids consumed (provenance/documentation)
  dependsOn?: string[]; // other tool ids this composes
  compute(ctx: ToolContext): Promise<R> | R;
  // NOTE (issue #106): tools no longer carry a persist member — persistence is
  // owned by the orchestrator's AnalyticsPersistence port (analytics/persistence.ts),
  // so compute stays pure and analyze/* never imports a SQL-backed store.
}

export class Registry {
  private tools = new Map<string, AnalyticTool>();

  register(tool: AnalyticTool): this {
    this.tools.set(tool.id, tool);
    return this;
  }
  get(id: string) { return this.tools.get(id); }
  list() { return [...this.tools.values()]; }

  // Topological order over dependsOn so a tool runs after its dependencies.
  private order(): AnalyticTool[] {
    const seen = new Set<string>(), out: AnalyticTool[] = [];
    const visit = (t: AnalyticTool, stack: Set<string>) => {
      if (seen.has(t.id)) return;
      if (stack.has(t.id)) throw new Error(`analytics dependency cycle at "${t.id}"`);
      stack.add(t.id);
      for (const d of t.dependsOn ?? []) {
        const dep = this.tools.get(d);
        if (!dep) throw new Error(`tool "${t.id}" dependsOn unknown "${d}"`);
        visit(dep, stack);
      }
      stack.delete(t.id);
      seen.add(t.id);
      out.push(t);
    };
    for (const t of this.tools.values()) visit(t, new Set());
    return out;
  }

  // Run one tool (and its deps) or all; returns {id: result}. Pure compute —
  // callers persist results through the AnalyticsPersistence port (issue #106).
  async run(asof: string, only?: string, provider: Provider = seededProvider) {
    if (only && !this.tools.has(only)) throw new Error(`unknown analytics tool "${only}"`);
    const results = new Map<string, unknown>();
    const ctx: ToolContext = { asof, provider, dep: (id) => results.get(id) as any };
    const plan = only
      ? this.order().filter((t) => t.id === only || this.deps(only).has(t.id))
      : this.order();
    for (const t of plan) {
      const r = await t.compute(ctx);
      results.set(t.id, r);
    }
    return Object.fromEntries(results);
  }

  private deps(id: string, acc = new Set<string>()): Set<string> {
    const t = this.tools.get(id);
    acc.add(id);
    for (const d of t?.dependsOn ?? []) this.deps(d, acc);
    return acc;
  }
}
