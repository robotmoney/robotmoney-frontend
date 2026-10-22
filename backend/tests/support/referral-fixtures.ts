// OFFLINE FIXTURES for the referral tests (issue 1371, referrals-spec §9). Every
// fixture is a full JSON-RPC-shaped transaction, receipt and block header, built
// with the same ABI encoders the decoder reads (carrier.ts), plus a fake Base
// RPC endpoint that serves them through the real transport. These are synthetic
// fixtures: they prove the rules over well-formed evidence. They are NOT live
// evidence that robotmoney-core's contracts emit this carrier, and they are not
// a wallet execution (spec §10).
import { createHash } from "node:crypto";
import { encodeCarrierLog, encodeDepositLog, encodeTransferLog, type RawLog } from "../../src/referrals/carrier.ts";
import type { CorrectionEntry, CorrectionLog } from "../../src/referrals/corrections.ts";
import { correctionMessage } from "../../src/referrals/corrections.ts";
import { personalMessageHash, pointMul, SECP256K1_G, SECP256K1_N, invert, mod, addressOfPoint, bytesToHex } from "../../src/referrals/eth-crypto.ts";
import type { RawBlock, RawReceipt, RawTransaction, TransactionEvidence } from "../../src/referrals/evidence.ts";
import type { ReferralManifest } from "../../src/referrals/manifest.ts";
import type { ReferralCodeRecord, ReferralRegistry } from "../../src/referrals/registry.ts";

export const hex = (n: number | bigint) => "0x" + n.toString(16);
const h32 = (s: string) => "0x" + createHash("sha256").update(s).digest("hex");

export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const V0 = "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd";
export const ROUTER = "0xb3a8e66d9e2980b54ac0e70e0e236486d1dcb356";
export const RMUSDC = "0x28bf6e6edad526191e8652ee631b56ead4ce7435";
export const RMPROTO = "0x28c5ca4df0107679bfcc9b0ad4c2f3f209b8f797";
export const RMAGENT = "0x22bd48c56c34a2c1c1bac77bd7c4e636a6f10d57";
export const RMRWA = "0x37be372bd32f9e63a94c7db3ab415996658bcd50";
export const UNRELATED = "0x00000000000000000000000000000000000000aa";

/** Synthetic private keys; their addresses are the fixture wallets. */
export const KEYS = { alice: 0xa11ce1n, bob: 0xb0b2n, carol: 0xca401n, dave: 0xda7en };
export const addr = (k: bigint) => addressOfPoint(pointMul(k, SECP256K1_G)!);
export const ALICE = addr(KEYS.alice);
export const BOB = addr(KEYS.bob);
export const CAROL = addr(KEYS.carol);
export const DAVE = addr(KEYS.dave);
/** A contract wallet (Safe / 4337 / any EIP-1271 signer): no private key, signs through its contract. */
export const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe";

/** A complete-coverage test manifest: every entry confirmed, carrier confirmed. */
export function testManifest(): ReferralManifest {
  const e = (id: string, kind: "vault" | "router", address: string, start: number, end: number | null = null, successors: string[] | null = null) => ({
    id, kind, label: id, address, abi: kind === "router" ? "router-d2" : "erc4626", status: "confirmed" as const, deploymentBlock: start, startBlock: start, endBlock: end, legacy: successors ? { successors } : null,
  });
  return {
    schemaVersion: 1,
    chainId: 8453,
    asset: { symbol: "USDC", address: USDC, decimals: 6 },
    carrier: { status: "confirmed" },
    entries: [
      e("v0-rmusdc", "vault", V0, 100, 4999, ["d2-router", "d2-rmusdc", "d2-rmproto", "d2-rmagent", "d2-rmrwa"]),
      e("d2-router", "router", ROUTER, 5000),
      e("d2-rmusdc", "vault", RMUSDC, 5000),
      e("d2-rmproto", "vault", RMPROTO, 5000),
      e("d2-rmagent", "vault", RMAGENT, 5000),
      e("d2-rmrwa", "vault", RMRWA, 5000),
    ],
  };
}

export const T0 = 1_800_000_000; // 2027-01-15T08:00:00Z, block 0's time in the fixture chain
export const blockTime = (n: number) => T0 + n * 2;
export const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000Z", "Z");
export const blockHash = (n: number, fork = "") => h32(`block-${n}${fork}`);

export function memberCode(code: string, memberId: string, handle: string, opts: Partial<ReferralCodeRecord> = {}): ReferralCodeRecord {
  return { code, beneficiary: { kind: "member", memberId }, display: { handle, name: handle.toUpperCase() }, termsVersion: "2026-10", enabledAt: iso(T0), disabledAt: null, cancelledAt: null, ...opts };
}
export function channelCode(code: string, channel: string, opts: Partial<ReferralCodeRecord> = {}): ReferralCodeRecord {
  return { code, beneficiary: { kind: "channel", channel }, display: { channel }, termsVersion: null, enabledAt: iso(T0), disabledAt: null, cancelledAt: null, ...opts };
}
export function testRegistry(codes: ReferralCodeRecord[], launch: number | null = 5000): ReferralRegistry {
  return { schemaVersion: 1, chainId: 8453, launch: { blockNumber: launch }, codes };
}

