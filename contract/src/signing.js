// Canonical signing payload for committee submissions — part of the protocol, so
// it lives in the contract and is shared by the backend (verify), the MCP server
// (get_signing_payload), and member agents (sign). Deterministic: fixed key order
// + JSON.stringify, so every party produces identical bytes.
export function canonicalizeSubmission(s) {
  const proposedWeights = s.proposedWeights && typeof s.proposedWeights === "object"
    ? Object.fromEntries(Object.entries(s.proposedWeights).sort(([a], [b]) => a.localeCompare(b)))
    : "";
  const ordered = {
    memberId: s.memberId,
    date: s.date,
    subjectId: s.subjectId,
    nonce: s.nonce,
    stance: s.stance,
    confidence: s.confidence,
    body: s.body ?? "",
    memoUrl: s.memoUrl ?? "",
    // Additive protocol field: it is deliberately appended so the pre-Phase-1
    // field order never moves. An absent proposal has one stable representation.
    proposedWeights,
  };
  return JSON.stringify(ordered);
}

// Public applications prove the submitted Ed25519 key is usable before an
// operator reviews it. The server derives this exact message; callers cannot
// substitute arbitrary signed text.
export function applicationProofMessage(memberId, publicKey) {
  return `robotmoney:apply:${String(memberId).trim()}:${String(publicKey).trim()}`;
}
