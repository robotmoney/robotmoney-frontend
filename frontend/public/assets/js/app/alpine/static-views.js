// @ts-nocheck — browser-facing plain JS predating the root tsconfig's checkJs
// coverage. It entered the root TS program when frontend-routes.test.ts was
// re-pointed at the real archive loaders below (review-maintainability-026);
// before that it was never typechecked, so this pragma preserves the status
// quo rather than weakening existing coverage. JSDoc-typing this file is a
// worthwhile follow-up, not a drive-by.
import { api, ROUTES, path } from "../lib/api.js";
import { assetDot, subjectDot, resolveTokenColors } from "./views/shared.js";
import { CATEGORICAL, SERIES } from "../lib/chart-theme.js";
import { forgetApplication, rememberApplication } from "../lib/application-memory.js";
import { SWARM_DISCLAIMER } from "../lib/swarm-disclaimer.js";
import { memberAvatarMarkup } from "../lib/member-mark.js";
import { memberLogo } from "../lib/member-logos.js";
import { sessionPhase } from "../lib/session-phase.js";
import { STANCE_COLORS, stanceClass, stanceStyle } from "../lib/stance.js";
import { operatorName } from "../lib/operator.js";
import { timeAgo, timeLeft, absoluteUtc } from "../lib/relative-time.js";
import { sessionSummary, weightEntries, bucketHue, bucketLabel, bucketRank, bookSleeveShares, weightsOutcomeLine, BUCKET_ORDER } from "../lib/session-summary.js";
import * as weightChange from "../lib/weight-change.js";
import { sessionTakes } from "../lib/session-takes.js";
import { allocationFramework } from "../lib/allocation-framework.js";
import { sessionBrief } from "../lib/session-brief.js";
import { sleeveExplorer } from "../lib/sleeve-explorer.js";
import { takeCard, takeWeightRows } from "../lib/take-card.js";
import { canonicalUrlFor, setCanonicalUrl, citeTitle } from "../seo.js";
import { VAULT_SUBJECT_ID } from "../lib/allocation-subject.js";
import { VAULTS, VAULT_SLUGS, vaultBySlug, vaultForBucket, layerComplete, positionName, fmtUsd as fmtVaultUsd } from "../lib/vault-data.js";
import { DEVNET_LABEL, loadVaultOverview, loadVaultSubjectFixture, vaultMode } from "../lib/vault-source.js";

// Sentiment scale on the Beam/Pool/Beacon covenant: conviction reads as the
// green mass (bullish deepest → constructive lighter), neutral as slate, and
// the negative end as sand → beacon (attention/loss). Retires the old
// lime/red/amber Tailwind trio.


// The concentration chart's residual band: every position outside the charted
// top-N, plus any NAV the position list does not account for. It is a leftover
// rather than an asset, so it takes neither an assetDot hue nor a CATEGORICAL
// slot — dim slate reads as "everything else" without competing with a real
// holding for attention. (Kept literal: it goes into an SVG fill where a var()
// indirection buys nothing, and the hex stays where it is now that RM-102 has
// retired the --color-text-dim rung it was borrowed from. A band fill encodes
// data, not type, so it does not move when the text ramp does.)
const OTHER_TOKEN = "other";
const OTHER_COLOR = "#4a5268";

