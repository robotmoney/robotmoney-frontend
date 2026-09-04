// Alpine factory for /allocation — the allocation as a POLICY (RM-115,
// container rule RM-114).
//
// THE ONE RULE THIS FILE EXISTS TO KEEP: it reads
// GET /api/dashboards/allocation, GET /api/dashboards/vault-economics and
// GET /api/swarm/sessions, and NOTHING ELSE. It must never read
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
// the policy as it stands now; /allocation/history is how it has changed;
// /swarm/subjects/:id is a book, and the vault keeps one.
//
// Live, per fetch:
//   allocation       the four sleeve target weights and their constituents,
//                    plus `asOf`. NOT `source`: on this DTO that is the Base
//                    RPC source, not the provenance of the weights.
//   vault-economics  tvlUsd, sharePrice, totalShares, idleUsdc, apy7d and the
//                    three adapter holdings. They drive the vault panel inside
//                    the sleeve the vault implements, and the drift between
//                    what it holds and what the policy says it should.
//   swarm/sessions   the newest PUBLISHED session on the allocation subject,
//                    for the reading under the change ledger.
//
// NOT live, and said so on the page:
//   * NAV per share and true period returns. There is no GET route over
//     `vault_share_price_history` (RM-115's first backend ask).
//     vault-economics does serve one SPOT `sharePrice`, printed as a spot read
//     with its own timestamp; one number is not a series, and a
//     since-inception return derived from it would be a fabrication.
//   * The recommendation VECTOR. `robotmoney-allocation` is typed
//     `position_actions`, so meanTakeWeights() never runs for it and no
//     session publishes weights. The line shows the session's actions instead
//     of inventing a vector.
//   * A second version of the weights. `allocation_framework` has one writer,
//     the database seed, so the change ledger's `was` is the row in force and
//     every row reads flat until something can write another.
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, CATEGORICAL } from "../../lib/chart-theme.js";
import { ALLOCATION_SUBJECT_ID, VAULT_SUBJECT_ID, isPublishedAllocationSession } from "../../lib/allocation-subject.js";

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

