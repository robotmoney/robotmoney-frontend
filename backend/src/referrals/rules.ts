// The referral credit rules (Linear RM-174): which deposit binds which wallet to
// which member's code.
//
// WHY A PURE FUNCTION. There is no referral table. The report script reads the
// deposits from the chain, hands them here with the config, and gets the credit
// list back. The same deposits and the same config always give the same answer,
// so anyone can rerun the report and check it, and "why didn't I get credit?"
// has a reason attached to every coded deposit.
//
// THE RULES, applied to each coded deposit in chain order (block, then log):
//
//   1. More than 1 distinct referral code in the transaction: `review`. A bundle
//      can carry 2 depositors' codes, and we do not guess which is whose.
//   2. A code we don't know: `unknown_code`. A code that was not switched on at
//      the deposit's block time, or a deposit before launch: `inactive_code`.
//   3. The wallet that receives the shares did not pay the USDC: `review`. This
//      is the rule that stops a member from claiming someone else's wallet with
//      a 1 USDC deposit made on their behalf.
//   4. The wallet is already bound: `duplicate`. The first valid code wins. Other
//      vault legs of the very transaction that bound it count as `bound` too.
//   5. More than 30 days after the wallet's first deposit (or after launch, for a
//      wallet that deposited before it): `late`.
//   6. Otherwise `bound`: the wallet is credited to that code from this deposit on.
//
// Manual credits from config apply after the chain rules, and only to wallets
// the chain did not bind. Uncoded deposits never produce a row; they only set a
// wallet's first deposit, which starts its 30-day window.
import {
  findReferralCode,
  referralCodeState,
  toSeconds,
  type ReferralCodeEntry,
  type ReferralManualCredit,
} from "./codes.ts";

/** How long after its first deposit a wallet can still add a code. */
export const REFERRAL_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** One ERC-4626 Deposit event, with what the report read from its transaction. */
export type DepositObservation = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Block timestamp, unix seconds. */
  blockTime: number;
  /** The Deposit event's `owner`: the wallet that receives the shares. */
  wallet: string;
  vault: string;
  /** Assets deposited, in the vault asset's raw units, as a decimal string. */
  assets: string;
  /** The `from` of the USDC transfer into the router or the vault; null if the receipt had none. */
  payer: string | null;
  /** findReferralCodes() over the transaction input; empty for an uncoded deposit. */
  codes: string[];
};

export type ReferralAttributionStatus =
  | "bound"
  | "duplicate"
  | "late"
  | "review"
  | "unknown_code"
  | "inactive_code";

/** The outcome for one coded deposit. */
export type ReferralAttribution = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: number;
  wallet: string;
  vault: string;
  assets: string;
  /** The single code the deposit carried; null when it carried several. */
  code: string | null;
  codes: string[];
  status: ReferralAttributionStatus;
  reason: string;
  memberId: string | null;
  channel: string | null;
};

/** A wallet credited to a code. */
export type ReferralBinding = {
  wallet: string;
  code: string;
  memberId: string | null;
  channel: string | null;
  source: "calldata" | "manual";
  txHash: string;
  /** Null for a manual credit. */
  logIndex: number | null;
  /** Null for a manual credit. */
  blockNumber: number | null;
  /** When credit starts, unix seconds. */
  boundAt: number;
};

export type SkippedManualCredit = { wallet: string; code: string; reason: string };

export type ReferralAttributionInput = {
  /** Every deposit the report read, coded or not. */
  deposits: readonly DepositObservation[];
  codes: readonly ReferralCodeEntry[];
  manualCredits: readonly ReferralManualCredit[];
  /** Launch time, unix seconds: codes count from here, and pre-launch wallets' windows start here. */
  launchTime: number;
};

export type ReferralAttributionResult = {
  bindings: ReferralBinding[];
  attributions: ReferralAttribution[];
  skippedManualCredits: SkippedManualCredit[];
};

