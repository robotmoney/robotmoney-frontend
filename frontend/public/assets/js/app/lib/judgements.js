// The consensus judge's public record: a judgement is its own record with its
// own page, as a take is, and a session judged by several judges shows each
// one's opinion rather than the one the session adopted (operators who run a
// judge come looking for theirs).
//
// What a judgement is NOT, and what every surface below must not imply: it
// never edits or scores a take, and it never sets a weight (the weights are
// the members' average, computed before any judge runs). Its release call is
// ADVICE. Nothing in the lifecycle refuses to publish on a hold, and
// publishing is not applying, so the call is worded ("Advises: Hold") and
// never drawn as a status. A "safe" call prints nothing at all: on a page
// about money the word reads as a safety claim.
import { api, ROUTES, path } from "./api.js";

// THE THREE PATHS. The frontend's route table is the vendored contract
// (contract/routes.js, held identical to the backend's by `bun run
// check-contract`), so this change cannot add them there. The backend PR that
// serves them (#1017) adds them as `sessionJudgements`, `judgement` and
// `memberJudgements`. Either PR can land first: the contract's names win once
// it carries them, and until then the same paths are derived from the entries
// it already has.
const SWARM = /** @type {Record<string, string>} */ (/** @type {unknown} */ (ROUTES.swarm));
export const JUDGEMENT_ROUTES = {
  session: SWARM.sessionJudgements || `${SWARM.sessionById}/judgements`,
  one: SWARM.judgement || SWARM.members.replace(/\/members$/, "/judgements/:id"),
  member: SWARM.memberJudgements || `${SWARM.member}/judgements`,
};

// The house's own judge, as the backend spells it when no seated member
// judged. The house member reads "Robot Money" everywhere
// (data/swarm/manifests/members/robotmoney.json), and every place this name
// shows already says "Judge" beside it (the role pill, "Judged by").
export const HOUSE_JUDGE_ID = "robotmoney-in-house";
export const HOUSE_JUDGE_NAME = "Robot Money";

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
    createdAt: String(raw.createdAt ?? raw.created_at ?? ""),
  };
}

// ── loaders ──────────────────────────────────────────────────────────────
// A list that cannot be read is an empty list: production answers 404 on
// these routes until #1017 deploys, and that has to read as "no judgements",
// never as a failure of the page around it.
/** @param {string} route @param {Record<string, string>} [query] */
async function listFrom(route, query) {
  try {
    const res = await api.get(route, query);
    return (Array.isArray(res?.judgements) ? res.judgements : []).map(normalizeJudgement).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/** @param {string | null | undefined} sessionId */
export function loadSessionJudgements(sessionId) {
  return sessionId ? listFrom(path(JUDGEMENT_ROUTES.session, { id: sessionId })) : Promise.resolve([]);
}

/** @param {string | null | undefined} memberRef */
export function loadMemberJudgements(memberRef) {
  return memberRef
    ? listFrom(path(JUDGEMENT_ROUTES.member, { id: memberRef }), { limit: String(MEMBER_JUDGEMENTS_MAX) })
    : Promise.resolve([]);
}

// One judgement: null when there is no such public record (404, or a host
// whose static fallback answered in the API's place), and a throw for any
// other failure, so its page can tell "not found" from "could not load".
/** @param {string} id */
export async function loadJudgement(id) {
  try {
    return normalizeJudgement(await api.get(path(JUDGEMENT_ROUTES.one, { id })));
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err?.status === 404 || err?.code === "not_json") return null;
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

// The role pill, then the judge's name, a way to its member page when it has
// one; the pill alone when the record does not say who. Bound with x-html: the
// name comes from a member's own profile, so it and the address are escaped
// here.
const JUDGE_PILL = '<span class="rm-role">Judge</span>';
/** @param {any} j @param {any[]} [roster] */
export function judgeLabelHtml(j, roster = []) {
  const name = judgeName(j, roster);
  if (!name) return JUDGE_PILL;
  const href = judgeHref(j, roster);
  return `${JUDGE_PILL} ${href ? `<a class="rr-lnk" href="${escapeHtml(href)}">${escapeHtml(name)}</a>` : escapeHtml(name)}`;
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

// The judge's call, as its badge names it. The data says "hold" or "safe";
// "safe" is never printed, since on a money page it reads as a safety claim
// about the vault, so the call that clears the recommendation reads
// "Proceed". Hold wears the attention hue, Proceed none (.rr-advice-badge).
// Swapping the word is this table.
/** @type {Record<"hold" | "safe", { key: "hold" | "proceed", label: string }>} */
export const ADVICE_CALLS = { hold: { key: "hold", label: "Hold" }, safe: { key: "proceed", label: "Proceed" } };
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
