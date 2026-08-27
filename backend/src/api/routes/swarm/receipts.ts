import type { SwarmRouteExtension } from "./types.ts";
import { ROUTES } from "@robotmoney/contract";
import { getConsensusReceipt } from "../../../swarm/consensus-receipt.ts";
import { getTakeReceipt } from "../../../swarm/domain.ts";

/**
 * Route boundary reserved for issue #207's public take receipt endpoint.
 * It remains a no-op in the scout. The eventual response must follow the
 * read-time verification contract in
 * frontend/public/views/docs/investment-swarm/api-reference.html.
 */
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const TAKE_RE = new RegExp(`^${ROUTES.swarm.take.replace(":id", UUID)}$`, "i");
// The AGGREGATE receipt (issue #754), beside the per-take one. A STABLE PATH
// derived from the session id alone — not content-addressed — so a reader
// holding only a session id can reach it, and so the URL is the same before and
// after every redeploy.
const CONSENSUS_RE = new RegExp(`^${ROUTES.swarm.sessionConsensusReceipt.replace(":id", UUID)}$`, "i");

export const handleSwarmReceiptRoutes: SwarmRouteExtension = async (req, url) => {
  if (req.method !== "GET") return null;

  const consensus = url.pathname.match(CONSENSUS_RE);
  if (consensus) {
    // Lowercased before the lookup for the same reason the payload is:
    // `session_id` has exactly one admitted spelling in schema 1.0, and two
    // URLs that differ only in case must not become two receipts.
    const stored = await getConsensusReceipt(decodeURIComponent(consensus[1]!).toLowerCase());
    if (!stored) return { status: 404, body: { error: "no consensus receipt published for this session" } };
    return {
      status: 200,
      body: {
        // SERVED AS UNVERIFIED, NEVER WITHHELD AND NEVER PASSED OFF AS VALID.
        // `verified` is recomputed on this request — it is not a stored column —
        // and one bad embedded signature, one failed invariant, or a payload
        // that no longer canonicalizes to its published bytes makes the whole
        // receipt unverified with the reasons stated.
        sessionId: stored.sessionId,
        subjectId: stored.subjectId,
        schemaVersion: stored.schemaVersion,
        publishedAt: stored.publishedAt,
        receipt: stored.receipt,
        canonicalBytes: stored.canonicalBytes,
        verified: stored.verified,
        signatures: stored.signatures,
        unverifiedReasons: stored.unverifiedReasons,
      },
    };
  }

  const match = url.pathname.match(TAKE_RE);
  if (!match) return null;
  const receipt = await getTakeReceipt(decodeURIComponent(match[1]!));
  return receipt
    ? { status: 200, body: receipt }
    : { status: 404, body: { error: "not found" } };
};