// Sessions are served newest first (swarm_sessions ORDER BY date DESC), so the
// allocation's latest published session is normally on the first page. Walk a
// bounded number of pages rather than one, because a run of sessions on the
// other portfolios can push it off page one, and stop the moment it is found.
const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 4;

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
/** "2026-08-04" → "4 Aug". */
function shortDay(iso) {
  const parts = String(iso || "").split("-");
  if (parts.length !== 3) return "—";
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]}`;
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
    latest: null,       // newest published session on the allocation subject
    sessionsFailed: false,
    loading: true,
    // The sleeve under the pointer, so the donut and its legend light together.
    hotKey: null,

    vaultAddress: VAULT_ADDRESS,
    vaultSubjectHref: `/swarm/subjects/${VAULT_SUBJECT_ID}`,
    historyHref: "/allocation/history",

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
        this.loadLatestSession(),
      ]);
      this.loading = false;
      this.$nextTick(() => this.draw());
    },

    // The one line the page needs from the swarm: what the allocation's most
    // recent published session came out with. `sessionsFailed` is tracked
    // separately from "there is no session", because a dead feed and an empty
    // history are different facts and the page says which one it is.
    async loadLatestSession() {
      let cursor = null;
      try {
        for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
          const query = { limit: String(SESSION_PAGE_SIZE) };
          if (cursor) query.cursor = cursor;
          const res = await api.get(ROUTES.swarm.sessions, query);
          const hit = (res.sessions || []).find(isPublishedAllocationSession);
          if (hit) { this.latest = hit; return; }
          cursor = res.nextCursor || null;
          if (!cursor) return;
        }
      } catch (_) {
        this.sessionsFailed = true;
      }
    },

    fmtUsd2(v) {
      return v == null || !isFinite(v)
        ? "—"
        : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    // A percentage already expressed in points (4.16 → "4.16%").
    fmtPct(v) { return v == null || !isFinite(v) ? "—" : Number(v).toFixed(2) + "%"; },
    fmtPct1(v) { return v == null || !isFinite(v) ? "—" : Number(v).toFixed(1) + "%"; },
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
      if (!this.hasTargets()) return "weights unavailable";
      return this.isSwarmManaged() ? "swarm-managed" : "seeded";
    },
    // Read from the code rather than from the feed: no session has ever
    // changed these weights, because nothing but the seed writes the table.
    // When a real writer lands, this sentence is the whole of the change.
    unchangedLine() {
      // Silent while the feeds are in flight: "could not be read" is a claim
      // about a request that has not finished, and the line holds its height
      // from CSS so nothing moves when the real sentence arrives.
      if (this.loading) return "";
      if (!this.hasTargets()) return "The published target could not be read.";
      const asOf = this.allocationAsOf();
      const since = asOf ? `Unchanged since ${longDay(asOf)}. ` : "";
      return `${since}No session has moved them: applying a recommendation is not built yet.`;
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
    sleeveStaleLabel(adapter) {
      const degraded = adapter?.provenance === "stale" || this.vaultStale();
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
      const names = this.constituents(s.key).length;
      const count = `${names} name${names === 1 ? "" : "s"}`;
      if (!this.sleeveHasVault(s.key)) return `${count} · vault pending`;
      const te = this.sleeveTrackingError(s.key);
      return te == null
        ? `${count} · vault live`
        : `${count} · vault live · ${te.toFixed(2)} pts off`;
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
        note: this.changeNote(row),
      }));
    },
    changeNote(row) {
      if (!(row.target > 0)) return "Never funded.";
      return this.sleeveHasVault(row.key)
        ? "In force, and a vault holds it."
        : "In force. No vault holds it yet.";
    },
    // Direction is the GLYPH first and the colour second, so the column
    // survives colourblindness, greyscale and forced-colors. Up takes Pool
    // green and down takes Beacon, which is what tokens.css already calls a
    // point for loss and attention: here it is one arrow at type size.
    changeGlyph(d) { return d > 0 ? "▲" : d < 0 ? "▼" : ""; },
    changeLabel(d) {
      if (d == null || !isFinite(d) || d === 0) return "—";
      return (d > 0 ? "+" : "−") + Math.abs(Number(d)).toFixed(2);
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
    // Concentration, carried over from the retired Vault section. It belongs
    // beside the holdings it is computed from rather than in a section of its
    // own two screens below them.
    concentrationLine() {
      const pct = this.largestVenuePct();
      if (pct == null) return "";
      return `Largest single venue ${this.fmtPct1(pct)}, across ${this.venueCount()}. `
        + "One failing costs whatever share it holds.";
    },
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
      return te == null ? "—" : `${te.toFixed(2)} pts off target`;
    },
    onTarget(key) {
      const te = this.sleeveTrackingError(key);
      return te != null && te < 0.5;
    },
    // The sentence under the table. It names the reason rather than restating
    // the number, and the reason is computed: whichever policy names the vault
    // does not hold are the ones carrying the gap.
    trackingErrorLine(key) {
      const te = this.sleeveTrackingError(key);
      if (te == null) return "The vault holdings could not be read, so there is nothing to compare.";
      if (te < 0.5) return "The vault holds the policy.";
      const missing = this.sleeveVaultRows(key)
        .filter((r) => !r.idle && !r.inVault && r.policy > 0)
        .map((r) => r.label);
      if (!missing.length) return "The venues the vault holds are not at their target weights.";
      const names = missing.length === 1
        ? missing[0]
        : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
      const isAre = missing.length === 1 ? "is" : "are";
      return `${names} ${isAre} in the policy and not in the vault, so the rest carry the difference.`;
    },
    vaultRowBalance(r) {
      return r.balance == null ? "—" : Number(r.balance).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    vaultRowPrice(r) { return r.balance == null ? "—" : "$1.0000"; },
    vaultRowValue(r) { return r.balance == null ? "—" : this.fmtUsd2(r.value); },
    vaultRowPolicy(r) { return r.idle ? "—" : this.fmtPct(r.policy); },
    vaultRowActual(r) { return r.actual == null ? "—" : this.fmtPct(r.actual); },
    // Drift is a DEVIATION, not a gain: eight points over is exactly as wrong
    // as eight points under. So it carries the glyph for direction and stays
    // in reading ink, and the colour is spent once, on the verdict line. The
    // change ledger is the opposite case and is coloured, because there up
    // genuinely means the swarm raised a target.
    vaultRowDrift(r) {
      if (r.drift == null) return "—";
      if (Math.abs(r.drift) < 0.005) return "—";
      return (r.drift > 0 ? "+" : "−") + Math.abs(r.drift).toFixed(2);
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
    tipHtml(row) {
      const parts = [
        `<b>${row.name}</b>`,
        `<span><i style="background:${this.sleeveColours()[row.key]}"></i>Target ${this.fmtPctTrim(row.target)}</span>`,
      ];
      const items = this.constituents(row.key);
      if (items.length) parts.push(`<span class="alp__tip-soft">${items.length} names</span>`);
      parts.push(this.sleeveHasVault(row.key)
        ? `<span class="alp__tip-soft">Vault live · ${this.trackingErrorLabel(row.key)}</span>`
        : '<span class="alp__tip-soft">Vault pending</span>');
      return parts.join("");
    },
    // Inside a card: hovering a block lights its name and recedes its
    // neighbours, and hovering a name does the same to its block. Applied by
    // hand rather than through Alpine state because the cards come out of an
    // x-for and a per-card scope for one transient class would cost more than
    // it explains.
    hoverItem(ev, index) {
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
      const card = ev.currentTarget.closest(".alp__card");
      if (!card) return;
      card.querySelectorAll(".alp__stk > span, .alp__names > span").forEach((node) => {
        node.classList.remove("dim", "is-hot");
      });
    },

    hoverSleeve(row, ev) { this.showTip(row, ev); this.dimTo(row.key); },
    leaveSleeve() { this.hideTip(); this.dimTo(null); },
    showTip(row, ev) {
      const tip = this.$refs.allocTip;
      const host = this.$refs.allocFig;
      if (!tip || !host) return;
      tip.innerHTML = this.tipHtml(row);
      tip.style.opacity = "1";
      const rect = host.getBoundingClientRect();
      const x = ev && ev.clientX != null ? ev.clientX - rect.left : rect.width / 2;
      const y = ev && ev.clientY != null ? ev.clientY - rect.top : rect.height / 2;
      tip.style.left = Math.min(Math.max(x + 14, 8), Math.max(8, rect.width - 190)) + "px";
      tip.style.top = Math.max(8, y - 10) + "px";
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
        + `$${Number(price).toFixed(4)} a share`;
    },
    // Concentration, computed from the live balances: what one venue failing
    // would cost. Not a drawdown percentage — a venue failing is the risk the
    // yield is being paid for.
    largestVenuePct() {
      const total = this.adaptersTotalUsd();
      if (!total) return null;
      const largest = Math.max(...this.fundedAdapters().map((a) => Number(a.balanceUsd)));
      return (largest / total) * 100;
    },
    venueCount() { return this.fundedAdapters().length; },

    latestDate() { return this.latest ? longDay(this.latest.date) : "—"; },
    latestHref() {
      const s = this.latest;
      if (!s) return this.historyHref;
      return s.id
        ? `/swarm/sessions/${encodeURIComponent(s.id)}`
        : `/swarm/${s.date}/${encodeURIComponent(s.subjectId || ALLOCATION_SUBJECT_ID)}`;
    },
    latestQuorum() {
      const q = this.latest?.swarmRecommendation?.quorum;
      return q ? `${q.submitted} of ${q.active} took part` : "";
    },
    // No vector, and the page says why rather than printing a blank. The
    // subject is typed `position_actions`, so meanTakeWeights() never runs for
    // it: what a session publishes is a set of actions and a rationale.
    //
    // The ACTIONS are the recommendation and lead. The rationale follows them
    // as the supporting sentence rather than standing in for them: the
    // aggregator generates it, and it restates the stance split, the quorum
    // and the percentile, two of which are already on the line above it.
    latestLine() {
      const rec = this.latest?.swarmRecommendation;
      if (!rec) return "";
      const acts = (Array.isArray(rec.actions) ? rec.actions : []).filter((a) => a && a.action);
      if (acts.length) return acts.map((a) => `${a.action} ${a.token}`).join(" · ");
      return rec.rationale ? String(rec.rationale) : "";
    },
    // Rendered under the line, and only when it is not already the line.
    latestRationale() {
      const rec = this.latest?.swarmRecommendation;
      if (!rec?.rationale) return "";
      const text = String(rec.rationale);
      return text === this.latestLine() ? "" : text;
    },
    latestConfidence() {
      const c = this.latest?.swarmRecommendation?.meanConfidence;
      return Number.isFinite(Number(c)) ? `${Math.round(Number(c) * 100)}% mean confidence` : "";
    },
    // What the page can say about a missing line, without guessing which of
    // the two reasons applies.
    latestFallback() {
      if (this.sessionsFailed) return "The session feed could not be read.";
      if (!this.latest) return "No session has published a recommendation on the allocation yet.";
      return "This session published no recommendation.";
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
        path.appendChild(label(document.createElementNS(SVG_NS, "title"),
          `${row.name}: ${this.fmtPctTrim(row.target)} target, ${this.sleeveState(row)}`));
        // The hover layer the pie charts on the old page had, kept. Dimming
        // the others rather than lifting the hovered one, so the ring keeps
        // its geometry and only its emphasis moves.
        path.addEventListener("pointerenter", (ev) => { this.showTip(row, ev); this.dimTo(row.key); });
        path.addEventListener("pointermove", (ev) => this.showTip(row, ev));
        path.addEventListener("pointerleave", () => { this.hideTip(); this.dimTo(null); });
        path.dataset.sleeve = row.key;
        host.appendChild(path);
      });

      // The hole carries the state of the POLICY, not a deposit. This page is
      // the recipe, and the first question a returning reader has is whether
      // it moved since they last looked; "1 USDC / DEPOSIT" answered a
      // question nobody was asking and framed a policy as a transaction.
      const asOf = this.allocationAsOf();
      host.appendChild(label(svg("text", {
        x: CX, y: CY - 12, "text-anchor": "middle", fill: PALETTE.textMuted,
        "font-family": "'JetBrains Mono',monospace", "font-size": 9, "letter-spacing": "0.18em",
      }), asOf ? "UNCHANGED SINCE" : "IN FORCE"));
      host.appendChild(label(svg("text", {
        x: CX, y: CY + 8, "text-anchor": "middle", fill: PALETTE.text,
        "font-family": "'JetBrains Mono',monospace", "font-size": 15, "font-weight": 700,
      }), asOf ? shortDay(asOf) : "—"));
      host.appendChild(label(svg("text", {
        x: CX, y: CY + 24, "text-anchor": "middle", fill: PALETTE.textMuted,
        "font-family": "'JetBrains Mono',monospace", "font-size": 9,
      }), asOf ? asOf.slice(0, 4) : ""));

      host.setAttribute("aria-label", "Target allocation, "
        + rows.map((s) => `${s.name} at a ${this.fmtPctTrim(s.target)} target, ${this.sleeveState(s)}`).join("; ")
        + ".");
    },

  }));
}
