import { test, expect } from "bun:test";
import { applicationProofMessage, canonicalizeSubmission } from "@robotmoney/contract";
import { generateKeyPair, signMessage, verifyMessageSignature, verifySubmissionSignature } from "../src/lib/signing.ts";

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

test("canonicalization appends sorted proposed weights with a stable absent default", () => {
  const absent = JSON.parse(canonicalizeSubmission(sub));
  expect(absent.proposedWeights).toBe("");
  expect(Object.keys(absent).at(-1)).toBe("proposedWeights");

  const first = canonicalizeSubmission({ ...sub, proposedWeights: { protocol_tokens: 0.2, agent_tokens: 0.8 } });
  const second = canonicalizeSubmission({ ...sub, proposedWeights: { agent_tokens: 0.8, protocol_tokens: 0.2 } });
  expect(first).toBe(second);
  expect(JSON.parse(first).proposedWeights).toEqual({ agent_tokens: 0.8, protocol_tokens: 0.2 });
});

test("application proof binds the member id and exact public key", async () => {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const message = applicationProofMessage("athena", publicKeyB64);
  const signature = await signMessage(message, privateKey);
  expect(await verifyMessageSignature(message, signature, publicKeyB64)).toBe(true);
  expect(await verifyMessageSignature(applicationProofMessage("boreas", publicKeyB64), signature, publicKeyB64)).toBe(false);
});
