// From one transaction's chain evidence to deposit authorizations (issue 1371,
// docs/technical/referrals-spec.md §2, §3, §7).
//
// INPUT is everything the report fetched for one transaction: the logs the scan
// found, the receipt, the transaction and the block header. OUTPUT is the deposit
// authorizations in it, each with its payer, receiver, legs and carrier, or an
// unknown observation naming the wallets it could affect. Pure: no RPC here.
//
// WHAT "PROVEN" MEANS (spec §2). An approval or a transfer somewhere in a
// receipt is not a deposit. A leg is an ERC-4626 Deposit log emitted by a
// manifest vault, matched by an asset Transfer of exactly its assets from the
// leg's sender into that vault, in a successful receipt whose block hash,
// number and transaction agree. The payer is the carrier's payer (a router
// deposit, or any coded deposit) or the Deposit's sender (an uncoded direct
// deposit, where the sender is the wallet that funded it). A router deposit with
// no carrier event has no proven payer, so it is unknown, never assumed
// self-funded (carrier.ts: core conformance pending).
//
// Anything inconsistent or missing is UNKNOWN, never "no referral" (spec §7).
import { decodeCarrierLog, decodeDepositLog, decodeTransferLog, CARRIER_TOPIC, DEPOSIT_TOPIC, type CarrierRecord, type DepositRecord, type RawLog } from "./carrier.ts";
import { entryForAddress, type ReferralManifest } from "./manifest.ts";

export interface RawReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  transactionIndex: string;
  status: string;
  logs: RawLog[];
  [k: string]: unknown;
}

export interface RawTransaction {
  hash: string;
  blockHash: string | null;
  blockNumber: string | null;
  transactionIndex: string | null;
  from: string;
  to: string | null;
  [k: string]: unknown;
}

export interface RawBlock {
  number: string;
  hash: string;
  timestamp: string;
  [k: string]: unknown;
}

export interface TransactionEvidence {
  transactionHash: string;
  /** The logs eth_getLogs returned for this transaction. */
  scannedLogs: RawLog[];
  receipt: RawReceipt | null;
  transaction: RawTransaction | null;
  block: RawBlock | null;
}

export interface DepositLeg {
  entryId: string;
  vault: string;
  logIndex: number;
  sender: string;
  assets: string;
  shares: string;
}

export interface DepositAuthorization {
  /** `${chainId}:${transactionHash}:${keyLogIndex}`, the authorization key. */
  id: string;
  chainId: number;
  transactionHash: string;
  /** The carrier log for a coded deposit; the Deposit log for an uncoded direct one. */
  keyLogIndex: number;
  keySource: "carrier" | "deposit";
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  transactionIndex: number;
  via: "direct" | "router";
  /** Null when no evidence proves who paid. */
  payer: string | null;
  receiver: string;
  /** Raw integer asset units, as a decimal string. */
  assets: string;
  legs: DepositLeg[];
  carrier: null | { logIndex: number; emitter: string; code: string | null; codeBytes: string };
  /** Further carrier events that name this same deposit: conflicting codes (spec §9). */
  conflictingCarriers: { logIndex: number; code: string | null; codeBytes: string }[];
  status: "proven" | "unknown";
  problems: string[];
}

export interface UnknownObservation {
  transactionHash: string | null;
  blockNumber: number | null;
  /** Block time when known; null when the block itself is missing. */
  blockTimestamp: number | null;
  /** The wallets this could affect, or null when they cannot be determined. */
  wallets: string[] | null;
  reason: string;
}

const hexNum = (v: string | null | undefined): number | null => (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? Number(BigInt(v)) : null);
const lower = (v: string | null | undefined) => (typeof v === "string" ? v.toLowerCase() : v);

function walletsInLogs(logs: RawLog[]): string[] {
  const out = new Set<string>();
  for (const l of logs) {
    const d = decodeDepositLog(l);
    if (d) out.add(d.owner);
    const c = decodeCarrierLog(l);
    if (c.ok) {
      out.add(c.record.receiver);
      out.add(c.record.payer);
    }
  }
  return [...out].sort();
}

function sameLog(a: RawLog, b: RawLog): boolean {
  return (
    lower(a.address) === lower(b.address) &&
    hexNum(a.logIndex) === hexNum(b.logIndex) &&
    a.data.toLowerCase() === b.data.toLowerCase() &&
    a.topics.length === b.topics.length &&
    a.topics.every((t, i) => t.toLowerCase() === b.topics[i]!.toLowerCase())
  );
}

