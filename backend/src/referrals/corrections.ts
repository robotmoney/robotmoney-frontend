// Admin referral corrections: the append-only correction log (issue 1371,
// docs/technical/referrals-spec.md §4).
//
// STORAGE. A correction is an entry in backend/src/referrals/config/corrections.json,
// added by a reviewed change and shipped in a release, exactly like the code
// registry. It is not a table and not an admin-route write: D66 makes every
// production data change a migration and rejects "an admin-route write with an
// audit row", and spec §8 prefers no new schema. Review is the "who"; the
// entry's `recordedBy`, `recordedAt`, `reason` and evidence are the rest of the
// log line §4 requires. A revocation is a later entry naming the correction, so
// nothing is ever edited or removed.
//
// TWO KINDS (spec §4):
//   verified  the depositor's wallet signed `correctionMessage(entry)`, which
//             names chain, wallet, code, deposit transaction and event, expiry
//             and nonce. EOA: EIP-191 personal_sign, checked here. Smart
//             wallet: EIP-1271 isValidSignature, checked by one read of the
//             wallet contract (verifyCorrectionSignature).
//   override  an admin's written reason.
//
// WHAT IS CHECKED WHERE. Everything that needs no chain history is checked
// here, when the entry is recorded (backend/tests/referrals-config.test.ts runs
// it over the committed log, and the admin panel shows the result): shape,
// code, nonce never reused, expiry, signature, one live correction per wallet,
// revocation targets. What needs chain history (the wallet had no attribution
// yet; the named deposit is a self-funded qualifying deposit by that wallet,
// not a gift) is decided by the report at its pinned snapshot, at the
// correction's recording time (attribution.ts).
import { isNormalizedReferralCode } from "@robotmoney/contract";
import { ethCall, isEmptyReturnData, type RpcCallOptions } from "../chain/base-rpc-client.ts";
import { EIP1271_MAGIC_WORD, encodeIsValidSignatureCall, personalMessageHash, recoverAddress } from "./eth-crypto.ts";
import { findCode, isoToSeconds, REFERRAL_CHAIN_ID, type ReferralRegistry } from "./registry.ts";

export interface CorrectionSignature {
  scheme: "eip191" | "eip1271";
  expiresAt: string;
  nonce: string;
  /** 0x hex. EIP-191: 65 bytes r||s||v. EIP-1271: whatever the wallet contract accepts. */
  signature: string;
}

export interface CorrectionEntry {
  type: "correction";
  id: string;
  kind: "verified" | "override";
  chainId: number;
  wallet: string;
  code: string;
  deposit: { transactionHash: string; logIndex: number };
  recordedAt: string;
  recordedBy: string;
  reason: string;
  /** Required for verified, absent (null) for override. */
  signature: CorrectionSignature | null;
}

export interface RevocationEntry {
  type: "revocation";
  id: string;
  revokes: string;
  recordedAt: string;
  recordedBy: string;
  reason: string;
}

export type CorrectionLogEntry = CorrectionEntry | RevocationEntry;

