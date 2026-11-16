// @ts-check
// A request in words (RM-146): the row on Your requests and the facts and
// timeline on its status page, from one record (stages.js has the shape) and
// the time. Both pages read these, so a request never says one thing in the
// table and another on its own page.

import { stageOf, filledOf, outOf, liveRemaining, canCancel, canWithdrawExpired, canGiveNotice, canTakeBack, claimableFills, lockOf, nextBatchFor, STAGE, IN_FLIGHT } from "./stages.js";
import { expiresAtOf, lockAtOf, fmtCountdown, fmtDuration } from "./schedule.js";
import { fmtUsdc, fmtShares, fmtWhen, fmtWhenShort } from "./format.js";

const EPS = 1e-9;

/** "250 USDC" for a deposit, "100.0000 shares" for a redemption. @param {any} r @param {number} n */
export const inUnit = (r, n) => (r.kind === "deposit" ? fmtUsdc(n) : `${fmtShares(n)} shares`);
/** The other side: shares for a deposit, USDC for a redemption. @param {any} r @param {number} n */
export const outUnit = (r, n) => (r.kind === "deposit" ? `${fmtShares(n)} shares` : fmtUsdc(n));
/** "Deposit" or "Redemption". @param {any} r */
export const kindLabel = (r) => (r.kind === "deposit" ? "Deposit" : "Redemption");

/** The cancelled part of a request: what was asked for less what filled, once closed by a cancel. @param {any} r */
export const cancelledOf = (r) => (r.cancelled ? Math.max(0, r.amount - filledOf(r)) : 0);

/**
 * How one batch filled a request: matched with the other side at the vault's
 * price, and the rest traded in the market (0.9.0, D16). "" when the split is
 * not known (a chain read before the indexer) or there is nothing to split.
 * @param {any} r @param {any} x a fill
 */
export function splitOf(r, x) {
  if (typeof x.matchedIn !== "number") return "";
  const m = Math.min(x.matchedIn, x.amountIn);
  const other = r.kind === "deposit" ? "redemptions" : "deposits";
  const market = r.kind === "deposit" ? "bought in the market" : "sold in the market";
  if (m <= EPS) return `All of it ${market}.`;
  if (x.amountIn - m <= 1e-6) return `All of it matched with ${other} in the same batch.`;
  return `${inUnit(r, m)} matched with ${other} in the same batch, ${inUnit(r, x.amountIn - m)} ${market}.`;
}

/**
 * One row of Your requests (canvas board 6).
 * @param {any} r @param {number} now @param {any} f flow parameters @param {{ depositsStopped?: boolean }} [ctx]
 */
