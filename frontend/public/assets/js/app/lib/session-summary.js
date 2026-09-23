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
import { actionLabel } from "./sleeve-explorer.js";
import { vaultBySlug } from "./vault-data.js";
import { BUCKET_NOTES } from "./sleeve-notes.js";
import { analystSeats, judgeLabelHtml, judgeWroteRationale } from "./judgements.js";

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

// A chain id as its proper name. The id stays the key everywhere else (the
// explorer link reads it raw); "peaq" is lowercase by its own spelling.
/** @type {Record<string, string>} */
const CHAIN_LABELS = { base: "Base", peaq: "peaq", ethereum: "Ethereum", devnet: "Staging devnet" };

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

// What each sleeve holds, in one line (lib/sleeve-notes.js): the (i) tip
// wherever a swarm page names a sleeve, /allocation's sleeve cards and each
// vault page's lede.
// A sleeve's short name, for a narrow column on a phone.
/** @type {Record<string, string>} */
const BUCKET_SHORT = { conservative_defi_yield: "DeFi yield", agent_tokens: "Agent tokens", protocol_tokens: "Protocol tokens", real_world_assets: "RWA" };
/** @param {unknown} idOrName */
export function bucketShort(idOrName) {
  const i = bucketIndex(idOrName);
  return i >= 0 ? BUCKET_SHORT[BUCKET_ORDER[i]] : "";
}
/** @param {unknown} idOrName */
export function bucketNote(idOrName) {
  const i = bucketIndex(idOrName);
  return i >= 0 ? BUCKET_NOTES[BUCKET_ORDER[i]] || "" : "";
}

// Where a book sat, per sleeve, when a session read it: each framework
// bucket's share of the snapshot's value, summed from the positions whose
// token the framework assigns to that bucket. Keyed by the framework's bucket
// id; a bucket none of whose tokens the book holds reads 0, which is true.
//
// The ONE reading of "the book" a weights recommendation is measured against.
// The session page and the subject page's latest recommendation both call it,
// so the same session cannot read "moves from the book" on one page and
// "target weights retained" on the other.
//
// Empty, meaning no book to measure against, unless the framework's token
// lists and a valued snapshot are both in hand and the snapshot was read on
// or before `date`: a book read after the session is not what it acted on.
//
// A position that names its vault (the four-vault stack: `vault` is a slug)
// counts toward that vault's sleeve, whatever its token: idle USDC inside
// rmAGENT is Agent Tokens money. A book whose every position names its vault
// needs no token lists, and is summed over the four published sleeves.
/**
 * @param {{ buckets?: Array<{ id: string, tokens: string[] }> } | null | undefined} framework
 * @param {{ date?: unknown, totalValueUsd?: unknown, total_value_usd?: unknown, positions?: any[] } | null | undefined} snapshot
 * @param {unknown} [date]
 * @returns {Map<string, number>}
 */
export function bookSleeveShares(framework, snapshot, date) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const buckets = framework?.buckets || [];
  const positions = snapshot?.positions || [];
  const total = Number(snapshot?.totalValueUsd ?? snapshot?.total_value_usd ?? 0);
  const vaultOf = (/** @type {any} */ p) => vaultBySlug(p?.vault);
  const ids = buckets.length
    ? buckets.map((b) => b.id)
    : positions.length && positions.every((p) => vaultOf(p)) ? BUCKET_ORDER : [];
  if (!ids.length || !positions.length || !(total > 0)) return out;
  const readOn = String(snapshot?.date || "").slice(0, 10);
  if (date && readOn && readOn > String(date).slice(0, 10)) return out;
  for (const id of ids) {
    const tokens = buckets.find((b) => b.id === id)?.tokens || [];
    const held = positions
      .filter((p) => {
        const v = vaultOf(p);
        return v ? normKey(v.bucket) === normKey(id) : tokens.includes(String(p?.token || "").toUpperCase());
      })
      .reduce((sum, p) => sum + (Number(p?.value_usd ?? p?.valueUsd) || 0), 0);
    out.set(id, held / total);
  }
  return out;
}

