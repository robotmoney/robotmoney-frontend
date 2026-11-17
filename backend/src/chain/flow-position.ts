import { config } from "../config.ts";
import { encodeAddressArg, rpcBatchRequest } from "./base-rpc-client.ts";

export async function readFlowPosition(queue: string, fund: string, owner: string, block: number, expectedHash: string, batch = rpcBatchRequest<unknown>) {
  const blockTag = `0x${block.toString(16)}`, address = encodeAddressArg(owner);
  const selectors = ["0x402d267d", "0xc63d75b6", "0xd905777e", "0x75807250", "0xddbb34b6", "0x70a08231", "0xce4a7043"];
  const results = await batch([...selectors.map((selector, i) => ({ method: "eth_call", params: [{ to: i === 4 || i === 5 ? fund : queue, data: selector + address }, blockTag] })), { method: "eth_getBlockByNumber", params: [blockTag, false] }], { rpcUrl: config.baseRpcUrl });
  const header = results.pop();
  if (!header?.ok || typeof header.result !== "object" || header.result === null || !("hash" in header.result) || typeof header.result.hash !== "string" || header.result.hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("indexed block changed");
  if (results.length !== 7) throw new Error("incomplete position read");
  const values = results.map((result, i) => {
    if (!result.ok || typeof result.result !== "string" || !(i === 3 ? /^0x[0-9a-fA-F]{128}$/ : /^0x[0-9a-fA-F]{64}$/).test(result.result)) throw new Error("invalid position result");
    return result.result;
  });
  const uint = (hex: string) => BigInt(hex).toString();
  return { owner: owner.toLowerCase(), claimableDepositUsdc: uint(values[0]!), claimableDepositShares: uint(values[1]!), claimableRedeemShares: uint(values[2]!), creditUsdc: uint(`0x${values[3]!.slice(2, 66)}`), creditShares: uint(`0x${values[3]!.slice(66)}`), ledgerShares: uint(values[4]!), walletShares: uint(values[5]!), queuedShares: uint(values[6]!) };
}
