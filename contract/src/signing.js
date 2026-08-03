// Canonical signing payload for swarm submissions — part of the protocol, so
// it lives in the contract and is shared by the backend (verify), the MCP server
// (get_signing_payload), and member agents (sign). Deterministic: fixed key order
// + JSON.stringify, so every party produces identical bytes.
export function canonicalizeSubmission(s) {
  const ordered = {
    memberId: s.memberId,
    date: s.date,
    subjectId: s.subjectId,
    nonce: s.nonce,
    stance: s.stance,
    confidence: s.confidence,
    body: s.body ?? "",
    memoUrl: s.memoUrl ?? "",
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
