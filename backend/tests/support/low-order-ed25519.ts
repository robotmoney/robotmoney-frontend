// The 14 low-order Ed25519 public-key encodings, and the forgery constant that
// verifies against any of them over any message (issue #789).
//
// This file is the ATTACK side of the fix: it is written independently of
// src/lib/signing.ts — the encodings are DERIVED here from the curve, not
// imported from the table signing.ts rejects with — so a test that passes is
// evidence about the curve, not a tautology over one shared constant. The
// derivation is a transcription of RFC 8032 §5.1 arithmetic:
//
//   1. take a point P on Ed25519,
//   2. form [L]P, which lands in the order-8 torsion subgroup,
//   3. enumerate that subgroup's 8 multiples and encode each,
//   4. add the 6 non-canonical encodings — the free sign bit on the two points
//      with x = 0, and y = p / y = p+1 re-encoding 0 and 1 above the modulus.
//
// The result is asserted to be exactly 14 values, and to equal libsodium's
// ge25519_has_small_order() blacklist (crypto_core/ed25519/ref10/ed25519_ref10.c)
// once byte 31's sign bit is masked off.

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

const mod = (a: bigint): bigint => ((a % P) + P) % P;
function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}
const inv = (a: bigint): bigint => modPow(a, P - 2n);
const D = mod(-121665n * inv(121666n));

interface Point { x: bigint; y: bigint }
const NEUTRAL: Point = { x: 0n, y: 1n };

function add(a: Point, b: Point): Point {
  const t = mod(D * a.x * b.x * a.y * b.y);
  return {
    x: mod(mod(a.x * b.y + b.x * a.y) * inv(1n + t)),
    y: mod(mod(a.y * b.y + a.x * b.x) * inv(1n - t)),
  };
}
function scalarMul(p: Point, n: bigint): Point {
  let acc = NEUTRAL;
  let addend = p;
  let k = n;
  while (k > 0n) {
    if (k & 1n) acc = add(acc, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return acc;
}
const isNeutral = (p: Point): boolean => p.x === 0n && p.y === 1n;

/** Recover x for a given y, or null when y is not on the curve. */
function xForY(y: bigint): bigint | null {
  const y2 = mod(y * y);
  const target = mod(mod(y2 - 1n) * inv(mod(D * y2 + 1n)));
  let x = modPow(target, (P + 3n) / 8n);
  if (mod(x * x) !== target) x = mod(x * modPow(2n, (P - 1n) / 4n));
  return mod(x * x) === target ? x : null;
}

function encode(y: bigint, signBit: 0 | 1, rawY: bigint = y): string {
  const bytes = new Uint8Array(32);
  let t = rawY;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  bytes[31] = (bytes[31] as number) | (signBit << 7);
  return Buffer.from(bytes).toString("hex");
}

function deriveLowOrderEncodings(): string[] {
  // An order-8 point: [L]P for some P whose [L]P is not itself order-dividing-4.
  let generator: Point | null = null;
  for (let candidateY = 2n; candidateY < 500n && generator === null; candidateY++) {
    const x = xForY(candidateY);
    if (x === null) continue;
    const torsionPart = scalarMul({ x, y: candidateY }, L);
    if (isNeutral(torsionPart)) continue;
    if (isNeutral(scalarMul(torsionPart, 4n))) continue; // order divides 4, want 8
    generator = torsionPart;
  }
  if (generator === null) throw new Error("no order-8 Ed25519 point found");

  const encodings = new Set<string>();
  for (let k = 0n; k < 8n; k++) {
    const point = scalarMul(generator, k);
    encodings.add(encode(point.y, Number(point.x & 1n) as 0 | 1));
    // x = 0 leaves the sign bit free: both settings decode to the same point.
    if (point.x === 0n) encodings.add(encode(point.y, 1));
  }
  // y = p and y = p+1 are non-canonical re-encodings of 0 and 1.
  for (const rawY of [P, P + 1n]) {
    const reduced = mod(rawY);
    if (xForY(reduced) === null) continue;
    encodings.add(encode(reduced, 0, rawY));
    encodings.add(encode(reduced, 1, rawY));
  }
  return [...encodings].sort();
}

/** All 14 encodings, lowercase hex, sorted. Derived, not transcribed. */
export const LOW_ORDER_ED25519_PUBLIC_KEYS_HEX: readonly string[] = deriveLowOrderEncodings();

/** The same 14, as the canonical base64 the API and swarm_member_keys use. */
export const LOW_ORDER_ED25519_PUBLIC_KEYS_B64: readonly string[] =
  LOW_ORDER_ED25519_PUBLIC_KEYS_HEX.map((hex) => Buffer.from(hex, "hex").toString("base64"));

/**
 * libsodium's published blacklist — the same 14 with the sign bit masked off.
 * Kept verbatim so the derivation above is checked against an outside source.
 */
export const LIBSODIUM_SMALL_ORDER_BLACKLIST_HEX: readonly string[] = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

/** The neutral-element encoding: 0x01 followed by 31 zero bytes. */
export const IDENTITY_PUBLIC_KEY_B64 = Buffer.concat([
  Buffer.from([0x01]),
  Buffer.alloc(31),
]).toString("base64");

/** The all-zeros 32-byte encoding — the order-4 point y = 0. */
export const ALL_ZEROS_PUBLIC_KEY_B64 = Buffer.alloc(32).toString("base64");

/**
 * The forgery: R = the neutral element, s = 0. With a low-order A the
 * verification equation [s]B = R + [h]A holds for EVERY message, so this one
 * public 64-byte constant is a "valid signature" for anything.
 */
export const FORGED_SIGNATURE_B64 = Buffer.concat([
  Buffer.from([0x01]),
  Buffer.alloc(63),
]).toString("base64");
