// What a published session came out with, derived from the session record.
//
// One implementation, spread into every surface that summarises a session, in
// the same way `helpers` is spread into every static view. /swarm and a
// subject profile list the SAME sessions: /swarm interleaved by date across
// every subject, the profile filtered to one. They were reading that record
// two different ways — /swarm showed the stance spread, the consensus lean,
// the quorum and what the session recommended; the profile showed a take
// count and five lines of synthesis — so the same session told two different
// stories depending on which page you reached it from.
//
// Every function here is pure in `s`: no fetching, no component state. The
// call sites differ only in what they choose to render.
//
// Deliberately NOT here: the session's href. /swarm and the profile build it
// differently today — the profile treats a `${date}-${subjectId}` id as the
// synthetic one the static archive rows carry (they have no `id` field at
// all) and falls back to the dated URL, and /swarm does not. Unifying that
// changes /swarm's archive links, which is its own change with its own
// evidence, not a side effect of this one.
import { stanceColor, stanceStyle } from "./stance.js";
import { CATEGORICAL } from "./chart-theme.js";

// Fixed reading direction, so a spread bar means the same thing on every
// surface. A stance this build does not know keeps its count and sorts last
// rather than being dropped: an unrecognised stance is still a take somebody
// signed.
const STANCE_ORDER = ["bullish", "constructive", "neutral", "cautious", "bearish"];

// The bucket order the allocation framework publishes in. Weights are printed
// in this order rather than the object's, so "95 / 5 / 0 / 0" names the same
// four sleeves every time.
const BUCKET_ORDER = ["conservative_defi_yield", "agent_tokens", "protocol_tokens", "real_world_assets"];

// Named, not humanised from the key: "real world assets" is the transform a
// slug gives you and "Real World Assets" is what the framework publishes.
/** @type {Record<string, string>} */
const BUCKET_LABELS = {
  conservative_defi_yield: "Conservative DeFi Yield",
  agent_tokens: "Agent Tokens",
  protocol_tokens: "Protocol Tokens",
  real_world_assets: "Real World Assets",
};

