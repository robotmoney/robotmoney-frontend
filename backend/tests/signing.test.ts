import { test, expect } from "bun:test";
import { canonicalizeApplication, canonicalizeClaimChallenge, canonicalizeSubmission } from "@robotmoney/contract";
import {
  fingerprintPublicKey,
  generateKeyPair,
  isLowOrderEd25519PublicKey,
  isValidEd25519PublicKey,
  signMessage,
  verifyApplicationSignature,
  verifyClaimChallengeSignature,
  verifyStoredSubmissionSignature,
  verifySubmissionSignature,
} from "../src/lib/signing.ts";
import {
  ALL_ZEROS_PUBLIC_KEY_B64,
  FORGED_SIGNATURE_B64,
  IDENTITY_PUBLIC_KEY_B64,
  LIBSODIUM_SMALL_ORDER_BLACKLIST_HEX,
  LOW_ORDER_ED25519_PUBLIC_KEYS_B64,
  LOW_ORDER_ED25519_PUBLIC_KEYS_HEX,
} from "./support/low-order-ed25519.ts";

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
  })).toBe('{"purpose":"swarm-token-claim-v1","memberId":"m1","challenge":"challenge-1","expiresAt":"2026-07-21T18:30:00.000Z"}');
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

// ---------------------------------------------------------------------------
// Issue #789 — low-order Ed25519 public keys.
//
// Before the fix, WebCrypto imported all 14 low-order point encodings and the
// single public constant `0x01 || 0x00*63` verified as a signature over any
// message for any of them, on every entry point in this module. The rejection
// lives at DECODE time (canonicalPublicKeyBytes), not at verification time, so
// such a key cannot enter swarm_member_keys in the first place.
//
// The encodings these tests use are derived from the curve in
// tests/support/low-order-ed25519.ts, not imported from the table signing.ts
// rejects with, so a pass is evidence about Ed25519 rather than a tautology.
// ---------------------------------------------------------------------------

test("the derived low-order set is exactly 14 encodings and matches libsodium's blacklist", () => {
  expect(LOW_ORDER_ED25519_PUBLIC_KEYS_HEX).toHaveLength(14);
  expect(LOW_ORDER_ED25519_PUBLIC_KEYS_B64).toHaveLength(14);
  const signBitMasked = [...new Set(LOW_ORDER_ED25519_PUBLIC_KEYS_HEX.map((hex) => {
    const bytes = Buffer.from(hex, "hex");
    bytes[31] = (bytes[31] as number) & 0x7f;
    return bytes.toString("hex");
  }))].sort();
  expect(signBitMasked).toEqual([...LIBSODIUM_SMALL_ORDER_BLACKLIST_HEX].sort());
});