export interface Leg {
  vault: string;
  assets: bigint;
}

/** One transaction under construction: logs are appended in order, log indices assigned at build. */
export class TxFixture {
  private logs: { address: string; topics: string[]; data: string }[] = [];
  constructor(
    readonly label: string,
    readonly block: number,
    readonly txIndex = 0,
    readonly from = ALICE,
    /** Block timestamp override (unix seconds); default blockTime(block). */
    readonly at: number | null = null,
  ) {}
  get hash(): string {
    return h32(`tx-${this.label}`);
  }
  raw(address: string, enc: { topics: string[]; data: string }): this {
    this.logs.push({ address, ...enc });
    return this;
  }
  /** ERC-4626 deposit(assets, receiver) called by `payer` on `vault`. */
  direct(payer: string, receiver: string, vault: string, assets: bigint): this {
    this.raw(USDC, encodeTransferLog(payer, vault, assets));
    this.raw(vault, encodeTransferLog("0x0000000000000000000000000000000000000000", receiver, assets)); // share mint (vault token)
    return this.raw(vault, encodeDepositLog(payer, receiver, assets, assets));
  }
  /** The placeholder carrier event, emitted by `emitter`. */
  carrier(emitter: string, payer: string, receiver: string, amount: bigint, code: string | Uint8Array): this {
    return this.raw(emitter, encodeCarrierLog(payer, receiver, amount, typeof code === "string" ? new TextEncoder().encode(code) : code));
  }
  /** A router deposit: payer funds the router, the router deposits each leg for receiver. */
  router(payer: string, receiver: string, legs: Leg[]): this {
    const total = legs.reduce((s, l) => s + l.assets, 0n);
    this.raw(USDC, encodeTransferLog(payer, ROUTER, total));
    for (const l of legs) this.direct(ROUTER, receiver, l.vault, l.assets);
    return this;
  }
  build(opts: { status?: "0x1" | "0x0"; fork?: string } = {}): TransactionEvidence {
    const bh = blockHash(this.block, opts.fork);
    const logs: RawLog[] = this.logs.map((l, i) => ({ ...l, logIndex: hex(i), blockNumber: hex(this.block), blockHash: bh, transactionHash: this.hash, transactionIndex: hex(this.txIndex), removed: false }));
    const receipt: RawReceipt = { transactionHash: this.hash, blockHash: bh, blockNumber: hex(this.block), transactionIndex: hex(this.txIndex), status: opts.status ?? "0x1", logs, from: this.from, to: ROUTER };
    const transaction: RawTransaction = { hash: this.hash, blockHash: bh, blockNumber: hex(this.block), transactionIndex: hex(this.txIndex), from: this.from, to: ROUTER, input: "0x" };
    const block: RawBlock = { number: hex(this.block), hash: bh, timestamp: hex(this.at ?? blockTime(this.block)), parentHash: blockHash(this.block - 1, opts.fork) };
    const manifestAddrs = new Set(testManifest().entries.map((e) => e.address));
    const scannedLogs = logs.filter((l) => manifestAddrs.has(l.address) && l.topics.length === 3 && !l.topics[0]!.startsWith("0xddf252ad"));
    return { transactionHash: this.hash, scannedLogs, receipt, transaction, block };
  }
}

/** A deterministic EIP-191 personal_sign signature by `key` (RFC 6979 is not needed for a fixture). */
export function signPersonal(message: string, key: bigint): string {
  const hash = personalMessageHash(message);
  const z = BigInt(bytesToHex(hash));
  const k = mod(BigInt(h32(`nonce-${key}-${message}`)), SECP256K1_N - 1n) + 1n;
  const R = pointMul(k, SECP256K1_G)!;
  const r = mod(R.x, SECP256K1_N);
  let s = mod(invert(k, SECP256K1_N) * (z + r * key), SECP256K1_N);
  let recId = Number(R.y & 1n);
  if (s > SECP256K1_N / 2n) {
    s = SECP256K1_N - s;
    recId ^= 1;
  }
  const w = (v: bigint) => v.toString(16).padStart(64, "0");
  return "0x" + w(r) + w(s) + (27 + recId).toString(16);
}

