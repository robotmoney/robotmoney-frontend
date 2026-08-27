// @ts-nocheck — buildless browser JS predating the root tsconfig's checkJs
// coverage; issue #358 is the first thing to import this module from a
// typechecked .ts file (scripts/tests/unit/swarm-synthesis-preview.test.ts),
// which pulls the whole file into the root TS program transitively and
// surfaces a pile of pre-existing implicit-any errors unrelated to this
// change (same situation as static-views.js's and apply-form.js's identical
// pragmas). This preserves the status quo rather than fixing unrelated
// coverage as a drive-by; JSDoc-typing this file is a worthwhile follow-up.
//
// Alpine factory for the /swarm directory view. Moved verbatim from the
// monolithic views.js (finding 025), then reworked for RM-100: three
// portfolios instead of four subjects, real session counts, and a member
// register.
import { api, ROUTES, path } from "../../lib/api.js";
import { memberAvatarMarkup } from "../../lib/member-mark.js";
import { memberLogo } from "../../lib/member-logos.js";

// Every seat proposes today. There is no role field on the projection yet, and
// the second role (validator) ships with its first holder, so this is a named
// constant rather than a string sprinkled through the template: when the field
// lands, this function reads it and nothing else moves. RM-97's roles table.
const DEFAULT_ROLE = "proposer";
const ROLE_EMITS = {
  proposer: "a signed take each session: position, reasoning, sources",
  validator: "a score per take. Never a market view",
};

// Operators the house runs itself. Anything else is an external operator, and
// a member with no operator set gets no chip at all rather than an invented one.
// The company is RM Protocol Labs. `operator` is free text that each member and
// each portfolio sets for itself, so the API serves two spellings of the same
// outfit: "robotmoney" on two members and on both our portfolios, "RM Protocol
// Labs" on a third member. Rendered verbatim that puts a slug and a company
// name in the same column, both marked house, reading as two different
// operators. Canonicalize on the way to the screen. The records want the same
// normalization, but that is an admin write and not this file's job.
const HOUSE_OPERATOR = "RM Protocol Labs";
const HOUSE_ALIASES = new Set(["robotmoney", "robot money", "rm protocol labs", "rm protocol"]);
const isHouseOperator = (op) => HOUSE_ALIASES.has(String(op || "").trim().toLowerCase());
const operatorName = (op) => {
  const s = String(op || "").trim();
  if (!s) return null;
  return isHouseOperator(s) ? HOUSE_OPERATOR : s;
};

// The sessions list is paginated and the page used to render only the first
// page while presenting its counts as totals. 209 published sessions arrive in
// 3 requests at this limit; the cap is a runaway guard, not a business rule.
const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 12;
const SESSIONS_SHOWN_STEP = 20;

