// @ts-nocheck: buildless Alpine factory for /deposit/requests/:id (RM-146,
// under RM-205): one request's public status page (canvas board 7). It is the
// link a person bookmarks after depositing and the link the skill returns to
// an agent's owner, so it says, in the same words as every other surface
// (stages.js, describe.js), where the request stands, what already happened
// and when the next thing happens. Anyone with the link can read it, without
// an early access code; only the owner's wallet can act on it.
//
// Live, the request is read from the queue on Base. Simulated, it lives in
// this browser's localStorage, so the link opens only where it was made.
// Transactions per request need the indexer (RM-206): until then the chain
// read lists none, and the simulator lists its own.
import { session } from "../../lib/deposit/session.js";
import { MANIFEST } from "../../lib/deposit/manifest.js";
import { buildCancel, buildWithdrawCredit, buildWithdrawExpired, buildGiveNotice, buildTakeBackNotice } from "../../lib/deposit/builder.js";
import { stageOf, filledOf, outOf, canCancel, canWithdrawExpired, canGiveNotice, canTakeBack, liveRemaining, lockOf, STAGE, IN_FLIGHT } from "../../lib/deposit/stages.js";
import { timelineOf, summaryOf, inUnit, outUnit, kindLabel, toneOf, cancelledOf } from "../../lib/deposit/describe.js";
import { requestExpiresAt, fmtWhenIn } from "../../lib/deposit/schedule.js";
import { fmtWhen, fmtFee, shortAddr, shortHash } from "../../lib/deposit/format.js";
import { DEPOSIT_REQUEST_RE } from "../../routes.js";

