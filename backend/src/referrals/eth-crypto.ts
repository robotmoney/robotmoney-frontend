// Keccak-256 and secp256k1 public-key recovery, in plain TypeScript (issue 1371,
// docs/technical/referrals-spec.md §4).
//
// WHY THIS FILE EXISTS. A verified referral correction is a wallet's EIP-191
// signature over a payload naming the code and the deposit. Checking it needs
// keccak-256 (the message hash and the address derivation) and secp256k1 key
// recovery. The backend has neither: every selector in chain/base-rpc-client.ts
// is a precomputed constant, and the repository adds no chain SDK (spec §8:
// "No second RPC client or external chain SDK implied"). These are the two
// textbook algorithms, small enough to review, held to published vectors by
// backend/tests/referrals-eth-crypto.test.ts.
//
// NOT A SIGNER. Nothing here produces a signature; the only private-key code is
// the test helper that makes fixtures. Verification never needs constant time.

// ── Keccak-256 (the original Keccak padding, as Ethereum uses; not SHA3-256) ──

const MASK64 = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets, indexed x + 5y.
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

function rotl(v: bigint, n: number): bigint {
  if (n === 0) return v;
  const b = BigInt(n);
  return ((v << b) | (v >> (64n - b))) & MASK64;
}

function keccakF(a: bigint[]): void {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) a[x + y] = a[x + y]! ^ d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y]!, ROTATIONS[x + 5 * y]!);
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        a[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & MASK64 & b[((x + 2) % 5) + y]!);
      }
    }
    a[0] = a[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

/** Keccak-256 of `input` (a UTF-8 string or bytes). */
export function keccak256(input: string | Uint8Array): Uint8Array {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const rate = 136;
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate);
  padded.set(data);
  padded[data.length] = padded[data.length]! ^ 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! ^ 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]!);
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bytes of a 0x-prefixed, even-length hex string; throws on anything else. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error(`not 0x-prefixed even-length hex: ${hex.slice(0, 20)}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function keccak256Hex(input: string | Uint8Array): string {
  return bytesToHex(keccak256(input));
}

/** The 32-byte event topic for a canonical event signature such as `Transfer(address,address,uint256)`. */
export function eventTopic(signature: string): string {
  return keccak256Hex(signature);
}

/** EIP-191 version 0x45 (`personal_sign`) hash of a UTF-8 message. */
export function personalMessageHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak256(all);
}

// ── secp256k1 ────────────────────────────────────────────────────────────────

export const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export type Point = { x: bigint; y: bigint } | null; // null is the point at infinity
export const SECP256K1_G: Point = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

export function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

export function invert(a: bigint, m: bigint): bigint {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("not invertible");
  return mod(oldS, m);
}

function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

export function pointAdd(a: Point, b: Point): Point {
  if (a === null) return b;
  if (b === null) return a;
  const P = SECP256K1_P;
  if (a.x === b.x) {
    if (mod(a.y + b.y, P) === 0n) return null;
    const l = mod(3n * a.x * a.x * invert(2n * a.y, P), P);
    const x = mod(l * l - 2n * a.x, P);
    return { x, y: mod(l * (a.x - x) - a.y, P) };
  }
  const l = mod((b.y - a.y) * invert(b.x - a.x, P), P);
  const x = mod(l * l - a.x - b.x, P);
  return { x, y: mod(l * (a.x - x) - a.y, P) };
}

export function pointMul(k: bigint, p: Point): Point {
  let result: Point = null;
  let addend = p;
  let e = mod(k, SECP256K1_N);
  while (e > 0n) {
    if (e & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    e >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function bigIntTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** The lowercase 0x address of an uncompressed public key point. */
export function addressOfPoint(p: Exclude<Point, null>): string {
  const pub = new Uint8Array(64);
  pub.set(bigIntTo32(p.x));
  pub.set(bigIntTo32(p.y), 32);
  return bytesToHex(keccak256(pub).slice(12));
}

/**
 * The signer address of a 65-byte `r || s || v` signature over a 32-byte
 * hash, or null when the signature is malformed or recovers no key. `v` is 27
 * or 28 (0 and 1 are accepted as the same recovery ids). A signature of the
 * wrong length, an r or s of 0 or not below the group order, or an r that is
 * not a curve x coordinate is null, never an exception.
 */
export function recoverAddress(hash: Uint8Array, signatureHex: string): string | null {
  let sig: Uint8Array;
  try {
    sig = hexToBytes(signatureHex);
  } catch {
    return null;
  }
  if (sig.length !== 65 || hash.length !== 32) return null;
  const r = bytesToBigInt(sig.slice(0, 32));
  const s = bytesToBigInt(sig.slice(32, 64));
  const vByte = sig[64]!;
  const recId = vByte >= 27 ? vByte - 27 : vByte;
  if (recId !== 0 && recId !== 1) return null;
  const N = SECP256K1_N;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;
  const P = SECP256K1_P;
  const ySquared = mod(r * r * r + 7n, P);
  let y = powMod(ySquared, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== ySquared) return null;
  if (Number(y & 1n) !== recId) y = P - y;
  const R: Point = { x: r, y };
  const z = bytesToBigInt(hash);
  const rInv = invert(r, N);
  const q = pointAdd(pointMul(mod(s * rInv, N), R), pointMul(mod(-z * rInv, N), SECP256K1_G));
  if (q === null) return null;
  return addressOfPoint(q);
}

/** ABI calldata for EIP-1271 `isValidSignature(bytes32 hash, bytes signature)`. */
export function encodeIsValidSignatureCall(hash: Uint8Array, signatureHex: string): string {
  const sig = hexToBytes(signatureHex);
  const hex = (b: Uint8Array) => bytesToHex(b).slice(2);
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  const padded = new Uint8Array(Math.ceil(sig.length / 32) * 32);
  padded.set(sig);
  return "0x1626ba7e" + hex(hash) + word(0x40n) + word(BigInt(sig.length)) + hex(padded);
}

/** EIP-1271's magic return value: the first four bytes of the selector, left-aligned in a word. */
export const EIP1271_MAGIC_WORD = "0x1626ba7e" + "0".repeat(56);