// A weights recommendation's outcome in one line, against the book or the
// target: the session page's headline and the subject page's latest
// recommendation and history rows all word it here.
/** @param {number} moved @param {"book" | "target"} basis */
export function weightsOutcomeLine(moved, basis) {
  if (!moved) return basis === "book" ? "Holds the book as it stands" : "Target weights retained";
  return `${moved} ${moved === 1 ? "sleeve moves" : "sleeves move"} from ${basis === "book" ? "the book" : "target"}`;
}

export const sessionSummary = {
  // The one-line note on a sleeve, for its (i) tip; "" for a position.
  /** @param {unknown} key */
  bucketNote(key) { return bucketNote(key); },
  /** @param {unknown} key */
  bucketShort(key) { return bucketShort(key); },
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
  // M counts the seats a take could fill: a seated judge files none, and the
  // roster, when the surface holds one, is how it is known (lib/judgements.js).
  /** @param {any} s @param {any[]} [roster] */
  quorumText(s, roster = []) {
    const q = s?.swarmRecommendation?.quorum;
    if (q) return `${q.submitted} of ${analystSeats(s.swarmRecommendation, roster) ?? q.active} took part`;
    const n = takeRowsOf(s).length;
    return n ? `${n} took part` : "";
  },
  // Turnout beside the stance tally, only where the tally cannot say it: a
  // seat that sat the session out ("4 of 5"), or a take the tally does not
  // count (no stance, or one off the five-stance axis). "3 took part" beside a
  // 1/1/1 tally is the tally's own sum.
  /** @param {any} s @param {any[]} [roster] */
  turnoutText(s, roster = []) {
    const q = s?.swarmRecommendation?.quorum;
    const seats = analystSeats(s?.swarmRecommendation, roster);
    if (q && seats != null && Number(q.submitted) < seats) return this.quorumText(s, roster);
    const tallied = this.stanceTally(s).reduce((/** @type {number} */ a, /** @type {{ n: number }} */ x) => a + x.n, 0);
    const filed = q ? Number(q.submitted) : takeRowsOf(s).length;
    return Number.isFinite(filed) && filed > 0 && filed !== tallied ? this.quorumText(s, roster) : "";
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
    return this.ringArcs(this.sessionWeights(s) || []);
  },
  // The arcs for any set of parts, each { key, label, pct, colour }, pct out
  // of 100. The recommended mix and a book's holdings draw through this one
  // geometry, so the two rings cannot drift apart.
  /** @param {any[]} rows */
  ringArcs(rows) {
    if (!rows || !rows.length) return [];
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
  // `active` is a sleeve key the reader is exploring: the other arcs recede,
  // so the one in focus reads against the whole without being redrawn.
  weightDonutSvg(s, active = null) {
    return this.ringSvg(this.sessionWeights(s) || [], active);
  },
  /** @param {any[]} rows @param {string | null} [active] */
  ringSvg(rows, active = null) {
    const arcs = this.ringArcs(rows);
    // No rows is no ring. Rows that all weigh zero (a vault stack before any
    // deposit, a policy of zeros) are a ring with nothing on it: its bare
    // track, as every empty ring is drawn, not a hole where it would be.
    if (!arcs.length && !(Array.isArray(rows) && rows.length)) return "";
    const ring = (/** @type {string} */ stroke, /** @type {string} */ extra) =>
      `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="${stroke}" stroke-width="4"${extra}></circle>`;
    // The track is drawn first and stays visible wherever the arcs do not
    // reach, so a framework whose weights do not sum to 100 shows as an
    // unclosed ring instead of being rescaled to look complete.
    const track = ring("var(--color-border)", "");
    const segs = arcs.map((a) =>
      ring(a.colour, ` pathLength="100" stroke-dasharray="${a.dash}" stroke-dashoffset="${a.offset}" data-mark="series" data-sleeve="${String(a.key).replace(/[&"<>]/g, "")}"`
        + (active && active !== a.key ? ` class="is-muted"` : "")),
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
    // The rationale under the same trust rule as everywhere else (rationaleOf):
    // a live rollup's is its template restating the tally, which printed
    // "Majority stance is cautious (1 of 3…)" beside a SPLIT chip. That
    // session did publish, and made no call on any position. A judge's prose
    // explains the takes; it is not a call either.
    const why = judgeWroteRationale(s) ? "" : this.rationaleOf(s);
    if (why) return { kind: "text", text: why };
    return rec.rationale ? { kind: "none" } : null;
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
  // ── a portfolio recommendation, as a history row reads it ─────────────
  // The authored actions only: rollups aggregated 2026-08-06 to 09-04 carry
  // two hardcoded actions derived from no member input (quorum/stances mark
  // them), and they say nothing about the book.
  /** @param {any} s */
  authoredActionsOf(s) {
    const rec = s?.swarmRecommendation;
    if (!rec || rec.type === "bucket_weights" || rec.quorum || rec.stances) return [];
    return (Array.isArray(rec.actions) ? rec.actions : []).filter((/** @type {any} */ a) => a && a.action);
  },
  // The glyph-first chip label, here so an action list outside the explorer
  // reads its verb the way the history and the ring do.
  actionLabel,
  // The recommendation's own prose, or "" when a rollup's template wrote it:
  // a live aggregate carries quorum/stances and its rationale restates the tally.
  // A model judge replaces that template with its own words, which stand, and
  // every surface that prints them names the judge (rationaleJudgeLabel).
  /** @param {any} s */
  rationaleOf(s) {
    const rec = s?.swarmRecommendation;
    if (!rec) return "";
    if ((rec.quorum || rec.stances) && !judgeWroteRationale(s)) return "";
    return rec.rationale || "";
  },
  // "Judge: <name>" over a rationale a judge wrote, "" over any other. The
  // name resolves through the roster when the surface holds one.
  /** @param {any} s @param {any[]} [roster] */
  rationaleJudgeLabel(s, roster = []) {
    return judgeWroteRationale(s) ? judgeLabelHtml(s.swarmRecommendation.judge, roster, { pill: false }) : "";
  },
  // The positions it moves, holds left out: the held count says the rest.
  /** @param {any} s */
  rowActions(s) {
    return this.authoredActionsOf(s)
      .filter((/** @type {any} */ a) => String(a.action).toLowerCase() !== "hold")
      .map((/** @type {any} */ a) => ({ token: a.token, action: String(a.action).toLowerCase(), label: actionLabel(a.action) }));
  },
  /** @param {any} s */
  rowHeld(s) {
    return this.authoredActionsOf(s)
      .filter((/** @type {any} */ a) => String(a.action).toLowerCase() === "hold")
      .map((/** @type {any} */ a) => a.token);
  },
  /** @param {any} s */
  actionsOutcome(s) {
    const acts = this.authoredActionsOf(s);
    if (!acts.length) return "";
    const moved = acts.filter((/** @type {any} */ a) => String(a.action).toLowerCase() !== "hold").length;
    // Counted in actions, which can be fewer than the positions the ring and
    // holdings list, so no "N of M": the history row's "· 3 held" form, and
    // never "0 held".
    const held = acts.length - moved;
    return moved
      ? `${moved} ${moved === 1 ? "position changes" : "positions change"}${held ? `, ${held} held` : ""}`
      : `${acts.length} ${acts.length === 1 ? "position" : "positions"} held`;
  },
  // One dot and count per stance that has any, bearish to bullish: the tally
  // the subject page and /swarm print under the latest rationale. The session
  // page draws it as its vote chart instead.
  /** @param {any} s */
  stanceTally(s) {
    /** @type {Record<string, unknown>} */
    const c = this.stanceCounts(s) || {};
    return VOTE_AXIS.map((stance) => ({ stance, n: Number(c[stance]) || 0 })).filter((x) => x.n > 0);
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
  // An unknown chain prints as its id rather than a guessed capitalisation.
  /** @param {unknown} c */
  chainLabel(c) { return CHAIN_LABELS[String(c || "").toLowerCase()] || c; },
  // The time the session convened, beside the date it convened on: a subject
  // can convene twice in a day, and the date alone prints both rows
  // identically. Not the publish time, which lands the next day when a window
  // runs past midnight, so "Sep 20 · 01:20" read as a time on the 20th that was
  // the 21st. Archive rows carry a bare date, so they print nothing here.
  /** @param {any} row */
  rowTime(row) {
    const at = row?.generatedAt || row?.publishedAt;
    if (!at || !Number.isFinite(Date.parse(at)) || !String(at).includes("T")) return "";
    return `${new Date(at).toISOString().slice(11, 16)} UTC`;
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
