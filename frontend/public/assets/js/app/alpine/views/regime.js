// Alpine factory for the /regime classification dashboard. Moved verbatim
// from the monolithic views.js (finding 025); its chart/data helper tables
// live in ./shared.js.
import { api, ROUTES } from "../../lib/api.js";
import { scrollToFragment } from "../../router.js";
import { enhanceHeadings } from "../../lib/heading-anchors.js";
import { fmtUsdCompact } from "../lib/dash-format.js";
import { sessionBrief } from "../../lib/session-brief.js";
import { PALETTE, SERIES, REGIME } from "../../lib/chart-theme.js";
import { denseDays, sampleDays, yScale, lineChartSvg, bandRuns, dateTicks, nearestSample, logTicks, dragWindow } from "../../lib/line-chart.js";
import {
  alignToDates,
  STRATEGY_STYLE,
  BASELINE_KEYS,
  BACKTESTS,
  ASSET_COLOR,
  ASSET_LABEL,
  FWD_COLS,
  CON_COLS,
  CORR_ROWS,
  SOURCE_LABEL,
  REGIME_BG_LEGEND,
  REGIME_BAND_BG,
} from "./shared.js";

// A figure as the site prints one: a true minus sign, a plus only where asked,
// and no sign at all on a value that rounds to zero ("-0.0%" read as a loss).
function signedFig(n, digits, suffix, plus) {
  const s = Math.abs(n).toFixed(digits);
  if (Number(s) === 0) return s + suffix;
  return (n < 0 ? "\u2212" : plus ? "+" : "") + s + suffix;
}

// The history chart's ranges. The first paint asks for one year (about 36 KB,
// answered in ~0.3 s); the whole history and the backtests (~260 KB, ~1 s)
// follow behind it, so the longer ranges fill in once that has landed.
const RANGES = [
  { id: "6m", label: "6M", days: 183 },
  { id: "ytd", label: "YTD" },
  { id: "1y", label: "1Y", days: 365 },
  { id: "3y", label: "3Y", days: 1096 },
  { id: "5y", label: "5Y", days: 1826 },
  { id: "all", label: "All" },
];
const FIRST_PAINT_DAYS = 400;
// Past this many days the lines take one reading a week (the last day of each
// seven, counted back from the latest, so today is always a point). A day is
// under half a pixel wide at that span. The regime bands stay day by day.
const WEEKLY_AFTER_DAYS = 400;
const HISTORY_SERIES = [["composite", "Composite"], ["macro", "Macro"], ["onchain", "On-chain"], ["factor", "Equity factor"]];

// Chart models are memoised outside Alpine data: one per history and range
// for the history chart, one per market for the backtests. Held in component
// data they would be read back through Alpine's proxies on every render.
const HIST_MEMO = { key: null, m: null };
const DAYS_MEMO = { key: null, days: [] };
// The narrowest window the navigator allows, in days.
const MIN_WINDOW = 14;
const BT_MEMO = new Map();

// Arrow keys step the crosshair through the drawn readings; Home and End jump
// to the ends; Escape clears it.
function stepAt(ev, at, count) {
  if (!count) return at;
  const last = count - 1;
  if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
    ev.preventDefault();
    const from = at ?? (ev.key === "ArrowRight" ? -1 : last + 1);
    return Math.max(0, Math.min(last, from + (ev.key === "ArrowRight" ? 1 : -1)));
  }
  if (ev.key === "Home") { ev.preventDefault(); return 0; }
  if (ev.key === "End") { ev.preventDefault(); return last; }
  if (ev.key === "Escape") return null;
  return at;
}

// The summary cards' panel tips (panelTip below). `reads` is each panel's own
// description on the indicators page; `count` is that page's count, used only
// when a snapshot carries no indicator rows to count.
const PANEL_TIP = {
  macro: { noun: "macro", count: 8, reads: "rates, credit, the dollar, jobs, volatility", role: "Half of the composite." },
  onchain: { noun: "on-chain", count: 10, reads: "DeFi TVL, stablecoin float, active addresses, valuation, trend", role: "Half of the composite." },
  factor: { noun: "equity factor", count: 8, reads: "trend, breadth, momentum, style, valuation", role: "Tracked for context and left out of the composite." },
};

// The panel readings draw with the session page's Market context component
// (lib/session-brief.js): the same rows, track, cuts and tips, fed today's
// snapshot instead of a session's. Only its signal half is taken.
const BRIEF = sessionBrief();

