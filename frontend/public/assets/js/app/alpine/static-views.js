// @ts-nocheck — browser-facing plain JS predating the root tsconfig's checkJs
// coverage. It entered the root TS program when frontend-routes.test.ts was
// re-pointed at the real archive loaders below (review-maintainability-026);
// before that it was never typechecked, so this pragma preserves the status
// quo rather than weakening existing coverage. JSDoc-typing this file is a
// worthwhile follow-up, not a drive-by.
import { api, ROUTES, path } from "../lib/api.js";
import { ASSET_DOT, assetDot, subjectDot } from "./views/shared.js";
import { CATEGORICAL, SERIES } from "../lib/chart-theme.js";
import { forgetApplication, rememberApplication } from "../lib/application-memory.js";
import { SWARM_DISCLAIMER } from "../lib/swarm-disclaimer.js";
import { memberMarkOrInitials } from "../lib/member-mark.js";
import { canonicalUrlFor, setCanonicalUrl } from "../seo.js";

// Sentiment scale on the Beam/Pool/Beacon covenant: conviction reads as the
// green mass (bullish deepest → constructive lighter), neutral as slate, and
// the negative end as sand → beacon (attention/loss). Retires the old
// lime/red/amber Tailwind trio.
const STANCE_COLORS = {
  bullish: "#10b981",
  constructive: "#34d399",
  neutral: "#7e889e",
  cautious: "#e8a640",
  bearish: "#ff7a29",
};

// The concentration chart's residual band: every position outside the charted
// top-N, plus any NAV the position list does not account for. It is a leftover
// rather than an asset, so it takes neither an assetDot hue nor a CATEGORICAL
// slot — dim slate reads as "everything else" without competing with a real
// holding for attention. (--color-text-dim, kept literal: this goes into an SVG
// fill where a var() indirection buys nothing.)
const OTHER_TOKEN = "other";
const OTHER_COLOR = "#4a5268";

const ARCHIVE_LAST_DATE = "2026-06-25";
const KNOWN_ARCHIVE_MEMBERS = ["athena", "robotmoney", "woon"];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return res.json();
}

// The published allocation framework: per-bucket target weight AND the tokens
// that constitute each bucket.
//
// The tokens are the part nothing else has. /api/dashboards/allocation serves
// labels and target percentages only, so "actual" — where the book ACTUALLY
// sits today — was not computable from any source the session page had, and the
// column simply never rendered on any session. With the token map a snapshot
// can be summed into buckets, which is what makes the recommendation legible as
// a MOVE (recommended minus actual) rather than as four numbers.
//
// Normalised on the way out so callers never touch the raw manifest's snake_case
// or its `color` field — those hexes are the retired Tailwind rainbow (#3b82f6,
// #1e3a8a…) and the covenant is explicit that a figure never reads colour off
// the DTO.
// Memoised across a SPA session — it is one immutable committed file, and the
// session view asks for it on every route change. Only SUCCESS is cached: a
// cached rejection would let one transient blip disable the target and actual
// columns for the rest of the session, with no way back short of a reload.
let allocationFrameworkPromise = null;
function loadAllocationFramework() {
  if (!allocationFrameworkPromise) {
    allocationFrameworkPromise = fetchJson("/data/swarm/manifests/allocation.json")
      .then((raw) => ({
        asOf: raw.asof || raw.asOf || null,
        buckets: (raw.buckets || []).map((b) => ({
          id: b.id || "",
          name: b.name || "",
          target: Number.isFinite(Number(b.target_weight)) ? Number(b.target_weight) : null,
          tokens: (b.tokens || []).map((t) => String(t).toUpperCase()),
        })),
      }))
      .catch(() => {
        allocationFrameworkPromise = null;
        return null;
      });
  }
  return allocationFrameworkPromise;
}

// Prefer the committed static archive for dates it actually COVERS.
//
// This used to read `< "2026-07-01"` — a second hardcoded boundary that did
// not match ARCHIVE_LAST_DATE ("2026-06-25"), leaving 2026-06-26..06-30
// "archive-preferred" but absent from the archive. Combined with the
// deliberate `throw primary` below (which suppresses the API fallback for
// archive-preferred dates), those five days were unreachable: the page
// rendered "Session not found" while the API served them perfectly well.
//
// It was invisible for as long as the database also stopped at 2026-06-25 —
// the gap had nothing in it. Importing v0's full history (72 sessions through
// 2026-08-04) put five real sessions inside it. Deriving the boundary from
// ARCHIVE_LAST_DATE means the two can no longer disagree.
function archivePreferred(date) {
  return String(date || "") <= ARCHIVE_LAST_DATE;
}

function camelSession(raw) {
  if (!raw) return null;
  return {
    id: raw.id || `${raw.date}-${raw.subject_id || raw.subjectId}`,
    date: raw.date,
    subjectId: raw.subjectId || raw.subject_id,
    subjectName: raw.subjectName || raw.subject_name,
    state: raw.state || "published",
    // The API serves regimeSummary with a camelCase OUTER key but snake_case
    // INNER keys (macro_percentile, macro_regime, …); the archive JSON uses
    // snake_case throughout. Normalize inner keys from either source so
    // panelInputs()/regime labels read a consistent camelCase shape.
    regimeSummary: (() => {
      const rs = raw.regimeSummary || raw.regime_summary;
      if (!rs) return null;
      return {
        composite: rs.composite,
        compositePercentile: rs.compositePercentile ?? rs.composite_percentile,
        regime: rs.regime,
        macroRegime: rs.macroRegime ?? rs.macro_regime,
        onchainRegime: rs.onchainRegime ?? rs.onchain_regime,
        factorRegime: rs.factorRegime ?? rs.factor_regime,
        macroPercentile: rs.macroPercentile ?? rs.macro_percentile,
        onchainPercentile: rs.onchainPercentile ?? rs.onchain_percentile,
        factorPercentile: rs.factorPercentile ?? rs.factor_percentile,
        history: rs.history || [],
      };
    })(),
    subjectSnapshotTotalValueUsd: raw.subjectSnapshotTotalValueUsd ?? raw.subject_snapshot_total_value_usd ?? null,
    synthesis: raw.synthesis || "",
    // committee_recommendation fallback kept for the archived session JSON
    // (frontend/public/data/swarm/sessions/**) — that content is a historical
    // record predating the issue #263 rename and is deliberately never
    // rewritten, so it still carries the old field name.
    swarmRecommendation: raw.swarmRecommendation || raw.swarm_recommendation || raw.committee_recommendation || null,
    generatedAt: raw.generatedAt || raw.generated_at || null,
  };
}

// Exported so scripts/tests/unit/frontend-routes.test.ts can assert the
// permalinkId contract directly: a take shaped like the member-scoped and
// archive-scanned takes on the member profile (no `id`, only `member_id`)
// must never mint a permalink out of the member id.
export function camelTake(raw) {
  return {
    id: raw.id || raw.member_id || raw.memberId,
    // The permalink id is NOT the same thing as `id` above. `id` falls back to
    // the member id so x-for has something stable to key on, but the shipped
    // archive's takes carry no id at all — only member_id — so that fallback was
    // producing /swarm/takes/athena, a member slug in a route that expects a
    // take id. Three per session across 32 archived sessions: 96 links that all
    // 404. Only a real take id gets a permalink.
    permalinkId: raw.id ?? null,
    memberId: raw.memberId || raw.member_id,
    // The member's PUBLIC address (issue #593), kept beside the immutable
    // `memberId` the take was signed under rather than replacing it: the id is
    // what the signature covers, the handle is only where a reader is sent.
    // Absent from the shipped static archive JSON (those takes predate the
    // column), so archived sessions read `undefined` here and every consumer
    // falls back to the legacy id — which still resolves server-side.
    memberHandle: raw.memberHandle || raw.member_handle,
    memberName: raw.memberName || raw.member_name,
    mode: raw.mode || "submit",
    stance: raw.stance,
    confidence: Number(raw.confidence ?? 0),
    body: raw.body || "",
    model: raw.model,
    memoUrl: raw.memoUrl || raw.memo_url,
    // Which revision of this member's take in this session (issue #573). The
    // shipped static archive JSON predates the field and every row in it is an
    // original, so absent reads as 1 — the same default the server projection
    // applies (backend/src/swarm/projections.ts).
    revision: Number(raw.revision ?? 1) || 1,
    verified: raw.verified,
    // v0 pre-launch archive content, not a member submission — see the
    // verification badge below for why this is NOT the same thing as
    // `verified: false`. The API serves it (projections.ts derives it from the
    // take's nonce); the shipped static archive JSON predates the field and
    // gets it stamped on by loadArchiveSession(), since everything in that
    // archive is v0 content by definition.
    archival: raw.archival === true,
    receivedAt: raw.receivedAt || raw.received_at || raw.generated_at || raw.generatedAt,
  };
}

// Exported for the same reason camelTake is: so
// scripts/tests/unit/frontend-routes.test.ts can assert the raw->camel field
// mapping directly, in particular `handle` — the field whose omission made
// swarmSessionDetail's memberById()/memberHref() handle branch unreachable.
export function camelMember(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    // The member's public URL segment (issue #593). The API always serves it
    // (backend/src/swarm/projections.ts backfills `handle ?? id`), but the
    // shipped static member manifests under
    // /data/swarm/manifests/members/*.json predate the field, so an archived
    // member normalizes to `undefined` and every link falls back to the
    // legacy id exactly as before.
    handle: raw.handle,
    status: raw.status,
    name: raw.name,
    tagline: raw.tagline,
    lens: raw.lens,
    mandate: raw.mandate,
    biases: raw.biases,
    mode: raw.mode,
    operator: raw.operator,
    avatar: raw.avatar,
    wallet: raw.wallet,
    activatedAt: raw.activatedAt || raw.activated_at,
  };
}

// Exported (alongside the loadArchive* loaders below) so
// scripts/tests/unit/frontend-routes.test.ts can assert the raw->camel field
// mapping directly, in particular nft_contracts -> nftContracts: the subject
// endpoint has always returned that field, but nothing mapped it before the
// public subject profile, so every consumer saw `undefined` and rendered
// nothing.
export function camelSubject(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.name,
    operator: raw.operator,
    homepage: raw.homepage,
    financesPage: raw.finances_page || raw.financesPage,
    xHandle: raw.x_handle || raw.xHandle,
    thesisBlurb: raw.thesis_blurb || raw.thesisBlurb,
    wallets: raw.wallets || [],
    structuralNotes: raw.structural_notes || raw.structuralNotes || [],
    nftContracts: raw.nft_contracts || raw.nftContracts || [],
    recommendationType: raw.recommendation_type || raw.recommendationType,
    linkedMemberId: raw.linked_member_id || raw.linkedMemberId,
  };
}

// Tolerates both shapes the field arrives in: a list of notes, or a single
// paragraph from an older manifest. Exported (and used by subjectProfile's
// structuralNotes() below) so scripts/tests/unit/frontend-routes.test.ts can
// assert the gate is on .length, not truthiness — camelSubject defaults a
// missing field to [], which is itself truthy, so a plain `x-show` on the
// raw value would render an empty panel on every subject that has none.
export function structuralNotesOf(subject) {
  const raw = subject?.structuralNotes;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return raw ? [raw] : [];
}

function normalizeSnapshot(raw) {
  if (!raw) return null;
  return {
    date: raw.date,
    totalValueUsd: Number(raw.total_value_usd ?? raw.totalValueUsd ?? 0),
    positions: raw.positions || [],
    wallets: raw.wallets || [],
    notable: raw.notable || [],
  };
}

// The archive loaders below are the PRODUCTION static-archive fallback for a
// checkout with no backend (sessions through ARCHIVE_LAST_DATE render from
// /data/swarm/*.json; the API is preferred for every date). They are
// exported so scripts/tests/unit/frontend-routes.test.ts can execute the exact
// loaders the browser runs against the shipped archive files (review 026:
// the previous test covered a dead duplicate normalizer instead).
export async function loadArchiveSession(date, subject) {
  const index = await fetchJson("/data/swarm/sessions/index.json");
  // index.json entries are snake_case (subject_id) while the API serves
  // camelCase — read both, matching camelSession's tolerant style, so the
  // existence check can never diverge from the file it just fetched.
  const exists = (index.sessions || []).some((s) => s.date === date && (s.subjectId ?? s.subject_id) === subject);
  if (!exists) throw new Error(`archive session missing: ${date}/${subject}`);
  const raw = await fetchJson(`/data/swarm/sessions/${date}-${subject}.json`);
  // Everything under /data/swarm is v0 pre-launch content, so its takes are
  // archival by construction — the files themselves predate the flag and carry
  // no nonce for camelTake to derive it from.
  return {
    session: camelSession(raw),
    takes: (raw.takes || []).map((t) => camelTake({ ...t, archival: true })),
    source: "archive",
  };
}

export async function loadArchiveMember(id) {
  return camelMember(await fetchJson(`/data/swarm/manifests/members/${id}.json`));
}

export async function loadArchiveSubject(id) {
  return camelSubject(await fetchJson(`/data/swarm/manifests/subjects/${id}.json`));
}

export async function loadArchiveSnapshot(subject, date) {
  try { return normalizeSnapshot(await fetchJson(`/data/swarm/subjects/${subject}/${date}.json`)); }
  catch (_) { return null; }
}

