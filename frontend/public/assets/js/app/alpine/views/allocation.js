// Alpine factory for /allocation — the allocation as a POLICY (RM-115,
// container rule RM-114), and where it meets the four vaults that carry it out.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP: it never reads wallet-balances or
// wallet-sleeves. Those are the three protocol-owned prop wallets — the house
// book, a different pot of money with different owners, moving to the token
// page under RM-103. The page this replaced added the two together under one
// "Total AUM" heading, which on 2026-09-02 put a $229 vault inside a $59.4k
// figure, 0.4% of the number a reader took for the vault, while backend
// config.ts throws at boot if a prop wallet is ever configured as the vault
// ("would double-count vault TVL"). A reviewer should check that exclusion
// before anything else.
//
// Two reads, each settling on its own so one degraded feed leaves only its own
// part of the page on "—":
//   the policy   lib/allocation-framework.js loadAllocationDto():
//                GET /api/dashboards/allocation, the four sleeve targets and
//                their constituents, plus `asOf`. The shipped manifest stands
//                in on a local host only. NOT `source`: on this DTO that is the
//                Base RPC source, not the provenance of the weights.
//   the vaults   lib/vault-source.js loadVaultOverview(): the four vaults'
//                Recommended, Applied and Actual weights, the gaps between
//                them, combined TVL, tracking error, the router and the latest
//                published robotmoney-allocation recommendation. The source
//                (the four-vault route, the Base feed, the saved snapshot or
//                the devnet fixtures) is the mock-data switch documented in
//                vault-source.js, and its label rides on the Vaults section.
//
// Asset-level holdings are on each vault's page (/vault/:slug). This page keeps
// the recipe: each sleeve's target constituents.
//
// NOT live, and said so on the page:
//   * A second version of the weights. `allocation_framework` has one writer,
//     the database seed, so the change ledger's `was` is the row in force and
//     every row reads flat until something can write another.
import { CATEGORICAL } from "../../lib/chart-theme.js";
import { ALLOCATION_SUBJECT_ID, VAULT_SUBJECT_ID } from "../../lib/allocation-subject.js";
import { loadAllocationDto } from "../../lib/allocation-framework.js";
import { loadLatestRecommendation, loadVaultOverview } from "../../lib/vault-source.js";
import { sessionTakes } from "../../lib/session-takes.js";

// sessionTakes() is a mixin factory; the panel needs only its session address.
const { sessionHref } = sessionTakes();
import { stanceColor } from "../../lib/stance.js";
import { helpers } from "../static-views.js";
import {
  VAULTS,
  explorerLink,
  fmtBps,
  fmtDate,
  fmtUsd,
  freshnessLabel,
  gapParts,
  hasTargetLayer,
  recommendationDate,
  recommendationHref,
  sleeveNote,
  statusLabel,
  vaultForBucket,
} from "../../lib/vault-data.js";
import * as weightChange from "../../lib/weight-change.js";
import { sessionSummary, bucketShort } from "../../lib/session-summary.js";
import { loadRoster } from "../../lib/judgements.js";

const shortAddress = (a) => {
  const s = String(a || "");
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};

// ── the palette ────────────────────────────────────────────────────────────
// CATEGORICAL from lib/chart-theme.js, whose own comment is the argument: pie
// and donut slices are DISTINCT ENTITIES, separated by HUE and never by
// lightness, because "a green luminance ramp reads as one indistinct blob the
// moment the slices are categories rather than one quantity's intensity".
// This page drew exactly that ramp until it was measured: four green steps
// separate at CVD dE 7.1 against 18.2 for the categorical front four, and a
// normal-vision floor below 15 means full-colour readers cannot tell the pair
// apart either.
//
// Sleeves take CATEGORICAL by POSITION, all four of them, so a sleeve keeps
// its hue whether or not it is funded and the legend row for a 0% sleeve is
// keyed to the colour its arc would have. The vault that implements a sleeve
// wears the same hue (lib/vault-data.js VAULTS[i].color === CATEGORICAL[i]).
// Constituents restart at the front inside their own sleeve, which is what the
// mini bucket pies already do.
const sleeveColour = (i) => CATEGORICAL[i % CATEGORICAL.length];
const itemColour = (i) => CATEGORICAL[i % CATEGORICAL.length];

