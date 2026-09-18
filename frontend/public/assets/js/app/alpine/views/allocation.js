// Allocation recommendation plus four-vault implementation. No house-book assets.
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, CATEGORICAL } from "../../lib/chart-theme.js";
import { vaultData } from "./vault.js";
import { escapeHtml } from "../../components/subject-research.js";
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
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
  if (a1 - a0 >= 359.999)
    return `M${cx},${cy - outer} A${outer},${outer} 0 1 1 ${cx},${cy + outer} A${outer},${outer} 0 1 1 ${cx},${cy - outer} M${cx},${cy - inner} A${inner},${inner} 0 1 0 ${cx},${cy + inner} A${inner},${inner} 0 1 0 ${cx},${cy - inner} Z`;
  const rad = (a) => ((a - 90) * Math.PI) / 180;
  const pt = (r, a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = pt(outer, a0);
  const [x1, y1] = pt(outer, a1);
  const [x2, y2] = pt(inner, a1);
  const [x3, y3] = pt(inner, a0);
  return (
    `M${x0.toFixed(2)},${y0.toFixed(2)}` +
    ` A${outer},${outer} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}` +
    ` L${x2.toFixed(2)},${y2.toFixed(2)}` +
    ` A${inner},${inner} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)}` +
    " Z"
  );
}

