// Alpine factory for /allocation/history — the allocation's decision log
// (RM-115).
//
// AN INDEX, NOT A DETAIL PAGE. One row per published session on the allocation
// subject: date, regime, quorum, what the session recommended, what the
// allocation was afterwards, whether it changed, and a link to the session.
// /swarm/sessions/<uuid> already renders the whole receipt for one session —
// the recommendation, the bucket bars, proposed against target, the drift, the
// disagreements and one card per member — so this page carries none of it. No
// takes, no member cards, no synthesis prose. That is what keeps one session's
// record in exactly one place.
//
// Its predecessor is /swarm/subjects/robotmoney-allocation, which redirects
// here (routes.js). That page is a PORTFOLIO profile: concentration over time,
// a holdings table, tracked wallets. The allocation is a framework, not a book
// — `source: {type: "framework"}` with `wallets: []` and a structural note
// reading "no portfolio to scrape" — so the template had no place for the
// columns below and rendered a chart for a book that does not exist.
//
// Reads GET /api/swarm/sessions and GET /api/dashboards/allocation. Nothing
// else. In particular it does NOT read the consensus-receipt route: that route
// returns 500 for every published session today (RM-115's second backend ask),
// and a page that fires 59 failing requests to render a column is worse than a
// page that says the receipt is not readable yet.
//
// THE TRUE STATE, AND THE PAGE SAYS IT PLAINLY: `allocation_framework` has
// exactly one writer, backend/src/db/seed.ts, and one row, asOf 2026-06-02. No
// session has ever changed the allocation. Every row therefore reads
// "unchanged" and the resulting-allocation column is the seeded row. This is
// derived from the data rather than typed: a session that publishes a weight
// vector differing from the target is reported as having PROPOSED a change,
// which is a different claim from having made one.
import { api, ROUTES } from "../../lib/api.js";
import { PALETTE, SERIES } from "../../lib/chart-theme.js";
import { ALLOCATION_SUBJECT_ID, isPublishedAllocationSession } from "../../lib/allocation-subject.js";

// The list is paginated. 209 published sessions arrive in 3 requests at this
// limit; the cap is a runaway guard, not a business rule, and hitting it is
// reported rather than presented as the whole set.
const SESSION_PAGE_SIZE = 100;
const MAX_SESSION_PAGES = 12;
const ROWS_STEP = 25;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SVG_NS = "http://www.w3.org/2000/svg";
const DAY_MS = 86_400_000;

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
function dayMs(iso) {
  const t = Date.parse(String(iso || "") + "T00:00:00Z");
  return Number.isFinite(t) ? t : null;
}

// The API serves regimeSummary with a camelCase OUTER key and snake_case INNER
// keys; the archive JSON is snake_case throughout. Read both rather than
// picking one and rendering a blank wherever the other shape arrives, the same
// normalization static-views.js's camelSession does for the detail page.
function regimeOf(s) {
  const rs = s?.regimeSummary || s?.regime_summary;
  if (!rs) return null;
  return {
    regime: rs.regime || null,
    composite: rs.composite ?? null,
    percentile: rs.compositePercentile ?? rs.composite_percentile ?? null,
  };
}

