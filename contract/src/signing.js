// Canonical signing payload for swarm submissions — part of the protocol, so
// it lives in the contract and is shared by the backend (verify), the MCP server
// (get_signing_payload), and member agents (sign). Deterministic: fixed key order
// + JSON.stringify, so every party produces identical bytes.
//
// SCHEMA 1.0 (legacy, unversioned) vs SCHEMA 2.0 (issue #978). Every
// submission ever signed before #978 has no `reportSnapshotId` field at all,
// so schema 1.0's bytes are EXACTLY what this function has always produced —
// no `schemaVersion` marker, unchanged byte for byte, for a submission that
// omits `reportSnapshotId`. A submission that NAMES one (the analytics
// report snapshot its author saw when composing the take — see
// swarm/domain.ts submitRecommendation) signs schema 2.0 instead: an explicit
// `schemaVersion: "2.0"` marker first, then the same fields in the same
// order, PLUS `reportSnapshotId` appended after `memoUrl` and before
// `weights`. Same "append an optional field, never reorder or retype an
// existing one" discipline consensus-receipt.js's schema_version documents —
// a version bump publishes new bytes going forward and never touches a
// historical row's already-signed bytes, which is exactly what lets a
// pre-#978 fixture keep verifying under this SAME function with no branch on
// the caller's part.
export function canonicalizeSubmission(s) {
  const ordered = {
    ...(s.reportSnapshotId != null ? { schemaVersion: "2.0" } : {}),
    memberId: s.memberId,
    date: s.date,
    subjectId: s.subjectId,
    nonce: s.nonce,
    stance: s.stance,
    confidence: s.confidence,
    body: s.body ?? "",
    memoUrl: s.memoUrl ?? "",
    ...(s.reportSnapshotId != null ? { reportSnapshotId: s.reportSnapshotId } : {}),
    ...(s.weights != null ? {
      weights: s.weights.map((entry) => ({ bucket: entry.bucket, weight: entry.weight })),
    } : {}),
  };
  return JSON.stringify(ordered);
}

// Token-claim challenges deliberately use a separate signing domain from
// swarm submissions. Issue #205 owns persistence, expiry enforcement, and
// claim behavior; this scout only establishes the protocol seam. Canonical
// onboarding behavior is documented in
// frontend/public/views/docs/investment-swarm/participation.html.
export function canonicalizeClaimChallenge(challenge) {
  return JSON.stringify({
    purpose: "swarm-token-claim-v1",
    memberId: challenge.memberId,
    challenge: challenge.challenge,
    expiresAt: challenge.expiresAt,
  });
}