export function registerAllocationView(Alpine) {
  Alpine.data("allocationView", () => ({
    ...vaultData(),
    allocationFw: null,
    loading: true,
    hotKey: null,
    init() {
      this.load();
    },
    async load() {
      await Promise.allSettled([
        this.loadVaults(),
        api.get(ROUTES.dashboards.allocation).then((d) => {
          this.allocationFw = d;
        }),
      ]);
      this.loading = false;
      this.$nextTick(() => {
        this.drawDonut();
        const id = location.hash.slice(1);
        if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
      });
    },
    fmtPct(v) {
      return v == null ? "Not reported" : Number(v).toFixed(2) + "%";
    },
    fmtPctTrim(v) {
      return v == null
        ? "Not reported"
        : Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";
    },
    allocationAsOfLabel() {
      return longDay(this.allocationFw?.asOf);
    },
    hasTargets() {
      return this.sleeves().some(s => s.target !== null);
    },
    sleeves() {
      if (!this.vaultOverview.recommendation) return [];
      return this.vaultRows().map((v) => ({
        key: v.key,
        name: v.name,
        target: v.recommendedBps == null ? null : v.recommendedBps / 100,
        held: v.actualBps == null ? null : v.actualBps / 100,
        holding: v.actualBps > 0,
      }));
    },
    sleeveState(s) {
      return s.held == null
        ? "Actual weight not reported"
        : this.fmtPctTrim(s.held) + " held";
    },
    sleeveLegendLine(s) {
      const v = this.vaultRows().find((v) => v.key === s.key);
      return v ? `${v.symbol} · ${this.statusLabel(v)}` : "";
    },
    sleeveColours() {
      return Object.fromEntries(this.vaultRows().map((v) => [v.key, v.color]));
    },
    sleeveSwatch(s) {
      return `background:${this.sleeveColours()[s.key]}`;
    },
    showTip(row, event) {
      const tip = this.$refs.allocTip,
        v = this.vaultRows().find((v) => v.key === row.key);
      if (!tip || !v) return;
      tip.innerHTML =
        `<b>${escapeHtml(v.name)}</b>` +
        ["recommended", "applied", "actual"]
          .map((k) => `<span><em>${k}</em>${this.weight(v[k + "Bps"])}</span>`)
          .join("");
      tip.style.opacity = "1";
      this.moveTip(event);
    },
    moveTip(event) {
      const tip = this.$refs.allocTip;
      if (!tip || !event) return;
      const r = tip.getBoundingClientRect();
      tip.style.left =
        Math.max(8, Math.min(innerWidth - r.width - 8, event.clientX + 14)) +
        "px";
      tip.style.top =
        Math.max(8, Math.min(innerHeight - r.height - 8, event.clientY + 14)) +
        "px";
    },
    hideTip() {
      if (this.$refs.allocTip) this.$refs.allocTip.style.opacity = "0";
      this.hotKey = null;
    },
    dimTo(key) {
      this.$refs.donut
        ?.querySelectorAll("path[data-sleeve]")
        .forEach((n) =>
          n.classList.toggle("dim", !!key && n.dataset.sleeve !== key),
        );
    },
    hoverSleeve(row, event) {
      this.showTip(row, event);
      this.dimTo(row.key);
    },
    leaveSleeve() {
      this.hideTip();
      this.dimTo(null);
    },
    drawDonut() {
      const host = this.$refs.donut;
      if (!host) return;
      host.replaceChildren();
      const rows = this.sleeves();
      if (!rows.length) return;

      const CX = 120,
        CY = 120,
        OUTER = 104,
        INNER = 66,
        GAP = 1.6;
      const colours = this.sleeveColours();

      // The unallocated remainder, and the track every slice sits on.
      host.appendChild(
        svg("circle", {
          cx: CX,
          cy: CY,
          r: (OUTER + INNER) / 2,
          fill: "none",
          stroke: PALETTE.surfaceLight,
          "stroke-width": OUTER - INNER,
        }),
      );

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
          d: donutArc(CX, CY, OUTER, INNER, a0, a1),
          fill: colours[row.key],
          "data-mark": "series",
        });
        // The hover layer the pie charts on the old page had, kept. Dimming
        // the others rather than lifting the hovered one, so the ring keeps
        // its geometry and only its emphasis moves.
        path.addEventListener("pointerenter", (ev) => {
          this.showTip(row, ev);
          this.dimTo(row.key);
        });
        path.addEventListener("pointermove", (ev) => this.showTip(row, ev));
        path.addEventListener("pointerleave", () => {
          this.hideTip();
          this.dimTo(null);
        });
        path.dataset.sleeve = row.key;
        host.appendChild(path);
      });

      // The hole carries what the ring adds up to. It carried the date the
      // weights had been in force, which the rail directly above it already
      // states; a figure printed twice within one screen is one figure and one
      // decoration. The sum is the one thing the ring cannot say for itself:
      // it is drawn to the full 360, so a policy adding to less than 100
      // leaves an unfilled arc, and this names what is missing from it.
      const total = this.sleeves().reduce(
        (n, r) => n + (Number(r.target) || 0),
        0,
      );
      const gap = 100 - total;
      const complete = this.sleeves().every((r) => r.target != null);
      host.appendChild(
        label(
          svg("text", {
            x: CX,
            y: CY - 12,
            "text-anchor": "middle",
            fill: PALETTE.textMuted,
            "font-family": "'JetBrains Mono',monospace",
            "font-size": 9,
            "letter-spacing": "0.18em",
          }),
          complete ? "RECOMMENDED" : "REPORTED",
        ),
      );
      host.appendChild(
        label(
          svg("text", {
            x: CX,
            y: CY + 8,
            "text-anchor": "middle",
            fill: PALETTE.text,
            "font-family": "'JetBrains Mono',monospace",
            "font-size": 15,
            "font-weight": 700,
          }),
          this.fmtPctTrim(total),
        ),
      );
      if (Math.abs(gap) >= 0.005) {
        host.appendChild(
          label(
            svg("text", {
              x: CX,
              y: CY + 24,
              "text-anchor": "middle",
              fill: PALETTE.textMuted,
              "font-family": "'JetBrains Mono',monospace",
              "font-size": 9,
            }),
            complete
              ? `${this.fmtPctTrim(Math.abs(gap))} ${gap > 0 ? "unallocated" : "over"}`
              : "Some weights unavailable",
          ),
        );
      }

      host.setAttribute(
        "aria-label",
        "Recommended allocation, " +
          rows
            .map(
              (s) =>
                `${s.name} at a ${this.fmtPctTrim(s.target)} target, ${this.sleeveState(s)}`,
            )
            .join("; ") +
          ".",
      );
    },
  }));
}