export function registerAllocationHistoryView(Alpine) {
  Alpine.data("allocationHistoryView", () => ({
    sessions: [],
    allocationFw: null,
    loading: true,
    error: null,
    truncated: false,
    shown: ROWS_STEP,
    subjectId: ALLOCATION_SUBJECT_ID,

    init() {
      this.load();
    },

    async load() {
      const [sessions, framework] = await Promise.all([
        this.loadAllSessions().catch((e) => { this.error = e.message; return []; }),
        api.get(ROUTES.dashboards.allocation).catch(() => null),
      ]);
      // Newest first. The API already orders by (date, generated_at, id) DESC,
      // but a page that depends on order should not depend on a server detail
      // it cannot see.
      this.sessions = sessions.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
      this.allocationFw = framework;
      this.loading = false;
      this.$nextTick(() => this.draw());
    },

    // Walk `nextCursor` to exhaustion. Without this the log is a first-page
    // artifact presented as a complete record, which for a decision log is the
    // whole of the defect.
    async loadAllSessions() {
      const rows = [];
      let cursor = null;
      for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
        const query = { limit: String(SESSION_PAGE_SIZE) };
        if (cursor) query.cursor = cursor;
        const res = await api.get(ROUTES.swarm.sessions, query);
        rows.push(...(res.sessions || []).filter(isPublishedAllocationSession));
        cursor = res.nextCursor || null;
        if (!cursor) return rows;
      }
      // Ran out of pages before the cursor ran out. Say so rather than
      // silently presenting a partial set as the total.
      this.truncated = true;
      return rows;
    },

    // ── the rows ────────────────────────────────────────────────────────────
    total() { return this.sessions.length; },
    visibleRows() { return this.sessions.slice(0, this.shown); },
    hasMore() { return this.shown < this.total(); },
    showMore() { this.shown += ROWS_STEP; },
    countLine() {
      const n = this.total();
      if (!n) return "";
      const noun = n === 1 ? "session" : "sessions";
      return `${n} published ${noun} · ${longDay(this.sessions[n - 1].date)} to ${longDay(this.sessions[0].date)}`;
    },

    dateLabel(s) { return longDay(s?.date); },
    sessionHref(s) {
      if (!s) return "";
      return s.id
        ? `/swarm/sessions/${encodeURIComponent(s.id)}`
        : `/swarm/${s.date}/${encodeURIComponent(s.subjectId || ALLOCATION_SUBJECT_ID)}`;
    },

    // Regime, in words and against its own record. A bare composite is a
    // number with no scale; the percentile is what makes it self-describing.
    regimeLabel(s) {
      const r = regimeOf(s);
      return r?.regime ? String(r.regime).replace(/_/g, "-") : "—";
    },
    // Same ends as the stance ramp: Pool green for the constructive end,
    // Beacon for the attention end, slate neutral. Carried by a <=8px dot,
    // never by a run of coloured type — Beacon is a POINT.
    regimeDotStyle(s) {
      const key = String(regimeOf(s)?.regime || "").replace(/-/g, "_");
      const hue = ({ risk_on: SERIES.emerald, neutral: SERIES.slate, risk_off: SERIES.beacon })[key] || SERIES.slate;
      return `background:${hue}`;
    },
    percentileLabel(s) {
      const p = regimeOf(s)?.percentile;
      if (p == null || !Number.isFinite(Number(p))) return "";
      const n = Math.round(Number(p) * 100);
      const rem100 = n % 100;
      const suffix = rem100 >= 11 && rem100 <= 13
        ? "th"
        : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th";
      return `${n}${suffix} pct`;
    },

    quorumLabel(s) {
      const q = s?.swarmRecommendation?.quorum;
      if (!q) return "—";
      const submitted = Number(q.submitted);
      const active = Number(q.active);
      if (!Number.isFinite(submitted) || !Number.isFinite(active)) return "—";
      return `${submitted} / ${active}`;
    },

    // The weight vector a session published, or null. `robotmoney-allocation`
    // is typed `position_actions`, so meanTakeWeights() never runs for it and
    // this returns null for every session on file. It is still computed rather
    // than assumed: the day RM-115's third backend ask retypes the subject,
    // this column fills itself instead of needing an edit.
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

    // What the session recommended, in one cell. A vector where there is one,
    // otherwise the aggregator's own rationale, otherwise the load-bearing
    // actions, and an explicit blank state where a session published none of
    // the three. Never a fabricated vector.
    proposedLine(s) {
      const weights = this.sessionWeights(s);
      if (weights) return weights;
      const rec = s?.swarmRecommendation;
      if (!rec) return "";
      if (rec.rationale) return String(rec.rationale);
      const acts = (Array.isArray(rec.actions) ? rec.actions : []).filter((a) => a && a.action);
      if (acts.length) return acts.map((a) => `${a.action} ${a.token}`).join(" · ");
      return "";
    },
    proposedIsWeights(s) { return this.sessionWeights(s) != null; },

    // ── the allocation these sessions produced ──────────────────────────────
    targets() {
      const rows = this.allocationFw?.strategy;
      if (!Array.isArray(rows)) return [];
      return rows.map((r, i) => ({
        label: r?.label || `Sleeve ${i + 1}`,
        pct: Number.isFinite(Number(r?.targetPct)) ? Number(r.targetPct) : null,
      }));
    },
    // "95 / 5 / 0 / 0". The same row for every session, because there is only
    // one row: this is the resulting allocation column, and it is honest that
    // it never varies.
    resultingWeights() {
      const rows = this.targets();
      if (!rows.length || rows.some((t) => t.pct == null)) return "—";
      return rows.map((t) => this.trimPct(t.pct)).join(" / ");
    },
    trimPct(v) {
      if (v == null || !Number.isFinite(Number(v))) return "—";
      return Number(v).toFixed(1).replace(/\.0$/, "");
    },
    frameworkAsOf() { return this.allocationFw?.asOf || null; },
    frameworkAsOfLabel() {
      const asOf = this.frameworkAsOf();
      return asOf ? longDay(asOf) : "—";
    },

    // Whether the allocation changed at this session. Derived, not typed: a
    // session with no vector cannot have changed anything, and a session whose
    // vector matches the target did not change it either. A vector that
    // DIFFERS is reported as a proposal, because nothing applies it — there is
    // no write path from a session to `allocation_framework`.
    changeLabel(s) {
      const proposed = this.sessionWeights(s);
      if (!proposed) return "unchanged";
      return proposed === this.resultingWeights() ? "unchanged" : "proposed a change";
    },
    isProposal(s) { return this.changeLabel(s) === "proposed a change"; },
    // The page-level statement of the same fact, counted rather than written.
    unchangedNote() {
      const n = this.total();
      if (!n) return "No session has published a recommendation on the allocation yet.";
      const proposals = this.sessions.filter((s) => this.isProposal(s)).length;
      const noun = n === 1 ? "session" : "sessions";
      if (!proposals) {
        return `${n} ${noun}, no change. The allocation has one published row, `
          + `${this.frameworkAsOfLabel()}, and nothing writes another: `
          + "applying a recommendation is not built yet.";
      }
      return `${n} ${noun}. ${proposals} proposed a different vector; none was applied, `
        + `because nothing writes the target weights. The row in force is still ${this.frameworkAsOfLabel()}.`;
    },

    // ── window ──────────────────────────────────────────────────────────────
    // The span the weights chart covers: the first published session (or the
    // published allocation, whichever is earlier) to today.
    windowStart() {
      const oldest = this.sessions.length ? dayMs(this.sessions[this.sessions.length - 1].date) : null;
      const published = dayMs(this.frameworkAsOf());
      const candidates = [oldest, published].filter((v) => v != null);
      return candidates.length ? Math.min(...candidates) : null;
    },
    windowEnd() { return Date.now(); },

    // ── charts (hand-authored inline SVG; no chart dependency) ──────────────
    draw() { this.drawWeights(); },

    // TARGET WEIGHTS OVER TIME. Flat by construction, and that is the finding:
    // one published row, never superseded. Drawn as levels rather than as a
    // stack, all four in ONE green because they are four readings of the same
    // quantity (a weight) rather than four categories a reader must tell
    // apart. Cyan is not spent here: it is the interface hue and a sleeve
    // weight is money.
    drawWeights() {
      const host = this.$refs.weights;
      if (!host) return;
      host.replaceChildren();
      const rows = this.targets().filter((t) => t.pct != null);
      const start = this.windowStart();
      const end = this.windowEnd();
      if (!rows.length || start == null || end <= start) return;

      const W = 900, H = 240, L = 42, R = 190, T = 18, B = 30;
      const X = (ms) => L + ((W - L - R) * (ms - start)) / (end - start);
      const Y = (pct) => T + ((H - T - B) * (100 - pct)) / 100;
      host.setAttribute("viewBox", `0 0 ${W} ${H}`);

      for (let g = 0; g <= 100.01; g += 25) {
        host.appendChild(svg("line", { class: "grid", x1: L, y1: Y(g), x2: W - R, y2: Y(g) }));
        host.appendChild(label(svg("text", { class: "axtxt", x: L - 8, y: Y(g) + 3.5, "text-anchor": "end" }), g + "%"));
      }

      // Month ticks across the window, so a flat line is plainly flat over a
      // real span of time rather than over an unlabelled axis.
      const cursor = new Date(start);
      cursor.setUTCDate(1);
      const seen = {};
      for (let t = cursor.getTime(); t <= end; t = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)) {
        cursor.setTime(t);
        if (t < start) continue;
        const key = `${cursor.getUTCFullYear()}-${cursor.getUTCMonth()}`;
        if (seen[key]) break;
        seen[key] = 1;
        host.appendChild(label(svg("text", { class: "axtxt", x: X(t), y: H - 10, "text-anchor": "middle" }),
          MONTHS[cursor.getUTCMonth()]));
      }

      // The day the row in force was published, marked once.
      const publishedMs = dayMs(this.frameworkAsOf());
      if (publishedMs != null && publishedMs >= start && publishedMs <= end) {
        host.appendChild(svg("line", {
          x1: X(publishedMs), y1: T, x2: X(publishedMs), y2: H - B,
          stroke: PALETTE.borderLight, "stroke-width": 1, "stroke-dasharray": "4 4",
        }));
        // Mid-height and clear of the mid gridline, not at the top: at 95/5/0/0
        // the topmost level sits a few pixels under T and the label landed on
        // it, and on the gridline's baseline one nudge later.
        host.appendChild(label(svg("text", { class: "axtxt", x: X(publishedMs) + 6, y: (T + H - B) / 2 - 8 }),
          `published ${shortDay(this.frameworkAsOf())}`));
      }

      // One level per sleeve, with its label nudged apart where two sleeves
      // sit on the same line (95/5/0/0 puts two of them on the baseline).
      const placed = [];
      rows.forEach((t) => {
        const y = Y(t.pct);
        const zero = t.pct === 0;
        host.appendChild(svg("line", {
          x1: X(publishedMs != null && publishedMs > start ? publishedMs : start), y1: y, x2: W - R, y2: y,
          stroke: zero ? PALETTE.textMuted : SERIES.emerald,
          "stroke-width": zero ? 1.25 : 2.25,
          ...(zero ? { "stroke-dasharray": "5 4" } : {}),
        }));
        let ly = y + 4;
        while (placed.some((p) => Math.abs(p - ly) < 13)) ly += 13;
        placed.push(ly);
        host.appendChild(label(svg("text", {
          class: "endlbl", x: W - R + 10, y: ly, fill: zero ? PALETTE.textMuted : PALETTE.text,
        }), `${this.trimPct(t.pct)}% ${t.label}`));
      });

      host.setAttribute("aria-label", "Target sleeve weights over the window, flat throughout: "
        + rows.map((t) => `${t.label} at ${this.trimPct(t.pct)}%`).join(", ")
        + `. Published ${this.frameworkAsOfLabel()} and unchanged since.`);
    },
  }));
}
