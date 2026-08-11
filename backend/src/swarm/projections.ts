import type {
  SwarmBrief,
  SwarmMember,
  SwarmSession,
  SwarmSessionListItem,
  SwarmSubject,
  SwarmTake,
  RegimeSummaryListItem,
  SubjectSnapshot,
} from "@robotmoney/contract";
import { verifyStoredSubmissionSignature } from "../lib/signing.ts";
import { isV0ArchiveNonce } from "./v0-archive.ts";

type Row = Record<string, any>;

// Exported so the session-list pagination cursor (domain.ts, issue #243) can
// serialize the same date/instant it just read off a swarm_sessions row —
// keeping the cursor's notion of "date"/"timestamp" identical to the
// projection's, rather than a second ad-hoc parser drifting from this one.
export const day = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, 10) : new Date(value as any).toISOString().slice(0, 10);
export const instant = (value: unknown): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();

export function toMember(row: Row): SwarmMember {
  return {
    id: row.id,
    memberUuid: row.member_uuid == null ? undefined : String(row.member_uuid),
    handle: row.handle ?? row.id,
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

export function toSubject(row: Row): SwarmSubject {
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

export function toSession(row: Row): SwarmSession {
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
    swarmRecommendation: row.swarm_recommendation ?? null,
    socialDraftId: row.social_draft_id ?? null,
    generatedAt: instant(row.generated_at) ?? "",
  };
}

// Bound on the list projection's synthesis field (issue #358). Post-#323,
// synthesis is a single deterministic sentence — typically well under this —
// so the bound is a defensive ceiling against a future aggregator regression
// re-inflating it, not a truncation this content is expected to hit day to day.
const SESSION_LIST_SYNTHESIS_MAX_CHARS = 500;
function synthesisExcerpt(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > SESSION_LIST_SYNTHESIS_MAX_CHARS
    ? `${value.slice(0, SESSION_LIST_SYNTHESIS_MAX_CHARS - 1)}…`
    : value;
}

// The list endpoint's regimeSummary (issue #357): the exact same stored
// regime_summary object the detail endpoint serializes, minus the
// >=8-point trailing `history` array — the one field big enough to matter
// across an 18+ row list payload. No separate computation path; this only
// ever strips a key off the value toSession() also reads.
function toRegimeSummaryListItem(regimeSummary: Row["regime_summary"]): RegimeSummaryListItem | null {
  if (!regimeSummary) return null;
  const { history: _history, ...rest } = regimeSummary;
  return rest;
}

// Light index-row projection for the default (unpaginated-no-more) GET
// /api/swarm/sessions response (issue #243). Deliberately drops
// subjectSnapshotTotalValueUsd — the large field behind the
// ~8.3MB unprojected payload — keeping everything else a list consumer
// (directory page, admin overview) already reads off a session row.
// synthesis rejoined this projection in issue #358 (see synthesisExcerpt()
// above): #323 made it a short deterministic sentence, so it no longer
// carries the concatenated-take-body weight that got it dropped originally.
// regimeSummary (issue #357) rides along in slim form (see
// toRegimeSummaryListItem) so the swarm index can render the regime
// label per row instead of falling back to session state.
export function toSessionListItem(row: Row): SwarmSessionListItem {
  return {
    id: row.id,
    date: day(row.date),
    subjectId: row.subject_id,
    subjectName: row.subject_name ?? null,
    state: row.state,
    windowClosesAt: instant(row.window_closes_at),
    publishedAt: instant(row.published_at),
    regimeSummary: toRegimeSummaryListItem(row.regime_summary),
    synthesis: synthesisExcerpt(row.synthesis),
    swarmRecommendation: row.swarm_recommendation ?? null,
    socialDraftId: row.social_draft_id ?? null,
    generatedAt: instant(row.generated_at) ?? "",
  };
}

export function toTake(row: Row): SwarmTake {
  return {
    id: row.id,
    memberId: row.member_handle ?? row.member_id,
    memberName: row.member_name,
    stance: row.stance ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    body: row.body ?? null,
    memoUrl: row.memo_url ?? null,
    ...(Array.isArray(row.payload?.weights) ? { weights: row.payload.weights } : {}),
    verified: Boolean(row.verified),
    // WHY `verified` ALONE IS NOT ENOUGH. It answers one question — "did this
    // member's signature check out against their registered key" — and the
    // public surfaces rendered its false case as the only reason it could be
    // false: "this take's signature did not check out. Treat it as
    // unattributed." For the takes imported from v0's pre-launch archive that
    // is simply untrue. They were never member-signed; member key registration
    // did not exist when they were published, so there is no failed check to
    // report. Same flag, two incompatible meanings, and the archive is the
    // larger population.
    //
    // So the read side says which it is, from the one durable marker the
    // import leaves (v0-archive.ts's nonce prefix). Rows fetched by a query
    // that does not select `nonce` report false, which is the safe direction:
    // a live submission is never mislabelled archival.
    archival: isV0ArchiveNonce(row.nonce),
    // Which revision of this member's take in this session this row is (issue
    // #573). Defaults to 1 rather than being omitted when the column is not
    // selected, because "revision 1" is exactly what every row was before
    // migration 0028 and what every archival row still is — an absent field
    // here would make a caller guess.
    revision: row.revision == null ? 1 : Number(row.revision),
    receivedAt: instant(row.received_at) ?? "",
  };
}

/**
 * Project the signed payload itself and recompute its verification result.
 * The denormalized columns and stored `verified` flag are intentionally not
 * authorities for a public receipt.
 */
export async function toVerifiedTake(row: Row): Promise<SwarmTake> {
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

export function toBrief(row: Row): SwarmBrief {
  return {
    id: row.id,
    date: day(row.date),
    subjectId: row.subject_id,
    // Which session this brief belongs to (migration 0028). Null only for
    // pre-0028 rows whose session was never archived — see the migration's
    // backfill note. Exposing it is what lets a caller that read a day-scoped
    // brief tell WHICH of the day's sessions it actually got.
    sessionId: row.session_id ?? null,
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
    memberId: row.member_handle ?? row.member_id,
    sessionId: row.session_id,
    title: row.title,
    body: row.body,
    createdAt: instant(row.created_at),
  };
}
