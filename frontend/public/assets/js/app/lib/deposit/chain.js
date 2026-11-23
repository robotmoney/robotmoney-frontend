// @ts-check
// Reads of the live vault on Base (Deploy 4, contracts 0.9.0) through the
// wallet kit's client (wallet.js `read`), shaped exactly like the simulator's
// (sim-queue.js), so the page renders either without knowing which.
//
// Requests and claims are read by id from the queue (`requestCount`,
// `getRequest`, `claimCount`, `getClaim`) and filtered by owner. That is fine
// while the queue holds hundreds; the indexer (RM-206, GitHub issue 1614)
// replaces it with one API call per owner.
//
// Two 0.9.0 facts shape these reads. A batch's matched part is booked by
// index and becomes a claim only when the owner's queue position next syncs,
// so what is still pending is read from `pendingDepositRequest` /
// `pendingRedeemRequest` (index-aware), not from `remaining`; and a fill's
// matched share is not on the claim, so `matchedIn` is null here until the
// indexer derives it. Untested against a deployment: 0.9.0 is not on chain
// yet (16 Nov 2026).

import { MANIFEST, DEFAULT_FLOW, VENUES as MANIFEST_VENUES } from "./manifest.js";
import { QUEUE_ABI, FUND_ABI, ERC20_ABI, SETTLE_CHECK, REQUEST_STATUS } from "./abi.js";
import { fromUnits, toUnits, SHARE_DECIMALS } from "./builder.js";

const S = 1000;
const lower = (a) => (a || "").toLowerCase();
/** Under a hundredth of a USDC or an rmFUND short of the request is rounding, not a cancel (describe.js DUST). */
const DUST = 0.01;
/** A lending sleeve by the venue its adapter lends to (manifest.js VENUES), else the adapter's address. */
const venueName = (adapter) => MANIFEST_VENUES[lower(adapter)] || adapter;

/** Plain words for why no batch can run (SettleCheck), or "" when one can. */
export const SETTLE_REASON = {
  Ok: "", Window: "", Caller: "",
  Paused: "The queue is paused.",
  Sequencer: "Base's sequencer reported a problem.",
  Feed: "A price feed stopped updating.",
  UsdcPeg: "USDC is trading away from one dollar.",
  TwapQuorum: "Pool prices are too unsettled to trust.",
  TwapVsFeed: "A pool price and its feed disagree.",
  LendRate: "A lending venue's rate jumped.",
  SharePrice: "The share price moved more than a batch allows.",
};

