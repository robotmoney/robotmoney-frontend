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
import { PALETTE, CATEGORICAL } from "../../lib/chart-theme.js";
import { ALLOCATION_SUBJECT_ID, VAULT_SUBJECT_ID } from "../../lib/allocation-subject.js";
import { loadAllocationDto } from "../../lib/allocation-framework.js";
import { loadVaultOverview } from "../../lib/vault-source.js";
import {
  VAULTS,
  explorerLink,
  fmtBps,
  fmtDate,
  fmtUsd,
  freshnessLabel,
  gapParts,
  hasAppliedLayer,
  recommendationDate,
  recommendationHref,
  sleeveNote,
  statusLabel,
  vaultForBucket,
} from "../../lib/vault-data.js";
import * as weightChange from "../../lib/weight-change.js";
import { bucketNote } from "../../lib/session-summary.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** @param {string} name @param {Record<string, string | number>} attrs */
function svg(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const key in attrs) node.setAttribute(key, String(attrs[key]));
  return node;
}
/** @param {Element} node @param {string} text */
function label(node, text) {
  node.textContent = text;
  return node;
}

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
// keyed to the colour its slice would have. The vault that implements a sleeve
// wears the same hue (lib/vault-data.js VAULTS[i].color === CATEGORICAL[i]).
// Constituents restart at the front inside their own sleeve, which is what the
// mini bucket pies already do.
const sleeveColour = (i) => CATEGORICAL[i % CATEGORICAL.length];
const itemColour = (i) => CATEGORICAL[i % CATEGORICAL.length];

