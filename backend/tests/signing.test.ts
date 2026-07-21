import { test, expect } from "bun:test";
import { canonicalizeClaimChallenge, canonicalizeSubmission } from "@robotmoney/contract";
import {
  generateKeyPair,
  signMessage,
  verifyStoredSubmissionSignature,
  verifySubmissionSignature,
} from "../src/lib/signing.ts";

const sub = { memberId: "m1", date: "2026-06-30", subjectId: "woon", nonce: "n1", stance: "bullish", confidence: 0.8, body: "hi", memoUrl: "https://x/m" };

test("valid signature verifies; wrong key + tampered fields are rejected", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const sig = await signMessage(canonicalizeSubmission(sub), a.privateKey);
  expect(await verifySubmissionSignature(sub, sig, a.publicKeyB64)).toBe(true);
  expect(await verifySubmissionSignature(sub, sig, b.publicKeyB64)).toBe(false);
  expect(await verifySubmissionSignature({ ...sub, stance: "bearish" }, sig, a.publicKeyB64)).toBe(false);
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
