// Investment Swarm API DTOs + types for the runtime constants in
// swarm.js (see that module for the canonical values/semantics).

import type { RegimeLabel } from "./regime";

// ── Runtime constants (swarm.js) ────────────────────────────────────────

export type Stance = "bearish" | "cautious" | "neutral" | "constructive" | "bullish";

/** Canonical stance vocabulary, ASCENDING (most bearish → most bullish). */
export const STANCES: readonly ["bearish", "cautious", "neutral", "constructive", "bullish"];

/** Fixed target size for the standing demo swarm roster. */
export const SWARM_ROSTER_CAP: number;

/** Demo no-show rule: the curated set of habitual no-show member ids. */
export const DEMO_NO_SHOWS: readonly string[];

/** Whether a demo swarm member attends a session (the demo no-show rule). */
export function demoAttends(memberId: string): boolean;

/**
 * Deterministic demo stance derivation from the regime composite plus a
 * member's directional bias (the hermetic no-LLM authoring path).
 */
export function stanceFor(composite: number, bias?: number): { stance: Stance; confidence: number };

// ── DTOs ────────────────────────────────────────────────────────────────────

export type MemberStatus = "active" | "inactive" | "applied";

export interface SwarmWaitlistEntry {
  id: string;
  email: string;
  emailNorm: string;
  createdAt: string;
  notifiedAt: string | null;
  source: string | null;
}

export interface SwarmMember {
  id: string;
  status: MemberStatus;
  name: string;
  tagline: string | null;
  lens: string | null;
  mandate: string | null;
  biases: unknown;
  voiceMd: string | null;
  mode: string | null;
  operator: string | null;
  avatar: unknown;
  appliedAt: string | null;
  activatedAt: string | null;
}

export interface SwarmSubject {
  id: string;
  status: string;
  name: string;
  operator: string | null;
  homepage: string | null;
  xHandle: string | null;
  thesisBlurb: string | null;
  wallets: unknown;
  nftContracts: unknown;
  source: unknown;
  recommendationType: string | null;
  linkedMemberId: string | null;
  structuralNotes: unknown;
  lastReviewed: string | null;
}

// A "take" is now a member-submitted, ed25519-signed recommendation pulled from
// the canonical append-only swarm_recommendations store (§9.8). The legacy
// LLM-provenance fields (mode/model/generatedAt) are optional remnants of the
// prototype swarm_takes table (dropped in 0006) and are not produced by the
// current getSession; `verified` reflects server-side signature verification.
export interface SwarmTake {
  id: string;
  memberId: string;
  memberName: string;
  stance: string | null;
  confidence: number | null;
  body: string | null;
  memoUrl?: string | null;
  weights?: SwarmBucketWeight[];
  verified: boolean;
  receivedAt: string;
  // Optional provenance (legacy/prototype; absent for signed recommendations).
  sessionId?: string;
  mode?: string | null;
  model?: string | null;
  generatedAt?: string;
}

export interface SwarmMemo {
  id: string | number;
  memberId: string;
  sessionId: string;
  title: string;
  body: string;
  createdAt: string | null;
}

export interface SwarmTakeSigner {
  id: string;
  name: string;
  publicKeyFingerprint: string | null;
}

/** Public receipt; verification is recomputed by the server on every read. */
export interface SwarmTakeReceipt {
  take: SwarmTake;
  memo: SwarmMemo | null;
  signer: SwarmTakeSigner;
}

// One point of the trailing regime history embedded in a session's
// regime_summary. Inner keys are the snake_case WIRE/DB dialect (the archive
// JSON shape) — the camelCase DTO seam stops at the session's top-level keys.
export interface RegimeHistoryPoint {
  date: string;
  composite: number;
  regime: RegimeLabel;
  macro: number;
  onchain: number;
  factor: number;
}

// The reference-shaped regime_summary object (backend buildRegimeSummary):
// latest composite/percentiles/labels plus a >=8-point trailing history.
// Field names are snake_case on purpose — this object is stored and served
// verbatim (archive fixtures and live sessions share the shape).
export interface RegimeSummary {
  composite: number;
  composite_percentile: number;
  regime: RegimeLabel;
  macro_regime: RegimeLabel;
  onchain_regime: RegimeLabel;
  factor_regime: RegimeLabel;
  macro_percentile: number;
  onchain_percentile: number;
  factor_percentile: number;
  history: RegimeHistoryPoint[];
}

// The list endpoint's slim regimeSummary (issue #357): every field the detail
// endpoint's RegimeSummary carries EXCEPT the >=8-point trailing history
// array — the one field big enough to matter across an 18+ row list payload.
// Sourced from the exact same stored regime_summary the detail endpoint
// serializes; no separate computation.
export type RegimeSummaryListItem = Omit<RegimeSummary, "history">;

// Aggregation rollup counts: how many active members, how many submitted, how
// many were absent, and submitted/active as a fraction.
export interface SwarmQuorum {
  active: number;
  submitted: number;
  absent: number;
  participation: number;
}

export interface SwarmDisagreementPosition {
  member_id: string;
  view: string;
}

export interface SwarmDisagreement {
  topic: string;
  positions: SwarmDisagreementPosition[];
  what_settles: string;
}

export interface SwarmRecommendedAction {
  token: string;
  action: string;
  rationale: string;
}

