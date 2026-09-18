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

// The same five stances as a number line, bearish on the left.
const VOTE_AXIS = ["bearish", "cautious", "neutral", "constructive", "bullish"];

// The bucket order the allocation framework publishes in. Weights are printed
// in this order rather than the object's, so "95 / 5 / 0 / 0" names the same
// four sleeves every time.
export const BUCKET_ORDER = ["conservative_defi_yield", "agent_tokens", "protocol_tokens", "real_world_assets"];

// Named, not humanised from the key: "real world assets" is the transform a
// slug gives you and "Real World Assets" is what the framework publishes.
/** @type {Record<string, string>} */
const BUCKET_LABELS = {
  conservative_defi_yield: "Conservative DeFi Yield",
  agent_tokens: "Agent Tokens",
  protocol_tokens: "Protocol Tokens",
  real_world_assets: "Real World Assets",
};

/** @param {unknown} v */
const normKey = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// A recommendation's weights as [bucket, weight] pairs, from either shape they
// arrive in: the v0 archive's map ({conservative_defi_yield: 0.95}) or the live
// aggregator's array ([{bucket, weight}], the contract's SwarmBucketWeight[]).
// Object.entries on the array read its indexes as bucket names, so a live
// bucket_weights session drew sleeves called "0" to "3", every one at 0%.
/** @param {unknown} weights @returns {Array<[string, unknown]>} */
export function weightEntries(weights) {
  if (Array.isArray(weights)) {
    return weights
      .filter((w) => w && typeof w === "object" && (w.bucket ?? w.id ?? w.name) != null)
      .map((w) => [String(w.bucket ?? w.id ?? w.name), w.weight]);
  }
  return weights && typeof weights === "object" ? Object.entries(weights) : [];
}

