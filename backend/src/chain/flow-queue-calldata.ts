// FlowQueue v0.9 action selectors from robotmoney-core FlowQueue.sol.
// These encode calls only: signing and submission stay with the wallet.
import { encodeAddressArg, encodeUint256Arg } from "./base-rpc-client.ts";

function uint(value: bigint): string {
  if (value < 0n || value >= (1n << 256n)) throw new Error("uint256 out of range");
  return encodeUint256Arg(value);
}

export const flowQueueCalldata = {
  requestDeposit: (amount: bigint, owner: string) => "0x29344f08" + uint(amount) + encodeAddressArg(owner),
  requestRedeem: (amount: bigint, owner: string) => "0x107703ab" + uint(amount) + encodeAddressArg(owner),
  cancel: (requestId: bigint) => "0x40e58ee5" + uint(requestId),
  giveRedemptionNotice: (requestId: bigint) => "0x9a4c9b1a" + uint(requestId),
  claimNoticeReturn: (requestId: bigint) => "0x29e9559b" + uint(requestId),
  withdrawCredit: () => "0xc36f3874",
  deposit: (assets: bigint, receiver: string) => "0x6e553f65" + uint(assets) + encodeAddressArg(receiver),
  redeem: (shares: bigint, receiver: string, owner: string) => "0xba087652" + uint(shares) + encodeAddressArg(receiver) + encodeAddressArg(owner),
  quoteDeposit: (amount: bigint) => "0xdb431f06" + uint(amount),
  quoteRedeem: (amount: bigint) => "0x2711be44" + uint(amount),
  allowance: (owner: string, spender: string) => "0xdd62ed3e" + encodeAddressArg(owner) + encodeAddressArg(spender),
  approve: (spender: string, amount: bigint) => "0x095ea7b3" + encodeAddressArg(spender) + uint(amount),
};

/** Decode the static Quote tuple defined in FlowTypes.sol. */
export function decodeFlowQuote(data: string) {
  if (!/^0x[0-9a-fA-F]{384}$/.test(data)) throw new Error("invalid FlowQueue quote result");
  const words = Array.from({ length: 6 }, (_, i) => BigInt(`0x${data.slice(2 + i * 64, 66 + i * 64)}`));
  const limits = [256, 64, 64, 64, 16, 16];
  if (words.some((value, i) => value >= (1n << BigInt(limits[i]!)))) throw new Error("FlowQueue quote field out of range");
  return { feeBps: words[0]!.toString(), cancelCutoff: words[1]!.toString(), earliestSettle: words[2]!.toString(), holdEnds: words[3]!.toString(), refBandBps: words[4]!.toString(), legBandBps: words[5]!.toString() };
}