export interface SwarmBucketWeight {
  bucket: string;
  weight: number;
}

// The rich swarm_recommendation object the backend aggregateSession builds:
// the deterministic rollup (quorum/stances/meanConfidence/absent) plus the
// reference rich fields (rationale/consensus/disagreements and, depending on
// the subject's recommendation type, actions or weights).
export interface SwarmRecommendation {
  quorum: SwarmQuorum;
  stances: Record<string, number>; // stance (Stance vocabulary) → count
  meanConfidence: number | null;
  absent: string[];
  type: "bucket_weights" | "position_actions";
  rationale?: string;
  consensus: string[];
  disagreements: SwarmDisagreement[];
  actions?: SwarmRecommendedAction[];
  weights?: SwarmBucketWeight[];
}

export interface SwarmSession {
  id: string;
  date: string;
  subjectId: string;
  subjectName: string | null;
  // "cancelled" (issue #152) is reachable via the admin surface's guarded
  // lifecycle transitions (swarm/admin.ts); the pre-#152 demo/worker path
  // never sets it.
  state: "scheduled" | "collecting" | "window_closed" | "aggregated" | "published" | "cancelled";
  windowClosesAt: string | null;
  publishedAt: string | null;
  regimeSummary: RegimeSummary | null;
  subjectSnapshotTotalValueUsd: number | null;
  synthesis: string | null;
  swarmRecommendation: SwarmRecommendation | null;
  socialDraftId: string | null;
  generatedAt: string;
  takes?: SwarmTake[];
}

// Light index row served by GET /api/swarm/sessions (default, unless
// ?full=1) — issue #243. Deliberately omits
// subjectSnapshotTotalValueUsd (the large field responsible for the
// ~8.3MB unpaginated payload); everything else a session list consumer
// needs (id, state, timestamps, the swarmRecommendation rollup) stays.
// synthesis rejoined the projection in issue #358: since #323 rebuilt it as a
// short deterministic sentence (never the concatenated take bodies that made
// it "large" in the first place), it is cheap enough to carry on every list
// row so the directory preview (synthesisPreview() in swarm.js) has
// something to render.
// regimeSummary (issue #357) also rides along: a slim projection (see
// RegimeSummaryListItem) so the swarm index can render the regime label
// per row instead of falling back to session state — the >=8-point history
// array stays detail-only to keep the list small.
export interface SwarmSessionListItem {
  id: string;
  date: string;
  subjectId: string;
  subjectName: string | null;
  state: SwarmSession["state"];
  windowClosesAt: string | null;
  publishedAt: string | null;
  regimeSummary: RegimeSummaryListItem | null;
  synthesis: string | null;
  swarmRecommendation: SwarmRecommendation | null;
  socialDraftId: string | null;
  generatedAt: string;
}

export interface SwarmSessionListResponse {
  sessions: (SwarmSessionListItem | SwarmSession)[];
  /** Opaque cursor for the next page; null once exhausted (always null for ?full=1). */
  nextCursor: string | null;
}

// GET /api/swarm/members/:id/takes response row (issue #243) — a single
// member's take in one session, collapsing the list+N-detail-fetch pattern
// the member profile page used into one round trip.
export interface SwarmMemberTakeRow {
  sessionDate: string;
  subjectId: string;
  subjectName: string | null;
  sessionState: SwarmSession["state"];
  take: SwarmTake;
}

export interface SwarmMemberTakesResponse {
  takes: SwarmMemberTakeRow[];
}

export interface SwarmBrief {
  id: string;
  date: string;
  subjectId: string;
  body: SwarmBriefBody | null;
  createdAt: string;
}

export interface SwarmBriefBody {
  regime: unknown;
  subject: SwarmSubject | null;
  recentSessions: unknown[];
  previousSession?: { outcome: string };
  researchSignals: unknown[];
  prompt: { system: string; user: string };
  takeSchema: {
    stance: { type: "string"; enum: Stance[] };
    confidence: { type: "number"; minimum: 0; maximum: 1 };
    body: { type: "string" };
    weights: {
      type: "array";
      optional: true;
      items: {
        bucket: { type: "string" };
        weight: { type: "number"; minimum: 0 };
      };
    };
  };
  windowClosesAt: string;
}

export interface SubjectSnapshot {
  id: string;
  subjectId: string;
  date: string;
  totalValueUsd: number | null;
  positions: unknown;
  wallets: unknown;
  notable: unknown;
}

export interface SwarmApplication {
  memberId: string;
  payload: unknown;
}

export interface SwarmSubmission {
  memberId: string;
  date: string;
  subjectId: string;
  nonce: string;
  stance: string;
  confidence: number;
  body: string;
  memoUrl?: string;
  weights?: SwarmBucketWeight[];
  signature: string;
}

/**
 * Durable swarm-agent health event shape reserved for issue #208.
 * This scout adds no storage or route behavior. The eventual admin projection
 * follows docs/architecture.md: bounded details, no secrets, append-only
 * auditability.
 */
export interface SwarmAgentHealthEvent {
  id: string;
  memberId: string;
  sessionId: string | null;
  eventType: "absence" | "rejected_signature";
  reason: string;
  detail: Record<string, unknown> | null;
  occurredAt: string;
}
