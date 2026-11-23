// @ts-check
// The one vault's ABI, as much of it as the deposit page and the skill use
// (RM-146, RM-147). Transcribed from robotmoney-core `release-0.9.0` (contracts
// 0.9.0, step 3f: netted, forward-priced flows; PR 2019), the version Deploy 4
// moves to next:
//   contracts/test/prototype/src/interfaces/IFlowQueue.sol, FlowQueue.sol
//   contracts/test/prototype/src/interfaces/IRobotMoneyFund.sol
//   contracts/test/prototype/src/FlowTypes.sol
// What 0.9.0 changed for a depositor: a request names a quantity and no price
// (the batch sets it); `quoteDeposit` returns terms, not a price; cancel closes
// `cancelBuffer` before the request's epoch ends; a redemption never expires
// but can be given notice after `maxRoll` epochs; there is no in-kind exit
// while the fund runs (`redeemInKind` opens only in a wind-down).
// Units: USDC 6 decimals; fund shares 10^18 units per USDC unit at the seed
// scale (24 decimals); prices `usdc × 1e36 / shares` (PRICE_SCALE).
// When core publishes a generated ABI with the deployment manifest, this file
// gives way to it.

const u = (name, type = "uint256") => ({ name, type });
const view = (name, inputs, outputs) => ({ type: "function", name, stateMutability: "view", inputs, outputs });
const write = (name, inputs, outputs = []) => ({ type: "function", name, stateMutability: "nonpayable", inputs, outputs });
const tuple = (name, components) => ({ name, type: "tuple", components });

const FLOW_PARAMS = tuple("", [
  u("epochLength", "uint32"), u("settleWindow", "uint32"), u("minHold", "uint32"), u("keeperGrace", "uint32"),
  u("maxEpochFlowBps", "uint16"), u("epochFlowFloorUsdc", "uint128"), u("maxSharePriceMoveBps", "uint16"),
  u("maxRoll", "uint16"), u("minRequestUsdc", "uint128"), u("maxFreeze", "uint32"), u("slices", "uint8"),
  u("quorum", "uint8"), u("dispersionBps", "uint16"), u("refBandBps", "uint16"), u("legBandBps", "uint16"),
  u("sequencerGrace", "uint32"), u("usdcPegBandBps", "uint16"), u("maxLendRateGrowthBps", "uint16"),
  u("cancelBuffer", "uint32"), u("maxPause", "uint32"), u("matchBandBps", "uint16"),
]);
// Terms are fixed on the request when it is made (D26): fee, hold, roll limit, expiry.
const REQUEST = tuple("", [
  u("owner", "address"), u("kind", "uint8"), u("epoch", "uint64"), u("amount"), u("remaining"), u("closed", "bool"),
  u("exitFeeBps", "uint16"), u("minHold", "uint32"), u("maxRoll", "uint16"), u("createdAt", "uint64"),
  u("expiryEpoch", "uint64"), u("expiresAt", "uint64"), u("noticeRound", "uint64"), u("era", "uint64"),
  u("enrolled", "bool"), u("matchCycle"), u("normBasis"), u("entryCumScaled"), u("entryUnmatchedFactor"), u("nextMatchId"),
]);
const CLAIM = tuple("", [
  u("requestId"), u("owner", "address"), u("kind", "uint8"), u("settlementId", "uint64"), u("unlockAt", "uint64"),
  u("shares"), u("usdc"), u("claimed"), u("sharesClaimed"),
]);
const SETTLEMENT = tuple("", [
  u("time", "uint64"), u("settler", "address"), u("matchedShares"), u("matchedUsdc"), u("matchSharePrice"),
  u("usdcIn"), u("sharesMinted"), u("sharesBurned"), u("usdcOut"), u("frozenUntil", "uint64"),
  u("freezeSetAt", "uint64"), u("holdEndsAt", "uint64"),
]);
// No price: the fee, the cancel deadline, the earliest batch, the hold end and the guard bands (§5.11.3 item 2).
const QUOTE = tuple("", [
  u("feeBps"), u("cancelCutoff", "uint64"), u("earliestSettle", "uint64"), u("holdEnds", "uint64"),
  u("refBandBps", "uint16"), u("legBandBps", "uint16"),
]);
const LIVENESS = tuple("", [
  u("keeperConfigured", "bool"), u("queuePausedNow", "bool"), u("queuePausedUntil", "uint64"),
  u("depositsStoppedNow", "bool"), u("windDownActive", "bool"), u("cancelBuffer", "uint32"), u("maxPause", "uint32"),
]);
const ASSET_CONFIG = {
  name: "",
  type: "tuple[]",
  components: [
    u("kind", "uint8"), u("active", "bool"), u("capBps", "uint16"), u("adapter", "address"), u("token", "address"),
    u("pool", "address"), u("poolFee", "uint24"), u("twapWindow", "uint32"), u("venue", "uint8"), u("feed", "address"),
    u("maxFeedAge", "uint32"),
  ],
};

