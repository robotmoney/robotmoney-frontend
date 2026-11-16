// @ts-nocheck: buildless Alpine factory for /deposit/requests (RM-146, under
// RM-205): the connected wallet's position and every request it made, with
// the one action each needs. Canvas boards 6, 17 and 25.
//
// Contracts 0.9.0 set the actions. A request can be cancelled only until it
// locks for its batch (or while deposits are stopped), and the cancel moves it
// to a credit in the queue that `withdrawCredit` takes home: Cancel sends both,
// as one confirmation where the wallet can batch. A deposit no batch fills in
// time is withdrawn; a redemption is given notice instead, and its unfilled
// shares taken back after one more batch. In a wind-down, every queued request
// is released to its owner. A credit left behind by any other route (the
// skill, a wallet that dropped the second call) shows as its own banner.
import { session } from "../../lib/deposit/session.js";
import { MANIFEST } from "../../lib/deposit/manifest.js";
import { buildCancel, buildWithdrawCredit, buildWithdrawExpired, buildClaimShares, buildClaimUsdc, buildGiveNotice, buildTakeBackNotice, buildReleaseWindDown } from "../../lib/deposit/builder.js";
import { rowOf, nextBatchLabel, stopOf } from "../../lib/deposit/describe.js";
import { claimableFills, liveRemaining } from "../../lib/deposit/stages.js";
import { timelineFor } from "../../lib/deposit/schedule.js";
import { fmtUsdc, fmtShares, shortAddr, shortHash } from "../../lib/deposit/format.js";

const EPS = 1e-9;

