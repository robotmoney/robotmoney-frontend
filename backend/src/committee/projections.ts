import type {
  CommitteeBrief,
  CommitteeMember,
  CommitteeSession,
  CommitteeSessionListItem,
  CommitteeSubject,
  CommitteeTake,
  SubjectSnapshot,
} from "@robotmoney/contract";
import { verifyStoredSubmissionSignature } from "../lib/signing.ts";

type Row = Record<string, any>;

// Exported so the session-list pagination cursor (domain.ts, issue #243) can
// serialize the same date/instant it just read off a committee_sessions row —
// keeping the cursor's notion of "date"/"timestamp" identical to the
// projection's, rather than a second ad-hoc parser drifting from this one.
export const day = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, 10) : new Date(value as any).toISOString().slice(0, 10);
export const instant = (value: unknown): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();

export function toMember(row: Row): CommitteeMember {
  return {
    id: row.id,
    status: row.status,
    name: row.name,
    tagline: row.tagline ?? null,
    lens: row.lens ?? null,
    mandate: row.mandate ?? null,
    biases: row.biases ?? null,
    voiceMd: row.voice_md ?? null,
    mode: row.mode ?? null,
    operator: row.operator ?? null,
    avatar: row.avatar ?? null,
    appliedAt: instant(row.applied_at),
    activatedAt: instant(row.activated_at),
  };
}

export function toSubject(row: Row): CommitteeSubject {
  return {
    id: row.id,
    status: row.status,
    name: row.name,
    operator: row.operator ?? null,
    homepage: row.homepage ?? null,
    xHandle: row.x_handle ?? null,
    thesisBlurb: row.thesis_blurb ?? null,
    wallets: row.wallets ?? null,
    nftContracts: row.nft_contracts ?? null,
    source: row.source ?? null,
    recommendationType: row.recommendation_type ?? null,
    linkedMemberId: row.linked_member_id ?? null,
    structuralNotes: row.structural_notes ?? null,
    lastReviewed: row.last_reviewed == null ? null : day(row.last_reviewed),
  };
}

export function toSession(row: Row): CommitteeSession {
  return {
    id: row.id,
    date: day(row.date),
    subjectId: row.subject_id,
    subjectName: row.subject_name ?? null,
    state: row.state,
    windowClosesAt: instant(row.window_closes_at),
    publishedAt: instant(row.published_at),
    regimeSummary: row.regime_summary ?? null,
    subjectSnapshotTotalValueUsd: row.subject_snapshot_total_value_usd == null
      ? null
      : Number(row.subject_snapshot_total_value_usd),
    synthesis: row.synthesis ?? null,
    committeeRecommendation: row.committee_recommendation ?? null,
    socialDraftId: row.social_draft_id ?? null,
    generatedAt: instant(row.generated_at) ?? "",
  };
}

// Light index-row projection for the default (unpaginated-no-more) GET
// /api/committee/sessions response (issue #243). Deliberately drops
// regimeSummary/synthesis/subjectSnapshotTotalValueUsd — the large fields
// behind the ~8.3MB unprojected payload — keeping everything else a list
// consumer (directory page, admin overview) already reads off a session row.
export function toSessionListItem(row: Row): CommitteeSessionListItem {
  return {
    id: row.id,
    date: day(row.date),
    subjectId: row.subject_id,
    subjectName: row.subject_name ?? null,
    state: row.state,
    windowClosesAt: instant(row.window_closes_at),
    publishedAt: instant(row.published_at),
    committeeRecommendation: row.committee_recommendation ?? null,
    socialDraftId: row.social_draft_id ?? null,
    generatedAt: instant(row.generated_at) ?? "",
  };
}

export function toTake(row: Row): CommitteeTake {
  return {
    id: row.id,
    memberId: row.member_id,
    memberName: row.member_name,
    stance: row.stance ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    body: row.body ?? null,
    memoUrl: row.memo_url ?? null,
    ...(Array.isArray(row.payload?.weights) ? { weights: row.payload.weights } : {}),
    verified: Boolean(row.verified),
    receivedAt: instant(row.received_at) ?? "",
  };
}

/**
 * Project the signed payload itself and recompute its verification result.
 * The denormalized columns and stored `verified` flag are intentionally not
 * authorities for a public receipt.
 */
export async function toVerifiedTake(row: Row): Promise<CommitteeTake> {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const verified = typeof row.signature === "string" && typeof row.public_key === "string"
    ? await verifyStoredSubmissionSignature({
      submission: payload,
      signatureB64: row.signature,
      publicKeyB64: row.public_key,
    })
    : false;

  return toTake({
    ...row,
    stance: payload.stance ?? row.stance,
    confidence: payload.confidence ?? row.confidence,
    body: payload.body ?? row.body,
    memo_url: payload.memoUrl ?? row.memo_url,
    verified,
  });
}

export function toBrief(row: Row): CommitteeBrief {
  return {
    id: row.id,
    date: day(row.date),
    subjectId: row.subject_id,
    body: row.body ?? null,
    createdAt: instant(row.created_at) ?? "",
  };
}

export function toSnapshot(row: Row): SubjectSnapshot {
  return {
    id: row.id,
    subjectId: row.subject_id,
    date: day(row.date),
    totalValueUsd: row.total_value_usd == null ? null : Number(row.total_value_usd),
    positions: row.positions ?? null,
    wallets: row.wallets ?? null,
    notable: row.notable ?? null,
  };
}

export function toMemo(row: Row) {
  return {
    id: row.id,
    memberId: row.member_id,
    sessionId: row.session_id,
    title: row.title,
    body: row.body,
    createdAt: instant(row.created_at),
  };
}
