// THE ANCHORED URL SERVES THE ANCHORED BYTES (decision D10).
//
// WHAT WAS WRONG. `payloadUri` is written on chain beside `payloadDigest`.
// Until this change `payloadUri` pointed at
// GET /api/swarm/sessions/:id/consensus-receipt, which answered a READ-TIME
// VERIFICATION ENVELOPE — {sessionId, …, receipt, canonicalBytes, verified, …}
// — whose keccak256 is NOT payloadDigest. Only the `canonicalBytes` string
// inside it hashes to the anchor. A third party holding nothing but the chain
// could not check the commitment without knowing, from nowhere on chain, to
// unwrap `.receipt`, re-canonicalize it under the v1 rules and hash that; and
// that unwrap rule had grown five implementations in three languages
// (phase3/3.1-FINDING-the-anchored-url-does-not-serve-the-anchored-bytes.txt,
// review task T24).
//
// WHAT D10 DECIDED, option (a): the anchored route returns the BARE CANONICAL
// BYTES — the exact preimage, byte for byte — and the envelope moves to the
// sibling route .../consensus-receipt/verified. That turns "verify the anchor"
// into fetch + keccak256 + compare, and turns T01's "refuse unless the URL
// drafted from is the anchored payloadUri" into plain string equality.
//
// WHAT THIS FILE ASSERTS, and why each case is here rather than implied:
//   1. the bare route's response body is byte-identical to the stored
//      `canonical_bytes` column minus its pinned domain prefix — not deep-equal
//      JSON, byte-identical, because a digest is taken over bytes and Postgres
//      jsonb does not round-trip key order (the sibling test in
//      consensus-receipt-envelope-shape.test.ts records that reordering);
//   2. keccak256(RECEIPT_DOMAIN_SEPARATOR + body) equals the digest pinned
//      below — this repo's first executed keccak256 assertion, discharging the
//      consumer obligation consensus-receipt.canonicalization.json#digest_note
//      parked on robotmoney-core. THE PREFIX IS WHY THE BODY IS NOT THE WHOLE
//      PREIMAGE: the canonical form is
//      `robotmoney:consensus-receipt:v1\n` + compact JSON + `\n`, and a body
//      carrying that prefix is not JSON, so `rmpc receipt verify --receipt-url`
//      — which parses the fetched body — could not read it. Prepending a
//      constant pinned in the shared fixture is not an unwrap rule: there is no
//      field to select and no second canonicalization, which is the whole
//      difference D10 bought;
//   3. it is byte-stable across requests, since an anchor is a promise about
//      every future fetch, not about the first one;
//   4. it is served as application/json with no envelope keys at the top level,
//      so `rmpc receipt verify --receipt-url` parses it directly;
//   5. the envelope still exists, unchanged in shape and still `verified: true`,
//      at the new URL — the human/verifier surface is moved, not deleted.
import { expect, test } from "bun:test";
import { RECEIPT_DOMAIN_SEPARATOR, ROUTES, canonicalizeReceipt, path } from "@robotmoney/contract";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { sql } from "../src/db/client.ts";
import { keccak256 } from "./support/keccak256.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const FIXTURES = join(import.meta.dir, "../node_modules/@robotmoney/contract/src/__fixtures__");
const ENVELOPE = JSON.parse(readFileSync(join(FIXTURES, "consensus-receipt.envelope.json"), "utf8"));
const spec = JSON.parse(readFileSync(join(FIXTURES, "consensus-receipt.canonicalization.json"), "utf8"));

// The keccak256 of the shared fixture's canonical bytes. NOT copied from a
// document: it is computed once here from the fixture and pinned, so a change
// to the fixture bytes, to the canonicalizer, or to what the route serves all
// surface as this constant failing. This is the value robotmoney-core anchors
// as `payloadDigest` for this receipt.
const PINNED_DIGEST = "0xd3e85fdd5fdbc7da72d0853bfeaa3f3a4288ad5392c39f2e0dee0d82c7f7b2d1";

