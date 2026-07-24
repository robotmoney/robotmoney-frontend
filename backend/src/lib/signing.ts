// Ed25519 authorship verification for committee submissions. Members sign the
// canonical payload (from @robotmoney/contract) in their own environment; the
// server only ever verifies — it never holds a private key. Web Crypto Ed25519
// (supported by Bun). Keys/signatures are exchanged as base64 of raw bytes.
import { canonicalizeApplication, canonicalizeClaimChallenge, canonicalizeSubmission } from "@robotmoney/contract";

const ALG = { name: "Ed25519" } as const;

function canonicalBase64ToBytes(b64: string, expectedBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof b64 !== "string" || b64.length === 0 || b64 !== b64.trim() || b64.length % 4 !== 0) {
    throw new Error("invalid base64");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
    throw new Error("invalid base64");
  }
  const decoded = Buffer.from(b64, "base64");
  if (decoded.length !== expectedBytes || decoded.toString("base64") !== b64) {
    throw new Error("invalid encoded length");
  }
  return Uint8Array.from(decoded);
}
function bytesToB64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
}

export async function verifySubmissionSignature(
  submission: Parameters<typeof canonicalizeSubmission>[0],
  signatureB64: string,
  publicKeyB64: string,
): Promise<boolean> {
  try {
    const pub = await importEd25519PublicKey(publicKeyB64);
    const msg = new TextEncoder().encode(canonicalizeSubmission(submission));
    return await crypto.subtle.verify(ALG, pub, canonicalBase64ToBytes(signatureB64, 64), msg);
  } catch {
    return false;
  }
}

/**
 * Import the exact public-key representation accepted by committee signature
 * verification: canonical base64 containing one 32-byte raw Ed25519 key.
 * Apply-time validation and every verification path share this function so a
 * key cannot be accepted during onboarding and rejected later at duty time.
 */
export async function importEd25519PublicKey(publicKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    canonicalBase64ToBytes(publicKeyB64, 32),
    ALG,
    false,
    ["verify"],
  );
}

export async function isValidEd25519PublicKey(publicKeyB64: string): Promise<boolean> {
  try {
    await importEd25519PublicKey(publicKeyB64);
    return true;
  } catch {
    return false;
  }
}

/**
 * §11 R6 — setup-gated apply. Verifies the applicant's rmpc signature over the
 * canonical committee-application payload (@robotmoney/contract) against the
 * submitted key BEFORE the server records anything. Same idiom as
 * verifySubmissionSignature/verifyClaimChallengeSignature: import the exact
 * key encoding accepted everywhere else, canonicalize, verify — no bespoke
 * crypto here.
 */
export async function verifyApplicationSignature(
  application: Parameters<typeof canonicalizeApplication>[0],
  signatureB64: string,
  publicKeyB64: string,
): Promise<boolean> {
  try {
    const pub = await importEd25519PublicKey(publicKeyB64);
    const msg = new TextEncoder().encode(canonicalizeApplication(application));
    return await crypto.subtle.verify(ALG, pub, canonicalBase64ToBytes(signatureB64, 64), msg);
  } catch {
    return false;
  }
}

export interface ClaimChallenge {
  memberId: string;
  challenge: string;
  expiresAt: string;
}

export async function verifyClaimChallengeSignature(
  challenge: ClaimChallenge,
  signatureB64: string,
  publicKeyB64: string,
): Promise<boolean> {
  try {
    const pub = await importEd25519PublicKey(publicKeyB64);
    const msg = new TextEncoder().encode(canonicalizeClaimChallenge(challenge));
    return await crypto.subtle.verify(ALG, pub, canonicalBase64ToBytes(signatureB64, 64), msg);
  } catch {
    return false;
  }
}

export interface StoredSubmissionSignature {
  submission: Parameters<typeof canonicalizeSubmission>[0];
  signatureB64: string;
  publicKeyB64: string;
}

/**
 * Read-time verification seam for public receipts (issue #207).
 * Callers must build `submission` from the persisted payload and must not trust
 * the stored `verified` flag. The public receipt contract is documented in
 * frontend/public/views/docs/investment-committee/api-reference.html.
 */
export async function verifyStoredSubmissionSignature(stored: StoredSubmissionSignature): Promise<boolean> {
  return verifySubmissionSignature(stored.submission, stored.signatureB64, stored.publicKeyB64);
}

/** Public, non-reversible identifier for a registered Ed25519 key. */
export async function fingerprintPublicKey(publicKeyB64: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", canonicalBase64ToBytes(publicKeyB64, 32));
    return `sha256:${Buffer.from(digest).toString("hex")}`;
  } catch {
    return null;
  }
}

// Helpers for seeding/tests/agents (key generation + signing). In production a
// member generates and holds their own private key; these exist so the demo
// harness and member agents can create identities.
export async function generateKeyPair(): Promise<{ publicKeyB64: string; privateKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { publicKeyB64: bytesToB64(raw), privateKey: kp.privateKey };
}

export async function signMessage(message: string, privateKey: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign(ALG, privateKey, new TextEncoder().encode(message));
  return bytesToB64(sig);
}

export { canonicalizeSubmission };