// A sleeve's colour, by its position in the published order, whichever way the
// sleeve is spelled ("agent_tokens" or "Agent Tokens"). One lookup for the
// targets card, the ring, the handover and the session outcome, so a sleeve
// cannot be two colours on one page.
/** @param {unknown} idOrName */
const bucketIndex = (idOrName) => {
  const n = normKey(idOrName);
  return BUCKET_ORDER.findIndex((k) => normKey(k) === n || normKey(BUCKET_LABELS[k]) === n);
};
// A sleeve's place in the published order, unknown sleeves last. Payloads do
// not keep it: Postgres jsonb stores object keys shortest first, so a weights
// map read back from the database lists Conservative DeFi Yield LAST.
/** @param {unknown} idOrName */
export function bucketRank(idOrName) {
  const i = bucketIndex(idOrName);
  return i < 0 ? BUCKET_ORDER.length : i;
}
/** @param {unknown} idOrName @param {number} [fallback] */
export function bucketHue(idOrName, fallback = 0) {
  const i = bucketIndex(idOrName);
  return CATEGORICAL[(i >= 0 ? i : fallback) % CATEGORICAL.length];
}
// The published name, for a sleeve spelled any way at all: humanising
// "conservative_defi_yield" gives "Conservative Defi Yield", which is not it.
/** @param {unknown} idOrName */
export function bucketLabel(idOrName) {
  const i = bucketIndex(idOrName);
  if (i >= 0) return BUCKET_LABELS[BUCKET_ORDER[i]];
  return String(idOrName || "").replace(/[_-]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

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
  // Whether this session's regime reading used the v0 method, whose composite
  // averaged macro, on-chain AND factor. Every live aggregate carries a quorum
  // and no v0 session ever did: not the static archive, and not the v0 sessions
  // imported into the database, which are dated past the archive and so read
  // as live to any test on the date.
  /** @param {any} s */
  readingIsV0(s) { return !!s && !s.swarmRecommendation?.quorum; },
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
    /** @type {Record<string, number>} */
    const by = {};
    for (const [k, v] of weightEntries(rec.weights)) {
      if (v !== null && v !== "" && Number.isFinite(Number(v))) by[normKey(k)] = Number(v) * 100;
    }
    const rows = BUCKET_ORDER
      .map((key, i) => ({ key, label: BUCKET_LABELS[key], pct: by[normKey(key)] ?? by[normKey(BUCKET_LABELS[key])], colour: CATEGORICAL[i % CATEGORICAL.length] }))
      .filter((r) => Number.isFinite(r.pct));
    return rows.length ? rows : null;
  },
  // The mix as donut arcs. Drawn on a circle carrying pathLength="100", so an
  // arc's length IS its percentage: no circumference, no radius in the
  // arithmetic, and the geometry cannot drift out of step with the SVG's own
  // dimensions the way a 2*PI*r computation does the moment someone retunes
  // the radius.
  //
  // A sleeve at 0% draws nothing at all. It keeps its row in the legend, where
  // "0%" is a decision a reader can read; a zero-length arc on a ring is just
  // an absence, and a minimum-length one would be a lie.
  /** @param {any} s */
  weightArcs(s) {
    const rows = this.sessionWeights(s);
    if (!rows) return [];
    const drawn = rows.filter((r) => Number(r.pct) > 0);
    // Surface between neighbouring arcs, in the same 100-unit space. Taken out
    // of the LARGEST arc only, so the ring still closes and every small sleeve
    // is drawn at its true length. Taking it from every arc drew a 2% sleeve
    // at 0.8 and a 3% one at 1.8: the small sleeves are the moves a reader is
    // looking for, and they came out 40 to 60% short.
    const gap = drawn.length > 1 ? 1.2 : 0;
    const largest = drawn.reduce((m, r) => (Number(r.pct) > Number(m?.pct ?? -1) ? r : m), /** @type {any} */ (null));
    let at = 0;
    return drawn.map((r) => {
      const len = Number(r.pct);
      const arc = r === largest ? Math.max(0.8, len - gap * drawn.length) : len;
      const seg = { key: r.key, label: r.label, colour: r.colour, dash: `${arc} ${100 - arc}`, offset: -at };
      // Every arc is followed by its gap, so no two sleeves touch; the gaps
      // together are what the largest arc gave up.
      at += arc + gap;
      return seg;
    });
  },
  // The ring itself, as markup.
  //
  // Built here rather than with x-for in the template because a <template>
  // element inside <svg> is parsed into the SVG namespace, where it is an
  // unknown element and Alpine's x-for never runs — the ring came out with one
  // arc. x-html is the idiom this codebase already uses for inline SVG
  // (portfolioMark on /swarm). Nothing user-supplied is interpolated: the
  // numbers are computed above and the colours are CATEGORICAL constants. The
  // readable label is an aria-label on the host element, where it is escaped.
  /** @param {any} s */
  weightDonutSvg(s) {
    const arcs = this.weightArcs(s);
    if (!arcs.length) return "";
    const ring = (/** @type {string} */ stroke, /** @type {string} */ extra) =>
      `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="${stroke}" stroke-width="4"${extra}></circle>`;
    // The track is drawn first and stays visible wherever the arcs do not
    // reach, so a framework whose weights do not sum to 100 shows as an
    // unclosed ring instead of being rescaled to look complete.
    const track = ring("var(--color-border)", "");
    const segs = arcs.map((a) =>
      ring(a.colour, ` pathLength="100" stroke-dasharray="${a.dash}" stroke-dashoffset="${a.offset}" data-mark="series"`),
    ).join("");
    return `<svg class="sv__wdonut" viewBox="0 0 42 42" aria-hidden="true" focusable="false">`
      + `<g transform="rotate(-90 21 21)">${track}${segs}</g></svg>`;
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
  // ── the vote, as a position on a scale (RM-121) ──────────────────────
  // Each member in their stance's column, bearish to bullish, so a reader
  // sees how the room leaned and how far apart it sat.
  /** @param {any} s */
  voteColumns(s) {
    const takes = takeRowsOf(s);
    return VOTE_AXIS.map((stance) => ({
      stance,
      members: takes
        .filter((/** @type {any} */ t) => String(t?.stance || "").toLowerCase() === stance)
        .map((/** @type {any} */ t, /** @type {number} */ i) => {
          const ref = t?.memberHandle || t?.memberId || "";
          return { key: `${ref || t?.memberName || "m"}-${i}`, name: t?.memberName || t?.memberId || "", href: ref ? `/swarm/members/${encodeURIComponent(ref)}` : "" };
        }),
    }));
  },
  /** @param {any} s */
  hasVoteMembers(s) { return this.voteColumns(s).some((c) => c.members.length); },
  // One square per take, for when the names were not fetched.
  /** @param {any} s */
  voteSquares(s) {
    /** @type {Record<string, unknown>} */
    const c = this.stanceCounts(s) || {};
    return VOTE_AXIS.flatMap((stance) => Array.from({ length: Number(c[stance]) || 0 }, (_, i) => ({ key: `${stance}-${i}`, stance })));
  },
  /** @param {any} s */
  voteTotal(s) {
    /** @type {Record<string, unknown>} */
    const c = this.stanceCounts(s) || {};
    return Object.values(c).reduce((/** @type {number} */ a, v) => a + (Number(v) || 0), 0);
  },
  // "3 of 5" for the leading stance; nothing for a split.
  /** @param {any} s */
  leadShare(s) {
    const l = this.lean(s);
    if (!l?.stance) return "";
    /** @type {Record<string, unknown>} */
    const c = this.stanceCounts(s) || {};
    return `${Number(c[l.stance]) || 0} of ${this.voteTotal(s)}`;
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
