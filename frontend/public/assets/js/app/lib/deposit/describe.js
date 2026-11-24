// @ts-check
// A request in words (RM-146): the row on Your requests and the facts and
// timeline on its status page, from one record (stages.js has the shape) and
// the time. Both pages read these, so a request never says one thing in the
// table and another on its own page.

import { stageOf, filledOf, outOf, liveRemaining, canCancel, canWithdrawExpired, canGiveNotice, canTakeBack, claimableFills, lockOf, nextBatchFor, STAGE, IN_FLIGHT } from "./stages.js";
import { requestExpiresAt, requestLockAt, fmtCountdown, fmtDuration, fmtAt, fmtSay } from "./schedule.js";
import { fmtUsdc, fmtRm, fmtWhen, fmtWhenShort } from "./format.js";

const EPS = 1e-9;
const UNKNOWN_EARLY = Number.MIN_SAFE_INTEGER;
/**
 * A batch can fill a request for slightly less than it asked (rounding into
 * the queue's dust books): under a hundredth of a USDC or of an rmFUND is not
 * a cancellation worth showing.
 */
const DUST = 0.01;

/** "250 USDC" for a deposit, "100.0000 rmFUND" for a redemption. @param {any} r @param {number} n */
export const inUnit = (r, n) => (r.kind === "deposit" ? fmtUsdc(n) : fmtRm(n));
/** The other side: rmFUND for a deposit, USDC for a redemption. @param {any} r @param {number} n */
export const outUnit = (r, n) => (r.kind === "deposit" ? fmtRm(n) : fmtUsdc(n));
/** "Deposit" or "Redemption". @param {any} r */
export const kindLabel = (r) => (r.kind === "deposit" ? "Deposit" : "Redemption");

/** The cancelled part of a request: what was asked for less what filled, once closed by a cancel. @param {any} r */
export const cancelledOf = (r) => { const d = r.cancelled ? r.amount - filledOf(r) : 0; return d >= DUST ? d : 0; };

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
 * What each stage means, in one or two sentences from the requester's side:
 * the (i) beside a stage, and the stage guide on Your position.
 * @param {string} stage @param {"deposit" | "redeem"} [kind] @param {any} [f] flow parameters
 */
export function stageHelp(stage, kind = "deposit", f = null) {
  const dep = kind === "deposit";
  const unit = dep ? "USDC" : "rmFUND";
  const out = dep ? "rmFUND" : "USDC";
  const hold = fmtDuration(f?.minHold ?? 3600);
  // The same lead the deposit page gives: the cancel buffer plus the settle window.
  const lead = fmtDuration((f?.cancelBuffer ?? 900) + (f?.settleWindow ?? 720));
  const span = f ? fmtDuration(f.maxRoll * f.epochLength) : "8 h";
  return {
    [STAGE.PENDING]: `Your ${unit} waits for the next batch, which sets the price. You can cancel until it locks, ${lead} before that batch. If a batch fills only part, the rest joins the next one.`,
    [STAGE.ON_HOLD]: dep
      ? `The batch bought your rmFUND at its price. It is yours to claim ${hold} after the batch: the wait protects every holder from a manipulated price.`
      : "The batch sold your rmFUND at its price. Your USDC is yours to claim once its wait ends.",
    [STAGE.READY]: `Your ${out} is ready. One signature moves it into your wallet.`,
    [STAGE.CLAIMED]: `Your ${out} is in your wallet.`,
    [STAGE.CANCELLED]: `Cancelled before it locked. The ${unit} came back to you.`,
    [STAGE.EXPIRED]: `No batch filled it within ${span}. The unfilled USDC is yours to withdraw.`,
    [STAGE.NOTICE]: "You asked for the unfilled rmFUND back. It takes part in one more batch; whatever that batch does not fill comes back.",
    [STAGE.TAKE_BACK]: "No batch filled the rest. Take the rmFUND back into your wallet.",
    [STAGE.RETURNED]: "No batch filled it, and the rmFUND came back to you.",
    [STAGE.RELEASED]: "The vault is winding down, so this request was released. Withdraw it to your wallet.",
  }[stage] || "";
}

/** The Stage header's (i): the path every request takes, said once for the column. */
export const STAGES_TIP = "A deposit goes Pending, Filled, Ready to claim, Claimed. A redemption has no wait, so it goes from Pending straight to Ready to claim.";

