// The referral credit report (Linear RM-174): read the deposits from the chain,
// apply the credit rules, and say who is credited and why.
//
// WHY A REPORT AND NOT A JOB. There is no referral table and no scheduled scan.
// The code each deposit carried is on chain for good, so the credit list is
// rebuilt from the chain whenever someone asks: monthly for the member emails,
// or for one wallet or one transaction when a member asks "why didn't I get
// credit?". Nothing is written to the database, so no migration, no job
// schedule and no chain-event store (D16, D36).
//
// WHAT IT READS, all through the shared transport in chain/base-rpc-client.ts:
//   - every ERC-4626 Deposit event from the vaults, in 500-block windows (the
//     public Base RPC's eth_getLogs cap), stopping 32 blocks behind the head;
//   - each deposit transaction's input, where a referral suffix may ride;
//   - for a transaction that carries a code, its receipt, to see who paid the
//     USDC into the router or the vault;
//   - each block's timestamp, once per block;
//   - for every credited wallet, its current shares and their value per vault.
// A public RPC's rate limit makes this slow over long ranges, which is fine for
// a report somebody runs by hand.
//
// The chain reads sit behind ReferralChainReader, so the tests run on fixtures
// with no network.
import {
  decodeUint256,
  encodeBalanceOfCall,
  encodeConvertToAssetsCall,
  ethBlockNumber,
  ethCall,
  ethGetLogs,
  ethGetTransactionByHash,
  ethGetTransactionReceipt,
  rpcRequest,
  toBlockTag,
  type EthLog,
  type RpcCallOptions,
} from "../chain/base-rpc-client.ts";
import type { ReferralCodeEntry, ReferralManualCredit } from "./codes.ts";
import {
  attributeReferrals,
  type DepositObservation,
  type ReferralAttribution,
  type ReferralBinding,
  type SkippedManualCredit,
} from "./rules.ts";
import { findReferralCodes } from "./suffix.ts";

/** keccak256("Deposit(address,address,uint256,uint256)"), the ERC-4626 event. */
export const ERC4626_DEPOSIT_TOPIC = "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7";
/** keccak256("Transfer(address,address,uint256)"), the ERC-20 event. */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** mainnet.base.org refuses an eth_getLogs range wider than this. */
export const REPORT_LOG_WINDOW = 500;
/** The report stops this many blocks behind the head, so a reorg cannot rewrite what it read. */
export const REPORT_CONFIRMATIONS = 32;

/** The contracts a deposit goes through. */
export type ReferralDepositContracts = {
  router: string;
  vaults: readonly string[];
  usdc: string;
};

/** Everything the report reads from the chain. */
export interface ReferralChainReader {
  headBlock(): Promise<number>;
  /** ERC-4626 Deposit logs from `addresses` over [fromBlock, toBlock], in block order. */
  depositLogs(addresses: readonly string[], fromBlock: number, toBlock: number): Promise<EthLog[]>;
  /** The transaction's full input, or null when the node does not know the hash. */
  transactionInput(txHash: string): Promise<string | null>;
  /** The receipt's logs, or null when the node does not know the hash. */
  receiptLogs(txHash: string): Promise<EthLog[] | null>;
  /** The block's timestamp, unix seconds. */
  blockTime(blockNumber: number): Promise<number>;
  /** The wallet's shares in the vault, and what they are worth in the vault's asset. */
  position(vault: string, wallet: string): Promise<{ shares: bigint; assets: bigint }>;
}

/** The reader the report uses in production: the shared Base RPC transport. */
export function rpcReferralChainReader(rpcUrl: string): ReferralChainReader {
  const opts: RpcCallOptions = { rpcUrl };
  const blockTimes = new Map<number, number>();
  return {
    headBlock: () => ethBlockNumber(opts),
    async depositLogs(addresses, fromBlock, toBlock) {
      const logs: EthLog[] = [];
      for (let start = fromBlock; start <= toBlock; start += REPORT_LOG_WINDOW) {
        const end = Math.min(start + REPORT_LOG_WINDOW - 1, toBlock);
        logs.push(
          ...(await ethGetLogs(
            {
              address: [...addresses],
              topics: [ERC4626_DEPOSIT_TOPIC],
              fromBlock: toBlockTag(start),
              toBlock: toBlockTag(end),
            },
            opts,
          )),
        );
      }
      return logs;
    },
    async transactionInput(txHash) {
      return (await ethGetTransactionByHash(txHash, opts))?.input ?? null;
    },
    async receiptLogs(txHash) {
      return (await ethGetTransactionReceipt(txHash, opts))?.logs ?? null;
    },
    async blockTime(blockNumber) {
      const cached = blockTimes.get(blockNumber);
      if (cached !== undefined) return cached;
      const block = await rpcRequest<{ timestamp?: string } | null>(
        "eth_getBlockByNumber",
        [toBlockTag(blockNumber), false],
        opts,
      );
      if (!block || typeof block.timestamp !== "string") {
        throw new Error(`Base RPC: block ${blockNumber} without a timestamp`);
      }
      const seconds = Number(BigInt(block.timestamp));
      blockTimes.set(blockNumber, seconds);
      return seconds;
    },
    async position(vault, wallet) {
      const shares = decodeUint256(await ethCall(vault, encodeBalanceOfCall(wallet), opts));
      const assets = shares === 0n ? 0n : decodeUint256(await ethCall(vault, encodeConvertToAssetsCall(shares), opts));
      return { shares, assets };
    },
  };
}