const ARCHIVE_LAST_DATE = "2026-06-25";
// The member-takes route's ceiling (it answers 400 above it) and it does not
// page, so a member past it shows its latest takes and says so.
const MEMBER_TAKES_MAX = 100;
export const KNOWN_ARCHIVE_MEMBERS = ["athena", "robotmoney", "woon"];

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
// Exported so the swarm index can compute the vault's sleeves from the same
// token map the session page uses. It belongs in lib/ with the other shared
// loaders; moving it is a bigger change than the one that needed it.
export function loadAllocationFramework() {
  if (!allocationFrameworkPromise) {
    allocationFrameworkPromise = fetchJson("/data/swarm/manifests/allocation.json")
      .then((raw) => ({
        asOf: raw.asof || raw.asOf || null,
        buckets: (raw.buckets || []).map((b) => ({
          id: b.id || "",
          name: b.name || "",
          target: Number.isFinite(Number(b.target_weight)) ? Number(b.target_weight) : null,
          tokens: (b.tokens || []).map((t) => String(t).toUpperCase()),
          // The sleeve's constituents in POLICY order, which is the order and
          // the colour /allocation draws them in.
          items: (b.items || []).map((it) => ({ id: it.id || "", name: it.name || it.id || "" })),
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
    // the rail and regime labels read a consistent camelCase shape.
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
        // A whitelist drops what it does not name: without these, a reading
        // that carries its own cuts (#964) could never draw its zones.
        bucketThresholds: rs.bucketThresholds ?? rs.bucket_thresholds ?? null,
        method: rs.method ?? null,
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
    // The API serves this and this transform used to drop it, so the session
    // page had no deadline to reason about and printed `state` raw — which is
    // how the same session read "closed" on /swarm and "collecting" one click
    // later. sessionPhase() needs it: the deadline is the timestamp, not the
    // state (backend domain.ts:567).
    windowClosesAt: raw.windowClosesAt || raw.window_closes_at || null,
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
    // The member's proposed sleeve weights (#963): the public take DTO serves
    // them normalized, as [{ bucket, weight }]. Null on a take that proposed
    // none and on the shipped archive, whose takes predate the field; the
    // take card's "Proposed weights" panel renders only when they are here.
    weights: Array.isArray(raw.weights) ? raw.weights : null,
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
    // `source.type` is the only field that says what KIND of thing this is:
    // `framework` has no portfolio to scrape because it IS the allocation
    // recipe, `vault_tvl` is the vault, `rpc` is a real wallet set. The
    // normaliser dropped it, which is why every consumer had to guess from the
    // slug. RM-100 groups on it.
    source: raw.source || null,
    status: raw.status || null,
  };
}

// Tolerates both shapes the field arrives in: a list of notes, or a single
// paragraph from an older manifest. Exported (and used by subjectProfile's
// structuralNotes() below) so scripts/tests/unit/frontend-routes.test.ts can
// assert the gate is on .length, not truthiness — camelSubject defaults a
// missing field to [], which is itself truthy, so a plain `x-show` on the
// raw value would open an empty disclosure on every subject that has none.
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
// the { bucket, items: [{ name, weight }] } rows session.html's `.sr__within`
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

// The subject operator this site IS. Compared lower-cased: the field is a
// free-text slug an admin types, and "RobotMoney" is the same house as
// "robotmoney".
const HOUSE_OPERATOR = "robotmoney";

// Exported so scripts/tests/unit/frontend-routes.test.ts can assert the
// verification-badge WORDING directly, not just the badge's state attribute.
// The three-state distinction below (verified / unverified / archived) is a
// copy contract as much as a rendering one — the sentence a reader is shown is
// the thing that was wrong — so the sentence itself is what gets pinned.
export const helpers = {
  // What KIND of subject this is, read from the record's own `source.type`
  // rather than guessed from the slug. Shared by the subject profile and by
  // the session detail, because a session's eyebrow and its subject's eyebrow
  // must not disagree about what the reader is looking at. A `framework`
  // subject has no book: its structural notes open with "no portfolio to
  // scrape", which both pages were contradicting by printing "portfolio".
  subjectKindOf(subject) {
    return subject?.source?.type === "framework" ? "framework" : "portfolio";
  },
  // The operator worth naming is the one the reader does not already know.
  // Every Robot Money subject is operated by Robot Money, so "· operator
  // robotmoney" sat under a headline reading ROBOT MONEY ALLOCATION and said
  // nothing twice. An outside operator is the opposite: peaq runs Woon
  // Treasury, and naming it is the only reason this slot exists.
  operatorOf(subject) {
    const op = String(subject?.operator || "").trim();
    return op.toLowerCase() === HOUSE_OPERATOR ? "" : op;
  },
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
  // Avatar precedence (#625, RM-100): the curated operator logo, then the
  // projection's avatar.path, then the derived identity mark (#560), then the
  // initials above when there is no seed either. The logo wins because every
  // seeded path production serves 404s and one of them points at the wrong
  // member; see lib/member-logos.js. Bound with x-html: memberAvatarMarkup()
  // only ever writes a path it was handed and a derived-mark/initials string
  // that cannot carry markup from a member name, so neither can inject.
  memberMark(seed, name, size = 40, avatarPath, handle) {
    const src = memberLogo({ handle }) || avatarPath || null;
    return memberAvatarMarkup(src, seed, name, size, (n) => this.initials(n));
  },
  // Same derivation /swarm uses, so a session cannot read "closed" there and
  // "collecting" here one click later. See lib/session-phase.js.
  phaseOf(session) { return session ? sessionPhase(session) : null; },
  phaseLabel(session) { return this.phaseOf(session)?.label || ""; },
  phaseClass(session) {
    const k = this.phaseOf(session)?.key;
    return k ? `rm-sphase rm-sphase--${k}` : "rm-sphase";
  },
  stanceColor(stance) {
    return STANCE_COLORS[stance] || STANCE_COLORS.neutral;
  },
  // The shared pill, so a stance reads the same on the member profile, the
  // session page and the swarm index. See lib/stance.js.
  stanceClass(stance) { return stanceClass(stance); },
  stanceStyle(stance) { return stanceStyle(stance); },
  // Same canonicalization the swarm index uses (lib/operator.js), so a member
  // profile cannot show the raw slug where the index shows the company name.
  operatorName(op) { return operatorName(op); },
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
  // Shared by the subject and session pages, which print the same positions
  // table. A token amount at the precision it deserves: billions and millions
  // compact, thousands grouped without decimals, units to two places, dust
  // to four significant digits.
  fmtAmount(v) {
    const n = Number(v);
    if (v == null || !Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return Math.round(n).toLocaleString("en-US");
    if (a >= 1) return n.toFixed(2);
    return a === 0 ? "0" : n.toPrecision(4);
  },
  // A unit price: cents above a dollar, four significant digits below it.
  fmtPrice(v) {
    const n = Number(v);
    if (v == null || !Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `$${Number(n.toPrecision(4)).toString()}`;
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
  // Only what the member declared. A newly approved member has no tagline,
  // biases or mandate yet, and the page says so rather than writing them one.
  memberTagline(member) { return member?.tagline || member?.mandate || ""; },
  memberBiases(member) { return Array.isArray(member?.biases) ? member.biases.filter(Boolean) : []; },
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
      return "Archived from the pre-launch record, filed before members signed their takes.";
    }
    return ok
      ? "Signed on the member's own machine with a key only they hold, and the signature checks out against their public key."
      : "This take's signature did not check out against the member's public key.";
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
      // A site path reads as the page's title (seo.js citeTitle), which is
      // escaped too; a path the site has no page for keeps its own text.
      .replace(/(^|[\s(])(\/[a-zA-Z0-9/_-]+)/g, (_, pre, path) => `${pre}<a href="${path}">${this.escapeHtml(citeTitle(path) || path)}</a>`);
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
  Alpine.data("sleeveExplorer", sleeveExplorer);
  // The same explorer over the vault stack's book (the Robot Money Vault
  // subject's Holdings): one arc per vault at its actual weight, measured
  // against the weights in force, and a vault's positions in its drawer.
  // subjectProfile supplies vaultRingRows().
  Alpine.data("vaultStackExplorer", () => ({
    ...sleeveExplorer(),
    explorerRows() { return this.vaultRingRows(); },
    explorerSvg() {
      return this.ringSvg(this.vaultRingRows().map((r) => ({ key: r.key, label: r.label, pct: r.pct, colour: r.hue })));
    },
    explorerCenter() { return { value: "", label: "Actual" }; },
    explorerLabel() {
      return this.vaultRingRows().filter((r) => r.pct > 0).map((r) => `${r.label} ${this.fmtPctTrim(r.pct)}`).join(", ");
    },
    // The legend's third column: the weights the vaults are measured against,
    // the router's applied weights once it applies them, else the target.
    legendBasis() {
      const r = this.vaultRingRows().find((x) => x.was != null);
      return r ? (r.basis === "applied" ? "Applied" : "Target") : "";
    },
  }));
  Alpine.data("takeCard", takeCard);

  Alpine.data("swarmTakeReceipt", () => ({
    ...helpers,
    // The ring and its formatting, shared with the subject and session pages.
    ...sessionSummary,
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
    // The member's proposed weights as the ring the subject and session pages
    // draw (lib/sleeve-explorer.js). No breakdown drawer: a take proposes
    // sleeves, not the assets inside them.
    explorerRows() {
      return this.take ? takeWeightRows(this.take).map((w) => ({ ...w, hue: w.colour, assets: [] })) : [];
    },
    explorerSvg() { return this.ringSvg(this.explorerRows()); },
    explorerLabel() {
      return this.explorerRows().filter((r) => r.pct > 0).map((r) => `${r.label} ${this.fmtPctTrim(r.pct)}`).join(", ");
    },
    hasBook() { return false; },
    fmtPctTrim(v) { return weightChange.fmtPctTrim(v); },
    // The signer's page, at the public handle (issue #593): the breadcrumb, the
    // head, the Signer list and the record link all go there.
    signerHref() {
      const ref = this.signer?.handle || this.take?.memberHandle || this.signer?.id || this.take?.memberId || "";
      return `/swarm/members/${encodeURIComponent(ref)}`;
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
    // verbatim: Apply, Approve, File a take. "Claimed" was the API's word for
    // the agent proving it holds its private key, and as a label it did two
    // things wrong: it sat one synonym away from "approved" on a page whose
    // whole job is telling those two apart, and it named an internal mechanism
    // rather than the thing the operator is waiting for, which is the agent
    // filing its first take.
    //
    // NOT "Vote". Nothing in this system votes: a member files a signed take,
    // and the recommendation is the arithmetic mean over the take set. There is
    // no ballot, no tally and no voting table behind the word, so it promised a
    // mechanism the code does not have.
    STEP_LABELS: { applied: "Apply", approved: "Approve", claimed: "File a take" },
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
      // The take step is NOT finished the moment the token is claimed.
      // Claiming proves the agent holds its key; filing is the duty that proof
      // unlocks, and it is what the operator is actually waiting for. So the step
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
      // The take step is "next" for two different reasons and they are not
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
    // filing takes. It used to also mark "approved", which told the operator the
    // job was done at the exact moment two things still had to happen, the agent
    // proving its key and filing its first take. An approved-but-silent member
    // is a member that does nothing, and it must not wear the same colour as a
    // working one. "Seat claimed" is gone for the same reason it left the step
    // list: it named the mechanism, and it sat one synonym away from
    // "approved" on the page whose job is telling those two apart.
    stateChip() {
      switch (this.status?.state) {
        case "rejected": return { label: "not accepted", tone: "alert" };
        case "approved": return { label: "not filing yet", tone: "pending" };
        case "claimed":
          return this.recordLoaded && !this.record.length
            ? { label: "no takes yet", tone: "pending" }
            : { label: "filing takes", tone: "good" };
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
        return { tone: "pending", label: "not filing yet",
          lead: `${name} has a seat, and is not filing yet.`,
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
      return { tone: "good", label: "filing takes",
        lead: `${name} is filing takes.`,
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
        const res = await api.get(`${path(ROUTES.swarm.memberTakes, { id: this.id })}?limit=${MEMBER_TAKES_MAX}`);
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
    // closes" about a window it had already filed in, while staying silent
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
    ...sessionSummary,
    ...sessionTakes(),
    ...allocationFramework(),
    ...sessionBrief(),
    loading: true,
    error: null,
    subject: null,
    snapshots: [],
    brief: null,
    // subject id → name, off the sessions list already fetched, so a brief's
    // recent-session refs can name their subjects.
    subjectNames: {},
    snapshot: null,
    // The published framework manifest, for its per-bucket token lists; only
    // a weights subject with a book asks for it. See latestBookWeights().
    allocationFramework: null,
    // Every published session on this subject, newest first, as index rows.
    sessionIndex: [],
    // The detailed rows: the current history page. sessions[0] on page 1 is
    // the latest review.
    sessions: [],
    historyPage: 0,
    historyBusy: false,
    historyError: "",
    historySize: 12,
    // How the history pages. "index": the whole list is read and filtered
    // here, which is all a backend before #1007 and the static archive allow.
    // "server": the API pages this subject's sessions and searches them.
    // Settled once, by loadHistory().
    historyMode: "index",
    historySubject: "",
    // Server mode. The cursor each page read so far opened at (the first
    // opens at none), the cursor past the page on screen, and how many
    // sessions the query holds: known once a page reaches the end, never
    // estimated. sessionTotal is the same count with no search applied.
    historyCursors: /** @type {(string | null)[]} */ ([null]),
    historyNext: /** @type {string | null} */ (null),
    historyTotal: /** @type {number | null} */ (null),
    sessionTotal: /** @type {number | null} */ (null),
    // The search the rows on screen answer, the one last asked for, and a
    // counter that lets only the newest request land.
    historyQuery: "",
    historyAsked: "",
    historySeq: 0,
    // The unfiltered first page, kept so clearing a search restores it
    // without asking again.
    historyFirst: /** @type {{ rows: any[], next: string | null } | null} */ (null),
    // The book chart's hover: the reading under the crosshair, and the band a
    // legend entry has put in focus.
    chartAt: null,
    chartFocus: null,
    // How many days of history the concentration chart reads. The API returns
    // every snapshot ever taken (311 on the demo stack), and a two-year stack of
    // 1px columns says nothing a reader can act on.
    windowDays: 90,
    // Positions beyond this fold into "other" rather than adding a colour. Seven
    // is the donut list's own cap on the session page; the two must agree or the
    // same book reads as two different shapes across two pages.
    topN: 7,
    // The Robot Money Vault's Holdings (isVaultStack): the book grouped by
    // vault. On the devnet switch (lib/vault-source.js) its readings and
    // wallets are the four-vault fixture's, kept apart from `snapshots` and
    // `subject.wallets` so the latest recommendation and the history still
    // measure real sessions against the real book. null reads those.
    vaultSnapshots: null,
    vaultWallets: null,
    // The vault overview, for the router's applied weights: the Holdings
    // target. Read after the page draws; until it settles no target shows,
    // rather than one target and then another.
    vaultStack: null,
    vaultStackSettled: false,
    async init() {
      const id = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
      // The route this component was mounted on. The fetch below is not
      // cancelled when the router tears the view down, so a slow response would
      // otherwise stamp a subject's name onto whatever page is showing by the
      // time it lands. Same guard memberProfile applies for the same reason.
      const routeAtEntry = location.pathname;
      try {
        // The archive fallback has to cover a subject the API ANSWERED for and
        // does not have, not just a request that failed. This route replies
        // 200 with a `null` body for an unknown id, so the promise resolves,
        // camelSubject(null) returns null, and a .catch() never runs: the page
        // read "Subject not found" for every subject missing from the database
        // while the checked-in manifest describing it sat one fetch away. That
        // is every subject on a stack seeded without them, which is what the
        // local demo stack is.
        const fromApi = await api.get(path(ROUTES.swarm.subject, { id }))
          .then(camelSubject)
          .catch(() => null);
        this.subject = fromApi || await loadArchiveSubject(id).catch(() => null);
        if (!this.subject) throw new Error("Subject not found");
        // Route-level SEO titleizes the last URL segment, which for a slug like
        // "robotmoney-allocation" reads "Robotmoney Allocation". Name the tab
        // after the subject once we know what it is actually called.
        if (this.subject?.name && location.pathname === routeAtEntry) {
          document.title = `${this.subject.name}: Robot Money Investment Swarm`;
        }
        // Each side-fetch is guarded on its own: a subject with no snapshot yet
        // still has sessions worth reading, and vice versa.
        //
        // A FRAMEWORK subject has no book, so it does not get one — the fetch
        // is skipped rather than the render being gated downstream. Its own
        // structural notes open with "no portfolio to scrape", and yet
        // /swarm/subjects/robotmoney-allocation published a $42,688 holdings
        // table on production: ensureSmokeSubjectFixtures() writes a
        // deterministic fake basket into swarm_subject_snapshots for any
        // subject that is not woon or mav, and a release cutover runs it
        // against the production database. The top line read "ROBOT 50%",
        // which is not a token — it is `subjectId.slice(0, 5).toUpperCase()`.
        // Whatever is in that table, this page is the wrong place to find out:
        // the subject declares it holds nothing.
        this.snapshots = this.isFramework() ? [] : await this.loadSnapshots(id);
        this.snapshot = this.snapshots.length ? normalizeSnapshot(this.snapshots[this.snapshots.length - 1]) : null;
        if (this.isVaultStack() && vaultMode().mode === "devnet") {
          const fixture = await loadVaultSubjectFixture({ hostname: location.hostname });
          if (fixture) {
            this.vaultSnapshots = fixture.snapshots;
            this.vaultWallets = fixture.wallets;
          }
        }
        await this.loadHistory(id);
        this.latestRow = this.sessions[0] || null;
        // The brief the last session opened with. Guarded like the rest: the
        // page describes the handover with or without it, and only the
        // figures depend on having a real one.
        this.brief = await this.loadBrief(id).catch(() => null);
        // A FRAMEWORK subject IS the published allocation, so its own page
        // opens with the weights in force (hasTargetsCard stays gated on
        // isFramework). Any weights subject also reads it, as the target a
        // session was measured against when its brief handed none over. A
        // book subject never asks: the framework does not describe it, and
        // asking would put the vault's targets on somebody else's treasury.
        if (this.isWeightsSubject()) await this.loadAllocationFw();
        // A weights subject that holds a book also reads the framework's
        // token lists, which sum that book into sleeves: its latest
        // recommendation is measured against the book, as its session page
        // measures it (latestBookWeights).
        if (this.isWeightsSubject() && this.snapshots.length) this.allocationFramework = await loadAllocationFramework();
        // The newest session's own regime read first, and the brief's copy of
        // it as the fallback: an archive-only subject reaches the brief but not
        // always the session detail, and they carry the same reading under two
        // spellings. normalizeRegime settles that.
        this.setBackdrop(this.sessions[0]?.regimeSummary || this.brief?.regime || null, {
          date: this.sessions[0]?.date || this.brief?.date || "",
          v0: this.readingIsV0(this.latest()),
        });
      } catch (_) {
        // Never e.message: it is whatever the fetch threw. A subject in hand
        // means a side-fetch failed, not that the subject is missing.
        this.error = this.subject ? "This subject could not be loaded." : "Subject not found.";
      } finally {
        this.loading = false;
      }
      // Not awaited: the Holdings target follows once the overview answers.
      if (!this.error && this.isVaultStack()) {
        loadVaultOverview({ hostname: location.hostname, recommendation: false })
          .then((r) => { this.vaultStack = r; })
          .catch(() => { this.vaultStack = null; })
          .finally(() => { this.vaultStackSettled = true; });
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
    // The brief is what a member is handed when a session opens: the regime
    // read, the framework, the research, the subject and what the last three
    // sessions concluded. It is fetched for the MOST RECENT session, because
    // "what does the swarm get" is a question about the current shape of the
    // handover, and the newest one is the best evidence of it.
    async loadBrief(id) {
      const latest = this.sessions[0];
      const date = latest?.date;
      if (!date) return null;
      const qs = latest.id && latest.id !== `${date}-${id}`
        ? `?session=${encodeURIComponent(latest.id)}`
        : `?date=${encodeURIComponent(date)}&subject=${encodeURIComponent(id)}`;
      try {
        const res = await api.get(`${ROUTES.swarm.brief}${qs}`);
        if (res && !res.error) return res;
      } catch (_) { /* fall through to the archive */ }
      return fetchJson(`/data/swarm/briefs/${date}-${id}.json`).catch(() => null);
    },
    latestRow: null,
    latest() { return this.latestRow; },
    hasTargetsCard() { return this.isFramework() && this.allocationTargets().length > 0; },
    hasLatestReview() {
      const l = this.latest();
      return Boolean(l) && (this.signalRows().length > 0 || this.voteTotal(l) > 0);
    },
    // The history's first page. The API pages one subject's published
    // sessions itself (#1007), each row carrying its take count and the target
    // its brief handed over, so no row is fetched to be drawn. A backend that
    // predates it ignores `subject` and answers with every subject's rows, so
    // the answer is trusted only when servesSubjectHistory() says so; anything
    // else reads the history as before, the static archive included.
    async loadHistory(id) {
      const first = await this.requestHistory(id, null, "").catch(() => null);
      if (!first || !servesSubjectHistory(first.rows, id)) {
        this.sessionIndex = await this.loadSessionIndex(id);
        this.sessions = await this.loadSessionPage(0);
        return;
      }
      this.historyMode = "server";
      this.historySubject = id;
      await this.showHistory(0, null, first, "", this.historySeq);
      this.historyFirst = { rows: this.sessions, next: this.historyNext };
    },
    /** @param {string} id @param {string | null} cursor @param {string} search */
    async requestHistory(id, cursor, search) {
      /** @type {Record<string, string>} */
      const query = { subject: id, state: "published", limit: String(this.historySize) };
      if (cursor) query.cursor = cursor;
      if (search) query.search = search;
      const res = await api.get(ROUTES.swarm.sessions, query);
      return {
        rows: Array.isArray(res?.sessions) ? res.sessions : [],
        next: typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : null,
      };
    },
    // One server page on screen, unless a newer request has been made since
    // (`seq`). The count is recorded when the query runs out on this page.
    async showHistory(page, cursor, res, search, seq) {
      const rows = await this.historyRows(res.rows, page === 0 && !search);
      if (seq !== this.historySeq) return false;
      if (search !== this.historyQuery) this.historyTotal = null;
      if (!res.next) this.historyTotal = page * this.historySize + rows.length;
      if (!search && this.historyTotal != null) this.sessionTotal = this.historyTotal;
      this.sessions = rows;
      this.historyPage = page;
      this.historyCursors = [...this.historyCursors.slice(0, page), cursor];
      this.historyNext = res.next;
      this.historyQuery = search;
      return true;
    },
    // Server rows as history rows. The row carries everything the table
    // draws but the takes, which only two readers need: the latest block (the
    // full synthesis, and a tally counted from the takes) and the consensus
    // of a portfolio session whose record predates the stance tally. Those
    // rows are read in full; no other row is fetched.
    async historyRows(raw, withLatest) {
      const rows = raw.filter((s) => (s?.subjectId ?? s?.subject_id) === this.historySubject).map(historyRowOf);
      const weights = this.isFramework() || rows.some((r) => r.swarmRecommendation?.type === "bucket_weights");
      return Promise.all(rows.map((r, i) => {
        if (this.latestRow && r.id === this.latestRow.id) return this.latestRow;
        const full = (withLatest && i === 0) || (!weights && Number(r.takes) > 0 && !this.lean(r));
        return full ? this.withDetail(r) : r;
      }));
    },
    // The session's own record over its index row, with its takes. The index
    // row stands when the detail does not load.
    async withDetail(r) {
      try {
        const detail = await api.get(path(ROUTES.swarm.sessionById, { id: r.id }));
        const full = camelSession(detail.session || detail);
        return {
          ...r,
          synthesis: full?.synthesis || r.synthesis,
          swarmRecommendation: full?.swarmRecommendation || r.swarmRecommendation,
          regimeSummary: full?.regimeSummary || r.regimeSummary,
          takeRows: (detail.takes || []).map(camelTake),
        };
      } catch (_) {
        return r;
      }
    },
    // The search box (server mode only): a literal phrase the API matches
    // against each session's date, rationale and synthesis before it pages.
    // An empty box puts the unfiltered first page back.
    async searchHistory(raw) {
      const q = String(raw || "").trim().slice(0, HISTORY_SEARCH_MAX);
      if (this.historyMode !== "server" || q === this.historyAsked) return;
      this.historyAsked = q;
      const seq = ++this.historySeq;
      this.historyError = "";
      if (!q && this.historyFirst) {
        this.sessions = this.historyFirst.rows;
        this.historyNext = this.historyFirst.next;
        this.historyCursors = [null];
        this.historyPage = 0;
        this.historyQuery = "";
        this.historyTotal = this.sessionTotal;
        this.historyBusy = false;
        return;
      }
      this.historyBusy = true;
      try {
        await this.showHistory(0, null, await this.requestHistory(this.historySubject, null, q), q, seq);
      } catch (_) {
        if (seq === this.historySeq) {
          this.historyError = "These sessions could not be loaded.";
          this.historyAsked = this.historyQuery;
        }
      } finally {
        if (seq === this.historySeq) this.historyBusy = false;
      }
    },
    // Newer and Older in server mode: a page already read reopens at its
    // cursor, the next one at the cursor past the page on screen.
    async goServerHistory(page) {
      const cursor = page === this.historyPage + 1 ? this.historyNext : this.historyCursors[page];
      if (this.historyBusy || page < 0 || page === this.historyPage || cursor === undefined) return;
      if (page > this.historyPage && !cursor) return;
      const seq = ++this.historySeq;
      this.historyBusy = true;
      this.historyError = "";
      try {
        const res = await this.requestHistory(this.historySubject, cursor, this.historyQuery);
        if (await this.showHistory(page, cursor, res, this.historyQuery, seq)) {
          document.getElementById("history")?.scrollIntoView({ block: "start" });
        }
      } catch (_) {
        if (seq === this.historySeq) this.historyError = "These sessions could not be loaded.";
      } finally {
        if (seq === this.historySeq) this.historyBusy = false;
      }
    },
    // How many sessions the subject has published, when the page knows: the
    // whole index in index mode, and in server mode once the unfiltered
    // history has been read to its end. Null otherwise, never a guess.
    sessionCount() { return this.historyMode === "server" ? this.sessionTotal : this.sessionIndex.length; },
    hasPages() { return this.historyMode === "server" ? this.historyPage > 0 || !!this.historyNext : this.historyPageCount() > 1; },
    hasOlder() { return this.historyMode === "server" ? !!this.historyNext : this.historyPage < this.historyPageCount() - 1; },
    // Every published session on the subject, newest first, as index rows.
    // The fallback when the API does not page by subject (a backend before
    // #1007): the whole index is read and filtered here, with the static
    // archive behind it.
    async loadSessionIndex(id) {
      const pick = (list) => list
        .filter((s) => (s.subjectId ?? s.subject_id) === id && s.state === "published")
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))
          || String(b.generatedAt || b.generated_at || "").localeCompare(String(a.generatedAt || a.generated_at || "")))
        // `id` is the ONLY unique handle on a session: a subject may convene
        // more than once a day. The static archive has no ids, so it falls
        // back to the composite, which sessionHref() recognises.
        .map((s) => ({
          id: s.id ?? `${s.date}-${s.subjectId ?? s.subject_id}`,
          date: s.date,
          subjectId: s.subjectId ?? s.subject_id,
          subjectName: s.subjectName ?? s.subject_name,
          generatedAt: s.generatedAt ?? s.generated_at ?? null,
        }));
      const remember = (list) => {
        const names = { ...this.subjectNames };
        for (const x of list || []) {
          const sid = x.subjectId ?? x.subject_id;
          const name = x.subjectName ?? x.subject_name;
          if (sid && name && !names[sid]) names[sid] = name;
        }
        this.subjectNames = names;
      };
      try {
        const all = await publishedSessionList();
        remember(all);
        const index = pick(all);
        if (index.length) return index;
      } catch (_) { /* fall through to the archive */ }
      try {
        const all = (await fetchJson("/data/swarm/sessions/index.json")).sessions || [];
        remember(all);
        return pick(all);
      } catch (_) {
        return [];
      }
    },
    // One page of history, in full: the session detail (recommendation, regime,
    // takes) and the brief it opened with, which is the only honest source of
    // the reference weights a row is compared against. Guarded per session,
    // with the static archive behind each.
    async loadSessionPage(page) {
      const rows = this.sessionIndex.slice(page * this.historySize, (page + 1) * this.historySize);
      return Promise.all(rows.map((s) => this.loadSessionRow(s)));
    },
    async loadSessionRow(s) {
      const archiveId = s.id === `${s.date}-${s.subjectId}`;
      const briefFor = async () => {
        if (!archiveId) {
          const b = await api.get(ROUTES.swarm.brief, { session: s.id }).catch(() => null);
          if (b && !b.error) return b;
        }
        return archivePreferred(s.date)
          ? fetchJson(`/data/swarm/briefs/${s.date}-${s.subjectId}.json`).catch(() => null)
          : null;
      };
      const withBrief = async (row) => ({ ...row, reference: referenceWeights(await briefFor()) });
      try {
        const detail = archiveId
          ? await api.get(path(ROUTES.swarm.session, { date: s.date, subject: s.subjectId }))
          : await api.get(path(ROUTES.swarm.sessionById, { id: s.id }));
        const full = camelSession(detail.session || detail);
        return withBrief({
          ...s,
          synthesis: full?.synthesis || "",
          swarmRecommendation: full?.swarmRecommendation || null,
          regimeSummary: full?.regimeSummary || null,
          publishedAt: full?.publishedAt || null,
          takes: (detail.takes || []).length,
          takeRows: (detail.takes || []).map(camelTake),
        });
      } catch (_) {
        if (archivePreferred(s.date)) {
          try {
            const archive = await loadArchiveSession(s.date, s.subjectId);
            return withBrief({
              ...s,
              synthesis: archive.session?.synthesis || "",
              swarmRecommendation: archive.session?.swarmRecommendation || null,
              regimeSummary: archive.session?.regimeSummary || null,
              // The index entry has no time; the session file does. Without it
              // the row printed "3 takes" where /swarm prints "23:58 UTC · 3 takes".
              generatedAt: s.generatedAt ?? archive.session?.generatedAt ?? null,
              takes: (archive.takes || []).length,
              takeRows: archive.takes || [],
            });
          } catch (_) { /* fall through */ }
        }
        // Marked failed, with no take count: a row that did not load is not a
        // session that collected nothing and published nothing.
        return { ...s, failed: true, synthesis: "", swarmRecommendation: null, takes: null, takeRows: [], reference: null };
      }
    },
    historyPageCount() { return Math.max(1, Math.ceil(this.sessionIndex.length / this.historySize)); },
    async goHistory(page) {
      if (this.historyMode === "server") return this.goServerHistory(page);
      if (this.historyBusy || page < 0 || page >= this.historyPageCount()) return;
      this.historyBusy = true;
      this.historyError = "";
      try {
        this.sessions = await this.loadSessionPage(page);
        this.historyPage = page;
        document.getElementById("history")?.scrollIntoView({ block: "start" });
      } catch (_) {
        this.historyError = "These sessions could not be loaded.";
      } finally {
        this.historyBusy = false;
      }
    },
    historyRange() {
      if (this.historyMode === "server") {
        const first = this.historyPage * this.historySize + 1;
        const last = first + this.sessions.length - 1;
        return this.historyTotal == null ? `${first}–${last}` : `${first}–${last} of ${this.historyTotal}`;
      }
      const from = this.historyPage * this.historySize + 1;
      const to = Math.min(this.sessionIndex.length, from + this.historySize - 1);
      return `${from}–${to} of ${this.sessionIndex.length}`;
    },
    // ── the record's figures (RM-121) ───────────────────────────────────────
    // The four sleeves in published order, as table columns.
    // `short` heads a column on a phone, where four full names do not fit.
    sleeveColumns() {
      return BUCKET_ORDER.map((key, i) => ({ key, label: bucketLabel(key), short: this.bucketShort(key) || bucketLabel(key), hue: bucketHue(key, i) }));
    },
    // A subject whose sessions recommend sleeve weights reads as a weights
    // history; any other reads as a verdict history.
    isWeightsSubject() {
      return this.isFramework() || this.subject?.recommendationType === "bucket_weights"
        || this.sessions.some((r) => r?.swarmRecommendation?.type === "bucket_weights");
    },
    // The history's one row when it has none: before the first session, or a
    // search that matched nothing.
    historyEmptyLabel() { return this.historyQuery ? "No session matches" : "No session published yet"; },
    // A row's recommended weights in column order, percent, null where absent.
    rowWeights(row) {
      const rows = this.sessionWeights(row) || [];
      return BUCKET_ORDER.map((key) => {
        const hit = rows.find((r) => r.key === key);
        return hit ? hit.pct : null;
      });
    },
    // The target a row is measured against: the one its brief handed over, else
    // the published target when it was already in force that day.
    rowReference(row) { return row?.reference || targetsInForce(this.allocationFw, row?.date); },
    // The moves a row recommends against rowReference(). No reference, no
    // moves: a target published after the session is never read back onto it.
    // The history table measures every row this way, the latest included.
    rowMoves(row) { return this.movesAgainst(row, this.rowReference(row)); },
    // The move in one sleeve's cell, beside its weight, or null when it did not
    // move: the history table carries each change in its own column rather
    // than in a last column that named every sleeve again.
    /** @param {any} row @param {number} i */
    moveAt(row, i) {
      const key = this.sleeveColumns()[i]?.key;
      return (this.rowMoves(row) || []).find((m) => m.key === key) || null;
    },
    // A weights row's state when its cells cannot say it: nothing loaded,
    // nothing published, or no target to measure the weights against.
    /** @param {any} row */
    rowState(row) {
      if (row?.failed) return "Could not be loaded";
      // A row of this weights table that carries no weights: a rollup with
      // none, or one typed position_actions on a weights subject.
      if (this.rowWeights(row).every((v) => v == null)) return row?.swarmRecommendation ? "No weights published" : "No recommendation published";
      if (!this.recommendation(row)) return "No recommendation published";
      return this.rowMoves(row) == null ? "No target recorded" : "";
    },
    movesAgainst(row, ref) {
      if (!ref) return null;
      const w = this.rowWeights(row);
      if (w.every((v) => v == null)) return null;
      return BUCKET_ORDER.map((key, i) => {
        const was = ref[key];
        const d = weightChange.weightDelta(w[i], was == null ? null : was);
        return { key, label: bucketLabel(key), was, d };
      }).filter((m) => m.d != null && m.d !== 0);
    },
    outcomeAgainst(row, moves, basis) {
      const rec = row?.swarmRecommendation;
      if (rec?.type !== "bucket_weights") return this.actionsOutcome(row);
      // No weights, no outcome: the history cell and the latest block each
      // say "no recommendation" in their own words, so this adds nothing.
      if (!this.rowWeights(row).some((v) => v != null)) return "";
      if (moves == null) return "No target recorded";
      return weightsOutcomeLine(moves.length, basis);
    },
    // The latest recommendation is measured as its session page measures it
    // (gapBasis there): against the book when the session read one, on or
    // before its date, and the framework's token lists can sum it into
    // sleeves; against its target otherwise. bookSleeveShares() is the one
    // reading of the book both pages call. Percent by sleeve, or null.
    latestBookWeights() {
      const row = this.latest();
      if (!row || this.isFramework()) return null;
      /** @type {Record<string, number>} */
      const out = {};
      for (const [id, share] of bookSleeveShares(this.allocationFramework, this.latestBook(), row.date)) {
        const i = bucketRank(id);
        if (i < BUCKET_ORDER.length) out[BUCKET_ORDER[i]] = share * 100;
      }
      return Object.keys(out).length ? out : null;
    },
    latestBasis() { return this.latestBookWeights() ? "book" : "target"; },
    latestReference() { return this.latestBookWeights() || this.rowReference(this.latest()); },
    latestMoves() { return this.movesAgainst(this.latest(), this.latestReference()); },
    latestOutcome() { return this.outcomeAgainst(this.latest(), this.latestMoves(), this.latestBasis()); },
    // The latest review's legend: each sleeve, its recommended weight, and its
    // move against what that session is measured against (latestReference).
    latestLegend() {
      const row = this.latest();
      const w = this.rowWeights(row);
      const ref = this.latestReference();
      return this.sleeveColumns().map((c, i) => {
        const was = ref ? ref[c.key] : null;
        return { ...c, pct: w[i], was: was == null ? null : was, d: ref ? weightChange.weightDelta(w[i], was == null ? null : was) : null };
      }).filter((r) => r.pct != null);
    },
    // The explorer for the latest review: the recommended mix on a weights
    // subject, the book on that session's date with its actions otherwise.
    latestActions() {
      const rec = this.latest()?.swarmRecommendation;
      // Rollups aggregated 2026-08-06 to 09-04 carry two hardcoded actions
      // derived from no member input (see the session page's authoredActions).
      if (!rec || rec.quorum || rec.stances) return [];
      return (Array.isArray(rec.actions) ? rec.actions : []).filter((a) => a && a.action);
    },
    latestBook() {
      const d = this.latest()?.date;
      return d ? pickSnapshotFor(this.snapshots, d) : null;
    },
    hasBook() { return this.recommendation(this.latest())?.kind !== "weights" && !!this.latestBook() && this.latestActions().length > 0; },
    hasExplorer() { return this.recommendation(this.latest())?.kind === "weights" || this.hasBook(); },
    // A weights subject's session recommends only when it publishes weights.
    hasLatestRecommendation() {
      const r = this.recommendation(this.latest());
      return this.isWeightsSubject() ? r?.kind === "weights" : !!r;
    },
    // The latest session's own words: its rationale, or its synthesis when it
    // is not a rollup's. A rollup's synthesis is a template over the tally
    // printed under it ("3 of 7 members … Stance split: 3 constructive"), and
    // the session page leaves it out for the same reason.
    latestProse() {
      const s = this.latest();
      const rec = s?.swarmRecommendation;
      return this.rationaleOf(s) || (rec && (rec.quorum || rec.stances) ? "" : s?.synthesis || "");
    },
    explorerSource() { return this.latest(); },
    explorerSvg() {
      return this.hasBook() ? this.ringSvg(this.explorerRows().map((r) => ({ ...r, colour: r.hue }))) : this.weightDonutSvg(this.latest());
    },
    explorerLabel() {
      return this.explorerRows().filter((r) => r.pct > 0).map((r) => `${r.label} ${this.fmtPctTrim(r.pct)}`).join(", ");
    },
    // The centre speaks for the row in focus. At rest a recommended mix reads
    // "Recommended", as it does on the session page and /swarm, so one ring
    // means one thing on every page. The book the latest session read is the
    // Holdings figure while it is still the newest snapshot; once newer
    // snapshots land, this is the only place the page gives the total of the
    // book the recommendation acted on.
    explorerCenter() {
      if (!this.hasBook()) return { value: "", label: "Recommended" };
      const book = this.latestBook();
      const newest = String(book?.date || "").slice(0, 10) === String(this.snapshot?.date || "").slice(0, 10);
      return book && !newest ? { value: this.fmtUsdShort(book.totalValueUsd), label: "Holdings" } : { value: "", label: "" };
    },
    fmtUsdShort(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return "—";
      return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`;
    },
    // One palette per book: the ring, the positions table and its share bars,
    // and the chart's bands. A named position keeps one hue on all of them;
    // only what both the chart and the ring fold into "other" is grey. The ring
    // is read from latestBook() directly: explorerRows() calls bookColour(),
    // so reading it here would recurse.
    bookPalette() {
      const ring = (this.latestBook()?.positions || [])
        .map((p) => ({ token: String(p.token || p.symbol || ""), value: Number(p.value_usd ?? p.valueUsd) || 0 }))
        .filter((p) => p.token).sort((a, b) => b.value - a.value).slice(0, 7).map((p) => p.token);
      const tokens = [...this.chartTokens(), ...ring, ...this.latestActions().map((a) => a.token)];
      return resolveTokenColors([...new Set(tokens.filter(Boolean))], [OTHER_COLOR]);
    },
    bookColour(token) { return this.bookPalette()[token] || assetDot(token); },
    explorerRows() {
      if (this.hasBook()) return bookExplorerRows(this.latestBook(), this.latestActions(), (t) => this.bookColour(t), (v) => this.fmtUsd(v));
      const row = this.latest();
      const legend = this.latestLegend();
      const sleeveWeight = new Map(legend.map((r) => [normKeyOf(r.key), r.pct == null ? null : r.pct / 100]));
      const within = new Map(withinBucketsFor(row?.swarmRecommendation, this.brief, null, sleeveWeight).map((w) => [normKeyOf(w.bucket), w]));
      return legend.map((r) => ({
        ...r,
        meta: "", action: "", rationale: "",
        basis: this.latestBasis(),
        assets: explorerAssets(within.get(normKeyOf(r.label)) || within.get(normKeyOf(r.key)), r.pct),
      }));
    },
    pctLabel(v) { return weightChange.fmtPctTrim(v); },
    fmtPctTrim(v) { return weightChange.fmtPctTrim(v); },
    changeLabel(d) { return weightChange.changeLabel(d); },
    changeClass(d) { return weightChange.changeClass(d); },
    isLong(text, chars) { return String(text || "").length > chars; },
    sessionsJsonHref() { return ROUTES.swarm.sessions; },
    // What KIND of subject this is, from the record rather than from the slug.
    // A `framework` subject is the allocation recipe and has no book: its own
    // structural notes open with "no portfolio to scrape", which the page was
    // contradicting one line above them by calling it a portfolio.
    isFramework() { return this.subject?.source?.type === "framework"; },
    subjectKind() { return this.subjectKindOf(this.subject); },
    operatorLabel() { return this.operatorOf(this.subject); },
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
    // Chart tokens lead bookPalette()'s list, so the bands still claim first.
    chartColors() { return this.bookPalette(); },
    // The snapshots inside the chart window, oldest first.
    //
    // Calendar days, not readings. This was `slice(-windowDays)`, which cut the
    // last N SNAPSHOTS — and on the archive path a snapshot is one per session,
    // not one per day, so "90 days" could reach back two years while the panel
    // said 9 readings. Fall back to the old cut only if the dates are unusable,
    // and never return fewer than the two points a series needs.
    windowed() {
      const all = this.isVaultStack() ? this.stackSnapshots() : this.snapshots;
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
      if (this.isVaultStack()) return this.vaultSeries();
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
    // The legend: swatch and token. The latest reading's share of each is the
    // positions table's Share column above, and every reading's is in the
    // crosshair tip. The panel previously shipped no legend at all, so six
    // unlabelled lines could only be decoded against a 14px rule in the table
    // further down the page.
    concentrationLegend() {
      const series = this.concentrationSeries();
      if (!series.length) return [];
      const items = series.map((b) => ({
        token: b.token,
        // The residual band's key is lowercase; printed as-is it reads as one
        // more token among the symbols. Keys and focus stay on `token`.
        label: b.label ?? (b.token === OTHER_TOKEN ? "Other" : b.token),
        color: b.color,
        mark: b.mark,
      })); // largest first: the legend runs left to right under the chart
      // The vault stack's target lines, when any reading has a target, named
      // by what they are: the router's applied weights, or the framework's.
      if (this.isVaultStack() && this.vaultTargetLines().length) items.push({ token: "target", label: this.stackTargetName(), target: true });
      return items;
    },
    // "readings", not "days": the archive path carries one snapshot per session
    // rather than one per calendar day, so eight points can span a month. Naming
    // them days would misdescribe the x-axis. The span is the axis's own first
    // and last ticks.
    chartSpan() {
      const w = this.windowed();
      return w.length < 2 ? "" : `${w.length} readings`;
    },
    // ── the book over time (RM-121) ─────────────────────────────────────────
    // Share-of-NAV over time, one stacked BAND per position. A holdings table is
    // a single day; the question a reader has is whether the book is
    // concentrating or diversifying, and only a series answers that.
    //
    // Bands rather than lines. Lines were tried first and failed on real books
    // in two ways a legend cannot fix: positions at equal weight draw exactly on
    // top of each other (the vault subject holds MORPHO/AAVE/COMPOUND at 33.3%
    // each and rendered as ONE line), and the long tail of sub-5% holdings piles
    // into an unreadable tangle along the axis. Stacked to a fixed 100%, share
    // is read as area: equal weights are three equal bands, and "is one position
    // taking over" is the bottom band's height.
    //
    // Geometry lives in a 1000 x 100 unit box that stretches to the column, and
    // every label (the axes, the ticks, the tooltip) is HTML over it, so text
    // stays at its real size at any width instead of scaling with the SVG.
    // The chart's empty frame: a line needs two readings.
    chartEmptyLabel() { return this.windowed().length > 1 ? "No positions to draw" : "One reading so far"; },
    chartModel() {
      const rows = this.windowed();
      const series = this.concentrationSeries();
      if (rows.length < 2 || !series.length) return null;
      // x by DATE, not by index. The archive path carries one reading per
      // session rather than one per day, so evenly-spaced points drew a
      // three-week gap the same width as a one-day one. Index spacing stays as
      // the fallback for snapshots whose dates will not parse.
      const stamps = rows.map((r) => Date.parse(`${r?.date}T00:00:00Z`));
      const dated = stamps.every((t) => Number.isFinite(t)) && stamps[stamps.length - 1] > stamps[0];
      const span = dated ? stamps[stamps.length - 1] - stamps[0] : 0;
      const xs = rows.map((_, i) => (dated ? 1000 * ((stamps[i] - stamps[0]) / span) : 1000 * (i / (rows.length - 1))));
      return { rows, series, xs };
    },
    // The bands, bottom-up over a running baseline, the largest position on the
    // bottom (only the bottom band has a flat, honest baseline). Each band is a
    // calm fill with a crisp top edge in its own colour, separated from its
    // neighbour by a hairline of the page ground.
    chartSvg() {
      const m = this.chartModel();
      if (!m) return "";
      const y = (frac) => (100 - this.clampPct(frac * 100)).toFixed(2);
      const base = m.rows.map(() => 0);
      const fills = [];
      const edges = [];
      for (const b of m.series) {
        const top = base.map((v, i) => v + b.shares[i]);
        const upper = top.map((v, i) => `${m.xs[i].toFixed(1)},${y(v)}`);
        const lower = base.map((v, i) => `${m.xs[i].toFixed(1)},${y(v)}`).reverse();
        for (let i = 0; i < base.length; i++) base[i] = top[i];
        const tok = this.escapeHtml(b.token);
        const mark = b.mark ? ` data-mark="${this.escapeHtml(b.mark)}"` : "";
        fills.push(`<polygon data-token="${tok}"${mark} points="${upper.concat(lower).join(" ")}" fill="${b.color}" fill-opacity="0.62"`
          + ` stroke="var(--color-void)" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
        edges.push(`<polyline data-token="${tok}"${mark} points="${upper.join(" ")}" fill="none" stroke="${b.color}"`
          + ` stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`);
      }
      // Gridlines over the fills, faint: at 50% a single position becomes the
      // majority of the book.
      const grid = [25, 50, 75].map((t) => `<line x1="0" x2="1000" y1="${100 - t}" y2="${100 - t}"`
        + ` stroke="rgba(237,239,241,${t === 50 ? 0.22 : 0.1})" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join("");
      // The vault stack's target over the bands: one dashed line per boundary
      // between vaults, in one neutral colour, never a vault's hue.
      const target = this.isVaultStack()
        ? this.vaultTargetLines().map((points) => `<polyline data-token="target" points="${points}" fill="none" style="stroke:var(--color-text-soft)"`
          + ` stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`).join("")
        : "";
      return `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">${fills.join("")}${edges.join("")}${grid}${target}</svg>`;
    },
    chartLabel() {
      const m = this.chartModel();
      if (!m) return "";
      const named = m.series.map((b) => `${b.label ?? b.token} ${this.fmtPct1(b.shares[b.shares.length - 1] || 0)}`).reverse().join(", ");
      const span = `${m.rows[0].date} to ${m.rows[m.rows.length - 1].date}`;
      if (this.isVaultStack()) {
        const t = this.stackTargetAt(m.rows[m.rows.length - 1].date);
        const target = t ? ` ${this.stackTargetName()}: ${VAULTS.map((v) => `${v.symbol} ${this.fmtPctTrim(t[v.slug] / 100)}`).join(", ")}.` : "";
        const dated = `${this.formatDate(m.rows[0].date, "short")} to ${this.formatDate(m.rows[m.rows.length - 1].date, "short")}`;
        return `Share of the book by vault, stacked to 100%, ${dated}. Latest reading, top band first: ${named}.${target} Use the arrow keys to step through the readings.`;
      }
      return `Share of the book by position, stacked to 100%, ${span}. Latest reading, top band first: ${named}. Use the arrow keys to step through the readings.`;
    },
    // A tick under every reading, month and day; the ones between the ends drop
    // out on a narrow screen. The last reading's year is the positions label's
    // above the chart, so the first tick carries its own year only when it
    // differs (windowed() can fall back to two readings a year or more apart).
    // Past eight readings only every step-th is dated, or 69 dates print over
    // one another (the vault subject on production); the rest show under the
    // crosshair.
    chartXTicks() {
      const m = this.chartModel();
      if (!m) return [];
      const last = m.rows.length - 1;
      const step = Math.max(1, Math.ceil(m.rows.length / 8));
      const dated = (i) => i % step === 0 && last - i >= step / 2;
      const md = (d) => { try { return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); } catch (_) { return d; } };
      const lastYear = String(m.rows[last]?.date || "").slice(0, 4);
      return m.rows.map((r, i) => ({
        key: `${r.date}-${i}`,
        left: m.xs[i] / 10,
        label: i === 0 && String(r.date || "").slice(0, 4) !== lastYear ? this.formatDate(r.date, "short") : md(r.date),
        i,
        cls: i === 0 ? "is-first" : i === last ? "is-last" : dated(i) ? "is-mid" : "is-mid is-sparse",
      }));
    },
    // One reading, for the crosshair and its tooltip: every band's share on
    // that date, top band first, as the stack reads.
    chartPoint(i) {
      const m = this.chartModel();
      if (!m || i == null || !m.rows[i]) return null;
      const snap = m.rows[i];
      const total = Number(snap?.total_value_usd ?? snap?.totalValueUsd);
      return {
        left: m.xs[i] / 10,
        date: this.formatDate(snap.date, "short"),
        total: Number.isFinite(total) && total > 0 ? this.fmtUsd(total) : "",
        // Positions the book did not hold on that date are left out.
        items: m.series.filter((b) => (b.shares[i] || 0) >= 0.0005)
          .map((b) => ({ token: b.token, label: b.label ?? (b.token === OTHER_TOKEN ? "Other" : b.token), color: b.color, mark: b.mark, pct: this.fmtPct1(b.shares[i] || 0) })).reverse(),
      };
    },
    // The crosshair snaps to the nearest reading under the pointer.
    chartMove(ev) {
      const m = this.chartModel();
      if (!m) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      const at = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 1000;
      let best = 0;
      for (let i = 1; i < m.xs.length; i++) if (Math.abs(m.xs[i] - at) < Math.abs(m.xs[best] - at)) best = i;
      this.chartAt = best;
    },
    chartKey(ev) {
      const m = this.chartModel();
      if (!m) return;
      const last = m.rows.length - 1;
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        const from = this.chartAt ?? (ev.key === "ArrowRight" ? -1 : last + 1);
        this.chartAt = Math.max(0, Math.min(last, from + (ev.key === "ArrowRight" ? 1 : -1)));
      } else if (ev.key === "Home") { ev.preventDefault(); this.chartAt = 0; }
      else if (ev.key === "End") { ev.preventDefault(); this.chartAt = last; }
      else if (ev.key === "Escape") { this.chartAt = null; }
    },
    // A band in focus (from the legend): the others recede, as the ring's arcs
    // do. Classes, not a redraw, so the fade runs on a transition.
    syncBands(host) {
      for (const el of host.querySelectorAll("[data-token]")) {
        el.classList.toggle("is-muted", this.chartFocus !== null && el.getAttribute("data-token") !== this.chartFocus);
      }
    },
    // ── the vault stack (the Robot Money Vault subject) ──────────────────────
    // A PortfolioRouter and four leg vaults, one per sleeve. Its Holdings is
    // one book grouped by vault: the total is the four vaults' sum, the ring
    // is each vault's actual weight against the weights in force, and the
    // chart stacks the vaults in their sleeves' hues with that target drawn
    // over them. Every read below goes through stackSnapshots() and
    // stackWalletList(), which are the devnet fixture's when the switch is on
    // and the subject's own book otherwise.
    isVaultStack() { return this.subject?.id === VAULT_SUBJECT_ID; },
    // The page's lede. The vault's thesis_blurb is agent-facing session
    // context written for the single Base vault, with the weights in it; the
    // page states the subject only, however many vaults are live.
    subjectLede() {
      if (this.isVaultStack()) return "Depositor capital in the Robot Money vaults, one per sleeve. Distinct from the treasury wallet, which holds protocol-owned capital.";
      return this.subject?.thesisBlurb || "";
    },
    // The devnet fixture's book is on (lib/vault-source.js): Holdings is test
    // data, while the latest recommendation still reads the real book.
    stackOnDevnet() { return this.isVaultStack() && !!this.vaultSnapshots; },
    stackSnapshots() { return this.vaultSnapshots ?? this.snapshots; },
    stackSnapshot() {
      if (!this.vaultSnapshots) return this.snapshot;
      const list = this.vaultSnapshots;
      return list.length ? normalizeSnapshot(list[list.length - 1]) : null;
    },
    stackWalletList() {
      if (this.vaultWallets) return this.vaultWallets;
      return (this.subject?.wallets?.length ? this.subject.wallets : this.snapshot?.wallets) || [];
    },
    // The fixture labels the devnet book; the subject's own book carries none.
    vaultStackLabel() { return this.vaultSnapshots ? DEVNET_LABEL : null; },
    // The vault a position sits in. A book read before positions named their
    // vault is the single rmUSDC vault's; once any position names one, a
    // position that does not is unassigned rather than guessed.
    vaultOf(p, snap) {
      const named = String(p?.vault ?? "").toLowerCase();
      if (VAULT_SLUGS.includes(named)) return named;
      const anyNamed = (snap?.positions || []).some((x) => x?.vault != null && x.vault !== "");
      return anyNamed ? null : "rmusdc";
    },
    // Each vault's value on one reading, and the unassigned rest.
    vaultValuesOf(snap) {
      /** @type {Record<string, number>} */
      const out = {};
      let unassigned = 0;
      for (const p of snap?.positions || []) {
        const value = Number(p?.value_usd ?? p?.valueUsd) || 0;
        const v = this.vaultOf(p, snap);
        if (v) out[v] = (out[v] || 0) + value;
        else unassigned += value;
      }
      return { byVault: out, unassigned };
    },
    // Read from: the router (it holds nothing, so no value) and each vault
    // with its sleeve and its value on the latest reading. A wallet that
    // predates `kind` is the rmUSDC vault when it is rmUSDC's Base address.
    stackWallets() {
      const snap = this.stackSnapshot();
      const { byVault } = this.vaultValuesOf(snap);
      const rank = (w) => (w.kind === "router" ? -1 : w.vault ? VAULT_SLUGS.indexOf(w.vault) : VAULT_SLUGS.length);
      return this.stackWalletList().filter(Boolean).map((w) => {
        let kind = w.kind === "router" || w.kind === "vault" ? w.kind : null;
        let id = kind === "vault" ? vaultBySlug(w.vault) || vaultForBucket(w.sleeve) : null;
        if (!kind && String(w.address || "").toLowerCase() === VAULTS[0].baseAddress) {
          kind = "vault";
          id = VAULTS[0];
        }
        const value = kind === "vault" && id && byVault[id.slug] != null ? byVault[id.slug] : null;
        return {
          kind,
          // The router by its role, whatever the feed calls it (the class
          // name, PortfolioRouter, is not a reader's word).
          name: id ? id.symbol : kind === "router" ? "Router" : w.label || w.name || "",
          vault: id ? id.slug : null,
          sleeve: id ? (vaultForBucket(w.sleeve) || id).name : "",
          color: id ? id.color : null,
          chain: w.chain || "",
          address: w.address || w.addr || "",
          value,
        };
      }).sort((a, b) => rank(a) - rank(b));
    },
    // The chains the stack is read on: the wallets', else the positions'.
    stackChains() {
      const chains = this.stackWallets().map((w) => w.chain);
      for (const p of this.stackSnapshot()?.positions || []) chains.push(p?.chain);
      return [...new Set(chains.filter(Boolean).map((c) => String(c)))];
    },
    // A Chain column only when the stack spans more than one chain; with one,
    // the total's line names it once.
    stackMultiChain() { return this.stackChains().length > 1; },
    // An Address column only when some row has an address to show.
    stackHasAddress() { return this.stackWallets().some((w) => !!w.address); },
    // The total's line: the chain it is read on and the reading's date, so a
    // total that differs from a vault page's names its own date.
    vaultStatSub() {
      return [
        this.stackChains().map((c) => this.chainLabel(c)).join(", "),
        this.stackSnapshot()?.date ? this.formatDate(this.stackSnapshot().date, "short") : "",
      ].filter(Boolean).join(" · ");
    },
    // The latest reading grouped by vault, in published order, each with its
    // value, its share of the book and its positions (largest first, each a
    // share of the book). Positions with no vault close the list as
    // "Unassigned", so the groups always add up to the total.
    vaultGroups() {
      const snap = this.stackSnapshot();
      const total = Number(snap?.totalValueUsd) || 0;
      const rows = (snap?.positions || []).map((p) => {
        const value = Number(p?.value_usd ?? p?.valueUsd) || 0;
        const vaultSlug = this.vaultOf(p, snap);
        // The name the vault's own page gives the position.
        return { ...p, vaultSlug, label: positionName(p, vaultSlug), value, share: total > 0 ? value / total : 0 };
      });
      const group = (identity, positions) => {
        const value = positions.reduce((n, p) => n + p.value, 0);
        return { ...identity, value, share: total > 0 ? value / total : 0, positions: positions.slice().sort((a, b) => b.value - a.value) };
      };
      const groups = VAULTS
        .map((v) => ({ v, positions: rows.filter((r) => r.vaultSlug === v.slug) }))
        .filter((g) => g.positions.length)
        .map((g) => group(g.v, g.positions));
      const rest = rows.filter((r) => !r.vaultSlug);
      if (rest.length) groups.push(group({ slug: "unassigned", symbol: "Unassigned", name: "", color: null }, rest));
      return groups;
    },
    // The weights in force on `date`, in basis points by vault slug: the
    // router's applied weights once they were applied, else the published
    // framework target in force that day. null when neither is complete, and
    // until the vault overview has answered.
    stackTargetAt(date) {
      return this.stackTargetOf(date)?.by ?? null;
    },
    // The same, with where it came from: "applied" (the router's weights) or
    // "target" (the framework's).
    stackTargetOf(date) {
      if (!this.vaultStackSettled || !date) return null;
      const day = String(date).slice(0, 10);
      const ov = this.vaultStack?.overview;
      if (ov) {
        const applied = VAULTS.map((v) => ov.vaults.find((r) => r.slug === v.slug)?.appliedBps ?? null);
        const at = String(ov.router?.appliedAt || "").slice(0, 10);
        if (layerComplete(applied) && at && at <= day) {
          return { basis: "applied", by: Object.fromEntries(VAULTS.map((v, i) => [v.slug, applied[i]])) };
        }
      }
      const fw = targetsInForce(this.allocationFw, day);
      if (!fw) return null;
      /** @type {Record<string, number>} */
      const out = {};
      for (const [key, pct] of Object.entries(fw)) {
        const v = vaultForBucket(key);
        if (v) out[v.slug] = Math.round(Number(pct) * 100);
      }
      return layerComplete(VAULTS.map((v) => out[v.slug])) ? { basis: "target", by: out } : null;
    },
    // The chart legend's name for the line over the bands: "Applied" when
    // every reading it is drawn on used the router's weights, else "Target".
    stackTargetName() {
      const m = this.chartModel();
      const bases = (m?.rows || []).map((r) => this.stackTargetOf(r.date)?.basis).filter(Boolean);
      return bases.length && bases.every((b) => b === "applied") ? "Applied" : "Target";
    },
    // The ring: all four vaults, each at its actual weight on the latest
    // reading, against the target in force on that date.
    // Each row names its reference ("target 95%", "applied 70%") and prints
    // no delta: the latest recommendation above already gives the gap, and a
    // second one here, measured the other way round, would point the other
    // way.
    vaultRingRows() {
      const snap = this.stackSnapshot();
      const groups = this.vaultGroups();
      const target = snap ? this.stackTargetOf(snap.date) : null;
      return VAULTS.map((v) => {
        const g = groups.find((x) => x.slug === v.slug);
        const pct = g ? g.share * 100 : 0;
        const was = target ? target.by[v.slug] / 100 : null;
        return {
          key: v.slug, label: v.symbol, hue: v.color, pct, meta: "",
          was, basis: target?.basis ?? "target", action: "", rationale: "",
          assets: (g?.positions || []).map((p) => ({
            key: `${v.slug}-${p.token}-${p.chain}`,
            label: positionName(p, v.slug),
            colour: null,
            ofSleeve: g && g.value > 0 ? (p.value / g.value) * 100 : null,
          })),
        };
      });
    },
    // The chart's bands: each vault's share of the book on every reading, in
    // published order, a vault that holds nothing across the window left out.
    // What no vault accounts for is the residual band.
    vaultSeries() {
      const rows = this.windowed();
      if (rows.length < 2) return [];
      const shares = rows.map((snap) => {
        const total = Number(snap?.total_value_usd ?? snap?.totalValueUsd ?? 0);
        const { byVault } = this.vaultValuesOf(snap);
        return (slug) => (total > 0 ? (byVault[slug] || 0) / total : 0);
      });
      const bands = VAULTS
        .map((v) => ({ token: v.slug, label: v.symbol, color: v.color, mark: "series", shares: shares.map((at) => at(v.slug)) }))
        .filter((b) => b.shares.some((s) => s > 0));
      if (!bands.length) return [];
      const other = rows.map((_, i) => Math.max(0, 1 - bands.reduce((sum, b) => sum + b.shares[i], 0)));
      if (other.some((v) => v > 0.005)) bands.push({ token: OTHER_TOKEN, label: "Other", color: OTHER_COLOR, mark: undefined, shares: other });
      return bands;
    },
    // The target over the bands, as the SVG points of each dashed line: one
    // per boundary between neighbouring vaults, stepping at the reading where
    // the target changes and broken where there is none. A boundary at 0 or
    // 100% on every reading is the chart's own edge, and two boundaries that
    // coincide (a vault targeted at 0%) are drawn once.
    vaultTargetLines() {
      const m = this.chartModel();
      if (!m) return [];
      const targets = m.rows.map((r) => this.stackTargetAt(r.date));
      const seen = new Set();
      const out = [];
      for (let k = 1; k < VAULTS.length; k++) {
        const cum = targets.map((t) => (t ? VAULTS.slice(0, k).reduce((n, v) => n + t[v.slug], 0) / 100 : null));
        if (cum.every((c) => c == null || c <= 0 || c >= 100)) continue;
        const segments = [];
        let seg = null;
        cum.forEach((c, i) => {
          if (c == null) { seg = null; return; }
          if (!seg) { seg = []; segments.push(seg); } else seg.push([m.xs[i], cum[i - 1]]);
          seg.push([m.xs[i], c]);
        });
        const lines = segments.filter((s) => s.length > 1)
          .map((s) => s.map(([x, c]) => `${x.toFixed(1)},${(100 - c).toFixed(2)}`).join(" "));
        const sig = lines.join("|");
        if (!sig || seen.has(sig)) continue;
        seen.add(sig);
        out.push(...lines);
      }
      return out;
    },
    vaultUsd(v) { return fmtVaultUsd(v); },
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
        address: n.address || "",
      }));
    },
    // A table row names a token, so it takes that token's hue: the one the
    // ring and the chart give it. Only a position neither figure names is grey.
    positionColor(token) { return this.bookPalette()[token] || OTHER_COLOR; },
    // Everything the book is read from, in one list: the tracked wallets, then
    // the NFT contracts the operator declared (which are not valued).
    bookSources() {
      return [
        ...this.trackedWallets().map((w) => ({ name: w.label || "wallet", kind: "Wallet", chain: w.chain, address: w.address })),
        ...this.nftContracts().map((n) => ({ name: n.name, kind: "NFT contract", chain: n.chain, address: n.address })),
      ];
    },
    // The chains the book is read on, in the order its wallets list them.
    walletChains() {
      return [...new Set(this.trackedWallets().map((w) => w.chain).filter(Boolean))];
    },
    // What the total spans and leaves out that the page does not already say:
    // the chains (both tables drop their Chain column on a phone) and the NFT
    // contracts it does not value. The date is the positions table's label and
    // the count is its rows, so the date stays only when there is no table.
    bookStatSub() {
      const nft = this.nftContracts().length;
      return [
        this.positionRows().length ? "" : this.formatDate(this.snapshot?.date, "short"),
        this.walletChains().map((c) => this.chainLabel(c)).join(", "),
        nft ? `${nft === 1 ? "NFT contract" : "NFT contracts"} not valued` : "",
      ].filter(Boolean).join(" · ");
    },
    // An address on a chain whose explorer is known. Base only for now; other
    // chains print the address without a link rather than guess a URL.
    explorerHref(chain, address) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) return "";
      return String(chain).toLowerCase() === "base" ? `https://basescan.org/address/${address}` : "";
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
    sort: "newest",  // see sortedBy(): newest | oldest | confidence
    now: Date.now(), // stamped once — a track record does not need a ticker
    openTakes: {},   // take id → expanded
    shown: 20,       // rows listed; "Show more" adds 20, a new sort or filter resets it
    // #687: the ref that failed to resolve, and the full roster to land on
    // instead of a blank profile. Kept distinct from `error` — this is not a
    // failure, it is the deliberate not-found render, and the two states show
    // different markup.
    notFound: false,
    attemptedRef: null,
    members: [],
    // subject id → the subject record's name. A take row carries the name its
    // session was filed under, which can lag a rename; /swarm and the subject
    // page print the record's name, so this page does too.
    subjectNames: {},
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
        // Both sources missed (issue #687). The route already answered this
        // request 404 (backend/src/api/routes/swarm.ts) — that status is what
        // makes "not found" deliberate rather than an accidental 200, and it is
        // recorded there rather than re-derived here. The old behaviour threw
        // into a blank error page; this renders the swarm roster in place
        // instead, at the URL the visitor actually requested, and keeps the
        // failed ref on screen (attemptedRef) for a future "did you mean"
        // affordance — deliberately not built here (out of scope per #687).
        if (!this.member) {
          this.notFound = true;
          this.attemptedRef = memberId;
          // The route-level title titleizes the missed ref, which names a
          // member who does not exist ("Nobody Here").
          if (location.pathname === routeAtEntry) document.title = "Member not found: Robot Money Investment Swarm";
          const res = await api.get(ROUTES.swarm.members).catch(() => null);
          // The shipped archive's members stand in when the API is not there,
          // so the roster still lists who the swarm is.
          this.members = res?.members
            || (await Promise.all(KNOWN_ARCHIVE_MEMBERS.map((id) => loadArchiveMember(id).catch(() => null)))).filter(Boolean);
          return;
        }
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
        try {
          const ids = [...new Set(this.rows.map((r) => r.session.subjectId).filter(Boolean))];
          const subs = await Promise.all(ids.map(async (id) => (await api.get(path(ROUTES.swarm.subject, { id })).then(camelSubject).catch(() => null)) || loadArchiveSubject(id).catch(() => null)));
          this.subjectNames = Object.fromEntries(ids.map((id, i) => [id, subs[i]?.name]).filter(([, n]) => n));
        } catch (_) { /* the stored names stand */ }
      } catch (_) {
        this.error = "This member's record could not be loaded.";
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
        const res = await api.get(`${path(ROUTES.swarm.memberTakes, { id: memberId })}?limit=${MEMBER_TAKES_MAX}`);
        const rows = (res.takes || []).map((r) => ({
          session: { date: r.sessionDate, subjectId: r.subjectId, subjectName: r.subjectName, state: r.sessionState },
          // camelTake, not the raw row: raw takes carry no `permalinkId`, only
          // `id`/`member_id`, so takeHref() silently returned null for every
          // take on this page and the "Verification receipt" link vanished.
          take: camelTake(r.take),
          phase: this.takePhase(r.sessionState),
        }));
        // This route serves a session's state and not its deadline, so an
        // overdue `collecting` row read as open here and as closed on /swarm
        // and the session page (#570). The few rows still collecting read the
        // deadline from their session, matched on the take itself.
        await Promise.all(rows.filter((r) => r.phase === "live").map(async (r) => {
          try {
            const d = await api.get(path(ROUTES.swarm.session, { date: r.session.date, subject: r.session.subjectId }));
            if (!(d?.takes || []).some((t) => t.id === r.take.id)) return;
            r.session.windowClosesAt = camelSession(d.session).windowClosesAt;
            r.phase = this.rowPhase(r.session);
          } catch (_) { /* the state stands */ }
        }));
        return rows;
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
      // The shipped archive stands in for the index when the API is not there
      // (a backendless checkout), the same fallback the session and subject
      // pages take, so a member's archived record still reads.
      let all;
      try {
        all = (await api.get(ROUTES.swarm.sessions)).sessions || [];
      } catch (_) {
        all = ((await fetchJson("/data/swarm/sessions/index.json")).sessions || [])
          .map((s) => ({ date: s.date, subjectId: s.subjectId ?? s.subject_id, subjectName: s.subjectName ?? s.subject_name ?? s.subject_id, state: "published" }))
          .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      }
      const inProgress = all.filter((s) => ["collecting", "window_closed", "aggregated", "judged"].includes(s.state));
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
          return take ? { session, take, phase: this.rowPhase(session) } : null;
        })
        .filter(Boolean);
    },
    takePhase(state) {
      if (state === "collecting") return "live";
      if (state === "window_closed" || state === "aggregated" || state === "judged") return "closing";
      return "published";
    },
    // Only `collecting` turns on the deadline (lib/session-phase.js): past it,
    // the window is shut whatever the row says, and nothing is working on it.
    rowPhase(session) {
      const p = this.takePhase(session?.state);
      if (p !== "live" || !session?.windowClosesAt) return p;
      return sessionPhase(session).isOpen ? "live" : "closed";
    },
    // The same three words the swarm index, the apply page and the session
    // page use, from lib/session-phase.js. This page said "Collecting · window
    // open" where they said "collecting", which is one session reading as two
    // states depending on which page you were standing on. The pulsing mark on
    // .rm-sphase--open now carries what the extra words were carrying.
    //
    // An overdue `collecting` row reads "closed", as it does on /swarm and
    // the session page (rowPhase()).
    phaseLabel(phase) {
      return phase === "live" ? "collecting"
        : phase === "closing" ? "aggregating"
        : phase === "closed" ? "closed"
        : "published";
    },
    phaseChipClass(phase) {
      const key = phase === "live" ? "open" : phase === "closing" ? "aggregating" : phase === "closed" ? "closed" : "published";
      return `rm-sphase rm-sphase--${key}`;
    },
    allTakes() { return this.member ? this.rows : []; },
    // At the route's ceiling there may be more: the counts are the latest ones.
    takesCapped() { return this.allTakes().length >= MEMBER_TAKES_MAX; },
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
        else by.set(r.session.subjectId, { id: r.session.subjectId, name: this.subjectNameOf(r.session), count: 1 });
      }
      return [...by.values()].sort((a, b) => b.count - a.count);
    },
    subjectNameOf(s) { return this.subjectNames[s?.subjectId] || s?.subjectName || s?.subjectId || ""; },
    // ── When ─────────────────────────────────────────────────────────────────
    // TWO CLOCKS reach this page and they are not the same fact: the session's
    // date (when the room convened, and what every /swarm URL is keyed on) and
    // the take's `receivedAt` (when THIS member filed). They agree on 46 of a
    // member's 50 most recent rows; the four that differ are sessions convened
    // for a past date and filed against later.
    //
    // This page is about the member, so it reads the member's clock, and it
    // both SORTS and LABELS on that one — a list ordered by a stamp it does not
    // show is the thing that made the old bare date hard to scan: three rows
    // saying "Aug 27, 2026" in an order nothing on screen accounted for.
    // The session's date is still one hover away, and one click away.
    filedAt(row) { return row?.take?.receivedAt || row?.session?.date || null; },
    // Friendly inside a day, exact past it — and past it the TIME comes with
    // the date, because a member files against several portfolios a day and a
    // bare date leaves three rows saying the same thing in an order nothing
    // accounts for. That is the whole complaint, and "1d ago" repeats it: the
    // relative scale coarsens to days exactly where the ambiguity starts.
    // timeAgo is also unbounded by design (it sits beside a countdown
    // elsewhere), and "217d ago" is a worse answer than a date.
    // Year only when it is not this one — 20 rows do not each need "2026".
    filedLabel(row) {
      const v = this.filedAt(row);
      if (!v) return "—";
      const t = Date.parse(String(v));
      if (!Number.isFinite(t)) return this.formatDate(v, "short");
      if (this.now - t < 24 * 60 * 60 * 1000) return timeAgo(v, this.now) || this.formatDate(v, "short");
      const d = new Date(t);
      const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      const year = d.getUTCFullYear() === new Date(this.now).getUTCFullYear() ? "" : `, ${d.getUTCFullYear()}`;
      return `${day}${year} ${d.toISOString().slice(11, 16)}`;
    },
    // Both clocks, stated, behind the one that is shown.
    filedTitle(row) {
      const abs = absoluteUtc(this.filedAt(row));
      const session = this.formatDate(row?.session?.date, "long");
      return abs ? `Filed ${abs} · ${session} session` : `${session} session`;
    },

    // ── Sort ─────────────────────────────────────────────────────────────────
    // Newest is the default and the only one the record had. Oldest answers
    // "what did this member open with"; confidence answers "what has it argued
    // hardest", which is the question the Avg confidence figure above raises
    // and could not previously be followed up on.
    setSort(key) { this.sort = key; this.shown = 20; },
    sortedBy(rows) {
      const at = (r) => Date.parse(String(this.filedAt(r) || "")) || 0;
      const copy = [...rows];
      if (this.sort === "oldest") return copy.sort((a, b) => at(a) - at(b));
      if (this.sort === "confidence") {
        return copy.sort((a, b) =>
          (Number(b.take?.confidence) || 0) - (Number(a.take?.confidence) || 0) || at(b) - at(a));
      }
      return copy.sort((a, b) => at(b) - at(a));
    },
    // The rows actually listed. Kept separate from recentTakes() so the empty
    // states stay keyed to the whole record: a filter that matches nothing is a
    // narrowed view, not a member who has never submitted.
    visibleTakes() {
      const rows = this.recentTakes();
      return this.sortedBy(this.subject ? rows.filter((r) => r.session.subjectId === this.subject) : rows);
    },
    filterBy(subjectId) { this.subject = this.subject === subjectId ? null : subjectId; this.shown = 20; },

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
    // The review band's vote and the recommendation ring, shared with /swarm
    // and the subject page. Spread BEFORE this page's own keys, and nothing
    // below redefines a name it carries: an own method of the same name would
    // silently replace the one its siblings call through `this`.
    ...sessionSummary,
    ...sessionBrief(),
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
    // subject id → name, for the brief's recent-session refs, which carry ids.
    subjectNames: {},
    // The sessions either side of this one on the same subject, for the
    // record's own prev/next. Filled after render.
    neighbours: { older: null, newer: null },
    // A 404, as opposed to a load that failed: retrying cannot find a session
    // that does not exist, so the page offers no retry for it.
    notFound: false,
    // A failed load offers a retry instead of a dead end.
    retry() {
      this.error = null;
      this.notFound = false;
      this.loading = true;
      this.session = null;
      this.init();
    },
    // The clock behind an open window's countdown, on /swarm's cadence.
    now: Date.now(),
    clock: null,
    destroy() {
      if (this.clock) { clearInterval(this.clock); this.clock = null; }
    },
    // A session still in its window, stated as /swarm's live strip states it,
    // so the reader who followed "See full session" finds the same count and
    // deadline here.
    isLive() {
      const k = this.session ? sessionPhase(this.session, this.now).key : "";
      return k === "open" || k === "aggregating" || k === "closed";
    },
    filedCount() {
      return this.isLive() && this.members.length ? `${this.takes.length} of ${this.members.length}` : String(this.takes.length);
    },
    windowLeft() { return this.isLive() ? timeLeft(this.session?.windowClosesAt, this.now) : ""; },
    windowAgo() { return this.isLive() ? timeAgo(this.session?.windowClosesAt, this.now) : ""; },
    windowAt() { return absoluteUtc(this.session?.windowClosesAt); },
    async init() {
      if (!this.clock) this.clock = setInterval(() => { this.now = Date.now(); }, 30 * 1000);
      const routeAtEntry = location.pathname;
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
          this.loadEvidence();
          this.syncTitle(routeAtEntry);
        } catch (e) {
          this.notFound = /** @type {any} */ (e)?.status === 404;
          this.error = this.notFound ? "Session not found." : "This session could not be loaded.";
        } finally {
          this.loading = false;
        }
        return;
      }
      const match = location.pathname.match(/^\/swarm\/(\d{4}-\d{2}-\d{2})\/([^/]+)/);
      if (!match) {
        this.notFound = true;
        this.error = "Session not found.";
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
        this.loadEvidence();
        this.syncTitle(routeAtEntry);
      } catch (primary) {
        try {
          // Fall back to the static archive. It only carries dates through
          // ARCHIVE_LAST_DATE, so archivePreferred() is what decides whether
          // falling back is even worth attempting.
          if (!archivePreferred(date)) throw primary;
          await this.loadArchive(date, subject);
          this.loadEvidence();
          this.syncTitle(routeAtEntry);
        } catch (_) {
          // Not found when the API said so, or when the date is one the archive
          // covers and it has no such session; any other failure can be retried.
          this.notFound = /** @type {any} */ (primary)?.status === 404 || archivePreferred(date);
          this.error = this.notFound ? "Session not found." : "This session could not be loaded.";
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
      // Same band the subject profile draws, fed this session's own reading.
      this.setBackdrop(this.session?.regimeSummary, { date: this.session?.date, v0: this.readingIsV0(this.session) });
      this.subject = await loadArchiveSubject(subject).catch(() => null);
      // A framework has no book: see loadApi().
      this.snapshot = this.isFramework() ? null : await loadArchiveSnapshot(subject, date);
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
      // The brief THIS session opened with. Asked for by date, the API answers
      // with that day's latest brief, which is the right one for the dated
      // address (it opens the day's latest session) and the wrong one for an
      // earlier session of the same day reached by its id (#965).
      const sessionId = preloaded?.session?.id;
      const briefQuery = sessionId ? { session: sessionId } : { date, subject };
      // Each side-fetch is independently guarded so a missing subject, snapshot,
      // brief, roster or framework never breaks the session render.
      const [detail, memberData, brief, subjectData, snapshotData, allocation, framework] = await Promise.all([
        preloaded ?? api.get(path(ROUTES.swarm.session, { date, subject })),
        // Guarded like the rest. It was the one side-fetch that was not, so a
        // roster that failed to load took the whole session down with it.
        api.get(ROUTES.swarm.members).catch(() => ({ members: [] })),
        api.get(ROUTES.swarm.brief, briefQuery).catch(() => null),
        api.get(path(ROUTES.swarm.subject, { id: subject })).catch(() => null),
        api.get(path(ROUTES.swarm.subjectSnapshots, { id: subject })).catch(() => null),
        // The allocation framework supplies the TARGET weight each bucket is
        // measured against when the brief did not hand the session one.
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
      this.setBackdrop(this.session?.regimeSummary, { date: this.session?.date, v0: this.readingIsV0(this.session) });
      this.members = (memberData?.members || []).map(camelMember);
      // The API answers 200 with a null body for a subject it does not hold,
      // which is every subject on a stack seeded without them. The checked-in
      // manifest is what says whether this is a framework, so it is read the
      // same way subjectProfile reads it.
      this.subject = (subjectData ? camelSubject(subjectData) : null) || await loadArchiveSubject(subject).catch(() => null);
      // A FRAMEWORK subject has no book, so it gets none, as on its subject
      // page. The release smoke writes a fake basket into
      // swarm_subject_snapshots for every subject that is not woon or mav, so
      // this page drew "Portfolio read · $42,688" for robotmoney-allocation,
      // whose own notes open with "no portfolio to scrape", and measured the
      // recommendation's gaps against that invented book.
      this.snapshot = this.isFramework() ? null : pickSnapshotFor(snapshotData?.snapshots, date);
      this.brief = brief;
      this.allocation = allocation;
      this.allocationFramework = framework;
      this.subjectNames = { [this.session?.subjectId]: this.session?.subjectName };
      const body = brief?.body || brief;
      if ((body?.recentSessions || []).some((/** @type {any} */ r) => r?.subject_id && r.subject_id !== this.session?.subjectId)) {
        this.loadSubjectNames();
      }
    },
    // The live brief's recent-session refs name their subjects by id. The
    // sessions list is the one public read that pairs an id with a name, the
    // same list the subject page names them from. Not awaited: the refs read
    // as ids until it lands, and as ids for good if it does not.
    async loadSubjectNames() {
      try {
        const all = (await api.get(ROUTES.swarm.sessions)).sessions || [];
        const names = { ...this.subjectNames };
        for (const x of all) {
          const sid = x.subjectId ?? x.subject_id;
          const name = x.subjectName ?? x.subject_name;
          if (sid && name && !names[sid]) names[sid] = name;
        }
        this.subjectNames = names;
      } catch (_) { /* ids stand in for names */ }
    },
    isFramework() { return this.subject?.source?.type === "framework"; },
    subjectHref() {
      const id = this.session?.subjectId || this.subject?.id;
      return id ? `/swarm/subjects/${encodeURIComponent(id)}` : "/swarm";
    },
    // The subject record's name, as /swarm and the subject page print it. The
    // session stores the name it was filed under, which can lag a rename, so
    // it is only the fallback when the subject record did not load.
    subjectTitle() { return this.subject?.name || this.session?.subjectName || this.session?.subjectId || ""; },
    // Route-level SEO titleizes the URL's slug ("Robotmoney Allocation"). Name
    // the tab after the subject and the session's date once both are known,
    // unless the visitor has already moved on: the loads are not cancelled
    // when the router tears this view down.
    /** @param {string} routeAtEntry */
    syncTitle(routeAtEntry) {
      const name = this.subjectTitle();
      if (!name || !this.session?.date || location.pathname !== routeAtEntry) return;
      document.title = `${name}, ${this.formatDate(this.session.date, "short")}: Robot Money Investment Swarm`;
    },
    // The session in the shape the shared review band reads (lib/
    // session-summary.js): the record, with its takes on it as `takeRows`.
    reviewRow() {
      return this.session ? { ...this.session, takeRows: this.takes } : null;
    },
    hasReview() {
      const row = this.reviewRow();
      return Boolean(row) && (this.signalRows().length > 0 || this.voteTotal(row) > 0);
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
    isRollupRecommendation() {
      const rec = this.session?.swarmRecommendation;
      return !!(rec && (rec.quorum || rec.stances));
    },
    // The recommendation's own prose, or "" when it cannot be trusted.
    //
    // On a rollup the aggregator writes `rationale` from a template over the
    // stance tally, the mean confidence and the regime percentile
    // (domain.ts buildRationale), every one of which the review band draws. v0
    // sessions carry a rationale somebody wrote, and that one is the reason
    // behind the weights.
    // The rule itself is sessionSummary.rationaleOf(), so the subject page and
    // /swarm apply the same one.
    recommendationRationale() {
      return this.rationaleOf(this.session);
    },
    // The recommendation's `actions`, as the payload carries them. Rollups
    // aggregated between 2026-08-06 and 2026-09-04 carry the same two
    // hardcoded rows (USDC rotate, rmUSDC add) on every subject, derived from
    // no member input (pre-#752, D42 §9.7); v0 sessions carry actions their
    // members wrote. authoredActions() is the half this page draws.
    recommendationActions() {
      return this.session?.swarmRecommendation?.actions || [];
    },
    authoredActions() {
      if (this.isRollupRecommendation()) return [];
      return this.recommendationActions().filter((a) => a && a.action);
    },
    hasRecommendationDetail() {
      return !!(this.isBucketWeights() || this.recommendationActions().length || this.recommendationRationale());
    },
    // The largest position first, which the subject page's holdings table
    // already does. The table takes the first eight, and unsorted that was the
    // first eight the snapshot happened to list.
    positionRows() {
      const total = this.snapshot?.totalValueUsd || 0;
      return (this.snapshot?.positions || [])
        .map((p) => ({ ...p, share: total > 0 ? p.value_usd / total : 0 }))
        .sort((a, b) => b.share - a.share);
    },
    // The book's date, only when it is not the session's own: pickSnapshotFor
    // falls back to an earlier snapshot, or the latest when none precedes it.
    bookDate() {
      const d = String(this.snapshot?.date || "").slice(0, 10);
      return d && d !== String(this.session?.date || "").slice(0, 10) ? this.formatDate(d, "short") : "";
    },
    // Keyed the way the subject page keys the same book: named tokens keep the
    // colour they own and the rest take a free one, resolved over the rows
    // this table draws, so no two rows share a key.
    tokenColor(token) {
      const tokens = [...this.positionRows().slice(0, 8).map((p) => p.token), ...this.authoredActions().map((a) => a.token)];
      return resolveTokenColors([...new Set(tokens)])[token] || assetDot(token);
    },
    // The holdings table lists every position, and the palette keys eight.
    // A position past those, and not named by an action, goes grey instead of
    // hashing onto a hue a keyed row already wears.
    holdingColor(token) {
      const keyed = this.positionRows().slice(0, 8).some((p) => p.token === token) || this.authoredActions().some((a) => a.token === token);
      return keyed ? this.tokenColor(token) : OTHER_COLOR;
    },
    // The snapshot's notable lines, minus the ones that are the subject's own
    // operator notes, which the handover already prints under that name.
    notableItems() {
      const body = this.brief?.body || this.brief;
      const raw = body?.subject?.structuralNotes ?? body?.subject?.structural_notes ?? this.subject?.structuralNotes ?? [];
      const notes = new Set((Array.isArray(raw) ? raw : [raw]).map((n) => this.normText(n)).filter(Boolean));
      return (this.snapshot?.notable || []).filter((n) => !notes.has(this.normText(n)));
    },
    humanize(id) {
      return humanizeLabel(id);
    },
    // Normalize a bucket_weights recommendation into rows the outcome can draw.
    // Prefers explicit bucket rows (name/target/actual/recommended) if the
    // payload carries them; otherwise derives rows from the weights, joined to
    // a target and, when the book is known, to where it actually sits.
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
    // The targets THIS session was handed, from its own brief. The v0 brief
    // carries them (allocation.buckets); the live brief does not yet (#961).
    // They win over the published framework because they are what the swarm
    // was actually aiming at: the framework row is the CURRENT one, and it can
    // postdate the session it is being compared against.
    briefTargets() {
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const body = this.brief?.body || this.brief;
      const out = new Map();
      for (const b of body?.allocation?.buckets || []) {
        const w = Number(b?.target_weight ?? b?.targetWeight);
        if (!Number.isFinite(w)) continue;
        const t = { label: b.name || this.humanize(b.id), target: w };
        if (b.id) out.set(norm(b.id), t);
        if (b.name) out.set(norm(b.name), t);
      }
      return out;
    },
    // "brief" when the session's own brief named the targets, "framework" when
    // the published framework stands in for them, null when neither did.
    targetSource() {
      if (!this.bucketWeights().some((b) => b.target != null)) return null;
      return this.briefTargets().size ? "brief" : "framework";
    },
    bucketWeights() {
      const rec = this.session?.swarmRecommendation;
      if (!rec || rec.type !== "bucket_weights") return [];
      const num = (v) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
      // In the published order whatever order the payload keeps: jsonb stores
      // keys shortest first, so a map read back from the database listed
      // Conservative DeFi Yield last.
      const ranked = (rows) => rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => bucketRank(a.r.id || a.r.name) - bucketRank(b.r.id || b.r.name) || a.i - b.i)
        .map((x) => x.r);
      if (Array.isArray(rec.buckets) && rec.buckets.length) {
        return ranked(rec.buckets.map((b, i) => ({
          id: b.id || "",
          name: b.name || bucketLabel(b.id),
          hue: bucketHue(b.id || b.name, i),
          target: num(b.target ?? b.target_weight),
          actual: num(b.actual ?? b.actual_weight),
          // A sleeve published with no weight has none. Drawing it as 0% put a
          // move to zero on the page that the swarm never made.
          recommended: num(b.recommended ?? b.weight),
        })));
      }
      // Either shape the weights arrive in: the v0 map or the live array.
      const entries = weightEntries(rec.weights);
      if (!entries.length) return [];
      const handed = this.briefTargets();
      const targets = this.allocationTargets();
      const manifest = this.frameworkBuckets();
      const actuals = this.bucketActuals();
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return ranked(entries.map(([id, w], i) => {
        const brief = handed.get(norm(id)) ?? handed.get(norm(this.humanize(id)));
        const framework = targets.get(norm(this.humanize(id))) ?? targets.get(norm(id));
        const bucket = manifest.get(norm(id)) ?? manifest.get(norm(this.humanize(id)));
        // The live dashboard's target, with the published manifest behind it
        // so a backendless checkout still has something to compare against.
        const published = framework ? framework.target : (bucket ? bucket.target : null);
        return {
          // Prefer the framework's own spelling of the bucket name when it is
          // known; humanize() of an id cannot recover "DeFi".
          id,
          name: framework?.label || bucket?.name || brief?.label || bucketLabel(id),
          hue: bucketHue(id, i),
          // A brief that named any target names them all, so a sleeve it left
          // out has no target rather than borrowing the framework's.
          target: handed.size ? (brief ? brief.target : null) : published,
          actual: bucket ? (actuals.get(bucket.id) ?? null) : null,
          recommended: num(w),
        };
      }));
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
    //
    // bookSleeveShares() is the one implementation: the subject page's latest
    // recommendation reads the book through it too, so the two pages cannot
    // measure the same session against different things.
    bucketActuals() {
      return bookSleeveShares(this.allocationFramework, this.snapshot, this.session?.date);
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
    // Only a question for the published framework: v0's archive spans
    // 2026-05-25 onward and the framework's asOf is later than the earliest of
    // them, so a straight join measures a historical session against a target
    // that did not exist yet — and, because the framework is admin-editable, an
    // edit today silently rewrites yesterday's verdict on every archived
    // allocation session. A target the brief handed over cannot postdate it.
    targetPostdatesSession() {
      if (this.targetSource() !== "framework") return false;
      const asOf = this.allocationAsOf();
      const date = this.session?.date;
      return !!(asOf && date && String(date) < String(asOf).slice(0, 10));
    },
    // Whether the legend and the headline can state a move: there is a basis,
    // and it is not a target that postdates the session. A move from the book
    // never reads the target, so the target's date cannot withhold it; the
    // subject page's latest recommendation follows the same rule.
    gapIsFair() {
      const basis = this.gapBasis();
      return basis === "actual" || (basis === "target" && !this.targetPostdatesSession());
    },
    // Inside each sleeve, as /allocation's sleeve cards draw it: each sleeve
    // under its published name and hue with its recommended weight, and its
    // items in POLICY order, each in the colour its position gives it there
    // (so Morpho is one colour on both pages), under the name the brief or the
    // published framework gives it rather than the payload's slug.
    withinBucketWeights() {
      const sleeveWeight = new Map(this.bucketWeights().map((b) => [normKeyOf(b.id || b.name), b.recommended]));
      return withinBucketsFor(this.session?.swarmRecommendation, this.brief, this.allocationFramework, sleeveWeight);
    },
    // The explorer: the recommended mix on a weights subject, the book with
    // the session's actions on a portfolio subject.
    hasBook() { return !this.isBucketWeights() && !!this.snapshot && this.authoredActions().length > 0; },
    hasExplorer() { return this.isBucketWeights() || this.hasBook(); },
    explorerSource() { return this.reviewRow(); },
    explorerSvg() {
      return this.hasBook() ? this.ringSvg(this.explorerRows().map((r) => ({ ...r, colour: r.hue }))) : this.weightDonutSvg(this.reviewRow());
    },
    explorerLabel() {
      return this.explorerRows().filter((r) => r.pct > 0).map((r) => `${r.label} ${this.fmtPctTrim(r.pct)}`).join(", ");
    },
    // At rest a recommended mix's centre names the ring and nothing more: the
    // mix is the whole allocation by definition, so "100%" said nothing, and
    // it was wrong where the weights do not sum to 100 (ringSvg leaves that
    // ring open on purpose).
    explorerCenter() {
      return this.hasBook()
        ? { value: this.fmtUsdShort(this.snapshot?.totalValueUsd), label: "Holdings" }
        : { value: "", label: "Recommended" };
    },
    fmtUsdShort(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return "—";
      return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`;
    },
    explorerRows() {
      if (this.hasBook()) return bookExplorerRows(this.snapshot, this.authoredActions(), (t) => this.tokenColor(t), (v) => this.fmtUsd(v));
      const within = new Map(this.withinBucketWeights().map((w) => [normKeyOf(w.bucket), w]));
      const fair = this.gapIsFair();
      const basis = this.gapBasis() === "actual" ? "book" : "target";
      return this.bucketRows().map((b, i) => {
        const key = BUCKET_ORDER[bucketRank(b.id || b.name)] || String(b.id || b.name || i);
        const pct = b.recommended == null ? null : b.recommended * 100;
        const was = this.gapBasis() === "actual" ? b.actual : b.target;
        return {
          key, label: b.name, hue: b.hue, pct, meta: "", action: "", rationale: "",
          d: fair ? b.gap : null, was: fair && was != null ? was * 100 : null, basis,
          assets: explorerAssets(within.get(normKeyOf(b.id || b.name)) || within.get(normKeyOf(b.name)), pct),
        };
      });
    },
    isBucketWeights() {
      const rec = this.session?.swarmRecommendation;
      return !!(rec && rec.type === "bucket_weights" && this.bucketWeights().length);
    },
    // A subject whose recommendation is a set of weights: the framework, or a
    // subject declared bucket_weights. Its session that publishes none says "No
    // weights published", whatever type the payload claims; production's
    // weights subjects published position_actions rollups from August on.
    weightsSubject() {
      return this.isFramework() || this.session?.swarmRecommendation?.type === "bucket_weights"
        || this.subject?.recommendationType === "bucket_weights";
    },
    // The outcome's rows: the recommendation, and the move it implies.
    //
    // The gap is measured against ACTUAL where we know it, because that is the
    // move being asked for; against target otherwise, which is a different
    // question, so gapBasis() names which one is on screen rather than letting
    // one column heading stand for both.
    bucketRows() {
      const basis = this.gapBasis();
      return this.bucketWeights().map((b) => {
        const from = basis === "actual" ? b.actual : b.target;
        const gap = from == null || b.recommended == null ? null : weightChange.weightDelta(b.recommended * 100, from * 100);
        return { ...b, gap };
      });
    },
    // "actual" once any bucket reports where the book actually sits, else
    // "target" when a target is known, else null — no basis, no column.
    gapBasis() {
      const buckets = this.bucketWeights();
      if (buckets.some((b) => b.actual != null)) return "actual";
      if (buckets.some((b) => b.target != null)) return "target";
      return null;
    },
    hasTargetColumn() { return this.bucketWeights().some((b) => b.target != null); },
    hasActualColumn() { return this.bucketWeights().some((b) => b.actual != null); },
    // The full comparison, only when it holds a figure the legend does not:
    // the target beside the book, or a target the legend withholds because it
    // postdates the session.
    hasLedger() {
      return !!this.gapBasis() && ((this.hasTargetColumn() && this.hasActualColumn()) || this.targetPostdatesSession());
    },
    // The number of figure columns in the outcome register, for its grid.
    outcomeColumns() {
      return 1 + (this.hasTargetColumn() ? 1 : 0) + (this.hasActualColumn() ? 1 : 0) + (this.gapBasis() ? 1 : 0);
    },
    // Weights and moves read as /allocation's "What changed" writes them
    // (lib/weight-change.js): 95%, 14.3%; ▲ +2.00% / ▼ −2.00%, or "—".
    // Weights here are fractions, so they are scaled to percent first.
    fmtWeight(v) { return v == null ? "—" : weightChange.fmtPctTrim(v * 100); },
    fmtPctTrim(v) { return weightChange.fmtPctTrim(v); },
    changeLabel(d) { return weightChange.changeLabel(d); },
    changeClass(d) { return weightChange.changeClass(d); },
    hasOutcome() { return this.isBucketWeights() || this.authoredActions().length > 0; },
    // The outcome in a word, the way the band states the signal and the
    // reasoning: whether the swarm moved anything, and how much of it. Only
    // when there is something to measure against and the comparison is fair.
    outcomeState() {
      if (this.isBucketWeights()) {
        const basis = this.gapBasis();
        if (!this.gapIsFair()) return null;
        const rows = this.bucketRows().filter((b) => b.gap != null);
        if (!rows.length) return null;
        const moved = rows.filter((b) => this.changeClass(b.gap) !== "flat").length;
        const what = basis === "actual" ? "the book" : "the target";
        return moved
          ? { label: "Change", detail: `${moved} of ${rows.length} sleeves move from ${what}` }
          : { label: "No change", detail: `matches ${what}` };
      }
      const acts = this.authoredActions();
      if (!acts.length) return null;
      const moved = acts.filter((a) => String(a.action).toLowerCase() !== "hold").length;
      return moved
        ? { label: "Change", detail: `${moved} of the ${acts.length} positions it reviewed` }
        : { label: "No change", detail: `holds all ${acts.length} positions it reviewed` };
    },
    // Anything byte-identical to a take already on this page is an echo, and
    // dropped. Shape-agnostic: a real synthesis stops matching any body and
    // appears on its own. Takes live on the factory root (`this.takes`).
    takeBodies() {
      return new Set((this.takes || []).map((t) => this.normText(t.body)).filter(Boolean));
    },
    normText(s) { return String(s || "").replace(/\s+/g, " ").trim(); },
    isEcho(text) { const n = this.normText(text); return !!n && this.takeBodies().has(n); },
    // Suppressed when it demonstrably contains every take body verbatim; a
    // genuine synthesis will not, and will render untouched.
    synthesisIsEcho() {
      const bodies = [...this.takeBodies()];
      if (!bodies.length) return false;
      const n = this.normText(this.session?.synthesis);
      return !!n && bodies.every((b) => n.includes(b));
    },
    // The take a disagreement position belongs to. v0 sessions imported into
    // the database kept v0's slugs in their disagreements ("robotmoney") while
    // their takes carry the live id and handle ("robot-money"); letters and
    // digits only lets the two meet.
    takeOf(memberId) {
      const takes = this.takes || [];
      const hit = takes.find((t) => t.memberId === memberId || t.memberHandle === memberId);
      if (hit) return hit;
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const n = norm(memberId);
      return n ? takes.find((t) => norm(t.memberHandle) === n || norm(t.memberId) === n) : undefined;
    },
    // Where a take card sits on this page, for the index above the cards.
    takeAnchor(t) { return `take-${String(t?.memberId || t?.id || "").replace(/[^A-Za-z0-9_-]/g, "")}`; },
    // THE DISCUSSION, when somebody wrote it. A live aggregate's consensus,
    // disagreements and synthesis are templates over the stance tally, the
    // quorum, the mean confidence and the regime percentile (domain.ts
    // buildConsensus, buildDisagreements, buildSynthesis), every one of which
    // the review band already draws, and a disagreement's views are two take
    // bodies copied verbatim. A judge rewrites the rationale and the
    // disagreements, and only a MODEL judge writes its own: the fallback
    // (judge.source other than "model", the shipped default) writes the same
    // templates. v0 sessions authored all of it.
    consensusItems() {
      if (this.isRollupRecommendation()) return [];
      return (this.session?.swarmRecommendation?.consensus || []).filter((c) => !this.isEcho(c));
    },
    disagreements() {
      const rec = this.session?.swarmRecommendation;
      if (this.isRollupRecommendation() && rec?.judge?.source !== "model") return [];
      return rec?.disagreements || [];
    },
    showSynthesis() {
      return !this.isRollupRecommendation() && !!this.session?.synthesis && !this.synthesisIsEcho();
    },
    hasDiscussion() {
      return this.showSynthesis() || this.consensusItems().length > 0 || this.disagreements().length > 0;
    },

    // ── the research record (RM-121) ────────────────────────────────────────
    // Evidence read after render: this session's neighbours on its subject. It
    // does not block the page.
    //
    // NO CONSENSUS RECEIPT PROBE. The page used to ask for the session's
    // receipt to print its status. No route says whether a receipt exists
    // without answering 404, and a published weights session has none until it
    // is published, so every such page logged a failed request (the full-stack
    // smoke fails on any). The status belongs on the session payload; until the
    // API carries it, the page does not guess.
    async loadEvidence() {
      const s = this.session;
      if (!s) return;
      subjectSessionIndex(s.subjectId).then((list) => {
        const at = list.findIndex((x) => (s.id && x.id === s.id) || (!String(x.id).match(/^[0-9a-f-]{36}$/) && x.date === s.date));
        if (at < 0) return;
        this.neighbours = { newer: list[at - 1] || null, older: list[at + 1] || null };
      }).catch(() => {});
    },
    // A session is addressed by id when it has a real one, by date otherwise.
    sessionHrefOf(s) {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s?.id || ""))
        ? `/swarm/sessions/${encodeURIComponent(s.id)}`
        : `/swarm/${s?.date}/${encodeURIComponent(s?.subjectId || this.session?.subjectId || "")}`;
    },
    // The time of day matters once a subject convenes more than once a day.
    sessionTime() {
      // When it convened, the moment the date beside it names (rowTime).
      const at = this.session?.generatedAt || this.session?.publishedAt;
      if (this.source !== "api" || !at || !Number.isFinite(Date.parse(at))) return "";
      return `${new Date(at).toISOString().slice(11, 16)} UTC`;
    },
    // Record generated, as a time when it is the session's own day (the header
    // prints that date), dated only when generated on another. Guarded:
    // toISOString() throws on an unparseable stamp, so that one prints as is.
    generatedLabel() {
      const at = this.session?.generatedAt || this.session?.generated_at;
      const t = Date.parse(at);
      if (!Number.isFinite(t)) return at || "";
      const iso = new Date(t).toISOString();
      const time = `${iso.slice(11, 16)} UTC`;
      return iso.slice(0, 10) === String(this.session?.date || "").slice(0, 10) ? time : `${this.formatDate(at, "short")} · ${time}`;
    },
    sessionJsonHref() {
      const s = this.session;
      if (this.source === "api" && s?.id) return path(ROUTES.swarm.sessionById, { id: s.id });
      return `/data/swarm/sessions/${s?.date}-${s?.subjectId}.json`;
    },
    briefJsonHref() {
      const s = this.session;
      if (this.source === "api" && s?.id) return `${ROUTES.swarm.brief}?session=${encodeURIComponent(s.id)}`;
      return `/data/swarm/briefs/${s?.date}-${s?.subjectId}.json`;
    },
    // The session as the subject page's summary reads a row: the record with
    // its takes on it, so the stance tally and turnout under the rationale are
    // drawn by the same helpers, from the same takes, as the subject page's.
    recordRow() { return this.session ? { ...this.session, takeRows: this.takes } : null; },
    hasRecommendationSection() {
      return this.hasOutcome() || !!this.recommendationRationale();
    },
    // The decision in one line, only where the legend cannot say it: that no
    // sleeve moved from what the session was measured against. A count of
    // moves is the legend's rows that carry one, and every action is labelled
    // on its own row, as on the subject page. Nothing when there is no fair
    // comparison: the legend still shows the mix.
    outcomeHeadline() {
      if (!this.isBucketWeights() || !this.gapIsFair()) return "";
      const rows = this.bucketRows().filter((b) => b.gap != null);
      if (!rows.length || rows.some((b) => this.changeClass(b.gap) !== "flat")) return "";
      // The subject page's wording (weightsOutcomeLine), so the same
      // session reads the same on both pages.
      return weightsOutcomeLine(0, this.gapBasis() === "actual" ? "book" : "target");
    },
    isLong(text, chars) { return String(text || "").length > chars; },
    // ── the vote, as a chart ────────────────────────────────────────────────
    // Each member at their stance (a fifth of the width each, bearish to
    // bullish) and their confidence. Members sharing a stance spread apart
    // inside its column, ordered by confidence, so no two dots sit on top of
    // each other.
    // The confidence axis fits the room: members rarely report under half, so
    // a fixed 0-100 scale pressed every dot into one line along the top and
    // left the chart two-thirds empty. The floor steps down in tens to clear
    // the lowest reading; it is a dot plot, so a floor above zero misstates
    // nothing.
    voteDomain() {
      const vals = (this.takes || []).map((t) => Number(t.confidence) * 100).filter((n) => Number.isFinite(n));
      const min = vals.length ? Math.min(...vals) : 50;
      const lo = Math.max(0, Math.min(50, Math.floor((min - 5) / 10) * 10));
      const step = 100 - lo <= 50 ? 10 : 25;
      const ticks = [];
      for (let v = 100; v >= lo; v -= step) ticks.push({ v, pos: ((v - lo) / (100 - lo)) * 100 });
      return { lo, ticks };
    },
    votePos(pct) {
      const { lo } = this.voteDomain();
      return Math.max(0, Math.min(100, ((pct - lo) / (100 - lo)) * 100));
    },
    voteDots() {
      const axis = ["bearish", "cautious", "neutral", "constructive", "bullish"];
      const takes = (this.takes || []).filter((t) => axis.includes(String(t.stance || "").toLowerCase()));
      const byCol = new Map();
      for (const t of takes) {
        const col = axis.indexOf(String(t.stance).toLowerCase());
        if (!byCol.has(col)) byCol.set(col, []);
        byCol.get(col).push(t);
      }
      const out = [];
      for (const [col, list] of byCol) {
        list.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
        list.forEach((t, j) => {
          const conf = Number(t.confidence);
          const spread = list.length > 1 ? (j - (list.length - 1) / 2) * Math.min(5, 14 / list.length) : 0;
          const x = 10 + col * 20 + spread;
          const y = Number.isFinite(conf) ? Math.round(this.clampPct(conf * 100)) : 0;
          out.push({
            key: t.memberId || t.id,
            name: t.memberName || t.memberId,
            stance: String(t.stance).toLowerCase(),
            color: this.stanceColor(t.stance),
            x,
            y,
            pos: this.votePos(y),
            anchor: this.takeAnchor(t),
            // Members sharing a stance put their names on opposite sides of
            // their dots; the last column always labels to the left, away
            // from the edge.
            flip: col === 4 || (list.length > 1 && j % 2 === 0),
          });
        });
      }
      return this.placeVoteLabels(out);
    },
    // Sides alone do not keep three names apart: three members at 60 to 62%
    // in one column wrote "Athena", "Robot Money" and "Noop Analyst" over one
    // another on production. A label that would overlap one already placed,
    // or run across another member's dot, tries the dot's other side, then
    // sits centred above or below its own dot, a label's height at a time
    // until it clears; the dot stays where the vote put it. Units are % of
    // the plot.
    placeVoteLabels(dots) {
      const H = 9;
      const placed = [];
      const clear = (d, x0, x1, y) => y >= 0 && y <= 100
        && !placed.some((p) => p.x0 < x1 && x0 < p.x1 && Math.abs(p.y - y) < H)
        && !dots.some((o) => o !== d && o.x > x0 && o.x < x1 && Math.abs(o.pos - y) < H / 2);
      for (const d of [...dots].sort((a, b) => a.x - b.x)) {
        const w = (String(d.name || "").length + 5) * 0.6;
        const tries = [
          { flip: d.flip, dy: 0 }, { flip: !d.flip, dy: 0 },
          // A stacked name clears its own dot as well as its neighbours'.
          ...[1, -1, 2, -2, 3, -3].map((step) => ({ stack: true, dy: step * (H + 2) })),
        ];
        const at = tries.find((t) => {
          const x0 = t.stack ? d.x - w / 2 : t.flip ? d.x - w : d.x;
          return clear(d, x0, x0 + w, d.pos + t.dy);
        }) || tries[0];
        const x0 = at.stack ? d.x - w / 2 : at.flip ? d.x - w : d.x;
        placed.push({ x0, x1: x0 + w, y: d.pos + at.dy });
        Object.assign(d, { flip: !!at.flip, stack: !!at.stack, dy: at.dy });
      }
      return dots;
    },
    voteMean() {
      const vals = (this.takes || []).map((t) => Number(t.confidence)).filter((n) => Number.isFinite(n));
      if (!vals.length) return null;
      return Math.round((vals.reduce((a, n) => a + n, 0) / vals.length) * 100);
    },
    voteLeanStance() { return this.leanStance(this.reviewRow()); },
    // The consensus as a fact: the stance with the most members, or "split"
    // when two or more tie for it.
    consensusText() {
      const row = this.reviewRow();
      const lean = this.lean(row);
      if (!lean) return "No consensus recorded";
      if (!lean.stance) return "Split, no stance has a majority";
      const word = lean.stance.charAt(0).toUpperCase() + lean.stance.slice(1);
      return `${word}, ${this.leadShare(row)} members`;
    },
    // The plot's accessible name carries the mean: its dashed rule is
    // decoration inside role=img, and the caption no longer repeats it.
    voteLabel() {
      const dots = this.voteDots();
      const mean = this.voteMean();
      return `How members voted, by stance and confidence. ${this.consensusText()}. `
        + dots.map((d) => `${d.name} ${d.stance} at ${d.y}%`).join(", ") + "."
        + (mean === null ? "" : ` Mean confidence ${mean}%.`);
    },
    signatureHeadline() {
      const t = this.takes || [];
      if (!t.length) return "";
      if (t.every((x) => x.archival)) return "Archived, unsigned research";
      const ok = t.filter((x) => x.verified).length;
      return ok === t.length ? "Every take is signed and verified" : `${ok} of ${t.length} takes verified`;
    },
    targetPolicyLabel() {
      const src = this.targetSource();
      if (src === "brief") {
        const asof = (this.brief?.body || this.brief)?.allocation?.asof;
        return asof ? `Handed to this session, dated ${this.formatDate(asof, "short")}` : "Handed to this session";
      }
      if (src === "framework" && this.allocationAsOf()) {
        const when = this.formatDate(this.allocationAsOf(), "short");
        return this.targetPostdatesSession() ? `Published ${when}, after this session` : `Published ${when}`;
      }
      return "Not recorded";
    },
  }));
}

/** @param {unknown} v */
export const normKeyOf = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Inside each sleeve: each sleeve under its published name and hue, and its
// items in POLICY order, each in the colour its position gives it there (so
// Morpho is one colour on every page), named as the brief or the published
// framework names it rather than by the payload's slug.
/** @param {any} rec @param {any} brief @param {any} framework @param {Map<string, number|null>} sleeveWeight */
export function withinBucketsFor(rec, brief, framework, sleeveWeight) {
  const body = brief?.body || brief;
  const policyOf = (/** @type {string} */ bucket) => {
    const n = normKeyOf(bucket);
    const fromBrief = (body?.allocation?.buckets || []).find((/** @type {any} */ b) => normKeyOf(b.id) === n || normKeyOf(b.name) === n);
    if (fromBrief?.items?.length) return fromBrief.items.map((/** @type {any} */ it) => ({ id: it.id || "", name: it.name || it.id || "" }));
    return (framework?.buckets || []).find((/** @type {any} */ b) => normKeyOf(b.id) === n || normKeyOf(b.name) === n)?.items || [];
  };
  return withinBucketWeightsFrom(rec)
    .map((b, i) => {
      const policy = policyOf(b.bucket);
      const items = b.items.map((it, j) => {
        const at = policy.findIndex((/** @type {any} */ p) => normKeyOf(p.id) === normKeyOf(it.name) || normKeyOf(p.name) === normKeyOf(it.name));
        const order = at >= 0 ? at : policy.length + j;
        return { ...it, label: at >= 0 ? policy[at].name : it.name, order, colour: CATEGORICAL[order % CATEGORICAL.length] };
      }).sort((x, y) => x.order - y.order);
      const w = sleeveWeight.get(normKeyOf(b.bucket));
      return { ...b, label: bucketLabel(b.bucket), hue: bucketHue(b.bucket, i), weight: w == null ? null : w * 100, items, rank: bucketRank(b.bucket) };
    })
    .sort((a, b) => a.rank - b.rank);
}

// A book as the explorer draws it: each position with its share of the book,
// and the action the session took on it. Positions past the seventh fold into
// "Other", as the concentration chart folds them. An action on a token the
// book does not hold still gets a row, at 0%, so no recommendation is dropped.
/** @param {any} snapshot @param {any[]} actions @param {(t: string) => string} colourOf @param {(v: number) => string} usd */
function bookExplorerRows(snapshot, actions, colourOf, usd) {
  const total = Number(snapshot?.totalValueUsd) || 0;
  if (!snapshot || total <= 0) return [];
  const byToken = new Map((actions || []).map((a) => [String(a.token || "").toLowerCase(), a]));
  const positions = (snapshot.positions || [])
    .map((/** @type {any} */ p) => ({ token: String(p.token || p.symbol || ""), chain: p.chain || "", value: Number(p.value_usd ?? p.valueUsd) || 0, amount: p.balance ?? p.amount ?? null }))
    .filter((p) => p.token)
    .sort((a, b) => b.value - a.value);
  const shown = positions.slice(0, 7);
  const rest = positions.slice(7);
  const row = (/** @type {any} */ p) => {
    const act = byToken.get(p.token.toLowerCase());
    const pct = (p.value / total) * 100;
    // What the position is worth on the row itself: its value, and its units
    // when the token is not the dollar it is valued in. A manager reads "add
    // USDC" beside "$8,995 · 9,037 USDC" without opening the drawer, and a
    // token priced far from $1 shows how many units that is.
    const units = p.amount == null || !Number.isFinite(Number(p.amount)) ? "" : `${helpers.fmtAmount(p.amount)} ${p.token}`;
    return {
      key: p.token, label: p.token, hue: colourOf(p.token), pct,
      worth: [usd(p.value), units].filter(Boolean).join(" · "),
      meta: p.chain ? sessionSummary.chainLabel(p.chain) : "",
      action: act ? String(act.action).toLowerCase() : "", rationale: act?.rationale || "",
      d: null, was: null, basis: "", assets: [],
    };
  };
  const rows = shown.map(row);
  const restValue = rest.reduce((a, p) => a + p.value, 0);
  if (restValue > 0) {
    const pct = (restValue / total) * 100;
    rows.push({ key: OTHER_TOKEN, label: `Other (${rest.length})`, hue: OTHER_COLOR, pct,
      worth: usd(restValue), meta: "", action: "", rationale: "", d: null, was: null, basis: "", assets: [] });
  }
  const held = new Set(positions.map((p) => p.token.toLowerCase()));
  for (const a of actions || []) {
    const t = String(a.token || "");
    if (!t || held.has(t.toLowerCase())) continue;
    rows.push({ key: t, label: t, hue: colourOf(t), pct: 0, worth: "Not held", meta: "",
      action: String(a.action).toLowerCase(), rationale: a.rationale || "", d: null, was: null, basis: "", assets: [] });
  }
  return rows;
}

// A sleeve's assets as the explorer lists them: share of the sleeve, and share
// of the whole allocation that implies.
/** @param {any} sleeve @param {number | null} pct */
export function explorerAssets(sleeve, pct) {
  return (sleeve?.items || []).map((/** @type {any} */ it) => ({
    key: it.name,
    label: it.label || it.name,
    colour: it.colour,
    ofSleeve: it.weight * 100,
    ofAllocation: pct == null ? null : it.weight * pct,
  }));
}

// The sleeve weights a brief handed its session, as { bucket key: percent }.
// Null when the brief carried none: the live brief does not yet (#961).
/** @param {any} brief */
export function referenceWeights(brief) {
  const body = brief?.body || brief;
  const buckets = body?.allocation?.buckets;
  if (!Array.isArray(buckets) || !buckets.length) return null;
  /** @type {Record<string, number>} */
  const out = {};
  for (const b of buckets) {
    const w = Number(b?.target_weight ?? b?.targetWeight);
    const i = bucketRank(b?.id || b?.name);
    if (Number.isFinite(w) && i < BUCKET_ORDER.length) out[BUCKET_ORDER[i]] = w * 100;
  }
  return Object.keys(out).length ? out : null;
}

// The published targets in force on `date`, as { bucket key: percent }, or
// null. The framework keeps one current row and no history, so a row dated
// after the session is never read back onto it (the session page's
// targetPostdatesSession rule).
/** @param {any} fw @param {string} date */
export function targetsInForce(fw, date) {
  const asOf = fw?.asOf ? String(fw.asOf).slice(0, 10) : "";
  if (!asOf || !date || String(date) < asOf) return null;
  const rows = (fw.strategy || []).filter((r) => r?.targetPct != null && Number.isFinite(Number(r.targetPct)));
  return referenceWeights({ allocation: { buckets: rows.map((r) => ({ name: r.label, target_weight: Number(r.targetPct) / 100 })) } });
}

// The API's own limit on a history search (#1007): a literal phrase, short.
const HISTORY_SEARCH_MAX = 200;

// Whether a session list answered a `subject=` request as #1007 does: every
// row that subject's, and each carrying its take count. A backend before it
// ignores the parameter and returns every subject's rows, with no takeCount.
// An empty answer proves nothing either way, so it is not trusted.
/** @param {any[]} rows @param {string} subjectId */
export function servesSubjectHistory(rows, subjectId) {
  return Array.isArray(rows) && rows.length > 0
    && rows.every((s) => Number.isFinite(s?.takeCount) && (s.subjectId ?? s.subject_id) === subjectId);
}

// A light index row (#1007) as a subject history row: the fields
// loadSessionRow() builds from a session and its brief, read off the row. The
// take count is the members who filed; the reference is the target that
// session's own brief carried, or null.
/** @param {any} s */
function historyRowOf(s) {
  const full = camelSession(s);
  return {
    id: full?.id,
    date: full?.date,
    subjectId: full?.subjectId,
    subjectName: full?.subjectName,
    generatedAt: full?.generatedAt ?? null,
    publishedAt: s?.publishedAt ?? s?.published_at ?? null,
    synthesis: full?.synthesis || "",
    swarmRecommendation: full?.swarmRecommendation || null,
    regimeSummary: full?.regimeSummary || null,
    takes: Number.isFinite(s?.takeCount) ? s.takeCount : null,
    takeRows: [],
    reference: referenceWeights({ allocation: s?.referenceAllocation }),
  };
}

// Every published session the list answers, walking `nextCursor` as /swarm's
// loadAllSessions() does. The list pages at 20 by default, so its first page
// alone held 5 of the allocation's 63 sessions on production, and the subject
// page said "Sessions 5". Capped so a runaway cursor cannot loop.
async function publishedSessionList() {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < 40; page += 1) {
    /** @type {Record<string, string>} */
    const query = { state: "published", limit: "50" };
    if (cursor) query.cursor = cursor;
    const res = await api.get(ROUTES.swarm.sessions, query);
    rows.push(...(res?.sessions || []));
    cursor = res?.nextCursor || null;
    if (!cursor) break;
  }
  return rows;
}

// A subject's published sessions, newest first, as { id, date, subjectId }.
// A backend without #1007's subject filter answers every subject's rows, so
// the whole index is read and filtered here, with the static archive behind it.
/** @param {string} subjectId */
async function subjectSessionIndex(subjectId) {
  const pick = (/** @type {any[]} */ list) => list
    .filter((s) => (s.subjectId ?? s.subject_id) === subjectId && s.state === "published")
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))
      || String(b.generatedAt || b.generated_at || "").localeCompare(String(a.generatedAt || a.generated_at || "")))
    .map((s) => ({ id: s.id ?? `${s.date}-${subjectId}`, date: s.date, subjectId }));
  try {
    const list = pick(await publishedSessionList());
    if (list.length) return list;
  } catch (_) { /* fall through to the archive */ }
  return pick((await fetchJson("/data/swarm/sessions/index.json")).sessions || []);
}
