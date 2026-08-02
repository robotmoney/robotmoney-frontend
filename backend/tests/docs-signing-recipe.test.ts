// Doc-sample verification guard (issue #190). The public participation.html
// ("Generate your ed25519 identity" / "Sample: Node script" sections) shows a
// hand-rolled Web Crypto Ed25519 recipe as a fallback for participants who
// cannot install the recommended `rmpc` CLI:
//
//   1. crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign","verify"])
//   2. crypto.subtle.exportKey("raw", kp.publicKey) -> base64
//   3. canonical bytes from POST /api/swarm/signing-payload, which the
//      server computes as canonicalizeSubmission(draft) (see
//      backend/src/api/routes/swarm.ts)
//   4. crypto.subtle.sign({ name: "Ed25519" }, privateKey, canonicalBytes) -> base64
//
// Nothing previously executed this recipe end to end against the real
// verification path, so it could silently drift from
// contract/src/signing.js's canonicalizeSubmission or
// backend/src/lib/signing.ts's verifySubmissionSignature without failing CI.
// This test runs the doc's exact steps (not the signing.ts test helpers) and
// asserts the real backend verifier accepts it — and rejects a wrong key or a
// tampered field, exactly as the "Treat the bearer token like any API key" /
// canonicalization guarantees promise.
import { test, expect } from "bun:test";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { verifySubmissionSignature } from "../src/lib/signing.ts";

const ED25519 = { name: "Ed25519" } as const;

// Step 1-2 from the doc's "Generate your ed25519 identity" js sample.
async function docGenerateIdentity() {
  const kp = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const rawPub = await crypto.subtle.exportKey("raw", kp.publicKey);
  const publicKeyB64 = Buffer.from(rawPub).toString("base64");
  return { privateKey: kp.privateKey, publicKeyB64 };
}

// Step 4 from the doc's "Sample: Node script" — sign the canonical bytes and
// base64-encode, byte for byte as shown in the doc.
async function docSign(canonical: string, privateKey: CryptoKey) {
  const sigBytes = await crypto.subtle.sign(ED25519, privateKey, new TextEncoder().encode(canonical));
  return Buffer.from(sigBytes).toString("base64");
}

const draft = {
  memberId: "athena",
  date: "2026-07-20",
  subjectId: "woon",
  nonce: "doc-recipe-nonce",
  stance: "bullish",
  confidence: 0.7,
  body: "doc sample verification",
  memoUrl: "",
};

test("the doc's own Web Crypto identity + signing recipe is accepted by the real backend verifier", async () => {
  const identity = await docGenerateIdentity();

  // Step 3: the exact bytes /api/swarm/signing-payload returns is
  // canonicalizeSubmission(draft) — see backend/src/api/routes/swarm.ts.
  const canonical = canonicalizeSubmission(draft);
  const signature = await docSign(canonical, identity.privateKey);

  expect(await verifySubmissionSignature(draft, signature, identity.publicKeyB64)).toBe(true);
});

test("a signature from a different rmpc/Web Crypto identity is rejected", async () => {
  const identity = await docGenerateIdentity();
  const impostor = await docGenerateIdentity();

  const canonical = canonicalizeSubmission(draft);
  const signature = await docSign(canonical, identity.privateKey);

  expect(await verifySubmissionSignature(draft, signature, impostor.publicKeyB64)).toBe(false);
});

test("tampering a submitted field after signing invalidates the signature", async () => {
  const identity = await docGenerateIdentity();

  const canonical = canonicalizeSubmission(draft);
  const signature = await docSign(canonical, identity.privateKey);

  const tampered = { ...draft, stance: "bearish" };
  expect(await verifySubmissionSignature(tampered, signature, identity.publicKeyB64)).toBe(false);
});
