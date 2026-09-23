// A session's regime reading and the brief it opened with.
//
// The fourth extraction, after session-summary, session-takes and
// allocation-framework. The session page and a subject profile draw the same
// review band from it: the signal (the reading as dots on one percentile
// axis) and what the swarm was handed (the brief, part by part). The session
// page feeds it that session's own reading and brief, a subject profile the
// most recent session's.
//
// A factory, because the reading is state.
import { bucketHue, bucketLabel } from "./session-summary.js";
import { citeTitle, isKnownPage } from "../seo.js";

// `helpers` belongs to the SURFACE, not to this module: regimeColor and
// regimeLabel are spread into both factories that spread this one, and so are
// the brief, subject and subjectNames the handover reads. A cast at the call
// site, and deliberately NOT a `get hx()` on the returned object — object
// spread EVALUATES a getter and copies its value, so `...sessionBrief()` would
// have frozen it to this module's own object, which has none of those on it.
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
    // The reading's own risk cuts, when it carries them. Prod's regime data
    // has bucketThresholds: null today (#964), so the latest review draws no
    // zones rather than hard-coding 0.33 / 0.67 in their place.
    cuts: (() => {
      const c = raw.bucketThresholds || raw.bucket_thresholds;
      return c && num(c.risk_off) !== null && num(c.risk_on) !== null
        ? { riskOff: /** @type {number} */ (num(c.risk_off)), riskOn: /** @type {number} */ (num(c.risk_on)) }
        : null;
    })(),
  };
  return out.composite === null && !out.regime ? null : out;
}

