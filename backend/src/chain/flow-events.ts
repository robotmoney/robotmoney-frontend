import type { FlowLog } from "./flow-indexer.ts";

// Pinned to the release-0.9.0 FlowTypes.sol event interface. Integer values
// stay decimal strings so no uint256 is rounded by JavaScript number parsing.
const definitions: Record<string, { name: string; indexed: string[]; fields: string[] }> = {
  "0xb8cbb91f85c0ecbb8b541805846bc3a6e090a8147b47523c51583a4815daebf9": { name: "DepositRequested", indexed: ["requestId", "owner:address", "sender:address"], fields: ["usdc", "epoch"] },
  "0x4e6558a3f3bfe9109a9a42f577ad5068d47c1e903f1f059cd8844db8d524d879": { name: "RedeemRequested", indexed: ["requestId", "owner:address", "sender:address"], fields: ["shares", "epoch"] },
  "0x3796cd2bbde8f185a2341d1c3fb8207b168febf5cd44d360661956cfdc70a177": { name: "RequestCancelled", indexed: ["requestId", "owner:address"], fields: ["unfilled"] },
  "0xae1f583816a37727fa407fb842920ab50ad6f9b9e7c9b025ac764a96343fe317": { name: "DepositFilled", indexed: ["requestId", "claimId", "settlementId"], fields: ["usdc", "shares", "unlockAt"] },
  "0xd7dbaf45fbec328ec24a3c08dafc1b7c75feac8d794d5aec21e037a7f1b7c59c": { name: "RedeemFilled", indexed: ["requestId", "claimId", "settlementId"], fields: ["shares", "usdc"] },
  "0xdfe275799fb4d958ef7eb4fa3c86cdca5a4999fd0b8941d39653fd13f1c22bae": { name: "SharesDelivered", indexed: ["owner:address", "caller:address"], fields: ["shares", "usdc"] },
  "0x9058dd2ba35a60a487ae583a06f9d17836b0e841c951f43a1baa3f33d0c55ccf": { name: "RedeemClaimed", indexed: ["owner:address", "receiver:address"], fields: ["shares", "usdc"] },
  "0xdd675b86dc7982cd559a7749ec9ecf4a18f51bb3978375a50ca3c3e3c683ae5c": { name: "Matched", indexed: ["epoch", "settlementId"], fields: ["matchedShares", "matchedUsdc", "feeUsdc", "sharePrice"] },
  "0x8ecc624c6f11fc84fecb7269245980bab9d25af8b2548d1d47212d16e53de860": { name: "Settled", indexed: ["settlementId", "settler:address"], fields: ["sharePrice", "matchedShares", "matchedUsdc", "usdcIn", "sharesMinted", "sharesBurned", "usdcOut"] },
  "0x4a39100d222c6c07af4e59c449c4643191784bcc65a9b1427f7c6e0018a75b3e": { name: "CreditAdded", indexed: ["owner:address"], fields: ["usdc", "shares"] },
  "0x77982616940619ddbda4afe3675280fff7c605d31503336add3633fbea69d8ba": { name: "CreditWithdrawn", indexed: ["owner:address"], fields: ["usdc", "shares"] },
  "0x066294ba3615e1cb93ebe7f2cfc0998fa7724d5e6bc72a87d28b9eb586272b0d": { name: "ExpiredWithdrawn", indexed: ["requestId", "owner:address"], fields: ["amount"] },
  "0x28fde4ff4280a9d2e89f0df548e95a0cd92b6da0cdf907f59b956cf57754e62a": { name: "RedemptionNoticeGiven", indexed: ["requestId", "owner:address"], fields: ["noticeRound"] },
  "0xb31625e6e63202241576224e28929307cae3c1da174b626b0a6e48938b2a01a5": { name: "RedemptionNoticeReturned", indexed: ["requestId", "owner:address"], fields: ["shares"] },
  "0x5872104128ca2bce296136f7aaebaffd0cd055e054483e0a1f15e73a8b491c75": { name: "WindDownReleased", indexed: ["owner:address"], fields: ["usdcReleased", "sharesReleased"] },
  "0x71119ad23c7a6293ff94e077e2b0e50fa733faa8a4ec78f90fe94a4401ff06e7": { name: "MatchSkipped", indexed: ["epoch"], fields: ["devBps"] },
  "0xcd6797753d1f6e96bcafe8c95faefebc4d69b3897de469bea9e07511f23eb4c8": { name: "DepositStoppedForRound", indexed: ["epoch"], fields: ["reason"] },
  "0xf166f7627dbd6a52559df1fa559700f0796cd8e54df092e9422eacfb29051346": { name: "SettlementFrozen", indexed: ["settlementId"], fields: ["until"] },
  "0xe5d56550a7bce6fe2562d64317b68394c9641cd177ea535b02c6493a783cd6bb": { name: "SettlementReleased", indexed: ["settlementId"], fields: [] },
  "0x2947fcf1e6533444a8b0d024aa23d671ce26710c63e636fdba834268d08ce95c": { name: "QueuePaused", indexed: ["account:address"], fields: ["until"] },
  "0xe68bef58d69407b5152e5a066d0a8f5f89ba63f10dfa5fe672a833260bd54c91": { name: "QueueUnpaused", indexed: ["account:address"], fields: [] },
  "0xeb225a736fbfee3f85ccb72bdf84ff0396ab358b7970e2cc351ab3e3fd92358d": { name: "DepositsPaused", indexed: ["account:address"], fields: [] },
  "0xd92e31f504caf26579aa9a5860a669bf0ccf07c267baa65bc79bf3ee57cfa27c": { name: "DepositsUnpaused", indexed: ["account:address"], fields: [] },
  "0x4426aa1fb73e391071491fcfe21a88b5c38a0a0333a1f6e77161470439704cf8": { name: "Shutdown", indexed: [], fields: [] },
  "0x8844cef3a16b6ac7edabbd8f395fc713a830e9a3198c483c712e4b515439f0d3": { name: "Restored", indexed: [], fields: ["newTvlCap"] },
  "0x14100b5173247fd85933be4f0a825a6f177df0921816a1412b949113e3c40b3a": { name: "FlowRoleBound", indexed: ["queue:address"], fields: [] },
  "0x67f9b61bf7b39fd24dd60467083f89ea77979db358db2804069474590a36c035": { name: "Seeded", indexed: [], fields: ["usdc", "shares"] },
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": { name: "Transfer", indexed: ["from:address", "to:address"], fields: ["value"] },
  "0x7b1aef0e0b790eaabc2bf48a69f9bdd83f9ae8c4eaca8d95b24850113af86e0e": { name: "ExitFeeCharged", indexed: ["owner:address"], fields: ["grossAssets", "fee"] },
  "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7": { name: "Deposit", indexed: ["caller:address", "owner:address"], fields: ["assets", "shares"] },
  "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db": { name: "Withdraw", indexed: ["caller:address", "receiver:address", "owner:address"], fields: ["assets", "shares"] },
  "0x3461fe378a2efca85c88ef6623ffa209efcef9051431ffca026aab841a2b4f89": { name: "AgentAuthorized", indexed: ["agent:address", "owner:address"], fields: ["validUntil", "maxPerPayment", "maxPerWindow", "shareReceiver:address"] },
  "0x3855bc4f5f7ba28049e0abd622b6ffbbf63cb46e6b09593b9213c9fd38db5cad": { name: "AgentRevoked", indexed: ["agent:address", "owner:address"], fields: [] },
  "0xa9d4181f9a037cd8447c2d7336d15eaf9b4424df7793889e5d155ec7cdb01965": { name: "AgentDeposit", indexed: ["paymentId:bytes32", "orderId:bytes32", "agent:address"], fields: ["shareReceiver:address", "amount", "sharesMinted", "windowId"] },
  "0x5fb42bba5add49752cfadf2acd1a6766af263661f5caca0577015c183fcce4ee": { name: "AgentWithdrawal", indexed: ["paymentId:bytes32", "orderId:bytes32", "agent:address"], fields: ["sourceVault:address", "shares", "assetsOut", "assetRecipient:address", "windowId"] },
  "0x59f0898f2df0fec2756b6bd25584cac8bc6d5a277a1c12aadd6b5c1ad801bff0": { name: "VaultStatusChanged", indexed: ["vault:address", "status"], fields: ["timestamp"] },
  "0x257cb22e03ab252c5a562a7b4b371f420ba141f1445d13e81e7f3ba3946f601f": { name: "Allocated", indexed: ["index", "adapter:address"], fields: ["amount"] },
  "0xc47b274de5c3e6569385361fa3dc869c98af8023c31ec785a8da75b9c91cfb99": { name: "Pulled", indexed: ["index", "adapter:address"], fields: ["amount"] },
  "0xc306af072396b02bf3a9782c10065cc7ff4aa842934a43f0b76f997b291237c8": { name: "Rebalanced", indexed: [], fields: ["totalMoved"] },
};

