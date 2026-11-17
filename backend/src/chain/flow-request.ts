import { config } from "../config.ts";
import { encodeAddressArg, encodeUint256Arg, ethCall, rpcBatchRequest } from "./base-rpc-client.ts";

/** Read the queue's own request and claimability views at one indexed block. */
export async function readFlowRequest(queue: string, requestId: bigint, block: number, dependencies = { call: ethCall, batch: rpcBatchRequest<string> }) {
  if (requestId <= 0n || requestId >= (1n << 256n)) throw new Error("invalid request id");
  const opts = { rpcUrl: config.baseRpcUrl, blockTag: `0x${block.toString(16)}` };
  const id = encodeUint256Arg(requestId);
  const raw = await dependencies.call(queue, `0xc58343ef${id}`, opts);
  if (!/^0x[0-9a-fA-F]{1280}$/.test(raw)) throw new Error("invalid queue request result");
  const words = Array.from({ length: 20 }, (_, i) => raw.slice(2 + i * 64, 66 + i * 64));
  if (!/^0{24}/.test(words[0]!)) throw new Error("invalid request owner");
  const owner = `0x${words[0]!.slice(24).toLowerCase()}`;
  const kind = BigInt(`0x${words[1]}`);
  if (/^0x0{40}$/.test(owner)) return null;
  if (kind !== 0n && kind !== 1n) throw new Error("invalid request kind");
  const ownerArg = encodeAddressArg(owner);
  const pending = kind === 0n ? "0x26c6f96c" : "0xf5a23d8d";
  const claimable = kind === 0n ? "0x995ea21a" : "0xeaed1d07";
  const calls = [`0x1a313202${id}`, `${pending}${id}${ownerArg}`, `${claimable}${id}${ownerArg}`];
  const results = await dependencies.batch(calls.map((data) => ({ method: "eth_call", params: [{ to: queue, data }, opts.blockTag] })), opts);
  const values = results.map((result) => {
    if (!result.ok || !/^0x[0-9a-fA-F]{64}$/.test(result.result)) throw new Error("invalid queue request view");
    return BigInt(result.result);
  });
  if (values[0]! > 3n) throw new Error("invalid request status");
  return { requestId: requestId.toString(), owner, kind: kind === 0n ? "deposit" : "redeem", status: ["none", "pending", "expired", "closed"][Number(values[0])], amount: BigInt(`0x${words[3]}`).toString(), pending: values[1]!.toString(), claimable: values[2]!.toString(), epoch: BigInt(`0x${words[2]}`).toString(), createdAt: BigInt(`0x${words[9]}`).toString(), expiresAt: BigInt(`0x${words[11]}`).toString() };
}
