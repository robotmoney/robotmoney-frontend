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
};
