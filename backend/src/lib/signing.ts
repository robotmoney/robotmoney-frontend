// Ed25519 authorship verification for swarm submissions. Members sign the
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

/**
 * SECURITY (issue #789) — the small-order (torsion) subgroup of Ed25519.
 *
 * Ed25519's group has order 8L: alongside the prime-order subgroup there are
 * eight points of order 1, 2, 4 or 8. If a public key A is one of them then the
 * verification equation [s]B = R + [h]A collapses — with A and R both the
 * neutral element, the single 64-byte constant `0x01 || 0x00*63` satisfies it
 * for EVERY message. That constant is public, so a member registered with such
 * a key can be "signed for" by anyone, with nothing secret. Confirmed against
 * this repo's own code before the fix: all 14 encodings imported, and the
 * constant verified as a submission signature over two different payloads.
 *
 * Those eight points have eight canonical encodings, and six further
 * non-canonical ones are accepted by decoders that do not range-check y:
 * the sign bit is free on the two points with x = 0, and y = p and y = p+1
 * re-encode 0 and 1 above the field modulus. Fourteen byte strings in total.
 *
 * The seven entries below are those fourteen with byte 31's sign bit masked
 * off, which is exactly how libsodium's ge25519_has_small_order() blacklist is
 * written (crypto_core/ed25519/ref10/ed25519_ref10.c). They are not copied on
 * trust: they were re-derived here by taking a curve point P, forming [L]P to
 * land in the torsion subgroup, enumerating its eight multiples, encoding each,
 * and adding the six non-canonical forms — the derivation reproduces this exact
 * set and agrees with libsodium byte for byte.
 *
 *   00...00                     y = 0            order 4
 *   01 00...00                  y = 1            order 1 (the neutral element)
 *   26e8...fc05                                  order 8
 *   c717...037a                                  order 8
 *   ecff...ff7f                 y = p-1          order 2
 *   edff...ff7f                 y = p   (≡ 0)    order 4, non-canonical
 *   eeff...ff7f                 y = p+1 (≡ 1)    order 1, non-canonical
 *
 * No honestly generated key can collide with this list: a keypair's public half
 * is [k]B in the prime-order subgroup, so reaching one of these would mean
 * hitting a set of 8 points out of ~2^252. The honest-key tests assert it.
 */
const LOW_ORDER_ED25519_POINTS: readonly string[] = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map((hex) => hex.toLowerCase());

/**
 * True when `bytes` is one of the 14 low-order Ed25519 point encodings.
 * Byte 31's high bit is the x-sign, and both settings of it decode to a
 * low-order point for every entry above, so it is masked before comparing.
 * Exported so the swarm_member_keys scan (scripts/scan-low-order-keys.ts)
 * screens stored rows against the same table this rejects new keys with.
 */
export function isLowOrderEd25519PublicKey(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const masked = Uint8Array.from(bytes);
  masked[31] = (masked[31] as number) & 0x7f;
  const hex = Buffer.from(masked).toString("hex");
  return LOW_ORDER_ED25519_POINTS.includes(hex);
}

/**
 * THE one decode gate for a swarm public key. Every path that turns a stored or
 * submitted base64 string into an Ed25519 public key goes through here, so the
 * low-order rejection is applied once at decode time rather than re-argued at
 * each call site — which matters because rejecting only at verification would
 * still let such a key be REGISTERED and sit in swarm_member_keys looking real.
 */
function canonicalPublicKeyBytes(publicKeyB64: string): Uint8Array<ArrayBuffer> {
  const bytes = canonicalBase64ToBytes(publicKeyB64, 32);
  if (isLowOrderEd25519PublicKey(bytes)) {
    throw new Error("low-order Ed25519 public key");
  }
  return bytes;
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
 * Import the exact public-key representation accepted by swarm signature
 * verification: canonical base64 containing one 32-byte raw Ed25519 key that is
 * NOT one of the 14 low-order point encodings (issue #789 — see
 * LOW_ORDER_ED25519_POINTS; WebCrypto imports all 14 happily, and for any of
 * them one public constant verifies as a signature over any message).
 * Apply-time validation and every verification path share this function so a
 * key cannot be accepted during onboarding and rejected later at duty time.
 */
export async function importEd25519PublicKey(publicKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    canonicalPublicKeyBytes(publicKeyB64),
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
 * canonical swarm-application payload (@robotmoney/contract) against the
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
 * frontend/public/views/docs/investment-swarm/api-reference.html.
 */
export async function verifyStoredSubmissionSignature(stored: StoredSubmissionSignature): Promise<boolean> {
  return verifySubmissionSignature(stored.submission, stored.signatureB64, stored.publicKeyB64);
}

/** Public, non-reversible identifier for a registered Ed25519 key. */
export async function fingerprintPublicKey(publicKeyB64: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", canonicalPublicKeyBytes(publicKeyB64));
    return `sha256:${Buffer.from(digest).toString("hex")}`;
  } catch {
    return null;
  }
}

// Helpers for seeding/tests/agents (key generation + signing). In production a
// member generates and holds their own private key; these exist so the smoke
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