export function rowOf(r, now, f, ctx = {}) {
  const st = stageOf(r, now, f);
  const filled = filledOf(r);
  const out = outOf(r);
  const left = liveRemaining(r);
  const lock = lockOf(r, now, f);
  const tone = st.stage === STAGE.READY || st.stage === STAGE.TAKE_BACK ? "ready" : st.stage === STAGE.ON_HOLD ? "hold" : st.stage === STAGE.FILLING ? "filling" : st.stage === STAGE.WAITING || st.stage === STAGE.NOTICE ? "waiting" : "off";
  const notice = canGiveNotice(r, now, f);
  let sub = "";
  if (st.stage === STAGE.WAITING && lock) sub = `You can cancel until ${fmtWhenShort(lock)}`;
  else if (notice) sub = `No batch has filled ${inUnit(r, left)} in ${fmtDuration(f.maxRoll * f.epochLength)}. You can ask for the shares back.`;
  else if (st.stage === STAGE.FILLING) sub = `${inUnit(r, left)} joins the next batch`;
  else if (st.stage === STAGE.NOTICE) sub = `${inUnit(r, left)} comes back if that batch does not fill it`;
  else if (st.stage === STAGE.TAKE_BACK) sub = `${inUnit(r, r.remaining)} to take back`;
  else if (st.stage === STAGE.RELEASED) sub = `${inUnit(r, r.remaining)} to withdraw`;
  else if (st.stage === STAGE.EXPIRED && canWithdrawExpired(r)) sub = `No batch filled ${inUnit(r, r.remaining)} in time. Withdraw it to your wallet.`;
  else if (st.stage === STAGE.EXPIRED) sub = `${inUnit(r, r.amount - filled)} did not fill and was taken back.`;
  else if (r.cancelled && cancelledOf(r) > EPS) sub = `${inUnit(r, cancelledOf(r))} cancelled`;
  return {
    id: r.id,
    href: `/deposit/requests/${r.id}`,
    kind: kindLabel(r),
    created: fmtWhen(r.createdAt),
    amount: inUnit(r, r.amount),
    filled: inUnit(r, filled),
    out: out > EPS ? outUnit(r, out) : "",
    pct: r.amount > 0 ? Math.min(100, (filled / r.amount) * 100) : 0,
    stage: st.stage,
    tone,
    sub,
    next: st.at && IN_FLIGHT.includes(st.stage) ? fmtWhenShort(st.at) : "",
    nextIn: st.at && st.stage === STAGE.ON_HOLD ? fmtCountdown(st.at - now) : "",
    canCancel: canCancel(r, now, f, ctx),
    cancelAmount: inUnit(r, left),
    filledShort: filled > EPS ? inUnit(r, filled).replace(/ USDC$/, "") : "",
    canWithdrawExpired: canWithdrawExpired(r),
    canGiveNotice: notice,
    canTakeBack: canTakeBack(r),
    claimable: claimableFills(r, now).length > 0,
  };
}

/**
 * What happened, oldest first, then what is expected (canvas board 7).
 * @param {any} r @param {number} now @param {any} f
 * @returns {{ key: number, at: number, when: string, what: string, sub: string, next: boolean }[]}
 */
export function timelineOf(r, now, f) {
  const dep = r.kind === "deposit";
  const ev = [{ at: r.createdAt, what: `Requested ${inUnit(r, r.amount)}`, sub: "", next: false }];
  const lockAt = lockAtOf(r.epoch, f);
  const lockedForBatch = !(r.cancelled && (r.cancelledAt ?? 0) < lockAt) && !(r.released && !r.fills.length);
  if (lockedForBatch) ev.push({ at: lockAt, what: lockAt > now ? "Locks for the batch. Cancelling closes then." : "Locked for the batch", sub: "", next: lockAt > now });
  for (const x of r.fills) {
    ev.push({ at: x.at, what: `Batch filled ${inUnit(r, x.amountIn)} at ${x.price.toFixed(4)} USDC a share, for ${outUnit(r, x.out)}`, sub: splitOf(r, x), next: false });
    if (dep && !x.claimed && x.unlockAt > now) ev.push({ at: x.unlockAt, what: `${fmtShares(x.out)} shares arrive`, sub: "", next: true });
  }
  if (r.noticeGivenAt) ev.push({ at: r.noticeGivenAt, what: "Notice given: the unfilled shares come back after one more batch", sub: "", next: false });
  const st = stageOf(r, now, f);
  const left = liveRemaining(r);
  if (left > EPS && st.at) {
    ev.push({ at: st.at, what: `Next batch: ${inUnit(r, left)} to fill, at the price it sets`, sub: "", next: true });
    if (dep) ev.push({ at: st.at + f.minHold * 1000, what: r.fills.length ? "The rest arrive, if that batch fills them" : "Shares arrive, if that batch fills them", sub: "", next: true });
    if (dep) ev.push({ at: expiresAtOf(r.epoch, f), what: "Anything still unfilled can be taken back", sub: "", next: true });
    else if (!r.noticeAt && expiresAtOf(r.epoch, f) > now) ev.push({ at: expiresAtOf(r.epoch, f), what: "If still unfilled, you can ask for the shares back", sub: "", next: true });
  }
  if (r.cancelled && cancelledOf(r) > EPS) ev.push({ at: r.cancelledAt ?? Number.MAX_SAFE_INTEGER, what: `Cancelled ${inUnit(r, cancelledOf(r))} that had not filled`, sub: "", next: false });
  if (r.expired) ev.push({ at: expiresAtOf(r.epoch, f), what: canWithdrawExpired(r) ? `Expired with ${inUnit(r, r.remaining)} unfilled, ready to withdraw` : "Expired, and the unfilled USDC was taken back", sub: "", next: false });
  if (r.noticeDone && r.noticeAt) ev.push({ at: r.noticeAt, what: canTakeBack(r) ? `The notice batch ran. ${inUnit(r, r.remaining)} is ready to take back` : "The notice batch ran, and the unfilled shares came back", sub: "", next: false });
  if (r.released) ev.push({ at: r.returnedAt ?? Number.MAX_SAFE_INTEGER, what: r.closed ? "Released in the wind-down and withdrawn" : "Released in the wind-down, ready to withdraw", sub: "", next: false });
  return ev
    .sort((a, b) => a.at - b.at)
    .map((e, i) => ({ ...e, key: i, when: e.at === Number.MAX_SAFE_INTEGER ? "" : fmtWhen(e.at) }));
}

