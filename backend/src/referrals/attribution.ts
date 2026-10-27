// The attribution rules: from deposit authorizations, the registry and the
// correction log to one row per wallet (issue 1371, docs/technical/referrals-spec.md
// §2, §4, §7). Pure and deterministic: same inputs, same rows, same order.
//
// THE RULES, in the order a wallet's history is walked:
//   - Chain candidates are ordered by (blockNumber, transactionIndex, key log
//     index); a correction sits at its recording time. On an equal second the
//     chain candidate comes first. Corrections recorded after the cutoff are
//     not in the report at all, so a produced report never changes.
//   - The first QUALIFYING deposit (self-funded: payer and receiver are the
//     wallet; positive assets; proven) across every manifest deployment starts
//     a 30 x 24 h window. Gifts, zero-asset deposits and unknown evidence never
//     start it. Pre-launch and v0 deposits count; nothing resets it.
//   - A coded qualifying deposit binds when its code is well formed, in the
//     registry, active at its block time, at or after the launch block, inside
//     the window, and the wallet is not already bound. Exactly the expiry second
//     is late.
//   - A correction binds at its recording time when its own checks passed, the
//     wallet is unbound then, and it names a proven self-funded deposit by the
//     wallet. A revocation ends it from the revocation time, forward only.
//   - The earliest valid attribution wins; a later one is `already_bound`.
//   - Unknown evidence before a binding makes it provisional; with no binding
//     the wallet's eligibility is unknown, never "no referral". Incomplete
//     coverage makes every binding provisional.
import { isNormalizedReferralCode } from "@robotmoney/contract";
import type { CorrectionEntry, CorrectionLog, RevocationEntry } from "./corrections.ts";
import type { DepositAuthorization, UnknownObservation } from "./evidence.ts";
import { codeStateAt, findCode, isoToSeconds, type ReferralBeneficiary, type ReferralDisplaySnapshot, type ReferralRegistry } from "./registry.ts";

export const ATTRIBUTION_WINDOW_SECONDS = 30 * 24 * 60 * 60; // 2592000

export type CandidateReason =
  | "bound"
  | "already_bound"
  | "uncoded"
  | "late"
  | "before_launch"
  | "code_inactive"
  | "gift"
  | "invalid_code"
  | "unknown_code"
  | "conflicting_codes"
  | "zero_assets"
  | "evidence_unavailable"
  | "correction_rejected"
  | "correction_revoked";

export interface Candidate {
  source: "chain" | "correction" | "unknown";
  /** Authorization key, correction id, or the unknown observation's transaction. */
  id: string | null;
  transactionHash: string | null;
  logIndex: number | null;
  blockNumber: number | null;
  /** ISO 8601 UTC effective time: block time or recording time; null when unknown. */
  time: string | null;
  via: "direct" | "router" | null;
  code: string | null;
  reason: CandidateReason;
  detail: string | null;
}

export interface Binding {
  code: string;
  beneficiary: ReferralBeneficiary;
  display: ReferralDisplaySnapshot;
  source: "chain" | "correction";
  correctionKind: "verified" | "override" | null;
  correctionId: string | null;
  event: { transactionHash: string; logIndex: number } | null;
  effectiveAt: string;
}

export interface AttributionRow {
  wallet: string;
  bindingStatus: "final" | "provisional" | "unbound" | "unknown";
  binding: Binding | null;
  firstQualifyingDeposit: null | { id: string; transactionHash: string; logIndex: number; blockNumber: number; time: string; tentative: boolean };
  windowEndsAt: string | null;
  candidates: Candidate[];
}

export interface AttributionInput {
  cutoff: { number: number; timestamp: number };
  registry: ReferralRegistry;
  corrections: CorrectionLog;
  /** Per correction id, the problems from checkCorrectionLog plus the EIP-1271 read. Empty = accepted. */
  correctionProblems: ReadonlyMap<string, readonly string[]>;
  authorizations: readonly DepositAuthorization[];
  unknowns: readonly UnknownObservation[];
  /** False when the manifest, a range or the carrier leaves history incomplete. */
  coverageComplete: boolean;
}

