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

/** Logs one window may record: each needs a header row too, within the pipeline's 1,000-row write. */
export const MAX_LOGS_PER_WINDOW = 400;

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
  let to = Math.min((await source.head()) - confirmations, from + maxBlocks - 1);
  if (to < from) return ancestor?.number ?? null;
  // FEW READS PER WINDOW (issue 1614). The RPC budget is shared and metered,
  // so a window costs a constant number of calls, not one per block: the tip's
  // hash before the log read, the logs, then one header batch for the blocks
  // that carry logs plus the tip. A tip hash unchanged across the log read
  // commits to every block beneath it, so no block between changed; each log's
  // block hash must match its header. Only those headers are checkpoints.
  const tip = to;
  const before = await source.header(tip);
  if (before.number !== tip) throw new Error("RPC returned the wrong block number");
  let logs = await source.logs(from, to);
  // Keep one write within the pipeline's row limit: a header and a log per row.
  if (logs.length > MAX_LOGS_PER_WINDOW) {
    const last = logs[MAX_LOGS_PER_WINDOW]!.blockNumber - 1;
    if (last < from) throw new Error(`block ${from} alone carries more than ${MAX_LOGS_PER_WINDOW} logs`);
    to = last;
    logs = logs.filter((log) => log.blockNumber <= to);
  }
  // The ancestor is re-read in the same batch: the window must still sit on it.
  const blockNumbers = [...new Set([...(ancestor ? [ancestor.number] : []), ...logs.map((log) => log.blockNumber), to, tip])].sort((a, b) => a - b);
  const fetched = source.headers ? await source.headers(blockNumbers) : await Promise.all(blockNumbers.map((block) => source.header(block)));
  if (fetched.length !== blockNumbers.length) throw new Error("RPC returned an incomplete block batch");
  fetched.forEach((header, i) => { if (header.number !== blockNumbers[i]) throw new Error("RPC returned the wrong block number"); });
  const byNumber = new Map(fetched.map((header) => [header.number, header]));
  // Detect a reorg while logs were fetched, before advancing the durable cursor.
  if (byNumber.get(tip)!.hash.toLowerCase() !== before.hash.toLowerCase()) throw new Error("chain changed during scan");
  if (ancestor && byNumber.get(ancestor.number)!.hash.toLowerCase() !== ancestor.hash.toLowerCase()) throw new Error("chain changed during scan");
  for (const log of logs) {
    if (byNumber.get(log.blockNumber)!.hash.toLowerCase() !== log.blockHash.toLowerCase()) throw new Error("log block hash does not match scanned header");
  }
  const headers = fetched.filter((header) => header.number <= to && header.number > (ancestor?.number ?? -1));
  await store.record(headers, logs);
  return to;
}