export function registerDepositRequestsView(Alpine) {
  Alpine.data("depositRequestsView", () => ({
    rev: 0,
    now: Date.now(),
    vault: null,
    acct: null,
    reqs: [],
    loaded: false,
    loadError: "",
    asking: null,
    busy: null,
    busyText: "",
    errKey: null,
    errText: "",
    resetAsk: false,
    _t: null,
    _unsub: null,

    async init() {
      this.now = session.now();
      this._unsub = session.subscribe(() => { this.rev++; this.now = session.now(); this.load(); });
      this._t = setInterval(() => { session.source?.tick?.(); this.now = session.now(); if (!session.simulated) this.load(); }, 15_000);
      if (!session.simulated) session.ready().catch(() => { this.loadError = "Your requests could not be read. Try again in a moment."; });
      await this.load();
    },
    destroy() { clearInterval(this._t); this._unsub?.(); },

    async load() {
      try {
        const src = await session.src();
        this.vault = await src.vault();
        if (session.connected() && session.onBase()) {
          const a = session.acct.address;
          [this.acct, this.reqs] = await Promise.all([src.account(a), src.requestsOf(a)]);
        } else { this.acct = null; this.reqs = []; }
        this.loaded = true; this.loadError = "";
      } catch (e) { console.error(e); this.loadError = "Your requests could not be read. Try again in a moment."; }
    },

    // Wallet
    simulated() { return session.simulated; },
    connected() { this.rev; return session.connected(); },
    onBase() { this.rev; return session.onBase(); },
    short() { this.rev; return shortAddr(session.acct.address); },
    walletLoading() { this.rev; return session.walletLoading; },
    connect() { session.connect(); },
    useTestAddress() { session.useTestAddress(); },
    switchToBase() { session.switchToBase(); },
    sample() { return this.vault?.source === "sample"; },
    stop() { return stopOf(this.vault); },

    // Position (board 6's facts)
    flow() { return this.vault?.flow || MANIFEST.flow; },
    price() { return this.vault?.priceUsdc ?? 0; },
    onHoldShares() { this.now; return this.reqs.filter((r) => r.kind === "deposit").flatMap((r) => r.fills).filter((x) => !x.claimed && x.unlockAt > this.now).reduce((t, x) => t + x.out, 0); },
    queuedUsdc() { return this.reqs.filter((r) => r.kind === "deposit").reduce((t, r) => t + liveRemaining(r), 0); },
    queuedShares() { return this.reqs.filter((r) => r.kind === "redeem").reduce((t, r) => t + liveRemaining(r), 0); },
    facts() {
      const a = this.acct;
      if (!a) return [];
      const out = [
        { key: "value", label: "Value", value: fmtUsdc(Math.floor(a.shares * this.price() * 100) / 100) },
        { key: "shares", label: "Shares", value: fmtShares(a.shares) },
      ];
      if (this.onHoldShares() > EPS) out.push({ key: "hold", label: "On hold", value: `${fmtShares(this.onHoldShares())} shares` });
      if (this.queuedUsdc() > EPS) out.push({ key: "qd", label: "In the queue", value: fmtUsdc(this.queuedUsdc()) });
      if (this.queuedShares() > EPS) out.push({ key: "qr", label: "Queued to redeem", value: `${fmtShares(this.queuedShares())} shares` });
      return out;
    },

    // What is ready
    readyDeposits() {
      this.now;
      const fills = this.reqs.filter((r) => r.kind === "deposit").flatMap((r) => claimableFills(r, this.now));
      const shares = fills.reduce((t, x) => t + x.out, 0);
      const cost = fills.reduce((t, x) => t + x.left, 0);
      const raw = fills.length && fills.every((x) => typeof x.leftRaw === "bigint") ? fills.reduce((t, x) => t + x.leftRaw, 0n) : null;
      const paid = fills.reduce((t, x) => t + x.amountIn, 0);
      return { shares, cost, raw, paid, any: shares > EPS };
    },
    readyRedemptions() {
      this.now;
      const fills = this.reqs.filter((r) => r.kind === "redeem").flatMap((r) => claimableFills(r, this.now));
      const usdc = fills.reduce((t, x) => t + x.out, 0);
      const shares = fills.reduce((t, x) => t + x.left, 0);
      const raw = fills.length && fills.every((x) => typeof x.leftRaw === "bigint") ? fills.reduce((t, x) => t + x.leftRaw, 0n) : null;
      return { usdc, shares, raw, any: usdc > EPS };
    },
    credit() { const a = this.acct; return { usdc: a?.creditUsdc ?? 0, shares: a?.creditShares ?? 0, any: (a?.creditUsdc ?? 0) > EPS || (a?.creditShares ?? 0) > EPS }; },
    words(usdc, shares) { return [usdc > EPS ? fmtUsdc(usdc) : "", shares > EPS ? `${fmtShares(shares)} shares` : ""].filter(Boolean).join(" and "); },
    creditWords() { const c = this.credit(); return this.words(c.usdc, c.shares); },
    /** In a wind-down: what the owner's queued requests released. */
    released() {
      const rs = this.reqs.filter((r) => r.released && !r.closed && r.remaining > EPS);
      const usdc = rs.filter((r) => r.kind === "deposit").reduce((t, r) => t + r.remaining, 0);
      const shares = rs.filter((r) => r.kind === "redeem").reduce((t, r) => t + r.remaining, 0);
      return { usdc, shares, any: rs.length > 0, words: this.words(usdc, shares) };
    },
    pending() { this.rev; return session.pending(); },
    pendingUrl() { const p = this.pending(); return p?.hash && /^0x[0-9a-f]{64}$/i.test(p.hash) ? `${MANIFEST.explorer}/tx/${p.hash}` : null; },

    // Requests (board 6)
    rows() { this.now; return this.reqs.map((r) => rowOf(r, this.now, this.flow(), { depositsStopped: !!this.vault?.depositsStopped })); },
    nextBatch() { this.now; return nextBatchLabel(timelineFor(this.now, this.flow()).settlesAt, this.now); },

    // Actions: each sends its calls and shows its progress where it was asked for.
    async act(key, calls, label) {
      if (this.busy) return;
      this.busy = key; this.errKey = null; this.errText = ""; this.busyText = "Confirm in your wallet";
      try {
        await session.send(calls, {
          label,
          onStep: (i, state) => {
            const of = calls.length > 1 ? ` (${i + 1} of ${calls.length})` : "";
            this.busyText = state === "wallet" ? `Confirm in your wallet${of}` : state === "sent" ? "Waiting for Base" : "Done";
          },
        });
        this.asking = null;
        await this.load();
      } catch (e) {
        this.errKey = key; this.errText = e.message;
      } finally { this.busy = null; this.busyText = ""; }
    },
    claimShares() {
      const d = this.readyDeposits();
      this.act("claim-shares", buildClaimShares(d.raw ?? d.cost, session.acct.address), "Claim your shares");
    },
    claimUsdc() {
      const r = this.readyRedemptions();
      this.act("claim-usdc", buildClaimUsdc(r.raw ?? r.shares, session.acct.address), "Claim your USDC");
    },
    withdrawCredit() { this.act("credit", buildWithdrawCredit(), "Withdraw to your wallet"); },
    releaseWindDown() { this.act("release", buildReleaseWindDown(session.acct.address), "Withdraw your released requests"); },
    cancel(id) { this.act(`cancel-${id}`, [...buildCancel(id), ...buildWithdrawCredit()], "Cancel the request"); },
    withdrawExpired(id) { this.act(`expired-${id}`, buildWithdrawExpired(id), "Withdraw what did not fill"); },
    giveNotice(id) { this.act(`notice-${id}`, buildGiveNotice(id), "Ask for the unfilled shares back"); },
    takeBack(id) { this.act(`back-${id}`, buildTakeBackNotice(id), "Take back the unfilled shares"); },

    fmtUsdc, fmtShares, shortHash,

    // Simulation controls, as on the deposit page.
    simNext() { session.source.toNextBatch(); },
    simAdvance(h) { session.source.advance(h * 3_600_000); },
    simReset() { session.source.reset(); this.resetAsk = false; },
    simState() { this.rev; return session.simulated ? session.source.stopped() : { deposits: false, windDown: false, blocked: false }; },
    simToggleDeposits() { session.source.setDepositsStopped(!this.simState().deposits); },
    simToggleWindDown() { session.source.setWindDown(!this.simState().windDown); },
    simToggleBlocked() { session.source.setBatchesBlocked(!this.simState().blocked); },
  }));
}
