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

// Fixed reading direction, so a spread bar means the same thing on every
// surface. A stance this build does not know keeps its count and sorts last
// rather than being dropped: an unrecognised stance is still a take somebody
// signed.
const STANCE_ORDER = ["bullish", "constructive", "neutral", "cautious", "bearish"];

// The bucket order the allocation framework publishes in. Weights are printed
// in this order rather than the object's, so "95 / 5 / 0 / 0" names the same
// four sleeves every time.
const BUCKET_ORDER = ["conservative_defi_yield", "agent_tokens", "protocol_tokens", "real_world_assets"];

export const sessionSummary = {
  /** @param {any} s */
  stanceSpread(s) {
    /** @type {Record<string, unknown>} */
    const st = s?.swarmRecommendation?.stances || {};
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
    return Number.isFinite(c) ? `${Math.round(Number(c) * 100)}% mean confidence` : "";
  },
  /** @param {any} s */
  quorumText(s) {
    const q = s?.swarmRecommendation?.quorum;
    return q ? `${q.submitted} of ${q.active} took part` : "";
  },
  /** @param {any} s */
  takesCount(s) {
    const q = s?.swarmRecommendation?.quorum;
    const n = Number(q?.submitted);
    return Number.isFinite(n) ? n : this.stanceSpread(s).reduce((a, r) => a + r.n, 0);
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
  /** @param {any} s */
  sessionWeights(s) {
    const rec = s?.swarmRecommendation;
    if (rec?.type !== "bucket_weights" || !rec.weights) return null;
    const norm = (/** @type {unknown} */ v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    /** @type {Record<string, number>} */
    const by = {};
    for (const [k, v] of Object.entries(rec.weights)) by[norm(k)] = Number(v) * 100;
    const vals = BUCKET_ORDER.map((k) => by[norm(k)]).filter((v) => Number.isFinite(v));
    return vals.length ? vals.map((v) => Math.round(v)).join(" / ") : null;
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
      const w = this.sessionWeights(s);
      return w ? { kind: "weights", text: w } : null;
    }
    const acts = (Array.isArray(rec.actions) ? rec.actions : [])
      .filter(/** @param {any} a */ (a) => a && a.action);
    if (acts.length) return { kind: "actions", actions: acts.slice(0, 2), more: Math.max(0, acts.length - 2) };
    return rec.rationale ? { kind: "text", text: rec.rationale } : null;
  },
};
