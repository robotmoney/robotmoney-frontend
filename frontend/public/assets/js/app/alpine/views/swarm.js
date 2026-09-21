// @ts-nocheck — buildless browser JS predating the root tsconfig's checkJs
// coverage; issue #358 is the first thing to import this module from a
import { sessionPhase, isLiveState } from "../../lib/session-phase.js";
import { timeAgo, timeLeft, absoluteUtc } from "../../lib/relative-time.js";
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
import { allocationFramework } from "../../lib/allocation-framework.js";
import { memberLogo } from "../../lib/member-logos.js";
import { CATEGORICAL } from "../../lib/chart-theme.js";
import { helpers, loadArchiveMember, loadArchiveSession, loadArchiveSubject, KNOWN_ARCHIVE_MEMBERS,
  referenceWeights, targetsInForce, withinBucketsFor, explorerAssets, normKeyOf } from "../static-views.js";
import * as weightChange from "../../lib/weight-change.js";
import { analystCount, isJudge, roleLabel } from "../../lib/judgements.js";

// What the shared take card (lib/take-card.js) reads off its host: the
// signature seal's wording and mark, the receipt link, and the take body's
// markdown. Taken from static-views' helpers rather than copied, so the seal
// says the same thing on /swarm as on a session and a member's page.
const takeCardHost = {
  verifyState: helpers.verifyState,
  verifyLabel: helpers.verifyLabel,
  verifyTip: helpers.verifyTip,
  verifyPath: helpers.verifyPath,
  takeHref: helpers.takeHref,
  escapeHtml: helpers.escapeHtml,
  inlineMarks: helpers.inlineMarks,
  linkified: helpers.linkified,
};

