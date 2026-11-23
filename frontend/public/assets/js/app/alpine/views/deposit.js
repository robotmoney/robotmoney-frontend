// @ts-nocheck: buildless Alpine factory for /deposit (RM-146, under RM-205):
// the vault page and its deposit panel, built to the design canvas (source of
// truth: https://claude.ai/artifact/JwVUy2W8WJbj8B4hxSb3MY, boards 1 to 5, 8,
// 9, 13 to 16, 19 and 22 to 25).
//
// Contracts 0.9.0: a request names an amount and no price, because the batch
// sets it; the panel shows an estimate at today's price, marked as one, and
// the time the request locks (`cancelBuffer` before its epoch closes). Exit in
// kind exists only once the vault is winding down. Stops (a paused queue,
// stopped deposits, a wind-down) come from the vault and block what they stop.
//
// Everything chain-shaped lives in lib/deposit/: the session (wallet, account,
// source, send path), the builder (calls), stages and schedule (words and
// times). The source is the live vault on Base when the manifest has Deploy 4's
// addresses, and the simulator otherwise; this file does not know which.
// `depositGate` is the early access gate in front of this page and Your
// requests (lib/deposit/access.js).
import { session, MIN_ETH } from "../../lib/deposit/session.js";
import { MANIFEST } from "../../lib/deposit/manifest.js";
import { buildDeposit, buildRedeem, buildExitInKind } from "../../lib/deposit/builder.js";
import { depositWait, redeemWait, fmtDuration, fmtCountdown, fmtWhenIn, fmtClock, timelineFor, expiresAtOf, epochOf, epochEndAt } from "../../lib/deposit/schedule.js";
import { nextBatchFor, stageOf, canWithdrawExpired, STAGE } from "../../lib/deposit/stages.js";
import { fmtUsdc, fmtShares, fmtRm, fmtPrice, fmtBps, fmtFee, floorTo, fmtWhen, fmtWhenShort, shortAddr, shortHash } from "../../lib/deposit/format.js";
import { isOpen, tryCode, bodyOf } from "../../lib/deposit/access.js";
import { stopOf } from "../../lib/deposit/describe.js";
import { tokenIcon } from "../../lib/deposit/tokens.js";
import { CATEGORICAL } from "../../lib/chart-theme.js";

