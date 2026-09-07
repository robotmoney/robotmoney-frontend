// Alpine factory for /allocation — the allocation as a POLICY (RM-115,
// container rule RM-114).
//
// THE ONE RULE THIS FILE EXISTS TO KEEP: it reads
// GET /api/dashboards/allocation and GET /api/dashboards/vault-economics,
// and NOTHING ELSE. It must never read
// wallet-balances or wallet-sleeves. Those are the three protocol-owned prop
// wallets — the house book, a different pot of money with different owners,
// moving to the token page under RM-103. The page this replaced added the two
// together under one "Total AUM" heading, which on 2026-09-02 put a $229 vault
// inside a $59.4k figure, 0.4% of the number a reader took for the vault,
// while backend config.ts throws at boot if a prop wallet is ever configured
// as the vault ("would double-count vault TVL"). A reviewer should check that
// exclusion before anything else.
//
// The allocation is a POLICY, not a book of holdings (RM-114). This page is
// the policy as it stands now; the sessions that reviewed it are on the
// swarm's page for the subject; /swarm/subjects/:id is otherwise a book, and
// the vault keeps one.
//
// Live, per fetch:
//   allocation       the four sleeve target weights and their constituents,
//                    plus `asOf`. NOT `source`: on this DTO that is the Base
//                    RPC source, not the provenance of the weights.
//   vault-economics  tvlUsd, sharePrice, totalShares, idleUsdc, apy7d and the
//                    three adapter holdings. They drive the vault panel inside
//                    the sleeve the vault implements, and the drift between
//                    what it holds and what the policy says it should.
//
// NOT live, and said so on the page:
//   * NAV per share and true period returns. There is no GET route over
//     `vault_share_price_history` (RM-115's first backend ask).
//     vault-economics does serve one SPOT `sharePrice`, printed as a spot read
//     with its own timestamp; one number is not a series, and a
//     since-inception return derived from it would be a fabrication.
//   * A second version of the weights. `allocation_framework` has one writer,
//     the database seed, so the change ledger's `was` is the row in force and
//     every row reads flat until something can write another.
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, CATEGORICAL } from "../../lib/chart-theme.js";
import { ALLOCATION_SUBJECT_ID, VAULT_SUBJECT_ID } from "../../lib/allocation-subject.js";

// The ERC-4626 vault on Base. A public on-chain address, source of truth
// frontend/public/skill.md.
const VAULT_ADDRESS = "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd";

// The vault's assets are its three lending adapters plus idle USDC, so
// everything it holds sits in the fixed-income sleeve. Keyed on the
// framework's own bucket key.
const FIXED_INCOME_KEY = "defi-yield";

// The one vault that exists. Its receipt token and chain are product facts,
// not a feed. The other three sleeves get no symbol at all: naming a token for
// a contract nobody has deployed is a fabrication a reader would act on.
const VAULT_TOKEN = "rmUSDC";

// What each sleeve IS, keyed on the framework's own bucket key. Page copy, not
// a feed: the allocation DTO serves labels and weights and no prose. It says
// what the sleeve holds and why it exists, and deliberately does not re-list
// the names, which are already printed under the bar.
const SLEEVE_NOTE = {
  "defi-yield": "Lending USDC on Base. The lowest-volatility sleeve, aimed at capital preservation.",
  "agent-tokens": "Tokens of the agents that hold $ROBOTMONEY. The list is admin-managed.",
  "protocol-tokens": "Large-cap crypto and DeFi assets.",
  rwa: "Tokenised traditional instruments: equity index and commodities.",
};
const VAULT_CHAIN = "Base";

