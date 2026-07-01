// Investment Committee API DTOs.

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
  verified: boolean;
  receivedAt: string;
  // Optional provenance (legacy/prototype; absent for signed recommendations).
  sessionId?: string;
  mode?: string | null;
  model?: string | null;
  generatedAt?: string;
}

export interface CommitteeSession {
  id: string;
  date: string;
  subjectId: string;
  subjectName: string | null;
  state: "scheduled" | "collecting" | "window_closed" | "aggregated" | "published";
  windowClosesAt: string | null;
  publishedAt: string | null;
  regimeSummary: unknown;
  subjectSnapshotTotalValueUsd: number | null;
  synthesis: string | null;
  committeeRecommendation: unknown;
  socialDraftId: string | null;
  generatedAt: string;
  takes?: CommitteeTake[];
}

export interface CommitteeBrief {
  id: string;
  date: string;
  subjectId: string;
  body: unknown;
  createdAt: string;
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
  signature: string;
}
