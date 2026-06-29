// Canonical signing payload for committee submissions — part of the protocol, so
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
  };
  return JSON.stringify(ordered);
}