/** One donut segment, as a path. Angles in degrees, clockwise from 12 o'clock. */
function donutArc(cx, cy, outer, inner, a0, a1) {
  // A whole ring cannot be one arc: its start and end points coincide, and an
  // SVG arc between two equal points draws nothing. Two half circles each way,
  // the inner ring wound against the outer so the hole stays open.
  if (a1 - a0 >= 359.999) {
    return `M${cx},${cy - outer} A${outer},${outer} 0 1 1 ${cx},${cy + outer}`
      + ` A${outer},${outer} 0 1 1 ${cx},${cy - outer}`
      + ` M${cx},${cy - inner} A${inner},${inner} 0 1 0 ${cx},${cy + inner}`
      + ` A${inner},${inner} 0 1 0 ${cx},${cy - inner} Z`;
  }
  const rad = (a) => ((a - 90) * Math.PI) / 180;
  const pt = (r, a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = pt(outer, a0);
  const [x1, y1] = pt(outer, a1);
  const [x2, y2] = pt(inner, a1);
  const [x3, y3] = pt(inner, a0);
  return `M${x0.toFixed(2)},${y0.toFixed(2)}`
    + ` A${outer},${outer} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`
    + ` L${x2.toFixed(2)},${y2.toFixed(2)}`
    + ` A${inner},${inner} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)}`
    + " Z";
}

export function registerAllocationView(Alpine) {
  Alpine.data("allocationView", () => ({
    allocationFw: null, // loadAllocationDto(): GET /api/dashboards/allocation
    vaults: null,       // loadVaultOverview(): { overview, source, label, error, ... }
    loading: true,      // the policy; the vaults fill their own rows as they land
    // The sleeve under the pointer, so the donut and its legend light together.
    hotKey: null,

    // The allocation's own decision log is not built yet, so the sessions
    // live where the swarm keeps them.
    historyHref: `/swarm/subjects/${ALLOCATION_SUBJECT_ID}`,
    // The swarm's page for the vaults: their combined book over time.
    vaultSubjectHref: `/swarm/subjects/${VAULT_SUBJECT_ID}`,

    fmtBps,
    gapParts,

    init() {
      this.load();
      this.$nextTick(() => this.draw());
    },

    // Both reads are fetched independently (allSettled semantics), so one
    // degraded feed leaves only its own part of the page on "—" rather than
    // blanking a page about money. A failed read becomes null, never a
    // fabricated value. The policy does not wait for the vaults: the Vaults
    // table holds its four rows from the first paint and fills them in.
    async load() {
      const host = location.hostname;
      const policy = loadAllocationDto(host)
        .then((d) => { this.allocationFw = d ?? null; }, () => { this.allocationFw = null; })
        .finally(() => {
          this.loading = false;
          this.$nextTick(() => this.draw());
        });
      const vaults = loadVaultOverview({ hostname: host })
        .then((r) => { this.vaults = r; }, () => { this.vaults = { overview: null, label: null }; });
      await Promise.allSettled([policy, vaults]);
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
    stateChip() {
      if (!this.hasTargets()) return "unavailable";
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
    // How many names are inside: the one question the donut cannot answer.
    // Which vault holds the sleeve is the Vaults table's to say.
    sleeveLegendLine(s) {
      const n = this.constituents(s.key).length;
      return `${n} asset${n === 1 ? "" : "s"}`;
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
    // Constituents restart at the front of the palette inside their own
    // sleeve, keyed on the constituent's index in the POLICY.
    constituentColour(i) { return itemColour(i); },
    // Empty for a bucket key we have no copy for, which renders nothing rather
    // than a placeholder (lib/vault-data.js SLEEVE_NOTE, shared with each
    // vault page's lede).
    sleeveNote(key) { return sleeveNote(key); },

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
    // Recommended, Applied and Actual once the router reports weights, with
    // the governance and flow gaps between them. Until then (Base today)
    // Recommended and Actual, and the one gap between them.
    threeLayers() { return hasAppliedLayer(this.overview()); },
    // The four identities from the first paint, so the table holds its shape
    // while the figures load; every figure reads "—" until then.
    vaultRows() {
      return VAULTS.map((id) => {
        const r = this.vaultRecord(id.slug);
        const status = this.vaultStatusOf(id.slug);
        return {
          slug: id.slug,
          symbol: id.symbol,
          color: id.color,
          href: `/vault/${id.slug}`,
          sub: status ? `${id.name} · ${status}` : id.name,
          tvl: fmtUsd(r?.tvlUsd),
          recommended: fmtBps(r?.recommendedBps),
          applied: fmtBps(r?.appliedBps),
          actual: fmtBps(r?.actualBps),
          governance: gapParts(r?.gaps?.governance),
          flow: gapParts(r?.gaps?.flow),
          gap: gapParts(r?.gaps?.total),
        };
      });
    },
    combinedLabel() { return fmtUsd(this.overview()?.combined?.tvlUsd); },
    liveLabel() {
      const n = this.overview()?.combined?.vaultsLive;
      return typeof n === "number" ? `${n} of ${VAULTS.length}` : "—";
    },
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

    // ── the vault behind each sleeve card ───────────────────────────────────
    // Its symbol, to its page. Its status is the Vaults table's.
    vaultHref(key) {
      const v = vaultForBucket(key);
      return v ? `/vault/${v.slug}` : null;
    },
    vaultSymbol(key) { return vaultForBucket(key)?.symbol ?? ""; },

    // ── the donut's hover layer ─────────────────────────────────────────────
    // Pointer only, and deliberately. Every figure the tooltip shows is
    // already on the page as text in the legend beside it, so making four
    // slices focusable would add tab stops that reach nothing new. The slices
    // keep their <title>, which is what a screen reader reads.
    // A constituent tooltip has to earn the hover, so it does NOT restate the
    // name and weight printed two lines below the bar as its headline: it adds
    // the same target read against the whole allocation rather than against
    // its sleeve.
    constituentTip(sleeve, item, index) {
      const hue = itemColour(index);
      const ofAlloc = (Number(item.target) * Number(sleeve.target)) / 100;
      return this.tipMarkup(hue, item.label, [
        ["Target in sleeve", this.fmtPct(item.target)],
        ["Target overall", this.fmtPct(ofAlloc), true],
      ]);
    },
    // A row's third element starts a new group: a hairline above it, because
    // the figure below the rule is measured against a different denominator
    // from the ones above it.
    tipMarkup(hue, title, rows) {
      let out = `<b><i style="background:${hue}"></i>${title}</b>`;
      out += rows.map(([k, v, sep]) =>
        `<span${sep ? ' class="alp__tip-sep"' : ""}><em>${k}</em>${v}</span>`).join("");
      return out;
    },
    // Viewport coordinates, because the tooltip is shared by the donut and by
    // every sleeve bar rather than living inside the figure.
    tipAt(html, ev) {
      const tip = this.$refs.allocTip;
      if (!tip) return;
      tip.innerHTML = html;
      tip.style.opacity = "1";
      this.moveTip(ev);
    },
    moveTip(ev) {
      const tip = this.$refs.allocTip;
      if (!tip || tip.style.opacity !== "1" || !ev) return;
      const pad = 14;
      const r = tip.getBoundingClientRect();
      let left = ev.clientX + pad;
      let top = ev.clientY + pad;
      if (left + r.width > window.innerWidth - 8) left = ev.clientX - r.width - pad;
      if (top + r.height > window.innerHeight - 8) top = ev.clientY - r.height - pad;
      tip.style.left = Math.max(8, left) + "px";
      tip.style.top = Math.max(8, top) + "px";
    },

    // Built through tipMarkup, like the constituent tooltip: one tooltip
    // object on the page, not two that happen to share a box.
    tipHtml(row) {
      const rows = [["Target", this.fmtPct(row.target)]];
      const items = this.constituents(row.key);
      if (items.length) rows.push(["Assets", String(items.length)]);
      return this.tipMarkup(this.sleeveColours()[row.key], row.name, rows);
    },
    // Inside a card: hovering a block lights its name and recedes its
    // neighbours, and hovering a name does the same to its block. Applied by
    // hand rather than through Alpine state because the cards come out of an
    // x-for and a per-card scope for one transient class would cost more than
    // it explains.
    hoverItem(ev, index, sleeve, item) {
      if (sleeve && item) this.tipAt(this.constituentTip(sleeve, item, index), ev);
      const card = ev.currentTarget.closest(".alp__card");
      if (!card) return;
      card.querySelectorAll(".alp__stk > span").forEach((node, i) => {
        node.classList.toggle("dim", i !== index);
      });
      card.querySelectorAll(".alp__names > span").forEach((node, i) => {
        node.classList.toggle("is-hot", i === index);
        node.classList.toggle("dim", i !== index);
      });
    },
    leaveItem(ev) {
      this.hideTip();
      const card = ev.currentTarget.closest(".alp__card");
      if (!card) return;
      card.querySelectorAll(".alp__stk > span, .alp__names > span").forEach((node) => {
        node.classList.remove("dim", "is-hot");
      });
    },

    // A slice and its legend row are the same object, so they hover alike: the
    // tooltip, and the dim on everything else. Both entry points, one handler.
    hoverSleeve(row, ev) { this.showTip(row, ev); this.dimTo(row.key); },
    leaveSleeve() { this.hideTip(); this.dimTo(null); },
    showTip(row, ev) {
      this.tipAt(this.tipHtml(row), ev);
      this.hotKey = row.key;
    },
    hideTip() {
      const tip = this.$refs.allocTip;
      if (tip) tip.style.opacity = "0";
      this.hotKey = null;
    },
    // Applied to the paths directly: they are built in JS, so there is no
    // Alpine binding to hang a class on.
    dimTo(key) {
      const host = this.$refs.donut;
      if (!host) return;
      host.querySelectorAll("path[data-sleeve]").forEach((node) => {
        node.classList.toggle("dim", !!key && node.dataset.sleeve !== key);
      });
    },

    // ── the hero donut (hand-authored inline SVG; no chart dependency) ──────
    draw() { this.drawDonut(); },

    // One deposit, split into the sleeves it is allocated to: the recipe.
    //
    // NOT NORMALISED to its own sum. The ring underneath is the full 360, so a
    // policy whose weights do not add to 100 leaves the remainder visibly
    // unfilled rather than being rescaled to look complete. Same rule as
    // swarm.js's sleeveBar().
    drawDonut() {
      const host = this.$refs.donut;
      if (!host) return;
      host.replaceChildren();
      const rows = this.sleeves();
      if (!rows.length) return;

      const CX = 120, CY = 120, OUTER = 104, INNER = 66, GAP = 1.6;
      const colours = this.sleeveColours();

      // The unallocated remainder, and the track every slice sits on.
      host.appendChild(svg("circle", {
        cx: CX, cy: CY, r: (OUTER + INNER) / 2, fill: "none",
        stroke: PALETTE.surfaceLight, "stroke-width": OUTER - INNER,
      }));

      const funded = rows.filter((r) => r.target > 0);
      let cursor = 0;
      rows.forEach((row) => {
        if (!(row.target > 0)) return;
        const sweep = (Math.min(100, row.target) / 100) * 360;
        // A gap only where there is a neighbour to separate from.
        const gap = funded.length > 1 ? GAP : 0;
        const a0 = cursor + gap / 2;
        const a1 = cursor + sweep - gap / 2;
        cursor += sweep;
        if (a1 <= a0) return;
        // data-mark declares this a SERIES mark, which is what lets the
        // covenant spec assert the strong rule (its fill is a CATEGORICAL hue)
        // instead of the blunt one (nothing on the page is ever cyan-filled).
        const path = svg("path", {
          d: donutArc(CX, CY, OUTER, INNER, a0, a1), fill: colours[row.key], "data-mark": "series",
        });
        // Dimming the others rather than lifting the hovered one, so the ring
        // keeps its geometry and only its emphasis moves.
        path.addEventListener("pointerenter", (ev) => { this.showTip(row, ev); this.dimTo(row.key); });
        path.addEventListener("pointermove", (ev) => this.showTip(row, ev));
        path.addEventListener("pointerleave", () => { this.hideTip(); this.dimTo(null); });
        path.dataset.sleeve = row.key;
        host.appendChild(path);
      });

      // The hole carries what the ring adds up to: it is drawn to the full
      // 360, so a policy adding to less than 100 leaves an unfilled arc, and
      // this names what is missing from it.
      const total = this.sleeves().reduce((n, r) => n + (Number(r.target) || 0), 0);
      const gap = 100 - total;
      host.appendChild(label(svg("text", {
        x: CX, y: CY - 12, "text-anchor": "middle", fill: PALETTE.textMuted,
        "font-family": "'JetBrains Mono',monospace", "font-size": 9, "letter-spacing": "0.18em",
      }), "ALLOCATED"));
      host.appendChild(label(svg("text", {
        x: CX, y: CY + 8, "text-anchor": "middle", fill: PALETTE.text,
        "font-family": "'JetBrains Mono',monospace", "font-size": 15, "font-weight": 700,
      }), this.fmtPctTrim(total)));
      if (Math.abs(gap) >= 0.005) {
        host.appendChild(label(svg("text", {
          x: CX, y: CY + 24, "text-anchor": "middle", fill: PALETTE.textMuted,
          "font-family": "'JetBrains Mono',monospace", "font-size": 9,
        }), `${this.fmtPctTrim(Math.abs(gap))} ${gap > 0 ? "unallocated" : "over"}`));
      }

      host.setAttribute("aria-label", "Target allocation, "
        + rows.map((s) => `${s.name} at a ${this.fmtPctTrim(s.target)} target`).join("; ")
        + ".");
    },

  }));
}
