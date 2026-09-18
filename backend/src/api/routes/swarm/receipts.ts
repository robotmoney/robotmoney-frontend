import type { SwarmRouteExtension } from "./types.ts";
import { RECEIPT_DOMAIN_SEPARATOR, ROUTES } from "@robotmoney/contract";
import { getConsensusReceipt, getStoredConsensusReceipt } from "../../../swarm/consensus-receipt.ts";
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
//
// TWO ROUTES, ONE RECEIPT (decision D10). `CONSENSUS_RE` is the path
// robotmoney-core anchors on chain as `payloadUri`, and it answers the BARE
// canonical bytes: the exact keccak256 preimage of `payloadDigest`. Until D10
// it answered the read-time verification envelope instead, whose keccak256 is
// NOT the anchored digest, so a third party holding only the chain had to know
// from nowhere on chain to take `.receipt`, re-canonicalize it under the v1
// rules and hash that — an unwrap rule that had grown five implementations in
// three languages with no shared fixture. `CONSENSUS_VERIFIED_RE` is where that
// envelope lives now. Nothing anchors the verified path.
//
// The verified pattern is tested FIRST: both are anchored regexes so they
// cannot actually overlap, but the specific path being matched before the
// general one is the property a future `:id` loosening must not silently break.
const CONSENSUS_RE = new RegExp(`^${ROUTES.swarm.sessionConsensusReceipt.replace(":id", UUID)}$`, "i");
const CONSENSUS_VERIFIED_RE = new RegExp(`^${ROUTES.swarm.sessionConsensusReceiptVerified.replace(":id", UUID)}$`, "i");

const NO_RECEIPT = { error: "no consensus receipt published for this session" };

export const handleSwarmReceiptRoutes: SwarmRouteExtension = async (req, url) => {
  if (req.method !== "GET") return null;

  const verified = url.pathname.match(CONSENSUS_VERIFIED_RE);
  if (verified) {
    // Lowercased before the lookup for the same reason the payload is:
    // `session_id` has exactly one admitted spelling in schema 1.0, and two
    // URLs that differ only in case must not become two receipts.
    const stored = await getConsensusReceipt(decodeURIComponent(verified[1]!).toLowerCase());
    if (!stored) return { status: 404, body: NO_RECEIPT };
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

  const consensus = url.pathname.match(CONSENSUS_RE);
  if (consensus) {
    const stored = await getStoredConsensusReceipt(decodeURIComponent(consensus[1]!).toLowerCase());
    // A 404 is an ERROR, not content, so it is JSON — it must never be
    // mistakable for anchorable bytes by a consumer that skipped the status.
    if (!stored) return Response.json(NO_RECEIPT, { status: 404 });

    // THE PUBLISHED `canonical_bytes` TEXT COLUMN, CARRIED THROUGH VERBATIM
    // MINUS ITS PINNED DOMAIN PREFIX — and nothing else happens to it.
    //
    // WHY NOT `JSON.stringify(stored.receipt)`. `receipt` is a jsonb column and
    // Postgres normalizes jsonb key order, so re-serializing it would produce a
    // body deep-equal to the receipt and byte-UNSTABLE: a different digest for
    // the same anchor, which is the whole failure this route exists to remove.
    //
    // WHY THE PREFIX COMES OFF. The keccak256 preimage is
    // `robotmoney:consensus-receipt:v1\n` + compact JSON + `\n`
    // (consensus-receipt.canonicalization.json#domain_separator). The prefix is
    // a CONSTANT pinned in the shared fixture and in both repos' code, not data
    // — and a body carrying it is not JSON, so `rmpc receipt verify
    // --receipt-url` (which parses the fetched body with
    // `ConsensusReceipt::from_json_slice`) could not consume it, and neither
    // could a browser verifier. Serving the JSON segment keeps the body
    // parseable while leaving the derivation a single prepend of a constant:
    //   keccak256(RECEIPT_DOMAIN_SEPARATOR + body) == payloadDigest
    // The trailing newline IS part of the preimage and is therefore served.
    // That is a constant, not an unwrap rule: there is no field to select, no
    // second canonicalization, and no way to pick the wrong object — which is
    // exactly what D10 bought over anchoring the envelope.
    if (!stored.canonicalBytes.startsWith(RECEIPT_DOMAIN_SEPARATOR)) {
      // Unreachable for anything this server assembled, and loud rather than
      // clever if it ever is: bytes that do not carry the pinned schema-1.0
      // prefix are not the preimage this route promises, and slicing a fixed
      // length off them would serve a corrupted body under a 200.
      return Response.json(
        {
          error: "stored canonical bytes do not carry the schema 1.0 domain separator",
          schemaVersion: stored.schemaVersion,
        },
        { status: 500 },
      );
    }
    return new Response(stored.canonicalBytes.slice(RECEIPT_DOMAIN_SEPARATOR.length), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // A published receipt is immutable (trigger rm_consensus_receipt_immutable),
        // so the bytes at this URL never change once it answers 200.
        "cache-control": "public, max-age=31536000, immutable",
        // The anchored bytes are meant to be fetched by third-party verifiers
        // from anywhere, including a browser-based one.
        "access-control-allow-origin": "*",
      },
    });
  }

  const match = url.pathname.match(TAKE_RE);
  if (!match) return null;
  const receipt = await getTakeReceipt(decodeURIComponent(match[1]!));
  return receipt
    ? { status: 200, body: receipt }
    : { status: 404, body: { error: "not found" } };
};