/** Decode one transaction. Never throws on bad evidence: it reports it. */
export function decodeTransactionEvidence(
  ev: TransactionEvidence,
  manifest: ReferralManifest,
): { authorizations: DepositAuthorization[]; unknowns: UnknownObservation[] } {
  const chainId = manifest.chainId;
  const hash = ev.transactionHash.toLowerCase();
  const scannedBlock = ev.scannedLogs.length ? hexNum(ev.scannedLogs[0]!.blockNumber) : null;
  const unknown = (reason: string): { authorizations: DepositAuthorization[]; unknowns: UnknownObservation[] } => ({
    authorizations: [],
    unknowns: [{ transactionHash: hash, blockNumber: hexNum(ev.block?.number) ?? scannedBlock, blockTimestamp: hexNum(ev.block?.timestamp), wallets: walletsInLogs(ev.scannedLogs), reason }],
  });

  const { receipt, transaction: tx, block } = ev;
  if (!receipt) return unknown("receipt unavailable");
  if (!tx) return unknown("transaction unavailable");
  if (!block) return unknown("block unavailable");
  if (lower(receipt.transactionHash) !== hash || lower(tx.hash) !== hash) return unknown("evidence names a different transaction");
  if (lower(receipt.blockHash) !== lower(block.hash) || lower(tx.blockHash) !== lower(block.hash)) return unknown("receipt, transaction and block disagree on the block hash");
  if (hexNum(receipt.blockNumber) !== hexNum(block.number) || hexNum(tx.blockNumber) !== hexNum(block.number)) return unknown("receipt, transaction and block disagree on the block number");
  if (hexNum(receipt.transactionIndex) !== hexNum(tx.transactionIndex)) return unknown("receipt and transaction disagree on the transaction index");
  if (!Array.isArray(receipt.logs)) return unknown("receipt without logs");
  for (const l of ev.scannedLogs) {
    if (l.removed) return unknown("a scanned log was removed by a reorg");
    if (l.blockHash && lower(l.blockHash) !== lower(block.hash)) return unknown("a scanned log names a different block hash");
    if (!receipt.logs.some((r) => sameLog(r, l))) return unknown("a scanned log is missing from the receipt");
  }
  if (receipt.status !== "0x1") {
    // A reverted transaction emits no logs, so a scan never finds one. If the
    // scan did, the evidence contradicts itself.
    return ev.scannedLogs.length ? unknown("receipt reverted but the scan found its logs") : { authorizations: [], unknowns: [] };
  }

  const blockNumber = hexNum(block.number)!;
  const blockTimestamp = hexNum(block.timestamp);
  const transactionIndex = hexNum(receipt.transactionIndex);
  if (blockTimestamp === null || transactionIndex === null) return unknown("block timestamp or transaction index unreadable");

  const asset = manifest.asset.address.toLowerCase();
  const routers = new Set(manifest.entries.filter((e) => e.kind === "router").map((e) => e.address));
  const logs = [...receipt.logs].sort((a, b) => (hexNum(a.logIndex) ?? 0) - (hexNum(b.logIndex) ?? 0));
  const transfers = logs.map(decodeTransferLog).filter((t): t is NonNullable<typeof t> => t !== null && t.token === asset);
  const usedTransfers = new Set<number>();

  const authorizations: DepositAuthorization[] = [];
  const unknowns: UnknownObservation[] = [];
  let pending: { record: DepositRecord; entryId: string }[] = [];

  const makeLeg = (p: { record: DepositRecord; entryId: string }, problems: string[]): DepositLeg => {
    const t = transfers.find(
      (x) => !usedTransfers.has(x.logIndex) && x.from === p.record.sender && x.to === p.record.vault && x.value === p.record.assets && x.logIndex < p.record.logIndex,
    );
    if (t) usedTransfers.add(t.logIndex);
    else problems.push(`Deposit log ${p.record.logIndex} has no matching ${manifest.asset.symbol} transfer into the vault`);
    return { entryId: p.entryId, vault: p.record.vault, logIndex: p.record.logIndex, sender: p.record.sender, assets: p.record.assets.toString(), shares: p.record.shares.toString() };
  };

  const base = (keyLogIndex: number, keySource: "carrier" | "deposit") => ({
    id: `${chainId}:${hash}:${keyLogIndex}`,
    chainId,
    transactionHash: hash,
    keyLogIndex,
    keySource,
    blockNumber,
    blockHash: block.hash.toLowerCase(),
    blockTimestamp,
    transactionIndex,
  });

  for (const log of logs) {
    const entry = entryForAddress(manifest, log.address);
    if (!entry) continue; // only manifest addresses' events count; code bytes elsewhere are ignored (spec §9)
    const topic = log.topics[0]?.toLowerCase();
    if (topic === DEPOSIT_TOPIC && entry.kind === "vault") {
      const d = decodeDepositLog(log);
      if (!d) {
        unknowns.push({ transactionHash: hash, blockNumber, blockTimestamp, wallets: null, reason: `Deposit log ${hexNum(log.logIndex)} undecodable` });
        continue;
      }
      pending.push({ record: d, entryId: entry.id });
      continue;
    }
    if (topic !== CARRIER_TOPIC) continue;

    const decoded = decodeCarrierLog(log);
    const logIndex = hexNum(log.logIndex)!;
    let carrier: CarrierRecord;
    const problems: string[] = [];
    if (!decoded.ok) {
      // Undecodable evidence is never skipped to award the next code. The legs
      // it would cover stay together as one unknown authorization.
      problems.push(`carrier event ${logIndex} undecodable: ${decoded.reason}`);
      carrier = { logIndex, emitter: entry.address, payer: "", receiver: pending[0]?.record.owner ?? "", amount: -1n, code: null, codeBytes: "0x" };
    } else carrier = decoded.record;

    const mine = pending.filter((p) => p.record.owner === carrier.receiver);
    if (mine.length === 0) {
      const prev = authorizations[authorizations.length - 1];
      if (prev && prev.receiver === carrier.receiver && prev.payer === carrier.payer && prev.keySource === "carrier") {
        prev.conflictingCarriers.push({ logIndex, code: carrier.code, codeBytes: carrier.codeBytes });
      } else {
        unknowns.push({ transactionHash: hash, blockNumber, blockTimestamp, wallets: [carrier.receiver, carrier.payer].filter(Boolean).sort(), reason: `carrier event ${logIndex} names no deposit` });
      }
      continue;
    }
    pending = pending.filter((p) => !mine.includes(p));
    const legs = mine.map((p) => makeLeg(p, problems));
    const total = mine.reduce((s, p) => s + p.record.assets, 0n);
    if (decoded.ok && total !== carrier.amount) problems.push(`carrier amount ${carrier.amount} does not equal the deposit's ${total}`);
    const viaRouter = mine.map((p) => routers.has(p.record.sender));
    if (viaRouter.some((v) => v) && !viaRouter.every((v) => v)) problems.push("carrier covers both router and direct legs");
    const via = viaRouter[0] ? "router" : "direct";
    if (decoded.ok && via === "direct" && mine.some((p) => p.record.sender !== carrier.payer)) problems.push("a direct deposit's sender is not the carrier's payer");
    if (decoded.ok && via === "router" && !routers.has(entry.address)) problems.push("a router deposit's carrier was not emitted by the router");
    authorizations.push({
      ...base(logIndex, "carrier"),
      via,
      payer: decoded.ok ? carrier.payer : null,
      receiver: mine[0]!.record.owner,
      assets: total.toString(),
      legs,
      carrier: { logIndex, emitter: carrier.emitter, code: carrier.code, codeBytes: carrier.codeBytes },
      conflictingCarriers: [],
      status: problems.length ? "unknown" : "proven",
      problems,
    });
  }

  // Legs no carrier claimed. A direct leg is its own uncoded deposit, paid by
  // its sender. Router legs with no carrier have no proven payer.
  const routerLegs = new Map<string, { record: DepositRecord; entryId: string }[]>();
  for (const p of pending) {
    if (routers.has(p.record.sender)) {
      const list = routerLegs.get(p.record.owner) ?? [];
      list.push(p);
      routerLegs.set(p.record.owner, list);
      continue;
    }
    const problems: string[] = [];
    const leg = makeLeg(p, problems);
    authorizations.push({
      ...base(p.record.logIndex, "deposit"),
      via: "direct",
      payer: p.record.sender,
      receiver: p.record.owner,
      assets: p.record.assets.toString(),
      legs: [leg],
      carrier: null,
      conflictingCarriers: [],
      status: problems.length ? "unknown" : "proven",
      problems,
    });
  }
  for (const [receiver, list] of routerLegs) {
    const problems = ["router deposit without a carrier event: payer unproven (carrier: core conformance pending)"];
    const legs = list.map((p) => makeLeg(p, problems));
    authorizations.push({
      ...base(list[0]!.record.logIndex, "deposit"),
      via: "router",
      payer: null,
      receiver,
      assets: list.reduce((s, p) => s + p.record.assets, 0n).toString(),
      legs,
      carrier: null,
      conflictingCarriers: [],
      status: "unknown",
      problems,
    });
  }

  authorizations.sort((a, b) => a.keyLogIndex - b.keyLogIndex);
  return { authorizations, unknowns };
}
