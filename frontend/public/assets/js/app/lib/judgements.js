// The consensus judge's public record: a judgement is its own record with its
// own page, as a take is, and a judge's member page lists its judgements. A
// session has one judge (the house judge by default, one picked at random
// when several are seated, never one related to the session's subject or
// members), and its page shows that judge's opinion.
//
// What a judgement is NOT, and what every surface below must not imply: it
// never edits or scores a take, and it never sets a weight (the weights are
// the members' average, computed before any judge runs). Its release call is
// ADVICE, a Hold or Update badge (ADVICE_CALLS): nothing in the lifecycle
// refuses to publish on a hold, and publishing is not applying. The data's
// "safe" never prints: on a page about money the word reads as a safety claim.
import { api, ROUTES, path } from "./api.js";

// THE THREE PATHS, AND WHETHER THEY ARE SERVED (RM-130). The frontend's route
// table is the vendored contract (contract/routes.js), and the backend serves
// exactly the contract's routes, so a route it does not declare has nothing
// behind it: the vault loader reads the four-vault route the same way
// (lib/vault-source.js declaredVaultsRoute). A release that holds #1017 back
// ships without these three, and a 404 from a declared one means the same.
//
// Not served is not "none yet". A judge's page that said "No judgement
// published yet" while its judgements could not be read would be false, so a
// loader answers null for "not served" and [] for "none", and asks nothing of
// a route the contract does not declare. Revert with the release that ships
// #1017.
const SWARM = /** @type {Record<string, string>} */ (/** @type {unknown} */ (ROUTES.swarm));
export const JUDGEMENT_ROUTES = {
  session: SWARM.sessionJudgements || null,
  one: SWARM.judgement || null,
  member: SWARM.memberJudgements || null,
};

// A declared route that answered "not here" stays not here for the visit, so
// one 404 is all a reader's console ever shows.
let judgementsAbsent = false;
/** For tests. */
export function _resetJudgementProbe() { judgementsAbsent = false; }

/** @param {any} e */
const routeAbsent = (e) => e?.status === 404 || e?.code === "not_json";

// The house's own judge, as the backend spells it when no seated member
// judged, by the company that runs it (RM-97): "Robot Money" already names too
// many things, the house analyst among them. Themis, seated, is the house
// judge by name; this is the judge that ran with no judge seated.
export const HOUSE_JUDGE_ID = "robotmoney-in-house";
export const HOUSE_JUDGE_NAME = "RM Protocol Labs";

// The member-judgements route's ceiling, as the takes route's is.
export const MEMBER_JUDGEMENTS_MAX = 100;

/** @param {any} member */
export function isJudge(member) { return member?.role === "judge"; }

// A member's role as the site names it, in the role pill (.rm-role) wherever a
// role shows: "Judge" for a judge, "Analyst" for every other seat (the
// roster's `role: "member"`, and a roster from before #1017 that has none).
/** @param {any} member */
export function roleLabel(member) { return isJudge(member) ? "Judge" : "Analyst"; }

/**
 * The public DTO, read tolerantly: camelCase as the route serves it, and the
 * snake_case the stored recommendation's own `judge` block uses.
 * @param {any} raw
 */
export function normalizeJudgement(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rs = raw.releaseSafety ?? raw.release_safety ?? null;
  return {
    id: raw.id == null ? "" : String(raw.id),
    sessionId: String(raw.sessionId ?? raw.session_id ?? ""),
    subjectId: String(raw.subjectId ?? raw.subject_id ?? ""),
    sessionDate: String(raw.sessionDate ?? raw.session_date ?? "").slice(0, 10),
    judgedBy: raw.judgedBy ?? raw.judged_by ?? null,
    judgedByMemberId: raw.judgedByMemberId ?? raw.judged_by_member_id ?? null,
    source: raw.source === "model" ? "model" : "fallback",
    model: raw.model ?? null,
    promptHash: String(raw.promptHash ?? raw.prompt_hash ?? ""),
    inputsDigest: String(raw.inputsDigest ?? raw.inputs_digest ?? ""),
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
    disagreements: Array.isArray(raw.disagreements) ? raw.disagreements : [],
    releaseSafety: rs && typeof rs === "object" ? rs : null,
    // Whether its session's recommendation set weights (#1017): true only
    // when the record says so.
    recommendsWeights: (raw.recommendsWeights ?? raw.recommends_weights) === true,
    createdAt: String(raw.createdAt ?? raw.created_at ?? ""),
  };
}

