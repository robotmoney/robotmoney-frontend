// @ts-check
// A simulated vault and queue for the deposit page (RM-146): the live queue's
// rules run in this browser, so the whole flow can be tested without spending
// anything. It reads like chain.js (same methods, same shapes) and it executes
// the builder's own calls (`execute`), so the page goes through exactly the
// path it takes on Base.
//
// Rules, from FlowQueue 0.9.0 (core `release-0.9.0`, proposal §5.11) with
// Deploy 4's parameters:
// - a request names a quantity, no price; it belongs to its epoch and can be
//   cancelled until `cancelBuffer` before that epoch closes, then it locks;
// - the epoch's batch runs once it has closed and the settle window passed;
// - in a batch, deposits and redemptions are matched with each other at the
//   vault's price, every request of a side by the same fraction; only the
//   difference trades in the market, oldest request first;
// - each side fills at most max(5% of the vault, the floor) per batch, matched
//   part included, so a large request fills over several batches;
// - deposit shares are held `minHold`; redemption USDC is ready at the batch,
//   less the exit fee fixed on the request;
// - cancel moves the unfilled part to a credit, taken back with
//   withdrawCredit; a deposit unfilled after `maxRoll` epochs expires and is
//   withdrawn (withdrawExpired); a redemption never expires, and after
//   `maxRoll` epochs can be given notice: it takes part in one more batch,
//   then the unfilled shares come back (claimNoticeReturn);
// - a stop of deposits keeps every deposit out of the batch and lets locked
//   deposits cancel; a blocked batch (a failed price check) rolls every
//   request to the next one; a wind-down stops every batch, releases queued
//   requests (releaseWindDown) and opens exit in kind.
// Other holders' flow is simulated too, a few hundred USDC each way a batch,
// so the match shows. The price drifts up 0.01% a batch; no entry fee, 0.1%
// exit; the wallet starts with 10,000 simulated USDC and a little ETH. State
// lives in this browser's localStorage.

import { MANIFEST, DEFAULT_FLOW } from "./manifest.js";
import { epochOf, settleableAt, expiresAtOf, lockAtOf } from "./schedule.js";
import { canCancel, canGiveNotice, liveRemaining } from "./stages.js";
import { fromUnits, SHARE_DECIMALS } from "./builder.js";

const KEY = "rm-deposit-sim-v3";
const S = 1000;
const EPS = 1e-9;
const START_USDC = 10_000;
const DRIFT = 0.0001;
const EXIT_FEE_BPS = 10;
const CAP_BPS = 500;

/** What the vault holds, by weight: the one-vault brief's example, not an allocation. */
export const SIM_HOLDINGS = Object.freeze([
  { key: "lend-1", kind: "lending", label: "USDC lending", venue: "Morpho", weight: 0.25, pays: "USDC", priceUsd: 1 },
  { key: "lend-2", kind: "lending", label: "USDC lending", venue: "Aave", weight: 0.25, pays: "USDC", priceUsd: 1 },
  { key: "lend-3", kind: "lending", label: "USDC lending", venue: "Moonwell", weight: 0.20, pays: "USDC", priceUsd: 1 },
  { key: "weth", kind: "token", label: "wETH", venue: "In the vault", weight: 0.12, pays: "wETH", priceUsd: 3_200 },
  { key: "cbbtc", kind: "token", label: "cbBTC", venue: "In the vault", weight: 0.13, pays: "cbBTC", priceUsd: 95_000 },
  { key: "idle", kind: "idle", label: "USDC, idle", venue: "In the vault", weight: 0.05, pays: "USDC", priceUsd: 1 },
]);

const fakeHash = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const lower = (a) => (a || "").toLowerCase();
/** A repeatable 0..1 per batch, so other holders' flow is the same on every reload. */
const noise = (k, salt) => { let x = (Math.imul(k, 2654435761) + salt) >>> 0; x ^= x >>> 13; x = Math.imul(x, 1274126177) >>> 0; return (x % 1000) / 1000; };

function fresh(now = Date.now()) {
  return {
    v: 3, offsetMs: 0, priceUsdc: 1.0213, tvlUsdc: 48_250, supply: 48_250 / 1.0213,
    lastSettled: epochOf(now, DEFAULT_FLOW) - 1, nextId: 1, nextClaim: 1,
    wallets: {}, requests: [], exits: [], tvlCapUsdc: 100_000, maxRequestUsdc: 25_000,
    depositsStopped: false, windDown: false, batchesBlocked: false,
  };
}
function read() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s?.v === 3) return s; } catch { /* fresh */ }
  return fresh();
}

