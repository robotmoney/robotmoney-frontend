// Chain scan logic is independent of storage; the API-owned store must commit
// each window and its checkpoints atomically and delete projections on rewind.
export interface FlowHeader { number: number; hash: string; timestamp: number; parentHash?: string }
export interface FlowLog { blockNumber: number; blockHash: string; logIndex: number; transactionHash: string; address: string; topics: string[]; data: string }
export interface FlowIndexStore {
  checkpoints(before?: number): Promise<FlowHeader[]>;
  rewind(afterBlock: number): Promise<void>;
  record(headers: FlowHeader[], logs: FlowLog[]): Promise<void>;
}
export interface FlowIndexSource {
  head(): Promise<number>;
  header(block: number): Promise<FlowHeader>;
  headers?(blocks: number[]): Promise<FlowHeader[]>;
  logs(from: number, to: number): Promise<FlowLog[]>;
}

export async function scanFlowWindow(source: FlowIndexSource, store: FlowIndexStore, options: {
  deployBlock: number; confirmations: number; maxBlocks: number;
}): Promise<number | null> {
  const { deployBlock, confirmations, maxBlocks } = options;
  if (![deployBlock, confirmations, maxBlocks].every(Number.isSafeInteger) || deployBlock < 0 || confirmations < 0 || maxBlocks < 1) throw new Error("invalid scan configuration");
  let checkpoints = (await store.checkpoints()).sort((a, b) => b.number - a.number);
  let ancestor: FlowHeader | undefined;
  const newest = checkpoints[0];
  while (checkpoints.length) {
    for (const checkpoint of checkpoints) {
      const canonical = await source.header(checkpoint.number);
      if (canonical.hash.toLowerCase() === checkpoint.hash.toLowerCase()) { ancestor = checkpoint; break; }
    }
    if (ancestor || checkpoints.length < 256) break;
    const oldest = checkpoints[checkpoints.length - 1]!.number;
    checkpoints = (await store.checkpoints(oldest)).sort((a, b) => b.number - a.number);
    if (checkpoints.some((checkpoint) => checkpoint.number >= oldest)) throw new Error("invalid checkpoint pagination");
  }
  if (newest && ancestor?.number !== newest.number) await store.rewind(ancestor?.number ?? deployBlock - 1);
  const from = ancestor ? ancestor.number + 1 : deployBlock;
  const to = Math.min((await source.head()) - confirmations, from + maxBlocks - 1);
  if (to < from) return ancestor?.number ?? null;
  const blockNumbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const headers = source.headers ? await source.headers(blockNumbers) : await Promise.all(blockNumbers.map((block) => source.header(block)));
  if (headers.length !== blockNumbers.length) throw new Error("RPC returned an incomplete block batch");
  for (let i = 0; i < blockNumbers.length; i++) {
    const block = blockNumbers[i]!;
    const header = headers[i]!;
    if (header.number !== block) throw new Error("RPC returned the wrong block number");
    const parent = i ? headers[i - 1] : ancestor;
    if (parent && header.parentHash && header.parentHash.toLowerCase() !== parent.hash.toLowerCase()) throw new Error("chain changed while reading headers");
  }
  const logs = await source.logs(from, to);
  const hashes = new Map(headers.map((header) => [header.number, header.hash.toLowerCase()]));
  for (const log of logs) {
    if (hashes.get(log.blockNumber) !== log.blockHash.toLowerCase()) throw new Error("log block hash does not match scanned header");
  }
  // Detect a reorg while logs were fetched, before advancing the durable cursor.
  if ((await source.header(to)).hash.toLowerCase() !== headers[headers.length - 1]!.hash.toLowerCase()) throw new Error("chain changed during scan");
  await store.record(headers, logs);
  return to;
}
