// KECCAK-256 FOR TESTS ONLY — the one thing this repo could never assert.
//
// contract/src/__fixtures__/consensus-receipt.canonicalization.json#digest_note
// says it plainly: `digest_algorithm` is keccak256, Bun/Node ship SHA3-256
// (NIST padding 0x06, not Keccak's 0x01), and so "no test in this repo checks a
// keccak256 value" — the digest that `payloadDigest` anchors was a CONSUMER
// OBLIGATION parked on robotmoney-core. Decision D10 makes the frontend's
// public receipt route serve the exact keccak256 PREIMAGE, which means this
// repo now owns the claim "the bytes at payloadUri hash to payloadDigest" and
// has to be able to check it. Hence ~60 lines of Keccak-f[1600] here, in
// tests/support and nowhere near src/: it is a checking tool, not a runtime
// dependency, and adding a package to the backend's four production
// dependencies to hash a test fixture would be the worse trade.
//
// It is self-tested against the published vectors in
// consensus-receipt-bare-bytes.test.ts before it is used on anything, so a
// wrong implementation fails as a wrong implementation rather than as a wrong
// receipt (checklist C-21).

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT: number[] = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
// PI[i] is the lane index whose value moves to lane i in the rho/pi step.
const PI: number[] = [
  0, 6, 12, 18, 24, 3, 9, 10, 16, 22, 1, 7, 13, 19, 20, 4, 5, 11, 17, 23, 2, 8, 14, 15, 21,
];
const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, n: number): bigint =>
  n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;

function keccakF(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // theta
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) c[x] = a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) a[x + y] = a[x + y]! ^ d;
    }
    // rho + pi
    const b = new Array<bigint>(25);
    for (let i = 0; i < 25; i++) b[i] = rotl(a[PI[i]!]!, ROT[PI[i]!]!);
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) a[y + x] = b[y + x]! ^ (~b[y + ((x + 1) % 5)]! & M64 & b[y + ((x + 2) % 5)]!);
    }
    // iota
    a[0] = a[0]! ^ RC[round]!;
  }
}

/** keccak256 (Ethereum's, padding 0x01) over `data`, as a 0x-prefixed lowercase hex string. */
export function keccak256(data: Uint8Array): string {
  const RATE = 136; // 1088 bits
  const padded = new Uint8Array(Math.ceil((data.length + 1) / RATE) * RATE);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! ^ 0x80;

  const a = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]!);
      a[i] = a[i]! ^ lane;
    }
    keccakF(a);
  }

  let hex = "";
  for (let i = 0; i < 4; i++) {
    let lane = a[i]!;
    for (let b = 0; b < 8; b++) {
      hex += Number(lane & 0xffn).toString(16).padStart(2, "0");
      lane >>= 8n;
    }
  }
  return `0x${hex}`;
}