// ── loaders ──────────────────────────────────────────────────────────────
// A list: the judgements, [] when there are none, and null when they are not
// served (the route undeclared, absent, or failing), so its page can leave
// the record out rather than call it empty.
/** @param {string | null} route @param {Record<string, string>} [query] */
async function listFrom(route, query) {
  if (!route || judgementsAbsent) return null;
  try {
    const res = await api.get(route, query);
    return (Array.isArray(res?.judgements) ? res.judgements : []).map(normalizeJudgement).filter(Boolean);
  } catch (e) {
    if (routeAbsent(e)) judgementsAbsent = true;
    return null;
  }
}

/** @param {string | null | undefined} sessionId @returns {Promise<any[] | null>} */
export function loadSessionJudgements(sessionId) {
  if (!sessionId || !JUDGEMENT_ROUTES.session) return Promise.resolve(sessionId ? null : []);
  return listFrom(path(JUDGEMENT_ROUTES.session, { id: sessionId }));
}

/** @param {string | null | undefined} memberRef @returns {Promise<any[] | null>} */
export function loadMemberJudgements(memberRef) {
  if (!memberRef || !JUDGEMENT_ROUTES.member) return Promise.resolve(memberRef ? null : []);
  return listFrom(path(JUDGEMENT_ROUTES.member, { id: memberRef }), { limit: String(MEMBER_JUDGEMENTS_MAX) });
}

// One judgement: null when there is no such public record (404, a host whose
// static fallback answered in the API's place, or a release that does not
// serve judgements), and a throw for any other failure, so its page can tell
// "not found" from "could not load".
/** @param {string} id */
export async function loadJudgement(id) {
  if (!JUDGEMENT_ROUTES.one || judgementsAbsent) return null;
  try {
    return normalizeJudgement(await api.get(path(JUDGEMENT_ROUTES.one, { id })));
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (routeAbsent(err)) return null;
    throw e;
  }
}

// The public roster, for pages that hold none of their own and need a judge's
// name. Memoised across the visit; only success is kept, so one failed read
// does not leave every later page nameless.
/** @type {Promise<any[]> | null} */
let rosterPromise = null;
export function loadRoster() {
  if (!rosterPromise) {
    rosterPromise = api.get(ROUTES.swarm.members)
      .then((/** @type {any} */ res) => (Array.isArray(res?.members) ? res.members : []))
      .catch(() => { rosterPromise = null; return []; });
  }
  return rosterPromise;
}

// ── who judged ───────────────────────────────────────────────────────────
/** @param {any[] | null | undefined} roster @param {string} ref */
function findMember(roster, ref) {
  return (roster || []).find((m) => m && (m.id === ref || m.handle === ref)) || null;
}

// The judging member's id, from a judgement or from a recommendation's own
// `judge` block. null for the house judge, and for a block written before the
// backend named its judge.
/** @param {any} j */
export function judgeMemberId(j) {
  const id = j?.judgedByMemberId ?? j?.judged_by_member_id;
  if (id) return String(id);
  const by = j?.judgedBy ?? j?.judged_by;
  return by && by !== HOUSE_JUDGE_ID ? String(by) : null;
}