export const sessionSummary = {
  // The stance tally. The live pipeline aggregates it onto the record; the
  // static archive never did, and its sessions carry the stances only on the
  // takes themselves. Reading both is what puts the spread bar, the consensus
  // lean and the mean confidence on an archived session — they were blank on
  // every one of them, over data sitting in the same object.
  /** @param {any} s */
  stanceCounts(s) {
    const agg = s?.swarmRecommendation?.stances;
    if (agg && Object.keys(agg).length) return agg;
    /** @type {Record<string, number>} */
    const out = {};
    for (const t of takeRowsOf(s)) {
      const k = String(t?.stance || "").toLowerCase();
      if (k) out[k] = (out[k] || 0) + 1;
    }
    return out;
  },
  /** @param {any} s */
  stanceSpread(s) {
    /** @type {Record<string, unknown>} */
    const st = this.stanceCounts(s) || {};
    const n = (/** @type {string} */ k) => Number(st[k]) || 0;
    const keys = [...STANCE_ORDER.filter(n), ...Object.keys(st).filter((k) => !STANCE_ORDER.includes(k) && n(k))];
    const total = keys.reduce((a, k) => a + n(k), 0);
    return total ? keys.map((k) => ({ stance: k, n: n(k), pct: n(k) / total })) : [];
  },
  /** @param {any} s */
  spreadLabel(s) {
    const rows = this.stanceSpread(s);
    return rows.length ? rows.map((r) => `${r.n} ${r.stance}`).join(", ") : "";
  },
  // The one-word answer. A tie is a real outcome, not a rounding problem, so
  // it is reported rather than resolved into a winner.
  /** @param {any} s */
  lean(s) {
    const rows = this.stanceSpread(s);
    if (!rows.length) return null;
    const max = Math.max(...rows.map((r) => r.n));
    const top = rows.filter((r) => r.n === max);
    return top.length > 1 ? { stance: null, label: "split" } : { stance: top[0].stance, label: top[0].stance };
  },
  /** @param {any} s */
  leanStance(s) { return this.lean(s)?.stance || ""; },
  /** @param {any} s */
  leanLabel(s) { return this.lean(s)?.label || ""; },
  /** @param {any} s */
  leanBadgeStyle(s) {
    const st = this.leanStance(s);
    return st ? stanceStyle(st) : "";
  },
  /** @param {any} s */
  leanDotStyle(s) {
    const st = this.leanStance(s);
    return st ? `background:${stanceColor(st)}` : "";
  },
  /** @param {any} s */
  meanConfidenceText(s) {
    const c = s?.swarmRecommendation?.meanConfidence;
    if (Number.isFinite(c)) return `${Math.round(Number(c) * 100)}% mean confidence`;
    const vals = takeRowsOf(s)
      .map((/** @type {any} */ t) => Number(t?.confidence))
      .filter((/** @type {number} */ n) => Number.isFinite(n));
    if (!vals.length) return "";
    const mean = vals.reduce((/** @type {number} */ a, /** @type {number} */ n) => a + n, 0) / vals.length;
    return `${Math.round(mean * 100)}% mean confidence`;
  },
  // "N of M took part" needs a roster size, which only the live record has.
  // An archived session knows how many filed and not how many could have, so
  // it says the half it can stand behind rather than inventing a denominator.
  /** @param {any} s */
  quorumText(s) {
    const q = s?.swarmRecommendation?.quorum;
    if (q) return `${q.submitted} of ${q.active} took part`;
    const n = takeRowsOf(s).length;
    return n ? `${n} took part` : "";
  },
  // How many takes this session collected. The quorum is the authority when
  // the record has one; a row that carries its own count comes next (the
  // sessions list route serves one, and the static archive has nothing else);
  // the stance spread is the last resort. Getting this wrong is visible: the
  // expander is disabled at 0, so an archive session with three signed takes
  // read "0 takes" and would not open.
  /** @param {any} s */
  takesCount(s) {
    const q = Number(s?.swarmRecommendation?.quorum?.submitted);
    if (Number.isFinite(q)) return q;
    const own = Number(s?.takes);
    if (Number.isFinite(own)) return own;
    return this.stanceSpread(s).reduce((a, r) => a + r.n, 0);
  },
  // Whether the session record carries a consensus AT ALL. The three facts
  // under the kicker are each individually gated, so a session with none of
  // them printed the word "Consensus" over empty space — which is every
  // static-archive row on a subject profile: those carry the recommendation
  // but no stances, no quorum and no mean confidence. A label with nothing
  // under it reads as a figure that failed to load.
  /** @param {any} s */
  hasConsensus(s) {
    return !!(this.lean(s) || this.quorumText(s) || this.meanConfidenceText(s));
  },
  // The weights as ROWS, not a string. "95 / 3 / 0 / 2" is four numbers a
  // reader has to map back onto four sleeve names they are holding in their
  // head; the relationship between them, which is the whole point of a target
  // mix, is not visible at all. Rows carry the name, the share and the colour,
  // so a card can draw the mix instead of spelling it.
  //
  // The colour is CATEGORICAL keyed on POSITION IN THE PUBLISHED ORDER, the
  // same index /allocation's donut uses, so a sleeve is the same colour on
  // both pages and a weight change never repaints the sleeves that did not
  // move.
  /** @param {any} s */
  sessionWeights(s) {
    const rec = s?.swarmRecommendation;
    if (rec?.type !== "bucket_weights" || !rec.weights) return null;
    const norm = (/** @type {unknown} */ v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    /** @type {Record<string, number>} */
    const by = {};
    for (const [k, v] of Object.entries(rec.weights)) by[norm(k)] = Number(v) * 100;
    const rows = BUCKET_ORDER
      .map((key, i) => ({ key, label: BUCKET_LABELS[key], pct: by[norm(key)], colour: CATEGORICAL[i % CATEGORICAL.length] }))
      .filter((r) => Number.isFinite(r.pct));
    return rows.length ? rows : null;
  },
  /** @param {any} s */
  sessionWeightsLabel(s) {
    const rows = this.sessionWeights(s);
    return rows ? rows.map((r) => `${r.label} ${Math.round(r.pct)}%`).join(", ") : "";
  },
  // What the session DECIDED. The card printed the synthesis paragraph here,
  // which is the reasoning: five lines of it, identical in shape on every row,
  // burying the one line a reader came for. Weights where the subject takes
  // weights, the load-bearing actions otherwise, and the aggregator's own
  // one-line rationale when a session carried neither.
  /** @param {any} s */
  recommendation(s) {
    const rec = s?.swarmRecommendation;
    if (!rec) return null;
    if (rec.type === "bucket_weights") {
      const rows = this.sessionWeights(s);
      // The weights are the decision; the rationale is why. A card carrying
      // the numbers alone made the reader open the session to find out what
      // moved, which is the one thing the row exists to tell them.
      return rows ? { kind: "weights", rows, note: rec.rationale || "" } : null;
    }
    const acts = (Array.isArray(rec.actions) ? rec.actions : [])
      .filter(/** @param {any} a */ (a) => a && a.action);
    if (acts.length) return { kind: "actions", actions: acts.slice(0, 2), more: Math.max(0, acts.length - 2) };
    return rec.rationale ? { kind: "text", text: rec.rationale } : null;
  },
};

// The take bodies a surface has already fetched, when it has. A subject
// profile carries them on the row (it built the card out of the same
// response); /swarm loads them on demand and passes nothing here, which is
// correct — a live session's record already holds the aggregates below.
/** @param {any} s */
function takeRowsOf(s) {
  return /** @type {any[]} */ (Array.isArray(s?.takeRows) ? s.takeRows : []);
}
