// Alpine factory for the /committee directory view. Moved verbatim from the
// monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";

export function registerCommitteeView(Alpine) {
  // ── Investment Committee ──────────────────────────────────────────────────
  Alpine.data("committeeView", () => ({
    loading: true,
    error: null,
    members: [],
    sessions: [],
    subjectCache: {},
    async load() {
      try {
        const [memberData, sessionData] = await Promise.all([
          api.get(ROUTES.committee.members),
          api.get(ROUTES.committee.sessions),
        ]);
        this.members = memberData.members || [];
        this.sessions = sessionData.sessions || [];
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    publishedSessions() { return this.sessions.filter((s) => s.state === "published"); },
    subjects() {
      const map = new Map();
      for (const s of this.sessions) {
        const id = s.subjectId;
        if (!id) continue;
        const meta = this.subjectCache[id] || {};
        const row = map.get(id) || {
          id,
          name: meta.name || s.subjectName || id,
          operator: meta.operator,
          thesisBlurb: meta.thesisBlurb,
          count: 0,
          latest: null,
        };
        row.count += 1;
        if (!row.latest || String(s.date) > String(row.latest)) row.latest = s.date;
        map.set(id, row);
      }
      return [...map.values()].sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
    },
    memberTagline(m) { return m.tagline || m.mandate || `${m.name} reads the session through a ${m.lens || "committee"} lens.`; },
    memberBiases(m) {
      if (Array.isArray(m.biases)) return m.biases.filter(Boolean);
      return m.lens ? [m.lens] : [];
    },
    initials(name = "") {
      return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("") || "SW";
    },
    stanceEntries(s) { return Object.entries(s.committeeRecommendation?.stances || {}); },
    quorumText(s) {
      const q = s.committeeRecommendation?.quorum;
      return q ? `${q.submitted}/${q.active} submitted` : "";
    },
    regimeLabel(r) { return r ? String(r).replace(/_/g, "-") : "—"; },
    stanceColor(s) {
      return ({ bullish: "#10b981", constructive: "#84cc16", neutral: "#94a3b8", cautious: "#f59e0b", bearish: "#ef4444" }[s] || "#94a3b8");
    },
    formatDate(value, style = "short") {
      const date = String(value || "").includes("T") ? new Date(value) : new Date(`${value}T00:00:00Z`);
      const opts = style === "long"
        ? { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }
        : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
      try { return date.toLocaleDateString("en-US", opts); } catch (_) { return value; }
    },
  }));
}
