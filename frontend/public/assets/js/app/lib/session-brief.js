// What the swarm was handed when a session opened — including the regime read.
//
// The fourth extraction, after session-summary, session-takes and
// allocation-framework. It exists because the two halves were being drawn as
// two unrelated blocks: /swarm/sessions/<id> carried a "Market backdrop" panel,
// and a subject profile carried a "What the swarm is given" list, and the
// backdrop's own copy said what it was — "the regime read attached to this
// session's brief". One of the parts, rendered separately, on a different page,
// in a different vocabulary. One card now, on both pages: the session page
// shows the brief THAT session opened with, a subject profile shows the most
// recent one.
//
// A factory, because the reading is state.
import { CATEGORICAL } from "./chart-theme.js";

// The three panels behind the composite, in a fixed reading order so the rail
// means the same thing on every session.
const PANELS = [
  { key: "macro", label: "macro" },
  { key: "onchain", label: "on-chain" },
  { key: "factor", label: "factor" },
];

// `helpers` belongs to the SURFACE, not to this module: ordinal, regimeColor,
// regimeLabel, formatDate and escapeHtml are spread into both factories that
// spread this one. A cast at the call site, and deliberately NOT a `get hx()`
// on the returned object — object spread EVALUATES a getter and copies its
// value, so `...sessionBrief()` would have frozen it to this module's own
// object, which has none of those helpers on it. It did, and every SVG in the
// card came out empty.
/** @param {any} self */
const surface = (self) => /** @type {any} */ (self);

/** @param {any} v */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// One shape out of three inputs: the API's camelCase session DTO, the static
// archive's snake_case file, and the brief's own `regime` object. They carry
// the same reading under three spellings, and every call site was picking one.
/** @param {any} raw */
export function normalizeRegime(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (/** @type {string} */ camel, /** @type {string} */ snake) =>
    num(raw[camel] !== undefined ? raw[camel] : raw[snake]);
  const out = {
    composite: pick("composite", "composite"),
    compositePercentile: pick("compositePercentile", "composite_percentile"),
    regime: String(raw.regime || ""),
    macro: pick("macroPercentile", "macro_percentile"),
    onchain: pick("onchainPercentile", "onchain_percentile"),
    factor: pick("factorPercentile", "factor_percentile"),
    macroRegime: String(raw.macroRegime || raw.macro_regime || ""),
    onchainRegime: String(raw.onchainRegime || raw.onchain_regime || ""),
    factorRegime: String(raw.factorRegime || raw.factor_regime || ""),
    history: Array.isArray(raw.history) ? raw.history : [],
  };
  return out.composite === null && !out.regime ? null : out;
}