export const QUEUE_ABI = [
  write("requestDeposit", [u("usdc"), u("owner", "address")], [u("requestId")]),
  write("requestRedeem", [u("shares"), u("owner", "address")], [u("requestId")]),
  write("cancel", [u("requestId")]),
  write("withdrawExpired", [u("requestId")], [u("amount")]),
  write("giveRedemptionNotice", [u("requestId")], [u("noticeRound", "uint64")]),
  write("claimNoticeReturn", [u("requestId")], [u("shares")]),
  write("releaseWindDown", [u("owner", "address")], [u("usdc"), u("shares")]),
  write("withdrawCredit", [], [u("usdc"), u("shares")]),
  write("deposit", [u("assets"), u("receiver", "address")], [u("shares")]),
  write("redeem", [u("shares"), u("receiver", "address"), u("owner", "address")], [u("assets")]),
  view("checkSettle", [], [u("check", "uint8"), u("index")]),
  view("flowParams", [], [FLOW_PARAMS]),
  view("liveness", [], [LIVENESS]),
  view("currentEpoch", [], [u("", "uint64")]),
  view("settleableAt", [u("epoch", "uint64")], [u("", "uint64")]),
  view("getRequest", [u("requestId")], [REQUEST]),
  view("requestStatus", [u("requestId")], [u("", "uint8")]),
  view("getClaim", [u("claimId")], [CLAIM]),
  view("getSettlement", [u("settlementId")], [SETTLEMENT]),
  view("requestCount", [], [u("")]),
  view("claimCount", [], [u("")]),
  view("creditOf", [u("owner", "address")], [u("usdc"), u("shares")]),
  view("queuedSharesOf", [u("account", "address")], [u("")]),
  view("quoteDeposit", [u("usdc")], [QUOTE]),
  view("quoteRedeem", [u("shares")], [QUOTE]),
  view("pendingDepositRequest", [u("requestId"), u("controller", "address")], [u("assets")]),
  view("claimableDepositRequest", [u("requestId"), u("controller", "address")], [u("assets")]),
  view("pendingRedeemRequest", [u("requestId"), u("controller", "address")], [u("shares")]),
  view("claimableRedeemRequest", [u("requestId"), u("controller", "address")], [u("shares")]),
  view("maxDeposit", [u("owner", "address")], [u("assets")]),
  view("maxRedeem", [u("owner", "address")], [u("shares")]),
];

export const FUND_ABI = [
  view("decimals", [], [u("", "uint8")]),
  view("totalSupply", [], [u("")]),
  view("balanceOf", [u("account", "address")], [u("")]),
  view("allowance", [u("owner", "address"), u("spender", "address")], [u("")]),
  write("approve", [u("spender", "address"), u("amount")], [u("", "bool")]),
  view("lastGoodNav", [], [u("nav"), u("at", "uint64")]),
  view("heldBalances", [], [u("idle"), u("held", "uint256[]")]),
  view("assetConfigs", [], [ASSET_CONFIG]),
  view("assetValue", [u("index")], [u("")]),
  view("targetBps", [], [u("", "uint16[]")]),
  view("currentWeightsBps", [], [u("bps", "uint256[]"), u("idleBps")]),
  view("depositsPaused", [], [u("", "bool")]),
  view("depositsPausedUntil", [], [u("", "uint64")]),
  view("isShutdown", [], [u("", "bool")]),
  view("config", [], [u("tvlCap"), u("perDepositCap"), u("exitFeeBps"), u("feeRecipient", "address")]),
  // Wind-down only (D18): the fund refuses it while it runs.
  write("redeemInKind", [u("shares"), u("receiver", "address"), u("owner", "address")]),
];

export const ERC20_ABI = [
  view("balanceOf", [u("account", "address")], [u("")]),
  view("allowance", [u("owner", "address"), u("spender", "address")], [u("")]),
  view("decimals", [], [u("", "uint8")]),
  view("symbol", [], [u("", "string")]),
  write("approve", [u("spender", "address"), u("amount")], [u("", "bool")]),
];

/** `SettleCheck` (FlowTypes.sol), in order: why no batch can run right now. */
export const SETTLE_CHECK = [
  "Ok", "Window", "Caller", "Paused", "Sequencer", "Feed", "UsdcPeg", "TwapQuorum", "TwapVsFeed", "LendRate",
  "SharePrice", "RedeemLeg", "DepositLeg", "Proportion", "RealizedPrice",
];
/**
 * topic0 of the queue's request events, whose first indexed field is the new
 * request's id: `DepositRequested(uint256,address,address,uint256,uint64)` and
 * `RedeemRequested(uint256,address,address,uint256,uint64)` (FlowTypes.sol).
 */
export const REQUEST_TOPICS = Object.freeze([
  "0xb8cbb91f85c0ecbb8b541805846bc3a6e090a8147b47523c51583a4815daebf9",
  "0x4e6558a3f3bfe9109a9a42f577ad5068d47c1e903f1f059cd8844db8d524d879",
]);
/** `RequestStatus`. */
export const REQUEST_STATUS = ["None", "Pending", "Expired", "Closed"];
export const PRICE_SCALE = 10n ** 36n;