let shared = null;
/** One simulated vault per page load, shared by every view. */
export function sharedSimQueue() { if (!shared) shared = createSimQueue(); return shared; }

export function createSimQueue() {
  let s = read();
  const flow = { ...DEFAULT_FLOW };
  const listeners = new Set();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } listeners.forEach((cb) => cb()); };
  const now = () => Date.now() + s.offsetMs;
  const wallet = (owner) => {
    const k = lower(owner);
    if (!s.wallets[k]) s.wallets[k] = { usdc: START_USDC, shares: 0, eth: 0.002, creditUsdc: 0, creditShares: 0, usdcAllow: 0, shareAllow: 0, tokens: {}, deposited: 0, redeemed: 0 };
    return s.wallets[k];
  };
  const cap = () => Math.max(s.tvlUsdc * (CAP_BPS / 10_000), MANIFEST.batchFloorUsdc);

  /** One batch: the epoch `k` round (§5.11.4). */
  function batch(k) {
    const at = settleableAt(k, flow);
    if (s.windDown) return; // In a wind-down nothing settles.
    if (s.batchesBlocked) {
      // A round a failed check keeps from running: requests roll to the next one, and a
      // noticed redemption's round still ends, so its shares come back (D25).
      for (const r of s.requests) if (r.noticeRound === k && !r.closed && r.remaining > EPS) r.noticeDone = true;
      return;
    }
    const price = s.priceUsdc;
    const takesPart = (r) => liveRemaining(r) > EPS && r.epoch <= k && (r.kind === "redeem" || at < expiresAtOf(r.epoch, flow));
    const byAge = (a, b) => a.createdAt - b.createdAt;
    const deps = s.depositsStopped ? [] : s.requests.filter((r) => r.kind === "deposit" && takesPart(r)).sort(byAge);
    const reds = s.requests.filter((r) => r.kind === "redeem" && takesPart(r)).sort(byAge);
    const othersD = s.depositsStopped ? 0 : 200 + 1200 * noise(k, 1);
    const othersR = (150 + 1000 * noise(k, 2)) / price;
    const D = deps.reduce((t, r) => t + r.remaining, 0) + othersD;
    const R = reds.reduce((t, r) => t + r.remaining, 0) + othersR;
    let roomD = cap(), roomR = cap();

    // The match (8a to 8c): M shares, every request of a side by the same fraction.
    const M = Math.min(Math.min(R, roomR / price), Math.min(D, roomD) / price);
    const fD = D > EPS ? (M * price) / D : 0;
    const fR = R > EPS ? M / R : 0;
    roomD -= M * price; roomR -= M * price;
    const part = new Map();
    for (const r of deps) part.set(r, { matched: r.remaining * fD, net: 0 });
    for (const r of reds) part.set(r, { matched: r.remaining * fR, net: 0 });

    // The net side, oldest first, inside the cap; only it changes the vault.
    if (D - M * price > EPS) {
      let room = Math.min(roomD, Math.max(0, s.tvlCapUsdc - s.tvlUsdc));
      for (const r of deps) {
        const p = part.get(r);
        const x = Math.min(r.remaining - p.matched, room);
        if (x <= EPS) continue;
        p.net = x; room -= x;
      }
      const othersNet = Math.min(othersD * (1 - fD), room);
      const netIn = deps.reduce((t, r) => t + part.get(r).net, 0) + othersNet;
      s.tvlUsdc += netIn; s.supply += netIn / price;
    } else if (R - M > EPS) {
      let room = roomR;
      for (const r of reds) {
        const p = part.get(r);
        const x = Math.min(r.remaining - p.matched, room / price);
        if (x <= EPS) continue;
        p.net = x; room -= x * price;
      }
      const othersNet = Math.min(othersR * (1 - fR), room / price);
      const netOut = reds.reduce((t, r) => t + part.get(r).net, 0) + othersNet;
      s.tvlUsdc -= netOut * price; s.supply -= netOut;
    }

    for (const [r, p] of part) {
      const x = p.matched + p.net;
      if (x <= EPS) continue;
      if (r.kind === "deposit") {
        r.fills.push({ claimId: String(s.nextClaim++), amountIn: x, out: x / price, price, matchedIn: p.matched, at, unlockAt: at + flow.minHold * S, claimed: false, left: x });
        wallet(r.owner).deposited += x;
      } else {
        const net = price * (1 - r.exitFeeBps / 10_000);
        r.fills.push({ claimId: String(s.nextClaim++), amountIn: x, out: x * net, price: net, matchedIn: p.matched, at, unlockAt: at, claimed: false, left: x });
      }
      r.remaining -= x;
      if (r.remaining <= 1e-7) { r.remaining = 0; r.closed = true; }
    }
    // A noticed redemption's batch has run: what it left unfilled comes back (§5.11.3 item 7).
    for (const r of s.requests) if (r.noticeRound === k && !r.closed && r.remaining > EPS) r.noticeDone = true;
    s.priceUsdc = +(price * (1 + DRIFT)).toFixed(6);
  }
  function settle() {
    const t = now();
    let changed = false;
    while (settleableAt(s.lastSettled + 1, flow) <= t) { s.lastSettled += 1; batch(s.lastSettled); changed = true; }
    for (const r of s.requests) {
      if (r.kind === "deposit" && liveRemaining(r) > EPS && t >= expiresAtOf(r.epoch, flow)) { r.expired = true; changed = true; }
    }
    return changed;
  }
  settle();

  const addRequest = (kind, owner, amount, hashes) => {
    const r = {
      id: String(s.nextId++), kind, owner, amount, remaining: amount, epoch: epochOf(now(), flow), createdAt: now(),
      exitFeeBps: kind === "redeem" ? EXIT_FEE_BPS : 0, closed: false, expired: false, cancelled: false,
      noticeAt: null, noticeRound: null, noticeGivenAt: null, noticeDone: false, released: false, fills: [], txs: hashes,
    };
    s.requests.push(r);
    return r;
  };
  const find = (id) => s.requests.find((r) => r.id === String(id));
  const terms = (dep) => {
    const e = epochOf(now(), flow);
    const settlesAt = settleableAt(e, flow);
    return { feeBps: dep ? 0 : EXIT_FEE_BPS, lockAt: lockAtOf(e, flow), settlesAt, readyAt: dep ? settlesAt + flow.minHold * S : settlesAt };
  };
  const deliverable = (x, t) => s.windDown || x.unlockAt <= t;

  const api = {
    simulated: true,
    now,
    flow: () => flow,
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    async vault() {
      const value = s.tvlUsdc;
      return {
        source: "sample", priceUsdc: s.priceUsdc, navAt: now(), tvlUsdc: value, tvlCapUsdc: s.tvlCapUsdc,
        maxRequestUsdc: s.maxRequestUsdc, exitFeeBps: EXIT_FEE_BPS, entryFeeBps: 0,
        depositsOpen: !s.depositsStopped && !s.windDown, depositsStopped: s.depositsStopped, stopCause: s.depositsStopped ? "paused" : "",
        depositsPausedUntil: null, queuePaused: false, queuePausedUntil: null, windDown: s.windDown, keeperSet: true,
        settleBlocked: s.batchesBlocked ? "A price feed stopped updating." : "", flow,
        queue: {
          depositUsdc: s.requests.filter((r) => r.kind === "deposit").reduce((n, r) => n + liveRemaining(r), 0),
          redeemShares: s.requests.filter((r) => r.kind === "redeem").reduce((n, r) => n + liveRemaining(r), 0),
          lastBatchAt: settleableAt(s.lastSettled, flow), batchDue: false,
        },
        holdings: SIM_HOLDINGS.map((h) => ({ key: h.key, kind: h.kind, label: h.label, venue: h.venue, active: true, valueUsdc: value * h.weight, actualBps: Math.round(h.weight * 10_000), targetBps: h.kind === "idle" ? null : Math.round(h.weight * 10_000) })),
      };
    },
    /** Terms of a deposit made now. No price: the batch sets it (D17). */
    async quoteDeposit() { return terms(true); },
    async quoteRedeem() { return terms(false); },
    async account(owner) {
      const w = wallet(owner);
      const t = now();
      const mine = s.requests.filter((r) => lower(r.owner) === lower(owner));
      return {
        usdc: w.usdc, usdbc: 0, eth: w.eth, shares: w.shares, usdcAllowance: BigInt(Math.round(w.usdcAllow * 1e6)),
        shareAllowance: BigInt(Math.round(w.shareAllow * 1e6)) * 10n ** 18n, creditUsdc: w.creditUsdc, creditShares: w.creditShares,
        queuedShares: mine.filter((r) => r.kind === "redeem" && liveRemaining(r) > EPS).reduce((n, r) => n + r.remaining, 0),
        maxDepositUsdc: mine.filter((r) => r.kind === "deposit").flatMap((r) => r.fills).filter((x) => !x.claimed && deliverable(x, t)).reduce((n, x) => n + x.left, 0),
        tokens: { ...w.tokens }, deposited: w.deposited, redeemed: w.redeemed,
      };
    },
    async requestsOf(owner) {
      const t = now();
      return s.requests.filter((r) => lower(r.owner) === lower(owner)).map((r) => {
        const c = structuredClone(r);
        if (s.windDown) c.fills.forEach((x) => { if (!x.claimed && x.unlockAt > t) x.unlockAt = t; });
        return c;
      }).reverse();
    },
    async request(id) { const r = find(id); return r ? structuredClone(r) : null; },
    inKindLegs(shares) {
      const value = shares * s.priceUsdc * (1 - EXIT_FEE_BPS / 10_000);
      return SIM_HOLDINGS.map((h) => ({ ...h, usd: value * h.weight, amount: (value * h.weight) / h.priceUsd }));
    },

    /**
     * Run one builder call as the queue and fund would, from `from`. Returns a fake hash.
     * @param {{ functionName: string, args: any[], to: string }} call @param {`0x${string}`} from
     */
    async execute(call, from) {
      settle();
      const w = wallet(from);
      const a = call.args;
      const usdcOf = (v) => fromUnits(v, 6);
      const sharesOf = (v) => fromUnits(v, SHARE_DECIMALS);
      const hash = fakeHash();
      const t = now();
      const owned = (id) => {
        const r = find(id);
        if (!r || lower(r.owner) !== lower(from)) throw new Error("NotRequestOwner");
        return r;
      };
      switch (call.functionName) {
        case "approve":
          if (lower(call.to) === lower(MANIFEST.usdc)) w.usdcAllow = usdcOf(a[1]); else w.shareAllow = sharesOf(a[1]);
          break;
        case "requestDeposit": {
          const usdc = usdcOf(a[0]);
          if (s.depositsStopped || s.windDown) throw new Error("DepositsArePaused");
          if (usdc > w.usdc + 1e-9) throw new Error("transfer amount exceeds balance");
          if (usdc > w.usdcAllow + 1e-9) throw new Error("insufficient allowance");
          w.usdc -= usdc; w.usdcAllow -= usdc;
          addRequest("deposit", a[1], usdc, [hash]);
          break;
        }
        case "requestRedeem": {
          const shares = sharesOf(a[0]);
          if (s.windDown) throw new Error("FundIsShutdown");
          if (shares > w.shares + 1e-9) throw new Error("insufficient shares");
          w.shares -= shares; w.shareAllow = Math.max(0, w.shareAllow - shares);
          addRequest("redeem", a[1], shares, [hash]);
          break;
        }
        case "cancel": {
          const r = owned(a[0]);
          if (!canCancel(r, t, flow, { depositsStopped: s.depositsStopped })) throw new Error("RequestLocked");
          if (r.kind === "deposit") w.creditUsdc += r.remaining; else w.creditShares += r.remaining;
          r.remaining = 0; r.closed = true; r.cancelled = true; r.cancelledAt = t; r.txs.push(hash);
          break;
        }
        case "giveRedemptionNotice": {
          const r = owned(a[0]);
          if (!canGiveNotice(r, t, flow)) throw new Error("NoticeNotReady");
          const cur = epochOf(t, flow);
          r.noticeRound = s.lastSettled >= cur - 1 ? cur : cur - 1;
          r.noticeAt = settleableAt(r.noticeRound, flow); r.noticeGivenAt = t; r.txs.push(hash);
          break;
        }
        case "claimNoticeReturn": {
          const r = owned(a[0]);
          if (!r.noticeDone || r.closed) throw new Error("NoticeNotReady");
          w.creditShares += r.remaining; r.remaining = 0; r.closed = true; r.returnedAt = t; r.txs.push(hash);
          break;
        }
        case "releaseWindDown": {
          if (!s.windDown) throw new Error("FundNotShutdown");
          for (const r of s.requests.filter((x) => lower(x.owner) === lower(a[0]) && x.released && !x.closed)) {
            if (r.kind === "deposit") wallet(a[0]).creditUsdc += r.remaining; else wallet(a[0]).creditShares += r.remaining;
            r.remaining = 0; r.closed = true; r.returnedAt = t; r.txs.push(hash);
          }
          break;
        }
        case "withdrawCredit":
          if (w.creditUsdc <= 1e-9 && w.creditShares <= 1e-9) throw new Error("NothingToWithdraw");
          w.usdc += w.creditUsdc; w.shares += w.creditShares; w.creditUsdc = 0; w.creditShares = 0;
          break;
        case "withdrawExpired": {
          const r = owned(a[0]);
          if (r.kind !== "deposit" || !r.expired || r.closed) throw new Error("NotExpired");
          w.usdc += r.remaining; r.remaining = 0; r.closed = true; r.returnedAt = t; r.txs.push(hash);
          break;
        }
        case "deposit": {
          // Delivers the receiver's own unlocked shares, oldest first. Anyone may send it.
          let budget = usdcOf(a[0]) + 1e-6;
          const owner = a[1];
          for (const r of s.requests.filter((x) => x.kind === "deposit" && lower(x.owner) === lower(owner)).sort((x, y) => x.createdAt - y.createdAt)) {
            for (const fl of r.fills) {
              if (fl.claimed || !deliverable(fl, t) || budget <= 1e-9) continue;
              wallet(owner).shares += fl.out; fl.claimed = true; fl.left = 0; budget -= fl.amountIn; r.txs.push(hash);
            }
          }
          break;
        }
        case "redeem": {
          if (lower(a[2]) !== lower(from)) throw new Error("NotRequestOwner");
          let left = sharesOf(a[0]) + 1e-9;
          const owner = a[2];
          for (const r of s.requests.filter((x) => x.kind === "redeem" && lower(x.owner) === lower(owner)).sort((x, y) => x.createdAt - y.createdAt)) {
            for (const fl of r.fills) {
              if (fl.claimed || left <= 1e-9) continue;
              wallet(owner).usdc += fl.out; wallet(owner).redeemed += fl.out; fl.claimed = true; fl.left = 0; left -= fl.amountIn; r.txs.push(hash);
            }
          }
          break;
        }
        case "redeemInKind": {
          if (!s.windDown) throw new Error("FundNotShutdown");
          const shares = sharesOf(a[0]);
          if (shares > w.shares + 1e-9) throw new Error("insufficient shares");
          const legs = api.inKindLegs(shares);
          w.shares -= shares;
          for (const l of legs) { if (l.pays === "USDC") { w.usdc += l.amount; w.redeemed += l.amount; } else w.tokens[l.pays] = (w.tokens[l.pays] || 0) + l.amount; }
          s.tvlUsdc -= shares * s.priceUsdc; s.supply -= shares;
          s.exits.push({ owner: from, shares, at: t, hash, legs: legs.map(({ label, pays, amount }) => ({ label, pays, amount })) });
          break;
        }
        default: throw new Error(`The simulator does not run ${call.functionName}.`);
      }
      save();
      return hash;
    },

    // Clock and state controls (the simulation bar).
    advance(ms) { s.offsetMs += ms; settle(); save(); },
    toNextBatch() { const t = now(); const next = settleableAt(s.lastSettled + 1, flow); this.advance(Math.max(0, next - t) + 1000); },
    tick() { if (settle()) save(); },
    reset() { s = fresh(); save(); },
    stopped() { return { deposits: s.depositsStopped, windDown: s.windDown, blocked: s.batchesBlocked }; },
    setBatchesBlocked(on) { settle(); s.batchesBlocked = !!on; save(); },
    setDepositsStopped(on) { settle(); s.depositsStopped = !!on; save(); },
    setWindDown(on) {
      settle();
      s.windDown = !!on;
      // Every queued request is released at once (§5.11.5); its owner withdraws it.
      if (on) for (const r of s.requests) if (liveRemaining(r) > EPS) r.released = true;
      save();
    },
  };
  return api;
}
