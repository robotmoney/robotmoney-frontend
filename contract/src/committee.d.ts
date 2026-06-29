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

export interface CommitteeTake {
  id: string;
  sessionId: string;
  memberId: string;
  memberName: string;
  mode: string | null;
  stance: string | null;
  confidence: number | null;
  body: string;
  model: string | null;
  generatedAt: string;
}

export interface CommitteeSession {
  id: string;
  date: string;
  subjectId: string;
  subjectName: string;
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
