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
import { addrHref, copyAddr } from "../../lib/deposit/addr.js";
import { buildDeposit, buildRedeem, buildExitInKind } from "../../lib/deposit/builder.js";
import { depositWait, redeemWait, fmtDuration, fmtCountdown, fmtWhenIn, fmtClock, fmtAt, timelineFor, expiresAtOf, epochOf, epochEndAt } from "../../lib/deposit/schedule.js";
import { nextBatchFor, stageOf, canWithdrawExpired, STAGE } from "../../lib/deposit/stages.js";
import { fmtUsdc, fmtUsdcFine, fmtShares, fmtRm, fmtPrice, fmtBps, fmtFee, floorTo, fmtWhen, fmtWhenShort, shortAddr, shortHash } from "../../lib/deposit/format.js";
import { isOpen, tryCode, bodyOf } from "../../lib/deposit/access.js";
import { stopOf } from "../../lib/deposit/describe.js";
import { tokenIcon } from "../../lib/deposit/tokens.js";
import { CATEGORICAL } from "../../lib/chart-theme.js";
import { sessionSummary } from "../../lib/session-summary.js";
import * as weightChange from "../../lib/weight-change.js";

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
    // Max remembers the exact balance it stood for, used while the field still reads what Max wrote.
    maxRaw: null,
    exitMode: "queue",
    rq: null,

    // The one dialog: review → signing → requested (boards 3 to 5).
    dlg: { open: false, kind: "deposit", phase: "review", checks: [], calls: [], steps: [], batch: false, error: "", ack: false, result: null, quote: null, amount: 0 },

    resetAsk: false,
    _t: null,
    _unsub: null,

    async init() {
      this.now = session.now();
      // /deposit?action=redeem opens on Redeem (the Redeem button on Your position).
      if (new URLSearchParams(location.search).get("action") === "redeem") this.tab = "redeem";
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
    // The explorer's rows (lib/sleeve-explorer.js): each holding at its actual
    // weight, named so the three lending positions tell apart in a legend.
    explorerRows() {
      return this.holdings().map((h) => ({ key: h.key, label: h.label === "USDC lending" ? `USDC on ${h.venueLabel}` : h.label, hue: h.hue, pct: h.actualBps / 100 }));
    },
    explorerSvg() { return sessionSummary.ringSvg(this.explorerRows().map((r) => ({ key: r.key, label: r.label, pct: r.pct, colour: r.hue }))); },
    /** At rest the centre names the largest holding. */
    explorerCenter() {
      const top = [...this.explorerRows()].sort((a, b) => b.pct - a.pct)[0];
      return top && top.pct > 0 ? { value: this.fmtPctTrim(top.pct), label: top.label } : { value: "", label: "" };
    },
    explorerLabel() { return this.explorerRows().filter((r) => r.pct > 0).map((r) => `${r.label} ${this.fmtPctTrim(r.pct)}`).join(", "); },
    fmtPctTrim(v) { return weightChange.fmtPctTrim(v); },
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
    fundAddr() { return MANIFEST.fund || null; },
    queueAddr() { return MANIFEST.queue || null; },
    // The (i) beside a row or a step (.rm-tip, components.css): what the label
    // means, so the panel does not spend a sentence under it (David, 17 Nov).
    receiveTip() { return "At today's price. The batch sets the price your deposit buys at."; },
    redeemReceiveTip() { return "At today's price, after the exit fee. The batch sets the price your rmFUND sells at."; },
    cancelTip(kind = "deposit", at = Infinity) {
      if (at <= this.now) return `A request made in the last ${Math.round((this.flow().cancelBuffer ?? 900) / 60)} minutes of the hour joins that hour's batch already locked.`;
      return `Until ${fmtAt(at, this.now)}. Cancelling returns your ${kind === "deposit" ? "USDC" : "rmFUND"}; after that, the request is locked for its batch.`;
    },
    /** The cancel deadline of a request made now. Past it, a new request still joins this batch, locked from the start. */
    cancelKv(at) { return at > this.now ? { label: "You can cancel for", value: this.soon(at) } : { label: "Cancelling", value: "Closed for this batch" }; },
    // The panel's time rows read "~12 min"; the exact time is in the tooltip (David, 25 Nov). Tips stay within two lines.
    batchAt() { return this.dq?.settlesAt ?? this.timeline().settlesAt; },
    sharesAt() { return this.dq?.readyAt ?? this.timeline().sharesAt; },
    usdcAt() { return this.rq?.readyAt ?? this.timeline().settlesAt; },
    batchTip() { const every = this.flow().epochLength === 3600 ? "hour" : this.epochLabel(); return `At ${fmtAt(this.batchAt(), this.now)}. A batch runs every ${every}: it sets the price and fills the requests waiting for it.`; },
    arriveTip() { return `Expected at ${fmtAt(this.sharesAt(), this.now)}, ${this.holdLabel()} after its batch. One signature then moves the rmFUND into your wallet.`; },
    usdcReadyTip() { return `Expected at ${fmtAt(this.usdcAt(), this.now)}, when the batch fills your request. The USDC is then yours to claim.`; },
    /** How far off a time is, as an estimate: "~12 min", "~1 h 39 min". */
    soon(ms) {
      this.now;
      if (ms == null || !Number.isFinite(ms)) return "—";
      const d = ms - this.now;
      return d <= 0 ? "Any minute" : d < 60_000 ? "~1 min" : `~${fmtDuration(d / 1000)}`;
    },
    /** The exit fee in USDC as well as in percent: "~0.002 USDC · 0.1%". @param {number} n shares @param {number|null|undefined} bps */
    exitFeeSays(n, bps) {
      if (bps == null) return "—";
      if (bps === 0) return "None";
      const p = this.vault?.priceUsdc;
      return n > 0 && p ? `~${fmtUsdcFine((n * p * bps) / 10_000)} · ${fmtFee(bps)}` : fmtFee(bps);
    },
    exitFeeTip(n, bps) {
      if (!bps) return "This vault charges no exit fee.";
      const base = `${fmtFee(bps)} of the USDC the batch pays you for your rmFUND.`;
      return n > 0 ? `${base} At today's price, that is about ${fmtShares((n * bps) / 10_000)} rmFUND.` : base;
    },
    priceTip() { return "Set from the holdings at market prices, after requests lock. Only the net of deposits and redemptions trades."; },
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
    /** A time and how far off it is: "14:45 · in 35 min". */
    when(ms) { this.now; return fmtWhenIn(ms, this.now); },
    canReview() { return this.connected() && this.onBase() && this.vault?.depositsOpen && this.amountN() > 0 && !this.amountError() && this.dq && !this.dqLoading; },

    // ── Redeem form ──────────────────────────────────────────────────────
    sharesN() { return num(this.shares); },
    heldShares() { return this.acctData?.shares ?? 0; },
    redeemMax() { this.shares = String(floorTo(this.heldShares(), 4)); this.maxRaw = { text: this.shares, raw: this.acctData?.sharesRaw ?? null }; },
    /** What the redemption sends: the exact balance after Max, else the typed number. */
    sharesArg() { return this.maxRaw?.raw != null && this.maxRaw.text === this.shares ? this.maxRaw.raw : this.sharesN(); },
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
        calls = buildRedeem({ shares: this.sharesArg(), owner: from, allowance: a?.shareAllowance ?? 0n });
      } else {
        amount = this.sharesN();
        calls = buildExitInKind(this.sharesArg(), from);
      }
      const batch = calls.length > 1 && !calls.some((c) => c.gas) && !session.simulated && (await session.wallet.canBatch());
      // total: the steps the eyebrow counts, review plus each wallet confirmation; skip: confirmations already done before a retry.
      this.dlg = { open: true, kind, phase: "review", checks: [], calls, steps: calls.map((c) => ({ label: c.label, state: "idle", hash: "" })), batch, error: "", ack: false, result: null, quote, amount, total: 1 + (batch ? 1 : calls.length), skip: 0 };
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
        d.result = { hash, id: id || null, at: this.now };
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
      d.skip += left.filter((x) => !x).length;
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
      if (st.some((s) => s.state === "sent")) return { text: "Already sent. Closing this does not stop it.", tip: "Your position shows it once Base confirms it." };
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
    /** The three steps after a request (David, 25 Nov): made, its batch, ready to claim. Times as estimates; the exact one on hover. */
    track() {
      const d = this.dlg, q = d.quote;
      if (!q) return [];
      const dep = d.kind === "deposit";
      return [
        { key: "r", label: "Requested", when: fmtAt(d.result?.at ?? this.now, this.now), title: "", cls: "is-now" },
        { key: "b", label: "Next batch", when: this.soon(q.settlesAt), title: fmtWhen(q.settlesAt), cls: "" },
        { key: "a", label: dep ? "rmFUND ready to claim" : "USDC ready to claim", when: dep ? this.soon(q.readyAt) : "Right after", title: fmtWhen(q.readyAt), cls: "is-money" },
      ];
    },
    /** "Step 2 of 3": review, then each wallet confirmation. Hidden once requested. */
    stepLabel() {
      const d = this.dlg;
      if (!d.total || d.total < 2 || d.phase === "requested") return "";
      if (d.phase === "review") return `Step 1 of ${d.total}`;
      const at = d.batch ? 0 : d.steps.findIndex((s) => s.state !== "done");
      const i = at < 0 ? d.steps.length - 1 : at;
      return `Step ${Math.min(d.total, 2 + d.skip + i)} of ${d.total}`;
    },
    /** What the wallet will ask, in one line. */
    walletLine() {
      const d = this.dlg;
      if (d.kind === "inkind") return "Your wallet asks for one signature. It settles at once, straight from the vault.";
      if (d.batch) return "Your wallet asks for one confirmation: the approval and the request go through together.";
      const appr = d.calls.find((c) => c.functionName === "approve");
      return appr ? `Your wallet asks for two signatures: ${appr.label.replace(/^Approve/, "approve")}, then the request.` : "Your wallet asks for one signature: the request.";
    },
    walletTip() { return this.dlg.calls.some((c) => c.functionName === "approve") ? "The approval lets only the Robot Money queue move that amount, nothing more." : ""; },
    dlgEstTip() {
      return this.dlg.kind === "deposit"
        ? `At today's share price, ${this.price()}. The batch sets the price you buy at.`
        : `At today's share price, ${this.price()}, after the exit fee. The batch sets the price you sell at.`;
    },
    dlgReadyTip() {
      const d = this.dlg, q = d.quote, f = this.flow();
      if (!q) return "";
      const span = fmtDuration(f.maxRoll * f.epochLength);
      return d.kind === "deposit"
        ? `At ${fmtAt(q.readyAt, this.now)}: the ${fmtAt(q.settlesAt, this.now)} batch buys it, then a ${this.holdLabel()} wait. Unfilled after ${span}? The USDC can come back.`
        : `At ${fmtAt(q.readyAt, this.now)}, when the next batch fills it at its price. Unfilled after ${span}? You can ask for it back.`;
    },
    /** "after a ~0.002 USDC exit fee", for the review's estimate line. */
    exitFeeWords(n, bps) {
      if (bps == null) return "after the exit fee";
      if (bps === 0) return "with no exit fee";
      const p = this.vault?.priceUsdc;
      return p ? `after a ~${fmtUsdcFine((n * p * bps) / 10_000)} exit fee` : `after a ${fmtFee(bps)} exit fee`;
    },
    /**
     * Eases the dialog's height from one step to the next instead of jumping
     * (David, 25 Nov). Watches the inner wrapper, animates the box: animating
     * what is watched would feed itself.
     * @param {HTMLElement} box
     */
    easeDialog(box) {
      const inner = box.firstElementChild;
      if (!inner || typeof ResizeObserver === "undefined") return;
      let last = 0;
      new ResizeObserver(() => {
        const h = box.offsetHeight;
        if (last && h && Math.abs(h - last) > 2 && this.dlg.open && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
          box.style.overflowY = "hidden";
          const a = box.animate([{ height: `${last}px` }, { height: `${h}px` }], { duration: 280, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
          a.onfinish = a.oncancel = () => { box.style.overflowY = ""; };
        }
        last = h;
      }).observe(inner);
    },

    fmtUsdc, fmtShares, fmtRm, fmtPrice, fmtWhen, fmtWhenShort, fmtFee, shortHash, shortAddr, floorTo, tokenIcon, addrHref, copyAddr,
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
