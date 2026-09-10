// @ts-nocheck — buildless browser JS predating the root tsconfig's checkJs
// coverage; issue #358 is the first thing to import this module from a
import { sessionPhase, isLiveState } from "../../lib/session-phase.js";
import { timeAgo, absoluteUtc } from "../../lib/relative-time.js";
import { stanceColor, stanceClass, stanceStyle } from "../../lib/stance.js";
import { operatorName } from "../../lib/operator.js";
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
import { ALLOCATION_SUBJECT_ID } from "../../lib/allocation-subject.js";
import { sessionSummary } from "../../lib/session-summary.js";
import { sessionTakes } from "../../lib/session-takes.js";
import { memberLogo } from "../../lib/member-logos.js";
import { CATEGORICAL } from "../../lib/chart-theme.js";

// Every seat proposes today. There is no role field on the projection yet, and
// the second role (validator) ships with its first holder, so this is a named
// constant rather than a string sprinkled through the template: when the field
// lands, this function reads it and nothing else moves. RM-97's roles table.
// Bearish through bullish, so the spread bar always runs the same direction
// no matter which stances a session actually produced.
const DEFAULT_ROLE = "proposer";

// The sessions list is paginated and the page used to render only the first
// page while presenting its counts as totals. 209 published sessions arrive in
// 3 requests at this limit; the cap is a runaway guard, not a business rule.
// THE DEADLINE IS THE TIMESTAMP, NOT THE STATE. That is the backend's own rule
// (domain.ts:567, issue #570): the submission gate is `window_closes_at < now`
// and a state gate was REMOVED from there for creating a dead zone. So a
// `window_closed` row whose timestamp is still in the future is a session the
// API is still accepting takes for, and a `collecting` row past its timestamp
// is not. Keying the copy on state would contradict the server in both
// directions. A null timestamp means no deadline, which the backend treats as
// open, so this does too — same predicate as the shipped `pendingWindow()`
// (static-views.js:966).
//
// Nothing sweeps state by timestamp, so an orphaned `collecting` row can sit
// past its deadline indefinitely. The page therefore never claims aggregation
// is under way on the strength of a `collecting` row: it reports the window
// closed and says nothing about what happens next.
const CLOSED_GRACE_MS = 3 * 60 * 60 * 1000;
const LIVE_TICK_MS = 30 * 1000;


const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 12;
const SESSIONS_SHOWN_STEP = 20;

// Short row copy, keyed on the served name so an admin rename drops the
// override in one line. The API blurbs reprint the 95/5/0/0 weights, the
// vault address, and a paragraph of flywheel; this page has a chart and a
// link for those. Nothing else here depends on the map.
const ROW_BLURBS = {
  "Robot Money Vault": "Depositor capital in the ERC-4626 vault on Base. One implementation of the allocation above.",
  "RM Protocol Labs Treasury": "Protocol-owned capital: the ROBOTMONEY primary wallet and two stablecoin strategy wallets.",
  "RM Protocol Treasury": "Protocol-owned capital: the ROBOTMONEY primary wallet and two stablecoin strategy wallets.",
  "Robot Money protocol wallets": "Protocol-owned capital: the ROBOTMONEY primary wallet and two stablecoin strategy wallets.",
  "Woon Treasury": "peaq's tokenized agent. Earnings go to $WOON buybacks, $PEAQ, and the Robot Money vault.",
  "Woon Treasury Allocation": "peaq's tokenized agent. Earnings go to $WOON buybacks, $PEAQ, and the Robot Money vault.",
};
const rowBlurb = (p) => ROW_BLURBS[String(p?.name || "").trim()] || p?.thesisBlurb || "";