export function registerAllocationView(Alpine) {
  Alpine.data("allocationView", () => ({
    allocationFw: null, // loadAllocationDto(): GET /api/dashboards/allocation
    vaults: null,       // loadVaultOverview(): { overview, source, label, error, ... }
    loading: true,      // the policy; the vaults fill their own rows as they land
    // loadLatestRecommendation(): the newest allocation session that published
    // weights, and the newest of all. The panel beside the ring reads them.
    recSession: null,
    recLatest: null,
    recLoaded: false,
    recError: false,
    // The public roster, read only when a judge worked on that session: its
    // name goes over the words it wrote, and a seated judge is no seat a take
    // could fill (lib/judgements.js).
    recRoster: [],

    // The allocation's own decision log is not built yet, so the sessions
    // live where the swarm keeps them.
    historyHref: `/swarm/subjects/${ALLOCATION_SUBJECT_ID}`,
    // The swarm's page for the vaults: their combined book over time.
    vaultSubjectHref: `/swarm/subjects/${VAULT_SUBJECT_ID}`,

    fmtBps,
    gapParts,

    init() {
      this.load();
    },

    // Both reads are fetched independently (allSettled semantics), so one
    // degraded feed leaves only its own part of the page on "—" rather than
    // blanking a page about money. A failed read becomes null, never a
    // fabricated value. The policy does not wait for the vaults: the Vaults
    // table holds its four rows from the first paint and fills them in.
    //
    // The policy and the recommendation are read once and handed to the
    // vaults' read too: the policy's targets are the vaults' targets, and the
    // recommendation walks the session list, which is not walked twice.
    async load() {
      const host = location.hostname;
      const policyRead = loadAllocationDto(host);
      const recRead = loadLatestRecommendation({ hostname: host }).catch(() => ({ rec: null, error: true }));
      const policy = policyRead
        .then((d) => { this.allocationFw = d ?? null; }, () => { this.allocationFw = null; })
        .finally(() => {
          this.loading = false;
        });
      const rec = recRead.then(async (r) => {
        // Before the panel draws, so a judge's name never flashes as its id.
        if (r?.session?.swarmRecommendation?.judge) this.recRoster = await loadRoster();
        this.recSession = r?.session ?? null;
        this.recLatest = r?.latest ?? null;
        this.recError = !!r?.error;
      }).finally(() => { this.recLoaded = true; });
      const vaults = loadVaultOverview({ hostname: host, recommendation: recRead, policy: policyRead })
        .then((r) => { this.vaults = r; }, () => { this.vaults = { overview: null, label: null }; });
      await Promise.allSettled([policy, rec, vaults]);
    },

    // A target weight at one decimal with a trailing ".0" trimmed: 95%, 14.3%.
    // Shared with a session's outcome (lib/weight-change.js).
    fmtPct(v) { return v == null || !isFinite(v) ? "—" : Number(v).toFixed(2) + "%"; },
    fmtPctTrim(v) { return weightChange.fmtPctTrim(v); },
    fmtPctTrimBare(v) { return weightChange.fmtPctTrimBare(v); },

    // ── the allocation in force ─────────────────────────────────────────────
    allocationAsOf() { return this.allocationFw?.asOf || null; },
    // "Jun 2, 2026": the date format of every other date on the page.
    allocationAsOfLabel() {
      const asOf = this.allocationAsOf();
      return asOf ? fmtDate(asOf) : "—";
    },
    hasTargets() { return this.sleeves().length > 0; },
    // The state chip, and the one place on this page it would be easy to lie.
    //
    // NEITHER FIELD ON THIS DTO ANSWERS THE QUESTION. `source` is
    // resolveBaseRpcSource() — whether the Base RPC is live or the hermetic
    // stub — which has nothing to do with where a row of weights came from,
    // and `managed` is hardcoded `true` in
    // backend/src/chain/allocation-framework.ts. Keying the chip on either one
    // would print "swarm-managed" on production for a row the database seed
    // wrote.
    //
    // A row a session actually produced will carry PROVENANCE: the session id
    // and the receipt digest behind it, which is RM-115's closing backend ask.
    // Nothing writes that field today, so this is false for every row the API
    // serves and the chip reads "seeded" — which is true. It is not hardcoded:
    // the day the field arrives the chip flips with no edit here.
    isSwarmManaged() {
      return this.hasTargets() && !!this.allocationFw?.provenance?.sessionId;
    },
    // "—" until the weights land, and when they cannot be read: the empty
    // ring under the rail says so.
    stateChip() {
      if (!this.hasTargets()) return "—";
      return this.isSwarmManaged() ? "swarm-managed" : "seeded";
    },

    // ── sleeves: the policy ─────────────────────────────────────────────────
    sleeves() {
      const buckets = this.allocationFw?.buckets || [];
      const strategy = this.allocationFw?.strategy || [];
      return buckets.map((b, i) => ({
        key: b.key,
        // The served label, never a local rename: /swarm prints these same
        // four strings from the same DTO, and two product surfaces naming
        // the same sleeve differently is worse than an inelegant label.
        name: b.label || strategy[i]?.label || b.key,
        target: Number(strategy[i]?.targetPct ?? 0),
      }));
    },
    // The legend swatch. Every sleeve carries its hue, funded or not: the
    // colour identifies the sleeve, and a sleeve at zero is still the same
    // sleeve. Its row is dimmed by the view instead, which says "holds
    // nothing" without also saying "has no identity".
    sleeveSwatch(s) {
      return `background:${this.sleeveColours()[s.key] || "var(--color-border-light)"}`;
    },
    // Keyed on POSITION in the published order, so a sleeve keeps its hue when
    // another one's weight changes. Colour follows the entity, never its rank.
    sleeveColours() {
      return Object.fromEntries(this.sleeves().map((row, i) => [row.key, sleeveColour(i)]));
    },
    // The weights in force as the ring every swarm page draws: the hover and
    // focus are lib/sleeve-explorer.js, the arcs session-summary's ringSvg.
    // Not normalised to its own sum: a policy that does not add to 100 leaves
    // the remainder of the track unfilled, and the centre names it.
    //
    // Beside each target, where the money is: the share of the four vaults'
    // combined TVL held by the sleeve's vault (one vault per sleeve), and the
    // gap between them in points. Selecting a sleeve opens its recipe.
    explorerRows() {
      const colours = this.sleeveColours();
      return this.sleeves().map((s) => {
        const bps = this.vaultRecord(vaultForBucket(s.key)?.slug ?? "")?.actualBps;
        const actual = typeof bps === "number" && isFinite(bps) ? bps / 100 : null;
        const items = this.constituents(s.key);
        return {
          key: s.key, label: s.name, hue: colours[s.key], pct: s.target, meta: "",
          actual,
          d: actual == null ? null : Math.round((actual - s.target) * 100) / 100,
          assets: items.map((c, i) => ({
            key: `${s.key}-${c.label}`, label: c.label, colour: itemColour(i),
            ofSleeve: c.target, ofAllocation: (c.target * s.target) / 100,
          })),
        };
      });
    },
    // Actual and Gap have their columns once the vaults answer; a sleeve whose
    // vault could not be read reads "—" there.
    hasActual() { return !!this.overview(); },
    explorerSvg() { return sessionSummary.ringSvg(this.explorerRows().map((r) => ({ ...r, colour: r.hue }))); },
    explorerLabel() { return this.explorerRows().map((r) => `${r.label} ${this.fmtPctTrim(r.pct)}`).join(", "); },
    ringRestLabel() {
      const gap = 100 - this.sleeves().reduce((n, r) => n + (Number(r.target) || 0), 0);
      return Math.abs(gap) >= 0.005 ? `${this.fmtPctTrim(Math.abs(gap))} ${gap > 0 ? "unallocated" : "over"}` : "In force";
    },
    hasBook() { return false; },
    // The recipe panel's (i), and the legend's short names on a phone.
    bucketNote(key) { return sleeveNote(key); },
    bucketShort(name) { return bucketShort(name); },
    // Constituents restart at the front of the palette inside their own
    // sleeve, keyed on the constituent's index in the POLICY.
    constituentColour(i) { return itemColour(i); },
    // Empty for a bucket key we have no copy for, which renders nothing rather
    // than a placeholder (lib/vault-data.js SLEEVE_NOTE, shared with each
    // vault page's lede).
    sleeveNote(key) { return sleeveNote(key); },

    // ── the latest recommendation, beside the ring ──────────────────────────
    // As /swarm sets it beside its ring: the newest allocation session that
    // published weights, why, and the way to it. A newer session that
    // published none held the target, and is named above the rest.
    recHeldBy() {
      const latest = this.recLatest;
      return latest && this.recSession && latest.id !== this.recSession.id ? latest : null;
    },
    recDate(s) { return s?.date ? fmtDate(s.date) : ""; },
    recHref(s) { return sessionHref(s); },
    recRationale() { return sessionSummary.rationaleOf.call(sessionSummary, this.recSession); },
    // "Judge · <name>" over a rationale a judge wrote.
    recRationaleLabel() { return sessionSummary.rationaleJudgeLabel.call(sessionSummary, this.recSession, this.recRoster); },
    recTally() { return this.recSession ? sessionSummary.stanceTally.call(sessionSummary, this.recSession) : []; },
    recTallyNote() {
      const s = this.recSession;
      return s ? [sessionSummary.turnoutText.call(sessionSummary, s, this.recRoster), sessionSummary.meanConfidenceText.call(sessionSummary, s)].filter(Boolean).join(" · ") : "";
    },
    linkified(text) { return helpers.linkified(text); },
    stanceColor(s) { return stanceColor(s); },

    // ── constituents (small multiples) ──────────────────────────────────────
    // Within-sleeve target weights: the recipe. What a vault actually holds is
    // on that vault's page.
    constituents(sleeveKey) {
      const bucket = (this.allocationFw?.buckets || []).find((b) => b.key === sleeveKey);
      if (!bucket) return [];
      return (bucket.items || []).map((item) => ({ label: item.label, target: Number(item.targetPct ?? 0) }));
    },

    // ── the change ledger ───────────────────────────────────────────────────
    // Was, now, and the move between them, one row per sleeve. Today every
    // row is flat and the table says so in four "—"s rather than being hidden:
    // "28 sessions looked at these weights and left them" is the finding, and
    // a section that disappears when nothing changed cannot report it.
    //
    // `was` is not a second reading. `allocation_framework` has one writer and
    // one row, so there is no prior version to diff against and the baseline
    // IS the row in force. The day a session writes a second row, `was` comes
    // from it and these arrows start moving with no change to the view.
    changeRows() {
      return this.sleeves().map((row, i) => ({
        key: row.key,
        name: row.name,
        colour: sleeveColour(i),
        was: row.target,
        now: row.target,
        delta: 0,
      }));
    },
    // Direction is the GLYPH first and the colour second, so the column
    // survives colourblindness, greyscale and forced-colors. Up takes Pool
    // green and down takes Beacon, which is what tokens.css already calls a
    // point for loss and attention: here it is one arrow at type size.
    // One implementation with a session's outcome (lib/weight-change.js), so
    // the same move cannot read two ways on two pages.
    changeLabel(d) { return weightChange.changeLabel(d); },
    changeClass(d) { return weightChange.changeClass(d); },

    // ── the four vaults ─────────────────────────────────────────────────────
    // One overview for the whole section (lib/vault-data.js normalizeOverview):
    // the page never recomputes a weight or a gap of its own.
    overview() { return this.vaults?.overview ?? null; },
    // Answered, and with nothing to show.
    vaultError() { return !!this.vaults && !this.vaults.overview; },
    // "Devnet test data", "Saved Base snapshot", "Stub data", or none.
    vaultLabel() { return this.overview() ? this.vaults?.label ?? null : null; },
    networkLabel() { return this.overview()?.network?.label || "—"; },
    // The overview's row for a vault identity, or null before it lands.
    vaultRecord(slug) { return this.overview()?.vaults?.find((r) => r.slug === slug) ?? null; },
    // A vault's status beside its name only when it is not simply active;
    // "Not live", since the Network fact above the table names the network.
    vaultStatusOf(slug) {
      const o = this.overview();
      if (!o) return null;
      const r = this.vaultRecord(slug);
      if (r?.availability === "not_on_network") return "Not live";
      const s = statusLabel(r, o.network?.label);
      return s === "Active" ? null : s;
    },
    // Recommended, Target and Actual once there is a target to read (the
    // router's weights, else the published policy's), with the governance and
    // flow gaps between them. Without one, Recommended and Actual, and the
    // one gap between them.
    threeLayers() { return hasTargetLayer(this.overview()); },
    // A weight in whole dollars at the combined TVL; Actual's are the vault's
    // own TVL. A gap in dollars is the difference of the two dollar figures
    // beside it, not its points re-priced, so the row adds up as printed:
    // $250 against $238 is "+$12", as the pp beside it reads "+5 pp".
    usdAt(bps) {
      const tvl = this.overview()?.combined?.tvlUsd;
      return typeof bps === "number" && isFinite(bps) && typeof tvl === "number" ? Math.round((bps / 10000) * tvl) : null;
    },
    actualUsd(r) {
      if (r?.availability === "not_on_network") return 0;
      return typeof r?.tvlUsd === "number" ? Math.round(r.tvlUsd) : null;
    },
    usdLabel(v) { return v === null ? "" : fmtUsd(v); },
    usdGap(a, b) {
      if (a === null || b === null) return "";
      const d = a - b;
      return d === 0 ? "$0" : `${d > 0 ? "+" : "−"}${fmtUsd(Math.abs(d))}`;
    },
    // The four identities from the first paint, so the table holds its shape
    // while the figures load; every figure reads "—" until then.
    vaultRows() {
      return VAULTS.map((id) => {
        const r = this.vaultRecord(id.slug);
        const status = this.vaultStatusOf(id.slug);
        // Only figures the row also prints as a weight get dollars.
        const usd = {
          recommended: r?.recommendedBps == null ? null : this.usdAt(r.recommendedBps),
          target: r?.targetBps == null ? null : this.usdAt(r.targetBps),
          actual: r?.actualBps == null ? null : this.actualUsd(r),
        };
        return {
          slug: id.slug,
          symbol: id.symbol,
          color: id.color,
          href: `/vault/${id.slug}`,
          sub: status ? `${id.name} · ${status}` : id.name,
          recommended: fmtBps(r?.recommendedBps),
          recommendedUsd: this.usdLabel(usd.recommended),
          target: fmtBps(r?.targetBps),
          targetUsd: this.usdLabel(usd.target),
          actual: fmtBps(r?.actualBps),
          actualUsd: this.usdLabel(usd.actual),
          governance: gapParts(r?.gaps?.governance),
          governanceUsd: this.usdGap(usd.target, usd.recommended),
          flow: gapParts(r?.gaps?.flow),
          flowUsd: this.usdGap(usd.actual, usd.target),
          gap: gapParts(r?.gaps?.total),
          gapUsd: this.usdGap(usd.actual, usd.recommended),
        };
      });
    },
    combinedLabel() { return fmtUsd(this.overview()?.combined?.tvlUsd); },
    trackingErrorLabel() { return fmtBps(this.overview()?.trackingErrorBps); },
    freshness() { return freshnessLabel(this.overview()); },
    recommendation() { return this.overview()?.recommendation ?? null; },
    recommendationDate() {
      const d = recommendationDate(this.recommendation());
      return d ? fmtDate(d) : null;
    },
    recommendationHref() { return recommendationHref(this.recommendation()); },
    // linked: a date that opens its session; date: a date with no record to
    // open; none: the source answered with no recommendation; unknown: not
    // loaded, or it could not be read.
    recState() {
      if (!this.overview()) return "unknown";
      const rec = this.recommendation();
      if (!rec) return this.vaults?.recommendationError ? "unknown" : "none";
      if (!this.recommendationDate()) return "unknown";
      return this.recommendationHref() ? "linked" : "date";
    },
    released() {
      const v = this.recommendation()?.releasedOnChain;
      return typeof v === "boolean" ? (v ? "Yes" : "No") : null;
    },

    // ── the router, on the meta rail ────────────────────────────────────────
    // It routes new deposits by the applied weights and holds nothing, so it
    // gets an address and no figure.
    router() { return this.overview()?.router ?? null; },
    routerHref() {
      const r = this.router();
      return r?.availability === "live" ? explorerLink(this.overview()?.network, r.address) : null;
    },
    routerShort() { return shortAddress(this.router()?.address); },
    routerLabel() {
      const r = this.router();
      if (r?.availability === "live") return "Live";
      if (r?.availability === "not_on_network") return `Not live on ${this.overview()?.network?.label || "this network"}`;
      return "—";
    },

    // ── the vault behind each sleeve ────────────────────────────────────────
    // Its symbol, to its page, in the sleeve's recipe. Its status is the
    // Vaults table's.
    vaultHref(key) {
      const v = vaultForBucket(key);
      return v ? `/vault/${v.slug}` : null;
    },
    vaultSymbol(key) { return vaultForBucket(key)?.symbol ?? ""; },

  }));
}
