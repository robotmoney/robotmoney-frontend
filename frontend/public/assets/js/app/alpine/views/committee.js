// Alpine factory for the /committee directory view. Moved verbatim from the
// monolithic views.js (finding 025).
import { api, ROUTES } from "../../lib/api.js";
import { subjectDot } from "./shared.js";

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
    // Link by SESSION ID. Two rows sharing a (date, subject) are two different
    // sessions — a subject may convene more than once a day — and the dated URL
    // resolves to the later of them, so linking by it would leave the earlier
    // session unreachable and make the pair look like one page listed twice.
    // The dated form remains the fallback for any row without an id (the static
    // archive), and remains valid as a URL in its own right.
    sessionHref(s) {
      return s?.id ? `/committee/sessions/${encodeURIComponent(s.id)}` : `/committee/${s.date}/${s.subjectId}`;
    },
    // Subject encoding + filter, identical in behaviour to the member profile's
    // track record — the roster is the same problem at larger scale (every
    // subject interleaved by date), and the two lists must not teach different
    // conventions for the same data.
    subjectFilter: null,
    subjectDot(subjectId) { return subjectDot(subjectId); },
    filterBy(id) { this.subjectFilter = this.subjectFilter === id ? null : id; },
    visibleSessions() {
      const rows = this.publishedSessions();
      return this.subjectFilter ? rows.filter((s) => s.subjectId === this.subjectFilter) : rows;
    },
    sessionSubjects() {
      const by = new Map();
      for (const s of this.publishedSessions()) {
        const cur = by.get(s.subjectId);
        if (cur) cur.count += 1;
        else by.set(s.subjectId, { id: s.subjectId, name: s.subjectName || s.subjectId, count: 1 });
      }
      return [...by.values()].sort((a, b) => b.count - a.count);
    },
    // The aggregator fills `synthesis` by joining every take body (see
    // backend committee/domain.ts), so the preview under each row was a wall of
    // raw markdown that opened with "**REGIME**" on EVERY row — identical text
    // twenty times over, which is worse than no preview at all. Show it only
    // when it is genuinely a summary rather than a dump of the takes.
    synthesisPreview(s) {
      const t = String(s?.synthesis || "").trim();
      if (!t || t.includes("**") || t.length > 600) return "";
      return t;
    },
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
    // Punctuation-stripped: "woon (test)" must read "WT", not "W(". Kept in
    // sync with the same helper in static-views.js.
    initials(name = "") {
      return String(name)
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0].toUpperCase())
        .join("") || "IC";
    },
    stanceEntries(s) { return Object.entries(s.committeeRecommendation?.stances || {}); },
    quorumText(s) {
      const q = s.committeeRecommendation?.quorum;
      return q ? `${q.submitted}/${q.active} submitted` : "";
    },
    regimeLabel(r) { return r ? String(r).replace(/_/g, "-") : "—"; },
    stanceColor(s) {
      // Sentiment on the Beam/Pool/Beacon covenant (mirrors STANCE_COLORS in
      // static-views.js): green mass for conviction, slate neutral, sand → beacon
      // for the negative/attention end.
      return ({ bullish: "#10b981", constructive: "#34d399", neutral: "#7e889e", cautious: "#e8a640", bearish: "#ff7a29" }[s] || "#7e889e");
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