export function registerDepositRequestView(Alpine) {
  Alpine.data("depositRequestView", () => ({
    id: "",
    rev: 0,
    now: Date.now(),
    r: null,
    vault: null,
    loaded: false,
    loadError: "",
    copied: false,
    asking: false,
    busy: false,
    busyText: "",
    errText: "",
    _t: null,
    _unsub: null,

    async init() {
      this.now = session.now();
      this.id = (DEPOSIT_REQUEST_RE.exec(location.pathname) || [])[1] || "";
      this._unsub = session.subscribe(() => { this.rev++; this.now = session.now(); this.load(); });
      this._t = setInterval(() => { session.source?.tick?.(); this.now = session.now(); if (!session.simulated) this.load(); }, 15_000);
      await this.load();
    },
    destroy() { clearInterval(this._t); this._unsub?.(); },

    async load() {
      try {
        const src = await session.src();
        [this.vault, this.r] = await Promise.all([src.vault(), /^\d+$/.test(this.id) ? src.request(this.id) : null]);
        this.loadError = "";
      } catch (e) { console.error(e); this.loadError = "This request could not be read. Try again in a moment."; }
      this.loaded = true;
    },

    simulated() { return session.simulated; },
    flow() { return this.vault?.flow || MANIFEST.flow; },
    sample() { return this.vault?.source === "sample"; },
    ctx() { return { depositsStopped: !!this.vault?.depositsStopped }; },
    st() { this.now; return this.r ? stageOf(this.r, this.now, this.flow()) : null; },
    title() { const r = this.r; return r ? `${kindLabel(r)} of ${inUnit(r, r.amount)}` : "Request not found"; },
    summary() { this.now; return this.r ? summaryOf(this.r, this.now, this.flow()) : ""; },
    tone() { const s = this.st()?.stage; return s ? toneOf(s, this.r) : "off"; },
    /** The fill bar: a block per batch fill, then what is still live, then what closed unfilled. */
    bar() {
      const r = this.r;
      if (!r || !(r.amount > 0) || (!r.fills.length && !(liveRemaining(r) > 0))) return [];
      const out = r.fills.map((x, i) => ({ key: `f${i}`, w: x.amountIn, cls: "is-fill" }));
      const left = liveRemaining(r);
      if (left > 0) out.push({ key: "live", w: left, cls: "is-rest" });
      const gone = r.amount - filledOf(r) - left;
      if (gone > 1e-9) out.push({ key: "gone", w: gone, cls: "is-gone" });
      return out;
    },
    filledLabel() { const r = this.r; return r ? `${inUnit(r, filledOf(r)).replace(/ (USDC|rmFUND)$/, "")} of ${inUnit(r, r.amount)}` : ""; },
    restLabel() {
      const r = this.r, st = this.st();
      if (!r || !st) return "";
      const left = liveRemaining(r);
      if (left > 0 && (st.stage === STAGE.FILLING || st.stage === STAGE.WAITING)) return `${inUnit(r, left)} in the next batch`;
      if (cancelledOf(r) > 1e-9) return `${inUnit(r, cancelledOf(r))} cancelled`;
      return "";
    },
    /** The bar replaces the sentence where it says the same thing (filling, ready, delivered); a stage with a time keeps its sentence. */
    barSays() { const s = this.st()?.stage; return s === STAGE.FILLING || s === STAGE.READY || s === STAGE.DELIVERED; },
    facts() {
      const r = this.r, st = this.st(), f = this.flow();
      if (!r) return [];
      const out = [{ key: "stage", label: "Stage", value: st.stage, stage: true }];
      if (st.at && IN_FLIGHT.includes(st.stage)) out.push({ key: "next", label: "Next", value: fmtWhenIn(st.at, this.now) });
      const filled = filledOf(r), got = outOf(r);
      out.push({ key: "filled", label: "Filled", value: got > 0 ? `${inUnit(r, filled).replace(/ USDC$/, "")} → ${outUnit(r, got)}` : inUnit(r, filled) });
      const lock = lockOf(r, this.now, f);
      if (lock) out.push({ key: "lock", label: "Can be cancelled until", value: fmtWhenIn(lock, this.now) });
      if (r.kind === "redeem") out.push({ key: "fee", label: "Exit fee", value: fmtFee(r.exitFeeBps) });
      if (liveRemaining(r) > 0 && r.kind === "deposit") out.push({ key: "exp", label: "Unfilled USDC can be taken back", value: fmtWhenIn(requestExpiresAt(r, f), this.now) });
      if (liveRemaining(r) > 0 && r.kind === "redeem" && !r.noticeAt) out.push({ key: "exp", label: "Notice possible from", value: fmtWhenIn(requestExpiresAt(r, f), this.now) });
      out.push({ key: "owner", label: "Owner", value: shortAddr(r.owner) });
      return out;
    },
    events() { this.now; return this.r ? timelineOf(this.r, this.now, this.flow()) : []; },
    txs() { return (this.r?.txs || []).map((h, i) => ({ key: i, hash: h, short: shortHash(h), url: !session.simulated && /^0x[0-9a-f]{64}$/i.test(h) ? `${MANIFEST.explorer}/tx/${h}` : null })); },

    // The owner's actions
    isOwner() { this.rev; return !!this.r && session.connected() && session.onBase() && session.acct.address.toLowerCase() === this.r.owner.toLowerCase(); },
    canCancel() { this.now; return !!this.r && canCancel(this.r, this.now, this.flow(), this.ctx()); },
    canWithdrawExpired() { return !!this.r && canWithdrawExpired(this.r); },
    canGiveNotice() { this.now; return !!this.r && canGiveNotice(this.r, this.now, this.flow()); },
    canTakeBack() { return !!this.r && canTakeBack(this.r); },
    ownerAction() { return this.canCancel() ? "cancel" : this.canWithdrawExpired() || this.canTakeBack() ? "withdraw" : this.canGiveNotice() ? "give notice" : ""; },
    cancelAmount() { return this.r ? inUnit(this.r, liveRemaining(this.r)) : ""; },
    connect() { session.connect(); },
    async act(calls, label) {
      if (this.busy) return;
      this.busy = true; this.errText = ""; this.busyText = "Confirm in your wallet";
      try {
        await session.send(calls, {
          label,
          onStep: (i, state) => {
            const of = calls.length > 1 ? ` (${i + 1} of ${calls.length})` : "";
            this.busyText = state === "wallet" ? `Confirm in your wallet${of}` : state === "sent" ? "Waiting for Base" : "Done";
          },
        });
        this.asking = false;
        await this.load();
      } catch (e) { this.errText = e.message; }
      finally { this.busy = false; this.busyText = ""; }
    },
    cancel() { this.act([...buildCancel(this.id), ...buildWithdrawCredit()], "Cancel the request"); },
    withdrawExpired() { this.act(buildWithdrawExpired(this.id), "Withdraw what did not fill"); },
    giveNotice() { this.act(buildGiveNotice(this.id), "Ask for the unfilled shares back"); },
    takeBack() { this.act(buildTakeBackNotice(this.id), "Take back the unfilled shares"); },

    async copyLink() {
      try { await navigator.clipboard.writeText(location.href); this.copied = true; setTimeout(() => { this.copied = false; }, 2000); } catch { /* clipboard blocked */ }
    },
  }));
}