/**
 * Every deposit into the vaults over [fromBlock, toBlock], with the codes its
 * transaction carried and who paid for it.
 *
 * WHO PAID. The rules only bind a wallet that paid for its own shares. In the
 * receipt, the deposit's wallet paid when a USDC Transfer from that wallet went
 * into the router or a vault. Otherwise the payer is the first sender, outside
 * the router and the vaults, of USDC into them (a depositFor from someone else),
 * or null when there is none. Receipts are read only for transactions that
 * carry a code, since only those can bind a wallet.
 */
export async function collectDeposits(
  reader: ReferralChainReader,
  contracts: ReferralDepositContracts,
  fromBlock: number,
  toBlock: number,
): Promise<DepositObservation[]> {
  const vaults = contracts.vaults.map((v) => v.toLowerCase());
  const depositContracts = new Set([contracts.router.toLowerCase(), ...vaults]);
  const usdc = contracts.usdc.toLowerCase();

  const logs = (await reader.depositLogs(vaults, fromBlock, toBlock)).filter(
    (log) => log.topics[0]?.toLowerCase() === ERC4626_DEPOSIT_TOPIC && vaults.includes(log.address.toLowerCase()),
  );

  const codesByTx = new Map<string, string[]>();
  const transfersByTx = new Map<string, { from: string; to: string }[]>();
  const observations: DepositObservation[] = [];

  for (const log of logs) {
    const txHash = log.transactionHash.toLowerCase();
    if (!codesByTx.has(txHash)) {
      const input = await reader.transactionInput(txHash);
      codesByTx.set(txHash, input === null ? [] : findReferralCodes(input));
    }
    const codes = codesByTx.get(txHash)!;

    if (codes.length > 0 && !transfersByTx.has(txHash)) {
      const receipt = (await reader.receiptLogs(txHash)) ?? [];
      transfersByTx.set(
        txHash,
        receipt
          .filter((l) => l.address.toLowerCase() === usdc && l.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC)
          .map((l) => ({ from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]) }))
          .filter((t) => depositContracts.has(t.to) && !depositContracts.has(t.from)),
      );
    }

    const blockNumber = Number(BigInt(log.blockNumber));
    const wallet = topicAddress(log.topics[2]);
    const transfers = transfersByTx.get(txHash) ?? [];
    const payer = transfers.some((t) => t.from === wallet) ? wallet : (transfers[0]?.from ?? null);

    observations.push({
      txHash,
      logIndex: Number(BigInt(log.logIndex)),
      blockNumber,
      blockTime: await reader.blockTime(blockNumber),
      wallet,
      vault: log.address.toLowerCase(),
      assets: BigInt(log.data.slice(0, 66)).toString(),
      payer: codes.length > 0 ? payer : null,
      codes,
    });
  }
  return observations;
}

/** One credited wallet, with what it holds now. */
export type ReferralCredit = ReferralBinding & {
  positions: { vault: string; shares: string; assets: string }[];
  /** The sum of the positions' value, in the vaults' asset (USDC, 6 decimals). */
  totalAssets: string;
};

export type ReferralReport = {
  fromBlock: number;
  toBlock: number;
  launchBlock: number;
  launchTime: number;
  credits: ReferralCredit[];
  attributions: ReferralAttribution[];
  skippedManualCredits: SkippedManualCredit[];
};

export type ReferralReportInput = {
  reader: ReferralChainReader;
  contracts: ReferralDepositContracts;
  codes: readonly ReferralCodeEntry[];
  manualCredits: readonly ReferralManualCredit[];
  /** Where the scan starts: early enough to see every wallet's first deposit. */
  fromBlock: number;
  /** Referrals count from this block. */
  launchBlock: number;
  /** Where the scan stops; defaults to REPORT_CONFIRMATIONS behind the head. */
  toBlock?: number;
};