export function verifiedCorrection(id: string, wallet: string, key: bigint | null, code: string, tx: string, logIndex: number, recordedAt: string, opts: { nonce?: string; expiresAt?: string; signature?: string; scheme?: "eip191" | "eip1271" } = {}): CorrectionEntry {
  const base = { type: "correction" as const, id, kind: "verified" as const, chainId: 8453, wallet, code, deposit: { transactionHash: tx, logIndex }, recordedAt, recordedBy: "ops@robotmoney", reason: "lookup timed out at deposit; depositor signed" };
  const sigMeta = { scheme: opts.scheme ?? "eip191", expiresAt: opts.expiresAt ?? iso(blockTime(1_000_000)), nonce: opts.nonce ?? `n-${id}` } as const;
  const signature = opts.signature ?? (key === null ? "0x" + "11".repeat(65) : signPersonal(correctionMessage({ ...base, signature: sigMeta }), key));
  return { ...base, signature: { ...sigMeta, signature } };
}

export function overrideCorrection(id: string, wallet: string, code: string, tx: string, logIndex: number, recordedAt: string): CorrectionEntry {
  return { type: "correction", id, kind: "override", chainId: 8453, wallet, code, deposit: { transactionHash: tx, logIndex }, recordedAt, recordedBy: "ops@robotmoney", reason: "the depositor confirmed in our 1:1 channel", signature: null };
}

export const log = (entries: CorrectionLog["entries"] = []): CorrectionLog => ({ schemaVersion: 1, entries });

// ── A fake Base RPC endpoint over fixtures, served through the real transport ──

export interface FakeChain {
  head: number;
  finalized: number | null;
  txs: TransactionEvidence[];
  /** eth_call answers keyed by `${to}:${data}`, default "0x". */
  calls?: Map<string, string>;
  /** Fault hooks: return a JSON-RPC error message to fail that call, or undefined. */
  fail?: (method: string, params: unknown[]) => string | undefined;
  /** Hash suffix per block, to simulate a reorg after the cutoff was pinned. */
  fork?: (n: number) => string;
  /** Serve every log twice, as a provider with overlapping pages might. */
  duplicateLogs?: boolean;
  /** Count of calls by method. */
  seen: Record<string, number>;
}

export function fakeChain(txs: TransactionEvidence[], head = 20_000, finalized: number | null = 19_000): FakeChain {
  return { head, finalized, txs, seen: {} };
}

function answer(chain: FakeChain, method: string, params: any[]): { result?: unknown; error?: { code: number; message: string } } {
  chain.seen[method] = (chain.seen[method] ?? 0) + 1;
  const fault = chain.fail?.(method, params);
  if (fault) return { error: { code: -32000, message: fault } };
  const header = (n: number) => {
    const fixed = chain.txs.find((t) => t.block && Number(BigInt(t.block.number)) === n)?.block;
    return { number: hex(n), hash: blockHash(n, chain.fork?.(n) ?? ""), timestamp: fixed?.timestamp ?? hex(blockTime(n)) };
  };
  switch (method) {
    case "eth_getBlockByNumber": {
      const tag = params[0];
      if (tag === "finalized") return { result: chain.finalized === null ? null : header(chain.finalized) };
      const n = Number(BigInt(tag));
      return { result: n > chain.head ? null : header(n) };
    }
    case "eth_getLogs": {
      const f = params[0];
      const from = Number(BigInt(f.fromBlock));
      const to = Number(BigInt(f.toBlock));
      const topics: string[] = f.topics[0];
      const logs = chain.txs.flatMap((t) => (chain.duplicateLogs ? [...t.scannedLogs, ...t.scannedLogs] : t.scannedLogs)).filter((l) => l.address === f.address && topics.includes(l.topics[0]!) && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to);
      return { result: logs };
    }
    case "eth_getTransactionReceipt":
      return { result: chain.txs.find((t) => t.transactionHash === params[0])?.receipt ?? null };
    case "eth_getTransactionByHash":
      return { result: chain.txs.find((t) => t.transactionHash === params[0])?.transaction ?? null };
    case "eth_call":
      // Keyed `${to}:${data}@${blockTag}` for a block-pinned answer, else `${to}:${data}`.
      return { result: chain.calls?.get(`${params[0].to}:${params[0].data}@${params[1]}`) ?? chain.calls?.get(`${params[0].to}:${params[0].data}`) ?? "0x" };
    default:
      return { error: { code: -32601, message: `method ${method} not in the fake` } };
  }
}

/** Install the fake as globalThis.fetch. Returns a restore function. */
export function installFakeChain(chain: FakeChain): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const one = (b: any) => ({ jsonrpc: "2.0", id: b.id, ...answer(chain, b.method, b.params) });
    const out = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

export const RPC_ENV = { BASE_RPC_MAX_CALLS_PER_SEC: "0", BASE_RPC_MAX_RETRIES: "0", BASE_RPC_RETRY_BASE_MS: "1" };

/** Serve the fake over real HTTP, for a subprocess (the report CLI). Returns its URL and a stop function. */
export function serveFakeChain(chain: FakeChain): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json();
      const one = (b: any) => ({ jsonrpc: "2.0", id: b.id, ...answer(chain, b.method, b.params) });
      return Response.json(Array.isArray(body) ? body.map(one) : one(body));
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
