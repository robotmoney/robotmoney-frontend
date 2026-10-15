// Referral codes carried in deposit calldata as an ERC-8021 suffix (Linear RM-174).
//
// WHY THIS EXISTS. A depositor can name the swarm member who referred them. The
// code rides at the end of the deposit call's data, after the ABI arguments, so
// the depositor signs only the deposit and the code is on chain from that block
// on. The vaults and the router ignore bytes after their arguments (no
// ERC-2771, no msg.data reads, no proxies; checked against Deploy 2), so no
// contract changes.
//
// THE FORMAT. ERC-8021 (draft, https://github.com/ethereum/ERCs/pull/1209)
// reads a suffix backwards from a 16-byte marker: marker, then a 1-byte schema
// id, then the schema's data. We WRITE schema 2 only: a CBOR map
// `{"m": {"rm": "<code>"}}`, its 2-byte big-endian length, then 0x02. Schema 0
// and 1 codes are meant to live in an on-chain code registry (Base's, for schema
// 0), which does not know our codes; schema 2's `m` key is the one place the
// draft lets a consumer put its own data. We READ schema 0, 1 and 2, so a code
// someone wrote as an `rm_`-prefixed schema 0 or 1 code still counts.
//
// WHERE THE SUFFIX SITS. Only on a plain wallet's deposit is it the end of the
// transaction input. From a Safe, an ERC-4337 bundle or an EIP-7702 batch, it
// ends the INNER call's data, somewhere in the middle of the input. The suffix
// delimits itself backwards from its marker, so the parser looks for every
// marker in the input instead of decoding each wallet's wrapper. Wallets may add
// their own ERC-8021 codes next to ours; we match our code by its key, never by
// exact bytes.
//
// Pure functions, no dependencies, no network: the endpoint, the report script
// and the tests share this module.

export const ERC8021_MARKER_HEX = "80218021802180218021802180218021";
const MARKER = hexToBytes(ERC8021_MARKER_HEX);
const SCHEMA_CODES = 0;
const SCHEMA_CODES_WITH_REGISTRY = 1;
const SCHEMA_CBOR = 2;

/** The CBOR key under `m` that carries a Robot Money referral code. */
export const REFERRAL_METADATA_KEY = "rm";

/** Every referral code starts with this, which is how we pick ours out of schema 0 and 1 code lists. */
export const REFERRAL_CODE_PREFIX = "rm_";

/** Codes are `rm_` plus a handle-shaped slug, 32 characters at most. */
export const REFERRAL_CODE_MAX_LENGTH = 32;
const REFERRAL_CODE_RE = /^rm_[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when `code` is a well-formed referral code. Case-sensitive: normalize first. */
export function isReferralCodeFormat(code: string): boolean {
  return code.length <= REFERRAL_CODE_MAX_LENGTH && REFERRAL_CODE_RE.test(code);
}

/** Codes compare in lowercase, with surrounding whitespace dropped. */
export function normalizeReferralCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * The ERC-8021 schema 2 suffix for one referral code, as 0x-prefixed hex, ready
 * to append to a deposit call's data. Throws on a malformed code, so a typo never
 * reaches a transaction.
 */
export function encodeReferralSuffix(code: string): string {
  const normalized = normalizeReferralCode(code);
  if (!isReferralCodeFormat(normalized)) {
    throw new Error(`not a referral code: ${JSON.stringify(code)}`);
  }
  const cbor = concatBytes(
    Uint8Array.of(0xa1), // map(1)
    cborText("m"),
    Uint8Array.of(0xa1), // map(1)
    cborText(REFERRAL_METADATA_KEY),
    cborText(normalized),
  );
  const length = Uint8Array.of(cbor.length >> 8, cbor.length & 0xff);
  return "0x" + bytesToHex(concatBytes(cbor, length, Uint8Array.of(SCHEMA_CBOR), MARKER));
}

/** One ERC-8021 suffix found in a transaction input. */
export type Erc8021Suffix =
  | { schemaId: 0; markerOffset: number; codes: string[] }
  | {
      schemaId: 1;
      markerOffset: number;
      codes: string[];
      registryChainId: string;
      registryAddress: string;
    }
  | { schemaId: 2; markerOffset: number; data: Map<CborValue, CborValue> };

/**
 * Every well-formed ERC-8021 suffix in `input`, in the order its marker appears.
 * A marker whose preceding bytes do not parse (an unknown schema id, a length
 * that runs past the start of the input, CBOR that does not decode) is skipped:
 * the draft says parsing stops at an unknown schema, and a byte run that merely
 * looks like a marker is not a suffix.
 */
export function parseErc8021Suffixes(input: string | Uint8Array): Erc8021Suffix[] {
  const bytes = typeof input === "string" ? hexToBytes(input) : input;
  const found: Erc8021Suffix[] = [];
  for (const offset of markerOffsets(bytes)) {
    const suffix = parseSuffixAt(bytes, offset);
    if (suffix) found.push(suffix);
  }
  return found;
}

/**
 * The distinct referral codes in `input`, normalized, in the order they appear.
 * A schema 2 suffix contributes `m.rm` when it is a string; a schema 0 or 1
 * suffix contributes every code that starts with `rm_`. Format is NOT checked
 * here: a malformed candidate is returned as written, so the credit rules can
 * report it as an unknown code instead of dropping it in silence.
 */
export function findReferralCodes(input: string | Uint8Array): string[] {
  const codes: string[] = [];
  const add = (candidate: string) => {
    const normalized = normalizeReferralCode(candidate);
    if (normalized && !codes.includes(normalized)) codes.push(normalized);
  };
  for (const suffix of parseErc8021Suffixes(input)) {
    if (suffix.schemaId === SCHEMA_CBOR) {
      const metadata = mapGet(suffix.data, "m");
      const code = metadata === undefined ? undefined : mapGet(metadata, REFERRAL_METADATA_KEY);
      if (typeof code === "string") add(code);
    } else {
      for (const code of suffix.codes) {
        if (normalizeReferralCode(code).startsWith(REFERRAL_CODE_PREFIX)) add(code);
      }
    }
  }
  return codes;
}

// --- Suffix parsing ----------------------------------------------------------

function markerOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  outer: for (let i = 0; i + MARKER.length <= bytes.length; i++) {
    for (let j = 0; j < MARKER.length; j++) {
      if (bytes[i + j] !== MARKER[j]) continue outer;
    }
    offsets.push(i);
  }
  return offsets;
}

