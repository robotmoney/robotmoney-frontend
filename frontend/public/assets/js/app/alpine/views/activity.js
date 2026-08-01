// Alpine factory for /market + /dashboard — "Agent Activity Log" TerminalFeed
// (issue #392, docs/bot-analytics-ui-port-plan.md §5.6, P4.1): both routes
// alias this same fragment/factory (routes.js's own aliasing, §4.1). Fetches
// GET /api/dashboards/activity — newest-first, zero-score noise already
// filtered server-side (backend/src/projects/activity-log-projections.ts).
// Renders inside views/dash/_layout.html's [data-outlet].
import { api, ROUTES } from "../../lib/api.js";

// §5.6 status glyphs: ✓ emerald (success) / ⏳ amber (pending) / ✗ red
// (rejected) — plain characters colored by the a3-terminal__status--* class,
// no icon-sprite entry needed for a three-way status this small.
const STATUS_GLYPH = { success: "✓", pending: "⏳", rejected: "✗" };

export function registerActivityView(Alpine) {
  Alpine.data("activityView", () => ({
    loading: true,
    error: null,
    entries: [],

    async init() {
      await this.load();
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const res = await api.get(ROUTES.dashboards.activity);
        this.entries = res.entries || [];
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    statusGlyph(status) {
      return STATUS_GLYPH[status] || "?";
    },

    // `[YYYY-MM-DD HH:MM]` (§5.6) in the viewer's local time — a terminal
    // "tail -f" line always reads in wall-clock local time, not UTC/relative.
    fmtTs(iso) {
      const d = new Date(iso);
      if (!iso || isNaN(d.getTime())) return "—";
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
  }));
}