/** The stages a deposit moves through, in order, for the stage guide on Your position. */
export const LIFECYCLE = Object.freeze([
  { stage: STAGE.PENDING, tone: "waiting" },
  { stage: STAGE.ON_HOLD, tone: "hold" },
  { stage: STAGE.READY, tone: "ready" },
  { stage: STAGE.CLAIMED, tone: "off" },
]);

/**
 * A stage's colour, one vocabulary on every surface (David, 17 Nov 2026: "lets
 * be consistent across the app"): green when it is ready to claim, grey while
 * the hold runs, a hollow ring while it waits for a batch, the Beacon point
 * when it needs the owner to act, and dim once it is closed.
 * @param {string} stage @param {any} r
 * @returns {"ready" | "hold" | "waiting" | "act" | "off"}
 */
export function toneOf(stage, r) {
  if (stage === STAGE.READY) return "ready";
  if (stage === STAGE.TAKE_BACK || stage === STAGE.RELEASED || (stage === STAGE.EXPIRED && canWithdrawExpired(r))) return "act";
  if (stage === STAGE.ON_HOLD) return "hold";
  if (stage === STAGE.PENDING || stage === STAGE.NOTICE) return "waiting";
  return "off";
}

/**
 * One row of Your requests (canvas board 6). `sub` is one short line under the
 * stage; `tip` is the reason behind it, for the (i) beside it.
 * @param {any} r @param {number} now @param {any} f flow parameters @param {{ depositsStopped?: boolean }} [ctx]
 */