test("isValidEd25519PublicKey is false for the identity and all-zeros encodings", async () => {
  expect(IDENTITY_PUBLIC_KEY_B64).toBe("AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  expect(await isValidEd25519PublicKey(IDENTITY_PUBLIC_KEY_B64)).toBe(false);
  expect(await isValidEd25519PublicKey(ALL_ZEROS_PUBLIC_KEY_B64)).toBe(false);
});

test("isValidEd25519PublicKey rejects all 14 low-order encodings", async () => {
  expect(LOW_ORDER_ED25519_PUBLIC_KEYS_B64).toHaveLength(14);
  for (const publicKeyB64 of LOW_ORDER_ED25519_PUBLIC_KEYS_B64) {
    expect(await isValidEd25519PublicKey(publicKeyB64)).toBe(false);
  }
  // Same table, same answer, from the predicate the production scan reuses.
  for (const hex of LOW_ORDER_ED25519_PUBLIC_KEYS_HEX) {
    expect(isLowOrderEd25519PublicKey(Uint8Array.from(Buffer.from(hex, "hex")))).toBe(true);
  }
});

test("the forgery constant fails on every signature entry point, over two different messages", async () => {
  const messageA = sub;
  const messageB = { ...sub, body: "an entirely different body", stance: "bearish", confidence: 0.05 };
  expect(canonicalizeSubmission(messageA)).not.toBe(canonicalizeSubmission(messageB));

  const applicationA = { name: "Forger", contact: "forger@example.test", publicKey: IDENTITY_PUBLIC_KEY_B64 };
  const applicationB = { name: "Forger Two", contact: "forger2@example.test", publicKey: IDENTITY_PUBLIC_KEY_B64 };
  const challengeA = { memberId: "m1", challenge: "challenge-a", expiresAt: "2026-07-21T18:30:00.000Z" };
  const challengeB = { memberId: "m1", challenge: "challenge-b", expiresAt: "2026-07-22T18:30:00.000Z" };

  let assertions = 0;
  for (const publicKeyB64 of LOW_ORDER_ED25519_PUBLIC_KEYS_B64) {
    for (const [a, b] of [[messageA, messageB]] as const) {
      expect(await verifySubmissionSignature(a, FORGED_SIGNATURE_B64, publicKeyB64)).toBe(false);
      expect(await verifySubmissionSignature(b, FORGED_SIGNATURE_B64, publicKeyB64)).toBe(false);
      expect(await verifyStoredSubmissionSignature({
        submission: a, signatureB64: FORGED_SIGNATURE_B64, publicKeyB64,
      })).toBe(false);
      expect(await verifyStoredSubmissionSignature({
        submission: b, signatureB64: FORGED_SIGNATURE_B64, publicKeyB64,
      })).toBe(false);
      assertions += 4;
    }
    expect(await verifyApplicationSignature(applicationA, FORGED_SIGNATURE_B64, publicKeyB64)).toBe(false);
    expect(await verifyApplicationSignature(applicationB, FORGED_SIGNATURE_B64, publicKeyB64)).toBe(false);
    expect(await verifyClaimChallengeSignature(challengeA, FORGED_SIGNATURE_B64, publicKeyB64)).toBe(false);
    expect(await verifyClaimChallengeSignature(challengeB, FORGED_SIGNATURE_B64, publicKeyB64)).toBe(false);
    // A low-order key gets no fingerprint either: the admin surface must not
    // present one as an ordinary registered identity.
    expect(await fingerprintPublicKey(publicKeyB64)).toBeNull();
    assertions += 5;
  }
  expect(assertions).toBe(14 * 9);
});

test("honest keys and honest signatures still verify — the fix does not over-reject", async () => {
  const lowOrder = new Set(LOW_ORDER_ED25519_PUBLIC_KEYS_B64);
  let verified = 0;
  for (let i = 0; i < 16; i++) {
    const honest = await generateKeyPair();
    // No honestly generated key can land in the reject list.
    expect(lowOrder.has(honest.publicKeyB64)).toBe(false);
    expect(await isValidEd25519PublicKey(honest.publicKeyB64)).toBe(true);
    expect(await fingerprintPublicKey(honest.publicKeyB64)).toMatch(/^sha256:[0-9a-f]{64}$/);

    const signature = await signMessage(canonicalizeSubmission(sub), honest.privateKey);
    expect(await verifySubmissionSignature(sub, signature, honest.publicKeyB64)).toBe(true);
    expect(await verifyStoredSubmissionSignature({
      submission: sub, signatureB64: signature, publicKeyB64: honest.publicKeyB64,
    })).toBe(true);

    const application = { name: "Honest", contact: "honest@example.test", publicKey: honest.publicKeyB64 };
    const applicationSig = await signMessage(canonicalizeApplication(application), honest.privateKey);
    expect(await verifyApplicationSignature(application, applicationSig, honest.publicKeyB64)).toBe(true);

    const challenge = { memberId: "m1", challenge: "c1", expiresAt: "2026-07-21T18:30:00.000Z" };
    const challengeSig = await signMessage(canonicalizeClaimChallenge(challenge), honest.privateKey);
    expect(await verifyClaimChallengeSignature(challenge, challengeSig, honest.publicKeyB64)).toBe(true);
    verified++;
  }
  expect(verified).toBe(16);
  // The pre-recorded legacy pair — an honest key registered before this fix —
  // must still verify: the rejection may not invalidate real history.
  expect(await isValidEd25519PublicKey(legacyPublicKeyB64)).toBe(true);
  expect(await verifySubmissionSignature(legacySubmission, legacySignatureB64, legacyPublicKeyB64)).toBe(true);
});