export function registerRegimeView(Alpine) {
  // ── Regime classification ────────────────────────────────────────────────
  Alpine.data("regimeView", () => ({
    loading: true,
    error: null,
    latest: null,
    history: [],
    // Freshness of the served snapshot (backend computes it). When `stale`, the
    // analytics pipeline isn't refreshing in this deployment and the charts below
    // are frozen — surfaced as a loud banner rather than served silently.
    staleness: null,
    // History-chart overlay toggles. composite/macro/on-chain/factor are ALWAYS
    // drawn (no per-series toggle, matching the source HistoryChart); only the
    // regime bands + the S&P 500 / ETH price overlays toggle.
    visible: { spx: false, eth: false, bands: true, btBands: true },
    // Each index line on the history chart, on or off from its chip.
    series: { composite: true, macro: true, onchain: true, factor: true },
    range: "1y",
    ranges: RANGES,
    // True once the whole history and the backtests have landed.
    fullLoaded: false,
    // The indicator panel on show; a #panel-<key> link opens its own.
    panelTab: "macro",
    // Market context (lib/session-brief.js), fed the latest snapshot.
    backdrop: null,
    backdropDate: "",
    backdropV0: false,
    setBackdrop: BRIEF.setBackdrop,
    signalRows: BRIEF.signalRows,
    signalZones: BRIEF.signalZones,
    signalCuts: BRIEF.signalCuts,
    // Hidden strategy lines on the backtest charts, "<market>:<strategy>".
    btHidden: {},
    // The market on show in Backtests; a link to a market's heading opens it.
    btMarket: "eth",
    // The backtest chart's range; the whole backtest to start.
    btRange: "all",
    // A window dragged on a chart's navigator, as day indices over the whole
    // history ({ from, to }), or null while a range chip sets it.
    histWin: null,
    btWin: null,
    _drag: null,
    // Crosshair positions (an index into the drawn readings) and the line a
    // legend hover focuses, per chart.
    histAt: null,
    histFocus: null,
    btAt: null,
    btFocus: null,

    async load() {
      try {
        const data = await api.get(ROUTES.dashboards.regimeSnapshots, { range: FIRST_PAINT_DAYS });
        this._apply(data);
        this.loading = false;
        this._openTabFromHash();
        // #composite and #panel-<key> exist only now: a session page links
        // its market context rows to them. So do the dashboard's headings,
        // which the router's rm:view-changed pass (lib/heading-anchors.js)
        // ran too early to give their section links.
        this.$nextTick(() => { enhanceHeadings(this.$root); scrollToFragment(); });
      } catch (e) {
        this.error = e.message;
        this.loading = false;
        return;
      }
      this._onHash = () => this._openTabFromHash();
      addEventListener("hashchange", this._onHash);
      this.loadFull();
    },

    // The whole history and the backtests. `latest.backtest` (~126 KB) is off
    // by default on the backend (issue #866b); this page is the one place that
    // reads it, so it asks for it explicitly. A failure here leaves the year
    // already on screen standing.
    async loadFull() {
      const target = location.hash.slice(1);
      const landed = !target || !!document.getElementById(decodeURIComponent(target));
      try {
        const data = await api.get(ROUTES.dashboards.regimeSnapshots, { range: 4000, include: "backtest" });
        this._apply(data);
        this.fullLoaded = true;
        this.$nextTick(() => {
          enhanceHeadings(this.$root);
          // A link to a backtest could not land before its card existed.
          if (!landed) scrollToFragment();
        });
      } catch {
        this.fullLoaded = true;
      }
    },
    _apply(data) {
      this.latest = data.latest;
      this.setBackdrop(data.latest, { date: data.latest?.date });
      this.history = data.history || [];
      this.staleness = data.staleness || null;
    },

    // ── panels ──────────────────────────────────────────────────────────────
    panelsList() {
      const p = this.latest?.panels;
      if (Array.isArray(p) && p.length) return p;
      // Fallback when `panels` is null: always show macro + on-chain, and append the
      // display-only Equity factor panel when its index is present in the data.
      const base = ["macro", "onchain"];
      return this.latest?.factorIndex != null ? [...base, "factor"] : base;
    },
    panelLabel(p) { return p === "macro" ? "Macro" : p === "onchain" ? "On-chain" : p === "factor" ? "Equity factor" : p; },
    panelIndex(p) { return this.latest?.[p + "Index"]; },
    setPanelTab(p) { this.panelTab = p; },
    // #panel-<key>, a panel's heading id, or an id inside its card.
    _openTabFromHash() {
      const id = decodeURIComponent(location.hash.slice(1));
      if (!id) return;
      for (const p of this.panelsList()) {
        if (id === "panel-" + p || id === this.slug(this.panelLabel(p) + " panel")) { this.panelTab = p; return; }
      }
      for (const bt of BACKTESTS) {
        if (id === this.slug(bt.title) || id === "market-" + bt.key) { this.btMarket = bt.key; return; }
      }
      const el = document.getElementById(id);
      const card = el?.closest?.("[id^='panel-']");
      if (card) this.panelTab = card.id.slice("panel-".length);
    },

    // ── summary-card tooltips ───────────────────────────────────────────────
    // What each top figure is, in the terms the methodology below uses. The
    // thresholds are read from the snapshot (bucketPct), and a panel's count
    // from the indicators it actually carries, so a tip cannot state a cut or
    // a count the rest of the page disagrees with. PANEL_TIP holds the parts
    // no snapshot carries: what the panel reads (the indicators page's panel
    // descriptions), its count when the snapshot has no indicator rows, and
    // its part in the composite.
    regimeTip() {
      const lo = this.ordinalPct(+this.bucketPct("risk_off") / 100);
      const hi = this.ordinalPct(+this.bucketPct("risk_on") / 100);
      return `Where the composite, the mean of the macro and on-chain indices, ranks in its last 3 years: risk-off below the ${lo} percentile, risk-on above the ${hi}, neutral between. The label switches after 5 consecutive trading days in a new bucket, or on a one-day move over\u00a02σ.`;
    },
    panelTip(p) {
      const t = PANEL_TIP[p];
      const n = this.indicatorsIn(p).length || t?.count;
      const what = [n, t ? t.noun : this.panelLabel(p).toLowerCase(), n === 1 ? "indicator" : "indicators"].filter(Boolean).join(" ");
      return `A weighted mean of ${what}${t ? ` (${t.reads})` : ""}, each a percentile of its own last 3 years: 0 is risk-off, 1 risk-on.${t ? " " + t.role : ""}`;
    },
    // An id for a heading whose text is data (a panel or backtest title): the
    // text, lowercased, with every run of other characters as one hyphen.
    // "Backtest · ETH / cash" is backtest-eth-cash.
    slug(s) { return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); },
    // Rich per-indicator objects come only on the latest (asof) row; historical
    // rows carry the numeric columns + `percentiles` map. Group by panel.
    indicatorsIn(panel) {
      const inds = this.latest?.indicators;
      return Array.isArray(inds) ? inds.filter((i) => i.panel === panel) : [];
    },

    // ── freshness ─────────────────────────────────────────────────────────────
    // Stale data is flagged over the charts it froze. No snapshot at all is
    // not stale data: the empty chart in the dashboard's place says it.
    isStale() { return !!(this.staleness && this.staleness.stale && this.staleness.asof != null); },
    // Days since the latest reading. The server's own count when it sends one
    // (it knows its date), else from the reading's date against today, UTC.
    ageDays() {
      const s = this.staleness;
      if (s && s.ageDays != null && s.asof === this.latest?.date) return s.ageDays;
      const d = this.latest?.date;
      if (!d) return null;
      const then = Date.parse(d + "T00:00:00Z"), now = new Date();
      if (!isFinite(then)) return null;
      return Math.max(0, Math.round((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - then) / 86400000));
    },
    // "Updated today", "Updated 1 day ago", "Updated 3 days ago". The date
    // itself stays on the element as its datetime and its title.
    updatedText() {
      const n = this.ageDays();
      if (n == null) return "";
      return n === 0 ? "Updated today" : `Updated ${n} day${n === 1 ? "" : "s"} ago`;
    },
    dateLong(d) {
      const t = Date.parse(String(d || "") + "T00:00:00Z");
      return isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
    },
    staleMessage() {
      const s = this.staleness;
      if (!s || s.ageDays == null || s.asof == null) return "";
      return `Latest reading ${s.asof}, ${s.ageDays} day${s.ageDays === 1 ? "" : "s"} old.`;
    },

    // ── formatting ──────────────────────────────────────────────────────────
    posPct(x) { return x == null ? 0 : Math.max(0, Math.min(1, x)) * 100; },
    // A 0-1 percentile as an ordinal, "91st". Appending "th" to the integer
    // printed "91th", "92th" and "93th".
    ordinalPct(x) {
      if (x == null || !isFinite(x)) return "—";
      const n = Math.round(x * 100);
      const rem100 = n % 100;
      if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
      return `${n}${({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"}`;
    },
    // The names the Market context markup reads.
    ordinal(p) { return this.ordinalPct(p); },
    fmtNum(v, d = 2) { return v == null || !isFinite(v) ? "—" : (+v).toFixed(d); },
    // A row's tip: its label and value (the composite, or the panel's index),
    // its percentile, and its reading.
    signalTip(r) {
      const v = r.key === "composite" ? this.latest?.composite : this.latest?.[r.key + "Index"];
      const name = r.key === "composite" ? "Composite" : `${this.panelLabel(r.key)} index`;
      return [v == null ? name : `${name} ${this.fmtNum(v)}`, `${this.ordinal(r.pct)} percentile`, r.kind === "context" ? "" : (r.regime ? this.regimeLabel(r.regime) : "")].filter(Boolean).join(" · ");
    },
    fmtWeight(w) { return w == null ? "—" : (w * 100).toFixed(1) + "%"; },
    regimeLabel(r) { return r == null ? "—" : ({ risk_off: "Risk-off", neutral: "Neutral", risk_on: "Risk-on" }[r] || String(r).replace(/_/g, "-")); },
    // One regime palette, the session page's: green risk-on, slate neutral,
    // beacon risk-off. It marks a reading as a small round dot or a line,
    // never as type or a filled area, so the regime card's label stays in the
    // text colour beside its dot.
    regimeColor(r) { return REGIME[String(r || "").replace(/-/g, "_")] || REGIME.neutral; },
    // The provenance line in words. The transform is what the percentile ranks
    // (the raw level, or its change); the sign is which way is risk-on.
    transformLabel(t) {
      return ({ level: "Level", change30: "30-day change", change90: "90-day change", trend_50_200: "50d/200d trend" })[t] || String(t || "").replace(/_/g, " ");
    },
    signText(s) { return s == null ? "" : s >= 0 ? "+1" : "\u22121"; },
    signTip(s) { return s == null ? "" : s >= 0 ? "+1: a higher value leans risk-on." : "\u22121: a higher value leans risk-off, so its percentile is flipped."; },
    // A reading's lean as a round dot: green at or above its median, beacon
    // below. Its tip says it in words.
    leanDot(v) { return `background:${this.signedColor(v)}`; },
    leanTip(v) {
      if (v == null || !isFinite(v)) return "No reading.";
      return `${this.ordinalPct(v)} percentile of its last 3 years: ${v >= 0.5 ? "at or above its median, leaning risk-on" : "below its median, leaning risk-off"}.`;
    },
    // What an indicator's weight means: its share of its panel index, and so
    // of the composite, which is half macro and half on-chain.
    weightTip(ind) {
      const w = ind?.panel_weight;
      if (w == null || !isFinite(w)) return "";
      const panel = this.panelLabel(ind.panel).toLowerCase();
      if (ind.panel === "factor") return `${(w * 100).toFixed(1)}% of the ${panel} index, which is left out of the composite.`;
      return `${(w * 100).toFixed(1)}% of the ${panel} index, and so ${(w * 50).toFixed(1)}% of the composite.`;
    },
    fmtSign(s) { return s == null ? "—" : (s >= 0 ? "+" : "") + s; },
    sourceLabel(s) { return SOURCE_LABEL[s] || s || "—"; },
    // Row-level provenance badge label (issue #397): which AnalyticsDataSource
    // wrote the served snapshot — distinct from sourceLabel() above, which
    // labels a PER-INDICATOR upstream vendor (FRED/Yahoo/…). `latest.source`
    // is `null`/undefined on every pre-migration row (honestly unlabeled), so
    // the badge is hidden entirely rather than guessing "live".
    provenanceLabel(s) {
      return { live: "Live data", hermetic: "Demo data (hermetic)", fixture: "Test fixture data", seed: "Reference snapshot (seed)" }[s] || s;
    },
    // The panel-table row tooltip. It used to be the sign convention and
    // NOTHING else — every row explained percentile flipping and no row said
    // what the indicator was, which is the one thing a reader hovering an
    // unfamiliar name wants. The prose has always existed on the analytics
    // indicator universe as `description`; it just was not serialised into the
    // snapshot payload until now. Snapshots persisted before that carry no
    // description and are never rewritten, so the sign-only text stays as the
    // fallback rather than leaving those rows with an empty bubble.
    indicatorTooltip(ind) {
      if (!ind || !ind.description) return this.signTooltip(ind?.sign, ind?.name ?? "this indicator");
      return `${ind.description} ${this.signClause(ind.sign)}`;
    },
    // An indicator name, split so the info glyph cannot be orphaned on a line
    // of its own. CSS puts a soft wrap opportunity on both sides of an atomic
    // inline (which the glyph is) whatever characters sit next to it — a word
    // joiner does not close it, and `white-space: nowrap` on the link would
    // stop the name wrapping at all, in a 110px column. So everything up to the
    // last space wraps normally, and the last word rides with the glyph in a
    // nowrap box. Head keeps its trailing space; a one-word name has no head.
    nameHead(name) { const s = String(name ?? ""); const i = s.lastIndexOf(" "); return i < 0 ? "" : s.slice(0, i + 1); },
    nameTail(name) { const s = String(name ?? ""); const i = s.lastIndexOf(" "); return i < 0 ? s : s.slice(i + 1); },
    // Orientation in one clause. The full account of what sign-aligning does
    // belongs to the "Risk-on" column header tip, where it is read once,
    // instead of being restated in all 26 rows.
    signClause(sign) {
      return sign == null || sign >= 0
        ? "Sign +1: a rising value reads as risk-on."
        : "Sign −1: a rising value reads as risk-off, so its rank is flipped.";
    },
    // Fallback for pre-`description` snapshots (see indicatorTooltip).
    signTooltip(sign, name) {
      if (sign == null || sign >= 0) {
        return `Sign +1: a rising ${name} reads as risk-on, so its percentile is used as is. A high reading means risk-on for every indicator.`;
      }
      return `Sign −1: a rising ${name} reads as risk-off, so its percentile is flipped (1 − percentile) before averaging. A high reading means risk-on for every indicator.`;
    },
    // Component methodology footer: bucket thresholds as integer percentiles.
    // The live snapshot can carry no thresholds (bucketThresholds null), which
    // printed a placeholder dash into the sentence. The method buckets at
    // 0.33 / 0.67, the value every snapshot that does carry them holds.
    bucketPct(key) {
      const t = this.latest?.bucketThresholds;
      const v = t && t[key] != null ? t[key] : ({ risk_off: 0.33, risk_on: 0.67 })[key];
      return v == null ? "—" : (v * 100).toFixed(0);
    },

    // Last visible value (transformed for change series), formatted by unit.
    fmtLast(ind) {
      const t = ind.transform;
      const v = (t === "change30" || t === "change90") ? ind.transformed_value : ind.raw_value;
      if (v == null) return "—";
      const u = ind.unit;
      if (u === "percent") return v.toFixed(2) + "%";
      if (u === "percent_change") return signedFig(v * 100, 1, "%", true);
      if (u === "index") return v.toFixed(2);
      if (u === "count") return Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.round(v).toLocaleString();
      if (u === "ratio2") return v.toFixed(2);
      if (u === "ratio4") return v.toFixed(4);
      // issue #449: this is the one view with a trillion tier (macro-scale
      // indicators), no K tier at all (anything below $1M falls to the
      // rounded/comma-grouped base case), and that base case is rounded
      // instead of toFixed(2) — preserved via {trillion, skipKTier,
      // baseInteger} rather than silently dropped in the consolidation.
      if (u === "usd") return fmtUsdCompact(v, { trillion: true, skipKTier: true, baseInteger: true });
      return v.toFixed(2);
    },
    fmtSigned(v) { return v == null ? "—" : Math.round(v * 100).toString(); },
    // Which side of its median a sign-aligned percentile sits: at or above
    // 0.5 it leans risk-on, below it risk-off. Indicators have no buckets of
    // their own (only the composite is bucketed at 0.33 / 0.67), so this is a
    // lean, not a reading. It colours the sparkline, a line; the figure beside
    // it stays in the text colour.
    signedColor(v) {
      if (v == null || !isFinite(v)) return PALETTE.textMuted;
      return v >= 0.5 ? REGIME.risk_on : REGIME.risk_off;
    },

    // Inline-SVG sparkline (percentiles in [0,1]), stroked in the reading its
    // last point gives (signedColor). Mid-line reference at 0.5.
    sparklineSvg(values) {
      const vals = Array.isArray(values) ? values : [];
      const finite = vals.filter((v) => typeof v === "number" && isFinite(v));
      if (finite.length < 2) return '<span class="rv__spark-empty">—</span>';
      // 68 rather than 80: the sparkline column is the only fixed width in a
      // panel table, and the table has to fit its card at three across (see the
      // fit assertion in regime-visual.spec.ts). 24 monthly points still read
      // at 2.8px apart, and the column stopped being the reason the Weight
      // column had nowhere to go.
      const W = 68, H = 22, pad = 1, n = vals.length;
      const xAt = (i) => pad + (i / (n - 1)) * (W - 2 * pad);
      const yAt = (v) => pad + (1 - v) * (H - 2 * pad);
      let last = null;
      for (let k = vals.length - 1; k >= 0; k--) { if (typeof vals[k] === "number" && isFinite(vals[k])) { last = vals[k]; break; } }
      // The line takes the colour of its own direction over the two years:
      // green as it climbs, --color-warn as it falls, slate when it ends
      // within 5 points of where it began. It plots the percentile flipped
      // where needed, so climbing is always toward risk-on. Its colour used to
      // be the latest reading's side of the median, which read as a line going
      // up drawn orange.
      let first = null;
      for (const v of vals) { if (typeof v === "number" && isFinite(v)) { first = v; break; } }
      const move = last != null && first != null ? last - first : 0;
      const stroke = move >= 0.05 ? SERIES.emerald : move <= -0.05 ? PALETTE.warn : SERIES.slate;
      const dot = stroke;
      const pts = []; let lastX = pad, lastY = yAt(0.5);
      vals.forEach((v, i) => { if (typeof v === "number" && isFinite(v)) { const px = xAt(i), py = yAt(v); pts.push(px.toFixed(1) + "," + py.toFixed(1)); lastX = px; lastY = py; } });
      const mid = yAt(0.5).toFixed(1);
      return '<svg class="rv__spark-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'
        + '<line x1="' + pad + '" y1="' + mid + '" x2="' + (W - pad) + '" y2="' + mid + '" stroke="' + PALETTE.border + '" stroke-width="0.5" stroke-dasharray="2 2"/>'
        + '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + stroke + '" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>'
        + '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="2.25" fill="' + dot + '"/>'
        + '</svg>';
    },

    // ── correlations ("Predictive power & alignment") ───────────────────────
    fwdCols() { return FWD_COLS; },
    conCols() { return CON_COLS; },
    hasForward() { return !!this.latest?.correlations?.forward; },
    hasConcurrent() { return !!this.latest?.correlations?.concurrent; },
    corrRows() {
      const c = this.latest?.correlations;
      if (!c) return [];
      return CORR_ROWS.filter(([k]) => (c.forward && c.forward[k]) || (c.concurrent && c.concurrent[k]));
    },
    // The one predictive-power table: per asset, today's alignment and then the
    // 30, 90 and 180 day forward correlations, each column only where the
    // snapshot carries it.
    corrAssets() { return [["spx", "S&P 500"], ["eth", "ETH"]]; },
    corrHorizons() {
      const h = [];
      if (this.hasConcurrent()) h.push(["now", "Today"]);
      if (this.hasForward()) h.push(["30d", "30 days"], ["90d", "90 days"], ["180d", "180 days"]);
      return h;
    },
    corrColumns() {
      const hs = this.corrHorizons();
      return this.corrAssets().flatMap(([asset]) => hs.map(([h, label], i) => ({ id: asset + h, asset, h, label, first: i === 0 })));
    },
    // What one figure says, in words, from the figure itself: its sign, and
    // whether it clears the 0.15 noise line. Strength past that is not graded,
    // since the method draws no line there.
    rhoSentence(idx, asset, h) {
      const cell = this.corrCell(idx, asset, h);
      const row = (CORR_ROWS.find(([k]) => k === idx) || [idx, idx])[1];
      const name = asset === "spx" ? "S&P 500" : "ETH";
      const when = h === "now" ? "today" : `next ${parseInt(h, 10)} days`;
      if (!cell || cell.rho == null) return `${row} vs ${name}, ${when}: no reading.`;
      const r = cell.rho;
      const n = cell.n != null ? ` Across ${Number(cell.n).toLocaleString("en-US")} days.` : "";
      const head = `${row} vs ${name}, ${when}: ${this.rhoText(cell)}.`;
      if (Math.abs(r) < 0.15) return `${head} Under 0.15 either way: no relation beyond noise.${n}`;
      const hi = `a high ${row.toLowerCase()} reading`;
      const says = h === "now"
        ? (r > 0 ? `The index has run high when ${name} is high.` : `The index has run high when ${name} is low.`)
        : (r > 0 ? `${hi[0].toUpperCase() + hi.slice(1)} has come before stronger ${name} returns over the ${parseInt(h, 10)} days after.` : `${hi[0].toUpperCase() + hi.slice(1)} has come before weaker ${name} returns over the ${parseInt(h, 10)} days after.`);
      return `${head} ${says}${n}`;
    },
    corrCell(idx, asset, h) { return h === "now" ? this.conCell(idx, asset) : this.fwdCell(idx, asset + "_" + h); },
    // The cell's signed bar: from the centre line, right for a positive ρ and
    // left for a negative one, half the track at |ρ| = 1.
    rhoBarStyle(cell) {
      if (!cell || cell.rho == null) return "width:0";
      const w = Math.min(1, Math.abs(cell.rho)) * 50;
      return `width:${w.toFixed(1)}%;left:${cell.rho < 0 ? 50 - w : 50}%;background:${this.rhoColor(cell)}`;
    },
    fwdCell(idx, col) { return this.latest?.correlations?.forward?.[idx]?.[col]; },
    conCell(idx, col) { return this.latest?.correlations?.concurrent?.[idx]?.[col]; },
    rhoText(cell) { if (!cell || cell.rho == null) return "—"; return signedFig(cell.rho, 2, "", true); },
    // A signed figure, coloured like a delta with its sign glyph first: green
    // for ρ ≥ +0.15, red for ρ ≤ −0.15, muted under 0.15 (noise). The key is in
    // the note under the tables. It used to be cyan, which never marks a figure.
    rhoColor(cell) {
      if (!cell || cell.rho == null) return PALETTE.textMuted;
      const r = cell.rho;
      if (Math.abs(r) < 0.15) return PALETTE.textMuted;
      return r > 0 ? SERIES.emerald : PALETTE.warn;
    },
    rhoTitle(cell) { return cell && cell.n != null ? "n = " + cell.n + " paired observations" : ""; },
    // The span the correlations are measured over: n paired observations, one
    // per calendar day (the history is forward-filled across weekends), so
    // n / 365.25 years. n / 252 treated them as trading days and printed
    // "~12.1y" over 8.4 years of data.
    corrSampleMeta() {
      const c = this.latest?.correlations;
      const days = c?.forward?.composite?.spx_30d?.n ?? c?.concurrent?.composite?.spx?.n ?? 0;
      if (!isFinite(days) || days <= 0) return "Spearman ρ";
      const trailing = days >= 365 ? "~" + (days / 365.25).toFixed(1) + "y" : "~" + Math.max(1, Math.round(days / 30.44)) + "mo";
      return "Spearman ρ · trailing " + trailing;
    },

    // ── backtests ───────────────────────────────────────────────────────────
    backtests() { return BACKTESTS; },
    hasBacktest(key) { const s = this.latest?.backtest?.[key]; return !!s && Object.keys(s).length > 0; },
    backtestRows(bt) {
      const data = this.latest?.backtest?.[bt.key] || {};
      return bt.strategies.filter(([k]) => data[k]).map(([k, label, desc]) => ({ key: k, label, desc, s: data[k], baseline: BASELINE_KEYS.has(k) }));
    },
    // The strategies whose equity curve the chart can draw, in table order.
    // drawBacktests() and the card's empty state both read this, so the chart
    // and the line saying it has nothing to draw cannot disagree.
    _curveKeys(key) {
      const strategies = this.latest?.backtest?.[key];
      if (!strategies) return [];
      const bt = BACKTESTS.find((b) => b.key === key);
      const order = bt ? bt.strategies.map(([k]) => k) : Object.keys(strategies);
      return order.filter((sk) => STRATEGY_STYLE[sk] && Array.isArray(strategies[sk]?.equity_curve) && strategies[sk].equity_curve.length);
    },
    // An equity chart plots its curves against the history's dates, so it is
    // empty when the history chart is, and when no strategy carries a curve.
    // Null when there is something to draw.
    btEmptyTitle(key) {
      if (!this._curveKeys(key).length) return "No data yet";
      return this.historyEmpty() ? this.historyEmptyTitle() : null;
    },
    btEmptyDetail(key) { return this._curveKeys(key).length ? this.historyEmptyDetail() : ""; },
    fmtNum2(v) { return v == null ? "—" : (+v).toFixed(2); },
    fmtPctSigned(v) { return v == null ? "—" : signedFig(v * 100, 1, "%", true); },
    fmtPctUnsigned(v) { return v == null ? "—" : signedFig(v * 100, 1, "%", false); },
    ddColor(v) { return v == null ? PALETTE.textMuted : v < -0.5 ? PALETTE.warn : PALETTE.textMuted; },
    tradesText(row) { return row.baseline ? "—" : (row.s.transitions ?? "—"); },
    describeWeights(w) { return Object.keys(ASSET_COLOR).filter((a) => w[a]).map((a) => Math.round(w[a] * 100) + "% " + ASSET_LABEL[a]).join(" / "); },
    // Allocation pie glyph (inline SVG) for a per-regime weight map.
    statePie(w) {
      const size = 28, r = size / 2 - 1, cx = size / 2, cy = size / 2;
      const order = Object.keys(ASSET_COLOR).filter((a) => (w[a] || 0) > 0);
      const total = order.reduce((s, a) => s + w[a], 0) || 1;
      // The slices are CATEGORICAL hues (cash, ETH, SP500) and declare it.
      if (order.length === 1) return '<svg class="rv__pie" width="' + size + '" height="' + size + '" aria-hidden="true"><circle data-mark="series" cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + ASSET_COLOR[order[0]] + '"/></svg>';
      let a0 = -Math.PI / 2, paths = "";
      for (const a of order) {
        const frac = w[a] / total, a1 = a0 + frac * Math.PI * 2, large = frac > 0.5 ? 1 : 0;
        const x0 = (cx + r * Math.cos(a0)).toFixed(2), y0 = (cy + r * Math.sin(a0)).toFixed(2);
        const x1 = (cx + r * Math.cos(a1)).toFixed(2), y1 = (cy + r * Math.sin(a1)).toFixed(2);
        paths += '<path data-mark="series" d="M ' + cx + ' ' + cy + ' L ' + x0 + ' ' + y0 + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + ' Z" fill="' + ASSET_COLOR[a] + '"/>';
        a0 = a1;
      }
      return '<svg class="rv__pie" width="' + size + '" height="' + size + '" aria-hidden="true">' + paths + '</svg>';
    },

    // ── history-chart overlay toggles + legend ────────────────────────────────
    bgLegend() { return REGIME_BG_LEGEND; },
    // A price overlay is reference context, so it is drawn the way the
    // backtests draw the same asset's buy-and-hold line: slate, with that
    // line's dash. Teal and mint named On-chain and Conservative elsewhere on
    // this page. The chip's dot reads the same colour.
    overlayStyle(key) { return STRATEGY_STYLE[key === "spx" ? "sp500_hodl" : "eth_hodl"]; },
    overlayColor(key) { return this.overlayStyle(key).color; },
    hasSpx() { return (this.latest?.extras?.spx || []).length > 0; },
    hasEth() { return (this.latest?.extras?.eth || []).length > 0; },
    isVisible(key) { return !!this.visible[key]; },
    toggle(key) { this.visible[key] = !this.visible[key]; },
    // The history chart's empty state (.rm-nodata): a line needs two readings.
    historyEmpty() { return this.history.length < 2; },
    historyEmptyTitle() { return this.history.length === 1 ? "Not enough data yet" : "No data yet"; },
    historyEmptyDetail() { return this.history.length === 1 ? "One reading so far" : ""; },
    // Panel index on a history row: prefer the DTO camelCase, fall back to the
    // raw snapshot key so the chart works against either shape.
    _idx(h, panel) { const v = h[panel + "Index"]; return v != null ? v : h[panel]; },

    // ── the charts: the site's own (.rr-area, lib/line-chart.js) ─────────────
    // Both draw on an axis of one unit per calendar day (issue #624): a gap in
    // the persisted readings takes the width of the days it covers and breaks
    // the line, never bridged. Past a year the lines take one reading a week;
    // the bands behind them stay day by day.
    bandBg(state) { return REGIME_BAND_BG[state] || "transparent"; },
    historySeries() {
      const hasFactor = this.history.some((h) => this._idx(h, "factor") != null);
      return HISTORY_SERIES.filter(([k]) => k !== "factor" || hasFactor).map(([key, label]) => ({ key, label, color: STRATEGY_STYLE[key].color }));
    },
    toggleSeries(key) { this.series[key] = !this.series[key]; },
    setRange(id) { this.range = id; this.histWin = null; this.histAt = null; },
    // Every calendar day of the history, once per history.
    _allDays() {
      const h = this.history;
      const key = `${h.length}|${h[0]?.date}|${h[h.length - 1]?.date}`;
      if (DAYS_MEMO.key !== key) { DAYS_MEMO.key = key; DAYS_MEMO.days = denseDays(h.map((r) => r.date)); }
      return DAYS_MEMO.days;
    },
    // A chart's window over the whole history, [from, to] as day indices:
    // the dragged one, else the chip's.
    _win(which) {
      const all = this._allDays();
      const w = this[which + "Win"];
      if (w) return [w.from, w.to];
      const start = this._rangeStartFor(which === "hist" ? this.range : this.btRange, all[all.length - 1]);
      const from = start ? Math.max(0, all.findIndex((d) => d >= start)) : 0;
      return [from, Math.max(0, all.length - 1)];
    },
    chipOn(which, id) { return !this[which + "Win"] && (which === "hist" ? this.range : this.btRange) === id; },
    // The first day the range shows, or null for the whole history.
    _rangeStart(last) { return this._rangeStartFor(this.range, last); },
    _rangeStartFor(id, last) {
      const r = RANGES.find((x) => x.id === id);
      if (!r || r.id === "all" || !last) return null;
      if (r.id === "ytd") return last.slice(0, 4) + "-01-01";
      return new Date(Date.parse(last + "T00:00:00Z") - r.days * 86_400_000).toISOString().slice(0, 10);
    },
    // One model per history and range, reused by every binding that reads it
    // (lines, bands, ticks, crosshair) in the same render.
    _hist() {
      const h = this.history;
      const [from, to] = this._win("hist");
      const key = `${h.length}|${h[0]?.date}|${h[h.length - 1]?.date}|${from}|${to}`;
      if (HIST_MEMO.key === key) return HIST_MEMO.m;
      const all = this._allDays();
      const days = all.slice(from, to + 1);
      const byDate = new Map(h.map((r) => [r.date, r]));
      const idx = sampleDays(days.length, WEEKLY_AFTER_DAYS);
      const read = { composite: (r) => r.composite, macro: (r) => this._idx(r, "macro"), onchain: (r) => this._idx(r, "onchain"), factor: (r) => this._idx(r, "factor") };
      const values = {};
      for (const k of Object.keys(read)) values[k] = idx.map((i) => { const r = byDate.get(days[i]); const v = r ? read[k](r) : null; return v == null ? null : +v; });
      const extras = this.latest?.extras || {};
      for (const k of ["spx", "eth"]) { const a = alignToDates(extras[k] || [], days); values[k] = idx.map((i) => a[i] ?? null); }
      const regimes = days.map((d) => byDate.get(d)?.regime ?? null);
      const m = { days, n: days.length, idx, values, regimes, runs: bandRuns(regimes), ticks: dateTicks(days), weekly: days.length > WEEKLY_AFTER_DAYS };
      HIST_MEMO.key = key; HIST_MEMO.m = m;
      return m;
    },
    historyWeekly() { return this._hist().weekly; },
    historyDays() { return this._hist().n; },
    // The lines drawn now: each index that is on, then any price overlay that
    // is on. A price overlay has its own log scale, fitted to the range.
    _histLines() {
      const m = this._hist();
      const out = this.historySeries().filter((s) => this.series[s.key]).map((s) => ({ token: s.key, color: s.color, width: s.key === "composite" ? 2 : 1.25, values: m.values[s.key], y: (v) => v }));
      for (const k of ["spx", "eth"]) {
        if (!this.visible[k] || !(this.latest?.extras?.[k] || []).length) continue;
        const vals = m.values[k].filter((v) => v > 0);
        if (!vals.length) continue;
        const f = yScale({ min: Math.min(...vals), max: Math.max(...vals), log: true });
        const st = this.overlayStyle(k);
        out.push({ token: k, color: st.color, width: 1.25, dash: st.dash, values: m.values[k], y: f, price: true });
      }
      return out;
    },
    historySvg() {
      if (this.historyEmpty()) return "";
      const m = this._hist();
      const lines = this._histLines();
      // Each line is placed by its own scale and drawn on a unit one.
      return lineChartSvg({
        n: m.n, y: (v) => v, grid: [0.25, 0.5, 0.75],
        series: lines.map((l) => ({ token: l.token, color: l.color, width: l.width, dash: l.dash, muted: !!this.histFocus && this.histFocus !== l.token, points: m.idx.map((i, k) => ({ i, v: l.values[k] == null ? null : l.y(l.values[k]) })) })),
      });
    },
    historyBands() { return this.visible.bands ? this._hist().runs : []; },
    historyYTicks() { return [1, 0.75, 0.5, 0.25, 0].map((v) => ({ key: v, top: (1 - v) * 100, label: v.toFixed(2) })); },
    historyXTicks() { return this._hist().ticks; },
    historyLabel() {
      const m = this._hist();
      if (!m.n) return "";
      const last = this.history[this.history.length - 1];
      return `The composite and its panel indices, 0 risk-off to 1 risk-on, ${this.dateLong(m.days[0])} to ${this.dateLong(m.days[m.n - 1])}${m.weekly ? ", one reading a week" : ""}. Latest: ${this.regimeLabel(last?.regime)}, composite ${last?.composite == null ? "none" : (+last.composite).toFixed(2)}. Use the arrow keys to step through the readings.`;
    },
    // The legend: each line with its latest value; hover focuses it, a click
    // switches it off and on.
    historyLegend() {
      const m = this._hist();
      const lastOf = (arr) => { for (let k = arr.length - 1; k >= 0; k--) if (arr[k] != null) return arr[k]; return null; };
      const rows = this.historySeries().map((s) => { const v = lastOf(m.values[s.key]); return { ...s, on: !!this.series[s.key], value: v == null ? "—" : v.toFixed(2) }; });
      for (const k of ["spx", "eth"]) {
        if (!(this.latest?.extras?.[k] || []).length) continue;
        const v = lastOf(m.values[k]);
        rows.push({ key: k, label: k === "spx" ? "S&P 500" : "ETH", color: this.overlayColor(k), dash: this.overlayStyle(k).dash, on: !!this.visible[k], value: v == null ? "—" : fmtUsdCompact(v), price: true });
      }
      return rows;
    },
    legendToggle(row) { if (row.price) this.toggle(row.key); else this.toggleSeries(row.key); },
    historyMove(ev) { const m = this._hist(); if (m.n) this.histAt = nearestSample(m.idx, m.n, ev); },
    historyKey(ev) { this.histAt = stepAt(ev, this.histAt, this._hist().idx.length); },
    historyPoint() {
      const m = this._hist();
      const k = this.histAt;
      if (k == null || m.idx[k] == null) return null;
      const i = m.idx[k];
      const r = this.history.find((h) => h.date === m.days[i]);
      const items = this._histLines().map((l) => ({ token: l.token, label: this.historyLegend().find((x) => x.key === l.token)?.label || l.token, color: l.color, value: l.values[k] == null ? "—" : l.price ? fmtUsdCompact(l.values[k]) : (+l.values[k]).toFixed(2) }));
      return { left: (i / Math.max(1, m.n - 1)) * 100, date: this.dateLong(m.days[i]), regime: r?.regime ? this.regimeLabel(r.regime) : "", regimeColor: this.regimeColor(r?.regime), items };
    },

    // Backtests: one market at a time behind the switch, every market's
    // table still in the page.
    // The backtest's own windows. The split is the engine's
    // BACKTEST_IN_SAMPLE_END (backend/src/analytics/analyze/backtest.ts,
    // 2024-01-31); the ends are the strategy's own start and end dates.
    btWindow(key) {
      const s = this.latest?.backtest?.[key]?.composite || Object.values(this.latest?.backtest?.[key] || {})[0] || {};
      const my = (d) => { const t = Date.parse(String(d) + "T00:00:00Z"); return isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "—"; };
      return { start: my(s.start_date), end: my(s.end_date), inEnd: "Jan 2024", outStart: "Feb 2024" };
    },
    marketLabel(bt) { return bt.title.replace(/^Backtest · /, "").replace(/SP500/g, "S&P 500"); },
    setMarket(key) { this.btMarket = key; this.btAt = null; this.btFocus = null; },
    setBtRange(id) { this.btRange = id; this.btWin = null; this.btAt = null; },

    // ── the range navigator: the whole history in miniature, with the window
    // on show; drag either end, or the window itself, as on a price chart.
    navModel(which) {
      const all = this._allDays();
      const n = all.length;
      const [from, to] = this._win(which);
      const pct = (i) => (i / Math.max(1, n - 1)) * 100;
      return { n, from, to, left: pct(from), width: pct(to) - pct(from), fromLabel: this.dateLong(all[from]), toLabel: this.dateLong(all[to]), ticks: dateTicks(all).filter((t) => !t.cls) };
    },
    navSvg(which) {
      const all = this._allDays();
      if (all.length < 2) return "";
      const idx = sampleDays(all.length, 60);
      if (which === "hist") {
        const byDate = new Map(this.history.map((r) => [r.date, r]));
        return lineChartSvg({ n: all.length, y: (v) => v, series: [{ token: "nav", color: "rgba(242,244,249,0.45)", width: 1, points: idx.map((i) => { const v = byDate.get(all[i])?.composite; return { i, v: v == null ? null : +v }; }) }] });
      }
      const curve = this.latest?.backtest?.[this.btMarket]?.composite?.equity_curve || [];
      const pos = new Map(all.map((d, i) => [d, i]));
      const pts = curve.filter((p) => pos.has(p.date)).map((p) => ({ i: pos.get(p.date), v: +p.value }));
      const vals = pts.map((p) => p.v).filter((v) => v > 0);
      if (!vals.length) return "";
      const f = yScale({ min: Math.min(...vals) * 0.95, max: Math.max(...vals) * 1.05, log: true });
      return lineChartSvg({ n: all.length, y: f, series: [{ token: "nav", color: "rgba(242,244,249,0.45)", width: 1, points: pts }] });
    },
    _navAt(ev, el) {
      const n = this._allDays().length;
      const r = el.getBoundingClientRect();
      return ((ev.clientX - r.left) / Math.max(1, r.width)) * Math.max(1, n - 1);
    },
    navStart(which, ev) {
      const el = ev.currentTarget;
      const n = this._allDays().length;
      if (n < MIN_WINDOW + 1) return;
      const at = this._navAt(ev, el);
      let [from, to] = this._win(which);
      let grab = ev.target?.closest?.("[data-grab]")?.getAttribute("data-grab") || "";
      if (!grab) {
        // Outside the window: it moves there, centred on the pointer.
        const width = to - from;
        const start = Math.max(0, Math.min(n - 1 - width, Math.round(at - width / 2)));
        from = start; to = start + width;
        this[which + "Win"] = { from, to };
        grab = "pan";
      }
      this._drag = { which, grab, offset: at - from };
      el.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
    },
    navMove(which, ev) {
      const d = this._drag;
      if (!d || d.which !== which) return;
      const [from, to] = this._win(which);
      const [f, t] = dragWindow(d.grab, this._navAt(ev, ev.currentTarget), { from, to, offset: d.offset, n: this._allDays().length, min: MIN_WINDOW });
      if (f !== from || t !== to) { this[which + "Win"] = { from: f, to: t }; this[which + "At"] = null; }
    },
    navEnd() { this._drag = null; },
    // Arrow keys move an end by a day, with Shift by a month.
    navKey(which, grab, ev) {
      const step = ev.shiftKey ? 30 : 1;
      const dir = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
      if (!dir) return;
      ev.preventDefault();
      const [from, to] = this._win(which);
      const at = (grab === "from" ? from : to) + dir * step;
      const [f, t] = dragWindow(grab, at, { from, to, offset: 0, n: this._allDays().length, min: MIN_WINDOW });
      this[which + "Win"] = { from: f, to: t };
    },
    // One market's curves over the chosen range. The engine keeps one point a
    // month (the month-end value), so each line is drawn through those points,
    // on the same calendar-day axis as the history. Short of the whole
    // backtest, each curve is rebased to $1 at its first point in the range,
    // so the chart reads as growth over that range; the table stays the whole
    // backtest.
    _bt(key) {
      const h = this.history;
      const [from, to] = this._win("bt");
      const cacheKey = `${key}|${h.length}|${h[h.length - 1]?.date}|${!!this.latest?.backtest}|${from}|${to}`;
      if (BT_MEMO.has(cacheKey)) return BT_MEMO.get(cacheKey);
      const all = this._allDays();
      const days = all.slice(from, to + 1);
      const pos = new Map(days.map((d, i) => [d, i]));
      const byDate = new Map(h.map((r) => [r.date, r]));
      const strategies = this.latest?.backtest?.[key] || {};
      const keys = this._curveKeys(key);
      const idxSet = new Set();
      for (const sk of keys) for (const pt of strategies[sk].equity_curve) if (pos.has(pt.date)) idxSet.add(pos.get(pt.date));
      const idx = [...idxSet].sort((a, b) => a - b);
      const rebased = from > 0;
      const lines = keys.map((sk) => {
        const at = new Map(strategies[sk].equity_curve.map((pt) => [pt.date, pt.value]));
        let vals = idx.map((i) => { const v = at.get(days[i]); return v == null ? null : +v; });
        if (rebased) { const first = vals.find((v) => v != null && v > 0); vals = vals.map((v) => (v == null || !first ? null : v / first)); }
        const st = STRATEGY_STYLE[sk];
        return { token: sk, label: st.label, color: st.color, baseline: !!st.baseline, dash: st.baseline ? (st.dash || [4, 3]) : null, values: vals };
      });
      const flat = lines.flatMap((l) => l.values).filter((v) => v > 0);
      const lo = flat.length ? Math.min(...flat) : 0.1, hi = flat.length ? Math.max(...flat) : 10;
      const min = lo * 0.92, max = hi * 1.08;
      const regimes = days.map((d) => byDate.get(d)?.regime ?? null);
      const m = { days, n: days.length, idx, lines, min, max, rebased, from: idx.length ? days[idx[0]] : null, runs: bandRuns(regimes), ticks: dateTicks(days) };
      if (BT_MEMO.size > 24) BT_MEMO.clear();
      BT_MEMO.set(cacheKey, m);
      return m;
    },
    // What the chart shows, in a sentence: the value of $1 over time, from
    // the backtest's start or, over a shorter range, from that range's first
    // month-end.
    btIntro(key) {
      const m = this._bt(key);
      const from = m.from ? this.dateLong(m.from) : "the start";
      return `What $1 put into each strategy on ${from} was worth at each month-end after. Log scale: an equal step up or down is the same percentage move.`;
    },
    money(v) {
      if (v == null || !isFinite(v)) return "—";
      const n = +v;
      return "$" + (Number.isInteger(n) ? String(n) : n.toFixed(2));
    },
    // Signed returns read as deltas: green up, --color-warn down.
    deltaColor(v) { return v == null || Math.abs(v) < 0.0005 ? PALETTE.textMuted : v > 0 ? SERIES.emerald : PALETTE.warn; },
    // The table's columns, each with what it means.
    btColumns() {
      return [
        { key: "final", label: "$1 became", tip: "What $1 put in at the start was worth at the end, after trading costs." },
        { key: "cagr", label: "CAGR", tip: "Compound annual growth rate: the steady yearly return that ends at the same place." },
        { key: "in", label: "In-sample", tip: "CAGR from May 2018 to January 2024, the years the indicators and their parameters were chosen on." },
        { key: "out", label: "Out-of-sample", tip: "CAGR from February 2024 on, which the method never saw while it was being built." },
        { key: "sharpe", label: "Sharpe", tip: "Return per unit of volatility, a year at a time. Higher means more return for the same ups and downs." },
        { key: "dd", label: "Max DD", tip: "Maximum drawdown: the largest fall from a peak to the low after it." , end: true },
        { key: "trades", label: "Trades", tip: "How many times the strategy changed what it holds. The baselines never trade.", end: true },
      ];
    },
    btSvg(key) {
      if (this.btMarket !== key || this.btEmptyTitle(key)) return "";
      const m = this._bt(key);
      const f = yScale({ min: m.min, max: m.max, log: true });
      const grid = logTicks(m.min, m.max).map(f);
      return lineChartSvg({
        n: m.n, y: f, grid,
        series: m.lines.filter((l) => !this.btHidden[key + ":" + l.token]).map((l) => ({ token: l.token, color: l.color, width: l.baseline ? 1 : 1.5, dash: l.dash, muted: !!this.btFocus && this.btFocus !== l.token, points: m.idx.map((i, k) => ({ i, v: l.values[k] })) })),
      });
    },
    btBands(key) { return this.visible.btBands && this.btMarket === key && !this.btEmptyTitle(key) ? this._bt(key).runs : []; },
    btYTicks(key) {
      if (this.btMarket !== key || this.btEmptyTitle(key)) return [];
      const m = this._bt(key);
      const f = yScale({ min: m.min, max: m.max, log: true });
      return logTicks(m.min, m.max).map((v) => ({ key: v, top: (1 - f(v)) * 100, label: this.money(v) }));
    },
    btXTicks(key) { return this.btMarket === key && !this.btEmptyTitle(key) ? this._bt(key).ticks : []; },
    btLegend(key) {
      const m = this._bt(key);
      return m.lines.map((l) => {
        let last = null;
        for (let k = l.values.length - 1; k >= 0; k--) if (l.values[k] != null) { last = l.values[k]; break; }
        return { key: l.token, id: key + ":" + l.token, label: l.label, color: l.color, dash: l.dash, on: !this.btHidden[key + ":" + l.token], value: this.money(last) };
      });
    },
    toggleBt(id) { this.btHidden[id] = !this.btHidden[id]; },
    btMove(key, ev) { const m = this._bt(key); if (m.n) this.btAt = nearestSample(m.idx, m.n, ev); },
    btKey(key, ev) { this.btAt = stepAt(ev, this.btAt, this._bt(key).idx.length); },
    btPoint(key) {
      if (this.btAt == null || this.btMarket !== key) return null;
      const m = this._bt(key);
      const k = this.btAt;
      const i = m.idx[k];
      if (i == null) return null;
      const r = this.history.find((h) => h.date === m.days[i]);
      const items = m.lines.filter((l) => !this.btHidden[key + ":" + l.token]).map((l) => ({ token: l.token, label: l.label, color: l.color, value: this.money(l.values[k]) }));
      return { left: (i / Math.max(1, m.n - 1)) * 100, date: this.dateLong(m.days[i]), regime: r?.regime ? this.regimeLabel(r.regime) : "", regimeColor: this.regimeColor(r?.regime), items };
    },
    btLabel(key) {
      const m = this._bt(key);
      if (!m.n) return "";
      return `Growth of $1 under each strategy, log scale, ${this.dateLong(m.days[0])} to ${this.dateLong(m.days[m.n - 1])}, month-end values${m.rebased ? ", rebased at the start of the range" : ""}, the composite regime shaded behind. Use the arrow keys to step through the readings.`;
    },
    // A dashed baseline's legend key: a short run of its line.
    dashKey(color, dash) {
      return `<svg width="14" height="8" aria-hidden="true"><line x1="0" y1="4" x2="14" y2="4" stroke="${color}" stroke-width="1.5" stroke-dasharray="${(dash || []).map((v) => v / 2).join(" ")}"/></svg>`;
    },

    destroy() {
      if (this._onHash) removeEventListener("hashchange", this._onHash);
    },
  }));
}