export function registerSwarmView(Alpine) {
  // ── Investment Swarm ──────────────────────────────────────────────────
  Alpine.data("swarmView", () => ({
    ...sessionSummary,
    ...sessionTakes(),
    loading: true,
    error: null,
    members: [],
    sessions: [],
    subjectCache: {},
    rosterCap: null,
    seatsAvailable: null,
    sessionsTruncated: false,
    shown: SESSIONS_SHOWN_STEP,
    // Read by the live strip so the countdown re-renders without a reload. The
    // SPA swaps views without unloading the document, so the interval has to be
    // cleared on teardown or it outlives the page (same destroy() contract the
    // apply-status view uses).
    now: Date.now(),
    liveTimer: null,
    liveTakes: null,
    // The published allocation: four sleeves and the weight each is held to.
    // Guarded, and the panel degrades by omission — it keeps its claim and
    // drops its register rather than printing a dash where a weight would be.
    allocationFw: null,
    destroy() {
      if (this.liveTimer) { clearInterval(this.liveTimer); this.liveTimer = null; }
    },
    async load() {
      this.liveTimer = setInterval(() => { this.now = Date.now(); }, LIVE_TICK_MS);
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
        // Subjects first: the portfolio rows need their names and source.type,
        // and loadAllocation() asks portfolios() which of them is the vault.
        await this.loadSubjects();
        // The last two are independent of each other, and were awaited one
        // after the other for no reason: two round trips of dead time before
        // the page could paint.
        await Promise.all([this.loadLiveTakes(), this.loadAllocation()]);
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
    // One extra request, and only when something is live. The sessions LIST
    // carries no take count and its swarmRecommendation is null until
    // aggregation writes it, so the count has to come from the detail route.
    // Failure is silent: the strip drops the count and keeps the countdown.
    async loadLiveTakes() {
      const s = this.liveSession();
      if (!s?.id) { this.liveTakes = null; return; }
      try {
        const d = await api.get(path(ROUTES.swarm.sessionById, { id: s.id }));
        this.liveTakes = Array.isArray(d?.takes) ? d.takes.length : null;
      } catch (_) { this.liveTakes = null; }
    },
    // One request. The panel states a policy, and the policy is this route.
    // It also used to fetch the bucket manifest and the vault's snapshots, to
    // derive a CURRENT column beside the target; both went with the panel's
    // move out of the vault's row. Measuring one contract's holdings against
    // the policy is the conflation this section now exists to undo.
    async loadAllocation() {
      this.allocationFw = await api.get(ROUTES.dashboards.allocation).catch(() => null);
    },

    // ── the published allocation ─────────────────────────────────────────
    // The four sleeves and the weight each is held to. Hues are chart-theme's
    // CATEGORICAL, in order, so a sleeve is the same colour here as in the
    // pies on /allocation.
    //
    // This block used to argue that figures beat a bar, because at 95/5/0/0 a
    // bar draws one long block beside two segments too thin to see. That is
    // true of a STACKED bar and only of one. Each sleeve now gets its own
    // full-width track on a shared 0-to-100 scale, where 5% is a short bar
    // rather than a sliver and 0% is an empty track.
    //
    // The CURRENT and DRIFT columns that stood here are gone. Kept alive, a
    // book that crossed their 99.5% coverage test would have silently sprouted
    // columns measuring a contract against a policy, inside the block built to
    // separate the two.
    allocationTargets() {
      const rows = this.allocationFw?.strategy;
      if (!Array.isArray(rows) || !rows.length) return [];
      return rows.map((r, i) => ({
        // "Sleeve" is the published word for one of the four allocation rows;
        // `buckets` stays the manifest's own field name and is not renamed.
        label: r?.label || `Sleeve ${i + 1}`,
        pct: Number.isFinite(Number(r?.targetPct)) ? Number(r.targetPct) : null,
        hue: CATEGORICAL[i % CATEGORICAL.length],
      }));
    },
    // Bar width, clamped to the scale. A framework whose weights do not sum to
    // 100 draws tracks that do not fill; it is never normalised to its own
    // sum, which would rescale an incomplete policy to look complete.
    //
    // null is not 0. A published zero gets an empty track and a muted figure;
    // an absent target gets no track and an em dash. The two must not look
    // alike, so the track is what separates them.
    sleeveBar(t) {
      const pct = Number(t?.pct);
      if (t?.pct === null || !Number.isFinite(pct)) return null;
      return Math.max(0, Math.min(100, pct));
    },
    allocationAsOf() {
      const d = this.allocationFw?.asOf;
      return d ? this.formatDate(d) : "";
    },
    // The note carries what the register cannot, and nothing it cannot back.
    //
    // "No session has changed these weights yet" is read from the code rather
    // than from the feed: `allocation_framework` has exactly one writer, the
    // seed, and this row has not moved since it was written. When a real
    // writer lands, this sentence is the whole of the change.
    allocationNote() {
      if (!this.allocationFw) return "The published target could not be read.";
      const zeros = this.allocationTargets().filter((t) => t.pct === 0).length;
      const head = "No session has changed these weights yet.";
      if (!zeros) return head;
      // Counted, not written into the string. The framework is 95/5/0/0 today,
      // and a hardcoded "two" becomes false the first time a weight is edited.
      const word = ["", "one", "two", "three", "four"][zeros] || String(zeros);
      return zeros === 1
        ? `${head} The ${word} sleeve at zero is a target, not a gap.`
        : `${head} The ${word} sleeves at zero are targets, not gaps.`;
    },

    // ── the allocation's own sessions ────────────────────────────────────
    // The framework subject is not a portfolio row, but its sessions are in
    // the feed. The panel count reads the same published set the list does.
    allocationSubject() {
      return Object.values(this.subjectCache).find((s) => s?.source?.type === "framework") || null;
    },
    allocationSessions() {
      const subj = this.allocationSubject();
      if (!subj?.id) return [];
      return this.publishedSessions().filter((s) => s.subjectId === subj.id);
    },
    // Omitted rather than zeroed. With no allocation subject, or one that has
    // never published, there is no count to state and nowhere to link: never
    // "0 sessions", never a link to /swarm/subjects/undefined.
    allocationMeta() {
      const rows = this.allocationSessions();
      if (!rows.length) return "";
      const latest = rows.reduce((acc, s) => (String(s.date) > String(acc) ? s.date : acc), rows[0].date);
      const noun = rows.length === 1 ? "session" : "sessions";
      return `${rows.length} ${noun} · latest ${this.formatDate(latest)}`;
    },
    // The allocation's decision log lives in the product section, not the
    // swarm's (RM-115). It pointed at /allocation/history for one commit;
    // that page is not built yet, so the sessions live where the swarm keeps
    // them, on the subject's own profile.
    //
    // Unconditional, where the older form returned "" without a subject or
    // without sessions. That guard existed to avoid linking to
    // /swarm/subjects/undefined, and the id is a fixed slug rather than
    // something this view has to resolve.
    allocationHref() {
      return `/swarm/subjects/${ALLOCATION_SUBJECT_ID}`;
    },
    // Sessions this page lists: every published session, including the
    // allocation subject's. They used to be dropped here and only reachable
    // from the panel link, which hid half the swarm's work behind a filter
    // the reader could not see. The chips below separate allocation from
    // the books; the feed itself does not.
    publishedSessions() {
      return this.sessions.filter((s) => s.state === "published");
    },
    // A framework subject that folds into a vault is not a fourth BOOK. It
    // still has its own sessions, listed above; it does not get a row in
    // Portfolios. Same rule parentFor() uses, applied to the count.
    isListedSubject(id) {
      const meta = this.subjectCache[id];
      if (meta?.source?.type !== "framework") return true;
      return this.parentFor(id) === id;
    },
    // Same set as publishedSessions(). Kept so older call sites cannot drift
    // onto a filtered list by accident.
    allPublishedSessions() { return this.publishedSessions(); },

    // The one session the swarm is working on right now, or null. Newest first,
    // because a subject may convene more than once a day.
    liveSession() {
      const rows = this.sessions
        .filter((s) => isLiveState(s.state))
        .sort((a, b) => String(b.windowClosesAt || "").localeCompare(String(a.windowClosesAt || "")));
      const s = rows[0];
      if (!s) return null;
      if (!s.windowClosesAt) return s;
      const closes = Date.parse(s.windowClosesAt);
      if (!Number.isFinite(closes)) return null;
      // Past the grace window it is an orphan, not news. Say nothing.
      if (this.now - closes > CLOSED_GRACE_MS) return null;
      return s;
    },
    // Derivation lives in lib/session-phase.js so this page and the session
    // detail page cannot answer it differently about the same row.
    livePhase() {
      const s = this.liveSession();
      return s ? sessionPhase(s, this.now) : null;
    },
    liveIsOpen() { return this.livePhase()?.isOpen === true; },
    liveIsAggregating() { return this.livePhase()?.key === "aggregating"; },
    livePhaseLabel() { return this.livePhase()?.label || ""; },
    liveTakesLabel() {
      const n = this.liveTakes;
      const seats = this.members.length;
      if (n == null || !seats) return "";
      return `${n}/${seats} takes in.`;
    },
    liveSubjectName() {
      const s = this.liveSession();
      if (!s) return "";
      const id = this.portfolioIdOf(s);
      return this.subjectCache[id]?.name || s.subjectName || id;
    },
    // Coarse on purpose: the window runs for hours, so a ticking second hand
    // would be precision this cadence does not have.
    liveRemaining() {
      const s = this.liveSession();
      // A session with no deadline is open, but there is no countdown to show.
      if (!s || !s.windowClosesAt) return "";
      const ms = Date.parse(s.windowClosesAt) - this.now;
      if (!Number.isFinite(ms)) return "";
      if (ms <= 0) return "";
      const mins = Math.floor(ms / 60000);
      if (mins < 1) return "under a minute";
      if (mins < 60) return `${mins} min`;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return m ? `${h}h ${m}m` : `${h}h`;
    },
    liveClosesAbsolute() { return absoluteUtc(this.liveSession()?.windowClosesAt); },
    // "3 min ago" for a window that has already shut. Returns "" for one that
    // has not, so the open branch keeps the countdown and this one stays empty.
    liveClosedAgo() { return timeAgo(this.liveSession()?.windowClosesAt, this.now); },

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
    sessionSubjectName(s) {
      const meta = this.subjectCache[s?.subjectId];
      return meta?.name || s?.subjectName || s?.subjectId || "";
    },
    // Two glyphs, from a fixed switch and never from data, so x-html here can
    // never carry anything a subject supplied. A neutral square said "this is
    // an identity" and nothing else, which is true of every row and therefore
    // told a reader nothing: the wallet mark says this portfolio is addresses
    // on a chain, and the bucket mark says it is a set of weights.
    portfolioMark(kind) {
      const open = '<svg class="rm-pmark" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">';
      return kind === "framework"
        // Unequal columns: a recipe, and at 95/5/0/0 an honest one.
        ? `${open}<rect x="1.6" y="2.6" width="10.8" height="8.8"/><path d="M9.2 2.6v8.8M11 2.6v8.8"/></svg>`
        // A card with a flap and a chip: something that holds value.
        : `${open}<rect x="1.6" y="3.4" width="10.8" height="8"/><path d="M1.6 6.2h10.8"/><rect x="8.4" y="8" width="2.6" height="1.8" fill="currentColor" stroke="none"/></svg>`;
    },
    portfolioKindOf(id) {
      const t = this.subjectCache[id]?.source?.type;
      return t === "framework" ? "framework" : "wallets";
    },

    // ── what a portfolio points at ───────────────────────────────────────
    // The rows said who operates a portfolio and how often it is reviewed,
    // and never what it actually IS: three of the four are real addresses on
    // real chains, and the fourth has none because it is the target recipe
    // the vault is measured against. That is the most load-bearing difference
    // between them and it was invisible.
    chainsOf(list) {
      return [...new Set((list || []).map((w) => String(w?.chain || "").trim()).filter(Boolean))];
    },
    walletsLine(p) {
      const n = p?.wallets?.length || 0;
      if (!n) return "";
      const chains = this.chainsOf(p.wallets);
      const noun = n === 1 ? "wallet" : "wallets";
      return chains.length ? `${n} ${noun} on ${chains.join(", ")}` : `${n} ${noun}`;
    },
    blurbOf(p) { return rowBlurb(p); },
    // Counted rather than written. Stage 5 of this redesign turns three
    // portfolios into two by making a subject inactive, and a hardcoded
    // "Three" is the one line that would go quietly wrong when it does.
    portfolioLede() {
      const n = this.portfolios().length;
      const word = ["No", "One", "Two", "Three", "Four", "Five"][n] ?? String(n);
      const noun = n === 1 ? "portfolio" : "portfolios";
      return `${word} ${noun}. One is reviewed per session, and each review ends in a verdict or a recommendation.`;
    },
    portfolios() {
      const map = new Map();
      for (const s of this.publishedSessions()) {
        if (!this.isListedSubject(s.subjectId)) continue;
        const id = this.portfolioIdOf(s);
        if (!id) continue;
        const meta = this.subjectCache[id] || {};
        const row = map.get(id) || {
          id,
          name: meta.name || s.subjectName || id,
          operator: operatorName(meta.operator),
          thesisBlurb: meta.thesisBlurb || null,
          isVault: meta.source?.type === "vault_tvl",
          // What KIND of thing this is, and what it points at. `framework` has
          // no wallets because it IS the recipe rather than a book of
          // holdings, which is the one distinction the row never drew.
          isFramework: meta.source?.type === "framework",
          wallets: Array.isArray(meta.wallets) ? meta.wallets : [],
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
    otherPortfolios() { return this.portfolios().filter((p) => !p.isVault); },

    // A recommendation only carries target weights when the session published
    // `bucket_weights`. Sessions since the 2026-08-06 cutover carry
    // `position_actions` instead, so this returns null rather than inventing a
    // number, and the row says "no weight change" instead.
    // ── sessions ─────────────────────────────────────────────────────────
    // Portfolio encoding + filter, identical in behaviour to the member
    // profile's track record — the roster is the same problem at larger scale
    // (every portfolio interleaved by date), and the two lists must not teach
    // different conventions for the same data.
    subjectFilter: null,

    // Filter chips: the allocation subject first, then each portfolio.
    // Filtering is by the session's own subjectId, so the vault chip is
    // holdings and the allocation chip is targets. Skip a portfolio whose
    // id is the allocation's: a framework that did not fold would otherwise
    // appear twice.
    sessionFilters() {
      const alloc = this.allocationSubject();
      const rows = [];
      if (alloc?.id) {
        const count = this.publishedSessions().filter((s) => s.subjectId === alloc.id).length;
        if (count) rows.push({ id: alloc.id, name: alloc.name, count });
      }
      for (const p of this.portfolios()) {
        if (alloc?.id && p.id === alloc.id) continue;
        rows.push({ id: p.id, name: p.name, count: p.count });
      }
      return rows;
    },
    filterBy(id) { this.subjectFilter = this.subjectFilter === id ? null : id; this.shown = SESSIONS_SHOWN_STEP; },
    visibleSessions() {
      const rows = this.publishedSessions();
      const filtered = this.subjectFilter
        ? rows.filter((s) => s.subjectId === this.subjectFilter)
        : rows;
      return filtered.slice(0, this.shown);
    },
    matchingCount() {
      const rows = this.publishedSessions();
      return this.subjectFilter ? rows.filter((s) => s.subjectId === this.subjectFilter).length : rows.length;
    },
    hasMore() { return this.shown < this.matchingCount(); },
    showMore() { this.shown += SESSIONS_SHOWN_STEP; },
    // The aggregator fills `synthesis` by joining every take body (see
    // backend swarm/domain.ts), so the preview under each row was a wall of
    // raw markdown that opened with "**REGIME**" on EVERY row — identical text
    // twenty times over, which is worse than no preview at all. Show it only
    // when it is genuinely a summary rather than a dump of the takes.
    //
    // NO LONGER RENDERED. The card states the recommendation now, and the
    // synthesis is the reasoning behind it rather than the result. Kept
    // because scripts/tests/unit/swarm-synthesis-preview.test.ts covers it and
    // that tree is not this lane's to edit; the two should go together.
    synthesisPreview(s) {
      const t = String(s?.synthesis || "").trim();
      if (!t || t.includes("**") || t.length > 600) return "";
      return t;
    },

    // ── members ──────────────────────────────────────────────────────────
    memberRole() { return DEFAULT_ROLE; },
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
    // ── what a session came out with ─────────────────────────────────────
    // stanceSpread / lean / quorum / recommendation come from
    // lib/session-summary.js, spread into this component above. A subject
    // profile lists the same sessions this page does and must not read them a
    // second way.
    closedAgo(s) { return timeAgo(s?.windowClosesAt, this.now); },
    closedAbsolute(s) { return absoluteUtc(s?.windowClosesAt); },
    fmtPct(value) {
      const n = Number(value);
      return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "";
    },

    // One ramp, in lib/stance.js. This used to hold a second copy of the five
    // colours, so the same stance could be painted differently here than on a
    // member profile.
    stanceColor(s) { return stanceColor(s); },
    stanceClass(s) { return stanceClass(s); },
    stanceStyle(s) { return stanceStyle(s); },
    formatDate(value, style = "short") {
      const date = String(value || "").includes("T") ? new Date(value) : new Date(`${value}T00:00:00Z`);
      const opts = style === "long"
        ? { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }
        : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
      try { return date.toLocaleDateString("en-US", opts); } catch (_) { return value; }
    },
  }));
}