// The name a judge goes by: the member's, from the roster when it holds them;
// the house judge's; "" when the record does not say who judged.
/** @param {any} j @param {any[]} [roster] */
export function judgeName(j, roster = []) {
  const id = judgeMemberId(j);
  if (id) return findMember(roster, id)?.name || id;
  return (j?.judgedBy ?? j?.judged_by) === HOUSE_JUDGE_ID ? HOUSE_JUDGE_NAME : "";
}

// A seated judge's page, at its public handle. The house judge has none.
/** @param {any} j @param {any[]} [roster] */
export function judgeHref(j, roster = []) {
  const id = judgeMemberId(j);
  if (!id) return null;
  return `/swarm/members/${encodeURIComponent(findMember(roster, id)?.handle || id)}`;
}

/** @param {unknown} v */
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);

// The judge, then its name, a way to its member page when it has one. As the
// role pill (the judge's own block on a session) or, over prose a judge wrote
// elsewhere, as a plain label, "Judge: Themis": the pill names who a member
// is, and is not spent on every line a judge wrote. Bound with x-html: the
// name comes from a member's own profile, so it and the address are escaped
// here.
const JUDGE_PILL = '<span class="rm-role">Judge</span>';
/** @param {any} j @param {any[]} [roster] @param {{ pill?: boolean }} [opts] */
export function judgeLabelHtml(j, roster = [], { pill = true } = {}) {
  const lead = pill ? JUDGE_PILL : "Judge";
  const name = judgeName(j, roster);
  if (!name) return lead;
  const href = judgeHref(j, roster);
  const who = href ? `<a class="rr-lnk" href="${escapeHtml(href)}">${escapeHtml(name)}</a>` : escapeHtml(name);
  return pill ? `${lead} ${who}` : `${lead}: ${who}`;
}

/** @param {any} j */
export function judgementHref(j) {
  return j?.id ? `/swarm/judgements/${encodeURIComponent(j.id)}` : null;
}

// Whether a session's rationale is a judge's own prose. A live aggregate
// writes its rationale from a template over the tally the page already draws,
// and only a MODEL judge replaces it with words of its own: the fallback
// writes the same template.
/** @param {any} s */
export function judgeWroteRationale(s) {
  const rec = s?.swarmRecommendation;
  return !!(rec?.rationale && rec?.judge?.source === "model");
}

// ── the advice ───────────────────────────────────────────────────────────
// The backend opens a thin session's concerns with its own sentence for the
// count, and records a hold with no reason as a sentence saying so. The line
// states both already, so neither is listed under it.
const THIN_CONCERN = /^thinly supported\b/i;
const UNNAMED_CONCERN = /^judge withheld release without naming a specific concern\.?$/i;

/**
 * A hold, in words: "Advises: Hold · 2 takes, below the minimum of 3", and the
 * reason alone ("2 takes, below the minimum of 3") for beside the call's badge
 * (adviceCall). The reason is the count when support is thin, or the one
 * concern when there is one; anything more is listed under it. null for a
 * call that is not a hold, which has no reason to give.
 * @param {any} rs
 * @returns {{ line: string, reason: string, concerns: string[] } | null}
 */
export function adviceOf(rs) {
  if (!rs || rs.release !== "hold") return null;
  const n = Number(rs.take_count ?? rs.takeCount);
  const min = Number(rs.min_takes ?? rs.minTakes);
  const counted = Number.isFinite(n) && Number.isFinite(min);
  const thin = rs.thinly_supported === true || rs.thinlySupported === true || (counted && n < min);
  const concerns = (Array.isArray(rs.concerns) ? rs.concerns : [])
    .map((/** @type {unknown} */ c) => String(c ?? "").trim())
    .filter((/** @type {string} */ c) => c && !UNNAMED_CONCERN.test(c) && !(thin && THIN_CONCERN.test(c)));
  const parts = ["Advises: Hold"];
  if (thin && counted) parts.push(`${n} ${n === 1 ? "take" : "takes"}, below the minimum of ${min}`);
  else if (concerns.length === 1) parts.push(/** @type {string} */ (concerns.shift()).replace(/\.$/, ""));
  // `reason` is the line without its call, for beside the call's badge.
  return { line: parts.join(" · "), reason: parts[1] || "", concerns };
}

