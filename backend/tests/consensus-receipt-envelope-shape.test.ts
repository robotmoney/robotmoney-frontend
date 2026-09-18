// THE READ-TIME ENVELOPE IS A PINNED SHAPE, NOT A ROUTE-LOCAL CONVENTION (T24).
//
// GET /api/swarm/sessions/:id/consensus-receipt/verified serves a read-time
// verification envelope around the receipt. (Its sibling — the ANCHORED path
// without /verified — serves the bare canonical bytes since decision D10;
// consensus-receipt-bare-bytes.test.ts owns that one, and the two files
// together are what stops the envelope and the anchor being confused again.)
// Every consumer
// downstream — rmpc, the devnet acceptance gate, robotmoney-core's shell
// helpers, the dapp — has to parse that shape, and before
// contract/src/__fixtures__/consensus-receipt.envelope.json existed they each
// carried their own inline literal of it, and the literals had already drifted
// apart. The fixture is now the single representation, shared byte-identically
// with robotmoney-core.
//
// WHAT THIS FILE ADDS THAT THE CONTRACT UNIT TEST CANNOT. The contract suite
// (tests/unit/consensus-receipt-shared-vectors.test.ts) asserts the fixture is
// internally consistent — right keys, right order, canonicalBytes equal to the
// golden. It has no route and no database, so it cannot tell you whether THIS
// SERVER still produces that shape. This test stores the fixture's receipt as a
// real row and drives the real HTTP handler, so the assertion is the one that
// matters: for a stored receipt, the served body IS the fixture. A renamed key,
// a reordered response object, a dropped `unverifiedReasons`, or a `verified`
// flag read from a column instead of recomputed all turn this red.
//
// NOTHING IS MOCKED. The row goes in through SQL, the verdict comes back out of
// the real read-time verifier — so `verified: true` here means the fixture's
// embedded Ed25519 signatures actually verify and its payload actually
// re-canonicalizes to its published bytes on this build.
import { expect, test } from "bun:test";
import { ROUTES, canonicalizeReceipt, path } from "@robotmoney/contract";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const FIXTURES = join(import.meta.dir, "../node_modules/@robotmoney/contract/src/__fixtures__");
const ENVELOPE = JSON.parse(readFileSync(join(FIXTURES, "consensus-receipt.envelope.json"), "utf8"));
const spec = JSON.parse(readFileSync(join(FIXTURES, "consensus-receipt.canonicalization.json"), "utf8"));

const get = (p: string) => handleSwarm(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));