const call = (p: string) => handleSwarm(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));
const bareUrl = (id: string) => path(ROUTES.swarm.sessionConsensusReceipt, { id });
const verifiedUrl = (id: string) => path(ROUTES.swarm.sessionConsensusReceiptVerified, { id });

async function seedStoredReceipt(): Promise<void> {
  const receipt = ENVELOPE.receipt;
  await sql`INSERT INTO swarm_subjects (id, name) VALUES (${ENVELOPE.subjectId}, 'Bare Bytes Fixture')`;
  await sql`
    INSERT INTO swarm_sessions (id, subject_id, convened_at, subject_name, state)
    VALUES (${ENVELOPE.sessionId}, ${ENVELOPE.subjectId}, ${receipt.created_at}, 'Bare Bytes Fixture', 'published')`;
  const [judgement] = (await sql`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, opinion)
    VALUES (${ENVELOPE.sessionId}, 'enforce', 'model', 'fixture-judge', ${receipt.prompt_hash},
            ${receipt.inputs_digest}, ${receipt.analyst_signatures.length}, 1, ${sql.json({ summary: "fixture" })})
    RETURNING id`) as { id: string }[];
  await sql`
    INSERT INTO swarm_consensus_receipts
      (session_id, subject_id, schema_version, judgement_id, session_version, receipt, canonical_bytes, published_at)
    VALUES (${ENVELOPE.sessionId}, ${ENVELOPE.subjectId}, ${ENVELOPE.schemaVersion}, ${judgement!.id}, 1,
            ${sql.json(ENVELOPE.receipt)}, ${ENVELOPE.canonicalBytes}, ${ENVELOPE.publishedAt})`;
}

test("the keccak256 helper is right before anything is judged by it", () => {
  // NEGATIVE SELF-TEST FIRST (checklist C-21). A hash function that returned a
  // constant, or NIST SHA3-256 instead of Keccak, would make every assertion
  // below pass against itself and mean nothing. These are the published
  // Keccak-256 vectors; the third case crosses the 136-byte rate boundary, so
  // an absorb loop that only ever ran one block is caught too.
  const utf8 = (s: string) => new TextEncoder().encode(s);
  expect(keccak256(utf8(""))).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  expect(keccak256(utf8("abc"))).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  expect(keccak256(utf8("a".repeat(136)))).toBe("0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e");
  // And it is NOT SHA3-256 — the one wrong answer that looks right.
  const sha3 = new Bun.CryptoHasher("sha3-256").update(utf8("")).digest("hex");
  expect(keccak256(utf8(""))).not.toBe(`0x${sha3}`);
  // A one-bit change moves it.
  expect(keccak256(utf8("abc"))).not.toBe(keccak256(utf8("abd")));
});

test("the ANCHORED route serves the BARE canonical bytes, byte for byte", async () => {
  await seedStoredReceipt();
  const res = (await call(bareUrl(ENVELOPE.sessionId))) as Response;
  expect(res).toBeInstanceOf(Response);
  expect(res.status).toBe(200);
  // application/json, because the bytes ARE json and rmpc parses them as json.
  expect(res.headers.get("content-type")).toBe("application/json");

  const served = await res.text();
  // THE assertion of decision D10: what the URL returns is the preimage's JSON
  // segment, not a wrapper around it. Compared as a string, not parsed, because
  // parsing is exactly the step that would hide a byte difference.
  expect(RECEIPT_DOMAIN_SEPARATOR + served).toBe(ENVELOPE.canonicalBytes);
  // And the bytes are what the database holds, not something re-derived on the
  // request path: the served text must come from the stored column.
  const [row] = (await sql`
    SELECT canonical_bytes FROM swarm_consensus_receipts WHERE session_id = ${ENVELOPE.sessionId}`) as {
    canonical_bytes: string;
  }[];
  expect(RECEIPT_DOMAIN_SEPARATOR + served).toBe(row!.canonical_bytes);
  // The trailing newline is part of the preimage, so it is part of the body.
  expect(served.endsWith("}\n")).toBe(true);
  // It re-canonicalizes to itself, so the bytes really are canonical and not
  // merely equal to a stored string that drifted from the rules.
  expect(canonicalizeReceipt(JSON.parse(served), spec)).toBe(RECEIPT_DOMAIN_SEPARATOR + served);
  // NO ENVELOPE at the top level: a consumer must not have to unwrap.
  const parsed = JSON.parse(served) as Record<string, unknown>;
  for (const enveloped of ["receipt", "canonicalBytes", "verified", "signatures", "unverifiedReasons", "publishedAt"]) {
    expect(parsed).not.toHaveProperty(enveloped);
  }
  expect(parsed).toHaveProperty("schema_version");
  expect(parsed.session_id).toBe(ENVELOPE.sessionId);
});