/** @param {{ read: (c: any) => Promise<any>, readMany: (c: any[]) => Promise<any[]> }} w */
export function createChainSource(w, m = MANIFEST) {
  const q = (functionName, args = []) => ({ address: m.queue, abi: QUEUE_ABI, functionName, args, chainId: m.chainId });
  const f = (functionName, args = []) => ({ address: m.fund, abi: FUND_ABI, functionName, args, chainId: m.chainId });
  const t = (address, functionName, args = []) => ({ address, abi: ERC20_ABI, functionName, args, chainId: m.chainId });
  let flow = { ...DEFAULT_FLOW };
  let windDown = false;

  async function vault() {
    const [nav, supply, cfg, depPaused, depPausedUntil, configs, held, weights, targets, params, live, check, cur] = await w.readMany([
      f("lastGoodNav"), f("totalSupply"), f("config"), f("depositsPaused"), f("depositsPausedUntil"), f("assetConfigs"),
      f("heldBalances"), f("currentWeightsBps"), f("targetBps"), q("flowParams"), q("liveness"), q("checkSettle"), q("currentEpoch"),
    ]);
    // Epochs count from the queue's anchor, not from 1970 (schedule.js): the
    // current epoch ends at settleableAt(cur) - settleWindow, and later ones follow it.
    const curEnd = Number(await w.read(q("settleableAt", [cur]))) - Number(params.settleWindow);
    flow = {
      epochLength: Number(params.epochLength), settleWindow: Number(params.settleWindow), minHold: Number(params.minHold),
      maxRoll: Number(params.maxRoll), cancelBuffer: Number(params.cancelBuffer), minRequestUsdc: fromUnits(params.minRequestUsdc, m.usdcDecimals),
      anchorIndex: Number(cur) + 1, anchorTime: curEnd,
    };
    windDown = live.windDownActive;
    const navUsdc = fromUnits(nav[0], m.usdcDecimals);
    const supplyShares = fromUnits(supply, SHARE_DECIMALS);
    const values = await w.readMany(configs.map((_, i) => f("assetValue", [BigInt(i)])));
    const symbols = await w.readMany(configs.map((c) => (Number(c.kind) === 1 ? t(c.token, "symbol") : null)).filter(Boolean)).catch(() => []);
    let si = 0;
    const holdings = configs.map((c, i) => ({
      key: `a${i}`,
      kind: Number(c.kind) === 0 ? "lending" : "token",
      label: Number(c.kind) === 0 ? "USDC lending" : symbols[si++] || "Token",
      venue: Number(c.kind) === 0 ? venueName(c.adapter) : "In the vault",
      active: c.active,
      valueUsdc: fromUnits(values[i] ?? 0n, m.usdcDecimals),
      actualBps: Number(weights[0][i] ?? 0n),
      targetBps: Number(targets[i] ?? 0),
    }));
    holdings.push({ key: "idle", kind: "idle", label: "USDC, idle", venue: "In the vault", active: true, valueUsdc: fromUnits(held[0], m.usdcDecimals), actualBps: Number(weights[1]), targetBps: null });
    const reason = SETTLE_CHECK[Number(check[0])] || "Ok";
    return {
      source: "chain",
      priceUsdc: supplyShares > 0 ? navUsdc / supplyShares : 1,
      navAt: Number(nav[1]) * S,
      tvlUsdc: navUsdc,
      tvlCapUsdc: fromUnits(cfg[0], m.usdcDecimals),
      maxRequestUsdc: fromUnits(cfg[1], m.usdcDecimals),
      exitFeeBps: Number(cfg[2]),
      entryFeeBps: 0,
      depositsOpen: !live.depositsStoppedNow && !live.windDownActive && !live.queuePausedNow,
      depositsStopped: live.depositsStoppedNow,
      // A stop that is a state has one of a few causes (§5.11.3 item 8); only the pause says when it ends.
      stopCause: !live.depositsStoppedNow ? "" : depPaused ? "paused" : "other",
      depositsPausedUntil: depPaused && Number(depPausedUntil) ? Number(depPausedUntil) * S : null,
      queuePaused: live.queuePausedNow,
      queuePausedUntil: live.queuePausedNow && Number(live.queuePausedUntil) ? Number(live.queuePausedUntil) * S : null,
      windDown: live.windDownActive,
      keeperSet: live.keeperConfigured,
      settleBlocked: SETTLE_REASON[reason] || "",
      flow,
      holdings,
    };
  }

  /** Terms, no price (D17). @param {any} quote */
  const shapeQuote = (quote) => ({
    feeBps: Number(quote.feeBps),
    lockAt: Number(quote.cancelCutoff) * S,
    settlesAt: Number(quote.earliestSettle) * S,
    readyAt: Number(quote.holdEnds) * S,
  });

  return {
    simulated: false,
    flow: () => flow,
    now: () => Date.now(),
    vault,
    async quoteDeposit(usdc) { return shapeQuote(await w.read(q("quoteDeposit", [toUnits(usdc, m.usdcDecimals)]))); },
    async quoteRedeem(shares) { return shapeQuote(await w.read(q("quoteRedeem", [toUnits(shares, SHARE_DECIMALS)]))); },

    /** Balances, allowances and credits of `owner`. @param {`0x${string}`} owner */
    async account(owner) {
      const [usdc, usdbc, shares, usdcAllow, shareAllow, credit, queued, maxDep] = await w.readMany([
        t(m.usdc, "balanceOf", [owner]), t(m.usdbc, "balanceOf", [owner]), f("balanceOf", [owner]),
        t(m.usdc, "allowance", [owner, m.queue]), f("allowance", [owner, m.queue]), q("creditOf", [owner]),
        q("queuedSharesOf", [owner]), q("maxDeposit", [owner]),
      ]);
      return {
        usdc: fromUnits(usdc, m.usdcDecimals), usdbc: fromUnits(usdbc, m.usdcDecimals),
        shares: fromUnits(shares, SHARE_DECIMALS), usdcAllowance: usdcAllow, shareAllowance: shareAllow,
        creditUsdc: fromUnits(credit[0], m.usdcDecimals), creditShares: fromUnits(credit[1], SHARE_DECIMALS),
        queuedShares: fromUnits(queued, SHARE_DECIMALS), maxDepositUsdc: fromUnits(maxDep, m.usdcDecimals), maxDepositRaw: maxDep,
      };
    },

    /** Every request of `owner`, newest first, in stages.js's shape. @param {`0x${string}`} owner */
    async requestsOf(owner) {
      const [nReq, nClaim] = (await w.readMany([q("requestCount"), q("claimCount")])).map(Number);
      const ids = Array.from({ length: nReq }, (_, i) => BigInt(i + 1));
      const claimIds = Array.from({ length: nClaim }, (_, i) => BigInt(i + 1));
      const [reqs, statuses, claims] = await Promise.all([
        w.readMany(ids.map((id) => q("getRequest", [id]))),
        w.readMany(ids.map((id) => q("requestStatus", [id]))),
        w.readMany(claimIds.map((id) => q("getClaim", [id]))),
      ]);
      const mine = (x) => x && lower(x.owner) === lower(owner);
      const mineIdx = reqs.map((r, i) => (mine(r) ? i : -1)).filter((i) => i >= 0);
      const pending = await w.readMany(mineIdx.map((i) => q(Number(reqs[i].kind) === 0 ? "pendingDepositRequest" : "pendingRedeemRequest", [ids[i], owner])));
      const pendingOf = new Map(mineIdx.map((i, j) => [i, pending[j]]));
      // Each request's own epoch ends, read from the queue: epochs from before the
      // 20 Nov upgrade had another length, so they cannot be computed.
      const epochs = [...new Set(mineIdx.flatMap((i) => [reqs[i].epoch, reqs[i].expiryEpoch, reqs[i].noticeRound].filter((e) => Number(e) > 0).map(String)))];
      const settles = await w.readMany(epochs.map((e) => q("settleableAt", [BigInt(e)])));
      const endOf = new Map(epochs.map((e, j) => [e, (Number(settles[j]) - flow.settleWindow) * S]));
      const byRequest = new Map();
      claims.forEach((c, i) => {
        if (!mine(c)) return;
        const dep = Number(c.kind) === 0;
        const key = String(c.requestId);
        const fill = {
          claimId: String(claimIds[i]),
          amountIn: dep ? fromUnits(c.usdc, m.usdcDecimals) : fromUnits(c.shares, SHARE_DECIMALS),
          out: dep ? fromUnits(c.shares, SHARE_DECIMALS) : fromUnits(c.usdc, m.usdcDecimals),
          matchedIn: null,
          unlockAt: Number(c.unlockAt) * S,
          at: (Number(c.unlockAt) - (dep ? flow.minHold : 0)) * S,
          claimed: dep ? c.claimed >= c.shares : c.sharesClaimed >= c.shares,
          // What can still be claimed: for a deposit, the USDC cost of the shares not yet delivered (the unit
          // `deposit(assets, receiver)` takes); for a redemption, the burned shares whose USDC is not yet taken.
          left: dep ? fromUnits(c.shares ? (c.usdc * (c.shares - c.claimed)) / c.shares : 0n, m.usdcDecimals) : fromUnits(c.shares - c.sharesClaimed, SHARE_DECIMALS),
          leftRaw: dep ? (c.shares ? (c.usdc * (c.shares - c.claimed)) / c.shares : 0n) : c.shares - c.sharesClaimed,
        };
        fill.price = fill.amountIn && fill.out ? (dep ? fill.amountIn / fill.out : fill.out / fill.amountIn) : 0;
        (byRequest.get(key) || byRequest.set(key, []).get(key)).push(fill);
      });
      const nowMs = Date.now();
      return mineIdx.map((i) => {
        const r = reqs[i];
        const dep = Number(r.kind) === 0;
        const dec = dep ? m.usdcDecimals : SHARE_DECIMALS;
        const fills = byRequest.get(String(ids[i])) || [];
        const amount = fromUnits(r.amount, dec);
        const remaining = fromUnits(pendingOf.get(i) ?? r.remaining, dec);
        const filled = fills.reduce((s, x) => s + x.amountIn, 0);
        const status = REQUEST_STATUS[Number(statuses[i])];
        const noticeRound = Number(r.noticeRound);
        const noticeEnd = noticeRound ? endOf.get(String(noticeRound)) : null;
        const noticeAt = noticeEnd != null ? noticeEnd + flow.settleWindow * S : null;
        // The notice batch has ended once the next epoch has closed (FlowMatchLib.claimNoticeReturn reverts before).
        const noticeDone = noticeEnd != null && !r.closed && nowMs >= noticeEnd + flow.epochLength * S;
        return {
          id: String(ids[i]), kind: dep ? "deposit" : "redeem", owner: r.owner, amount, remaining,
          epoch: Number(r.epoch), createdAt: Number(r.createdAt) * S, exitFeeBps: Number(r.exitFeeBps),
          endAt: endOf.get(String(r.epoch)) ?? null, expiresAt: endOf.get(String(r.expiryEpoch)) ?? null,
          closed: r.closed, expired: status === "Expired",
          cancelled: r.closed && !noticeRound && status !== "Expired" && filled + DUST < amount && remaining <= 1e-9,
          noticeAt, noticeRound: noticeRound || null, noticeDone, released: windDown && !r.closed,
          fills, txs: [],
        };
      }).reverse();
    },

    /** One request by id, for the status page. @param {string} id */
    async request(id) {
      const r = await w.read(q("getRequest", [BigInt(id)]));
      if (!r || /^0x0+$/.test(r.owner)) return null;
      return (await this.requestsOf(r.owner)).find((x) => x.id === String(id)) || null;
    },
  };
}
