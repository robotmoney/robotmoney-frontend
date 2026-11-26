// @ts-check
// When a request to the one vault settles, and when its shares arrive (RM-146,
// RM-205). Pure functions over epoch milliseconds, shared by the deposit page
// and the skill.
//
// The queue (FlowQueue, contracts 0.9.0) groups requests into epochs of
// `epochLength` seconds: a request belongs to the epoch it was made in. It can
// be cancelled until `cancelBuffer` before that epoch closes; then it locks.
// The epoch's batch can run once it has closed and a `settleWindow` has passed
// (the window the price is taken over, so nobody can see the price when they
// request). Deposit shares are then held for `minHold`. A deposit still
// unfilled after `maxRoll` epochs expires; a redemption can be given notice.
//
// On Deploy 4 (hourly epochs, 12 minute window, 1 hour hold) that puts a
// deposit's shares 1 h 12 min to 2 h 12 min after the request, plus however
// long the keeper takes to settle. The live quote (`quoteDeposit`) gives the
// exact `earliestSettle` and `holdEnds`; these functions stand in where no
// chain read is available.

import { DEFAULT_FLOW } from "./manifest.js";
import { fmtWhen, fmtWhenShort } from "./format.js";

const S = 1000;

/**
 * Epochs are numbered from an anchor (FlowEpochs, 0.9.0): epoch `anchorIndex - 1`
 * ends at `anchorTime` (seconds) and each later epoch `epochLength` after it.
 * chain.js reads the anchor from the queue; the simulator leaves it at 0, which
 * numbers epochs from 1970. Epochs from before an `epochLength` change ended at
 * stored times, so a request's own times come from the chain (requestLockAt,
 * requestExpiresAt), not from this arithmetic.
 * @typedef {{ epochLength: number, settleWindow: number, minHold: number, maxRoll: number, cancelBuffer?: number, anchorIndex?: number, anchorTime?: number }} Flow
 */

/** When epoch `e` ends. @param {number} e @param {Flow} [f] */
export function epochEndAt(e, f = DEFAULT_FLOW) {
  return ((f.anchorTime ?? 0) + (e + 1 - (f.anchorIndex ?? 0)) * f.epochLength) * S;
}

/** The epoch a request made at `now` belongs to. @param {number} now @param {Flow} [f] */
export function epochOf(now, f = DEFAULT_FLOW) {
  return (f.anchorIndex ?? 0) + Math.floor((now / S - (f.anchorTime ?? 0)) / f.epochLength);
}

/** The earliest time epoch `e` can settle. @param {number} e @param {Flow} [f] */
export function settleableAt(e, f = DEFAULT_FLOW) {
  return epochEndAt(e, f) + f.settleWindow * S;
}

/**
 * When a request of epoch `e` locks: `cancelBuffer` before the epoch closes
 * (FlowClaimLib.cancel, "endOf(epoch) - cancelBuffer"). After this it waits
 * for the batch and cannot be cancelled, unless a stop keeps deposits out.
 * @param {number} e @param {Flow} [f]
 */
export function lockAtOf(e, f = DEFAULT_FLOW) {
  return epochEndAt(e, f) - (f.cancelBuffer ?? DEFAULT_FLOW.cancelBuffer) * S;
}

/**
 * When a request of epoch `e` expires: the end of epoch `e + maxRoll`
 * (FlowQueue._setFlowParams, "expires at (e + maxRoll + 1) × L"). Its last
 * chance to fill is the batch of epoch `e + maxRoll - 1`. After this time an
 * unfilled deposit is withdrawn (withdrawExpired); a redemption does not expire,
 * and from this time its owner can give notice (giveRedemptionNotice).
 * @param {number} e @param {Flow} [f]
 */
export function expiresAtOf(e, f = DEFAULT_FLOW) {
  return epochEndAt(e + f.maxRoll, f);
}

/** When a request locks: its own epoch's end as the chain stored it (`endAt`), else computed. @param {any} r @param {Flow} [f] */
export function requestLockAt(r, f = DEFAULT_FLOW) {
  return r.endAt != null ? r.endAt - (f.cancelBuffer ?? DEFAULT_FLOW.cancelBuffer) * S : lockAtOf(r.epoch, f);
}

/** When a deposit expires, or a redemption can be given notice: the end of its `expiryEpoch` as read from the chain, else computed. @param {any} r @param {Flow} [f] */
export function requestExpiresAt(r, f = DEFAULT_FLOW) {
  return r.expiresAt != null ? r.expiresAt : expiresAtOf(r.epoch, f);
}

/**
 * The timeline of a request made at `now`, if the first possible batch fills
 * it whole.
 * @param {number} now
 * @param {Flow} [f]
 */
export function timelineFor(now, f = DEFAULT_FLOW) {
  const e = epochOf(now, f);
  const settlesAt = settleableAt(e, f);
  return {
    epoch: e,
    lockAt: lockAtOf(e, f),
    settlesAt,
    sharesAt: settlesAt + f.minHold * S,
    expiresAt: expiresAtOf(e, f),
  };
}

/** The shortest and longest wait, in seconds, from request to shares. @param {Flow} [f] */
export function depositWait(f = DEFAULT_FLOW) {
  return { min: f.settleWindow + f.minHold, max: f.epochLength + f.settleWindow + f.minHold };
}

/** The same for a redemption's USDC. @param {Flow} [f] */
export function redeemWait(f = DEFAULT_FLOW) {
  return { min: f.settleWindow, max: f.epochLength + f.settleWindow };
}

/**
 * "1 h 12 min", "12 min", "8 h", "1 day": a duration in seconds, in words.
 * @param {number} seconds
 */
export function fmtDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h >= 24 && rest === 0 && h % 24 === 0) return h === 24 ? "1 day" : `${h / 24} days`;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "2 days ago", "35 min ago", "just now". @param {number} ms */
export function fmtAgo(ms) {
  if (ms < 60 * S) return "just now";
  return `${fmtDuration(ms >= 2 * 86400 * S ? Math.floor(ms / (86400 * S)) * 86400 : ms / S)} ago`;
}

/**
 * A time with how far off it is, so nobody does the arithmetic (David, 23 Nov):
 * "14:45 · in 35 min" today, "Sat 00:12 · 2 days ago" within a week, the full
 * date beyond. @param {number|null|undefined} ms @param {number} now
 */
export function fmtWhenIn(ms, now) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${fmtAt(ms, now)} · ${ms >= now ? fmtCountdown(ms - now) : fmtAgo(now - ms)}`;
}

/** The same inside a sentence: "16:24, in 24 min". @param {number|null|undefined} ms @param {number} now */
export function fmtSay(ms, now) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${fmtAt(ms, now)}, ${ms >= now ? fmtCountdown(ms - now) : fmtAgo(now - ms)}`;
}

/** The time alone when it is today ("15:12"), the weekday within a week ("Sat 00:12"), else the date. @param {number} ms @param {number} now */
export function fmtAt(ms, now) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (new Date(ms).toDateString() === new Date(now).toDateString()) return fmtWhenShort(ms).split(" ")[1];
  return Math.abs(ms - now) < 6 * 86400 * S ? fmtWhenShort(ms) : fmtWhen(ms);
}

/** A ticking countdown: "54:12", "1:02:15", "0:00" once it is due. @param {number} ms */
export function fmtClock(ms) {
  const t = Math.max(0, Math.floor(ms / S));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** "in 5 h 25 min", "in under a minute", "now". @param {number} ms */
export function fmtCountdown(ms) {
  if (ms <= 0) return "now";
  if (ms < 60 * S) return "in under a minute";
  return `in ${fmtDuration(ms / S)}`;
}