/** The sentence under a status page title. @param {any} r @param {number} now @param {any} f */
export function summaryOf(r, now, f) {
  const st = stageOf(r, now, f);
  const filled = filledOf(r);
  const left = liveRemaining(r);
  const lock = lockOf(r, now, f);
  if (st.stage === STAGE.FILLING) return `${inUnit(r, filled).replace(/ USDC$/, "")} of ${inUnit(r, r.amount)} has filled. The other ${inUnit(r, left)} joins the next batch.`;
  if (st.stage === STAGE.WAITING) return `Waiting for the batch at ${fmtWhen(st.at)}, which sets the price.${lock ? ` It can be cancelled until ${fmtWhenShort(lock)}.` : ""}`;
  if (st.stage === STAGE.ON_HOLD) return `Filled. ${r.kind === "deposit" ? "The shares are held until" : "Ready at"} ${fmtWhen(st.at)}.`;
  if (st.stage === STAGE.NOTICE) return `Notice given. Shares still unfilled after the batch at ${fmtWhen(st.at)} come back.`;
  return st.note;
}

/**
 * What stops the vault right now, in words, from its liveness (0.9.0,
 * `liveness()`): the cause, when it ends when the chain says, and what still
 * works. Null when nothing does. Every surface shows the same sentence.
 * @param {any} v the vault, as chain.js and sim-queue.js return it
 * @returns {{ title: string, body: string } | null}
 */
export function stopOf(v) {
  if (!v) return null;
  if (v.windDown) return { title: "The vault is winding down", body: "Deposits and batches have stopped. Queued requests are released: withdraw them under Your requests. Holders can exit in kind, taking their slice of each holding." };
  if (v.queuePaused) return { title: "The queue is paused", body: `Nothing settles, and no new request can be made${v.queuePausedUntil ? ` until ${fmtWhen(v.queuePausedUntil)}` : ""}. Requests already in the queue wait for the first batch after.` };
  if (v.depositsStopped) return { title: "Deposits are stopped", body: `${v.stopCause === "paused" ? `The vault paused deposits${v.depositsPausedUntil ? ` until ${fmtWhen(v.depositsPausedUntil)}` : ""}.` : "A holding cannot be priced or paid out safely right now, so no deposit can join a batch."} Deposits already in the queue wait, and can be cancelled while this lasts. Redemptions still work.` };
  if (v.keeperSet === false) return { title: "No batch can run yet", body: "The vault has no keeper to run its batches. Requests wait until one is set." };
  if (v.settleBlocked) return { title: "Batches are on hold", body: `${v.settleBlocked} Requests wait in the queue and join the first batch that can run.` };
  return null;
}

/** For a next batch label: "Sat 01:00 · in 5 h 25 min". @param {number} at @param {number} now */
export const nextBatchLabel = (at, now) => `${fmtWhenShort(at)} · ${fmtCountdown(at - now)}`;
export { nextBatchFor };
