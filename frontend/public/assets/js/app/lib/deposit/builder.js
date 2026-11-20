// @ts-check
// The transaction builder (PRD "One core, three surfaces"; RM-205): from an
// intent (deposit 250 USDC for this owner) to the calls a wallet signs, each
// with a plain label. Pure: no wallet, no network, no viem. The page hands the
// calls to its wallet (batched into one confirmation where the wallet can,
// wallet.js); the skill hands the same calls to its agent's wallet; the
// prepare endpoint will return them encoded.
//
// Against the queue and fund of contracts 0.9.0 (abi.js). Units: USDC 6
// decimals, fund shares 24 decimals, prices in PRICE_SCALE (1e36) as USDC units
// per share unit, so 1 USDC a share is 1e18.

import { MANIFEST } from "./manifest.js";
import { QUEUE_ABI, FUND_ABI, ERC20_ABI } from "./abi.js";

export const SHARE_DECIMALS = 24;
/** A price of 1 USDC a share is 1e18 in PRICE_SCALE units. */
const PRICE_DECIMALS = 18;

/**
 * A decimal amount as integer base units, exactly: "250.5" with 6 decimals is
 * 250500000n. Accepts a number or a decimal string.
 * @param {number | string} amount
 * @param {number} decimals
 */
export function toUnits(amount, decimals) {
  const s = typeof amount === "number" ? amount.toFixed(Math.min(decimals, 12)) : String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not an amount: ${amount}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole + frac.slice(0, decimals).padEnd(decimals, "0"));
}

/** Base units back to a number, for display. @param {bigint} v @param {number} decimals */
export function fromUnits(v, decimals) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const d = 10n ** BigInt(decimals);
  const n = Number(a / d) + Number(a % d) / Number(d);
  return neg ? -n : n;
}

/** USDC a share (a number) to PRICE_SCALE units. @param {number} p */
export const priceToScaled = (p) => toUnits(p, PRICE_DECIMALS);
/** PRICE_SCALE units to USDC a share. @param {bigint} v */
export const scaledToPrice = (v) => fromUnits(v, PRICE_DECIMALS);

/** @typedef {{ label: string, to: `0x${string}` | null, abi: any[], functionName: string, args: any[] }} Call */

const fmt = (n, max = 2) => n.toLocaleString("en-US", { maximumFractionDigits: max });

/**
 * Approve the queue for exactly `usdc` (skipped when the allowance already
 * covers it, PRD F6), then request the deposit for `owner`. No price: on 0.9.0
 * the batch sets it (D17).
 * @param {{ usdc: number, owner: `0x${string}`, allowance?: bigint }} p
 * @returns {Call[]}
 */
export function buildDeposit({ usdc, owner, allowance = 0n }, m = MANIFEST) {
  const assets = toUnits(usdc, m.usdcDecimals);
  const calls = [];
  if (allowance < assets) {
    calls.push({ label: `Approve exactly ${fmt(usdc)} USDC`, to: m.usdc, abi: ERC20_ABI, functionName: "approve", args: [m.queue, assets] });
  }
  calls.push({ label: "Request the deposit", to: m.queue, abi: QUEUE_ABI, functionName: "requestDeposit", args: [assets, owner] });
  return calls;
}

/**
 * Approve the queue for exactly `shares` (skipped when covered), then request
 * the redemption. The batch sets the price; the exit fee is fixed on the request.
 * @param {{ shares: number, owner: `0x${string}`, allowance?: bigint }} p
 * @returns {Call[]}
 */
export function buildRedeem({ shares, owner, allowance = 0n }, m = MANIFEST) {
  const amount = toUnits(shares, SHARE_DECIMALS);
  const calls = [];
  if (allowance < amount) {
    calls.push({ label: `Approve exactly ${fmt(shares, 4)} shares`, to: m.fund, abi: FUND_ABI, functionName: "approve", args: [m.queue, amount] });
  }
  calls.push({ label: "Request the redemption", to: m.queue, abi: QUEUE_ABI, functionName: "requestRedeem", args: [amount, owner] });
  return calls;
}

