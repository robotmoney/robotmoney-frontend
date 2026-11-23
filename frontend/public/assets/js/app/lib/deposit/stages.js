// @ts-check
// One vocabulary for where a request stands (PRD "Managing expectations";
// design canvas board 12): the page, the status page, the skill and the MCP
// server use these words and nothing else. Derived from a request record and
// the time, never stored, so the chain reads, the indexer and the simulator
// all agree.
//
// A request record (chain.js and sim-queue.js both produce it):
//   { id, kind: "deposit" | "redeem", owner, amount, remaining, epoch,
//     createdAt, closed, expired, cancelled, cancelledAt, exitFeeBps,
//     noticeAt, noticeDone, released,
//     fills: [{ claimId, amountIn, out, price, matchedIn, at, unlockAt, claimed }] }
// `amount`, `remaining` and a fill's `amountIn` are USDC for a deposit and
// shares for a redemption; a fill's `out` is the other side, and `matchedIn`
// the part of `amountIn` the batch matched with the other side (0.9.0, D16).
// `noticeAt` is the batch a redemption's notice runs in; `noticeDone` is set
// once that batch has run and the unfilled shares are free to take back.
// Times are ms.
//
// Contracts 0.9.0: a request can be cancelled only until it locks
// (`cancelBuffer` before its epoch closes), or while a stop keeps deposits out;
// a deposit unfilled after `maxRoll` epochs expires; a redemption never
// expires, but can be given notice then.

import { DEFAULT_FLOW } from "./manifest.js";
import { settleableAt, requestLockAt, requestExpiresAt, fmtDuration } from "./schedule.js";

export const STAGE = Object.freeze({
  // Four words for the path a request takes (David, 23 Nov 2026): Pending until
  // a batch has filled all of it (a part-filled request is still pending: its
  // rest joins the next batch), Filled while the hold runs, Ready to claim, Claimed.
  PENDING: "Pending",
  ON_HOLD: "Filled",
  READY: "Ready to claim",
  CLAIMED: "Claimed",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  NOTICE: "Notice given",
  TAKE_BACK: "Ready to take back",
  RETURNED: "Returned",
  RELEASED: "Released",
});

/** Stages that still have a time ahead of them. */
export const IN_FLIGHT = Object.freeze([STAGE.PENDING, STAGE.ON_HOLD, STAGE.NOTICE]);

const EPS = 1e-9;
/** @param {any} r */
export const filledOf = (r) => r.fills.reduce((s, f) => s + f.amountIn, 0);
/** @param {any} r */
export const outOf = (r) => r.fills.reduce((s, f) => s + f.out, 0);
/** @param {any} r */
export const matchedOf = (r) => r.fills.reduce((s, f) => s + (f.matchedIn || 0), 0);
/** Unfilled and still able to fill. @param {any} r */
export const liveRemaining = (r) => (!r.closed && !r.expired && !r.cancelled && !r.released && !r.noticeDone ? Math.max(0, r.remaining) : 0);

/**
 * The next batch a pending request of epoch `epoch` can join, at or after `now`.
 * @param {number} epoch @param {number} now @param {typeof DEFAULT_FLOW} [f]
 */
export function nextBatchFor(epoch, now, f = DEFAULT_FLOW) {
  // The first epoch whose batch is still ahead: settleableAt(k) >= now.
  const first = (f.anchorIndex ?? 0) - 1 + Math.ceil(((now - f.settleWindow * 1000) / 1000 - (f.anchorTime ?? 0)) / f.epochLength);
  return settleableAt(Math.max(epoch, first), f);
}

/**
 * Where a request stands at `now`, the time that matters next, and one line.
 * @param {any} r @param {number} now @param {typeof DEFAULT_FLOW} [f]
 * @returns {{ stage: string, at: number | null, note: string }}
 */
export function stageOf(r, now, f = DEFAULT_FLOW) {
  const dep = r.kind === "deposit";
  const live = liveRemaining(r) > EPS;
  const filled = r.fills.length > 0;
  if (r.released && !r.closed && r.remaining > EPS) return { stage: STAGE.RELEASED, at: null, note: "The vault is winding down, so this request was released. Withdraw it under Your position." };
  if (r.noticeAt && live) return { stage: STAGE.NOTICE, at: r.noticeAt, note: "It takes part in one more batch. Any shares still unfilled then come back." };
  if (r.noticeDone && !r.closed && r.remaining > EPS) return { stage: STAGE.TAKE_BACK, at: null, note: "No batch filled the rest. The unfilled shares are ready to take back." };
  if (!filled) {
    if (r.cancelled) return { stage: STAGE.CANCELLED, at: null, note: "Cancelled before it locked for a batch." };
    if (r.expired) return { stage: STAGE.EXPIRED, at: null, note: `No batch filled it within ${fmtDuration(f.maxRoll * f.epochLength)}.` };
    if (r.noticeDone || r.released) return { stage: STAGE.RETURNED, at: null, note: "No batch filled it, and the shares came back." };
    return { stage: STAGE.PENDING, at: nextBatchFor(r.epoch, now, f), note: "Joins the next batch, at the price that batch sets." };
  }
  if (live) return { stage: STAGE.PENDING, at: nextBatchFor(r.epoch, now, f), note: "Part has filled. The rest joins the next batch." };
  const held = r.fills.filter((x) => dep && !x.claimed && x.unlockAt > now);
  if (held.length) return { stage: STAGE.ON_HOLD, at: Math.max(...held.map((x) => x.unlockAt)), note: "Filled. It is yours to claim once its hold ends." };
  if (r.fills.some((x) => !x.claimed)) return { stage: STAGE.READY, at: null, note: dep ? "Your shares are ready." : "Your USDC is ready." };
  return { stage: STAGE.CLAIMED, at: null, note: dep ? "The shares are in your wallet." : "The USDC is in your wallet." };
}

/**
 * Whether the unfilled part can be cancelled at `now`: until it locks, or for
 * a deposit while a stop keeps deposits out of every batch (§5.11.3 item 8).
 * @param {any} r @param {number} now @param {typeof DEFAULT_FLOW} [f] @param {{ depositsStopped?: boolean }} [ctx]
 */
export const canCancel = (r, now, f = DEFAULT_FLOW, ctx = {}) =>
  liveRemaining(r) > EPS && !r.noticeAt && (now < requestLockAt(r, f) || (r.kind === "deposit" && !!ctx.depositsStopped));
/** When an open request locks, or null once it has. @param {any} r @param {number} now @param {typeof DEFAULT_FLOW} [f] */
export const lockOf = (r, now, f = DEFAULT_FLOW) => (liveRemaining(r) > EPS && now < requestLockAt(r, f) ? requestLockAt(r, f) : null);
/** Whether an expired deposit's USDC is waiting to be withdrawn. @param {any} r */
export const canWithdrawExpired = (r) => r.kind === "deposit" && !!r.expired && !r.closed && r.remaining > EPS;
/** Whether a redemption is old enough to give notice (D25). @param {any} r @param {number} now @param {typeof DEFAULT_FLOW} [f] */
export const canGiveNotice = (r, now, f = DEFAULT_FLOW) => r.kind === "redeem" && liveRemaining(r) > EPS && !r.noticeAt && now >= requestExpiresAt(r, f);
/** Whether a noticed redemption's unfilled shares can be taken back. @param {any} r */
export const canTakeBack = (r) => !!r.noticeDone && !r.closed && r.remaining > EPS;
/** Fills whose shares or USDC can be taken at `now`. @param {any} r @param {number} now */
export const claimableFills = (r, now) => r.fills.filter((x) => !x.claimed && x.unlockAt <= now);
