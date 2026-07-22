import { test, expect } from "bun:test";
import { canonicalizeClaimChallenge, canonicalizeSubmission } from "@robotmoney/contract";
import {
  generateKeyPair,
  isValidEd25519PublicKey,
  signMessage,
  verifyStoredSubmissionSignature,
  verifySubmissionSignature,
} from "../src/lib/signing.ts";

const sub = { memberId: "m1", date: "2026-06-30", subjectId: "woon", nonce: "n1", stance: "bullish", confidence: 0.8, body: "hi", memoUrl: "https://x/m" };

const legacySubmission = {
  memberId: "legacy-member",
  date: "2026-07-20",
  subjectId: "legacy-subject",
  nonce: "legacy-nonce",
  stance: "neutral",
  confidence: 0.625,
  body: "legacy signed body",
  memoUrl: "https://example.test/memo",
};
const legacyPublicKeyB64 = "YmUwLbJYgrbWC5g6UJ+v4t8hVmCCPHeDhTYR5zdlxhA=";
const legacySignatureB64 = "2w3ubE+a7vwW96xCB6SitBUoz9oWCPJW9COc4uPz2XvZR3szZeu+pTBW5mewJ21e7gaPOWDW3gIARL4YYRXCCg==";

test("valid signature verifies; wrong key + tampered fields are rejected", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const sig = await signMessage(canonicalizeSubmission(sub), a.privateKey);
  expect(await verifySubmissionSignature(sub, sig, a.publicKeyB64)).toBe(true);
  expect(await verifySubmissionSignature(sub, sig, b.publicKeyB64)).toBe(false);
  expect(await verifySubmissionSignature({ ...sub, stance: "bearish" }, sig, a.publicKeyB64)).toBe(false);
});

test("raw Ed25519 public-key validation shares the canonical import path", async () => {
  const valid = await generateKeyPair();
  expect(await isValidEd25519PublicKey(valid.publicKeyB64)).toBe(true);
  expect(await isValidEd25519PublicKey(valid.publicKeyB64.slice(0, -4))).toBe(false);
  expect(await isValidEd25519PublicKey("not-base64!!!")).toBe(false);
  expect(await isValidEd25519PublicKey(Buffer.alloc(31, 7).toString("base64"))).toBe(false);
  expect(await isValidEd25519PublicKey(Buffer.alloc(33, 7).toString("base64"))).toBe(false);
});

test("memoUrl is covered by the signature (tampering it invalidates)", async () => {
  const a = await generateKeyPair();
  const sig = await signMessage(canonicalizeSubmission(sub), a.privateKey);
  expect(await verifySubmissionSignature({ ...sub, memoUrl: "https://evil/x" }, sig, a.publicKeyB64)).toBe(false);
});

test("canonicalization is deterministic and key-order independent", () => {
  const a = canonicalizeSubmission(sub);
  const b = canonicalizeSubmission({ memoUrl: sub.memoUrl, body: sub.body, confidence: sub.confidence, stance: sub.stance, nonce: sub.nonce, subjectId: sub.subjectId, date: sub.date, memberId: sub.memberId } as any);
  expect(a).toBe(b);
});

test("weights-less canonical bytes and pre-recorded signatures remain backward compatible", async () => {
  expect(canonicalizeSubmission(legacySubmission)).toBe(
    '{"memberId":"legacy-member","date":"2026-07-20","subjectId":"legacy-subject","nonce":"legacy-nonce","stance":"neutral","confidence":0.625,"body":"legacy signed body","memoUrl":"https://example.test/memo"}',
  );
  expect(await verifySubmissionSignature(legacySubmission, legacySignatureB64, legacyPublicKeyB64)).toBe(true);
});

test("weighted submissions sign the appended weights and reject tampering", async () => {
  const identity = await generateKeyPair();
  const weighted = {
    ...sub,
    weights: [
      { bucket: "conservative_defi_yield", weight: 3 },
      { bucket: "agent_tokens", weight: 1 },
    ],
  };
  const canonical = canonicalizeSubmission(weighted);
  expect(canonical.endsWith('"weights":[{"bucket":"conservative_defi_yield","weight":3},{"bucket":"agent_tokens","weight":1}]}')).toBe(true);
  const signature = await signMessage(canonical, identity.privateKey);
  expect(await verifySubmissionSignature(weighted, signature, identity.publicKeyB64)).toBe(true);
  expect(await verifySubmissionSignature({
    ...weighted,
    weights: [{ bucket: "conservative_defi_yield", weight: 2 }, { bucket: "agent_tokens", weight: 2 }],
  }, signature, identity.publicKeyB64)).toBe(false);
});

test("claim challenges use a separate versioned canonical signing domain", () => {
  expect(canonicalizeClaimChallenge({
    memberId: "m1",
    challenge: "challenge-1",
    expiresAt: "2026-07-21T18:30:00.000Z",
  })).toBe('{"purpose":"committee-token-claim-v1","memberId":"m1","challenge":"challenge-1","expiresAt":"2026-07-21T18:30:00.000Z"}');
});

test("stored submission seam re-verifies canonical bytes at read time", async () => {
  const a = await generateKeyPair();
  const sig = await signMessage(canonicalizeSubmission(sub), a.privateKey);
  expect(await verifyStoredSubmissionSignature({
    submission: sub,
    signatureB64: sig,
    publicKeyB64: a.publicKeyB64,
  })).toBe(true);
  expect(await verifyStoredSubmissionSignature({
    submission: { ...sub, body: "tampered" },
    signatureB64: sig,
    publicKeyB64: a.publicKeyB64,
  })).toBe(false);
});
