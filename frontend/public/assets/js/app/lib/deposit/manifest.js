// @ts-check
// The deposit manifest: everything a surface needs to build a call to the one
// vault, in one place (PRD "One core, three surfaces"; RM-205). The page reads
// it here; the skill and the prepare endpoint will read the same values once
// the manifest is published at a stable URL (RM-206).
//
// Deploy 4 is live on Base (contracts 0.8.0, upgraded in place 14 Nov 2026).
// The page is built for its next version, 0.9.0 (core `release-0.9.0`, PR
// 2019): no price limit, a cancel deadline, matched batches, redemption
// notice. Its proxies keep their addresses through an in-place upgrade, so
// they are recorded below; DEPLOY_4_LIVE turns them on once the queue answers
// `liveness()` (0.9.0 only). Until then the page runs the simulated queue
// (sim-queue.js). On a local host only, `?fund=0x…&queue=0x…` sets them for
// the tab, to test against the live contracts before the switch flips.
//
// Pins are meant to be the reviewed implementation code hashes, compared
// before any approve or request. That comparison is NOT built yet: today an
// empty list refuses every send off a local host, and a local host sends
// without it. It must exist before production.
//
// USDC is Circle's native USDC on Base; USDbC is the old bridged one, which
// the vault does not take. Both checked on chain on 12 and 16 Nov 2026.

export const BASE_CHAIN_ID = 8453;

/**
 * Deploy 4 proxies on Base, read on chain 16 Nov 2026: the fund (rmFUND) and
 * the queue it names as `flowQueue()`. Still on 0.8.0 that day.
 */
const DEPLOY_4_PROXIES = {
  fund: "0xb2c17a384b6fc03d96D77f39E016aD7b9E34af2B",
  queue: "0xbB414D1536Fef6c240e984a24F777ca0958e5439",
};
/** Flip once Deploy 4 runs 0.9.0 (the queue answers `liveness()`). */
const DEPLOY_4_LIVE = false;
const DEPLOY_4 = DEPLOY_4_LIVE ? DEPLOY_4_PROXIES : { fund: null, queue: null };

/**
 * The queue's flow parameters on Deploy 4: hourly epochs, a 12 minute settle
 * window, a 1 hour hold, expiry (deposits) or notice (redemptions) after 8
 * epochs, and requests that lock 15 minutes before their epoch closes (0.9.0's
 * `cancelBuffer`, working default D39). The page reads the live values from
 * `flowParams()` when it can and falls back to these.
 */
export const DEFAULT_FLOW = Object.freeze({
  epochLength: 3600,
  settleWindow: 720,
  minHold: 3600,
  maxRoll: 8,
  cancelBuffer: 900,
  minRequestUsdc: 1,
});

const OVERRIDE_KEY = "rm.deposit.contracts";

function localOverride() {
  try {
    const h = location.hostname;
    const local = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
    if (!local) return null;
    const q = new URLSearchParams(location.search);
    const fund = q.get("fund");
    const queue = q.get("queue");
    const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
    if (isAddr(fund) && isAddr(queue)) {
      sessionStorage.setItem(OVERRIDE_KEY, JSON.stringify({ fund, queue }));
      return { fund, queue };
    }
    const saved = JSON.parse(sessionStorage.getItem(OVERRIDE_KEY) || "null");
    return saved && isAddr(saved.fund) && isAddr(saved.queue) ? saved : null;
  } catch { return null; }
}

const contracts = (typeof location !== "undefined" && localOverride()) || DEPLOY_4;

/**
 * @typedef {{
 *   chainId: number,
 *   usdc: `0x${string}`, usdbc: `0x${string}`, usdcDecimals: number,
 *   fund: `0x${string}` | null, queue: `0x${string}` | null,
 *   pins: { fund: string[], queue: string[] },
 *   flow: typeof DEFAULT_FLOW,
 *   batchFloorUsdc: number,
 *   explorer: string,
 * }} Manifest
 */

/** @type {Readonly<Manifest>} */
export const MANIFEST = Object.freeze({
  chainId: BASE_CHAIN_ID,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  usdbc: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  usdcDecimals: 6,
  fund: /** @type {any} */ (contracts.fund),
  queue: /** @type {any} */ (contracts.queue),
  pins: { fund: [], queue: [] },
  flow: { ...DEFAULT_FLOW },
  // Used by the simulator only.
  batchFloorUsdc: 100,
  explorer: "https://basescan.org",
});

/** True until the fund and queue have Base addresses: the page then simulates. */
export function isSimulated(m = MANIFEST) {
  return !m.fund || !m.queue;
}

/** A Basescan link for a transaction or an address. */
export function explorerUrl(hashOrAddress, m = MANIFEST) {
  const kind = hashOrAddress.length === 66 ? "tx" : "address";
  return `${m.explorer}/${kind}/${hashOrAddress}`;
}