export function rowOf(r, now, f, ctx = {}) {
  const st = stageOf(r, now, f);
  const filled = filledOf(r);
  const out = outOf(r);
  const left = liveRemaining(r);
  const lock = lockOf(r, now, f);
  const tone = toneOf(st.stage, r);
  const notice = canGiveNotice(r, now, f);
  const span = fmtDuration(f.maxRoll * f.epochLength);
  let sub = "", tip = "";
  const part = st.stage === STAGE.PENDING && filled > EPS;
  if (st.stage === STAGE.PENDING && !part && lock) sub = `You can cancel until ${fmtSay(lock, now)}`;
  // The Next column carries the time, so the line says what happens then.
  else if (st.stage === STAGE.ON_HOLD) sub = `Ready to claim after a ${fmtDuration(f.minHold)} wait`;
  else if (notice) { sub = "You can ask for the rmFUND back"; tip = `No batch has filled ${inUnit(r, left)} in ${span}.`; }
  else if (part) sub = `${inUnit(r, left)} joins the next batch`;
  else if (st.stage === STAGE.NOTICE) { sub = `${inUnit(r, left)} comes back if unfilled`; tip = "It takes part in one more batch. Whatever that batch does not fill comes back."; }
  else if (st.stage === STAGE.TAKE_BACK) sub = `${inUnit(r, r.remaining)} to take back`;
  else if (st.stage === STAGE.RELEASED) sub = `${inUnit(r, r.remaining)} to withdraw`;
  else if (st.stage === STAGE.EXPIRED && canWithdrawExpired(r)) { sub = `Withdraw the ${inUnit(r, r.remaining)} to your wallet.`; tip = `No batch filled it within ${span}.`; }
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
    claimed: st.stage === STAGE.CLAIMED,
    sub,
    tip,
    help: stageHelp(st.stage, r.kind, f),
    next: st.at && IN_FLIGHT.includes(st.stage) ? fmtAt(st.at, now) : "",
    nextIn: st.at && IN_FLIGHT.includes(st.stage) && st.at > now ? fmtCountdown(st.at - now) : "",
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
 * What happened, oldest first, then what is expected (canvas board 7). One
 * short line per event; the detail (how a batch matched) goes in `tip`.
 * `mark` colours the event's point with the stage vocabulary (toneOf): money
 * that moved or arrives is green, a step done is white, a deadline or an
 * action the owner needs is the Beacon point, what has not happened yet is a
 * hollow ring, and what closed without effect is dim.
 * @param {any} r @param {number} now @param {any} f
 * @returns {{ key: number, at: number, when: string, what: string, tip: string, next: boolean, mark: "money" | "done" | "act" | "next" | "off" }[]}
 */
export function timelineOf(r, now, f) {
  const dep = r.kind === "deposit";
  /** @type {any[]} */
  // A request carried over from 0.8.0 has no creation time (createdAt 0): it sorts first, with no time shown.
  const ev = [{ at: r.createdAt || UNKNOWN_EARLY, what: `Requested ${inUnit(r, r.amount)}`, mark: "done" }];
  const lockAt = requestLockAt(r, f);
  const lockedForBatch = !(r.cancelled && (r.cancelledAt ?? 0) < lockAt) && !(r.released && !r.fills.length);
  if (lockedForBatch) ev.push(lockAt > now ? { at: lockAt, what: "Locks, and cancelling closes", mark: "act", next: true } : { at: lockAt, what: "Locked", mark: "done" });
  for (const x of r.fills) {
    ev.push({ at: x.at, what: `Filled ${inUnit(r, x.amountIn)} at ${x.price.toFixed(4)} → ${outUnit(r, x.out)}`, tip: splitOf(r, x), mark: "money" });
    if (dep && !x.claimed && x.unlockAt > now) ev.push({ at: x.unlockAt, what: `${fmtRm(x.out)} ready to claim`, mark: "money", next: true });
  }
  if (r.noticeGivenAt) ev.push({ at: r.noticeGivenAt, what: "Notice given", tip: "Unfilled rmFUND comes back after one more batch.", mark: "done" });
  const st = stageOf(r, now, f);
  const left = liveRemaining(r);
  if (left > EPS && st.at) {
    ev.push({ at: st.at, what: `Next batch: ${inUnit(r, left)}`, tip: "The batch sets the price it fills at.", mark: "next", next: true });
    if (dep) ev.push({ at: st.at + f.minHold * 1000, what: r.fills.length ? "The rest ready to claim, if that batch fills it" : "rmFUND ready to claim, if that batch fills it", mark: "next", next: true });
    if (dep) ev.push({ at: requestExpiresAt(r, f), what: "Unfilled USDC can be taken back", mark: "next", next: true });
    else if (!r.noticeAt && requestExpiresAt(r, f) > now) ev.push({ at: requestExpiresAt(r, f), what: "You can ask for unfilled rmFUND back", mark: "next", next: true });
  }
  if (r.cancelled && cancelledOf(r) > EPS) ev.push({ at: r.cancelledAt ?? Number.MAX_SAFE_INTEGER, what: `Cancelled ${inUnit(r, cancelledOf(r))} unfilled`, mark: "off" });
  if (r.expired) ev.push(canWithdrawExpired(r) ? { at: requestExpiresAt(r, f), what: `Expired: ${inUnit(r, r.remaining)} to withdraw`, mark: "act" } : { at: requestExpiresAt(r, f), what: "Expired. The unfilled USDC was taken back", mark: "off" });
  if (r.noticeDone && r.noticeAt) ev.push(canTakeBack(r) ? { at: r.noticeAt, what: `Notice batch ran: ${inUnit(r, r.remaining)} to take back`, mark: "act" } : { at: r.noticeAt, what: "Notice batch ran. The unfilled rmFUND came back", mark: "off" });
  if (r.released) ev.push(r.closed ? { at: r.returnedAt ?? Number.MAX_SAFE_INTEGER, what: "Released in the wind-down and withdrawn", mark: "off" } : { at: r.returnedAt ?? Number.MAX_SAFE_INTEGER, what: "Released in the wind-down, to withdraw", mark: "act" });
  return ev
    .sort((a, b) => a.at - b.at)
    .map((e, i) => ({ tip: "", next: false, ...e, key: i, when: e.at === Number.MAX_SAFE_INTEGER || e.at === UNKNOWN_EARLY ? "" : fmtWhen(e.at) }));
}

/** The sentence under a status page title. @param {any} r @param {number} now @param {any} f */
export function summaryOf(r, now, f) {
  const st = stageOf(r, now, f);
  const filled = filledOf(r);
  const left = liveRemaining(r);
  const lock = lockOf(r, now, f);
  if (st.stage === STAGE.PENDING && filled > EPS) return `${inUnit(r, filled).replace(/ USDC$/, "")} of ${inUnit(r, r.amount)} has filled. The other ${inUnit(r, left)} joins the next batch.`;
  if (st.stage === STAGE.PENDING) return `Waiting for the batch at ${fmtSay(st.at, now)}, which sets the price.${lock ? ` You can cancel until ${fmtSay(lock, now)}.` : ""}`;
  if (st.stage === STAGE.ON_HOLD) return r.kind === "deposit" ? `Filled. Your ${fmtRm(outOf(r))} is ready to claim at ${fmtSay(st.at, now)}.` : `Filled. Your USDC is ready to claim at ${fmtSay(st.at, now)}.`;
  if (st.stage === STAGE.NOTICE) return `Notice given. Any rmFUND the batch at ${fmtSay(st.at, now)} does not fill comes back to you.`;
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
