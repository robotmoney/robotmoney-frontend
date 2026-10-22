// The referral report's evidence collector (issue 1371, docs/technical/referrals-spec.md §7).
//
// It reads the chain through the ONE shared transport (chain/base-rpc-client.ts)
// and its one token bucket: no second client, no second limiter. It never
// writes a database. Its only state is a local checkpoint file of this CLI run.
//
//   1. Resolve the RPC `finalized` head once. An explicit cutoff must be at or
//      before it. Depth is never treated as finality: a provider that cannot
//      answer `finalized` makes the report incomplete.
//   2. Pin the cutoff block's number and hash.
//   3. Scan every manifest entry's history through the cutoff in bounded log
//      ranges, checkpointing each range. A range that fails after the
//      transport's bounded retries is recorded as failed, never as empty.
//   4. Fetch receipt, transaction and block for every transaction a scanned log
//      names. A missing one is recorded as missing: the decoder makes it unknown.
//   5. Re-read the cutoff block. A changed hash invalidates the run.
//
// Hitting the RPC or time budget stops the scan with the checkpoint written and
// the remaining ranges `pending`: an incomplete artifact, never a silently
// shortened history.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import {
  ethCallBatch,
  ethGetBlockHeader,
  ethGetBlockHeaderBatch,
  ethGetLogs,
  ethGetTransactionByHashBatch,
  ethGetTransactionReceiptBatch,
  encodeBalanceOfCall,
  encodeConvertToAssetsCall,
  decodeUint256,
  isEmptyReturnData,
  toBlockTag,
  type RpcCallOptions,
} from "../chain/base-rpc-client.ts";
import { CARRIER_TOPIC, DEPOSIT_TOPIC, type RawLog } from "./carrier.ts";
import type { RawBlock, RawReceipt, RawTransaction, TransactionEvidence } from "./evidence.ts";
import type { ReferralManifest } from "./manifest.ts";

export interface ScanRange {
  entryId: string;
  fromBlock: number;
  toBlock: number;
  status: "complete" | "failed" | "pending";
  logCount: number;
  error: string | null;
}

export interface PinnedBlock {
  number: number;
  hash: string;
  timestamp: number;
}

export interface CollectedEvidence {
  chainId: number;
  cutoff: PinnedBlock | null;
  finalizedHead: { number: number; hash: string } | null;
  ranges: ScanRange[];
  transactions: TransactionEvidence[];
  errors: string[];
  stoppedByBudget: boolean;
  /** Set when the cutoff hash changed during the run: publication is blocked. */
  invalidated: string | null;
  stats: { rpcCalls: number; elapsedMs: number; peakRssBytes: number; resumedRanges: number };
}

export interface CollectOptions {
  rpc: RpcCallOptions;
  manifest: ReferralManifest;
  /** Explicit cutoff block; default the finalized head. */
  cutoffBlock?: number;
  /** Blocks per eth_getLogs range. */
  rangeBlocks: number;
  /** Local checkpoint file; omitted means no checkpoint. */
  checkpointPath?: string;
  /** Identity of the inputs (manifest, registry, log and rules revisions). A checkpoint is reused only under the same key and cutoff hash. */
  checkpointKey: string;
  budget?: { maxRpcCalls?: number; maxSeconds?: number };
  /** Injected clock, for tests. */
  nowMs?: () => number;
}

interface Checkpoint {
  schema: "robotmoney.referral-scan-checkpoint/1";
  key: string;
  cutoff: { number: number; hash: string };
  ranges: Record<string, { status: "complete"; logs: RawLog[] }>;
  transactions: Record<string, { receipt: RawReceipt | null; transaction: RawTransaction | null; block: RawBlock | null }>;
}

const rangeId = (r: { entryId: string; fromBlock: number; toBlock: number }) => `${r.entryId}:${r.fromBlock}-${r.toBlock}`;
const hexNum = (v: string) => Number(BigInt(v));

class BudgetExhausted extends Error {}