export function sessionBrief() {
  return {
    /** @type {any} */
    backdrop: null,
    backdropDate: "",
    // True for a v0 archive reading, whose composite averages macro, on-chain
    // AND factor. The latest review draws factor as context only when it is.
    backdropV0: false,

    /** @param {any} summary @param {{date?: string, v0?: boolean}} opts */
    setBackdrop(summary, opts = {}) {
      this.backdrop = normalizeRegime(summary);
      this.backdropDate = opts.date || "";
      this.backdropV0 = Boolean(opts.v0);
      return this.backdrop;
    },

    // ── the latest review's signal (RM-121) ──────────────────────────────
    // Dots on one percentile axis: every reading is a position in its own
    // three-year history, not an amount. Composite first, then its inputs.
    // Factor is drawn apart as context on the published method, where it is
    // not an input; on a v0 reading it was one, so it is drawn as one.
    signalRows() {
      const b = this.backdrop;
      if (!b) return [];
      const at = (/** @type {number} */ p) => `${(Math.max(0, Math.min(1, p)) * 100).toFixed(1)}%`;
      const rows = [];
      if (b.compositePercentile !== null) {
        rows.push({ key: "composite", label: "Composite", pct: b.compositePercentile, regime: b.regime, kind: "lead", at: at(b.compositePercentile),
          href: "/regime#composite", about: "Macro and on-chain averaged. Its cuts set the regime." });
      }
      /** @type {Record<string, string>} */
      const about = {
        macro: "Eight macro indicators: rates, credit spreads, the dollar, volatility.",
        onchain: "Ten on-chain indicators: DeFi TVL, stablecoins, activity, new DEX pools.",
        factor: this.backdropV0
          ? "Eight equity factor signals, in the composite of this older reading."
          : "Eight equity factor signals, shown for context. Not in the composite.",
      };
      for (const [key, label] of [["macro", "Macro"], ["onchain", "On-chain"], ["factor", "Factor"]]) {
        const pct = b[key];
        if (pct === null) continue;
        const kind = key === "factor" && !this.backdropV0 ? "context" : "input";
        rows.push({ key, label, pct, regime: b[`${key}Regime`], kind, at: at(pct), href: `/regime#panel-${key}`, about: about[key] });
      }
      return rows;
    },
    // Zones only from the reading's own cuts; none today.
    signalZones() {
      const c = this.backdrop?.cuts;
      if (!c) return [];
      const at = (/** @type {number} */ p) => `${(p * 100).toFixed(1)}%`;
      return [
        { key: "risk_off", label: "risk-off", from: 0, to: c.riskOff },
        { key: "neutral", label: "neutral", from: c.riskOff, to: c.riskOn },
        { key: "risk_on", label: "risk-on", from: c.riskOn, to: 1 },
      ].map((z) => ({ ...z, left: at(z.from), width: at(z.to - z.from) }));
    },
    signalCuts() {
      const c = this.backdrop?.cuts;
      return c ? [`${(c.riskOff * 100).toFixed(1)}%`, `${(c.riskOn * 100).toFixed(1)}%`] : [];
    },

    // ── what the swarm was handed ────────────────────────────────────────
    // The session's brief, part by part. A part renders only if the brief
    // contains it: the live brief and the v0 archive brief have different
    // shapes. The subject page feeds it the latest session's brief, the session
    // page its own, and both draw it with the same markup.
    handoverParts() {
      const self = surface(this);
      const b = self.brief?.body || self.brief;
      if (!b || typeof b !== "object") return [];
      const txt = (/** @type {unknown} */ v) => (typeof v === "string" ? v.trim() : "");
      // A pill is text, or text with an href when the site has a page there.
      const pills = (/** @type {string} */ key, /** @type {Array<string | {text: string, href?: string}>} */ list) =>
        list
          .map((x) => (typeof x === "string" ? { text: x, href: "" } : { text: x.text, href: x.href || "" }))
          .filter((x) => x.text)
          .map((x, i) => ({ key: `${key}-${i}`, text: x.text, href: x.href && isKnownPage(x.href) ? x.href : "" }));
      const day = (/** @type {unknown} */ v) => {
        const d = new Date(`${String(v || "").slice(0, 10)}T00:00:00Z`);
        return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      };
      const human = (/** @type {unknown} */ k) => {
        const t = String(k || "").replace(/[_-]+/g, " ").trim();
        return t ? t[0].toUpperCase() + t.slice(1) : "";
      };
      const parts = [];
      const inst = txt(b.prompt?.user);
      if (inst) parts.push({ key: "instruction", label: "Instruction", quote: inst });
      // No regime part: the session page states the reading once, in its facts
      // row and its market context, and this list sits in the same page.
      // The weights in force when the session opened, drawn as the targets
      // card draws the weights in force now, each sleeve in its published hue.
      const buckets = b.allocation?.buckets;
      if (Array.isArray(buckets) && buckets.length) {
        const bars = buckets.map((/** @type {any} */ x, /** @type {number} */ i) => {
          const w = Number(x?.target_weight ?? x?.targetWeight);
          if (!x?.name || !Number.isFinite(w)) return null;
          return { key: `targets-${i}`, label: bucketLabel(x.name || x.id), pct: Math.round(w * 100), hue: bucketHue(x.id || x.name, i) };
        }).filter(Boolean);
        // "Allocation targets", not "Targets": every v0 brief carried the
        // allocation framework's weights, and on Woon's or the treasury's page a
        // bare "Targets" read as that subject's own.
        if (bars.length) parts.push({ key: "targets", label: "Allocation targets", bars });
      }
      const signals = b.researchSignals || b.research_signals;
      const articles = b.research?.articles;
      if (Array.isArray(signals) && signals.length) {
        // Each signal has a reader page at /research/<key> when the site
        // publishes one; the brief's own href is the JSON route, not a page.
        parts.push({ key: "research", label: "Research signals", links: pills("research", signals.map((/** @type {any} */ x) => {
          const k = String(x?.signalKey || x?.signal_key || "");
          const href = k ? `/research/${encodeURIComponent(k)}` : "";
          // The page's own name when there is a page ("Late-Cycle Signals"),
          // the key humanised when there is not.
          const title = href ? citeTitle(href) : "";
          return { text: title || human(k), href };
        })) });
      } else if (Array.isArray(articles) && articles.length) {
        // v0's articles went into one member's prompt, not the swarm's: the
        // brief's own note says "research is Athena's context".
        // Which member's prompt the articles went into is an internal routing
        // detail, so the part is "Research" either way.
        parts.push({ key: "research", label: "Research", links: pills("research", articles.map((/** @type {any} */ x) => ({ text: txt(x?.title), href: txt(x?.slug) }))) });
      }
      const recent = b.recentSessions || b.recent_sessions;
      if (Array.isArray(recent) && recent.length) {
        // Each ref links to its session by the dated address, which resolves
        // for live sessions and archived ones alike. The live brief names the
        // subject on every ref (they span subjects); the archive brief's refs
        // are this subject's own and carry no subject at all.
        const own = b.subject_id || b.subjectId || self.subject?.id || "";
        /** @type {Record<string, string>} */
        const names = self.subjectNames || {};
        // Two sessions on one subject and day read identically and reach the
        // same dated address (the day's latest), so the second pill adds
        // nothing until refs carry their own ids (#965).
        const seen = new Set();
        const refs = recent.map((/** @type {any} */ x) => {
          const sid = x?.subject_id || x?.subjectId;
          const d = day(x?.date);
          const date = String(x?.date || "").slice(0, 10);
          const href = d && (sid || own) ? `/swarm/${date}/${encodeURIComponent(sid || own)}` : "";
          return { text: sid ? `${d} · ${names[sid] || sid}` : d, href };
        }).filter((r) => {
          const k = `${r.text}|${r.href}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        parts.push({ key: "recent", label: "Recent sessions", pills: pills("recent", refs) });
      }
      const rawNotes = b.subject?.structuralNotes ?? b.subject?.structural_notes;
      const notes = (Array.isArray(rawNotes) ? rawNotes : rawNotes ? [rawNotes] : []).map(txt).filter(Boolean);
      if (notes.length) parts.push({ key: "notes", label: "Operator notes", list: notes.map((text, i) => ({ key: `n-${i}`, text })) });
      const schema = b.takeSchema && typeof b.takeSchema === "object" ? Object.keys(b.takeSchema) : [];
      if (schema.length) {
        /** @type {Record<string, string>} */
        const said = { body: "written take", stance: "stance", confidence: "confidence", weights: "target weights" };
        // An optional field is asked for as optional: every live schema marks
        // weights optional, on subjects whose sessions publish none.
        const optional = (/** @type {string} */ k) => Boolean(b.takeSchema[k] && typeof b.takeSchema[k] === "object" && b.takeSchema[k].optional);
        parts.push({ key: "returns", label: "Asked to return", pills: pills("returns", schema.map((k) => `${said[k] || human(k)}${optional(k) ? " (optional)" : ""}`)) });
      }
      return parts;
    },
  };
}
