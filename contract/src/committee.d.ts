// Investment Committee API DTOs + types for the runtime constants in
// committee.js (see that module for the canonical values/semantics).

import type { RegimeLabel } from "./regime";

// ── Runtime constants (committee.js) ────────────────────────────────────────

export type Stance = "bearish" | "cautious" | "neutral" | "constructive" | "bullish";

/** Canonical stance vocabulary, ASCENDING (most bearish → most bullish). */
export const STANCES: readonly ["bearish", "cautious", "neutral", "constructive", "bullish"];

/** Fixed target size for the standing demo committee roster. */
export const COMMITTEE_ROSTER_CAP: number;

/** Demo no-show rule: the curated set of habitual no-show member ids. */
export const DEMO_NO_SHOWS: readonly string[];

/** Whether a demo committee member attends a session (the demo no-show rule). */
export function demoAttends(memberId: string): boolean;

/**
 * Deterministic demo stance derivation from the regime composite plus a
 * member's directional bias (the hermetic no-LLM authoring path).
 */
export function stanceFor(composite: number, bias?: number): { stance: Stance; confidence: number };

// ── DTOs ────────────────────────────────────────────────────────────────────

export type MemberStatus = "active" | "inactive" | "applied";

export interface CommitteeMember {
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

export interface CommitteeSubject {
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
// the canonical append-only committee_recommendations store (§9.8). The legacy
// LLM-provenance fields (mode/model/generatedAt) are optional remnants of the
// prototype committee_takes table (dropped in 0006) and are not produced by the
// current getSession; `verified` reflects server-side signature verification.
export interface CommitteeTake {
  id: string;
  memberId: string;
  memberName: string;
  stance: string | null;
  confidence: number | null;
  body: string | null;
  memoUrl?: string | null;
  weights?: CommitteeBucketWeight[];
  verified: boolean;
  receivedAt: string;
  // Optional provenance (legacy/prototype; absent for signed recommendations).
  sessionId?: string;
  mode?: string | null;
  model?: string | null;
  generatedAt?: string;
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

// Aggregation rollup counts: how many active members, how many submitted, how
// many were absent, and submitted/active as a fraction.
export interface CommitteeQuorum {
  active: number;
  submitted: number;
  absent: number;
  participation: number;
}

export interface CommitteeDisagreementPosition {
  member_id: string;
  view: string;
}

export interface CommitteeDisagreement {
  topic: string;
  positions: CommitteeDisagreementPosition[];
  what_settles: string;
}

export interface CommitteeRecommendedAction {
  token: string;
  action: string;
  rationale?: string;
}

export interface CommitteeBucketWeight {
  bucket: string;
  weight: number;
}

// The rich committee_recommendation object the backend aggregateSession builds:
// the deterministic rollup (quorum/stances/meanConfidence/absent) plus the
// reference rich fields (rationale/consensus/disagreements and, depending on
// the subject's recommendation type, actions or weights).
export interface CommitteeRecommendation {
  quorum: CommitteeQuorum;
  stances: Record<string, number>; // stance (Stance vocabulary) → count
  meanConfidence: number | null;
  absent: string[];
  type: "bucket_weights" | "position_actions";
  rationale: string;
  consensus: string[];
  disagreements: CommitteeDisagreement[];
  actions?: CommitteeRecommendedAction[];
  weights?: CommitteeBucketWeight[];
}

export interface CommitteeSession {
  id: string;
  date: string;
  subjectId: string;
  subjectName: string | null;
  // "cancelled" (issue #152) is reachable via the admin surface's guarded
  // lifecycle transitions (committee/admin.ts); the pre-#152 demo/worker path
  // never sets it.
  state: "scheduled" | "collecting" | "window_closed" | "aggregated" | "published" | "cancelled";
  windowClosesAt: string | null;
  publishedAt: string | null;
  regimeSummary: RegimeSummary | null;
  subjectSnapshotTotalValueUsd: number | null;
  synthesis: string | null;
  committeeRecommendation: CommitteeRecommendation | null;
  socialDraftId: string | null;
  generatedAt: string;
  takes?: CommitteeTake[];
}

export interface CommitteeBrief {
  id: string;
  date: string;
  subjectId: string;
  body: CommitteeBriefBody | null;
  createdAt: string;
}

export interface CommitteeBriefBody {
  regime: unknown;
  subject: CommitteeSubject | null;
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

export interface CommitteeApplication {
  memberId: string;
  payload: unknown;
}

export interface CommitteeSubmission {
  memberId: string;
  date: string;
  subjectId: string;
  nonce: string;
  stance: string;
  confidence: number;
  body: string;
  memoUrl?: string;
  weights?: CommitteeBucketWeight[];
  signature: string;
}

/**
 * Durable committee-agent health event shape reserved for issue #208.
 * This scout adds no storage or route behavior. The eventual admin projection
 * follows docs/plan-admin-surface.md: bounded details, no secrets, append-only
 * auditability.
 */
export interface CommitteeAgentHealthEvent {
  id: string;
  memberId: string;
  sessionId: string | null;
  eventType: "absence" | "rejected_signature";
  reason: string;
  detail: Record<string, unknown> | null;
  occurredAt: string;
}