export const isoOf = (s: number): string => new Date(s * 1000).toISOString().replace(".000Z", "Z");

type Item =
  | { k: "chain"; t: number; block: number; tx: number; log: number; a: DepositAuthorization }
  | { k: "unknown"; t: number; block: number; tx: number; log: number; u: UnknownObservation }
  | { k: "correction"; t: number; c: CorrectionEntry }
  | { k: "revocation"; t: number; r: RevocationEntry; target: CorrectionEntry };

function compareItems(a: Item, b: Item): number {
  const chainish = (i: Item) => i.k === "chain" || i.k === "unknown";
  if (chainish(a) && chainish(b)) {
    const x = a as Extract<Item, { block: number }>;
    const y = b as Extract<Item, { block: number }>;
    return x.block - y.block || x.tx - y.tx || x.log - y.log;
  }
  if (a.t !== b.t) return a.t - b.t;
  // Equal second: chain evidence first, then corrections, then revocations.
  const rank = (i: Item) => (chainish(i) ? 0 : i.k === "correction" ? 1 : 2);
  return rank(a) - rank(b);
}

function sortItems(items: Item[]): Item[] {
  // Chain items keep their total chain order; time decides only across kinds.
  // A stable merge of the two sorted lists does exactly that.
  const chain = items.filter((i) => i.k === "chain" || i.k === "unknown").sort(compareItems);
  const other = items.filter((i) => i.k === "correction" || i.k === "revocation").sort(compareItems);
  const out: Item[] = [];
  let i = 0;
  let j = 0;
  while (i < chain.length || j < other.length) {
    if (j >= other.length || (i < chain.length && compareItems(chain[i]!, other[j]!) <= 0)) out.push(chain[i++]!);
    else out.push(other[j++]!);
  }
  return out;
}

/** Attribute every wallet the evidence or the correction log names. Rows sorted by wallet. */
export function attribute(input: AttributionInput): AttributionRow[] {
  const cutoffT = input.cutoff.timestamp;
  const globalUnknown = !input.coverageComplete || input.unknowns.some((u) => u.wallets === null);
  const perWallet = new Map<string, Item[]>();
  const push = (w: string, i: Item) => {
    const list = perWallet.get(w) ?? [];
    list.push(i);
    perWallet.set(w, list);
  };

  for (const a of input.authorizations) {
    if (a.blockNumber > input.cutoff.number) continue;
    push(a.receiver, { k: "chain", t: a.blockTimestamp, block: a.blockNumber, tx: a.transactionIndex, log: a.keyLogIndex, a });
  }
  for (const u of input.unknowns) {
    if (u.blockNumber !== null && u.blockNumber > input.cutoff.number) continue;
    // A missing block time sorts as early as possible: it cannot be shown to be later.
    for (const w of u.wallets ?? []) push(w, { k: "unknown", t: u.blockTimestamp ?? -Infinity, block: u.blockNumber ?? -1, tx: -1, log: -1, u });
  }
  const byId = new Map<string, CorrectionEntry>();
  for (const e of input.corrections.entries) {
    const t = isoToSeconds(e.recordedAt);
    if (t === null || t > cutoffT) continue;
    if (e.type === "correction") {
      byId.set(e.id, e);
      push(e.wallet, { k: "correction", t, c: e });
    } else {
      const target = byId.get(e.revokes);
      if (target && (input.correctionProblems.get(e.id) ?? []).length === 0) push(target.wallet, { k: "revocation", t, r: e, target });
    }
  }

  const rows: AttributionRow[] = [];
  for (const wallet of [...perWallet.keys()].sort()) {
    rows.push(walk(wallet, sortItems(perWallet.get(wallet)!), input, globalUnknown));
  }
  return rows;
}