export function registerSwarmView(Alpine) {
  // ── Investment Swarm ──────────────────────────────────────────────────
  Alpine.data("swarmView", () => ({
    loading: true,
    error: null,
    members: [],
    sessions: [],
    subjectCache: {},
    rosterCap: null,
    seatsAvailable: null,
    sessionsTruncated: false,
    shown: SESSIONS_SHOWN_STEP,
    async load() {
      try {
        const [memberData, sessionData] = await Promise.all([
          api.get(ROUTES.swarm.members),
          this.loadAllSessions(),
        ]);
        this.members = memberData.members || [];
        this.rosterCap = memberData.rosterCap ?? null;
        this.seatsAvailable = memberData.seatsAvailable ?? null;
        this.sessions = sessionData;
        // Subject records carry the operator, the thesis blurb, and the field
        // this whole regrouping turns on: `source.type`. `subjectCache` has
        // existed since the port and was never written to, which is why the
        // panel has always shown a raw id where an operator belongs.
        await this.loadSubjects();
        this.loading = false;
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },
    // Walk `nextCursor` to exhaustion. Without this the counts below are
    // first-page artifacts: the panel implied 4 or 5 sessions per subject where
    // the real figures are 50 to 102.
    async loadAllSessions() {
      const rows = [];
      let cursor = null;
      for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
        const query = { limit: String(SESSION_PAGE_SIZE) };
        if (cursor) query.cursor = cursor;
        const res = await api.get(ROUTES.swarm.sessions, query);
        rows.push(...(res.sessions || []));
        cursor = res.nextCursor || null;
        if (!cursor) return rows;
      }
      // Ran out of pages before the cursor ran out. Say so rather than
      // silently presenting a partial set as the total.
      this.sessionsTruncated = true;
      return rows;
    },
    async loadSubjects() {
      const ids = [...new Set(this.sessions.map((s) => s.subjectId).filter(Boolean))];
      const rows = await Promise.all(
        ids.map((id) => api.get(path(ROUTES.swarm.subject, { id })).catch(() => null)),
      );
      const cache = {};
      ids.forEach((id, i) => { if (rows[i]) cache[id] = rows[i]; });
      this.subjectCache = cache;
    },
    publishedSessions() { return this.sessions.filter((s) => s.state === "published"); },
    // Link by SESSION ID. Two rows sharing a (date, subject) are two different
    // sessions — a subject may convene more than once a day — and the dated URL
    // resolves to the later of them, so linking by it would leave the earlier
    // session unreachable and make the pair look like one page listed twice.
    // The dated form remains the fallback for any row without an id (the static
    // archive), and remains valid as a URL in its own right.
    sessionHref(s) {
      return s?.id ? `/swarm/sessions/${encodeURIComponent(s.id)}` : `/swarm/${s.date}/${s.subjectId}`;
    },

    // ── portfolios ───────────────────────────────────────────────────────
    // A framework subject has no portfolio to scrape: it IS the allocation
    // recipe for one. So it is not a fourth thing under review, it is the
    // vault's own sessions wearing a second name, and it folds into the
    // `vault_tvl` subject of the same operator. Expressed as a rule rather
    // than a hardcoded slug so a second framework subject behaves correctly,
    // and it degrades to standing alone when no vault matches.
    parentFor(id) {
      const meta = this.subjectCache[id];
      if (meta?.source?.type !== "framework") return id;
      const vault = Object.values(this.subjectCache).find(
        (s) => s?.source?.type === "vault_tvl" && s.operator && s.operator === meta.operator,
      );
      return vault?.id || id;
    },
    // Grouped id for a session, so counts, colours and filters all agree.
    portfolioIdOf(s) { return this.parentFor(s?.subjectId); },
    // Once two subjects retitle to one portfolio, this is what still separates
    // their sessions. Only qualify where something actually folded in: a
    // portfolio with a single source needs no qualifier, and adding one to
    // every row would be noise that distinguishes nothing.
    foldedInto(id) {
      const set = new Set(
        this.publishedSessions()
          .filter((s) => this.parentFor(s.subjectId) === id)
          .map((s) => s.subjectId),
      );
      return set.size > 1;
    },
    qualifierOf(s) {
      const meta = this.subjectCache[s?.subjectId];
      if (!meta) return "";
      if (!this.foldedInto(this.parentFor(s.subjectId))) return "";
      return meta.source?.type === "framework" ? "target allocation" : "holdings";
    },
    portfolioName(id) { return this.subjectCache[id]?.name || id; },
    portfolios() {
      const map = new Map();
      for (const s of this.publishedSessions()) {
        const id = this.portfolioIdOf(s);
        if (!id) continue;
        const meta = this.subjectCache[id] || {};
        const row = map.get(id) || {
          id,
          name: meta.name || s.subjectName || id,
          operator: operatorName(meta.operator),
          thesisBlurb: meta.thesisBlurb || null,
          isVault: meta.source?.type === "vault_tvl",
          count: 0,
          latest: null,
        };
        row.count += 1;
        if (!row.latest || String(s.date) > String(row.latest)) row.latest = s.date;
        map.set(id, row);
      }
      const rows = [...map.values()];
      // The vault leads: it is the only portfolio whose recommendation becomes
      // a real allocation. The rest fall back to volume.
      return rows.sort((a, b) => (b.isVault - a.isVault) || (b.count - a.count));
    },
    vaultPortfolio() { return this.portfolios().find((p) => p.isVault) || null; },
    otherPortfolios() { return this.portfolios().filter((p) => !p.isVault); },

    // A recommendation only carries target weights when the session published
    // `bucket_weights`. Sessions since the 2026-08-06 cutover carry
    // `position_actions` instead, so this returns null rather than inventing a
    // number, and the row says "no weight change" instead.
    sessionWeights(s) {
      const rec = s?.swarmRecommendation;
      if (rec?.type !== "bucket_weights" || !rec.weights) return null;
      const order = ["conservative_defi_yield", "agent_tokens", "protocol_tokens", "real_world_assets"];
      const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const by = {};
      for (const [k, v] of Object.entries(rec.weights)) by[norm(k)] = Number(v) * 100;
      const vals = order.map((k) => by[norm(k)]).filter((v) => Number.isFinite(v));
      return vals.length ? vals.map((v) => Math.round(v)).join(" / ") : null;
    },
    // Only the vault's recommendations are weights; every other portfolio gets
    // a verdict, so the marker would be meaningless on their rows.
    showsWeights(s) {
      const vault = this.vaultPortfolio();
      return !!vault && this.portfolioIdOf(s) === vault.id;
    },

    // ── sessions ─────────────────────────────────────────────────────────
    // Portfolio encoding + filter, identical in behaviour to the member
    // profile's track record — the roster is the same problem at larger scale
    // (every portfolio interleaved by date), and the two lists must not teach
    // different conventions for the same data.
    subjectFilter: null,

    // A grouped session wears its portfolio's colour, so one symbol is one
    // colour everywhere rather than the vault showing two.
    filterBy(id) { this.subjectFilter = this.subjectFilter === id ? null : id; this.shown = SESSIONS_SHOWN_STEP; },
    visibleSessions() {
      const rows = this.publishedSessions();
      const filtered = this.subjectFilter
        ? rows.filter((s) => this.portfolioIdOf(s) === this.subjectFilter)
        : rows;
      return filtered.slice(0, this.shown);
    },
    matchingCount() {
      const rows = this.publishedSessions();
      return this.subjectFilter ? rows.filter((s) => this.portfolioIdOf(s) === this.subjectFilter).length : rows.length;
    },
    hasMore() { return this.shown < this.matchingCount(); },
    showMore() { this.shown += SESSIONS_SHOWN_STEP; },
    // The aggregator fills `synthesis` by joining every take body (see
    // backend swarm/domain.ts), so the preview under each row was a wall of
    // raw markdown that opened with "**REGIME**" on EVERY row — identical text
    // twenty times over, which is worse than no preview at all. Show it only
    // when it is genuinely a summary rather than a dump of the takes.
    synthesisPreview(s) {
      const t = String(s?.synthesis || "").trim();
      if (!t || t.includes("**") || t.length > 600) return "";
      return t;
    },

    // ── members ──────────────────────────────────────────────────────────
    memberRole() { return DEFAULT_ROLE; },
    roleEmits(role) { return ROLE_EMITS[role || DEFAULT_ROLE] || ""; },
    seatsLabel() {
      if (this.rosterCap == null) return `${this.members.length} seats`;
      return `${this.members.length} of ${this.rosterCap} seats taken`;
    },
    openSeatsLabel() {
      if (this.seatsAvailable == null) return "";
      if (this.seatsAvailable <= 0) return "No seats open right now";
      return this.seatsAvailable === 1 ? "One seat open" : `${this.seatsAvailable} seats open`;
    },
    // House or external, from the operator. A member with none set gets
    // nothing: three of the seven have not filled their profile in, and an
    // invented chip would be a claim the data does not support.
    // Just the operator. A "· house" marker used to hang off ours, but it
    // repeated on three of seven rows to restate what the name already says.
    operatorLabel(m) { return operatorName(m?.operator); },
    memberTagline(m) { return m.tagline || m.mandate || ""; },
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
        .join("") || "SW";
    },
    // Avatar precedence (#625, RM-100); see the twin in static-views.js. The
    // curated logo wins over the projection's `avatar.path` because every path
    // production serves 404s and one of them points at the wrong member.
    // x-html is safe here: memberAvatarMarkup() never interpolates the seed,
    // and initials() is already stripped to letters and digits.
    memberMark(seed, name, size = 40, avatarPath, handle) {
      const src = memberLogo({ handle }) || avatarPath || null;
      return memberAvatarMarkup(src, seed, name, size, (n) => this.initials(n));
    },
    stanceEntries(s) { return Object.entries(s.swarmRecommendation?.stances || {}); },
    quorumText(s) {
      const q = s.swarmRecommendation?.quorum;
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
