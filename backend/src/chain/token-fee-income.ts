// The protocol's income from $ROBOTMONEY's swap fees, and the tokens its own
// wallets hold, read from Base in ONE eth_call (RM-156). token-metrics.ts
// values them; this module only reads and decodes.
//
// Doppler's locker (config.ts ROBOTMONEY_DOPPLER) keeps, per pool, a running
// total of every fee it has collected (getCumulatedFees0/1: token0 is WETH,
// token1 ROBOTMONEY) and each beneficiary's share of them (getShares, WAD). The
// prop wallets' share of the lifetime total is cumulated × shares / 1e18. That
// assumes the share was the same since launch, and it was: 57% throughout,
// moved from the launch wallet to the primary prop wallet with
// updateBeneficiary, which carries the shares across unchanged. The pool's
// swap fee is the hook's schedule end fee (getFeeScheduleOf word 2, hundredths
// of a basis point); the launch decay to it ended ten seconds after launch.
//
// Every sub-call is allowFailure:false, so a revert fails the one eth_call and
// the caller degrades the whole leg to null; it never mixes a partial read.
import { ROBOTMONEY_DOPPLER, resolvePropWallets } from "../config.ts";
import {
  encodeAddressArg,
  encodeBalanceOfCall,
  multicall3Aggregate3,
  type Call3,
  type RpcCallOptions,
} from "./base-rpc-client.ts";

const SELECTORS = {
  getCumulatedFees0: "0xcb7dd8f2", // getCumulatedFees0(bytes32)
  getCumulatedFees1: "0x5a302347", // getCumulatedFees1(bytes32)
  getShares: "0x5ebb58fb", // getShares(bytes32,address)
  getFeeScheduleOf: "0x10d052f2", // getFeeScheduleOf(bytes32) → (startingTime, startFee, endFee, lastFee, durationSeconds)
} as const;

export { SELECTORS as TOKEN_FEE_INCOME_SELECTORS };

const WAD = 10n ** 18n;

export interface TokenFeeIncomeRead {
  /** The prop wallets' share of every fee collected since launch, in WETH. */
  lifetimeWeth: number;
  /** The same, in ROBOTMONEY (fees on sells are paid in the token). */
  lifetimeRobotmoney: number;
  /** The prop wallets' combined share of the pool's fees, 0..1. */
  protocolShare: number;
  /** The pool's swap fee, 0..1 (0.012). */
  swapFee: number;
  /** ROBOTMONEY held across the prop wallets, whole tokens. */
  protocolHeld: number;
}

// The n-th 32-byte word of an ABI return, as a bigint.
function wordAt(returnData: string, n: number): bigint {
  const hex = returnData.replace(/^0x/, "");
  const w = hex.slice(n * 64, (n + 1) * 64);
  if (w.length !== 64) throw new Error(`token-fee-income: return data has no word ${n}`);
  return BigInt("0x" + w);
}

export async function readTokenFeeIncome(
  robotmoney: string,
  opts: RpcCallOptions,
  wallets: string[] = resolvePropWallets(),
): Promise<TokenFeeIncomeRead> {
  const { locker, hook, poolId } = ROBOTMONEY_DOPPLER;
  const pool = poolId.replace(/^0x/, "");
  const calls: Call3[] = [
    { target: locker, allowFailure: false, callData: SELECTORS.getCumulatedFees0 + pool },
    { target: locker, allowFailure: false, callData: SELECTORS.getCumulatedFees1 + pool },
    { target: hook, allowFailure: false, callData: SELECTORS.getFeeScheduleOf + pool },
    ...wallets.map((w) => ({ target: locker, allowFailure: false, callData: SELECTORS.getShares + pool + encodeAddressArg(w) })),
    ...wallets.map((w) => ({ target: robotmoney, allowFailure: false, callData: encodeBalanceOfCall(w) })),
  ];
  const results = await multicall3Aggregate3(calls, opts);
  if (results.length !== calls.length || results.some((r) => !r.success)) {
    throw new Error("token-fee-income: a locker, hook or balance read did not answer");
  }
  const cumulatedWeth = wordAt(results[0]!.returnData, 0);
  const cumulatedRobotmoney = wordAt(results[1]!.returnData, 0);
  const endFee = wordAt(results[2]!.returnData, 2);
  const shares = results.slice(3, 3 + wallets.length).reduce((sum, r) => sum + wordAt(r.returnData, 0), 0n);
  const held = results.slice(3 + wallets.length).reduce((sum, r) => sum + wordAt(r.returnData, 0), 0n);
  return {
    lifetimeWeth: Number((cumulatedWeth * shares) / WAD) / 1e18,
    lifetimeRobotmoney: Number((cumulatedRobotmoney * shares) / WAD) / 1e18,
    protocolShare: Number(shares) / 1e18,
    swapFee: Number(endFee) / 1e6,
    protocolHeld: Number(held) / 1e18,
  };
}