test("keccak256 of what the anchored URL serves IS the anchored payloadDigest", async () => {
  await seedStoredReceipt();
  const res = (await call(bareUrl(ENVELOPE.sessionId))) as Response;
  const body = new Uint8Array(await res.arrayBuffer());
  // Over the RESPONSE BYTES, not over a re-encoded string: a stray BOM, a
  // dropped trailing newline, or a non-UTF-8 encoding all change the digest and
  // all would survive a comparison done after decoding.
  const prefix = new TextEncoder().encode(RECEIPT_DOMAIN_SEPARATOR);
  const preimage = new Uint8Array(prefix.length + body.length);
  preimage.set(prefix);
  preimage.set(body, prefix.length);
  expect(keccak256(preimage)).toBe(PINNED_DIGEST);
  expect(keccak256(new TextEncoder().encode(ENVELOPE.canonicalBytes))).toBe(PINNED_DIGEST);
  // The body alone is NOT the digest — stated so the prepend is a checked
  // requirement rather than a comment, and so a future route that started
  // serving the prefix inline would fail here instead of silently anchoring a
  // digest no consumer computes.
  expect(keccak256(body)).not.toBe(PINNED_DIGEST);
});

test("the anchored bytes are stable across requests", async () => {
  await seedStoredReceipt();
  const a = await ((await call(bareUrl(ENVELOPE.sessionId))) as Response).text();
  const b = await ((await call(bareUrl(ENVELOPE.sessionId))) as Response).text();
  // An anchor is a promise about every fetch. A response assembled from the
  // jsonb `receipt` column would be deep-equal and byte-unstable; carrying the
  // `canonical_bytes` text column through is what makes this hold.
  expect(a).toBe(b);
  expect(keccak256(new TextEncoder().encode(RECEIPT_DOMAIN_SEPARATOR + a))).toBe(PINNED_DIGEST);
});

test("the ENVELOPE lives at the sibling /verified route, unchanged in shape", async () => {
  await seedStoredReceipt();
  const res = (await call(verifiedUrl(ENVELOPE.sessionId))) as { status: number; body: Record<string, unknown> };
  expect(res.status).toBe(200);
  expect(res.body).toEqual(ENVELOPE);
  expect(Object.keys(res.body)).toEqual(Object.keys(ENVELOPE));
  expect(res.body.verified).toBe(true);
  // The envelope's own copy of the bytes is the same object the bare route
  // serves — one receipt, two representations, no third.
  expect(res.body.canonicalBytes).toBe(
    RECEIPT_DOMAIN_SEPARATOR + (await ((await call(bareUrl(ENVELOPE.sessionId))) as Response).text()),
  );
});

test("both routes 404 as JSON for a session with no published receipt", async () => {
  const missing = "12440000-0000-4000-8000-00000000dead";
  const bare = (await call(bareUrl(missing))) as Response;
  expect(bare).toBeInstanceOf(Response);
  expect(bare.status).toBe(404);
  // A 404 is an ERROR, not a receipt: it must never be served as if it were
  // anchorable content, so it is a JSON error object and not bare bytes.
  expect(await bare.json()).toEqual({ error: "no consensus receipt published for this session" });
  const verified = (await call(verifiedUrl(missing))) as { status: number; body: unknown };
  expect(verified.status).toBe(404);
  expect(verified.body).toEqual({ error: "no consensus receipt published for this session" });
});