export function decodeFlowEvent(log: Pick<FlowLog, "topics" | "data">): { name: string; args: Record<string, string> } | null {
  const def = definitions[log.topics[0]?.toLowerCase() ?? ""];
  if (!def) return null;
  if (log.topics.length !== def.indexed.length + 1 || !/^0x(?:[0-9a-fA-F]{64})*$/.test(log.data) || (log.data.length - 2) / 64 !== def.fields.length) throw new Error(`malformed ${def.name} event`);
  const args: Record<string, string> = {};
  const assign = (field: string, word: string) => {
    if (!/^[0-9a-fA-F]{64}$/.test(word)) throw new Error(`malformed ${def.name} word`);
    const [name, kind] = field.split(":");
    if (kind === "address" && !/^0{24}/.test(word)) throw new Error(`malformed ${def.name} address`);
    args[name!] = kind === "address" ? `0x${word.slice(24).toLowerCase()}` : kind === "bytes32" ? `0x${word.toLowerCase()}` : BigInt(`0x${word}`).toString();
  };
  def.indexed.forEach((field, i) => assign(field, log.topics[i + 1]!.replace(/^0x/, "")));
  def.fields.forEach((field, i) => assign(field, log.data.slice(2 + i * 64, 2 + (i + 1) * 64)));
  return { name: def.name, args };
}