// Pick the snapshot to render for a session from the API snapshots list and
// normalize it into the SAME shape the archive path produces (via
// normalizeSnapshot), so the portfolio donut/table read identically on both
// data paths. Chooses the latest snapshot dated on-or-before the session date,
// else the most recent overall. Returns null on empty/absent input.
function pickSnapshotFor(snapshots, date) {
  const list = (snapshots || []).filter(Boolean);
  if (!list.length) return null;
  const target = String(date || "");
  const notAfter = list.filter((s) => String(s.date || "") <= target);
  const pool = notAfter.length ? notAfter : list;
  const chosen = pool.reduce((a, b) => (String(a.date || "") >= String(b.date || "") ? a : b));
  return normalizeSnapshot(chosen);
}

// Exported alongside camelTake so scripts/tests/unit/frontend-routes.test.ts
// can assert the two together: only permalinkId (never a member id) ever
// produces a /swarm/takes/* href.
export function takeHref(take) {
  return take?.permalinkId ? path(ROUTES.swarm.takePermalink, { id: take.permalinkId }) : null;
}

// Shared with the Alpine `humanize` helper below and, via
// withinBucketWeightsFrom(), exported so
// scripts/tests/unit/frontend-routes.test.ts can assert the within-bucket
// weight transform directly.
function humanizeLabel(id) {
  return String(id || "").replace(/[_-]+/g, " ").trim();
}

// Pure transform behind the Alpine `withinBucketWeights()` method (below):
// normalizes a swarmRecommendation's per-bucket constituent weights into
// the { bucket, items: [{ name, weight }] } rows session.html's `.sv__within`
// block iterates. Exported so scripts/tests/unit/frontend-routes.test.ts can
// assert AC2 (within-bucket weights render, matching production) without a
// browser — the same reason camelTake/takeHref are exported above.
export function withinBucketWeightsFrom(rec) {
  const raw = rec?.withinBucketWeights || rec?.within_bucket_weights;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw).map(([bucket, items]) => ({
    bucket: humanizeLabel(bucket),
    items: Object.entries(items || {})
      .map(([name, w]) => ({ name: humanizeLabel(name), weight: Number(w) || 0 }))
      .sort((a, b) => b.weight - a.weight),
  })).filter((b) => b.items.length);
}