// Adapter display names and venue types. vault-economics serves the protocol
// name only ("Morpho"), but Morpho's position is a specific curated vault and
// saying so is the difference between "three lending venues" and "two pooled
// markets and a vault somebody else sets the caps on". An adapter not in this
// map still renders, under its own name, rather than disappearing.
const ADAPTER_DISPLAY = {
  aave: { label: "Aave V3 USDC", type: "Pooled market", managed: false },
  morpho: { label: "Gauntlet USDC Prime", type: "Curated vault", managed: true },
  compound: { label: "Compound III USDC", type: "Pooled market", managed: false },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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

/** "2026-08-04" → "4 Aug 2026". */
function longDay(iso) {
  const parts = String(iso || "").split("-");
  if (parts.length !== 3) return "—";
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

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
// keyed to the colour its slice would have. Constituents restart at the front
// inside their own sleeve, which is what the mini bucket pies already do, and
// the vault table reuses the constituent's hue keyed by its position in the
// POLICY — never by the order the holdings feed happens to return, which would
// let the API repaint a venue.
const sleeveColour = (i) => CATEGORICAL[i % CATEGORICAL.length];
const itemColour = (i) => CATEGORICAL[i % CATEGORICAL.length];

/** One donut segment, as a path. Angles in degrees, clockwise from 12 o'clock. */
function donutArc(cx, cy, outer, inner, a0, a1) {
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
    economics: null,    // GET /api/dashboards/vault-economics
    allocationFw: null, // GET /api/dashboards/allocation
    loading: true,
    // The sleeve under the pointer, so the donut and its legend light together.
    hotKey: null,

    vaultAddress: VAULT_ADDRESS,
    vaultSubjectHref: `/swarm/subjects/${VAULT_SUBJECT_ID}`,
    // The allocation's own decision log is not built yet, so the sessions
    // live where the swarm keeps them.
    historyHref: `/swarm/subjects/${ALLOCATION_SUBJECT_ID}`,

    init() {
      this.load();
      this.$nextTick(() => this.draw());
    },

    // Every feed is fetched independently (allSettled semantics), so one
    // degraded endpoint leaves only its own widget on "—" rather than blanking
    // a page about money. A failed leg becomes null, never a fabricated value.
    async load() {
      const fetchInto = (key, route) =>
        api.get(route).then((d) => { this[key] = d; }).catch(() => { this[key] = null; });
      await Promise.allSettled([
        fetchInto("economics", ROUTES.dashboards.vaultEconomics),
        fetchInto("allocationFw", ROUTES.dashboards.allocation),
      ]);
      this.loading = false;
      this.$nextTick(() => this.draw());
    },

    fmtUsd2(v) {
      return v == null || !isFinite(v)
        ? "—"
        : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    // A percentage already expressed in points (4.16 → "4.16%").
    fmtPct(v) { return v == null || !isFinite(v) ? "—" : Number(v).toFixed(2) + "%"; },
    // A fraction 0..1 from the API (apy7d) → "4.20%".
    fmtRate(v) { return v == null || !isFinite(v) ? "—" : (Number(v) * 100).toFixed(2) + "%"; },
    // A target weight at one decimal with a trailing ".0" trimmed: 95%, 14.3%.
    // Held weights keep the decimal (100.0%, 0.0%) because a holding that
    // reads "0%" and one that reads "0.0%" are different claims about how
    // closely it was measured.
    fmtPctTrim(v) {
      if (v == null || !isFinite(v)) return "—";
      return this.fmtPctTrimBare(v) + "%";
    },
    fmtPctTrimBare(v) {
      if (v == null || !isFinite(v)) return "—";
      return Number(v).toFixed(1).replace(/\.0$/, "");
    },

    // ── the allocation in force ─────────────────────────────────────────────
    allocationAsOf() { return this.allocationFw?.asOf || null; },
    allocationAsOfLabel() {
      const asOf = this.allocationAsOf();
      return asOf ? longDay(asOf) : "—";
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

    // ── degradation states ──────────────────────────────────────────────────
    // Carried over from the pages this one replaces, in full. A page about
    // money that silently assumes fresh data is a regression, so every one of
    // these renders a visible badge rather than a console warning.

    // The vault feed is serving hermetic stub data, not a chain read.
    vaultNonLive() { return this.economics?.source === "stub"; },
    // The live RPC read failed and every figure is the last persisted sample.
    vaultStale() { return this.economics?.stale === true; },
    // issue #614 AC4: a same-bucket scheduler catch-up — a genuinely live
    // read, only a late one. Distinct from stub (never a chain read) and from
    // stale (a degraded leg reusing an OLDER value).
    vaultBackfilled() {
      return (this.economics?.adapters || []).some((a) => a.provenance === "backfilled");
    },
    // Per-row stale label: names the observation time, so "stale" is a date
    // rather than an adjective. The direct descendant of the old page's
    // sleeveStaleLabel(w) over wallet-sleeves, pointed at the only book this
    // page is allowed to read.
    // Keyed on the ROW, not on the feed. A whole-feed `stale` is already stated
    // once by the page badge and again by asOfLabel()'s "(stale)"; repeating it
    // on every row said nothing new and put three warm badges in a column that
    // is otherwise all figures. The per-row badge is for the case it was built
    // for: SOME rows degraded, each naming its own observation time.
    sleeveStaleLabel(adapter) {
      const degraded = adapter?.provenance === "stale";
      if (!degraded) return "";
      const observed = adapter?.balanceObservedAt || this.economics?.asOf;
      if (!observed) return "stale";
      const when = new Date(observed).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
      }) + " UTC";
      return `stale (${when})`;
    },
    asOfLabel() {
      const asOf = this.economics?.asOf;
      if (!asOf) return "—";
      const when = new Date(asOf).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
      }) + " UTC";
      return this.vaultStale() ? `${when} (stale)` : when;
    },
    // ── sleeves: allocation (target) against holdings (actual) ──────────────
    // The vault's assets are its three lending adapters plus idle USDC, so
    // everything it holds sits in fixed income. Held weight is COMPUTED from
    // the live adapter balances rather than asserted, which is what makes
    // "held at zero" a reading instead of a copy decision.
    adapters() { return this.economics?.adapters || []; },
    fundedAdapters() {
      return this.adapters().filter((a) => a.configured !== false && a.balanceUsd != null);
    },
    adaptersTotalUsd() {
      const funded = this.fundedAdapters();
      if (!funded.length) return null;
      return funded.reduce((sum, a) => sum + Number(a.balanceUsd), 0);
    },
    // Sleeve rows for the bullet bars and the hero fan. The vault is the only
    // book the allocation has, so "held" is the vault's own composition; the
    // agent-token basket is bought at deposit time and lands in the
    // depositor's wallet, which is why that sleeve reads held at zero.
    sleeves() {
      const buckets = this.allocationFw?.buckets || [];
      const strategy = this.allocationFw?.strategy || [];
      const tvl = this.economics?.tvlUsd;
      const fixedIncome = this.adaptersTotalUsd();
      return buckets.map((b, i) => {
        const target = Number(strategy[i]?.targetPct ?? 0);
        const held = b.key === FIXED_INCOME_KEY
          ? (tvl && fixedIncome != null ? (fixedIncome / tvl) * 100 : null)
          : 0;
        return {
          key: b.key,
          // The served label, never a local rename: /swarm prints these same
          // four strings from the same DTO, and two product surfaces naming
          // the same sleeve differently is worse than an inelegant label.
          name: b.label || strategy[i]?.label || b.key,
          target,
          held,
          drift: held == null ? null : held - target,
          holding: held != null && held > 0,
        };
      });
    },
    sleeveState(s) {
      if (s.held == null) return "—";
      return s.holding ? "holding" : "held at zero";
    },
    // What the legend row says under the sleeve name. It answers the two
    // questions the donut cannot: how many names are inside, and whether
    // anything is actually holding this weight.
    sleeveLegendLine(s) {
      const n = this.constituents(s.key).length;
      const count = `${n} asset${n === 1 ? "" : "s"}`;
      if (!this.sleeveHasVault(s.key)) return `${count} · vault pending`;
      const te = this.sleeveTrackingError(s.key);
      return te == null
        ? `${count} · vault live`
        : `${count} · vault live · ${te.toFixed(2)}% off`;
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
    // sleeve. Keyed on the constituent's index in the POLICY, which is also
    // what the vault table below keys on, so a venue is one colour on the page
    // however the holdings feed orders itself.
    constituentColour(i) { return itemColour(i); },


    // ── constituents (small multiples) ──────────────────────────────────────
    // Within-sleeve weights. Fixed income's come from the live adapter
    // balances; every other sleeve holds nothing in the vault, so its
    // constituents render as an allocation against a zero holding rather than
    // being hidden.
    constituents(sleeveKey) {
      const bucket = (this.allocationFw?.buckets || []).find((b) => b.key === sleeveKey);
      if (!bucket) return [];
      const total = this.adaptersTotalUsd();
      return (bucket.items || []).map((item) => {
        const target = Number(item.targetPct ?? 0);
        let held = 0;
        if (sleeveKey === FIXED_INCOME_KEY && total) {
          const adapter = this.adapters().find(
            (a) => String(a.name).toLowerCase() === String(item.label).toLowerCase(),
          );
          held = adapter && adapter.balanceUsd != null ? (Number(adapter.balanceUsd) / total) * 100 : 0;
        }
        return { label: item.label, target, held, holding: held > 0 };
      });
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
    changeGlyph(d) { return d > 0 ? "▲" : d < 0 ? "▼" : ""; },
    changeLabel(d) {
      if (d == null || !isFinite(d) || d === 0) return "—";
      return (d > 0 ? "+" : "−") + this.fmtPct(Math.abs(Number(d)));
    },
    changeClass(d) {
      if (d == null || !isFinite(d) || d === 0) return "flat";
      return d > 0 ? "up" : "down";
    },


    // ── one vault per sleeve ────────────────────────────────────────────────
    // Only fixed income has a contract. The other three are written policy
    // waiting on Lucas's vaults, and the page says "pending" rather than
    // inventing a receipt-token symbol for an address that does not exist.
    sleeveHasVault(key) { return key === FIXED_INCOME_KEY && !!this.economics; },
    // /allocation#vault is a citable anchor: the deposit skill and the swarm's
    // vault row both point at it. The section it used to name is gone, because
    // the vault's holdings now sit in the sleeve they implement, so the anchor
    // moves onto that card rather than being retired out from under two
    // callers. Keyed on the sleeve, NOT on sleeveHasVault: a dead economics
    // feed must not take the anchor down with it.
    sleeveAnchor(key) { return key === FIXED_INCOME_KEY ? "vault" : null; },
    // Empty for a bucket key we have no copy for, which renders nothing rather
    // than a placeholder: a sleeve the framework adds later gets no sentence
    // until someone writes one.
    sleeveNote(key) { return SLEEVE_NOTE[key] || ""; },
    vaultChain() { return VAULT_CHAIN; },
    // The meta rail, which replaced a four-tile stat block. Two of those tiles
    // were "not yet published" set in display type, which spent the top of the
    // page on figures that do not exist; they are one footnote now.
    vaultsLiveLabel() {
      const rows = this.sleeves();
      if (!rows.length) return "—";
      return `${rows.filter((row) => this.sleeveHasVault(row.key)).length} of ${rows.length}`;
    },
    deployedLabel() { return this.fmtUsd2(this.tvlUsd()); },
    vaultToken() { return VAULT_TOKEN; },
    // The 7-day figure the vault reports, and NOT a net one. Every yield on
    // this page is before the 0.25% exit fee (note 1), so calling this "net"
    // would be a claim the feed does not make. A sleeve-level net APY needs a
    // stated window and a stated fee treatment agreed across four vaults, and
    // today there is one vault to agree with.
    vaultApyLabel() {
      return this.economics?.apy7d != null ? this.fmtRate(this.economics.apy7d) : "—";
    },

    // The merged vault table: the book and the policy it is measured against,
    // as one set of rows. Splitting them made the reader do the join by eye
    // across four identical row labels.
    //
    // Rows follow the POLICY's order, so the table reads in the same order as
    // the bar above it and the colours line up. A name the policy holds and
    // the vault does not stays as a row with dashes: the absence is the
    // finding, and dropping the row would hide the largest drift on the page.
    //
    // "In vault" is a share of TVL, not of the adapters alone, so idle USDC
    // cannot silently vanish from the denominator and the weights reconcile
    // to the total underneath them.
    sleeveVaultRows(key) {
      if (!this.sleeveHasVault(key)) return [];
      const bucket = (this.allocationFw?.buckets || []).find((b) => b.key === key);
      const tvl = this.economics?.tvlUsd;
      const rows = (bucket?.items || []).map((item, i) => {
        const adapter = this.adapters().find(
          (a) => String(a.name).toLowerCase() === String(item.label).toLowerCase(),
        );
        const held = adapter && adapter.configured !== false && adapter.balanceUsd != null
          ? Number(adapter.balanceUsd)
          : null;
        const policy = Number(item.targetPct ?? 0);
        const actual = tvl ? ((held ?? 0) / tvl) * 100 : null;
        return {
          label: adapter ? this.adapterLabel(adapter) : item.label,
          colour: itemColour(i),
          adapter,
          inVault: held != null,
          balance: held,
          value: held,
          policy,
          actual,
          drift: actual == null ? null : actual - policy,
        };
      });
      // Idle USDC is in the vault and not in the policy, so it is a row with a
      // zero target rather than a footnote. Without it the weights do not add
      // to the total printed below them.
      const idle = this.idleUsdc();
      if (idle != null && Number(idle) > 0) {
        const actual = tvl ? (Number(idle) / tvl) * 100 : null;
        rows.push({
          label: "Idle USDC", colour: null, adapter: null, idle: true,
          inVault: true, balance: Number(idle), value: Number(idle),
          policy: 0, actual, drift: actual,
        });
      }
      return rows;
    },
    // Half the sum of absolute deviations: the standard reading of how far a
    // book sits from its policy, in points.
    sleeveTrackingError(key) {
      const rows = this.sleeveVaultRows(key);
      if (!rows.length || rows.some((r) => r.drift == null)) return null;
      return rows.reduce((sum, r) => sum + Math.abs(r.drift), 0) / 2;
    },
    trackingErrorLabel(key) {
      const te = this.sleeveTrackingError(key);
      return te == null ? "—" : `${te.toFixed(2)}% off target`;
    },
    vaultRowBalance(r) {
      return r.balance == null ? "—" : Number(r.balance).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    vaultRowPrice(r) { return r.balance == null ? "—" : "$1.0000"; },
    vaultRowValue(r) { return r.balance == null ? "—" : this.fmtUsd2(r.value); },
    vaultRowPolicy(r) { return r.idle ? "—" : this.fmtPct(r.policy); },
    vaultRowActual(r) { return r.actual == null ? "—" : this.fmtPct(r.actual); },
    // Every figure on this page is a percentage or a difference of
    // percentages, and both wear %. Points are the stricter unit for the
    // second kind, but two units on one page cost a reader more than the
    // precision buys: the label already says the figure is a deviation.
    vaultRowDrift(r) {
      if (r.drift == null) return "—";
      if (Math.abs(r.drift) < 0.005) return "—";
      return (r.drift > 0 ? "+" : "−") + this.fmtPct(Math.abs(r.drift));
    },
    // Same convention as the change ledger: glyph for direction, colour to
    // read it at a glance. Beacon is off this page; --color-warn is the down.
    vaultRowDriftClass(r) {
      if (r.drift == null || Math.abs(r.drift) < 0.005) return "flat";
      return r.drift > 0 ? "up" : "down";
    },
    vaultRowDriftGlyph(r) {
      if (r.drift == null || Math.abs(r.drift) < 0.005) return "";
      return r.drift > 0 ? "▲" : "▼";
    },

    // ── the donut's hover layer ─────────────────────────────────────────────
    // Pointer only, and deliberately. Every figure the tooltip shows is
    // already on the page as text in the legend beside it, so making four
    // slices focusable would add tab stops that reach nothing new. The slices
    // keep their <title>, which is what a screen reader reads.
    // A constituent tooltip has to earn the hover, so it does NOT restate the
    // name and weight printed two lines below the bar. It adds the figures
    // that are not on screen: the same target read against the whole
    // allocation rather than against its sleeve, and, where a vault holds the
    // asset, what it actually holds and the gap. The last pair otherwise lives
    // inside a collapsed panel.
    //
    // The labels separate TARGET from HELD, because that is the distinction a
    // reader is here to make. "In sleeve / of allocation / in vault" put three
    // percentages of three different denominators under three labels that all
    // read as the same kind of thing.
    constituentTip(sleeve, item, index) {
      const hue = itemColour(index);
      // Order carries the arithmetic. Drift is held against the target IN THE
      // SLEEVE, so those three sit together and read down as a subtraction:
      // 25.00 held against 0.00 is the −25.00 underneath it. "Target overall"
      // is the same asset measured against a different denominator and answers
      // a different question, so it goes below a rule rather than between the
      // two figures whose difference the reader is being shown.
      const rows = [["Target in sleeve", this.fmtPct(item.target)]];
      const held = this.sleeveVaultRows(sleeve.key).find((r) => r.policy === item.target && r.label.toLowerCase().includes(String(item.label).toLowerCase().split(" ")[0]))
        || this.sleeveVaultRows(sleeve.key)[index];
      if (this.sleeveHasVault(sleeve.key) && held && held.actual != null) {
        rows.push(["Held in vault", this.fmtPct(held.actual)]);
        const d = held.actual - held.policy;
        rows.push(["Drift", (d >= 0 ? "+" : "−") + this.fmtPct(Math.abs(d))]);
      }
      const ofAlloc = (Number(item.target) * Number(sleeve.target)) / 100;
      rows.push(["Target overall", this.fmtPct(ofAlloc), true]);
      return this.tipMarkup(hue, item.label, rows);
    },
    // A row's third element starts a new group: a hairline above it, because
    // the figure below the rule is measured against a different denominator
    // from the ones above it.
    tipMarkup(hue, title, rows, foot) {
      let out = `<b><i style="background:${hue}"></i>${title}</b>`;
      out += rows.map(([k, v, sep]) =>
        `<span${sep ? ' class="alp__tip-sep"' : ""}><em>${k}</em>${v}</span>`).join("");
      if (foot) out += `<span class="alp__tip-soft">${foot}</span>`;
      return out;
    },
    // Viewport coordinates, because the tooltip is now shared by the donut and
    // by every sleeve bar rather than living inside the figure.
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
    // object on the page, not two that happen to share a box. It had the
    // swatch inside a value row and three stacked sentences under it, which is
    // why it read as a different component every time the pointer crossed
    // from a bar to a slice.
    tipHtml(row) {
      const rows = [["Target", this.fmtPct(row.target)]];
      const items = this.constituents(row.key);
      if (items.length) rows.push(["Assets", String(items.length)]);
      if (this.sleeveHasVault(row.key)) {
        const te = this.sleeveTrackingError(row.key);
        if (te != null) rows.push(["Off target", this.fmtPct(te)]);
      }
      return this.tipMarkup(
        this.sleeveColours()[row.key], row.name, rows,
        this.sleeveHasVault(row.key) ? null : "No vault holds this sleeve yet.",
      );
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

    // ── the vault: how the allocation is implemented today ──────────────────
    adapterLabel(a) { return ADAPTER_DISPLAY[String(a?.name).toLowerCase()]?.label || a?.name || "—"; },
    adapterHref(a) { return a?.address ? `https://basescan.org/address/${a.address}` : null; },
    idleUsdc() { return this.economics?.idleUsdc; },
    tvlUsd() { return this.economics?.tvlUsd; },
    vaultHref() { return `https://basescan.org/address/${VAULT_ADDRESS}`; },
    shortAddress() { return `${VAULT_ADDRESS.slice(0, 10)}…${VAULT_ADDRESS.slice(-8)}`; },
    // The SPOT share price, labelled as a spot read. This is not the NAV per
    // share the stat rail reports as pending: that one needs the recorded
    // series, and one sample is not a series.
    sharesLabel() {
      const shares = this.economics?.totalShares;
      const price = this.economics?.sharePrice;
      if (shares == null || price == null) return "—";
      return `${Number(shares).toLocaleString("en-US", { maximumFractionDigits: 2 })} rmUSDC at `
        + `$${Number(price).toFixed(4)} a share, spot`;
    },

    // ── the hero donut (hand-authored inline SVG; no chart dependency) ──────
    draw() { this.drawDonut(); },

    // One deposit, split into the sleeves it is allocated to.
    //
    // The page this replaced drew a FAN instead, on the argument that a donut
    // of 95/5/0/0 is one slice and an 18-degree sliver. That argument was made
    // when the page was framed vault-first and the diagram had to carry the
    // whole product story. It does not have to any more: the section below it
    // carries target against held on bullet bars, so this only has to answer
    // "what is the recipe", and for that a donut is the plainer instrument.
    // The 18-degree sliver is the truth about this allocation.
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
        // Beam and Beacon are slices in that palette by design: chart-theme.js
        // spends them there so seven categories stay tellable apart, and the
        // covenant governs interface chrome and figures, not data encodings.
        const path = svg("path", {
          d: donutArc(CX, CY, OUTER, INNER, a0, a1), fill: colours[row.key], "data-mark": "series",
        });
        // The hover layer the pie charts on the old page had, kept. Dimming
        // the others rather than lifting the hovered one, so the ring keeps
        // its geometry and only its emphasis moves.
        path.addEventListener("pointerenter", (ev) => { this.showTip(row, ev); this.dimTo(row.key); });
        path.addEventListener("pointermove", (ev) => this.showTip(row, ev));
        path.addEventListener("pointerleave", () => { this.hideTip(); this.dimTo(null); });
        path.dataset.sleeve = row.key;
        host.appendChild(path);
      });

      // The hole carries what the ring adds up to. It carried the date the
      // weights had been in force, which the rail directly above it already
      // states; a figure printed twice within one screen is one figure and one
      // decoration. The sum is the one thing the ring cannot say for itself:
      // it is drawn to the full 360, so a policy adding to less than 100
      // leaves an unfilled arc, and this names what is missing from it.
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
        + rows.map((s) => `${s.name} at a ${this.fmtPctTrim(s.target)} target, ${this.sleeveState(s)}`).join("; ")
        + ".");
    },

  }));
}
