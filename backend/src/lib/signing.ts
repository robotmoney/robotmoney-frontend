// Ed25519 authorship verification for committee submissions. Members sign the
// canonical payload (from @robotmoney/contract) in their own environment; the
// server only ever verifies — it never holds a private key. Web Crypto Ed25519
// (supported by Bun). Keys/signatures are exchanged as base64 of raw bytes.
import { canonicalizeSubmission } from "@robotmoney/contract";

const ALG = { name: "Ed25519" } as const;

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(b64, "base64"));
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
    const pub = await crypto.subtle.importKey("raw", b64ToBytes(publicKeyB64), ALG, false, ["verify"]);
    const msg = new TextEncoder().encode(canonicalizeSubmission(submission));
    return await crypto.subtle.verify(ALG, pub, b64ToBytes(signatureB64), msg);
  } catch {
    return false;
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