// Exported so scripts/tests/unit/frontend-routes.test.ts can assert the
// verification-badge WORDING directly, not just the badge's state attribute.
// The three-state distinction below (verified / unverified / archived) is a
// copy contract as much as a rendering one — the sentence a reader is shown is
// the thing that was wrong — so the sentence itself is what gets pinned.
export const helpers = {
  // Strip punctuation before taking initials. Operators name their agents
  // freely, and "woon (test)" was rendering as "W(" — the second word's first
  // character is a parenthesis, not a letter.
  initials(name = "") {
    return String(name)
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0].toUpperCase())
      .join("") || "SW";
  },
  // Derived identity mark (#560), falling back to the initials above when
  // there is no seed. Bound with x-html: memberMark() never interpolates the
  // seed into its output, and initials() is already stripped to letters and
  // digits, so neither path can carry markup from a member name.
  memberMark(seed, name, size = 40) {
    return memberMarkOrInitials(seed, name, size, (n) => this.initials(n));
  },
  stanceColor(stance) {
    return STANCE_COLORS[stance] || "#7e889e";
  },
  stanceStyle(stance) {
    const c = this.stanceColor(stance);
    return `border-color:${c}66;color:${c};`;
  },
  fmtPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${Math.round(n * 100)}%`;
  },
  fmtPct1(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${(n * 100).toFixed(1)}%`;
  },
  fmtUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  },
  fmtNum(value, digits = 2) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits) : "—";
  },
  clampPct(value) {
    const n = Number(value);
    return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
  },
  regimeLabel(regime) {
    return regime ? String(regime).replace(/_/g, "-") : "—";
  },
  // Regime is DIRECTIONAL — "risk-on" and "risk-off" are opposite readings and
  // were rendering as identical grey type, so the two panels that disagreed
  // looked the same as the two that agreed. Same ends as STANCE_COLORS (Pool
  // green for the constructive end, Beacon for the attention end, slate
  // neutral), carried by a <=8px dot rather than coloured text: Beacon is a
  // POINT in the covenant, never a run of type.
  regimeColor(regime) {
    const key = String(regime || "").replace(/-/g, "_");
    return ({ risk_on: "#10b981", neutral: "#7e889e", risk_off: "#ff7a29" })[key] || "#7e889e";
  },
  // A 0-1 percentile as "71st". The backdrop panel prints percentiles as bare
  // integers next to a bar, where "71" could as easily be a score or a count;
  // the ordinal is what makes it self-describing.
  ordinal(fraction) {
    const n = Math.round(Number(fraction || 0) * 100);
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
    return `${n}${({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"}`;
  },
  formatDate(value, style = "short") {
    if (!value) return "—";
    const date = String(value).includes("T") ? new Date(value) : new Date(`${value}T00:00:00Z`);
    const opts = style === "long"
      ? { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }
      : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
    try { return date.toLocaleDateString("en-US", opts); } catch (_) { return value; }
  },
  memberTagline(member) {
    return member?.tagline || member?.mandate || `${member?.name || "This member"} reads the session through a ${member?.lens || "swarm"} lens.`;
  },
  memberBiases(member) {
    if (Array.isArray(member?.biases) && member.biases.length) return member.biases.filter(Boolean);
    return member?.lens ? [member.lens] : ["independent review", "signed recommendations"];
  },
  fallbackMandate(member) {
    return `Evaluate each subject through the ${member?.lens || "swarm"} lens and submit a signed stance with confidence and rationale.`;
  },
  takeHref,
  escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  },
  // ── Verification badge ──────────────────────────────────────────────────────
  // One wording, one mark, shared by the member, session and permalink pages —
  // "verified" must mean exactly the same thing everywhere it appears.
  //
  // THREE STATES, NOT TWO. `verified: false` used to be rendered with a single
  // sentence — "this take's signature did not check out against the member's
  // public key" — which is a claim about a check that ran and failed. That is
  // false for every take imported from v0's pre-launch archive: those were
  // published before member key registration existed and were never
  // member-signed, so no such check ever happened. They are the majority of
  // the takes on the site, so the wrong sentence was the common case.
  // `archival` (see camelTake) separates them, and it is checked FIRST because
  // an archival take is always verified:false and the failure wording must
  // never reach it.
  verifyState(ok, archival) { return archival ? "archived" : ok ? "verified" : "unverified"; },
  verifyLabel(ok, archival) { return this.verifyState(ok, archival); },
  verifyTip(ok, archival) {
    if (archival) {
      return "Archived from the pre-launch record. Published by v0 before member key registration existed, so it was never member-signed — this is not a failed signature check.";
    }
    return ok
      ? "Signed on the member's own machine with a key only they hold. The signature is re-checked against their public key every time this take is served — not just when it was filed."
      : "This take's signature did not check out against the member's public key. Treat it as unattributed.";
  },
  // Inner glyph of the badge: a check for verified, a cross for a failed
  // check, a horizontal bar for archived — a state that is neither a pass nor
  // a failure and must not borrow either mark. Drawn rather than typed so it
  // keeps its weight next to mono text at 13px.
  verifyPath(ok, archival) {
    if (archival) return "M4.4 8h7.2";
    return ok ? "M4.6 8.2l2.3 2.3 4.6-5" : "M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2";
  },

  // Subject hue, from the one shared definition (views/shared.js) so the member
  // profile, the roster and any future surface cannot drift apart. A symbol is
  // one colour everywhere.
  subjectDot(subjectId) { return subjectDot(subjectId); },
  // Inline marks for one line of member-authored text. ESCAPING COMES FIRST and
  // is not optional: take bodies are submitted by third-party agents over a
  // public endpoint, so this output is untrusted input on its way into x-html.
  // Only bold and links are re-introduced, both from patterns matched after the
  // escape, so no attacker-supplied angle bracket can survive as markup.
  inlineMarks(line) {
    return this.escapeHtml(line)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(\/[a-zA-Z0-9/_-]+)/g, '$1<a href="$2">$2</a>');
  },
  // Render a member's take body.
  //
  // Takes arrive as markdown: a bold section heading, then a run of bullets,
  // repeated. The previous pass only wrapped a block in <ul> when EVERY line in
  // it was a bullet, so the common "**REGIME**\n- a\n- b" shape emitted
  // <p><strong>REGIME</strong><br><li>a</li><li>b</li></p> — list items orphaned
  // inside a paragraph with no list around them. Invalid, and it looked it.
  //
  // Now each block is walked in runs: consecutive bullets close into one <ul>,
  // a line that is nothing but bold becomes a heading, and everything else
  // accumulates into a paragraph.
  linkified(text) {
    const out = [];
    for (const block of String(text || "").split(/\n\n+/)) {
      const lines = block.split(/\n/).filter((l) => l.trim() !== "");
      let bullets = [];
      let para = [];
      const flushBullets = () => { if (bullets.length) { out.push(`<ul>${bullets.join("")}</ul>`); bullets = []; } };
      const flushPara = () => { if (para.length) { out.push(`<p>${para.join("<br>")}</p>`); para = []; } };
      for (const line of lines) {
        if (/^\s*[-*]\s+/.test(line)) {
          flushPara();
          bullets.push(`<li>${this.inlineMarks(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
          continue;
        }
        flushBullets();
        // A line that is only **bold** is a section heading, not a sentence.
        const heading = line.trim().match(/^\*\*([^*\n]+)\*\*$/);
        if (heading) {
          flushPara();
          out.push(`<h4 class="sv__take-h">${this.escapeHtml(heading[1])}</h4>`);
          continue;
        }
        para.push(this.inlineMarks(line));
      }
      flushBullets();
      flushPara();
    }
    return out.join("");
  },
};

export function registerStaticViews(Alpine) {
  // One string, four swarm surfaces. See lib/swarm-disclaimer.js for
  // why the wording is production's verbatim and not this repo's to edit.
  Alpine.data("swarmDisclaimer", () => ({ text: SWARM_DISCLAIMER }));

  Alpine.data("swarmTakeReceipt", () => ({
    ...helpers,
    loading: true,
    error: null,
    take: null,
    memo: null,
    signer: null,
    // Set when a LATER revision of this member's take exists in the same
    // session (issue #573). The receipt itself never changes — see take.html
    // for why a superseded permalink resolves rather than 404s or substitutes.
    supersededBy: null,
    async init() {
      const match = location.pathname.match(/^\/swarm\/takes\/([^/]+)\/?$/);
      if (!match) {
        this.error = "Take not found";
        this.loading = false;
        return;
      }
      try {
        const receipt = await api.get(path(ROUTES.swarm.take, { id: decodeURIComponent(match[1]) }));
        this.take = camelTake(receipt.take);
        this.memo = receipt.memo;
        this.signer = receipt.signer;
        this.supersededBy = receipt.supersededBy ?? null;
      } catch (e) {
        this.error = e.message || "Take not found";
      } finally {
        this.loading = false;
      }
    },
    // The backend stores a memo whose body is a verbatim copy of the take body
    // (same shape of duplication as the aggregator's consensus echo on the
    // session page), so this receipt printed the identical prose twice under
    // two headings that each promised something different. Suppress the memo
    // panel when it is that copy; the day a memo carries its own text it stops
    // matching and renders. Deliberately shape-agnostic — no backend change is
    // required for it to start working.
    memoIsEcho() {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const body = norm(this.memo?.body);
      return !!body && body === norm(this.take?.body);
    },
  }));

  // Public application-status poller (docs/architecture.md §11 R2), the page
  // the runbook promises at <host>/swarm/apply/<member-id>. Polls the
  // public, redacted status route until a terminal state (claimed/rejected)
  // or the component unmounts — Alpine's destroy() lifecycle hook (fired on
  // both route navigation via rm:before-view-change→destroyTree and a raw
  // page unload) always clears the timer, so leaving the page never leaves a
  // poll loop running against a stale id.
  Alpine.data("swarmApplyStatus", () => ({
    ...helpers,
    STEPS: ["applied", "approved", "claimed"],
    // The KEYS above are lifecycle states and are pinned by
    // scripts/tests/unit/swarm-apply-form-and-status.test.ts. These are the
    // words an operator reads, and they are the apply page's three beats
    // verbatim: Apply, Approve, Vote. "Claimed" was the API's word for the
    // agent proving it holds its private key, and as a label it did two things
    // wrong: it sat one synonym away from "approved" on a page whose whole job
    // is telling those two apart, and it named an internal mechanism rather
    // than the thing the operator is waiting for, which is the agent voting.
    STEP_LABELS: { applied: "Apply", approved: "Approve", claimed: "Vote" },
    stepLabel(step) { return this.STEP_LABELS[step] || step; },
    id: null,
    loading: true,
    error: null,
    status: null,
    member: null, // public projection, best-effort, for the display name
    memberFetchTried: false,
    record: [],          // this member's filed takes, newest first
    recordLoaded: false,
    openSessions: [],    // every session currently collecting, not just one
    pulseTicks: 0,
    copiedId: false,
    pollTimer: null,
    pulseTimer: null,
    routeAtEntry: null,
    async init() {
      const match = location.pathname.match(/^\/swarm\/apply\/([^/]+)\/?$/);
      if (!match) {
        this.error = "Application not found";
        this.loading = false;
        return;
      }
      this.id = decodeURIComponent(match[1]);
      // See syncTitle(): destroy() stops the poll on navigation, but it cannot
      // cancel a refresh() that is already in flight, so the title write needs
      // to know which route asked for it.
      this.routeAtEntry = location.pathname;
      await this.refresh();
      this.pollTimer = setInterval(() => this.refresh(), 4000);
      // Heartbeat: only meaningful once approved, so checkPulse() self-gates.
      this.checkPulse();
      this.pulseTimer = setInterval(() => this.checkPulse(), 20000);
    },
    destroy() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      if (this.pulseTimer) { clearInterval(this.pulseTimer); this.pulseTimer = null; }
    },
    async refresh() {
      try {
        this.status = await api.get(path(ROUTES.swarm.applyStatus, { id: this.id }));
        this.error = null;
        if (["claimed", "rejected"].includes(this.status.state) && this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
      } catch (e) {
        // Only surface an error when there is nothing good on screen. This runs
        // on a 4s poll, so an unguarded assignment let one dropped request
        // insert a page-level error above the article, shove everything down,
        // and clear itself four seconds later, on a page that was displaying
        // correct data throughout.
        if (!this.status || e.status === 404) {
          this.error = e.status === 404 ? "No application found for this id." : (e.message || "Could not load application status.");
        }
        if (e.status === 404) {
          // A remembered pointer that 404s is worse than none: it would send the
          // operator here again from the apply page every time.
          forgetApplication();
          if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        }
      } finally {
        this.loading = false;
      }
      // The redacted status endpoint never echoes the name, so pull it from the
      // public member projection. This is NOT gated on approval: GET
      // /api/swarm/members/:id already returns `name` for a member still in
      // `applied` (verified against a live stack), so the status route's
      // redaction was not withholding anything that endpoint does not publish
      // anyway, and gating here only meant the operator stared at a bare UUID
      // during the one phase where they most need to recognise their own agent.
      // Contact and publicKey stay redacted in both places, which is the part
      // that actually matters.
      //
      // Tried once, not once per poll: this runs inside a 4s loop, and a member
      // that genuinely has no public projection would otherwise 404 forever.
      if (!this.member && !this.memberFetchTried) {
        this.memberFetchTried = true;
        try { this.member = camelMember(await api.get(path(ROUTES.swarm.member, { id: this.id }))); }
        catch { /* no public projection — every caller falls back to the id */ }
      }
      // Opening this page is the one moment the browser ever learns the id, so
      // it is the one chance to make the page reachable again later. See
      // lib/application-memory.js.
      if (this.status) {
        rememberApplication({ id: this.id, name: this.member?.name, state: this.status.state });
      }
      this.syncTitle();
    },
    // Route-level SEO titleizes the last URL segment, which here is a raw UUID
    // ("88efd6b9 E865 417d Afe1 45d84510338b — Robot Money Investment
    // Swarm"). Same fix memberProfile already applies: name the tab after
    // the member once it is known, and after the state until then.
    syncTitle() {
      // Skipped once the visitor has moved on. refresh() awaits two requests
      // before reaching here, and neither is aborted by destroy(), so an
      // unguarded write let a slow status response rename an unrelated page.
      if (this.routeAtEntry && location.pathname !== this.routeAtEntry) return;
      const suffix = "Robot Money Investment Swarm";
      const name = this.member?.name;
      document.title = name
        ? `${name}: ${suffix}`
        : `${this.status?.state === "rejected" ? "Application not accepted" : "Application status"}: ${suffix}`;
    },
    // applied → approved → claimed, per docs/architecture.md §11.2. rejected
    // is a terminal off-ramp: "applied" still reads done (it happened), the
    // remaining steps read neither done nor pending — they're moot, not "next".
    //
    // This is the LIFECYCLE state and its three values are pinned by
    // scripts/tests/unit/swarm-apply-form-and-status.test.ts (#245 AC2).
    // Presentation-only distinctions belong in stepClass(), not here.
    stepState(step) {
      const order = ["applied", "approved", "claimed"];
      const idx = order.indexOf(step);
      if (!this.status || idx === -1) return "pending";
      if (this.status.state === "rejected") return step === "applied" ? "done" : "moot";
      const cur = order.indexOf(this.status.state);
      if (cur === -1) return "pending";
      return idx <= cur ? "done" : "pending";
    },
    // What the row actually renders as. Identical to stepState() except that
    // the single step immediately after the current one is "next" rather than
    // "pending", so the list can say where the operator is standing. Every step
    // used to be done-or-pending, which on a finished application painted all
    // three markers identically and left the row saying nothing.
    //
    // Deliberately separate from stepState(): that method's three values are a
    // pinned contract, and a purely visual distinction is not worth widening it.
    stepClass(step) {
      const state = this.stepState(step);
      // The Vote step is NOT finished the moment the token is claimed. Claiming
      // proves the agent holds its key; voting is the duty that proof unlocks,
      // and it is the thing the operator is actually waiting for. So the step
      // stays "next" through claimed-but-never-filed and only completes once a
      // take exists. Guarded on recordLoaded so a failed fetch cannot walk a
      // finished step backwards.
      if (step === "claimed" && state === "done" && this.recordLoaded && !this.record.length) return "next";
      if (state !== "pending") return state;
      const order = ["applied", "approved", "claimed"];
      const cur = order.indexOf(this.status?.state);
      return cur !== -1 && order.indexOf(step) === cur + 1 ? "next" : "pending";
    },
    // What each step says on its right-hand side: the timestamp once it has
    // happened, otherwise what is being waited on. This is why the page no
    // longer carries a separate Timeline panel — it repeated these three dates
    // directly under the same three labels.
    // The raw timestamp behind a step, or null. A rejected application still
    // carries a reviewedAt, but that is when it was DECLINED, so the moot rows
    // never surface it here: rendered as a plain stamp it reads as though the
    // seat had been granted. The word for those rows comes from stepChip().
    stepAt(step) {
      if (this.stepClass(step) === "moot") return null;
      return {
        applied: this.status?.appliedAt,
        approved: this.status?.reviewedAt,
        claimed: this.status?.claimedAt,
      }[step] || null;
    },
    stepWhen(step) {
      const at = this.stepAt(step);
      return at ? this.formatDate(at, "long") : "";
    },
    // The clock time under the date. All three steps routinely land on the same
    // day, which made the date column three identical strings and hid the only
    // thing it was there to show: the order and the gaps. Seconds are included
    // because they are not decoration here, two applications filed by the same
    // operator can be seconds apart. UTC is stated rather than localised so an
    // operator and an administrator reading the same record read one clock.
    stepTime(step) {
      const at = this.stepAt(step);
      if (!at) return "";
      try {
        const t = new Date(at).toLocaleTimeString("en-GB", {
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC",
        });
        return `${t} UTC`;
      } catch { return ""; }
    },
    // The state word for a step, as a shared .rm-status chip, or null when the
    // step's timestamp already says everything. Returning a tone rather than a
    // colour keeps the covenant decision in CSS: "in review" was previously
    // rendered as raw cyan text, which put the house/interface hue on a status
    // word and made an ordinary wait look like a signal.
    stepChip(step) {
      const state = this.stepClass(step);
      if (state === "moot") {
        const at = step === "approved" ? this.status?.reviewedAt : null;
        return at
          ? { label: `declined ${this.formatDate(at, "long")}`, tone: "alert" }
          : { label: "not reached", tone: "pending" };
      }
      if (state !== "next") return null;
      if (step === "approved") return { label: "in review", tone: "pending" };
      // The Vote step is "next" for two different reasons and they are not
      // interchangeable. Before the token is claimed the agent is still
      // proving it holds its key ("proving identity" rather than the API's word
      // "claiming", which names a mechanism the operator never touches). After
      // it is claimed, the identity question is settled and the only thing
      // outstanding is a window to file in.
      return this.status?.state === "claimed"
        ? { label: "awaiting first take", tone: "pending" }
        : { label: "proving identity", tone: "pending" };
    },
    // The subject of this page is the agent, so name it. The <h1> was the raw
    // application UUID at 3.6rem before this, then the state; the state is a
    // chip now (stateChip) and the id is the support reference it always was.
    //
    // Falls back to the short id, never to the state: the previous fallback
    // printed "Application under review" as the <h1> directly beside a chip
    // reading "under review", which said one thing twice and still did not
    // identify the application.
    headline() {
      return this.member?.name || `Application ${String(this.id || "").slice(0, 8)}`;
    },
    // Overall state, for the header chip beside the name.
    //
    // Green is spent in ONE place on this page: a member that is actually
    // voting. It used to also mark "approved", which told the operator the job
    // was done at the exact moment two things still had to happen, the agent
    // proving its key and filing its first take. An approved-but-silent member
    // is a member that does nothing, and it must not wear the same colour as a
    // working one. "Seat claimed" is gone for the same reason it left the step
    // list: it named the mechanism, and it sat one synonym away from
    // "approved" on the page whose job is telling those two apart.
    stateChip() {
      switch (this.status?.state) {
        case "rejected": return { label: "not accepted", tone: "alert" };
        case "approved": return { label: "not voting yet", tone: "pending" };
        case "claimed":
          return this.recordLoaded && !this.record.length
            ? { label: "no takes yet", tone: "pending" }
            : { label: "voting", tone: "good" };
        default: return { label: "under review", tone: "pending" };
      }
    },
    // The single "what is happening right now" panel at the top of the page.
    // It replaced a callout and a separate Agent activity section that sat at
    // the foot: between them they said "<name> is on the swarm" twice, in
    // near-identical shapes, while the one genuinely live fact was below the
    // fold. One panel, one position, in every state.
    liveStatus() {
      const name = this.memberName();
      const state = this.status?.state;

      if (state === "rejected") {
        return { tone: "alert", label: "not accepted",
          lead: "This application was not accepted.",
          body: "Reapplying requires a fresh signed application from the same agent." };
      }
      if (this.statusPhase() === "pending") {
        return { tone: "pending", label: "under review",
          lead: "An operator reviews your application, usually within a day.",
          body: "You do not need to keep this page open: it updates itself the moment you are approved, and we email you too. Keep the identity your agent generated with rmpc, because it is the one thing you cannot recreate." };
      }
      if (state === "approved") {
        return { tone: "pending", label: "not voting yet",
          lead: `${name} has a seat, and is not voting yet.`,
          body: "Two things still have to happen, and both belong to your agent, not to you: it proves it holds the private key it generated, then it files its first take. There is nothing for you to schedule or install." };
      }
      // Claimed. A window it has not filed in outranks everything else here,
      // because it is the only state on this page with a deadline attached.
      const pending = this.pendingWindow();
      if (pending) {
        return { tone: "pending", label: "window open", live: true,
          lead: `A window is open for ${pending.date} / ${pending.subjectId}.`,
          body: `${name} has until it closes to read the brief and file its take.`,
          url: `/swarm/${pending.date}/${encodeURIComponent(pending.subjectId)}`,
          linkText: "Follow the session" };
      }
      if (this.recordLoaded && !this.record.length) {
        return { tone: "pending", label: "no takes yet",
          lead: `${name} is ready, and has not filed yet.`,
          body: "It has proved it holds its key, so it can file. No session is collecting right now, which is the swarm's normal resting state: it catches the next window on its own." };
      }
      const last = this.record[0];
      return { tone: "good", label: "voting",
        lead: `${name} is voting.`,
        body: "Nothing is left for you to do. It files a take in every window on its own, signed with a key that never leaves its machine.",
        url: last ? `/swarm/takes/${encodeURIComponent(last.take?.id || "")}` : null,
        linkText: "See the latest take" };
    },
    // Coarse phase for the rich status UI: approved covers approved + claimed.
    statusPhase() {
      const state = this.status?.state;
      if (state === "approved" || state === "claimed") return "approved";
      if (state === "rejected") return "rejected";
      return "pending";
    },
    // This member's filed takes, newest first, from the member-scoped endpoint
    // (#243) the profile page already uses. Best-effort: the record is a
    // courtesy on this page, never a reason to fail it.
    async loadRecord() {
      try {
        const res = await api.get(`${path(ROUTES.swarm.memberTakes, { id: this.id })}?limit=50`);
        this.record = res.takes || [];
        this.recordLoaded = true;
      } catch { /* leave the strip hidden rather than render a wrong zero */ }
    },
    // Three figures that answer "is it working, and does what it files check
    // out". Deliberately NOT an average conviction: high confidence is not
    // correctness, and a conviction figure sitting beside two counts reads as a
    // score for judgement we have no basis to give. That one stays on the
    // profile, next to the takes it summarises.
    // `verifiable` is the denominator, and it is NOT `takes`. Archival takes
    // (v0 pre-launch content, never member-signed) cannot verify by
    // construction, so counting them in the denominator renders a member's
    // whole record as a signature failure — "0 / 50", styled as an alert. Only
    // takes that were actually member-signed can be verified or not.
    recordStats() {
      const verifiable = this.record.filter((r) => !r.take?.archival);
      return {
        takes: this.record.length,
        verifiable: verifiable.length,
        archival: this.record.length - verifiable.length,
        verified: verifiable.filter((r) => r.take?.verified).length,
        lastFiled: this.record[0] ? this.formatDate(this.record[0].sessionDate, "short") : "—",
        last: this.record[0] || null,
      };
    },
    // Live heartbeat. Runs only once approved; reads public data, best-effort.
    //
    // Reads EVERY collecting session, not GET /open-session, which returns a
    // single session while several routinely collect at once (verified live:
    // woon and mav both collecting, open-session naming only woon). The old
    // code could therefore tell an operator "your agent has until the window
    // closes" about a window it had already voted in, while staying silent
    // about the one it had not.
    //
    // It also drops a localStorage cache of the last seen take. That cache
    // existed because the only source was a single session's detail payload, so
    // a second browser saw no history at all; the member-takes endpoint is the
    // real record and needs no shadow copy.
    async checkPulse() {
      if (this.statusPhase() !== "approved") return;
      // Take bodies are large, so the record is not on the 20s beat: once, then
      // every third tick.
      if (!this.recordLoaded || this.pulseTicks++ % 3 === 0) await this.loadRecord();
      try {
        const res = await api.get(`${ROUTES.swarm.sessions}?state=collecting&limit=10`);
        this.openSessions = res.sessions || [];
      } catch { /* best-effort: an unreachable index just means no window shown */ }
    },
    // The first session this member could still file in, or null.
    //
    // `state=collecting` is not the same question as "is the window open".
    // A session stays in `collecting` until the close job runs, so a stack
    // whose worker is idle, paused, or behind keeps advertising sessions whose
    // windowClosesAt is hours in the past — and this panel is the one element
    // on the page that claims to be live. It was telling an operator their
    // agent "has until it closes to read the brief and file its take" about a
    // window that had closed two days earlier. The close time is on the row, so
    // trust that over the state label.
    pendingWindow() {
      const now = Date.now();
      return this.openSessions.find(
        (s) => (!s.windowClosesAt || new Date(s.windowClosesAt).getTime() > now) &&
          !this.record.some((r) => r.sessionDate === s.date && r.subjectId === s.subjectId),
      ) || null;
    },
    memberName() {
      return (this.member && this.member.name) || this.id;
    },
    profileUrl() {
      return `/swarm/members/${encodeURIComponent(this.id)}`;
    },
    recoveryMailto() {
      return `mailto:hi@robotmoney.net?subject=${encodeURIComponent(`Key rotation for swarm member ${this.id}`)}`;
    },
    // The member id is a 36-character UUID that support, the admin surface and
    // the API all key on, so it gets a copy control rather than an invitation
    // to transcribe it by hand.
    async copyId() {
      try {
        await navigator.clipboard.writeText(this.id);
        this.copiedId = true;
        setTimeout(() => { this.copiedId = false; }, 1600);
      } catch { /* clipboard blocked: the id is still selectable text */ }
    },
    // printWelcome() and skillInstallCommand() were removed with the "Give it a
    // mind" section they served. The install command told an already onboarded
    // agent to install the skill it had just used to get here, and the print
    // affordance existed to produce a keepsake of a celebration card that is no
    // longer a separate object on the page.
  }));

  // Public subject profile (/swarm/subjects/:id). The reader-facing
  // counterpart to the admin subject page: what portfolio is under review, what
  // it holds, which wallets are tracked, and every session about it.
  //
  // Both endpoints this needs have been live all along — the session detail page
  // already calls them for its own portfolio block — so this page is markup and
  // shaping over an API that was already answering.
  Alpine.data("subjectProfile", () => ({
    ...helpers,
    loading: true,
    error: null,
    subject: null,
    snapshots: [],
    snapshot: null,
    sessions: [],
    // How many days of history the concentration chart reads. The API returns
    // every snapshot ever taken (311 on the demo stack), and a two-year stack of
    // 1px columns says nothing a reader can act on.
    windowDays: 90,
    // Positions beyond this fold into "other" rather than adding a colour. Seven
    // is the donut list's own cap on the session page; the two must agree or the
    // same book reads as two different shapes across two pages.
    topN: 7,
    async init() {
      const id = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
      // The route this component was mounted on. The fetch below is not
      // cancelled when the router tears the view down, so a slow response would
      // otherwise stamp a subject's name onto whatever page is showing by the
      // time it lands. Same guard memberProfile applies for the same reason.
      const routeAtEntry = location.pathname;
      try {
        this.subject = await api.get(path(ROUTES.swarm.subject, { id })).then(camelSubject)
          .catch(() => loadArchiveSubject(id));
        if (!this.subject) throw new Error("Subject not found");
        // Route-level SEO titleizes the last URL segment, which for a slug like
        // "robotmoney-allocation" reads "Robotmoney Allocation". Name the tab
        // after the subject once we know what it is actually called.
        if (this.subject?.name && location.pathname === routeAtEntry) {
          document.title = `${this.subject.name}: Robot Money Investment Swarm`;
        }
        // Each side-fetch is guarded on its own: a subject with no snapshot yet
        // still has sessions worth reading, and vice versa.
        this.snapshots = await this.loadSnapshots(id);
        this.snapshot = this.snapshots.length ? normalizeSnapshot(this.snapshots[this.snapshots.length - 1]) : null;
        this.sessions = await this.loadSessions(id);
      } catch (e) {
        this.error = e.message || "Subject not found";
      } finally {
        this.loading = false;
      }
    },
    async loadSnapshots(id) {
      try {
        const res = await api.get(path(ROUTES.swarm.subjectSnapshots, { id }));
        const list = (Array.isArray(res) ? res : res.snapshots || []).filter(Boolean);
        if (list.length) return list.slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
      } catch (_) { /* fall through to the archive */ }
      return this.archiveSnapshots(id);
    },
    // Static-archive fallback, the same path every other swarm surface has.
    // Without it this page renders a subject with an empty chart and a dashed
    // book value whenever the API is unreachable — and the shipped archive holds
    // 28-30 real daily snapshots per subject, which is a better answer than a
    // blank panel. There is no snapshot index file, so the dates come from the
    // session index: those are the days the swarm actually read this book.
    async archiveSnapshots(id) {
      let dates = [];
      try {
        const index = await fetchJson("/data/swarm/sessions/index.json");
        dates = (index.sessions || [])
          .filter((s) => (s.subjectId ?? s.subject_id) === id)
          .map((s) => s.date)
          .filter(Boolean)
          .sort();
      } catch (_) {
        return [];
      }
      const snaps = await Promise.all(dates.map((d) => loadArchiveSnapshot(id, d)));
      return snaps.filter(Boolean);
    },
    // Sessions carry their synthesis only on the detail endpoint, so the list is
    // filtered to this subject first and only the visible page of it is expanded.
    // Same shape as memberProfile.scanSessions: guarded per session, with the
    // shipped static archive behind it for dates that predate the live API.
    async loadSessions(id) {
      const pick = (list) => list
        .filter((s) => (s.subjectId ?? s.subject_id) === id && s.state === "published")
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
        .slice(0, 20)
        // `id` is carried through because it is now the ONLY unique handle on a
        // session: a subject may convene more than once a day, so the template
        // cannot key rows on (date, subjectId) without colliding — and a
        // duplicate key makes Alpine render the whole list as nothing. The
        // static archive has no ids, so fall back to the old composite there.
        .map((s) => ({
          id: s.id ?? `${s.date}-${s.subjectId ?? s.subject_id}`,
          date: s.date,
          subjectId: s.subjectId ?? s.subject_id,
          subjectName: s.subjectName ?? s.subject_name,
        }));
      let index = [];
      try {
        index = pick((await api.get(ROUTES.swarm.sessions)).sessions || []);
      } catch (_) { /* fall through to the archive */ }
      // Same archive fallback the snapshots take. index.json is snake_case while
      // the API is camelCase, so pick() reads both rather than silently matching
      // nothing and rendering "no published session yet" over a full archive.
      if (!index.length) {
        try {
          index = pick((await fetchJson("/data/swarm/sessions/index.json")).sessions || []);
        } catch (_) {
          return [];
        }
      }
      return Promise.all(index.map(async (s) => {
        try {
          const detail = await api.get(path(ROUTES.swarm.session, { date: s.date, subject: s.subjectId }));
          return { ...s, synthesis: camelSession(detail.session || detail).synthesis, takes: (detail.takes || []).length };
        } catch (_) {
          if (archivePreferred(s.date)) {
            try {
              const archive = await loadArchiveSession(s.date, s.subjectId);
              return { ...s, synthesis: archive.session?.synthesis || "", takes: (archive.takes || []).length };
            } catch (_) { /* fall through */ }
          }
          return { ...s, synthesis: "", takes: 0 };
        }
      }));
    },
    // One sentence saying what this page is. It replaced a three-figure stat
    // strip whose "top position" was the fourth place the same holding appeared,
    // and which never told a reader what a "subject" actually is.
    summaryLine() {
      const worth = this.snapshot ? `It holds ${this.fmtUsd(this.snapshot.totalValueUsd)} today` : null;
      const n = this.sessions.length;
      const oldest = n ? this.sessions[n - 1].date : null;
      const since = oldest ? this.formatDate(oldest, "long").replace(/\s*\d{1,2},\s*/, " ") : null;
      const reviewed = !n
        ? "The swarm has not reviewed it yet"
        : `the swarm has reviewed it ${n === 1 ? "once" : n + " times"}${since ? " since " + since : ""}`;
      const parts = ["This is a portfolio the Robot Money Investment Swarm reviews."];
      parts.push(worth ? `${worth} and ${reviewed}.` : `${reviewed[0].toUpperCase()}${reviewed.slice(1)}.`);
      return parts.join(" ");
    },
    positionRows() {
      const total = this.snapshot?.totalValueUsd || 0;
      return (this.snapshot?.positions || [])
        .map((p) => ({ ...p, share: total > 0 ? p.value_usd / total : 0 }))
        .sort((a, b) => b.share - a.share);
    },
    // The chart draws one band per top token; the holdings table and the legend
    // repeat that colour beside the token. Keyed by TOKEN via assetDot(), which
    // is the same map /allocation's pies and the wallet tables read — so WETH is
    // sand on this page AND everywhere else on the site.
    //
    // This used to index a local palette by the token's RANK, which meant a
    // colour said "second-biggest today" rather than "WETH": the same holding
    // drew sand here and teal on /allocation, and both colours moved the moment
    // two positions swapped places.
    seriesColor(token) {
      if (token === OTHER_TOKEN) return OTHER_COLOR;
      return this.chartColors()[token] || assetDot(token);
    },
    // assetDot() hashes any symbol it does not name explicitly into CATEGORICAL,
    // so two unmapped tokens in one book can legitimately land on the same hue —
    // and two same-coloured bands in a stack are indistinguishable from one band
    // of their combined height, which is a chart that lies. Resolve per figure.
    //
    // NAMED tokens claim first. Resolving in stack order instead let WOON, whose
    // hash happens to land on cyan, take cyan on a book that also holds
    // ROBOTMONEY — which actually OWNS cyan — and pushed ROBOTMONEY onto sand, a
    // colour it means nothing in. Ownership beats rank: a token the palette
    // names keeps its colour, and the hashed ones fill in around it.
    //
    // The cost is that a hashed token's colour depends on which other tokens
    // share its figure, so WOON can be sand here and cyan elsewhere. That is the
    // right trade: an unmapped symbol has no identity to protect, and within one
    // figure being TELLABLE APART beats being globally stable.
    chartColors() {
      const tokens = this.chartTokens();
      const out = {};
      const used = new Set([OTHER_COLOR]);
      for (const token of tokens) {
        const owned = ASSET_DOT[token];
        if (owned && !used.has(owned)) {
          out[token] = owned;
          used.add(owned);
        }
      }
      // Slate is withheld from the fallback pool: the covenant spends it on
      // muted references and baselines, and a 36%-of-NAV holding is not a
      // reference — drawn slate it reads as the leftovers bucket. Only a book
      // deep enough to exhaust every other hue falls back to it.
      const pool = CATEGORICAL.filter((hue) => hue !== SERIES.slate);
      for (const token of tokens) {
        if (out[token]) continue;
        const hashed = assetDot(token);
        const free = hashed !== SERIES.slate && !used.has(hashed);
        const color = free
          ? hashed
          : (pool.find((hue) => !used.has(hue)) || CATEGORICAL.find((hue) => !used.has(hue)) || hashed);
        out[token] = color;
        used.add(color);
      }
      return out;
    },
    // The snapshots inside the chart window, oldest first.
    //
    // Calendar days, not readings. This was `slice(-windowDays)`, which cut the
    // last N SNAPSHOTS — and on the archive path a snapshot is one per session,
    // not one per day, so "90 days" could reach back two years while the panel
    // said 9 readings. Fall back to the old cut only if the dates are unusable,
    // and never return fewer than the two points a series needs.
    windowed() {
      const all = this.snapshots;
      if (all.length < 2) return all;
      const day = (s) => Date.parse(`${s?.date}T00:00:00Z`);
      const last = day(all[all.length - 1]);
      if (!Number.isFinite(last)) return all.slice(-this.windowDays);
      const floor = last - this.windowDays * 86400000;
      const within = all.filter((s) => {
        const t = day(s);
        return !Number.isFinite(t) || t >= floor;
      });
      return within.length >= 2 ? within : all.slice(-2);
    },
    // Which tokens get their own band. Ranked by share on the most recent day, so
    // the legend and the newest column of the chart always agree.
    topTokens() {
      return this.positionRows().slice(0, this.topN).map((p) => p.token);
    },
    // A position's share of NAV on one snapshot. Reads both the API's camelCase
    // and the archive's snake_case total.
    shareOf(snap, token) {
      const total = Number(snap?.total_value_usd ?? snap?.totalValueUsd ?? 0);
      if (!(total > 0)) return 0;
      const hit = (snap?.positions || []).find((p) => p.token === token);
      return hit ? Number(hit.value_usd || 0) / total : 0;
    },
    // The tokens that actually earn a band. A holding that never reaches 1% of
    // NAV anywhere in the window draws a sub-pixel sliver no reader can see, but
    // still spends a hue and a legend row — so it belongs in the residual.
    chartTokens() {
      const rows = this.windowed();
      if (rows.length < 2) return [];
      return this.topTokens().filter((t) => rows.some((r) => this.shareOf(r, t) >= 0.01));
    },
    // Bands bottom-to-top, largest first, plus the residual. Stacking to a fixed
    // 100% is the point of the panel: the reader's question is what fraction of
    // the book one position has become, and a stack answers it by area without
    // any cross-referencing. The largest position sits on the BOTTOM because
    // only the bottom band has a flat baseline — every band above it is sheared
    // by the ones below, so the position that matters most gets the honest edge.
    concentrationSeries() {
      const rows = this.windowed();
      const tokens = this.chartTokens();
      if (rows.length < 2 || !tokens.length) return [];
      const colors = this.chartColors();
      const bands = tokens.map((token) => ({
        token,
        color: colors[token] || assetDot(token),
        shares: rows.map((r) => this.shareOf(r, token)),
      }));
      // Everything the bands do not cover: the tail below the top-N, the sub-1%
      // holdings folded out above, and any NAV the position list misses. Adding
      // it is what lets the stack total 100% honestly rather than quietly
      // dropping the remainder the way the old line chart did.
      const other = rows.map((_, i) => {
        const covered = bands.reduce((sum, b) => sum + b.shares[i], 0);
        return Math.max(0, 1 - covered);
      });
      // Rounding leaves a few basis points of residue on a book that is fully
      // accounted for; a permanent 0% legend row is noise, so only carry the
      // band when it is genuinely something.
      if (other.some((v) => v > 0.005)) {
        bands.push({ token: OTHER_TOKEN, color: OTHER_COLOR, shares: other });
      }
      return bands;
    },
    // The legend: swatch, token, and its share on the most recent reading. The
    // panel previously shipped no legend at all, so six unlabelled lines could
    // only be decoded against a 14px rule in the table further down the page.
    concentrationLegend() {
      const series = this.concentrationSeries();
      if (!series.length) return [];
      return series.map((b) => ({
        token: b.token,
        color: b.color,
        pct: this.fmtPct1(b.shares[b.shares.length - 1] || 0),
      })).reverse(); // top band first, so the legend reads down the stack
    },
    // "readings", not "days": the archive path carries one snapshot per session
    // rather than one per calendar day, so eight points can span a month. Naming
    // them days would misdescribe the x-axis.
    spanLabel() {
      const w = this.windowed();
      if (w.length < 2) return "";
      return `${w[0].date} → ${w[w.length - 1].date} · ${w.length} readings`;
    },
    // Share-of-NAV over time, one stacked BAND per position. A holdings table is
    // a single day; the question a reader has is whether the book is
    // concentrating or diversifying, and only a series answers that.
    //
    // Bands rather than lines. Lines were tried first and failed on real books
    // in two ways a legend cannot fix: positions at equal weight draw exactly on
    // top of each other (the vault subject holds MORPHO/AAVE/COMPOUND at 33.3%
    // each and rendered as ONE line), and the long tail of sub-5% holdings piles
    // into an unreadable tangle along the axis. Stacked to a fixed 100%, share
    // is read as area — equal weights are three equal bands, and "is one
    // position taking over" is the bottom band's height, no decoding required.
    //
    // This does put cyan on screen as a mass where the brand grammar wants it as
    // a line, on any book whose largest holding happens to be ROBOTMONEY.
    // David's explicit call: legibility of the part-to-whole read wins here, and
    // this panel now matches what robotmoney.net has always published.
    concentrationArea() {
      const rows = this.windowed();
      const series = this.concentrationSeries();
      if (rows.length < 2 || !series.length) return "";
      const W = 640, H = 150, padB = 16, padT = 4, padL = 28;
      const plotH = H - padB - padT;
      const y = (frac) => padT + plotH - this.clampPct(frac * 100) / 100 * plotH;
      // x by DATE, not by index. The archive path carries one reading per
      // session rather than one per day, so evenly-spaced points drew a
      // three-week gap the same width as a one-day one and made a stale book
      // look continuously observed. Index spacing stays as the fallback for
      // snapshots whose dates will not parse.
      const stamps = rows.map((r) => Date.parse(`${r?.date}T00:00:00Z`));
      const dated = stamps.every((t) => Number.isFinite(t)) && stamps[stamps.length - 1] > stamps[0];
      const plotW = W - padL;
      const span = dated ? stamps[stamps.length - 1] - stamps[0] : 0;
      const xs = rows.map((_, i) => (dated
        ? padL + plotW * ((stamps[i] - stamps[0]) / span)
        : padL + plotW * (i / (rows.length - 1))));
      // Bands are drawn bottom-up over a running baseline. Each polygon runs
      // along its own top edge left-to-right, then back along the baseline
      // beneath it — so the band's height at any x IS that position's share.
      const base = rows.map(() => 0);
      const bands = series.map((b) => {
        const top = base.map((v, i) => v + b.shares[i]);
        const upper = top.map((v, i) => `${xs[i].toFixed(2)},${y(v).toFixed(2)}`);
        const lower = base.map((v, i) => `${xs[i].toFixed(2)},${y(v).toFixed(2)}`).reverse();
        for (let i = 0; i < base.length; i++) base[i] = top[i];
        // A hairline in the page ground separates neighbours, so two adjacent
        // hues of similar value still read as two bands rather than one blur.
        return `<polygon points="${upper.concat(lower).join(" ")}" fill="${b.color}"
          stroke="var(--color-deep)" stroke-width="1" stroke-linejoin="round"/>`;
      }).join("");
      // Drawn ON TOP of the fills, and in a light wash rather than the dim slate
      // a gridline takes on an empty ground — over a saturated band, slate is
      // invisible. 50% is the line a single position crosses when it becomes the
      // majority of the book, which is the one threshold this panel exists to
      // show. 0 and 100 need no label: the stack fills the frame by construction.
      const mid = `<line x1="${padL}" y1="${y(0.5).toFixed(1)}" x2="${W}" y2="${y(0.5).toFixed(1)}"
          stroke="rgba(255,255,255,0.32)" stroke-width="1" stroke-dasharray="3 4"/>
        <text x="0" y="${(y(0.5) + 3).toFixed(1)}" fill="var(--color-text-dim)" font-size="8.5" font-family="ui-monospace,monospace">50%</text>`;
      const axis = `<line x1="${padL}" y1="${padT + plotH}" x2="${W}" y2="${padT + plotH}" stroke="var(--color-border)" stroke-width="1"/>`;
      const ends = `<text x="${padL}" y="${H - 3}" fill="var(--color-text-dim)" font-size="9" font-family="ui-monospace,monospace">${this.escapeHtml(rows[0].date || "")}</text>
        <text x="${W}" y="${H - 3}" text-anchor="end" fill="var(--color-text-dim)" font-size="9" font-family="ui-monospace,monospace">${this.escapeHtml(rows[rows.length - 1].date || "")}</text>`;
      // The legend is HTML beside the figure, so the accessible name here spells
      // out what the bands are for a reader who gets only the image.
      const named = series.map((b) => `${b.token} ${this.fmtPct1(b.shares[b.shares.length - 1] || 0)}`).reverse().join(", ");
      return `<svg viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Top positions as a share of net asset value, stacked to 100%, ${this.escapeHtml(rows[0].date || "")} to ${this.escapeHtml(rows[rows.length - 1].date || "")}. Latest reading, largest first: ${this.escapeHtml(named)}.">
        ${bands}${mid}${axis}${ends}</svg>`;
    },
    // Wallets come off the subject manifest where the operator declared them, and
    // off the latest snapshot where the indexer actually read them. Prefer the
    // manifest, fall back to the snapshot, and de-duplicate by address.
    trackedWallets() {
      const raw = (this.subject?.wallets?.length ? this.subject.wallets : this.snapshot?.wallets) || [];
      const seen = new Set();
      return raw.filter(Boolean).map((w) => ({
        label: w.label || w.name || "",
        chain: w.chain || "",
        address: w.address || w.addr || "",
      })).filter((w) => {
        const key = `${w.chain}:${w.address}`.toLowerCase();
        if (!w.address || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    nftContracts() {
      return (this.subject?.nftContracts || []).filter(Boolean).map((n) => ({
        name: n.name || n.label || String(n.address || "").slice(0, 10),
        chain: n.chain || "",
      }));
    },
    structuralNotes() {
      return structuralNotesOf(this.subject);
    },
    takeCountLabel(s) {
      const n = Number(s?.takes || 0);
      return n === 1 ? "1 take" : `${n} takes`;
    },
    truncAddress(addr) {
      const a = String(addr || "");
      return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
    },
    hostOf(url) {
      try { return new URL(url).host.replace(/^www\./, ""); } catch (_) { return String(url || ""); }
    },
  }));

  Alpine.data("memberProfile", () => ({
    ...helpers,
    loading: true,
    error: null,
    member: null,
    rows: [],
    subject: null,   // active session filter; null = every subject
    openTakes: {},   // take id → expanded
    async init() {
      const memberId = location.pathname.split("/").filter(Boolean).pop();
      // The route this init is answering. Everything below runs after an await,
      // and the router does not cancel a superseded view's in-flight work, so
      // the corrections at the end have to know whether they are still relevant.
      const routeAtEntry = location.pathname;
      try {
        // LIVE FIRST, archive only as the fallback (issue #595) — the same
        // precedence subjectProfile.init() above and swarmSessionDetail below
        // already use, and for the same reason: the static manifests under
        // /data/swarm/manifests/members are a backendless checkout's fallback,
        // never a competing source of truth for a record the database holds.
        //
        // Reading the archive first meant a RENAMED member served two
        // contradictory public profiles: /swarm/members/<handle> missed the
        // archive and rendered the live row, while /swarm/members/<legacy-id>
        // HIT one of the four shipped manifests (athena, robotmoney,
        // noop-analyst, woon — two of them live seated members) and rendered
        // the pre-rename name/tagline forever, with no `handle` field at all.
        // Both returned 200, so nothing alerted. Migration 0030 keeps the
        // legacy id resolving on purpose ("no URL that has ever been published
        // stops working"), which makes that address a first-class public one
        // and its staleness a stated-requirement gap, not a cosmetic lag.
        //
        // The backendless path costs no NEW class of request here: loadRows()
        // on the very next line already calls the member-takes endpoint
        // unconditionally, so a checkout with no backend was always going to
        // issue (and lose) a swarm API call on this page.
        this.member = await api.get(path(ROUTES.swarm.member, { id: memberId })).then(camelMember)
          .catch(() => loadArchiveMember(memberId).catch(() => null));
        // Both sources missed. Raise it rather than falling through to a blank
        // page: the old ordering surfaced the API's own error here, and
        // subjectProfile.init() throws the same way for the same reason.
        if (!this.member) throw new Error("Member not found");
        // Both corrections below name this page after the record rather than
        // after the URL, and both are skipped if the visitor has already moved
        // on: the fetch above is not cancelled when the router tears this view
        // down, so a slow response would otherwise stamp a member's identity
        // onto whatever route is showing by the time it lands.
        if (location.pathname === routeAtEntry) {
          // Route-level SEO titleizes the last URL segment, which here is a raw
          // UUID ("D6e430f5 D706 4325…"). This is the page onboarding hands a new
          // operator, so name the tab after the member once it is known.
          if (this.member?.name) document.title = `${this.member.name}: Robot Money Investment Swarm`;
          // Same correction, for the address rather than the tab. This profile
          // answers on BOTH /swarm/members/<handle> and /swarm/members/<id> —
          // migration 0030 keeps every published id resolving on purpose — so the
          // page is two URLs and, left alone, two indexable duplicates. Now that
          // the record is in hand, name the handle form as the canonical one.
          //
          // Guarded on `handle` too: it is undefined for a member served from the
          // static archive manifests (see camelMember above), and there the
          // visited URL stays canonical, which is what the archive links to.
          if (this.member?.handle) {
            setCanonicalUrl(canonicalUrlFor(`/swarm/members/${this.member.handle}`), routeAtEntry);
          }
        }
        this.rows = await this.loadRows(memberId);
      } catch (e) {
        this.error = e.message || "Member not found";
      } finally {
        this.loading = false;
      }
    },
    // This member's record, from the member-scoped takes endpoint (#243): one
    // request that returns every take they have filed, newest first.
    //
    // The page used to rebuild the record by fetching the sessions index and
    // scanning each session for a matching take. That index is capped at the 20
    // most recent sessions, so any member whose takes had scrolled past that
    // window read "Track record (0)" on their own profile while the API held a
    // full history — and it cost 21 requests to get the wrong answer.
    async loadRows(memberId) {
      try {
        const res = await api.get(`${path(ROUTES.swarm.memberTakes, { id: memberId })}?limit=50`);
        return (res.takes || []).map((r) => ({
          session: { date: r.sessionDate, subjectId: r.subjectId, subjectName: r.subjectName, state: r.sessionState },
          // camelTake, not the raw row: raw takes carry no `permalinkId`, only
          // `id`/`member_id`, so takeHref() silently returned null for every
          // take on this page and the "Verification receipt" link vanished.
          take: camelTake(r.take),
          phase: this.takePhase(r.sessionState),
        }));
      } catch (_) {
        return this.scanSessions();
      }
    },
    // Fallback for hosts without the member-takes endpoint, and the path that
    // still serves the shipped static archive for sessions through
    // ARCHIVE_LAST_DATE (the boundary is derived from that constant, not from a
    // second hardcoded date).
    // Prioritises in-progress sessions by STATE, not date position: a
    // just-submitted take lives in a collecting session, and a manually-opened
    // window can sit deep in a date-ordered list, so a naive slice would drop it
    // and the page would read "no sessions yet" right after a verified submit.
    async scanSessions() {
      const all = (await api.get(ROUTES.swarm.sessions)).sessions || [];
      const inProgress = all.filter((s) => ["collecting", "window_closed", "aggregated"].includes(s.state));
      const published = all.filter((s) => s.state === "published").slice(0, 20);
      const details = await Promise.all([...inProgress, ...published].map(async (s) => {
        try {
          const detail = await api.get(path(ROUTES.swarm.session, { date: s.date, subject: s.subjectId }));
          return { ...s, takes: detail.takes || [] };
        } catch (_) {
          if (archivePreferred(s.date)) {
            try {
              const archive = await loadArchiveSession(s.date, s.subjectId);
              return { ...s, takes: archive.takes || [] };
            } catch (_) { /* fall through to empty */ }
          }
          return { ...s, takes: [] };
        }
      }));
      return details
        .map((session) => {
          // camelTake before matching: this is the fallback path for the
          // static archive (dates through ARCHIVE_LAST_DATE), whose takes are
          // snake_case and carry no `permalinkId` until camelTake derives one
          // from a real take `id` (never from `member_id`). loadArchiveSession
          // has already stamped `archival` on the ones it served.
          const take = (session.takes || []).map(camelTake).find((t) => t.memberId === this.member?.id);
          return take ? { session, take, phase: this.takePhase(session.state) } : null;
        })
        .filter(Boolean);
    },
    takePhase(state) {
      if (state === "collecting") return "live";
      if (state === "window_closed" || state === "aggregated") return "closing";
      return "published";
    },
    phaseLabel(phase) {
      return phase === "live" ? "Collecting · window open"
        : phase === "closing" ? "Closed · awaiting publish"
        : "Published";
    },
    allTakes() { return this.member ? this.rows : []; },
    // The record at a glance. Counts every take, published or still collecting,
    // so a just-submitted one registers immediately rather than reading as zero
    // while its window is open. Conviction is the mean confidence across them.
    // `verifiable` excludes archival takes for the same reason as the apply
    // page's stat strip: v0's pre-launch takes were never member-signed, so
    // they are not failed verifications and must not sit in the denominator.
    // A member whose record is entirely archive read "Verified 0".
    recordStats() {
      const all = this.allTakes();
      const conf = all.map((r) => Number(r.take.confidence)).filter((n) => Number.isFinite(n));
      const verifiable = all.filter((r) => !r.take.archival);
      return {
        takes: all.length,
        verifiable: verifiable.length,
        archival: all.length - verifiable.length,
        verified: verifiable.filter((r) => r.take.verified).length,
        conviction: conf.length ? this.fmtPct(conf.reduce((a, b) => a + b, 0) / conf.length) : "—",
      };
    },
    // Takes in sessions that haven't published yet — the current, live activity.
    inProgressTakes() { return this.allTakes().filter((r) => r.phase !== "published"); },
    // The published track record (what "Recent takes" has always meant).
    recentTakes() { return this.allTakes().filter((r) => r.phase === "published"); },

    // ── Session filter ───────────────────────────────────────────────────────
    // A member files against several subjects, and the list interleaves them by
    // date. Reading "how has this member treated Mav Holdings" meant scanning
    // every card, so the subjects become filter chips.
    subjects() {
      const by = new Map();
      for (const r of this.recentTakes()) {
        const cur = by.get(r.session.subjectId);
        if (cur) cur.count += 1;
        else by.set(r.session.subjectId, { id: r.session.subjectId, name: r.session.subjectName || r.session.subjectId, count: 1 });
      }
      return [...by.values()].sort((a, b) => b.count - a.count);
    },
    // The rows actually listed. Kept separate from recentTakes() so the empty
    // states stay keyed to the whole record: a filter that matches nothing is a
    // narrowed view, not a member who has never submitted.
    visibleTakes() {
      const rows = this.recentTakes();
      return this.subject ? rows.filter((r) => r.session.subjectId === this.subject) : rows;
    },
    filterBy(subjectId) { this.subject = this.subject === subjectId ? null : subjectId; },

    // ── Take body collapse ───────────────────────────────────────────────────
    // Bodies run to several hundred words across three sections. Collapsed by
    // default so the record can be scanned; the toggle only appears when there
    // is genuinely more to see, so short takes get no pointless control.
    expandable(body) { return String(body || "").length > 320; },
    isOpen(id) { return !!this.openTakes[id]; },
    toggleTake(id) { this.openTakes = { ...this.openTakes, [id]: !this.openTakes[id] }; },
  }));

  Alpine.data("swarmSessionDetail", () => ({
    ...helpers,
    loading: true,
    error: null,
    source: null,
    session: null,
    subject: null,
    snapshot: null,
    // Published bucket targets; null until loadApi() resolves them, and on
    // the archive fallback, where the framework is not available.
    allocation: null,
    // The published framework manifest: per-bucket targets and, crucially, the
    // token→bucket map that makes "actual" computable. See bucketActuals().
    allocationFramework: null,
    brief: null,
    takes: [],
    members: [],
    async init() {
      // TWO addressing forms reach this view:
      //   /swarm/sessions/<uuid>  — one exact session, the only form that can
      //                                 reach an earlier session of a day on which
      //                                 the subject convened more than once.
      //   /swarm/<date>/<subject> — the latest session that day. Kept because
      //                                 every published link, the prerenderer and
      //                                 the static archive use it.
      // The id form resolves first and then continues down the SAME path as the
      // dated form, using the date/subject the server reported, so the subject,
      // snapshot, brief and archive fallbacks all behave identically.
      const byId = location.pathname.match(
        /^\/swarm\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i,
      );
      if (byId) {
        try {
          const detail = await api.get(path(ROUTES.swarm.sessionById, { id: byId[1] }));
          const s = camelSession(detail.session);
          await this.loadApi(s.date, s.subjectId, detail);
        } catch (_) {
          this.error = "Session not found";
        } finally {
          this.loading = false;
        }
        return;
      }
      const match = location.pathname.match(/^\/swarm\/(\d{4}-\d{2}-\d{2})\/([^/]+)/);
      if (!match) {
        this.error = "Session not found";
        this.loading = false;
        return;
      }
      const [, date, subject] = match;
      try {
        // API FIRST, for every date — matching what the two list views above
        // (loadSessionsWithSynthesis, the member/subject feeds) have always
        // done. This view used to prefer the static archive for dates it
        // covered, which meant the same session could be read from two
        // different sources: the feed showed the database's copy while the
        // page showed the checked-in copy. Now that v0's full history lives
        // in the database, the archive is a FALLBACK for checkouts with no
        // backend, not a competing source of truth for old dates.
        await this.loadApi(date, subject);
      } catch (primary) {
        try {
          // Fall back to the static archive. It only carries dates through
          // ARCHIVE_LAST_DATE, so archivePreferred() is what decides whether
          // falling back is even worth attempting.
          if (!archivePreferred(date)) throw primary;
          await this.loadArchive(date, subject);
        } catch (_) {
          this.error = `Session not found for ${date}/${subject}. This checkout's reference archive currently has Woon sessions through ${ARCHIVE_LAST_DATE}.`;
        }
      } finally {
        this.loading = false;
      }
    },
    async loadArchive(date, subject) {
      const detail = await loadArchiveSession(date, subject);
      this.source = "archive";
      this.session = detail.session;
      this.takes = detail.takes;
      this.subject = await loadArchiveSubject(subject).catch(() => null);
      this.snapshot = await loadArchiveSnapshot(subject, date);
      const ids = [...new Set([...this.takes.map((t) => t.memberId), ...KNOWN_ARCHIVE_MEMBERS])];
      const members = await Promise.all(ids.map((id) => loadArchiveMember(id).catch(() => null)));
      this.members = members.filter(Boolean);
      this.brief = await fetchJson(`/data/swarm/briefs/${date}-${subject}.json`).catch(() => null);
      // The archive path set no allocation at all, so a bucket_weights session
      // read from a backendless checkout drew Recommended alone — no target to
      // compare it against and no way to see whether it deviated. Same fallback
      // shape as every other archive load: guarded, never fatal.
      this.allocationFramework = await loadAllocationFramework();
    },
    // `preloaded` is the already-fetched session when the caller resolved it by
    // id; without it this fetches the latest session for (date, subject) exactly
    // as before. Everything after the fetch is shared, so the two addressing
    // forms cannot drift into rendering different pages.
    async loadApi(date, subject, preloaded = null) {
      // Fetch subject + snapshots alongside the session so the live/API path
      // renders the SAME reference experience as the archive path (charts +
      // portfolio). Each side-fetch is independently guarded so a missing
      // subject/snapshot never breaks the takes/session render.
      const [detail, memberData, brief, subjectData, snapshotData, allocation, framework] = await Promise.all([
        preloaded ?? api.get(path(ROUTES.swarm.session, { date, subject })),
        api.get(ROUTES.swarm.members),
        api.get(ROUTES.swarm.brief, { date, subject }).catch(() => null),
        api.get(path(ROUTES.swarm.subject, { id: subject })).catch(() => null),
        api.get(path(ROUTES.swarm.subjectSnapshots, { id: subject })).catch(() => null),
        // The allocation framework supplies the TARGET weight each bucket is
        // measured against. Without it the bucket chart could only draw
        // "Recommended", so a session that proposed 97/3 against a 95/5 target
        // rendered as two bars with nothing to compare them to — the reader
        // could not see that it deviated at all. Guarded like the other
        // side-fetches: a missing framework degrades the chart, never the page.
        api.get(ROUTES.dashboards.allocation).catch(() => null),
        // The published framework manifest, for the two things the dashboard
        // endpoint does not carry: which TOKENS belong to each bucket (without
        // which "actual" cannot be computed at all) and the per-bucket target as
        // a fallback when the dashboard is unreachable.
        loadAllocationFramework(),
      ]);
      this.source = "api";
      this.session = camelSession(detail.session);
      this.takes = (detail.takes || []).map(camelTake);
      this.members = (memberData.members || []).map(camelMember);
      this.subject = subjectData ? camelSubject(subjectData) : null;
      this.snapshot = pickSnapshotFor(snapshotData?.snapshots, date);
      this.brief = brief;
      this.allocation = allocation;
      this.allocationFramework = framework;
    },
    memberLens(memberId) {
      return this.memberById(memberId)?.lens || "swarm member";
    },
    // Accepts EITHER name (issue #593). A session payload carries the immutable
    // `memberId` its takes were signed under, while the roster this page also
    // holds carries the public `handle`; the two are the same string for every
    // member nobody has renamed, and this lookup has to keep resolving for the
    // ones who have been.
    memberById(memberId) {
      return this.members.find((m) => m.id === memberId || m.handle === memberId) || null;
    },
    // THE PUBLIC HANDLE FOR A MEMBER REFERENCE, from either source this page
    // already holds (issue #598). The roster is only the ACTIVE roster —
    // GET /api/swarm/members filters `status = 'active'`
    // (backend/src/swarm/domain.ts) — so a member deactivated after a rename is
    // simply not in `this.members`, and every reference resolved through the
    // roster alone fell back to the signed id. The takes on this same page each
    // carry their own author's `member_handle` (domain.ts withTakes joins
    // swarm_members with NO status filter, so a deactivated author keeps it), so
    // the page holds the public address of every member who submitted here even
    // when the roster does not. Consulting both is what stops one page from
    // publishing two different addresses for one member: the take byline read
    // the take, the disagreement panel read the roster, and after a
    // rename-then-deactivate they disagreed.
    //
    // Returns null when neither source knows the reference — the caller decides
    // what to fall back to.
    memberHandleOf(memberId) {
      const rosterHandle = this.memberById(memberId)?.handle;
      if (rosterHandle) return rosterHandle;
      const take = (this.takes || []).find((t) => t.memberId === memberId || t.memberHandle === memberId);
      return take?.memberHandle || null;
    },
    // Where to LINK for a member reference, preferring the public handle and
    // falling back to whatever the payload carried when neither the roster nor
    // this session's takes hold a handle for it — a link to a legacy id still
    // resolves server-side (domain.ts resolveMemberRow matches handle OR id).
    // That fallback is what the shipped static archive takes when read from a
    // backendless checkout: those rows predate the `handle` column entirely.
    memberHref(memberId) {
      return `/swarm/members/${encodeURIComponent(this.memberHandleOf(memberId) || memberId)}`;
    },
    // `absent` is a list of member IDs, printed raw — a reader got
    // "absent: draco, 88efd6b9-e865-417d-afe1-45d84510338b". Resolve what we
    // can; an id we hold no member record for still prints, because silently
    // dropping it would understate who missed the session.
    absentNames() {
      return (this.session?.swarmRecommendation?.absent || [])
        .map((id) => this.memberById(id)?.name || id);
    },
    // Stance distribution, largest first, with each share of the submitted
    // takes — the proportional bar and the key both read from this so they can
    // never disagree.
    stanceSpread() {
      const stances = this.session?.swarmRecommendation?.stances || {};
      const total = Object.values(stances).reduce((sum, n) => sum + Number(n || 0), 0);
      return Object.entries(stances)
        .map(([stance, n]) => ({ stance, n: Number(n), pct: total ? (Number(n) / total) * 100 : 0 }))
        .sort((a, b) => b.n - a.n || a.stance.localeCompare(b.stance));
    },
    // The recommendation block used to lead with turnout ("3/5", set in the
    // largest type on the page) and leave the reader to tally the stance chips
    // themselves. Turnout is procedural; the finding is the modal stance — or,
    // when nothing outpolls anything else, that there ISN'T one. A split is a
    // real swarm result and this page stated it nowhere.
    verdict() {
      const rows = this.stanceSpread();
      if (!rows.length) return { label: "No stances recorded", detail: "", color: "#7e889e", split: true };
      const submitted = rows.reduce((sum, r) => sum + r.n, 0);
      const tied = rows.filter((r) => r.n === rows[0].n);
      if (tied.length > 1) {
        return {
          label: "Split · no majority",
          detail: `${tied.map((r) => r.stance).join(", ")} tied at ${rows[0].n} member${rows[0].n === 1 ? "" : "s"} each.`,
          color: "#7e889e",
          split: true,
        };
      }
      return {
        label: rows[0].stance,
        detail: `${rows[0].n} of ${submitted} submitted take${submitted === 1 ? "" : "s"} took this position.`,
        color: this.stanceColor(rows[0].stance),
        split: false,
      };
    },
    quorumText() {
      const q = this.session?.swarmRecommendation?.quorum;
      const submitted = q?.submitted ?? this.takes.length;
      const active = q?.active ?? this.members.length;
      return `${submitted} of ${active} submitted`;
    },
    // The Brief panel rendered "Subject: {name}. Regime: {label}." — the <h1>
    // and a backdrop chip, restated in a half-width panel that was otherwise
    // empty. Only the part a reader has not already seen earns the space.
    briefExtra() {
      const body = this.brief?.body || this.brief;
      const n = Array.isArray(body?.researchSignals) ? body.researchSignals.length : 0;
      return n ? `${n} research signal${n === 1 ? "" : "s"} were attached to the brief members received.` : "";
    },
    panelInputs() {
      const r = this.session?.regimeSummary;
      if (!r) return [];
      return [
        ["macro", r.macroPercentile, r.macroRegime],
        ["onchain", r.onchainPercentile, r.onchainRegime],
        ["factor", r.factorPercentile, r.factorRegime],
      ].filter(([, pct]) => typeof pct === "number").map(([label, pct, regime]) => ({ label, pct, regime }));
    },
    // Panels reading the opposite way from the composite. This is the single
    // most-argued fact on a session page — the 2026-06-19 vault synthesis opens
    // on "on-chain at the 10th percentile dissents from a 71st-percentile
    // composite" — and the panel drew three bars that left the reader to notice
    // it. risk_on vs risk_off only; a neutral panel is not a dissent.
    dissentingPanels() {
      const head = String(this.session?.regimeSummary?.regime || "").replace(/-/g, "_");
      if (head !== "risk_on" && head !== "risk_off") return [];
      const opposite = head === "risk_on" ? "risk_off" : "risk_on";
      return this.panelInputs().filter((p) => String(p.regime || "").replace(/-/g, "_") === opposite);
    },
    dissentLine() {
      const out = this.dissentingPanels();
      if (!out.length) return "";
      const names = out.map((p) => `${p.label} at the ${this.ordinal(p.pct)}`).join(" and ");
      const head = this.regimeLabel(this.session?.regimeSummary?.regime);
      return `${names} — ${out.length === 1 ? "dissents" : "dissent"} from a ${head} composite`;
    },
    briefSummary() {
      const body = this.brief?.body || this.brief;
      if (!body) return "No brief available.";
      const subject = body.subject?.name || this.session?.subjectName;
      const regime = body.regime?.regime ? this.regimeLabel(body.regime.regime) : null;
      const signals = Array.isArray(body.researchSignals) ? body.researchSignals.length : 0;
      return [subject ? `Subject: ${subject}.` : "", regime ? `Regime: ${regime}.` : "", signals ? `${signals} research signals attached.` : ""].filter(Boolean).join(" ") || JSON.stringify(body).slice(0, 240);
    },
    recommendationKind() {
      const rec = this.session?.swarmRecommendation;
      if (!rec) return "none";
      if (rec.quorum || rec.stances) return "rollup";
      return rec.type ? String(rec.type).replace(/_/g, " ") : "recommendation";
    },
    isRollupRecommendation() {
      const rec = this.session?.swarmRecommendation;
      return !!(rec && (rec.quorum || rec.stances));
    },
    // The recommendation's own prose, or "" when it cannot be trusted.
    //
    // On a rollup the aggregator currently fills `rationale` with the member
    // take bodies concatenated: measured on 2026-09-25/mav it is 3714 characters
    // and BYTE-IDENTICAL to session.synthesis. Printing it would repeat the same
    // text a reader has already scrolled past under the takes, a third time,
    // under a heading claiming it is the swarm's reasoning. This is the same
    // judgement synthesisIsEcho() and consensusItems() already make elsewhere on
    // this page; the fix belongs in the aggregator, and until it lands the page
    // stays silent rather than pretending three quoted takes are a rationale.
    recommendationRationale() {
      const rec = this.session?.swarmRecommendation;
      if (!rec || this.isRollupRecommendation()) return "";
      return rec.rationale || "";
    },
    // Structured, and correct on a rollup as much as on a typed recommendation:
    // these are the positions the swarm is actually calling for.
    recommendationActions() {
      return this.session?.swarmRecommendation?.actions || [];
    },
    hasRecommendationDetail() {
      return !!(this.isBucketWeights() || this.recommendationActions().length || this.recommendationRationale());
    },
    positionRows() {
      const total = this.snapshot?.totalValueUsd || 0;
      return (this.snapshot?.positions || []).map((p) => ({ ...p, share: total > 0 ? p.value_usd / total : 0 }));
    },
    donutStyle(p, i) {
      const colors = ["#00e5ff", "#5fb3a1", "#10b981", "#e8a640", "#ff7a29", "#7e889e", "#6ee7b7"];
      return `--c:${colors[i % colors.length]};--p:${this.clampPct((p.share || 0) * 100)};`;
    },
    humanize(id) {
      return humanizeLabel(id);
    },
    // Inline-SVG panel-divergence bars (macro/onchain/factor percentiles) with a
    // dashed 50th-percentile reference line — mirrors the reference
    // PanelDivergenceBars. Consumes panelInputs() (pct is 0-1). Renders nothing
    // below 2 panels so it never shows an empty axis.
    panelDivergenceBars() {
      const rows = this.panelInputs().filter((p) => Number.isFinite(Number(p.pct)));
      if (rows.length < 2) return "";
      const W = 240, labelW = 56, barW = W - labelW, rowH = 16, rowGap = 4;
      const H = rows.length * rowH + (rows.length - 1) * rowGap + 6;
      const tick = (p) => labelW + p * barW;
      const body = rows.map((r, i) => {
        const y = i * (rowH + rowGap);
        const pct = this.clampPct(r.pct * 100) / 100;
        const ty = (y + rowH * 0.7).toFixed(1);
        // Each panel's bar takes its OWN regime colour. Drawn in one flat accent
        // these three bars said only "how high", so a panel reading risk-off
        // looked exactly like the two reading risk-on and the disagreement the
        // members are arguing about was invisible in the figure.
        const fill = this.regimeColor(r.regime);
        return `<g>
          <text x="0" y="${ty}" fill="var(--color-text-dim)" font-size="9" font-family="ui-monospace,monospace" style="text-transform:uppercase;letter-spacing:0.05em">${this.escapeHtml(r.label)}</text>
          <rect x="${labelW}" y="${y + 4}" width="${barW}" height="${rowH - 8}" fill="transparent" stroke="var(--color-border)"/>
          <rect x="${labelW}" y="${y + 4}" width="${(pct * barW).toFixed(1)}" height="${rowH - 8}" fill="${fill}" fill-opacity="0.75"/>
          <text x="${labelW + barW + 4}" y="${ty}" fill="var(--color-text-muted)" font-size="9" font-family="ui-monospace,monospace">${this.ordinal(r.pct)}</text>
        </g>`;
      }).join("");
      return `<svg viewBox="0 0 ${W + 32} ${H}" role="img" aria-label="Panel percentile divergence with 50th-percentile reference">
        ${body}
        <line x1="${tick(0.5).toFixed(1)}" x2="${tick(0.5).toFixed(1)}" y1="2" y2="${H - 2}" stroke="var(--color-border)" stroke-dasharray="2 2"/>
      </svg>`;
    },
    // Normalize a bucket_weights recommendation into rows the bar chart can draw.
    // Prefers explicit bucket rows (name/target/actual/recommended) if the
    // payload carries them; otherwise derives Recommended-only rows from the
    // weights map (target/actual are unavailable without allocation data).
    // Bucket ids and framework labels are written differently on each side
    // ("conservative_defi_yield" vs "Conservative DeFi Yield" — note DeFi's
    // inner capital, which humanize() cannot reproduce). Comparing on
    // letters-and-digits only lets the two meet without either side having to
    // adopt the other's spelling.
    allocationTargets() {
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const out = new Map();
      for (const s of this.allocation?.strategy || []) {
        if (Number.isFinite(Number(s.targetPct))) out.set(norm(s.label), { label: s.label, target: Number(s.targetPct) / 100 });
      }
      return out;
    },
    bucketWeights() {
      const rec = this.session?.swarmRecommendation;
      if (!rec || rec.type !== "bucket_weights") return [];
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      if (Array.isArray(rec.buckets) && rec.buckets.length) {
        return rec.buckets.map((b) => ({
          name: b.name || this.humanize(b.id),
          target: num(b.target ?? b.target_weight),
          actual: num(b.actual ?? b.actual_weight),
          recommended: num(b.recommended ?? b.weight) ?? 0,
        }));
      }
      const weights = rec.weights;
      if (!weights || typeof weights !== "object") return [];
      const targets = this.allocationTargets();
      const manifest = this.frameworkBuckets();
      const actuals = this.bucketActuals();
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return Object.entries(weights).map(([id, w]) => {
        const framework = targets.get(norm(this.humanize(id))) ?? targets.get(norm(id));
        const bucket = manifest.get(norm(id)) ?? manifest.get(norm(this.humanize(id)));
        return {
          // Prefer the framework's own spelling of the bucket name when it is
          // known; humanize() of an id cannot recover "DeFi".
          name: framework?.label || bucket?.name || this.humanize(id),
          // The live dashboard's target wins when it answered — it is the
          // CURRENT framework — with the published manifest behind it so a
          // backendless checkout still has something to compare against.
          target: framework ? framework.target : (bucket ? bucket.target : null),
          actual: bucket ? (actuals.get(bucket.id) ?? null) : null,
          recommended: num(w) ?? 0,
        };
      });
    },
    // The framework's buckets, indexed by both id and name so a weights map
    // keyed "conservative_defi_yield" and a manifest naming it "Conservative
    // DeFi Yield" still meet — the same letters-and-digits comparison
    // allocationTargets() uses, for the same reason.
    frameworkBuckets() {
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const out = new Map();
      for (const b of this.allocationFramework?.buckets || []) {
        if (b.id) out.set(norm(b.id), b);
        if (b.name) out.set(norm(b.name), b);
      }
      return out;
    },
    // Where the book ACTUALLY sits, per bucket, on this session's snapshot:
    // each bucket's share of NAV, summed from the positions whose token the
    // framework assigns to it.
    //
    // This is the number that turns the panel from a list of proposed weights
    // into a proposed MOVE. It is derived, not published — so it is computed
    // only when the snapshot and the framework are BOTH present, and a bucket
    // whose tokens are simply absent from the book reads 0%, which is true,
    // rather than "—", which would claim we do not know.
    bucketActuals() {
      const out = new Map();
      const buckets = this.allocationFramework?.buckets || [];
      const positions = this.snapshot?.positions || [];
      const total = Number(this.snapshot?.totalValueUsd ?? this.snapshot?.total_value_usd ?? 0);
      if (!buckets.length || !positions.length || !(total > 0)) return out;
      for (const b of buckets) {
        const held = positions
          .filter((p) => b.tokens.includes(String(p.token || "").toUpperCase()))
          .reduce((sum, p) => sum + Number(p.value_usd || 0), 0);
        out.set(b.id, held / total);
      }
      return out;
    },
    // The date the published framework's targets are stated as of.
    // /api/dashboards/allocation serves the SINGLE CURRENT row of
    // allocation_framework — there is no history — so this is the only handle
    // a reader has on when the target being drawn was set.
    // Falls back to the manifest's own asof, so a target sourced from the
    // published framework is still dated on screen. An undated target is an
    // unqualified claim — see the caller.
    allocationAsOf() { return this.allocation?.asOf || this.allocationFramework?.asOf || null; },
    // Whether the target predates the session it is being compared against.
    // v0's archive spans 2026-05-25 onward and the framework's asOf is later
    // than the earliest of them, so a straight join measures a historical
    // session against a target that did not exist yet — and, because the
    // framework is admin-editable, an edit today silently rewrites yesterday's
    // verdict on every archived allocation session.
    targetPostdatesSession() {
      const asOf = this.allocationAsOf();
      const date = this.session?.date;
      return !!(asOf && date && String(date) < String(asOf).slice(0, 10));
    },
    // Whether the swarm proposed something OTHER than the published target.
    // Mirrors the reference implementation's half-a-point tolerance, so a
    // rounding artifact never renders as a deviation.
    //
    // Suppressed when the target postdates the session: "deviates from target"
    // is a judgement on the swarm, and it cannot be made against a target the
    // swarm could not have been aiming at. The bars still draw, captioned with
    // the framework's own asOf, so the comparison is visible as a comparison
    // rather than asserted as a finding.
    deviatesFromTarget() {
      if (this.targetPostdatesSession()) return false;
      return this.bucketWeights().some((b) => b.target != null && Math.abs(b.recommended - b.target) > 0.005);
    },
    // Per-constituent weights inside each bucket. The payload has carried
    // `within_bucket_weights` all along and nothing rendered it, so allocation
    // sessions answered "95/5/0/0" and stopped — while the page's own copy asks
    // "within each bucket are the right constituents weighted correctly?".
    // Production prints this table; this rebuild dropped it.
    withinBucketWeights() {
      return withinBucketWeightsFrom(this.session?.swarmRecommendation);
    },
    isBucketWeights() {
      const rec = this.session?.swarmRecommendation;
      return !!(rec && rec.type === "bucket_weights" && this.bucketWeights().length);
    },
    // The bucket table's rows: the recommendation as numbers, and the move it
    // implies. The bars alone could not carry this panel — a book weighted
    // 97/3/0/0 draws one long bar and three that round to nothing, so the whole
    // recommendation was legible only in the value labels, and the reader had to
    // do the arithmetic that matters (how far is this from where we are?) in
    // their head.
    //
    // The gap is measured against ACTUAL where we know it, because that is the
    // move being asked for; against target otherwise, which is a different
    // question, so gapBasis() names which one is on screen rather than letting
    // one column heading stand for both.
    bucketRows() {
      const basis = this.gapBasis();
      return this.bucketWeights().map((b) => {
        const from = basis === "actual" ? b.actual : b.target;
        const gap = from == null ? null : b.recommended - from;
        return { ...b, gap };
      });
    },
    // "actual" once any bucket reports where the book actually sits, else
    // "target" when the framework supplies one, else null — no basis, no column.
    gapBasis() {
      const buckets = this.bucketWeights();
      if (buckets.some((b) => b.actual != null)) return "actual";
      if (buckets.some((b) => b.target != null)) return "target";
      return null;
    },
    // A gap under half a point is rounding, not a proposal — the same tolerance
    // deviatesFromTarget() uses, so the table and the ⚠ line cannot disagree.
    fmtGap(gap) {
      if (gap == null) return "—";
      const pp = gap * 100;
      if (Math.abs(pp) < 0.5) return "—";
      return `${pp > 0 ? "↑ +" : "↓ −"}${Math.abs(pp).toFixed(0)}pp`;
    },
    gapClass(gap) {
      if (gap == null || Math.abs(gap * 100) < 0.5) return "";
      return gap > 0 ? "is-up" : "is-down";
    },
    fmtWeight(v) {
      return v == null ? "—" : `${Math.round(v * 100)}%`;
    },
    // Inline-SVG grouped bars per bucket: Target (open outline), Actual (muted
    // fill), Recommended (accent fill) — mirrors the reference BucketWeightsBars.
    // Target/Actual rows only appear when at least one bucket supplies them, so
    // the chart degrades cleanly to Recommended-only when allocation data is
    // absent. Axis pinned 0-100% for cross-bucket comparability.
    bucketWeightsBars() {
      const buckets = this.bucketWeights();
      if (!buckets.length) return "";
      const hasTarget = buckets.some((b) => b.target != null);
      const hasActual = buckets.some((b) => b.actual != null);
      const series = [
        hasTarget ? { key: "target", label: "target", fill: "transparent", stroke: "var(--color-text-muted)", txt: "var(--color-text-muted)" } : null,
        hasActual ? { key: "actual", label: "actual", fill: "var(--color-text-dim)", opacity: "0.9", txt: "var(--color-text-muted)" } : null,
        { key: "recommended", label: "recommended", fill: "var(--color-accent)", txt: "var(--color-accent)" },
      ].filter(Boolean);
      // The series are NOT named per row. Repeating "target / actual /
      // recommended" beside every bucket printed the same three words four
      // times and left the figure looking like a form; the key lives once,
      // under the chart, as bucketBarsKey(). The values keep their % suffix,
      // because that unit is per-number and a key cannot supply it.
      //
      // There is also no 0/50/100 tick row. Each bar sits on a full-width track
      // that IS 100% of NAV, so the scale is already stated by the geometry and
      // again by the value at the end of every bar — a tick row on top of that
      // read as a third, competing scale next to the "% of NAV" heading.
      // The bucket name sits in a left COLUMN beside its bars, not on a line of
      // its own above them. Dropping the series column had left the bars running
      // the full width of the panel as ~3px hairlines with the name stranded
      // above — more air than figure. Beside the name they are shorter, thicker,
      // and the whole thing reads as the table it is.
      const W = 580, labelW = 160, valW = 44;
      const barX = labelW;
      const barW = W - barX - valW;
      const subH = 8, subGap = 4, gap = 14;
      const headY = 8, axisH = 23;
      const groupH = series.length * subH + (series.length - 1) * subGap;
      const H = axisH + buckets.length * (groupH + gap) + 2;
      const x = (v) => barX + this.clampPct(v * 100) / 100 * barW;
      const mono = 'font-family="ui-monospace,monospace"';
      const heads = `<text x="0" y="${headY}" fill="var(--color-text-dim)" font-size="8.5" ${mono}
          style="text-transform:uppercase;letter-spacing:0.06em">Bucket</text>
        <text x="${W}" y="${headY}" text-anchor="end" fill="var(--color-text-dim)" font-size="8.5" ${mono}
          style="text-transform:uppercase;letter-spacing:0.06em">% of NAV</text>`;
      const rule = `<line x1="0" y1="${axisH - 4}" x2="${W}" y2="${axisH - 4}" stroke="var(--color-border)"/>`;
      const body = buckets.map((b, i) => {
        const top = axisH + i * (groupH + gap);
        const sub = series.map((s, si) => {
          const v = b[s.key];
          const barY = top + si * (subH + subGap);
          const txtY = barY + subH - 1;
          // The full-width track. Without it a 0% bucket drew nothing at all —
          // three of four rows on a 97/3/0/0 recommendation were an empty band
          // and a number, which reads as missing data rather than as zero.
          const track = `<rect x="${barX}" y="${barY}" width="${barW}" height="${subH}" fill="var(--color-surface)"/>`;
          if (v == null) {
            return `${track}<text x="${W}" y="${txtY.toFixed(1)}" text-anchor="end" fill="var(--color-text-dim)" font-size="9" ${mono}>—</text>`;
          }
          const w = Math.max(0, x(v) - barX);
          const rect = s.fill === "transparent"
            ? `<rect x="${barX}" y="${barY}" width="${w.toFixed(1)}" height="${subH}" fill="transparent" stroke="${s.stroke}"/>`
            : `<rect x="${barX}" y="${barY}" width="${w.toFixed(1)}" height="${subH}" fill="${s.fill}"${s.opacity ? ` fill-opacity="${s.opacity}"` : ""}/>`;
          // The order the bars are stacked in IS the key's order, so the two can
          // be read against each other without either being numbered.
          return `${track}${rect}<text x="${W}" y="${txtY.toFixed(1)}" text-anchor="end" fill="${s.txt}" font-size="9" ${mono}>${Math.round(v * 100)}%</text>`;
        }).join("");
        // Centred against its own group of bars, so the name and the rows it
        // labels are unambiguously one block.
        const nameY = top + groupH / 2 + 3.5;
        return `<g>
          <text x="0" y="${nameY.toFixed(1)}" fill="var(--color-text)" font-size="10" ${mono}>${this.escapeHtml(b.name)}</text>
          ${sub}
        </g>`;
      }).join("");
      // The accessible name states the comparison AND the bar order, since a
      // screen reader gets the figure without the visual key beneath it.
      const drawn = series.map((s) => s.label).join(", then ");
      return `<svg viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Bucket weights as a percentage of NAV: recommended${hasTarget ? " vs target" : ""}${hasActual ? " vs actual" : ""}. Bars per bucket, in order: ${drawn}.">
        ${heads}${rule}${body}
      </svg>`;
    },
    // The key for the bars above, rendered once under the figure rather than
    // repeated on all four buckets. Order matches the stacking order inside each
    // group, so a reader maps top-to-top without a numbered legend.
    bucketBarsKey() {
      const buckets = this.bucketWeights();
      if (!buckets.length) return [];
      return [
        buckets.some((b) => b.target != null) ? { key: "target", label: "target" } : null,
        buckets.some((b) => b.actual != null) ? { key: "actual", label: "actual" } : null,
        { key: "recommended", label: "recommended" },
      ].filter(Boolean);
    },
    // The composite's trailing run. The two dashed rules are the regime
    // thresholds — 0.33 and 0.67 — and they used to be drawn unnamed, so the
    // line's most important property (which BAND it is in, and how close it sits
    // to crossing out of it) was invisible. Naming them turns the sparkline from
    // a shape into a reading.
    regimeSparkline() {
      const h = this.session?.regimeSummary?.history || [];
      if (h.length < 2) return "";
      const W = 260, H = 58, pad = 5, gutter = 26;
      const x = (i) => gutter + (i / (h.length - 1)) * (W - gutter - pad);
      const y = (v) => H - pad - Number(v || 0) * (H - pad * 2);
      const pts = h.map((d, i) => `${x(i).toFixed(1)},${y(d.composite).toFixed(1)}`).join(" ");
      const band = (v, label) => `<line x1="${gutter}" x2="${W - pad}" y1="${y(v)}" y2="${y(v)}" stroke="var(--color-border)" stroke-dasharray="2 3"/>
        <text x="0" y="${(y(v) + 3).toFixed(1)}" fill="var(--color-text-dim)" font-size="8"
          font-family="ui-monospace,monospace">${label}</text>`;
      const last = h[h.length - 1];
      // The end dot takes the regime's own colour, so the line lands on the same
      // reading the headline states rather than on a flat accent.
      const dot = this.regimeColor(last.regime || this.session?.regimeSummary?.regime);
      return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Regime composite over the trailing ${h.length} sessions, against the 0.33 risk-off and 0.67 risk-on thresholds">
        ${band(0.67, "0.67")}${band(0.33, "0.33")}
        <polyline fill="none" stroke="var(--color-accent)" stroke-width="1.6" points="${pts}"/>
        <circle cx="${x(h.length - 1)}" cy="${y(last.composite)}" r="2.8" fill="${dot}"/>
      </svg>`;
    },
    // The aggregator currently fills `consensus` with every take body verbatim
    // and `disagreements[].positions[].view` with two of those same bodies
    // (backend swarm/domain.ts: `authoredTakes.map(t => t.body)`). Rendered
    // literally, one take appears three times on this page under three headings
    // that each promise synthesis.
    //
    // So anything byte-identical to a take already listed above is treated as an
    // echo and dropped. This is deliberately shape-agnostic: the day the
    // aggregator emits real synthesis, those items stop matching any body and
    // appear on their own. Nothing here has to change for that to work.
    // NB: takes live on the factory root (`this.takes`), not under `session` —
    // the page's own x-for iterates `takes`.
    takeBodies() {
      return new Set((this.takes || []).map((t) => this.normText(t.body)).filter(Boolean));
    },
    normText(s) { return String(s || "").replace(/\s+/g, " ").trim(); },
    isEcho(text) { const n = this.normText(text); return !!n && this.takeBodies().has(n); },
    // Synthesis has the same problem one level up: the aggregator builds it by
    // joining every take body, so the section headed "Synthesis" reprints the
    // member takes already listed above it rather than drawing a conclusion
    // from them. Suppressed when it demonstrably contains every body verbatim;
    // a genuine synthesis will not, and will render untouched.
    synthesisIsEcho() {
      const bodies = [...this.takeBodies()];
      if (!bodies.length) return false;
      const n = this.normText(this.session?.synthesis);
      return !!n && bodies.every((b) => n.includes(b));
    },
    takeOf(memberId) { return (this.takes || []).find((t) => t.memberId === memberId); },
    consensusItems() {
      return (this.session?.swarmRecommendation?.consensus || []).filter((c) => !this.isEcho(c));
    },
    // Kept even when every view is an echo: WHO disagreed, and how far apart
    // they sat, is real information the takes list does not state anywhere.
    // Only the duplicated prose is suppressed — see the markup.
    disagreements() {
      return this.session?.swarmRecommendation?.disagreements || [];
    },
  }));
}
