// EVM address validation with the EIP-55 mixed-case checksum, for forms that
// take a wallet (the early-access page). No dependency is vendored for this, so
// the one hash it needs, Keccak-256, is here: BigInt lanes, written for reading
// rather than speed, since it hashes 40 characters once per submit.

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets, ROT[x][y].
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const rotl = (/** @type {bigint} */ v, /** @type {number} */ n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

/** Keccak-f[1600] over 25 lanes, indexed x + 5y. @param {bigint[]} s */
function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = /** @type {bigint[]} */ (new Array(25));
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
    }
    s[0] ^= RC[round];
  }
}

/** Keccak-256 (the Ethereum hash, not SHA3-256) of bytes, as lowercase hex. @param {Uint8Array} bytes */
export function keccak256Hex(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let out = "";
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 8; k++) out += Number((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
  }
  return out;
}

/** The EIP-55 checksummed spelling of a 0x-prefixed 40-hex-digit address. @param {string} address */
export function toChecksumAddress(address) {
  const hex = address.slice(2).toLowerCase();
  const hash = keccak256Hex(new TextEncoder().encode(hex));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  return out;
}

/**
 * The checksummed address when the input is a valid EVM address, else null.
 * All-lowercase and all-uppercase carry no checksum and are accepted (EIP-55);
 * a mixed-case address must match its checksum, so a mistyped character in a
 * copied address is caught.
 * @param {unknown} input
 * @returns {string | null}
 */
export function parseEvmAddress(input) {
  const s = String(input ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  const body = s.slice(2);
  const checksummed = toChecksumAddress(s);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return checksummed;
  return checksummed === s ? checksummed : null;
}