export function attributeReferrals(input: ReferralAttributionInput): ReferralAttributionResult {
  const deposits = input.deposits
    .map((d) => ({ ...d, wallet: d.wallet.toLowerCase(), payer: d.payer?.toLowerCase() ?? null }))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  const firstDepositAt = new Map<string, number>();
  for (const d of deposits) {
    const seen = firstDepositAt.get(d.wallet);
    if (seen === undefined || d.blockTime < seen) firstDepositAt.set(d.wallet, d.blockTime);
  }

  const bindings = new Map<string, ReferralBinding>();
  const attributions: ReferralAttribution[] = [];

  for (const d of deposits) {
    if (d.codes.length === 0) continue;
    const row = (
      status: ReferralAttributionStatus,
      reason: string,
      entry?: ReferralCodeEntry,
    ): ReferralAttribution => ({
      txHash: d.txHash,
      logIndex: d.logIndex,
      blockNumber: d.blockNumber,
      blockTime: d.blockTime,
      wallet: d.wallet,
      vault: d.vault,
      assets: d.assets,
      code: d.codes.length === 1 ? d.codes[0]! : null,
      codes: d.codes,
      status,
      reason,
      memberId: entry?.memberId ?? null,
      channel: entry?.channel ?? null,
    });

    if (d.codes.length > 1) {
      attributions.push(row("review", `the transaction carries ${d.codes.length} referral codes`));
      continue;
    }
    const entry = findReferralCode(input.codes, d.codes[0]!);
    if (!entry) {
      attributions.push(row("unknown_code", `no referral code ${d.codes[0]} exists`));
      continue;
    }
    if (d.blockTime < input.launchTime) {
      attributions.push(row("inactive_code", "the deposit came before referrals launched", entry));
      continue;
    }
    if (referralCodeState(entry, d.blockTime) === "off") {
      attributions.push(row("inactive_code", `${entry.code} was not switched on at the deposit's time`, entry));
      continue;
    }
    if (d.payer === null) {
      attributions.push(row("review", "no USDC transfer into the router or the vault was found", entry));
      continue;
    }
    if (d.payer !== d.wallet) {
      attributions.push(row("review", `paid by ${d.payer}, but the shares went to ${d.wallet}`, entry));
      continue;
    }
    const existing = bindings.get(d.wallet);
    if (existing) {
      if (existing.source === "calldata" && existing.txHash === d.txHash) {
        attributions.push(row("bound", "another vault leg of the deposit that bound this wallet", entry));
      } else {
        attributions.push(
          row("duplicate", `the wallet was already credited to ${existing.code} at block ${existing.blockNumber}`, entry),
        );
      }
      continue;
    }
    const windowStart = Math.max(firstDepositAt.get(d.wallet)!, input.launchTime);
    if (d.blockTime > windowStart + REFERRAL_WINDOW_SECONDS) {
      attributions.push(row("late", "the code came more than 30 days after the wallet's first deposit", entry));
      continue;
    }
    bindings.set(d.wallet, {
      wallet: d.wallet,
      code: entry.code,
      memberId: entry.memberId,
      channel: entry.channel,
      source: "calldata",
      txHash: d.txHash,
      logIndex: d.logIndex,
      blockNumber: d.blockNumber,
      boundAt: d.blockTime,
    });
    attributions.push(row("bound", `credited to ${entry.code}`, entry));
  }

  const skippedManualCredits: SkippedManualCredit[] = [];
  const credits = [...input.manualCredits].sort(
    (a, b) => (toSeconds(a.addedAt) ?? 0) - (toSeconds(b.addedAt) ?? 0),
  );
  for (const credit of credits) {
    const wallet = credit.wallet.toLowerCase();
    const entry = findReferralCode(input.codes, credit.code);
    const addedAt = toSeconds(credit.addedAt);
    if (!entry || addedAt === null) {
      skippedManualCredits.push({ wallet, code: credit.code, reason: "the credit is not valid config" });
      continue;
    }
    const existing = bindings.get(wallet);
    if (existing) {
      skippedManualCredits.push({ wallet, code: entry.code, reason: `the wallet is already credited to ${existing.code}` });
      continue;
    }
    bindings.set(wallet, {
      wallet,
      code: entry.code,
      memberId: entry.memberId,
      channel: entry.channel,
      source: "manual",
      txHash: credit.txHash,
      logIndex: null,
      blockNumber: null,
      boundAt: addedAt,
    });
  }

  return { bindings: [...bindings.values()], attributions, skippedManualCredits };
}
