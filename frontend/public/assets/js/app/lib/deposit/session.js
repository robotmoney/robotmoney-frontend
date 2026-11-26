// @ts-check
// The deposit session (RM-146): one per page load, shared by /deposit, Your
// requests and the status page. It holds the wallet, the connected account,
// and the data source (the live vault through chain.js, or the simulator while
// the manifest has no addresses), and it owns the send path the design review
// asked for (canvas boards 21 to 25):
//   checks before the wallet opens → one confirmation where the wallet can
//   batch, else one call after another → a sent transaction kept in this
//   browser until it is mined, so a reload or a trip to a mobile wallet picks
//   it back up.

import { MANIFEST, isSimulated } from "./manifest.js";
import { REQUEST_TOPICS } from "./abi.js";
import { sharedSimQueue } from "./sim-queue.js";
import { createChainSource } from "./chain.js";
import { loadWallet, errorText } from "./wallet.js";

const PENDING_KEY = "rm-deposit-pending-v1";
const ACK_KEY = "rm-deposit-ack-v1";
const TEST_ADDRESS = "0x7e57000000000000000000000000000000c0ffee";
const TEST_KEY = "rm-deposit-test-address";
/** Enough ETH for a few calls on Base (fees are a fraction of a cent). */
export const MIN_ETH = 0.00002;

const listeners = new Set();
const emit = () => listeners.forEach((cb) => cb());
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const isLocal = () => /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(location.hostname);
/** Whether this browser had a wallet connected last time, so the kit will reconnect it (AppKit and wagmi storage). */
const hadWallet = () => { try { return localStorage.getItem("@appkit/connection_status") === "connected" || !!localStorage.getItem("wagmi.recentConnectorId"); } catch { return false; } };