export interface CorrectionLog {
  schemaVersion: 1;
  entries: CorrectionLogEntry[];
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;

/** The exact text a wallet signs for a verified correction. Every field the spec names, one per line. */
export function correctionMessage(e: Pick<CorrectionEntry, "chainId" | "wallet" | "code" | "deposit"> & { signature: Pick<CorrectionSignature, "expiresAt" | "nonce"> }): string {
  return [
    "Robot Money referral correction",
    `Chain ID: ${e.chainId}`,
    `Wallet: ${e.wallet}`,
    `Referral code: ${e.code}`,
    `Deposit transaction: ${e.deposit.transactionHash}`,
    `Deposit event log index: ${e.deposit.logIndex}`,
    `Expires at: ${e.signature.expiresAt}`,
    `Nonce: ${e.signature.nonce}`,
  ].join("\n");
}

function allZero(hex: string): boolean {
  return /^0x0*$/.test(hex);
}

export interface EntryCheck {
  id: string;
  /** Problems found without chain history; empty when the entry is accepted on those checks. */
  problems: string[];
  /** EIP-1271 needs a read of the wallet contract; true until verifyCorrectionSignature ran. */
  needsContractSignatureCheck: boolean;
}

/**
 * Check every entry of the log against the registry, in log order. An entry
 * with problems is rejected: it never binds, and the report shows it as
 * rejected with these reasons. Structural problems with the log itself (ids,
 * order) are returned in `logErrors` and fail config validation outright.
 */
export function checkCorrectionLog(log: CorrectionLog, registry: ReferralRegistry): { logErrors: string[]; entries: EntryCheck[] } {
  const logErrors: string[] = [];
  if (log.schemaVersion !== 1) logErrors.push("corrections: schemaVersion must be 1");
  const entries: EntryCheck[] = [];
  const ids = new Set<string>();
  const nonces = new Set<string>();
  const corrections = new Map<string, { entry: CorrectionEntry; accepted: boolean; revoked: boolean }>();
  const liveByWallet = new Map<string, string>();
  let lastRecorded = -Infinity;

  for (const e of log.entries ?? []) {
    const problems: string[] = [];
    let needsContract = false;
    if (!ID.test(e.id ?? "")) logErrors.push(`corrections: id ${JSON.stringify(e.id)} must be a lowercase slug`);
    if (ids.has(e.id)) logErrors.push(`corrections: id ${JSON.stringify(e.id)} used twice`);
    ids.add(e.id);
    const recorded = isoToSeconds(e.recordedAt);
    if (recorded === null) logErrors.push(`corrections: ${e.id}: recordedAt must be an ISO 8601 UTC time`);
    else {
      if (recorded < lastRecorded) logErrors.push(`corrections: ${e.id}: entries are appended in recording order`);
      lastRecorded = Math.max(lastRecorded, recorded);
    }
    if (typeof e.recordedBy !== "string" || e.recordedBy.trim() === "") problems.push("recordedBy (who) is required");
    if (typeof e.reason !== "string" || e.reason.trim() === "") problems.push("reason (why) is required");

    if (e.type === "revocation") {
      const target = corrections.get(e.revokes);
      if (!target) problems.push(`revokes ${JSON.stringify(e.revokes)}, which is not an earlier correction`);
      else if (target.revoked) problems.push(`${e.revokes} is already revoked`);
      else if (!target.accepted) problems.push(`${e.revokes} was rejected; there is nothing to revoke`);
      if (target && problems.length === 0) {
        target.revoked = true;
        if (liveByWallet.get(target.entry.wallet) === target.entry.id) liveByWallet.delete(target.entry.wallet);
      }
      entries.push({ id: e.id, problems, needsContractSignatureCheck: false });
      continue;
    }
    if ((e as { type: string }).type !== "correction") {
      logErrors.push(`corrections: ${(e as { id: string }).id}: type must be correction or revocation`);
      continue;
    }

    if (e.kind !== "verified" && e.kind !== "override") problems.push("kind must be verified or override");
    if (e.chainId !== REFERRAL_CHAIN_ID) problems.push(`chainId must be ${REFERRAL_CHAIN_ID}`);
    if (!ADDRESS.test(e.wallet ?? "")) problems.push("wallet must be a lowercase 0x address");
    if (!isNormalizedReferralCode(e.code)) problems.push("code is not a normalized referral code");
    else if (!findCode(registry, e.code)) problems.push(`code ${e.code} is not in the registry`);
    if (!TX_HASH.test(e.deposit?.transactionHash ?? "")) problems.push("deposit.transactionHash must be a lowercase 0x hash");
    if (!Number.isInteger(e.deposit?.logIndex) || e.deposit.logIndex < 0) problems.push("deposit.logIndex must be a non-negative integer");
    const live = liveByWallet.get(e.wallet);
    if (live) problems.push(`wallet already has correction ${live}; a correction never takes a wallet from another code`);

    if (e.kind === "verified") {
      const s = e.signature;
      if (!s) problems.push("a verified correction carries the wallet's signature");
      else {
        if (s.scheme !== "eip191" && s.scheme !== "eip1271") problems.push("signature.scheme must be eip191 or eip1271");
        const expires = isoToSeconds(s.expiresAt);
        if (expires === null) problems.push("signature.expiresAt must be an ISO 8601 UTC time");
        else if (recorded !== null && recorded > expires) problems.push("the signed payload expired before it was recorded");
        if (typeof s.nonce !== "string" || s.nonce.trim() === "") problems.push("signature.nonce is required");
        else if (nonces.has(s.nonce)) problems.push(`nonce ${JSON.stringify(s.nonce)} was already used; a nonce is never accepted twice`);
        else nonces.add(s.nonce);
        if (typeof s.signature !== "string" || !HEX.test(s.signature) || allZero(s.signature)) problems.push("signature is empty, all zero or not hex");
        else if (s.scheme === "eip191" && problems.length === 0) {
          const signer = recoverAddress(personalMessageHash(correctionMessage(e as CorrectionEntry & { signature: CorrectionSignature })), s.signature);
          if (signer !== e.wallet) problems.push(signer === null ? "EIP-191 signature recovers no key" : `EIP-191 signature is by ${signer}, not the wallet`);
        } else if (s.scheme === "eip1271" && problems.length === 0) {
          needsContract = true;
        }
      }
    } else if (e.kind === "override" && e.signature !== null && e.signature !== undefined) {
      problems.push("an override carries no signature; it is an admin's written reason");
    }

    const accepted = problems.length === 0;
    corrections.set(e.id, { entry: e, accepted, revoked: false });
    if (accepted) liveByWallet.set(e.wallet, e.id);
    entries.push({ id: e.id, problems, needsContractSignatureCheck: needsContract });
  }
  return { logErrors, entries };
}

/**
 * EIP-1271: ask the wallet contract whether it accepts the signature over the
 * message hash, at `blockTag` (the report's pinned block; the admin panel's
 * latest). Returns problems; empty means accepted. A transport failure or an
 * empty return is "unverifiable", never accepted and never a silent pass.
 */
export async function verifyContractSignature(e: CorrectionEntry, opts: RpcCallOptions): Promise<{ status: "accepted" | "rejected" | "unverifiable"; problem: string | null }> {
  if (!e.signature || e.signature.scheme !== "eip1271") return { status: "rejected", problem: "not an EIP-1271 correction" };
  const hash = personalMessageHash(correctionMessage(e as CorrectionEntry & { signature: CorrectionSignature }));
  let result: string;
  try {
    result = await ethCall(e.wallet, encodeIsValidSignatureCall(hash, e.signature.signature), opts);
  } catch (err) {
    return { status: "unverifiable", problem: `EIP-1271 read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (isEmptyReturnData(result)) return { status: "rejected", problem: "the wallet has no EIP-1271 contract code at this block" };
  if (result.toLowerCase().slice(0, 66) !== EIP1271_MAGIC_WORD) return { status: "rejected", problem: "the wallet contract rejected the signature (EIP-1271)" };
  return { status: "accepted", problem: null };
}

/**
 * Previous-revision check: the accepted log is a prefix of the new one, entry
 * for entry, and every appended entry is recorded no earlier than this
 * revision's deployment, so a correction never takes effect before it shipped.
 */
export function validateCorrectionLogHistory(prev: CorrectionLog, next: CorrectionLog, deployedAt: number): string[] {
  const errors: string[] = [];
  const p = prev.entries ?? [];
  const n = next.entries ?? [];
  if (n.length < p.length) errors.push("corrections: entries were removed; the log is append-only");
  for (let i = 0; i < Math.min(p.length, n.length); i++) {
    if (JSON.stringify(p[i]) !== JSON.stringify(n[i])) errors.push(`corrections: entry ${i} (${p[i]!.id}) was edited; the log is append-only`);
  }
  for (const e of n.slice(p.length)) {
    const t = isoToSeconds(e.recordedAt);
    if (t !== null && t < deployedAt) errors.push(`corrections: ${e.id}: recordedAt ${e.recordedAt} is earlier than this revision's deployment; a correction takes effect when recorded, never earlier`);
  }
  return errors;
}

export function emptyCorrectionLog(): CorrectionLog {
  return { schemaVersion: 1, entries: [] };
}
