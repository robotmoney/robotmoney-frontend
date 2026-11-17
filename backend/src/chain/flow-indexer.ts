// Chain scan logic is independent of storage; the API-owned store must commit
// each window and its checkpoints atomically and delete projections on rewind.
export interface FlowHeader { number: number; hash: string; timestamp: number }
export interface FlowLog { blockNumber: number; blockHash: string; logIndex: number; transactionHash: string; address: string; topics: string[]; data: string }
export interface FlowIndexStore {
  checkpoints(): Promise<FlowHeader[]>;
  rewind(afterBlock: number): Promise<void>;
  record(headers: FlowHeader[], logs: FlowLog[]): Promise<void>;
}
export interface FlowIndexSource {
  head(): Promise<number>;
  header(block: number): Promise<FlowHeader>;
  logs(from: number, to: number): Promise<FlowLog[]>;
}

export async function scanFlowWindow(source: FlowIndexSource, store: FlowIndexStore, options: {
  deployBlock: number; confirmations: number; maxBlocks: number;
}): Promise<number | null> {
  const { deployBlock, confirmations, maxBlocks } = options;
  if (![deployBlock, confirmations, maxBlocks].every(Number.isSafeInteger) || deployBlock < 0 || confirmations < 0 || maxBlocks < 1) throw new Error("invalid scan configuration");
  const checkpoints = (await store.checkpoints()).sort((a, b) => b.number - a.number);
  let ancestor: FlowHeader | undefined;
  for (const checkpoint of checkpoints) {
    const canonical = await source.header(checkpoint.number);
    if (canonical.hash.toLowerCase() === checkpoint.hash.toLowerCase()) { ancestor = checkpoint; break; }
  }
  if (checkpoints.length && ancestor?.number !== checkpoints[0]?.number) await store.rewind(ancestor?.number ?? deployBlock - 1);
  const from = ancestor ? ancestor.number + 1 : deployBlock;
  const to = Math.min((await source.head()) - confirmations, from + maxBlocks - 1);
  if (to < from) return ancestor?.number ?? null;
  const headers: FlowHeader[] = [];
  for (let block = from; block <= to; block++) headers.push(await source.header(block));
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