// The judge's call, as its badge names it: Hold or Update (RM-97,
// 2026-09-21). Update: the recommendation should become the target. Hold: the
// target stays as it is. Either way the recommendation is published. The data
// says "hold" or "safe"; "safe" is never printed, since on a money page it
// reads as a safety claim about the vault. Hold wears the attention hue,
// Update none (.rr-advice-badge). Swapping a word is this table.
/** @type {Record<"hold" | "safe", { key: "hold" | "update", label: string }>} */
export const ADVICE_CALLS = { hold: { key: "hold", label: "Hold" }, safe: { key: "update", label: "Update" } };
// Whether a judge's call has anything to act on: a recommendation that sets
// weights, which Update would make the target. A session that published no
// weights holds the target by itself, and a portfolio review sets none: there
// a judge's reasons show and no call does (RM-97, 2026-09-21). A public
// judgement says it (`recommendsWeights`, #1017); a page holding the session
// reads it off the recommendation.
/** @param {any} rec */
export function setsWeights(rec) {
  if (rec?.type !== "bucket_weights") return false;
  const w = rec.weights;
  const values = Array.isArray(w) ? w.map((x) => x?.weight) : w && typeof w === "object" ? Object.values(w) : [];
  return values.some((v) => v != null && Number.isFinite(Number(v)));
}

/** @param {any} rs */
export function adviceCall(rs) {
  /** @type {unknown} */
  const call = rs?.release;
  return call === "hold" || call === "safe" ? ADVICE_CALLS[/** @type {"hold" | "safe"} */ (call)] : null;
}

/** @param {any} rs */
export function adviceLine(rs) { return adviceOf(rs)?.line || ""; }

// ── judges are not analysts ──────────────────────────────────────────────
// A judge files no take (the backend refuses one), so it is neither absent
// from a session nor a seat a take could have filled. Production's
// aggregation still counts a seated judge: it is inside `quorum.active` and
// listed in `absent`. That is the backend owner's to fix; until it is, every
// count of who could have filed reads through here, and the day it is fixed
// nothing here has anything left to subtract. A judge is known by its roster
// role, or by having judged this very session (a page with no roster).
/** @param {any} rec @param {any[]} [roster] */
function judgeIdsOf(rec, roster = []) {
  const ids = new Set();
  for (const m of roster || []) {
    if (!isJudge(m)) continue;
    if (m.id) ids.add(m.id);
    if (m.handle) ids.add(m.handle);
  }
  const own = judgeMemberId(rec?.judge);
  if (own) ids.add(own);
  return ids;
}

// The members who could have filed and did not.
/** @param {any} rec @param {any[]} [roster] @returns {string[]} */
export function analystAbsent(rec, roster = []) {
  const judges = judgeIdsOf(rec, roster);
  return (Array.isArray(rec?.absent) ? rec.absent : []).filter((/** @type {string} */ id) => id && !judges.has(id));
}

// The seats a take could have filled: `quorum.active`, less the judges it
// counted as absent. null when the record carries no quorum.
/** @param {any} rec @param {any[]} [roster] */
export function analystSeats(rec, roster = []) {
  const q = rec?.quorum;
  const active = Number(q?.active);
  if (!q || !Number.isFinite(active)) return null;
  const judges = judgeIdsOf(rec, roster);
  const seated = (Array.isArray(rec?.absent) ? rec.absent : []).filter((/** @type {string} */ id) => judges.has(id)).length;
  return Math.max(Number(q.submitted) || 0, active - seated);
}

// The roster's members who file takes.
/** @param {any[] | null | undefined} roster */
export function analystCount(roster) { return (roster || []).filter((m) => !isJudge(m)).length; }