export const session = {
  simulated: isSimulated(),
  /** @type {any} */ wallet: null,
  /** @type {any} */ source: isSimulated() ? sharedSimQueue() : null,
  acct: { address: null, chainId: null, walletName: "", isSafe: false, testAddress: false },
  walletLoading: false,
  walletError: "",
  /**
   * True from page load until the kit has reconnected a wallet this browser
   * used before (or found none): the pages show a placeholder, not a "Connect
   * wallet" that vanishes a second later.
   */
  restoring: !isSimulated() && hadWallet(),
  rev: 0,

  subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  bump() { this.rev++; emit(); },
  now() { return this.source?.now ? this.source.now() : Date.now(); },
  connected() { return !!this.acct.address; },
  onBase() { return this.acct.testAddress || this.acct.chainId === MANIFEST.chainId; },

  /** Load the wallet kit (and, live, the chain source). Safe to call repeatedly. */
  async ready() {
    if (this.wallet) return this.wallet;
    this.wallet = await loadWallet();
    if (!this.simulated) this.source = createChainSource(this.wallet);
    this.wallet.onChange((a) => this.setAccount(a));
    this.setAccount(this.wallet.account());
    // A reconnect that never settles must not hold the page in its placeholder.
    setTimeout(() => { if (this.restoring) { this.restoring = false; this.bump(); } }, 8000);
    return this.wallet;
  },
  async connect() {
    this.walletError = ""; this.walletLoading = true; this.restoring = false; this.bump();
    try {
      await this.ready();
      if (!this.acct.address) await this.wallet.open();
    } catch (e) {
      console.error(e);
      this.walletError = "The wallet kit did not load. Check your connection and try again.";
    } finally { this.walletLoading = false; this.bump(); }
  },
  /** Simulation only: walk the flow without a wallet. */
  useTestAddress() {
    this.acct = { address: TEST_ADDRESS, chainId: MANIFEST.chainId, walletName: "Test address", isSafe: false, testAddress: true };
    try { sessionStorage.setItem(TEST_KEY, "1"); } catch { /* this page only */ }
    this.bump();
  },
  setAccount(a) {
    const prev = this.acct.address;
    if (this.acct.testAddress && !a.address) return;
    this.acct = { address: a.address, chainId: a.chainId, walletName: a.walletName, isSafe: a.isSafe, testAddress: false };
    // Connected ends the reconnect at once. The kit can report "disconnected" for
    // a moment before its reconnect starts, so that ends it only if it lasts.
    if (a.status === "connected") this.restoring = false;
    else if (a.status === "disconnected" && this.restoring) setTimeout(() => { if (this.restoring && !this.acct.address) { this.restoring = false; this.bump(); } }, 1500);
    // A different account mid-flow: whatever was being reviewed was for the old one.
    if (prev && a.address && prev.toLowerCase() !== a.address.toLowerCase()) this.accountSwitched = true;
    this.bump();
  },
  accountSwitched: false,
  async switchToBase() {
    try { await this.wallet.switchToBase(); } catch { this.walletError = "Your wallet did not switch. Choose Base in the wallet and try again."; this.bump(); }
  },
  async disconnect() {
    if (this.acct.testAddress) {
      this.acct = { address: null, chainId: null, walletName: "", isSafe: false, testAddress: false };
      try { sessionStorage.removeItem(TEST_KEY); } catch { /* ignore */ }
      this.bump(); return;
    }
    await this.wallet?.disconnect();
  },

  /** The source, loading the kit first when live. */
  async src() { if (!this.source) await this.ready(); return this.source; },

  /** ETH for fees: real on chain, the simulator's otherwise. */
  async ethBalance(address) {
    if (this.simulated) return (await this.source.account(address)).eth ?? 1;
    return this.wallet.ethBalance(address);
  },

  /** Acknowledgement, per wallet, in this browser (Legal board 19: counsel may want a record elsewhere). */
  acked(address = this.acct.address) {
    try { return !!JSON.parse(localStorage.getItem(ACK_KEY) || "{}")[String(address).toLowerCase()]; } catch { return false; }
  },
  saveAck(address = this.acct.address) {
    try { const all = JSON.parse(localStorage.getItem(ACK_KEY) || "{}"); all[String(address).toLowerCase()] = Date.now(); localStorage.setItem(ACK_KEY, JSON.stringify(all)); } catch { /* per page only */ }
  },

  /**
   * Refuse to send unless the vault still runs the implementations this page
   * was reviewed against (manifest.js pins). Contracts set by hand on a local
   * host carry no pins and pass; anywhere else, no pins means no sends.
   */
  async checkPins() {
    const pins = MANIFEST.pins;
    if (!pins) {
      if (isLocal()) return;
      throw new Error("Deposits are not open on this site yet.");
    }
    const ok = (list, impl) => !!impl && list.some((p) => p.toLowerCase() === impl.toLowerCase());
    const [fund, queue] = await Promise.all([this.wallet.implementationOf(MANIFEST.fund), this.wallet.implementationOf(MANIFEST.queue)]);
    if (!ok(pins.fund, fund) || !ok(pins.queue, queue)) {
      throw new Error("The vault's contracts changed since this page was last reviewed, so nothing was sent. Deposits reopen once the new version is checked.");
    }
  },

  /**
   * The id of the request a mined transaction made, from the queue's own
   * DepositRequested / RedeemRequested log. Exact, unlike reading the owner's
   * request list right after, which a node a block behind answers without it.
   * Null when the transaction made none.
   * @param {string} hash
   */
  async requestIdOf(hash) {
    if (this.simulated || !hash) return null;
    try {
      const r = await this.wallet.receipt(hash);
      const log = (r?.logs || []).find((l) => String(l.address).toLowerCase() === String(MANIFEST.queue).toLowerCase() && REQUEST_TOPICS.includes(String(l.topics?.[0]).toLowerCase()));
      return log ? BigInt(log.topics[1]).toString() : null;
    } catch { return null; }
  },

  /** A sent transaction not yet mined, kept across reloads (board 25). */
  pending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "null"); } catch { return null; } },
  setPending(p) { try { if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p)); else localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ } this.bump(); },

  /**
   * Send prepared calls. `onStep(index, state, hash?)` reports progress:
   * state is "wallet" (waiting for a signature), "sent" (waiting for Base) or "done".
   * Resolves to the last hash. Throws a readable Error.
   * @param {any[]} calls @param {{ onStep?: Function, label?: string }} [opts]
   */
  async send(calls, opts = {}) {
    const step = opts.onStep || (() => {});
    const from = this.acct.address;
    if (!from) throw new Error("Connect a wallet first.");
    if (this.simulated) {
      let hash = "";
      for (let i = 0; i < calls.length; i++) {
        step(i, "wallet"); await pause(600);
        step(i, "sent"); await pause(500);
        hash = await this.source.execute(calls[i], from);
        step(i, "done", hash);
      }
      this.bump();
      return hash;
    }
    if (!this.onBase()) throw new Error("Switch your wallet to Base first.");
    await this.checkPins();
    try {
      if (calls.length === 1) await this.wallet.simulate(calls[0]);
      if (calls.length > 1 && !calls.some((c) => c.gas) && (await this.wallet.canBatch())) {
        calls.forEach((_, i) => step(i, "wallet"));
        const hash = await this.wallet.sendBatch(calls, (id) => { calls.forEach((_, i) => step(i, "sent")); this.setPending({ id, label: opts.label, at: Date.now(), from }); });
        calls.forEach((_, i) => step(i, "done", hash));
        this.setPending(null);
        return hash;
      }
      let hash = "";
      for (let i = 0; i < calls.length; i++) {
        step(i, "wallet");
        hash = await this.wallet.write(calls[i], (h) => { step(i, "sent", h); this.setPending({ hash: h, label: calls[i].label, at: Date.now(), from }); });
        step(i, "done", hash);
      }
      this.setPending(null);
      return hash;
    } catch (e) {
      this.setPending(null);
      throw new Error(errorText(e));
    }
  },
};

// The simulator's clock and sends change state with no wallet loaded (a test
// address never loads the kit), so every view hears it from here.
if (session.simulated) {
  session.source.subscribe(() => session.bump());
  // A test address survives a reload in this tab, as a wallet session would.
  try { if (sessionStorage.getItem(TEST_KEY)) session.useTestAddress(); } catch { /* ignore */ }
}
