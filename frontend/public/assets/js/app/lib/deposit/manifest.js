// @ts-check
// The deposit manifest: everything a surface needs to build a call to the one
// vault, in one place (PRD "One core, three surfaces"; RM-205). The page reads
// it here; the skill and the prepare endpoint will read the same values once
// the manifest is published at a stable URL (RM-206).
//
// Deploy 4 runs contracts 0.9.0 on Base: upgraded in place on 20 Nov 2026 and
// signed off on 21 Nov at robotmoney-core tag release/v0.9.0-rc.1-rehearsal
// (05cf204). No price limit, a cancel deadline, matched batches, redemption
// notice. The page reads and sends to these proxies; with DEPLOY_4_LIVE off it
// runs the simulated queue instead (sim-queue.js).
//
// Pins: the implementation behind each proxy (its EIP-1967 slot) must be one
// listed here before the page sends anything (session.js). An upgrade puts a
// new implementation behind the same address, so sends stop until someone
// reviews it and adds it here. Implementation contracts cannot be changed in
// place, so the address stands for its code.
//
// On a local host only, two switches for testing, kept for the tab:
// `?vault=sim` runs the simulator (CI and demos, no network),
// `?fund=0x…&queue=0x…` points at other contracts (pins then do not apply),
// and `?rpc=http://127.0.0.1:8545` reads and sends through another node, such
// as an anvil fork of Base for a rehearsal with pretend money. Without it, a
// local host reads Base's public endpoint (Reown's RPC refuses its origin).
//
// USDC is Circle's native USDC on Base; USDbC is the old bridged one, which
// the vault does not take. Both checked on chain on 12 and 16 Nov 2026.

export const BASE_CHAIN_ID = 8453;

/** Deploy 4 proxies on Base: the fund (rmFUND) and the queue it names as `flowQueue()`. */
const DEPLOY_4_PROXIES = {
  fund: "0xb2c17a384b6fc03d96D77f39E016aD7b9E34af2B",
  queue: "0xbB414D1536Fef6c240e984a24F777ca0958e5439",
};
/**
 * Deploy 4's lending adapters, by the venue each lends USDC to (the rehearsal
 * page for 0.9.0, 21 Nov 2026). The fund's asset configs name an adapter, not
 * a venue. Lower-case addresses.
 */
export const VENUES = Object.freeze({
  "0x1ccaa5fd0cd17df9f1e4c278bf372476dd86be55": "Aave",
  "0x74d61d7417a47bd4f15ea7338383c86527bda065": "Moonwell",
  "0x1420381b3bf85a669a9be73bc5ec14c76a73ca24": "Compound",
});

/** The reviewed implementations (0.9.0, tag 05cf204), read on chain 23 Nov 2026. */
const DEPLOY_4_PINS = {
  fund: ["0xb309256290fe5dC64b2e3069123c60CFaD22E6c1"],
  queue: ["0x94051e739E7725bd193CB1ed743A035dE60F4Fa0"],
};
/** Off: the page runs the simulator. On since Deploy 4 answered `liveness()` (0.9.0). */
const DEPLOY_4_LIVE = true;
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
const RPC_KEY = "rm.deposit.rpc";

function isLocalHost() {
  try {
    const h = location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  } catch { return false; }
}

/**
 * The node a local host reads and sends through. Reown's RPC, the wallet kit's
 * default, answers only the origins on the Reown project's allowlist
 * (robotmoney.network and the preview host), so a local host reads Base's
 * public endpoint instead, or the node `?rpc=` names (an anvil fork), kept for
 * the tab. Null elsewhere: the deployed site uses Reown's.
 */
function localRpc() {
  if (typeof location === "undefined" || !isLocalHost()) return null;
  try {
    const v = new URLSearchParams(location.search).get("rpc");
    if (v && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(v)) sessionStorage.setItem(RPC_KEY, v);
    return sessionStorage.getItem(RPC_KEY) || "https://mainnet.base.org";
  } catch { return "https://mainnet.base.org"; }
}

function localOverride() {
  try {
    if (!isLocalHost()) return null;
    const q = new URLSearchParams(location.search);
    if (q.get("vault") === "sim") { sessionStorage.setItem(OVERRIDE_KEY, "sim"); return { fund: null, queue: null }; }
    const fund = q.get("fund");
    const queue = q.get("queue");
    const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
    if (isAddr(fund) && isAddr(queue)) {
      sessionStorage.setItem(OVERRIDE_KEY, JSON.stringify({ fund, queue }));
      return { fund, queue };
    }
    if (sessionStorage.getItem(OVERRIDE_KEY) === "sim") return { fund: null, queue: null };
    const saved = JSON.parse(sessionStorage.getItem(OVERRIDE_KEY) || "null");
    return saved && isAddr(saved.fund) && isAddr(saved.queue) ? saved : null;
  } catch { return null; }
}

const override = typeof location !== "undefined" ? localOverride() : null;
const contracts = override || DEPLOY_4;

/**
 * @typedef {{
 *   chainId: number,
 *   usdc: `0x${string}`, usdbc: `0x${string}`, usdcDecimals: number,
 *   fund: `0x${string}` | null, queue: `0x${string}` | null,
 *   pins: { fund: string[], queue: string[] } | null,
 *   rpc: string | null,
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
  // Pins guard the real deployment; contracts set by hand on a local host are not checked.
  pins: override ? null : DEPLOY_4_LIVE ? DEPLOY_4_PINS : null,
  rpc: localRpc(),
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