/** Cancel the unfilled part; it becomes a credit (buildWithdrawCredit). @param {string|number|bigint} requestId @returns {Call[]} */
export const buildCancel = (requestId, m = MANIFEST) => [
  { label: "Cancel what has not filled", to: m.queue, abi: QUEUE_ABI, functionName: "cancel", args: [BigInt(requestId)] },
];

/** Take every USDC and share credit back to the wallet. @returns {Call[]} */
export const buildWithdrawCredit = (m = MANIFEST) => [
  { label: "Withdraw to your wallet", to: m.queue, abi: QUEUE_ABI, functionName: "withdrawCredit", args: [] },
];

/** Take back the USDC of an expired deposit (redemptions never expire). @param {string|number|bigint} requestId @returns {Call[]} */
export const buildWithdrawExpired = (requestId, m = MANIFEST) => [
  { label: "Withdraw what did not fill", to: m.queue, abi: QUEUE_ABI, functionName: "withdrawExpired", args: [BigInt(requestId)] },
];

/**
 * Deliver unlocked deposit shares to `owner`, up to `usdcCost` of their cost.
 * Anyone may send it; the shares only ever go to the owner.
 * @param {number | bigint} usdcCost a number, or exact base units @param {`0x${string}`} owner @returns {Call[]}
 */
export const buildClaimShares = (usdcCost, owner, m = MANIFEST) => [
  { label: "Claim your shares", to: m.queue, abi: QUEUE_ABI, functionName: "deposit", args: [typeof usdcCost === "bigint" ? usdcCost : toUnits(usdcCost, m.usdcDecimals), owner] },
];

/** Take settled redemption USDC for `shares` burned shares. @param {number | bigint} shares @param {`0x${string}`} owner @returns {Call[]} */
export const buildClaimUsdc = (shares, owner, m = MANIFEST) => [
  { label: "Claim your USDC", to: m.queue, abi: QUEUE_ABI, functionName: "redeem", args: [typeof shares === "bigint" ? shares : toUnits(shares, SHARE_DECIMALS), owner, owner] },
];

/**
 * Give notice on a redemption no batch has filled within the roll limit: it
 * takes part in one more batch, then the unfilled shares come back
 * (buildTakeBackNotice). @param {string|number|bigint} requestId @returns {Call[]}
 */
export const buildGiveNotice = (requestId, m = MANIFEST) => [
  { label: "Ask for the unfilled shares back", to: m.queue, abi: QUEUE_ABI, functionName: "giveRedemptionNotice", args: [BigInt(requestId)] },
];

/** After the notice batch: the unfilled shares to credit, then to the wallet. @param {string|number|bigint} requestId @returns {Call[]} */
export const buildTakeBackNotice = (requestId, m = MANIFEST) => [
  { label: "Take back the unfilled shares", to: m.queue, abi: QUEUE_ABI, functionName: "claimNoticeReturn", args: [BigInt(requestId)] },
  ...buildWithdrawCredit(m),
];

/** In a wind-down: every queued request of `owner` released, then to the wallet. @param {`0x${string}`} owner @returns {Call[]} */
export const buildReleaseWindDown = (owner, m = MANIFEST) => [
  { label: "Release your queued requests", to: m.queue, abi: QUEUE_ABI, functionName: "releaseWindDown", args: [owner] },
  ...buildWithdrawCredit(m),
];

/**
 * Exit in kind, straight from the fund: only once the fund is winding down
 * (D18). One transaction, no queue, no price.
 * @param {number} shares @param {`0x${string}`} owner @returns {Call[]}
 */
export const buildExitInKind = (shares, owner, m = MANIFEST) => [
  { label: `Exit ${fmt(shares, 4)} shares in kind`, to: m.fund, abi: FUND_ABI, functionName: "redeemInKind", args: [toUnits(shares, SHARE_DECIMALS), owner, owner] },
];