export function sessionBrief() {
  return {
    /** @type {any} */
    backdrop: null,
    // "session" on a session page, "latest" on a subject profile. The only
    // thing that differs between the two renders, so the two cannot drift.
    backdropScope: "session",
    backdropDate: "",

    /** @param {any} summary @param {{date?: string, scope?: string}} opts */
    setBackdrop(summary, opts = {}) {
      this.backdrop = normalizeRegime(summary);
      this.backdropDate = opts.date || "";
      this.backdropScope = opts.scope || "session";
      return this.backdrop;
    },

    // Composite first, then its three panels. Every row is a percentile
    // against ITS OWN history, which is what makes them comparable on one
    // axis — the raw 0-1 composite is comparable to nothing and is printed as
    // a figure rather than drawn as a bar.
    regimeRows() {
      const b = this.backdrop;
      if (!b) return [];
      const rows = [];
      if (b.compositePercentile !== null) {
        rows.push({ key: "composite", label: "composite", pct: b.compositePercentile, regime: b.regime, lead: true });
      }
      for (const p of PANELS) {
        const pct = b[p.key];
        if (pct !== null) rows.push({ key: p.key, label: p.label, pct, regime: b[`${p.key}Regime`], lead: false });
      }
      return rows;
    },
    // The panels that read the opposite way to the composite. This is the
    // disagreement the members argue about in the takes below, so the card
    // names it rather than leaving it to be spotted in three bars.
    dissenters() {
      const b = this.backdrop;
      if (!b?.regime) return [];
      return PANELS
        .filter((p) => b[`${p.key}Regime`] && b[`${p.key}Regime`] !== b.regime && b[p.key] !== null)
        .map((p) => ({ ...p, pct: b[p.key], regime: b[`${p.key}Regime`] }));
    },
    // Always a sentence, including when nothing dissents: the silent-when-
    // agreeing branch is why the old panel's second column emptied out. No em
    // dash, per the house copy rule.
    regimeFinding() {
      const b = this.backdrop;
      if (!b) return "";
      const rows = this.regimeRows().filter((r) => !r.lead);
      if (!rows.length) return "No panel percentiles were recorded for this session.";
      const ord = (/** @type {number} */ p) => surface(this).ordinal(p);
      const d = this.dissenters();
      const word = surface(this).regimeLabel(b.regime);
      if (!d.length) return `All three panels read the same way as the composite: ${word}.`;
      const names = d.map((x) => `${x.label} at the ${ord(x.pct)}`).join(" and ");
      return `${d.length === 1 ? "One panel dissents" : "Two panels dissent"}: ${names}, against a ${word} composite at the ${ord(b.compositePercentile)}.`;
    },
    backdropScopeLine() {
      const when = this.backdropDate ? surface(this).formatDate(this.backdropDate, "long") : "";
      return this.backdropScope === "latest"
        ? `From the most recent session${when ? `, ${when}` : ""}.`
        : `The brief this session opened with${when ? `, ${when}` : ""}.`;
    },

    // ── the rail ─────────────────────────────────────────────────────────
    // Four readings on ONE percentile axis. The card used to draw the
    // composite as a bar on a RAW 0-1 scale directly above a caption reading
    // "76th percentile", in the same bar vocabulary as the panel bars beside
    // it: two figures for one reading, 18 points apart, with nothing telling
    // the reader which axis each belonged to.
    //
    // Length is magnitude and is one green for every row. Direction is a dot,
    // in the stance colour. They were confounded in a single coloured bar, so
    // a long green bar could not be read as "high" or as "risk-on".
    //
    // The cyan line is the composite's own position, drawn across every panel
    // row: cyan is a LINE and never fills a figure. Reading a panel against
    // the composite is the question this figure exists to answer, and it was
    // left to arithmetic.
    regimeRailSvg() {
      const rows = this.regimeRows();
      if (!rows.length) return "";
      const W = 320, LABEL = 62, VAL = 30, ROW = 16, GAP = 7, TOP = 14;
      const BAR = W - LABEL - VAL;
      const H = TOP + rows.length * ROW + (rows.length - 1) * GAP + 8;
      const x = (/** @type {number} */ pct) => LABEL + Math.max(0, Math.min(1, pct)) * BAR;
      const parts = [];
      // Axis first, behind everything.
      parts.push(`<line x1="${LABEL}" y1="${TOP - 5}" x2="${LABEL + BAR}" y2="${TOP - 5}" stroke="var(--color-border)"/>`);
      for (const [pct, label, anchor] of [[0, "0", "start"], [0.5, "50th", "middle"], [1, "100th", "end"]]) {
        parts.push(`<text x="${x(Number(pct))}" y="${TOP - 9}" text-anchor="${anchor}" font-size="7.5" fill="var(--color-text-muted)" font-family="var(--font-mono)" letter-spacing="0.08em">${label}</text>`);
      }
      // The 50th, full height and BEHIND the fills. It used to be drawn inside
      // the bars, so it was occluded on every row above the median, which is
      // most of them.
      parts.push(`<line x1="${x(0.5)}" y1="${TOP - 5}" x2="${x(0.5)}" y2="${H - 4}" stroke="var(--color-border)" stroke-dasharray="2 3"/>`);
      rows.forEach((r, i) => {
        const y = TOP + i * (ROW + GAP);
        const mid = y + ROW / 2;
        parts.push(`<text x="0" y="${mid + 3}" font-size="8" fill="var(--color-text-muted)" font-family="var(--font-mono)" letter-spacing="0.1em">${surface(this).escapeHtml(r.label.toUpperCase())}</text>`);
        parts.push(`<rect x="${LABEL - 10}" y="${mid - 3}" width="6" height="6" fill="${surface(this).regimeColor(r.regime)}"/>`);
        parts.push(`<rect x="${LABEL}" y="${y + 3}" width="${BAR}" height="${ROW - 6}" fill="none" stroke="var(--color-border)"/>`);
        parts.push(`<rect data-mark="series" x="${LABEL}" y="${y + 3}" width="${Math.max(1, x(r.pct) - LABEL)}" height="${ROW - 6}" fill="var(--color-green)"/>`);
        parts.push(`<text x="${W}" y="${mid + 3}" text-anchor="end" font-size="8.5" fill="${r.lead ? "var(--color-text)" : "var(--color-text-muted)"}" font-family="var(--font-mono)">${surface(this).ordinal(r.pct)}</text>`);
      });
      // The composite's line, last, on top of the fills.
      const lead = rows.find((r) => r.lead);
      if (lead) {
        parts.push(`<line x1="${x(lead.pct)}" y1="${TOP - 5}" x2="${x(lead.pct)}" y2="${H - 4}" stroke="var(--color-accent)"/>`);
      }
      const read = rows.map((r) => `${r.label} ${surface(this).ordinal(r.pct)}`).join(", ");
      return `<svg class="mb__rail" viewBox="0 0 ${W} ${H}" role="img" aria-label="Percentile against own history: ${surface(this).escapeHtml(read)}."><g>${parts.join("")}</g></svg>`;
    },

    // ── the trail ────────────────────────────────────────────────────────
    // Autoscaled to the window, not pinned to 0-1. The old sparkline plotted a
    // series spanning about 0.03 on a fixed 0-to-1 axis, so it occupied ~4% of
    // the plot height and rendered as a dead horizontal stroke — and the
    // 0.33/0.67 band lines, always off-window, were the only thing with any
    // shape in the figure.
    //
    // The floor matters as much as the autoscale: below a 0.02 span the range
    // is held open, so a genuinely flat fortnight still reads flat instead of
    // a 0.001 wobble being sold as a swing. The min and max are printed, so
    // the amplitude is never implied.
    regimeTrailSvg() {
      const hist = (this.backdrop?.history || [])
        .map((/** @type {any} */ h) => num(h?.composite))
        .filter((/** @type {number|null} */ v) => v !== null);
      if (hist.length < 2) return "";
      const W = 200, H = 42, PAD = 3;
      let lo = Math.min(...hist), hi = Math.max(...hist);
      if (hi - lo < 0.02) { const m = (hi + lo) / 2; lo = m - 0.01; hi = m + 0.01; }
      const y = (/** @type {number} */ v) => PAD + (1 - (v - lo) / (hi - lo)) * (H - PAD * 2);
      const step = (W - 34) / (hist.length - 1);
      const pts = hist.map((/** @type {number} */ v, /** @type {number} */ i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`);
      const last = hist[hist.length - 1];
      return `<svg class="mb__trail" viewBox="0 0 ${W} ${H}" role="img" aria-label="Composite over the last ${hist.length} sessions, ${lo.toFixed(3)} to ${hi.toFixed(3)}.">`
        + `<polyline fill="none" stroke="var(--color-accent)" stroke-width="1.5" points="${pts.join(" ")}"/>`
        + `<circle data-mark="series" cx="${((hist.length - 1) * step).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="${surface(this).regimeColor(this.backdrop?.regime)}"/>`
        + `<text x="${W}" y="9" text-anchor="end" font-size="7.5" fill="var(--color-text-muted)" font-family="var(--font-mono)">${hi.toFixed(3)}</text>`
        + `<text x="${W}" y="${H - 2}" text-anchor="end" font-size="7.5" fill="var(--color-text-muted)" font-family="var(--font-mono)">${lo.toFixed(3)}</text>`
        + `</svg>`;
    },
    trailCaption() {
      const n = (this.backdrop?.history || []).length;
      return n >= 2 ? `composite, last ${n} sessions` : "";
    },
  };
}

// Kept beside the module that consumes it: the allocation sleeve colours are
// CATEGORICAL by published position, and nothing in this file paints a sleeve.
// Re-exported so a caller does not have to import two modules to draw a brief.
export { CATEGORICAL };