function parseSuffixAt(bytes: Uint8Array, markerOffset: number): Erc8021Suffix | null {
  let end = markerOffset; // exclusive end of the bytes still to read, walking backwards
  const takeByte = (): number | null => (end >= 1 ? bytes[--end]! : null);
  const take = (n: number): Uint8Array | null => {
    if (n < 0 || end - n < 0) return null;
    end -= n;
    return bytes.subarray(end, end + n);
  };

  const schemaId = takeByte();
  if (schemaId === SCHEMA_CODES || schemaId === SCHEMA_CODES_WITH_REGISTRY) {
    const codesLength = takeByte();
    const codes = codesLength === null ? null : take(codesLength);
    if (!codes) return null;
    const list = splitCodes(codes);
    if (list === null) return null;
    if (schemaId === SCHEMA_CODES) return { schemaId: 0, markerOffset, codes: list };
    const chainIdLength = takeByte();
    const chainId = chainIdLength === null ? null : take(chainIdLength);
    const registry = take(20);
    if (!chainId || !registry) return null;
    return {
      schemaId: 1,
      markerOffset,
      codes: list,
      registryChainId: "0x" + bytesToHex(chainId),
      registryAddress: "0x" + bytesToHex(registry),
    };
  }
  if (schemaId === SCHEMA_CBOR) {
    const lengthBytes = take(2);
    if (!lengthBytes) return null;
    const cbor = take((lengthBytes[0]! << 8) | lengthBytes[1]!);
    if (!cbor) return null;
    const data = decodeCbor(cbor);
    if (data === undefined || !(data instanceof Map)) return null;
    return { schemaId: 2, markerOffset, data };
  }
  return null; // unknown schema id: the draft says stop
}

function splitCodes(bytes: Uint8Array): string[] | null {
  let text = "";
  for (const b of bytes) {
    if (b > 0x7f) return null; // codes are 7-bit ASCII
    text += String.fromCharCode(b);
  }
  return text === "" ? [] : text.split(",");
}

// --- A minimal CBOR reader ---------------------------------------------------
// Definite-length unsigned and negative integers, byte and text strings, arrays,
// maps, and the simple values false, true and null. That covers every ERC-8021
// schema 2 shape. Anything else (indefinite lengths, tags, floats, 8-byte
// lengths) makes the whole map undecodable, which skips that suffix.

export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | Map<CborValue, CborValue>;

function decodeCbor(bytes: Uint8Array): CborValue | undefined {
  try {
    const [value, next] = readCbor(bytes, 0);
    return next === bytes.length ? value : undefined;
  } catch {
    return undefined;
  }
}

function readCbor(bytes: Uint8Array, offset: number): [CborValue, number] {
  const initial = bytes[offset];
  if (initial === undefined) throw new Error("cbor: truncated");
  const major = initial >> 5;
  const info = initial & 0x1f;
  let at = offset + 1;
  if (major === 7) {
    if (info === 20) return [false, at];
    if (info === 21) return [true, at];
    if (info === 22) return [null, at];
    throw new Error("cbor: unsupported simple value");
  }
  let argument: number;
  if (info < 24) argument = info;
  else if (info === 24 || info === 25 || info === 26) {
    const width = 1 << (info - 24);
    if (at + width > bytes.length) throw new Error("cbor: truncated");
    argument = 0;
    for (let k = 0; k < width; k++) argument = argument * 256 + bytes[at + k]!;
    at += width;
  } else throw new Error("cbor: unsupported length");

  switch (major) {
    case 0:
      return [argument, at];
    case 1:
      return [-1 - argument, at];
    case 2:
    case 3: {
      if (at + argument > bytes.length) throw new Error("cbor: truncated");
      const raw = bytes.subarray(at, at + argument);
      return [major === 2 ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw), at + argument];
    }
    case 4: {
      const items: CborValue[] = [];
      for (let k = 0; k < argument; k++) {
        const [item, next] = readCbor(bytes, at);
        items.push(item);
        at = next;
      }
      return [items, at];
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      for (let k = 0; k < argument; k++) {
        const [key, afterKey] = readCbor(bytes, at);
        const [value, afterValue] = readCbor(bytes, afterKey);
        map.set(key, value);
        at = afterValue;
      }
      return [map, at];
    }
    default:
      throw new Error("cbor: unsupported major type");
  }
}

function mapGet(value: CborValue, key: string): CborValue | undefined {
  return value instanceof Map ? value.get(key) : undefined;
}

function cborText(text: string): Uint8Array {
  const utf8 = new TextEncoder().encode(text);
  // Codes are at most 32 bytes, so a 1-byte length always suffices.
  const head = utf8.length < 24 ? Uint8Array.of(0x60 + utf8.length) : Uint8Array.of(0x78, utf8.length);
  return concatBytes(head, utf8);
}

// --- Hex and byte helpers -----------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("not a hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