// A seat is an analyst unless the roster says it judges (lib/judgements.js
// roleLabel). The projection emits `role` since #1017 ("member" | "judge"); a
// roster from before it has none, and every seat on it is an analyst.

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
  "Robot Money Vault": "Depositor capital in the ERC-4626 vault. One implementation of the Robot Money Allocation.",
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
    ...takeCardHost,
    ...allocationFramework(),
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
    destroy() {
      if (this.liveTimer) { clearInterval(this.liveTimer); this.liveTimer = null; }
    },
    async load() {
      this.liveTimer = setInterval(() => { this.now = Date.now(); }, LIVE_TICK_MS);
      try {
        // The shipped archive stands in when the API is not there (a
        // backendless checkout), the same fallback every other swarm page
        // takes, so the directory still reads.
        const [memberData, sessionData] = await Promise.all([
          api.get(ROUTES.swarm.members).catch(() => this.archiveMembers()),
          this.loadAllSessions().catch(() => this.archiveSessions()),
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
      } catch (_) {
        // Our sentence, not the exception's: a raw "Failed to fetch" is
        // machine noise to a reader.
        this.error = "The swarm could not be loaded.";
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
        if (res.nextSessionAt !== undefined) this.nextSessionAt = res.nextSessionAt;
        cursor = res.nextCursor || null;
        if (!cursor) return rows;
      }
      // Ran out of pages before the cursor ran out. Say so rather than
      // silently presenting a partial set as the total.
      this.sessionsTruncated = true;
      return rows;
    },
    // ── the shipped archive, when there is no API ─────────────────────────
    async archiveMembers() {
      const members = await Promise.all(KNOWN_ARCHIVE_MEMBERS.map((id) => loadArchiveMember(id).catch(() => null)));
      return { members: members.filter(Boolean), rosterCap: null, seatsAvailable: null };
    },
    // Every archived session, published, newest first, each carrying its takes
    // as `takeRows` so a card's takes open without asking an API that is not
    // there. The composite `${date}-${subjectId}` id is what sessionHref()
    // turns back into the dated address.
    async archiveSessions() {
      const index = await fetch("/data/swarm/sessions/index.json").then((r) => (r.ok ? r.json() : { sessions: [] }));
      const rows = await Promise.all((index.sessions || []).map(async (e) => {
        const subjectId = e.subjectId ?? e.subject_id;
        try {
          const d = await loadArchiveSession(e.date, subjectId);
          return {
            ...d.session,
            id: `${e.date}-${subjectId}`,
            date: e.date,
            subjectId,
            subjectName: d.session?.subjectName || e.subjectName || e.subject_name || subjectId,
            state: "published",
            takes: (d.takes || []).length,
            takeRows: d.takes || [],
          };
        } catch (_) { return null; }
      }));
      // Two subjects can convene on one date; the later one leads, as each row
      // prints its time.
      return rows.filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date))
        || String(b.generatedAt || b.publishedAt || "").localeCompare(String(a.generatedAt || a.publishedAt || "")));
    },
    async loadSubjects() {
      const ids = [...new Set(this.sessions.map((s) => s.subjectId).filter(Boolean))];
      // The API answers null for a subject it does not hold, so the archive
      // manifest is asked on a miss as well as on a failure.
      const rows = await Promise.all(
        ids.map(async (id) => (await api.get(path(ROUTES.swarm.subject, { id })).catch(() => null))
          || loadArchiveSubject(id).catch(() => null)),
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
      await this.loadAllocationFw();
      // The brief the latest allocation session opened with: the only honest
      // source of the target its recommendation is measured against, and of
      // the asset names inside each sleeve.
      const s = this.allocShown();
      if (s) this.allocBrief = await this.briefFor(s);
    },
    async briefFor(s) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(s?.id || ""))) {
        const b = await api.get(ROUTES.swarm.brief, { session: s.id }).catch(() => null);
        if (b && !b.error) return b;
      }
      return fetch(`/data/swarm/briefs/${s.date}-${s.subjectId}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    },

    // ── the research record's pieces (RM-121) ────────────────────────────
    // /swarm reads like the subject and session pages: a row of facts, the
    // flagship allocation's latest recommendation as the explorable ring, the
    // portfolios and the recommendation history as tables.
    nextSessionAt: null,
    allocBrief: null,
    facts() {
      const published = this.publishedSessions();
      const latest = published.reduce((acc, s) => (!acc || String(s.date) > String(acc) ? s.date : acc), null);
      // Members who file takes: a judge sits on the roster and files none.
      const rows = [
        { k: "Members", v: String(analystCount(this.members)) },
        { k: "Subjects", v: String(this.sessionFilters().length) },
        { k: "Sessions", v: String(published.length) },
      ];
      if (latest) rows.push({ k: "Latest session", v: this.formatDate(latest) });
      // Dated as "Latest session" is, with the hour it convenes.
      if (this.nextSessionAt) {
        const at = absoluteUtc(this.nextSessionAt);
        if (at) rows.push({ k: "Next session", v: `${this.formatDate(this.nextSessionAt)} ${at.slice(11)}` });
      }
      return rows;
    },
    // The newest published session on the allocation subject.
    allocLatest() {
      const id = this.allocationSubject()?.id || ALLOCATION_SUBJECT_ID;
      return this.publishedSessions().filter((s) => s.subjectId === id)[0] || null;
    },
    // The session the flagship draws: the newest that published weights. A
    // newer one that published none left the target where it was, so the
    // ring keeps the weights that stand; allocHeldBy() names the newer one.
    allocShown() {
      const id = this.allocationSubject()?.id || ALLOCATION_SUBJECT_ID;
      return this.publishedSessions().find((s) => s.subjectId === id && this.mixOf(s).length) || this.allocLatest();
    },
    allocHeldBy() {
      const latest = this.allocLatest();
      return latest && latest !== this.allocShown() ? latest : null;
    },
    // The target the latest allocation session is measured against: the one
    // its brief handed over, else the published target when it was already in
    // force that day, as the session page reads it.
    allocReference() {
      const s = this.allocShown();
      return referenceWeights(this.allocBrief) || (s?.referenceAllocation ? referenceWeights({ allocation: s.referenceAllocation }) : null)
        || targetsInForce(this.allocationFw, s?.date);
    },
    // The explorer (lib/sleeve-explorer.js) reads these, as it does on the
    // subject and session pages.
    hasBook() { return false; },
    explorerSource() { return this.allocShown(); },
    explorerSvg() { return this.weightDonutSvg(this.allocShown()); },
    // At rest the centre names the ring and nothing more: a recommended mix
    // is the whole allocation by definition, so "100%" says nothing.
    explorerCenter() { return { value: "", label: "Recommended" }; },
    explorerLabel() {
      return this.explorerRows().filter((r) => r.pct > 0).map((r) => `${r.label} ${this.fmtPctTrim(r.pct)}`).join(", ");
    },
    explorerRows() {
      const s = this.allocShown();
      const rows = this.sessionWeights(s) || [];
      const ref = this.allocReference();
      const sleeveWeight = new Map(rows.map((r) => [normKeyOf(r.key), r.pct / 100]));
      const within = new Map(withinBucketsFor(s?.swarmRecommendation, this.allocBrief, null, sleeveWeight).map((w) => [normKeyOf(w.bucket), w]));
      return rows.map((r) => {
        const was = ref ? (ref[r.key] ?? null) : null;
        return {
          key: r.key, label: r.label, hue: r.colour, pct: r.pct,
          meta: "", action: "", rationale: "",
          d: ref ? weightChange.weightDelta(r.pct, was) : null, was, basis: "target",
          assets: explorerAssets(within.get(normKeyOf(r.label)) || within.get(normKeyOf(r.key)), r.pct),
        };
      });
    },
    // Only what the legend cannot show, as on the subject and session pages:
    // that no sleeve moved. A count of moves is the legend's rows that carry one.
    allocOutcome() {
      if (!this.allocReference()) return "";
      return this.explorerRows().some((r) => r.d != null && r.d !== 0) ? "" : "Target weights retained";
    },
    fmtPctTrim(v) { return weightChange.fmtPctTrim(v); },
    changeLabel(d) { return weightChange.changeLabel(d); },
    changeClass(d) { return weightChange.changeClass(d); },
    // A portfolio's newest published session, its own and not a folded one.
    portfolioLatest(p) {
      return this.publishedSessions().find((s) => s.subjectId === p.id)
        || this.publishedSessions().find((s) => this.parentFor(s.subjectId) === p.id) || null;
    },
    // A weights recommendation as its four figures, in the published order.
    mixOf(s) { return this.sessionWeights(s) || []; },
    // A weights row's moves against the target ITS OWN session was handed
    // (the list carries it once #991 lands), else the published target when it
    // was already in force that day. None without either.
    movesOf(s) {
      const ref = this.referenceOf(s);
      if (!ref) return [];
      return this.mixOf(s)
        .map((r) => ({ key: r.key, label: r.label, d: weightChange.weightDelta(r.pct, ref[r.key] ?? null) }))
        .filter((m) => m.d != null && m.d !== 0);
    },
    /** @param {any} s */
    referenceOf(s) {
      return (s?.referenceAllocation ? referenceWeights({ allocation: s.referenceAllocation }) : null) || targetsInForce(this.allocationFw, s?.date);
    },
    // A history row's verdict, in one word: did the session change anything.
    // What changed, and by how much, is its session page's to say; listing
    // every sleeve or position here made a column of mixed figures and chips.
    // Rebalance when a weights session moved a sleeve against the target it
    // was handed, or a portfolio session changed a position; Hold when it
    // moved nothing. Otherwise the row names the gap, quietly.
    /** @param {any} s */
    verdictOf(s) {
      const rec = this.recommendation(s);
      if (!rec) return { label: "No recommendation published", quiet: true };
      if (rec.kind === "weights") {
        if (!this.referenceOf(s)) return { label: "No target recorded", quiet: true };
        return { label: this.movesOf(s).length ? "Rebalance" : "Hold", quiet: false };
      }
      if (this.rowActions(s).length) return { label: "Rebalance", quiet: false };
      if (this.rowHeld(s).length) return { label: "Hold", quiet: false };
      return { label: "No position calls", quiet: true };
    },
    takesOf(s) {
      const n = this.takesCount(s);
      return n ? `${n} ${n === 1 ? "take" : "takes"}` : "";
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
      const seats = analystCount(this.members);
      if (n == null || !seats) return "";
      return `${n} of ${seats} takes filed`;
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
      // A session with no deadline is open, but there is no countdown to show.
      return timeLeft(this.liveSession()?.windowClosesAt, this.now);
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
      return chains.length ? `${n} ${noun} on ${chains.map((c) => this.chainLabel(c)).join(", ")}` : `${n} ${noun}`;
    },
    blurbOf(p) { return rowBlurb(p); },
    // Counted rather than written. Stage 5 of this redesign turns three
    // portfolios into two by making a subject inactive, and a hardcoded
    // "Three" is the one line that would go quietly wrong when it does.
    portfolioLede() {
      const n = this.portfolios().length;
      const word = ["No", "One", "Two", "Three", "Four", "Five"][n] ?? String(n);
      const noun = n === 1 ? "portfolio" : "portfolios";
      return `${word} ${noun}. Each session convenes on one, and a published session ends in a recommendation.`;
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
    memberRole(m) { return roleLabel(m); },
    // The Role tip describes a judge only once one is seated.
    hasJudge() { return this.members.some(isJudge); },
    // The seats beside the Apply button: how many are open, of how many. The
    // members holding the rest are the facts row's count.
    openSeatsLabel() {
      if (this.seatsAvailable == null) return "";
      if (this.seatsAvailable <= 0) return "No seats open right now";
      if (this.rosterCap != null) return `${this.seatsAvailable} of ${this.rosterCap} seats open`;
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