const num = (v) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : NaN; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function registerDepositView(Alpine) {
  // The early access gate (access.js): wraps /deposit and Your requests.
  // RM is fixed and the ten characters after it fill ten boxes, drawn over one
  // real input (#dp-code) so typing, pasting and screen readers all work on a
  // single field. The code is checked as soon as the tenth character lands.
  Alpine.data("depositGate", () => ({
    open: isOpen(),
    code: "",
    focused: false,
    state: "idle", // idle | checking | wrong | ok
    focusFirst(el) {
      if (window.matchMedia?.("(pointer: fine)").matches) requestAnimationFrame(() => el.focus({ preventScroll: true }));
    },
    onInput(e) {
      const v = bodyOf(e.target.value);
      if (e.target.value !== v) e.target.value = v;
      this.code = v;
      this.state = "idle";
      if (v.length === 10) this.check();
    },
    async check() {
      const code = this.code;
      this.state = "checking";
      let ok = false;
      try { ok = await tryCode(code); } catch { ok = false; }
      if (code !== this.code) return; // edited while it was checked
      this.state = ok ? "ok" : "wrong";
      if (ok) setTimeout(() => { this.open = true; window.scrollTo(0, 0); }, 700);
    },
    box(i) { return this.code[i] || ""; },
    boxClass(i) {
      const active = this.focused && this.state !== "ok" && i === Math.min(this.code.length, 9);
      return { "is-filled": !!this.code[i], "is-active": active };
    },
    msg() {
      if (this.state === "ok") return "Code accepted. Opening the vault.";
      if (this.state === "wrong") return "That code does not match. Check it against the message it came in.";
      return "Your code came by email or Telegram.";
    },
  }));

  Alpine.data("depositView", () => ({
    rev: 0,
    now: Date.now(),
    vault: null,
    loadError: "",
    acctData: null,
    reqCounts: { open: 0, ready: 0 },
    tick: 0,
    tab: "deposit",
    menuOpen: false,
    copied: false,

    // Deposit form.
    amount: "",
    maxWhy: "",
    dq: null,
    dqLoading: false,

    // Redeem form. "inkind" only while the vault winds down (D18).
    shares: "",
    exitMode: "queue",
    rq: null,

    // The one dialog: review → signing → requested (boards 3 to 5).
    dlg: { open: false, kind: "deposit", phase: "review", checks: [], calls: [], steps: [], batch: false, error: "", ack: false, result: null, quote: null, amount: 0 },

    resetAsk: false,
    _t: null,
    _unsub: null,

    async init() {
      this.now = session.now();
      this._unsub = session.subscribe(() => { this.rev++; this.now = session.now(); this.refreshAccount(); this.loadVault(); });
      this._quote = debounce(() => this.loadQuote(), 250);
      this._rquote = debounce(() => this.loadRedeemQuote(), 250);
      this.$watch("amount", () => { this.maxWhy = ""; this._quote(); });
      this.$watch("shares", () => this._rquote());
      this.$watch("exitMode", () => this._rquote());
      let ticks = 0;
      this._t = setInterval(() => {
        session.source?.tick?.();
        this.now = session.now();
        if (!session.simulated && ++ticks % 4 === 0) this.loadVault();
      }, 15_000);
      if (!session.simulated) session.ready().catch(() => { this.loadError = "The vault could not be read. Try again in a moment."; });
      // The Queue countdown ticks each second; nothing else reads `tick`.
      this.tick = session.now();
      this._clock = setInterval(() => { this.tick = session.now(); }, 1000);
      await this.loadVault();
      this.refreshAccount();
    },
    destroy() { clearInterval(this._t); clearInterval(this._clock); this._unsub?.(); },

    // ── Vault ────────────────────────────────────────────────────────────
    async loadVault() {
      try {
        const src = await session.src();
        this.vault = await src.vault();
        this.loadError = "";
        this.exitMode = this.vault.windDown ? "inkind" : "queue";
      } catch (e) { console.error(e); this.loadError = "The vault could not be read. Try again in a moment."; }
    },
    flow() { return this.vault?.flow || MANIFEST.flow; },
    sample() { return this.vault?.source === "sample"; },
    price() { return fmtPrice(this.vault?.priceUsdc); },
    tvl() { return fmtUsdc(this.vault?.tvlUsdc); },
    room() { return this.vault ? Math.max(0, this.vault.tvlCapUsdc - this.vault.tvlUsdc) : null; },
    roomLabel() { return fmtUsdc(this.room()); },
    capTip() { return this.vault ? `What the vault can still take before it reaches its ${fmtUsdc(this.vault.tvlCapUsdc)} cap.` : "What the vault can still take before it reaches its cap."; },
    holdings() {
      const hs = this.vault?.holdings || [];
      return hs.map((h, i) => ({ ...h, hue: CATEGORICAL[i % CATEGORICAL.length], value: fmtUsdc(h.valueUsdc).replace(" USDC", ""), target: h.targetBps == null ? "—" : fmtBps(h.targetBps), actual: fmtBps(h.actualBps), venueLabel: /^0x/.test(h.venue) ? shortAddr(h.venue) : h.venue }));
    },
    ringSvg() {
      let at = 0;
      const arcs = this.holdings().map((h) => {
        const pct = h.actualBps / 100;
        const arc = `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="${h.hue}" stroke-width="4" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${25 - at}" data-mark="series"></circle>`;
        at += pct;
        return arc;
      }).join("");
      return `<svg viewBox="0 0 42 42" width="176" height="176" role="img" aria-label="Holdings by weight"><circle cx="21" cy="21" r="15.9155" fill="none" stroke="#222a38" stroke-width="4"></circle>${arcs}</svg>`;
    },
    waitLabel() { const w = depositWait(this.flow()); return `${fmtDuration(w.min)} to ${fmtDuration(w.max)}`; },
    redeemWaitLabel() { const w = redeemWait(this.flow()); return `${fmtDuration(w.min)} to ${fmtDuration(w.max)}`; },
    epochLabel() { return fmtDuration(this.flow().epochLength); },
    holdLabel() { return fmtDuration(this.flow().minHold); },
    expiryLabel() { return fmtDuration(this.flow().maxRoll * this.flow().epochLength); },
    /** How long before its batch a request locks: the cancel buffer plus the settle window. */
    lockLead() { const f = this.flow(); return fmtDuration((f.cancelBuffer ?? 900) + f.settleWindow); },
    limits() {
      const v = this.vault;
      if (!v) return "—";
      return `${fmtUsdc(this.flow().minRequestUsdc)} to ${fmtUsdc(v.maxRequestUsdc)} a request · ${fmtUsdc(v.tvlCapUsdc)} vault cap`;
    },
    fees() { return this.vault ? `Entry ${fmtFee(this.vault.entryFeeBps)} · Exit ${fmtFee(this.vault.exitFeeBps)}` : "—"; },
    contractsLabel() { return MANIFEST.fund ? `Vault ${shortAddr(MANIFEST.fund)} · Queue ${shortAddr(MANIFEST.queue)}` : "Not on Base yet"; },
    // The (i) beside a row or a step (.rm-tip, components.css): what the label
    // means, so the panel does not spend a sentence under it (David, 17 Nov).
    receiveTip() { return "At today's price. The batch sets the price your deposit buys at."; },
    redeemReceiveTip() { return "At today's price, after the exit fee. The batch sets the price your rmFUND sells at."; },
    cancelTip(kind = "deposit") { return `Until then, cancelling returns your ${kind === "deposit" ? "USDC" : "rmFUND"}. After it, the request is locked for its batch.`; },
    batchTip() { return `A batch runs every ${this.epochLabel()}. It sets the price and fills the requests locked before it.`; },
    arriveTip() { return `New rmFUND is held for ${this.holdLabel()} after its batch, then arrives in your wallet.`; },
    usdcReadyTip() { return "Once its batch fills your request, the USDC is yours to claim."; },
    priceTip() { return "The price comes from the vault's holdings at market prices, after requests lock. Only the difference between deposits and redemptions trades in the market."; },
    landTip() { return `A large deposit can fill over several batches. Anything unfilled after ${this.expiryLabel()} is yours to take back.`; },
    // The queue, for every depositor (chain.js `queue`).
    queue() { return this.vault?.queue || null; },
    queueBatchLast() { const t = this.queue()?.lastBatchAt; return t ? fmtWhenIn(t, this.now) : "None yet"; },
    /**
     * The cycle of the next batch, for the Queue block's line: from the start of
     * the hour whose requests it fills, through the moment they lock and the
     * hour's end, to the batch itself (settleWindow after). Percentages place
     * the marks; `fill` is how far along now is.
     */
    batchClock() { return fmtClock(this.cycle().batch - this.tick); },
    cycle() {
      const f = this.flow(), now = this.now, W = f.settleWindow * 1000;
      const e = epochOf(now - W, f);
      const start = epochEndAt(e - 1, f), end = epochEndAt(e, f), batch = end + W, lock = end - (f.cancelBuffer ?? 900) * 1000;
      const pct = (t) => Math.max(0, Math.min(100, ((t - start) / (batch - start)) * 100));
      return { start, end, batch, lock, fill: pct(now), lockAt: pct(lock), endAt: pct(end), locked: now >= lock, ended: now >= end, toBatch: fmtCountdown(batch - now) };
    },
    /** When a due batch is more than 10 minutes late, the time it was due; else null. */
    batchLate() {
      if (!this.queue()?.batchDue) return null;
      const f = this.flow();
      const due = epochEndAt(epochOf(this.now, f) - 1, f) + f.settleWindow * 1000;
      return this.now - due > 600_000 ? due : null;
    },
    requestsSummary() { const c = this.reqCounts; return c.ready ? `${c.ready} ready to claim` : c.open ? `${c.open} open` : ""; },
    /** What stops the vault right now, in words (describe.js); null when nothing does. */
    stop() { return stopOf(this.vault); },

    // ── Wallet ───────────────────────────────────────────────────────────
    connected() { this.rev; return session.connected(); },
    onBase() { this.rev; return session.onBase(); },
    address() { this.rev; return session.acct.address; },
    short() { return shortAddr(this.address()); },
    walletName() { this.rev; return session.acct.walletName; },
    walletLoading() { this.rev; return session.walletLoading; },
    restoring() { this.rev; return session.restoring && !session.connected(); },
    walletError() { this.rev; return session.walletError; },
    connect() { session.connect(); },
    useTestAddress() { session.useTestAddress(); },
    switchToBase() { session.switchToBase(); },
    disconnect() { this.menuOpen = false; session.disconnect(); },
    explorerAddress() { return `${MANIFEST.explorer}/address/${this.address()}`; },
    async refreshAccount() {
      if (!session.connected() || !session.onBase()) { this.acctData = null; return; }
      try {
        const src = await session.src();
        const a = await src.account(session.acct.address);
        a.eth = await session.ethBalance(session.acct.address);
        this.acctData = a;
        // Where this wallet's requests stand, for the row that leads to Your requests.
        const rs = await src.requestsOf(session.acct.address);
        const t = session.now();
        this.reqCounts = {
          open: rs.filter((r) => !r.closed || r.fills.some((x) => !x.claimed)).length,
          ready: rs.filter((r) => [STAGE.READY, STAGE.TAKE_BACK].includes(stageOf(r, t, this.flow()).stage) || canWithdrawExpired(r)).length,
        };
      } catch (e) { console.error(e); }
    },
    async copyAddress() { try { await navigator.clipboard.writeText(this.address()); this.copied = true; setTimeout(() => (this.copied = false), 2000); } catch { /* blocked */ } },
    inQueue() { const a = this.acctData; return a ? a.queuedShares : 0; },

    // ── Deposit form ─────────────────────────────────────────────────────
    amountN() { return num(this.amount); },
    setMax() {
      const a = this.acctData, v = this.vault;
      if (!a || !v) return;
      const options = [
        { v: a.usdc, why: "Max is your whole balance." },
        { v: v.maxRequestUsdc, why: `Max is the largest request, ${fmtUsdc(v.maxRequestUsdc)}.` },
        { v: this.room() ?? Infinity, why: `Max is the vault's remaining capacity, ${fmtUsdc(this.room())}.` },
      ];
      const m = options.reduce((best, o) => (o.v < best.v ? o : best));
      this.amount = String(floorTo(m.v, 2));
      this.$nextTick(() => { this.maxWhy = m.why; });
    },
    amountError() {
      const n = this.amountN(), v = this.vault, a = this.acctData;
      if (!this.amount || !v) return "";
      if (!(n > 0)) return "Enter an amount in USDC.";
      if (n < this.flow().minRequestUsdc) return `The smallest request is ${fmtUsdc(this.flow().minRequestUsdc)}.`;
      if (n > v.maxRequestUsdc) return `The largest request is ${fmtUsdc(v.maxRequestUsdc)}.`;
      if (n > (this.room() ?? Infinity)) return `The vault can take ${fmtUsdc(this.room())} more.`;
      if (a && n > a.usdc + 1e-9) return `This wallet holds ${fmtUsdc(a.usdc)}.`;
      return "";
    },
    async loadQuote() {
      const n = this.amountN();
      if (!(n > 0) || this.amountError()) { this.dq = null; return; }
      this.dqLoading = true;
      try { const src = await session.src(); this.dq = await src.quoteDeposit(n); } catch (e) { console.error(e); this.dq = null; }
      this.dqLoading = false;
    },
    /** About how many shares, at today's price. Not binding: the batch sets the price (D17). */
    estShares(n = this.amountN()) { const p = this.vault?.priceUsdc; return n > 0 && p ? fmtRm(floorTo(n / p, 4)) : "—"; },
    timeline() { return timelineFor(this.now, this.flow()); },
    lockAt() { return this.dq?.lockAt ?? this.timeline().lockAt; },
    nextBatch() { return fmtWhenIn(this.dq?.settlesAt ?? this.timeline().settlesAt, this.now); },
    sharesArrive() { return fmtWhenIn(this.dq?.readyAt ?? this.timeline().sharesAt, this.now); },
    /** A time and how far off it is: "14:45 · in 35 min". */
    when(ms) { this.now; return fmtWhenIn(ms, this.now); },
    canReview() { return this.connected() && this.onBase() && this.vault?.depositsOpen && this.amountN() > 0 && !this.amountError() && this.dq && !this.dqLoading; },

    // ── Redeem form ──────────────────────────────────────────────────────
    sharesN() { return num(this.shares); },
    heldShares() { return this.acctData?.shares ?? 0; },
    redeemMax() { this.shares = String(floorTo(this.heldShares(), 4)); },
    redeemError() {
      const n = this.sharesN();
      if (!this.shares) return "";
      if (!(n > 0)) return "Enter a number of shares.";
      if (n > this.heldShares() + 1e-9) return `You hold ${fmtRm(this.heldShares())}.`;
      if (this.exitMode === "queue" && this.vault && n * this.vault.priceUsdc < this.flow().minRequestUsdc && Math.abs(n - this.heldShares()) > 1e-4) return `The smallest redemption is ${fmtUsdc(this.flow().minRequestUsdc)}, unless you redeem everything.`;
      return "";
    },
    async loadRedeemQuote() {
      const n = this.sharesN();
      if (!(n > 0) || this.redeemError() || this.exitMode !== "queue") { this.rq = null; return; }
      try { const src = await session.src(); this.rq = await src.quoteRedeem(n); } catch (e) { console.error(e); this.rq = null; }
    },
    exitFeeBps() { return this.rq?.feeBps ?? this.vault?.exitFeeBps ?? 0; },
    /** About how much USDC, at today's price, after the exit fee. Not binding. */
    estUsdc(n = this.sharesN()) { const p = this.vault?.priceUsdc; return n > 0 && p ? fmtUsdc(floorTo(n * p * (1 - this.exitFeeBps() / 10_000), 2)) : "—"; },
    redeemLockAt() { return this.rq?.lockAt ?? this.timeline().lockAt; },
    inKindLegs() { this.rev; const n = this.sharesN(); return n > 0 && session.simulated ? session.source.inKindLegs(n) : []; },
    inKindSummary() {
      const legs = this.inKindLegs();
      const usdc = legs.filter((l) => l.pays === "USDC").reduce((t, l) => t + l.amount, 0);
      const rest = legs.filter((l) => l.pays !== "USDC").map((l) => ({ key: l.pays, label: l.pays, amount: l.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }) }));
      return legs.length ? [{ key: "USDC", label: "USDC", amount: usdc.toLocaleString("en-US", { maximumFractionDigits: 2 }) }, ...rest] : [];
    },
    canRedeem() {
      const v = this.vault;
      if (!this.connected() || !this.onBase() || !v || !(this.sharesN() > 0) || this.redeemError()) return false;
      return this.exitMode === "inkind" ? !!v.windDown : !v.windDown && !v.queuePaused && !!this.rq;
    },

    // ── The dialog ───────────────────────────────────────────────────────
    async openReview(kind) {
      await this.refreshAccount();
      const a = this.acctData;
      const from = session.acct.address;
      let calls, quote = null, amount;
      if (kind === "deposit") {
        amount = this.amountN();
        quote = this.dq;
        calls = buildDeposit({ usdc: amount, owner: from, allowance: a?.usdcAllowance ?? 0n });
      } else if (kind === "redeem") {
        amount = this.sharesN();
        quote = this.rq;
        calls = buildRedeem({ shares: amount, owner: from, allowance: a?.shareAllowance ?? 0n });
      } else {
        amount = this.sharesN();
        calls = buildExitInKind(amount, from);
      }
      const batch = calls.length > 1 && !calls.some((c) => c.gas) && !session.simulated && (await session.wallet.canBatch());
      this.dlg = { open: true, kind, phase: "review", checks: [], calls, steps: calls.map((c) => ({ label: c.label, state: "idle", hash: "" })), batch, error: "", ack: false, result: null, quote, amount };
      session.accountSwitched = false;
      this.$nextTick(() => this.$refs.dlgTitle?.focus());
      this.runChecks();
    },
    async runChecks() {
      const a = this.acctData || {};
      const d = this.dlg;
      const eth = a.eth ?? 0;
      const checks = [{ key: "base", ok: session.onBase(), text: "On Base" }];
      if (d.kind === "deposit") {
        const enough = (a.usdc ?? 0) + 1e-9 >= d.amount;
        checks.push({ key: "usdc", ok: enough, text: `${fmtUsdc(d.amount)} in your wallet`, aside: fmtUsdc(a.usdc), note: !enough && a.usdbc > 0 ? "This wallet holds USDbC, the older bridged USDC. The vault takes native USDC." : "" });
      } else {
        checks.push({ key: "shares", ok: (a.shares ?? 0) + 1e-9 >= d.amount, text: `${fmtRm(d.amount)} in your wallet`, aside: fmtShares(a.shares) });
      }
      checks.push({ key: "eth", ok: eth >= MIN_ETH, text: "ETH for the network fee", aside: eth >= MIN_ETH ? "" : "None", note: eth >= MIN_ETH ? "" : `Base charges its network fee in ETH, and this wallet has none. Send a little ETH on Base to ${shortAddr(session.acct.address)}; this checks again on its own.` });
      if (d.calls.length === 1 && !session.simulated) {
        try { await session.wallet.simulate(d.calls[0]); checks.push({ key: "sim", ok: true, text: "It goes through in a dry run" }); }
        catch (e) { checks.push({ key: "sim", ok: false, text: "It goes through in a dry run", note: session.wallet.errorText(e) }); }
      }
      this.dlg.checks = checks;
      if (checks.some((c) => !c.ok)) setTimeout(() => { if (this.dlg.open && this.dlg.phase === "review") this.refreshAccount().then(() => this.runChecks()); }, 10_000);
    },
    failedChecks() { return this.dlg.checks.filter((c) => !c.ok); },
    checksOk() { return this.dlg.checks.length > 0 && this.dlg.checks.every((c) => c.ok); },
    needsAck() { return this.dlg.kind === "deposit" && !session.acked(); },
    accountSwitched() { this.rev; return session.accountSwitched; },
    canConfirm() { return this.checksOk() && (!this.needsAck() || this.dlg.ack) && !this.accountSwitched(); },
    async confirm() {
      if (!this.canConfirm()) return;
      // The dialog can be closed while Base confirms ("Close and keep waiting"),
      // and a new review replaces this.dlg; this send writes only to its own.
      const d = this.dlg;
      if (d.kind === "deposit") session.saveAck();
      d.phase = "signing";
      d.error = "";
      try {
        const hash = await session.send(d.calls, {
          label: d.calls.at(-1).label,
          onStep: (i, state, h) => { d.steps[i].state = state; if (h) d.steps[i].hash = h; },
        });
        const src = await session.src();
        // The new request's id: from the transaction's own log on chain, from the list in the simulator.
        const id = d.kind === "inkind" ? null : session.simulated ? (await src.requestsOf(session.acct.address))[0]?.id : await session.requestIdOf(hash);
        d.result = { hash, id: id || null };
        d.phase = "requested";
        if (d.kind === "deposit") { this.amount = ""; this.dq = null; } else { this.shares = ""; this.rq = null; }
        this.refreshAccount(); this.loadVault();
        if (d === this.dlg && d.open) this.$nextTick(() => this.$refs.dlgTitle?.focus());
      } catch (e) {
        d.error = e.message;
        d.steps.forEach((st) => { if (st.state !== "done") st.state = "idle"; });
      }
    },
    /** Back to review with only what is left to sign: a confirmed approval is not asked for twice. */
    retry() {
      const d = this.dlg;
      const left = d.steps.map((st) => st.state !== "done");
      d.calls = d.calls.filter((_, i) => left[i]);
      d.steps = d.steps.filter((_, i) => left[i]);
      d.batch = d.batch && d.calls.length > 1;
      d.phase = "review"; d.error = "";
      this.refreshAccount().then(() => this.runChecks());
    },
    closeDialog() { if (this.dlg.phase === "signing" && !this.dlg.error) return; this.dlg.open = false; },
    stepWords(st) { return { idle: "", wallet: "Waiting for your wallet", sent: "Sent, waiting for Base", done: "Confirmed" }[st.state] || ""; },
    signingLede() {
      const d = this.dlg;
      const what = d.kind === "deposit" ? `${fmtUsdc(d.amount)} to the Robot Money queue` : d.kind === "redeem" ? `${fmtRm(d.amount)} to the Robot Money queue` : `${fmtRm(d.amount)} out of the vault`;
      return `Your wallet shows the request. Check that it is for ${what}, then confirm.`;
    },
    /** What closing now leaves behind, as one line and its (i) (board 4's footnote, board 16). */
    closeNote() {
      const st = this.dlg.steps;
      if (st.some((s) => s.state === "sent")) return { text: "Already sent. Closing this does not stop it.", tip: "Your requests shows it once Base confirms it." };
      const approved = st.some((s, i) => s.state === "done" && this.dlg.calls[i]?.functionName === "approve");
      return approved ? { text: "Close now and nothing more is requested.", tip: "The approval stays until you use it or revoke it in your wallet." } : { text: "Close now and nothing is requested.", tip: "" };
    },
    /** The (i) on a wallet step in What happens next (board 3). */
    callTip(c) {
      const both = this.dlg.batch ? " Your wallet shows both steps as one confirmation: they go through together, or not at all." : "";
      if (c.functionName === "approve") return `Only the Robot Money queue can spend it.${both}`;
      if (c.functionName === "redeemInKind") return "Settled at once, straight from the vault.";
      return both.trim();
    },
    /** When an unfilled remainder of a request made now can be taken back (deposit) or given notice (redemption). */
    expiresAt() { return expiresAtOf(epochOf(this.now, this.flow()), this.flow()); },
    dlgTitle() {
      const d = this.dlg;
      if (d.phase === "review") return d.kind === "deposit" ? "Review deposit" : d.kind === "redeem" ? "Review redemption" : "Review exit in kind";
      if (d.phase === "signing") return d.error ? "Nothing more was sent" : "Confirm in your wallet";
      return d.kind === "deposit" ? "Deposit requested" : d.kind === "redeem" ? "Redemption requested" : "Exit in kind done";
    },
    statusLink() { return this.dlg.result?.id ? `/deposit/requests/${this.dlg.result.id}` : "/deposit/requests"; },
    statusUrl() { return `${location.origin}${this.statusLink()}`; },
    async copyStatus() { try { await navigator.clipboard.writeText(this.statusUrl()); this.copied = true; setTimeout(() => (this.copied = false), 2000); } catch { /* blocked */ } },
    readyIn() { const q = this.dlg.quote; return q ? fmtCountdown(q.readyAt - this.now) : ""; },
    track() {
      const q = this.dlg.quote;
      if (!q) return [];
      const nowWhen = fmtWhen(this.now).split(" · ")[1];
      if (this.dlg.kind === "deposit") return [
        { key: "r", label: "Requested", when: nowWhen, done: true },
        { key: "b", label: "Next batch", when: fmtWhenShort(q.settlesAt), done: false },
        { key: "h", label: "Held", when: this.holdLabel(), done: false },
        { key: "a", label: "Shares arrive", when: fmtWhenShort(q.readyAt), done: false, money: true },
      ];
      return [
        { key: "r", label: "Requested", when: nowWhen, done: true },
        { key: "b", label: "Next batch", when: fmtWhenShort(q.settlesAt), done: false },
        { key: "a", label: "USDC ready", when: fmtWhenShort(q.readyAt), done: false, money: true },
      ];
    },

    fmtUsdc, fmtShares, fmtRm, fmtPrice, fmtWhen, fmtWhenShort, fmtFee, shortHash, floorTo, tokenIcon,
    hashUrl(h) { return h && /^0x[0-9a-f]{64}$/i.test(h) && !session.simulated ? `${MANIFEST.explorer}/tx/${h}` : null; },

    // ── Simulation controls ──────────────────────────────────────────────
    simulated() { return session.simulated; },
    simClock() { this.now; return fmtWhen(this.now); },
    simAhead() { const h = Math.round((this.now - Date.now()) / 3_600_000); return h > 0 ? `${h} h ahead` : "Real time"; },
    simNext() { session.source.toNextBatch(); },
    simAdvance(h) { session.source.advance(h * 3_600_000); },
    simReset() { session.source.reset(); this.resetAsk = false; },
    simState() { this.rev; return session.simulated ? session.source.stopped() : { deposits: false, windDown: false, blocked: false }; },
    simToggleDeposits() { session.source.setDepositsStopped(!this.simState().deposits); },
    simToggleWindDown() { session.source.setWindDown(!this.simState().windDown); },
    simToggleBlocked() { session.source.setBatchesBlocked(!this.simState().blocked); },
  }));
}
