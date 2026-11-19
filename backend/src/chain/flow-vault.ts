import { config } from "../config.ts";
import { encodeUint256Arg, rpcBatchRequest } from "./base-rpc-client.ts";

/** Read the deployed fund and queue at the same indexed block. */
export async function readFlowVault(queue: string, fund: string, block: number, expectedHash: string, batch = rpcBatchRequest<unknown>) {
  const blockTag = `0x${block.toString(16)}`;
  const read = async (calls: { to: string; data: string }[], optional: number[] = []) => {
    const results = await batch([...calls.map((call) => ({ method: "eth_call", params: [call, blockTag] })), { method: "eth_getBlockByNumber", params: [blockTag, false] }], { rpcUrl: config.baseRpcUrl });
    const header = results.pop();
    if (!header?.ok || typeof header.result !== "object" || header.result === null || !("hash" in header.result) || typeof header.result.hash !== "string" || header.result.hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("indexed block changed");
    return results.map((result, i) => { if (!result.ok || typeof result.result !== "string") { if (optional.includes(i)) return null; throw new Error("fund read failed"); } return result.result; });
  };
  const selectors = ["0x2d39d674", "0x18160ddd", "0x79502c55", "0x6ad0690a", "0x76671808", "0x71d53fe4", "0x9f163905", "0x7d53d9c1", "0x2eee90e3"];
  const results = await read(selectors.map((data, i) => ({ to: [3, 4, 5].includes(i) ? queue : fund, data })));
  const words = (value: string | null | undefined): bigint[] => {
    if (!value || !/^0x(?:[0-9a-fA-F]{64})+$/.test(value)) throw new Error("invalid fund ABI result");
    return Array.from({ length: (value.length - 2) / 64 }, (_, i) => BigInt(`0x${value.slice(2 + 64 * i, 66 + 64 * i)}`));
  };
  const [nav, supply, fundConfig, live, epoch, params, targetsRaw, assetsRaw, heldRaw] = results.map(words);
  if (nav!.length !== 2 || supply!.length !== 1 || fundConfig!.length !== 4 || live!.length !== 7 || epoch!.length !== 1 || params!.length !== 21) throw new Error("invalid fund state");
  if ([live![0], live![1], live![3], live![4]].some((v) => v !== 0n && v !== 1n)) throw new Error("invalid liveness flag");
  if (targetsRaw![0] !== 32n || assetsRaw![0] !== 32n || heldRaw![1] !== 64n) throw new Error("invalid fund array offset");
  const count = Number(targetsRaw![1]);
  if (!Number.isSafeInteger(count) || count < 0 || count > 100 || targetsRaw!.length !== count + 2 || assetsRaw![1] !== BigInt(count) || assetsRaw!.length !== 2 + count * 11 || heldRaw![2] !== BigInt(count) || heldRaw!.length !== 3 + count) throw new Error("invalid fund array lengths");
  const address = (value: bigint) => { if (value >= (1n << 160n)) throw new Error("invalid fund address"); return `0x${value.toString(16).padStart(40, "0")}`; };
  const holdings = Array.from({ length: count }, (_, i) => {
    const a = assetsRaw!.slice(2 + i * 11, 2 + (i + 1) * 11);
    if (a[1] !== 0n && a[1] !== 1n) throw new Error("invalid asset active flag");
    return { index: i, kind: a[0]!.toString(), active: a[1] === 1n, capBps: a[2]!.toString(), adapter: address(a[3]!), token: address(a[4]!), pool: address(a[5]!), held: heldRaw![3 + i]!.toString(), targetBps: targetsRaw![2 + i]!.toString() };
  });
  const [settle, priceRaw] = await read([{ to: queue, data: `0x648c691a${encodeUint256Arg(epoch![0]!)}` }, { to: fund, data: `0x07a2d13a${encodeUint256Arg(1_000_000n)}` }], [1]);
  const price = priceRaw === null || priceRaw === "0x" ? null : words(priceRaw);
  if (price && price.length !== 1) throw new Error("invalid price result");
  const settleWords = words(settle);
  if (settleWords.length !== 1 || settleWords[0]! < params![1]! + params![18]!) throw new Error("invalid epoch cutoff");
  const navValue = nav![0]!, cap = fundConfig![0]!;
  return {
    navUsdc: navValue.toString(), navObservedAt: nav![1]!.toString(), totalShares: supply![0]!.toString(),
    tvlCapUsdc: cap.toString(), roomAtLastGoodNavUsdc: (cap > navValue ? cap - navValue : 0n).toString(), perDepositCapUsdc: fundConfig![1]!.toString(), exitFeeBps: fundConfig![2]!.toString(),
    pricePerMillionSharesUsdc: price?.[0]?.toString() ?? null, priceBinding: false, idleUsdc: heldRaw![0]!.toString(), holdings,
    keeperConfigured: live![0] === 1n, queuePaused: live![1] === 1n, queuePausedUntil: live![2]!.toString(), depositsStopped: live![3] === 1n, windDown: live![4] === 1n,
    epoch: epoch![0]!.toString(), settleableAt: settleWords[0]!.toString(), cancelCutoff: (settleWords[0]! - params![1]! - params![18]!).toString(),
  };
}