export async function buildReferralReport(input: ReferralReportInput): Promise<ReferralReport> {
  const toBlock = input.toBlock ?? (await input.reader.headBlock()) - REPORT_CONFIRMATIONS;
  if (toBlock < input.fromBlock) throw new Error(`nothing to read: toBlock ${toBlock} is before fromBlock ${input.fromBlock}`);
  const launchTime = await input.reader.blockTime(input.launchBlock);
  const deposits = await collectDeposits(input.reader, input.contracts, input.fromBlock, toBlock);
  const result = attributeReferrals({
    deposits,
    codes: input.codes,
    manualCredits: input.manualCredits,
    launchTime,
  });

  const credits: ReferralCredit[] = [];
  for (const binding of result.bindings) {
    const positions = [];
    let total = 0n;
    for (const vault of input.contracts.vaults) {
      const { shares, assets } = await input.reader.position(vault.toLowerCase(), binding.wallet);
      if (shares === 0n) continue;
      positions.push({ vault: vault.toLowerCase(), shares: shares.toString(), assets: assets.toString() });
      total += assets;
    }
    credits.push({ ...binding, positions, totalAssets: total.toString() });
  }

  return {
    fromBlock: input.fromBlock,
    toBlock,
    launchBlock: input.launchBlock,
    launchTime,
    credits,
    attributions: result.attributions,
    skippedManualCredits: result.skippedManualCredits,
  };
}

/** The answer to "why didn't this wallet get credit?", in plain lines. */
export function explainWallet(report: ReferralReport, wallet: string): string[] {
  const w = wallet.toLowerCase();
  const credit = report.credits.find((c) => c.wallet === w);
  const rows = report.attributions.filter((a) => a.wallet === w);
  const lines: string[] = [];
  if (credit) {
    lines.push(
      `${w} is credited to ${credit.code} since ${isoDate(credit.boundAt)} (${credit.source}, tx ${credit.txHash}).`,
    );
  }
  for (const row of rows) lines.push(describe(row));
  const skipped = report.skippedManualCredits.find((s) => s.wallet === w);
  if (skipped) lines.push(`Manual credit to ${skipped.code} not applied: ${skipped.reason}.`);
  if (lines.length === 0) {
    lines.push(
      `No deposit from ${w} carried a referral code between blocks ${report.fromBlock} and ${report.toBlock}, and it has no manual credit.`,
    );
  }
  return lines;
}

/** The answer for one transaction, in plain lines. */
export function explainTransaction(report: ReferralReport, txHash: string): string[] {
  const rows = report.attributions.filter((a) => a.txHash === txHash.toLowerCase());
  if (rows.length === 0) {
    return [
      `Transaction ${txHash} has no deposit into the vaults that carried a referral code between blocks ${report.fromBlock} and ${report.toBlock}.`,
    ];
  }
  return rows.map(describe);
}

/** The credit list as CSV. */
export function creditsCsv(report: ReferralReport): string {
  const header = ["wallet", "code", "member_id", "channel", "source", "tx_hash", "block_number", "bound_at", "total_assets"];
  const rows = report.credits.map((c) => [
    c.wallet,
    c.code,
    c.memberId ?? "",
    c.channel ?? "",
    c.source,
    c.txHash,
    c.blockNumber === null ? "" : String(c.blockNumber),
    isoTime(c.boundAt),
    c.totalAssets,
  ]);
  return toCsv([header, ...rows]);
}

/** Every coded deposit and its outcome, as CSV. */
export function attributionsCsv(report: ReferralReport): string {
  const header = ["tx_hash", "log_index", "block_number", "block_time", "wallet", "vault", "assets", "codes", "status", "reason", "member_id", "channel"];
  const rows = report.attributions.map((a) => [
    a.txHash,
    String(a.logIndex),
    String(a.blockNumber),
    isoTime(a.blockTime),
    a.wallet,
    a.vault,
    a.assets,
    a.codes.join(" "),
    a.status,
    a.reason,
    a.memberId ?? "",
    a.channel ?? "",
  ]);
  return toCsv([header, ...rows]);
}

function describe(row: ReferralAttribution): string {
  return `Block ${row.blockNumber}, tx ${row.txHash}, ${row.vault}: ${row.status}. ${capitalize(row.reason)}.`;
}

function topicAddress(topic: string | undefined): string {
  if (!topic || topic.length < 42) throw new Error("log topic is not an address");
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function isoDate(seconds: number): string {
  return isoTime(seconds).slice(0, 10);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