/** Store the fixture's receipt verbatim, exactly as a publish would have left it. */
async function seedStoredReceipt(): Promise<void> {
  const receipt = ENVELOPE.receipt;
  await sql`INSERT INTO swarm_subjects (id, name) VALUES (${ENVELOPE.subjectId}, 'Envelope Shape Fixture')`;
  await sql`
    INSERT INTO swarm_sessions (id, subject_id, convened_at, subject_name, state)
    VALUES (${ENVELOPE.sessionId}, ${ENVELOPE.subjectId}, ${receipt.created_at}, 'Envelope Shape Fixture', 'published')`;
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

test("the served envelope IS consensus-receipt.envelope.json, key for key and value for value", async () => {
  await seedStoredReceipt();
  const res = (await get(path(ROUTES.swarm.sessionConsensusReceiptVerified, { id: ENVELOPE.sessionId }))) as {
    status: number;
    body: Record<string, unknown>;
  };
  expect(res.status).toBe(200);
  // toEqual first, so a value difference reports as a value difference rather
  // than as a key-order failure two lines down.
  expect(res.body).toEqual(ENVELOPE);
  // ENVELOPE KEY ORDER as well as membership: the envelope's nine keys are
  // written out one by one by the route, so their order is the route's choice
  // and a reorder there is a real change to what consumers receive.
  expect(Object.keys(res.body)).toEqual(Object.keys(ENVELOPE));
});

test("the RECEIPT's key order is NOT preserved through storage — and that is why canonicalBytes exists", async () => {
  // A RECORDED PROPERTY, and a load-bearing one. `receipt` is a jsonb column,
  // and Postgres jsonb normalizes object key order (shortest key first, then
  // by code point); it does not round-trip the insertion order. So the served
  // `receipt` is deep-equal to the fixture but NOT byte-equal to it, and any
  // consumer that hashes the served JSON text would compute a digest that
  // depends on Postgres's normalization rather than on the receipt.
  //
  // That is precisely the failure the canonicalization contract removes: the
  // preimage is never the served bytes. `canonicalBytes` is carried verbatim in
  // a `text` column, and re-canonicalizing the served receipt reproduces it —
  // asserted below, so the claim is checked rather than argued.
  await seedStoredReceipt();
  const res = (await get(path(ROUTES.swarm.sessionConsensusReceiptVerified, { id: ENVELOPE.sessionId }))) as {
    status: number;
    body: any;
  };
  expect(res.body.receipt).toEqual(ENVELOPE.receipt);
  expect(Object.keys(res.body.receipt)).not.toEqual(Object.keys(ENVELOPE.receipt));
  expect(Object.keys(res.body.receipt).sort()).toEqual(Object.keys(ENVELOPE.receipt).sort());
  // The pin survives the reordering, in both directions.
  expect(canonicalizeReceipt(res.body.receipt, spec)).toBe(ENVELOPE.canonicalBytes);
  expect(res.body.canonicalBytes).toBe(ENVELOPE.canonicalBytes);
});

test("`verified` is RECOMPUTED on the read, not echoed from storage", async () => {
  // The stored row carries NO verdict: swarm_consensus_receipts has no
  // `verified`, `signatures` or `unverified_reasons` column, and the table is
  // immutable once written (migration trigger rm_consensus_receipt_immutable,
  // which is why this case seeds its own row instead of tampering with the
  // one above). So the only way the served envelope can report a bad signature
  // is by re-verifying the payload on the request.
  const columns = (await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'swarm_consensus_receipts'`) as { column_name: string }[];
  const names = columns.map((c) => c.column_name);
  for (const absent of ["verified", "signatures", "unverified_reasons"]) expect(names).not.toContain(absent);

  // One flipped bit in one embedded signature. Everything else — the payload,
  // the published bytes it canonicalizes to, the schema, the invariants — is
  // still intact, so a route that only re-checked the cheap things stays green.
  const sessionId = "12440000-0000-4000-8000-0000000000ff";
  await sql`INSERT INTO swarm_subjects (id, name) VALUES (${ENVELOPE.subjectId}, 'Envelope Shape Fixture')`;
  const tampered = structuredClone(ENVELOPE.receipt);
  tampered.session_id = sessionId;
  const raw = Buffer.from(tampered.analyst_signatures[0].signature, "base64");
  raw[0] = raw[0]! ^ 0xff;
  tampered.analyst_signatures[0].signature = raw.toString("base64");
  const canonicalBytes = canonicalizeReceipt(tampered, spec);

  await sql`
    INSERT INTO swarm_sessions (id, subject_id, convened_at, subject_name, state)
    VALUES (${sessionId}, ${ENVELOPE.subjectId}, ${tampered.created_at}, 'Envelope Shape Fixture', 'published')`;
  const [judgement] = (await sql`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, opinion)
    VALUES (${sessionId}, 'enforce', 'model', 'fixture-judge', ${tampered.prompt_hash},
            ${tampered.inputs_digest}, ${tampered.analyst_signatures.length}, 1, ${sql.json({ summary: "fixture" })})
    RETURNING id`) as { id: string }[];
  await sql`
    INSERT INTO swarm_consensus_receipts
      (session_id, subject_id, schema_version, judgement_id, session_version, receipt, canonical_bytes, published_at)
    VALUES (${sessionId}, ${ENVELOPE.subjectId}, ${ENVELOPE.schemaVersion}, ${judgement!.id}, 1,
            ${sql.json(tampered)}, ${canonicalBytes}, ${ENVELOPE.publishedAt})`;

  const res = (await get(path(ROUTES.swarm.sessionConsensusReceiptVerified, { id: sessionId }))) as { status: number; body: any };
  // SERVED, NOT WITHHELD, and not passed off as valid: the envelope shape is
  // unchanged, `verified` is false, and the reason names the member.
  expect(res.status).toBe(200);
  expect(Object.keys(res.body)).toEqual(Object.keys(ENVELOPE));
  expect(res.body.verified).toBe(false);
  expect(res.body.signatures[0]).toEqual({ memberId: ENVELOPE.signatures[0].memberId, verified: false });
  expect(res.body.signatures.slice(1)).toEqual(ENVELOPE.signatures.slice(1));
  expect(res.body.unverifiedReasons.join("\n")).toContain(ENVELOPE.signatures[0].memberId);
  // The failure is attributed to the SIGNATURE and nothing else: the payload
  // still canonicalizes to its published bytes, so this test cannot pass by
  // making the whole receipt degenerate.
  expect(res.body.unverifiedReasons).toHaveLength(1);
  expect(res.body.canonicalBytes).toBe(canonicalBytes);
});