export async function collectEvidence(opts: CollectOptions): Promise<CollectedEvidence> {
  const now = opts.nowMs ?? Date.now;
  const started = now();
  const out: CollectedEvidence = {
    chainId: opts.manifest.chainId,
    cutoff: null,
    finalizedHead: null,
    ranges: [],
    transactions: [],
    errors: [],
    stoppedByBudget: false,
    invalidated: null,
    stats: { rpcCalls: 0, elapsedMs: 0, peakRssBytes: 0, resumedRanges: 0 },
  };
  const sample = () => {
    out.stats.peakRssBytes = Math.max(out.stats.peakRssBytes, process.memoryUsage().rss);
    out.stats.elapsedMs = now() - started;
  };
  const spend = (n: number) => {
    const b = opts.budget ?? {};
    if (b.maxRpcCalls !== undefined && out.stats.rpcCalls + n > b.maxRpcCalls) throw new BudgetExhausted(`RPC budget of ${b.maxRpcCalls} calls reached`);
    if (b.maxSeconds !== undefined && now() - started > b.maxSeconds * 1000) throw new BudgetExhausted(`time budget of ${b.maxSeconds}s reached`);
    out.stats.rpcCalls += n;
  };

  // 1-2. Finality and the pinned cutoff.
  let finalized;
  try {
    spend(1);
    finalized = await ethGetBlockHeader("finalized", opts.rpc);
  } catch (err) {
    out.errors.push(`finalized head unavailable: ${message(err)}`);
    sample();
    return out;
  }
  if (!finalized) {
    out.errors.push("the provider did not establish a finalized head; the report is incomplete (32-block depth is not finality)");
    sample();
    return out;
  }
  out.finalizedHead = { number: hexNum(finalized.number), hash: finalized.hash.toLowerCase() };
  let cutoffHeader = finalized;
  if (opts.cutoffBlock !== undefined) {
    if (opts.cutoffBlock > out.finalizedHead.number) {
      out.errors.push(`cutoff block ${opts.cutoffBlock} is after the finalized head ${out.finalizedHead.number}`);
      sample();
      return out;
    }
    try {
      spend(1);
      const h = await ethGetBlockHeader(opts.cutoffBlock, opts.rpc);
      if (!h) throw new Error("no such block");
      cutoffHeader = h;
    } catch (err) {
      out.errors.push(`cutoff block ${opts.cutoffBlock} unavailable: ${message(err)}`);
      sample();
      return out;
    }
  }
  out.cutoff = { number: hexNum(cutoffHeader.number), hash: cutoffHeader.hash.toLowerCase(), timestamp: hexNum(cutoffHeader.timestamp) };
  const cutoff = out.cutoff;

  // Checkpoint: reused only for the same inputs and the same pinned block.
  let cp: Checkpoint = { schema: "robotmoney.referral-scan-checkpoint/1", key: opts.checkpointKey, cutoff: { number: cutoff.number, hash: cutoff.hash }, ranges: {}, transactions: {} };
  if (opts.checkpointPath && existsSync(opts.checkpointPath)) {
    const prior = JSON.parse(readFileSync(opts.checkpointPath, "utf8")) as Checkpoint;
    if (prior.key !== opts.checkpointKey || prior.cutoff?.hash !== cutoff.hash || prior.cutoff?.number !== cutoff.number) {
      throw new Error(`checkpoint ${opts.checkpointPath} was written for other inputs or another cutoff; use a new checkpoint path`);
    }
    cp = prior;
  }
  const save = () => {
    if (!opts.checkpointPath) return;
    const tmp = `${opts.checkpointPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(cp));
    renameSync(tmp, opts.checkpointPath);
  };

  // 3. Ranges.
  for (const e of opts.manifest.entries) {
    if (e.startBlock === null) continue; // a manifest gap; the report names it
    const last = Math.min(e.endBlock ?? cutoff.number, cutoff.number);
    for (let from = e.startBlock; from <= last; from += opts.rangeBlocks) {
      out.ranges.push({ entryId: e.id, fromBlock: from, toBlock: Math.min(from + opts.rangeBlocks - 1, last), status: "pending", logCount: 0, error: null });
    }
  }
  const logsByKey = new Map<string, RawLog>();
  const addLogs = (logs: RawLog[]) => {
    for (const l of logs) logsByKey.set(`${l.transactionHash.toLowerCase()}:${hexNum(l.logIndex)}`, l); // dedup (chainId, tx, logIndex)
  };
  try {
    for (const r of out.ranges) {
      const done = cp.ranges[rangeId(r)];
      if (done) {
        r.status = "complete";
        r.logCount = done.logs.length;
        addLogs(done.logs);
        out.stats.resumedRanges++;
        continue;
      }
      const entry = opts.manifest.entries.find((x) => x.id === r.entryId)!;
      spend(1);
      try {
        const logs = (await ethGetLogs({ address: entry.address, topics: [[DEPOSIT_TOPIC, CARRIER_TOPIC]], fromBlock: toBlockTag(r.fromBlock), toBlock: toBlockTag(r.toBlock) }, opts.rpc)) as RawLog[];
        for (const l of logs) {
          const n = hexNum(l.blockNumber);
          if (n < r.fromBlock || n > r.toBlock || l.address.toLowerCase() !== entry.address || l.removed) throw new Error(`log outside the requested range or removed (block ${n})`);
        }
        r.status = "complete";
        r.logCount = logs.length;
        addLogs(logs);
        cp.ranges[rangeId(r)] = { status: "complete", logs };
        save();
      } catch (err) {
        r.status = "failed";
        r.error = message(err);
        out.errors.push(`range ${rangeId(r)} failed: ${r.error}`);
      }
      sample();
    }

    // 4. Evidence per transaction.
    const byTx = new Map<string, RawLog[]>();
    for (const l of [...logsByKey.values()]) {
      const h = l.transactionHash.toLowerCase();
      byTx.set(h, [...(byTx.get(h) ?? []), l]);
    }
    const hashes = [...byTx.keys()].sort();
    const missing = hashes.filter((h) => !cp.transactions[h]);
    if (missing.length) {
      spend(missing.length * 2);
      const [receipts, txs] = [await ethGetTransactionReceiptBatch(missing, opts.rpc), await ethGetTransactionByHashBatch(missing, opts.rpc)];
      const blockNums = new Set<number>();
      missing.forEach((h, i) => {
        const rc = receipts[i]!;
        const tx = txs[i]!;
        if (!rc.ok) out.errors.push(`receipt ${h}: ${rc.error.message}`);
        if (!tx.ok) out.errors.push(`transaction ${h}: ${tx.error.message}`);
        const n = rc.ok && rc.result && typeof rc.result.blockNumber === "string" ? hexNum(rc.result.blockNumber) : hexNum(byTx.get(h)![0]!.blockNumber);
        blockNums.add(n);
      });
      const nums = [...blockNums].sort((a, b) => a - b);
      spend(nums.length);
      const blocks = await ethGetBlockHeaderBatch(nums, opts.rpc);
      const blockBy = new Map<number, RawBlock | null>();
      nums.forEach((n, i) => {
        const b = blocks[i]!;
        if (!b.ok) out.errors.push(`block ${n}: ${b.error.message}`);
        blockBy.set(n, b.ok ? (b.result as RawBlock | null) : null);
      });
      missing.forEach((h, i) => {
        const rc = receipts[i]!;
        const tx = txs[i]!;
        const receipt = rc.ok ? (rc.result as RawReceipt | null) : null;
        const n = receipt && typeof receipt.blockNumber === "string" ? hexNum(receipt.blockNumber) : hexNum(byTx.get(h)![0]!.blockNumber);
        cp.transactions[h] = { receipt, transaction: tx.ok ? (tx.result as RawTransaction | null) : null, block: blockBy.get(n) ?? null };
      });
      save();
      sample();
    }
    out.transactions = hashes.map((h) => ({ transactionHash: h, scannedLogs: byTx.get(h)!.sort((a, b) => hexNum(a.logIndex) - hexNum(b.logIndex)), ...cp.transactions[h]! }));

    // 5. The pinned block must still be the same block.
    spend(1);
    const again = await ethGetBlockHeader(cutoff.number, opts.rpc);
    if (!again || again.hash.toLowerCase() !== cutoff.hash) out.invalidated = `cutoff block ${cutoff.number} hash changed from ${cutoff.hash} to ${again?.hash ?? "nothing"}; rescan required`;
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    out.stoppedByBudget = true;
    out.errors.push(`${err.message}: stopped with a resumable checkpoint; history is incomplete`);
    save();
  }
  sample();
  return out;
}

export interface HoldingRow {
  wallet: string;
  entryId: string;
  /** Raw integer share units. */
  shares: string;
  /** Raw integer asset units at the pinned block (convertToAssets). */
  assets: string;
}

export interface Holdings {
  label: string;
  block: { number: number; hash: string };
  assetDecimals: number;
  rows: HoldingRow[];
  errors: string[];
  complete: boolean;
}

/**
 * Descriptive holdings at the pinned block: balanceOf, then convertToAssets,
 * per wallet per vault. A block-addressed call that returns `0x` is a failure,
 * never a zero (D36). The block hash is verified before and after. Raw integers
 * only; rounding is presentation, never an attribution input.
 */
export async function collectHoldings(rpc: RpcCallOptions, manifest: ReferralManifest, wallets: readonly string[], cutoff: PinnedBlock): Promise<Holdings> {
  const out: Holdings = {
    label: "descriptive holdings: includes transferred-in shares and later deposits, decreases on withdrawal; not referred or qualified capital",
    block: { number: cutoff.number, hash: cutoff.hash },
    assetDecimals: manifest.asset.decimals,
    rows: [],
    errors: [],
    complete: false,
  };
  const blockTag = toBlockTag(cutoff.number);
  const verify = async (when: string) => {
    const h = await ethGetBlockHeader(cutoff.number, rpc).catch(() => null);
    if (!h || h.hash.toLowerCase() !== cutoff.hash) out.errors.push(`pinned block hash check ${when} failed`);
  };
  await verify("before");
  const vaults = manifest.entries.filter((e) => e.kind === "vault");
  const pairs = wallets.flatMap((w) => vaults.map((v) => ({ wallet: w, entry: v })));
  let balances;
  try {
    balances = await ethCallBatch(pairs.map((p) => ({ to: p.entry.address, data: encodeBalanceOfCall(p.wallet), blockTag })), rpc);
  } catch (err) {
    out.errors.push(`balanceOf reads failed: ${message(err)}`);
    return out;
  }
  const withShares: { wallet: string; entryId: string; address: string; shares: bigint }[] = [];
  pairs.forEach((p, i) => {
    const r = balances[i]!;
    if (!r.ok) return void out.errors.push(`balanceOf ${p.entry.id} ${p.wallet}: ${r.error.message}`);
    if (isEmptyReturnData(r.result)) return void out.errors.push(`balanceOf ${p.entry.id} ${p.wallet}: empty return at block ${cutoff.number} (archive state unavailable, never zero)`);
    const shares = decodeUint256(r.result);
    if (shares > 0n) withShares.push({ wallet: p.wallet, entryId: p.entry.id, address: p.entry.address, shares });
  });
  let assets;
  try {
    assets = await ethCallBatch(withShares.map((p) => ({ to: p.address, data: encodeConvertToAssetsCall(p.shares), blockTag })), rpc);
  } catch (err) {
    out.errors.push(`convertToAssets reads failed: ${message(err)}`);
    return out;
  }
  withShares.forEach((p, i) => {
    const r = assets[i]!;
    if (!r.ok) return void out.errors.push(`convertToAssets ${p.entryId} ${p.wallet}: ${r.error.message}`);
    if (isEmptyReturnData(r.result)) return void out.errors.push(`convertToAssets ${p.entryId} ${p.wallet}: empty return (never zero)`);
    out.rows.push({ wallet: p.wallet, entryId: p.entryId, shares: p.shares.toString(), assets: decodeUint256(r.result).toString() });
  });
  await verify("after");
  out.rows.sort((a, b) => (a.wallet + a.entryId < b.wallet + b.entryId ? -1 : 1));
  out.complete = out.errors.length === 0;
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