function walk(wallet: string, items: Item[], input: AttributionInput, globalUnknown: boolean): AttributionRow {
  const candidates: Candidate[] = [];
  let binding: Binding | null = null;
  let uncertainAtBinding = false;
  let uncertain = false;
  let first: AttributionRow["firstQualifyingDeposit"] = null;
  const proven = (a: DepositAuthorization) => a.status === "proven" && a.payer === wallet && a.receiver === wallet;

  const chainCandidate = (a: DepositAuthorization, reason: CandidateReason, detail: string | null = null): Candidate => ({
    source: "chain",
    id: a.id,
    transactionHash: a.transactionHash,
    logIndex: a.keyLogIndex,
    blockNumber: a.blockNumber,
    time: isoOf(a.blockTimestamp),
    via: a.via,
    code: a.carrier?.code ?? null,
    reason,
    detail,
  });

  for (const item of items) {
    if (item.k === "unknown") {
      uncertain = true;
      candidates.push({ source: "unknown", id: null, transactionHash: item.u.transactionHash, logIndex: null, blockNumber: item.u.blockNumber, time: item.u.blockTimestamp === null ? null : isoOf(item.u.blockTimestamp), via: null, code: null, reason: "evidence_unavailable", detail: item.u.reason });
      continue;
    }
    if (item.k === "chain") {
      const a = item.a;
      if (a.status !== "proven") {
        uncertain = true;
        candidates.push(chainCandidate(a, "evidence_unavailable", a.problems.join("; ")));
        continue;
      }
      if (a.payer !== wallet) {
        candidates.push(chainCandidate(a, "gift", `paid by ${a.payer}`));
        continue;
      }
      if (BigInt(a.assets) <= 0n) {
        candidates.push(chainCandidate(a, "zero_assets"));
        continue;
      }
      if (first === null) first = { id: a.id, transactionHash: a.transactionHash, logIndex: a.keyLogIndex, blockNumber: a.blockNumber, time: isoOf(a.blockTimestamp), tentative: uncertain };
      if (!a.carrier) {
        candidates.push(chainCandidate(a, "uncoded"));
        continue;
      }
      if (a.conflictingCarriers.length) {
        const codes = [a.carrier.code, ...a.conflictingCarriers.map((c) => c.code)].map((c) => JSON.stringify(c)).join(", ");
        candidates.push(chainCandidate(a, "conflicting_codes", `carrier events name ${codes} for one deposit`));
        continue;
      }
      const code = a.carrier.code;
      if (!isNormalizedReferralCode(code)) {
        candidates.push(chainCandidate(a, "invalid_code", code === null ? `code bytes ${a.carrier.codeBytes} are not UTF-8` : `recorded ${JSON.stringify(code)} is not a normalized code`));
        continue;
      }
      const record = findCode(input.registry, code!);
      if (!record) {
        candidates.push(chainCandidate(a, "unknown_code"));
        continue;
      }
      if (binding) {
        candidates.push(chainCandidate(a, "already_bound", `bound to ${binding.code} since ${binding.effectiveAt}`));
        continue;
      }
      const launch = input.registry.launch.blockNumber;
      if (launch === null || a.blockNumber < launch) {
        candidates.push(chainCandidate(a, "before_launch", launch === null ? "no launch block is configured" : `launch block ${launch}`));
        continue;
      }
      const firstT = isoToSeconds(first.time)!;
      if (a.blockTimestamp >= firstT + ATTRIBUTION_WINDOW_SECONDS) {
        candidates.push(chainCandidate(a, "late", `window ended ${isoOf(firstT + ATTRIBUTION_WINDOW_SECONDS)}`));
        continue;
      }
      const state = codeStateAt(record, a.blockTimestamp);
      if (state !== "active") {
        candidates.push(chainCandidate(a, "code_inactive", `code was ${state} at block time`));
        continue;
      }
      binding = { code: record.code, beneficiary: record.beneficiary, display: record.display, source: "chain", correctionKind: null, correctionId: null, event: { transactionHash: a.transactionHash, logIndex: a.keyLogIndex }, effectiveAt: isoOf(a.blockTimestamp) };
      uncertainAtBinding = uncertain || first.tentative;
      candidates.push(chainCandidate(a, "bound"));
      continue;
    }
    if (item.k === "correction") {
      const c = item.c;
      const cand = (reason: CandidateReason, detail: string | null): Candidate => ({ source: "correction", id: c.id, transactionHash: c.deposit.transactionHash, logIndex: c.deposit.logIndex, blockNumber: null, time: c.recordedAt, via: null, code: c.code, reason, detail: detail ? `${c.kind}: ${detail}` : c.kind });
      const problems = input.correctionProblems.get(c.id) ?? [];
      if (problems.length) {
        candidates.push(cand("correction_rejected", problems.join("; ")));
        continue;
      }
      if (binding) {
        candidates.push(cand("correction_rejected", `wallet already bound to ${binding.code}; a correction never takes a wallet from another code`));
        continue;
      }
      const named = input.authorizations.find(
        (a) => a.transactionHash === c.deposit.transactionHash && (a.keyLogIndex === c.deposit.logIndex || a.legs.some((l) => l.logIndex === c.deposit.logIndex)),
      );
      if (!named) {
        if (globalUnknown || uncertain) {
          uncertain = true;
          candidates.push(cand("evidence_unavailable", "the named deposit is not in the scanned evidence, which is incomplete"));
        } else candidates.push(cand("correction_rejected", "names no deposit in the scanned evidence"));
        continue;
      }
      if (named.status !== "proven") {
        uncertain = true;
        candidates.push(cand("evidence_unavailable", `the named deposit's evidence is unknown: ${named.problems.join("; ")}`));
        continue;
      }
      if (named.receiver !== wallet) {
        candidates.push(cand("correction_rejected", "names a deposit to another wallet"));
        continue;
      }
      if (named.payer !== wallet) {
        candidates.push(cand("correction_rejected", "names a gift; a gift cannot be corrected"));
        continue;
      }
      if (BigInt(named.assets) <= 0n) {
        candidates.push(cand("correction_rejected", "names a zero-asset deposit"));
        continue;
      }
      if (named.blockTimestamp > item.t || named.blockNumber > input.cutoff.number) {
        candidates.push(cand("correction_rejected", "names a deposit later than the correction"));
        continue;
      }
      const record = findCode(input.registry, c.code)!;
      binding = { code: record.code, beneficiary: record.beneficiary, display: record.display, source: "correction", correctionKind: c.kind, correctionId: c.id, event: null, effectiveAt: c.recordedAt };
      uncertainAtBinding = uncertain;
      candidates.push(cand("bound", null));
      continue;
    }
    // revocation
    const r = item.r;
    if (binding?.correctionId === item.target.id) {
      binding = null;
      uncertainAtBinding = false;
    }
    candidates.push({ source: "correction", id: item.target.id, transactionHash: item.target.deposit.transactionHash, logIndex: item.target.deposit.logIndex, blockNumber: null, time: r.recordedAt, via: null, code: item.target.code, reason: "correction_revoked", detail: `revoked by ${r.id} (${r.recordedBy}): ${r.reason}` });
  }

  let bindingStatus: AttributionRow["bindingStatus"];
  if (binding) bindingStatus = uncertainAtBinding || globalUnknown ? "provisional" : "final";
  else bindingStatus = uncertain || globalUnknown ? "unknown" : "unbound";
  const windowEndsAt = first ? isoOf(isoToSeconds(first.time)! + ATTRIBUTION_WINDOW_SECONDS) : null;
  return { wallet, bindingStatus, binding, firstQualifyingDeposit: first, windowEndsAt, candidates };
}
