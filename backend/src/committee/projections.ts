import type {
  CommitteeBrief,
  CommitteeMember,
  CommitteeSession,
  CommitteeSubject,
  CommitteeTake,
  SubjectSnapshot,
} from "@robotmoney/contract";

type Row = Record<string, any>;

const day = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, 10) : new Date(value as any).toISOString().slice(0, 10);
const instant = (value: unknown): string | null =>
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
