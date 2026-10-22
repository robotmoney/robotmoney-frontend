// THE CARRIER ADAPTER — CORE CONFORMANCE PENDING (issue 1371,
// docs/technical/referrals-spec.md §3, §11 "Encoding").
//
// `robotmoney-core` owns how a deposit's referral code is recorded on chain. The
// owner chose core's carrier on 2026-10-19: core emits an EVENT naming payer,
// receiver, amount and code. Core has not published the event's ABI yet. This
// module is the ONE place that knows the carrier's bytes, so when core ships,
// conformance is a change to this file and its fixtures and nothing else.
//
// PLACEHOLDER, CLEARLY. Until core documents its event, the adapter decodes:
//
//     event ReferralRecorded(address indexed payer, address indexed receiver, uint256 amount, string code)
//
// emitted by a manifest address (the router for a router deposit, the vault for
// a direct one) after the Deposit log(s) it covers, in the same transaction.
// The signature, the topic layout and the "after its legs" placement are this
// repository's assumptions, not core's specification. No contract change is
// proposed or implied (spec §1); a mismatch with core's real event is found by
// the conformance check at launch (spec §10), never by a merge gate.
//
// WHAT THE REPORT RELIES ON (spec §3, and the fourth property §11 adds): one
// carrier event per deposit authorization, readable from the receipt, naming
// payer, receiver, amount and the code exactly as chosen. A deposit with no
// carrier event is uncoded (coordinator default 2 on issue 1371). A router
// deposit is keyed by its carrier event, `(chainId, transactionHash,
// carrierLogIndex)`, which groups its legs into one authorization.
import { bytesToHex, eventTopic, hexToBytes } from "./eth-crypto.ts";

export const CARRIER_CONFORMANCE = "core-conformance-pending" as const;

/** Placeholder event signature. Replace with core's documented event. */
export const CARRIER_EVENT_SIGNATURE = "ReferralRecorded(address,address,uint256,string)";
export const CARRIER_TOPIC = eventTopic(CARRIER_EVENT_SIGNATURE);

/** ERC-4626 `Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)`. */
export const DEPOSIT_TOPIC = eventTopic("Deposit(address,address,uint256,uint256)");
/** ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)`. */
export const TRANSFER_TOPIC = eventTopic("Transfer(address,address,uint256)");

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
  blockNumber: string;
  blockHash?: string;
  transactionHash: string;
  transactionIndex?: string;
  removed?: boolean;
}

export interface CarrierRecord {
  logIndex: number;
  emitter: string;
  payer: string;
  receiver: string;
  amount: bigint;
  /**
   * The code exactly as recorded, when its bytes are valid UTF-8; null when
   * they are not (then `codeBytes` is the evidence). Never trimmed or
   * lowercased: the report judges it with isNormalizedReferralCode.
   */
  code: string | null;
  codeBytes: string;
}

function topicAddress(topic: string | undefined): string | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  if (!/^0x0{24}/.test(topic)) return null;
  return ("0x" + topic.slice(26)).toLowerCase();
}

function words(data: string): string[] | null {
  if (!/^0x([0-9a-fA-F]{64})*$/.test(data)) return null;
  const out: string[] = [];
  for (let i = 2; i < data.length; i += 64) out.push(data.slice(i, i + 64));
  return out;
}

/** Decode a carrier log, or a reason it cannot be decoded. Throws never. */
export function decodeCarrierLog(log: RawLog): { ok: true; record: CarrierRecord } | { ok: false; reason: string } {
  if (log.topics[0]?.toLowerCase() !== CARRIER_TOPIC) return { ok: false, reason: "not a carrier event" };
  const payer = topicAddress(log.topics[1]);
  const receiver = topicAddress(log.topics[2]);
  if (!payer || !receiver || log.topics.length !== 3) return { ok: false, reason: "carrier topics malformed" };
  const w = words(log.data);
  if (!w || w.length < 3) return { ok: false, reason: "carrier data malformed" };
  const amount = BigInt("0x" + w[0]);
  const offset = Number(BigInt("0x" + w[1]));
  if (offset !== 64) return { ok: false, reason: "carrier code offset malformed" };
  const len = Number(BigInt("0x" + w[2]));
  const bodyHex = w.slice(3).join("");
  if (len > 1024 || bodyHex.length < len * 2) return { ok: false, reason: "carrier code length malformed" };
  const bytes = hexToBytes("0x" + bodyHex.slice(0, len * 2));
  let code: string | null;
  try {
    code = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    code = null;
  }
  return {
    ok: true,
    record: { logIndex: Number(BigInt(log.logIndex)), emitter: log.address.toLowerCase(), payer, receiver, amount, code, codeBytes: bytesToHex(bytes) },
  };
}

export interface DepositRecord {
  logIndex: number;
  vault: string;
  sender: string;
  owner: string;
  assets: bigint;
  shares: bigint;
}

export function decodeDepositLog(log: RawLog): DepositRecord | null {
  if (log.topics[0]?.toLowerCase() !== DEPOSIT_TOPIC || log.topics.length !== 3) return null;
  const sender = topicAddress(log.topics[1]);
  const owner = topicAddress(log.topics[2]);
  const w = words(log.data);
  if (!sender || !owner || !w || w.length !== 2) return null;
  return { logIndex: Number(BigInt(log.logIndex)), vault: log.address.toLowerCase(), sender, owner, assets: BigInt("0x" + w[0]), shares: BigInt("0x" + w[1]) };
}

export interface TransferRecord {
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}

export function decodeTransferLog(log: RawLog): TransferRecord | null {
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) return null;
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  const w = words(log.data);
  if (!from || !to || !w || w.length !== 1) return null;
  return { logIndex: Number(BigInt(log.logIndex)), token: log.address.toLowerCase(), from, to, value: BigInt("0x" + w[0]) };
}

// ── Fixture encoders. Tests and the offline fixtures build logs with these, so
// a fixture and the decoder can only disagree through the ABI itself. ────────

function word(v: bigint): string {
  return v.toString(16).padStart(64, "0");
}
export function addressTopic(address: string): string {
  return "0x" + "0".repeat(24) + address.toLowerCase().slice(2);
}

/** Encode a placeholder carrier log's topics and data. */
export function encodeCarrierLog(payer: string, receiver: string, amount: bigint, codeBytes: Uint8Array): { topics: string[]; data: string } {
  const padded = Math.ceil(codeBytes.length / 32) * 32;
  const body = bytesToHex(codeBytes).slice(2).padEnd(padded * 2, "0");
  return { topics: [CARRIER_TOPIC, addressTopic(payer), addressTopic(receiver)], data: "0x" + word(amount) + word(64n) + word(BigInt(codeBytes.length)) + body };
}

export function encodeDepositLog(sender: string, owner: string, assets: bigint, shares: bigint): { topics: string[]; data: string } {
  return { topics: [DEPOSIT_TOPIC, addressTopic(sender), addressTopic(owner)], data: "0x" + word(assets) + word(shares) };
}

export function encodeTransferLog(from: string, to: string, value: bigint): { topics: string[]; data: string } {
  return { topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)], data: "0x" + word(value) };
}
