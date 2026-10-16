// The referral credit report (Linear RM-174), on fixtures with no network.
//
// WHAT THIS FILE PROTECTS. The rules (referrals-rules.test.ts) are only as
// good as what the report hands them. So this file checks the reading itself:
// that a routed deposit's legs come back as one deposit's legs, that "who
// paid" comes from the USDC transfer into the router or a vault and not from
// the router's own transfers to the vaults, that a deposit made for someone
// else shows its real payer, that a code in the middle of a bundle is found,
// that receipts are read only for transactions that carry a code, and that the
// --wallet and --tx answers and the CSVs say what the report decided.
import { test, expect, describe } from "bun:test";
import type { EthLog } from "../src/chain/base-rpc-client.ts";
import type { ReferralCodeEntry } from "../src/referrals/codes.ts";
import {
  ERC20_TRANSFER_TOPIC,
  ERC4626_DEPOSIT_TOPIC,
  REPORT_CONFIRMATIONS,
  attributionsCsv,
  buildReferralReport,
  collectDeposits,
  creditsCsv,
  explainTransaction,
  explainWallet,
  type ReferralChainReader,
} from "../src/referrals/report.ts";
import { encodeReferralSuffix } from "../src/referrals/suffix.ts";

const addr = (byte: string) => "0x" + byte.repeat(20);
const ROUTER = addr("0a");
const RMUSDC = addr("0b");
const RMPROTO = addr("0c");
const USDC = addr("0d");
const ALICE = addr("a1");
const BOB = addr("b0");
const CAROL = addr("c4");
const DAVE = addr("d4");
const MALLORY = addr("ee");
const contracts = { router: ROUTER, vaults: [RMUSDC, RMPROTO], usdc: USDC };

const LAUNCH_BLOCK = 1000;
const T0 = Date.parse("2026-10-20T00:00:00Z") / 1000;
const HEAD = 1100;

const codes: ReferralCodeEntry[] = [
  { code: "rm_acme", memberId: "m-acme", channel: null, termsVersion: "2026-10", enabledAt: "2026-10-20T00:00:00Z", disabledAt: null },
];

const hex = (n: number | bigint, bytes = 32) => BigInt(n).toString(16).padStart(bytes * 2, "0");
const topic = (address: string) => "0x" + "00".repeat(12) + address.slice(2);
const txHash = (n: number) => "0x" + hex(n);

const depositLog = (vault: string, owner: string, assets: number, tx: number, block: number, logIndex: number, sender = owner): EthLog => ({
  address: vault,
  topics: [ERC4626_DEPOSIT_TOPIC, topic(sender), topic(owner)],
  data: "0x" + hex(assets) + hex(BigInt(assets) * 10n ** 18n),
  blockNumber: "0x" + block.toString(16),
  transactionHash: txHash(tx),
  logIndex: "0x" + logIndex.toString(16),
});
const transferLog = (from: string, to: string, amount: number): EthLog => ({
  address: USDC,
  topics: [ERC20_TRANSFER_TOPIC, topic(from), topic(to)],
  data: "0x" + hex(amount),
  blockNumber: "0x0",
  transactionHash: "0x",
  logIndex: "0x0",
});

const ROUTER_DEPOSIT = "0xde3ab781" + hex(150_000_000) + hex(64) + hex(0);
const VAULT_DEPOSIT = (owner: string) => "0x6e553f65" + hex(50_000_000) + "00".repeat(12) + owner.slice(2);
const SUFFIX = encodeReferralSuffix("rm_acme").slice(2);

// tx 1: Alice deposits through the router with a code; two vault legs.
// tx 2: Bob deposits into rmUSDC directly, no code.
// tx 3: Mallory deposits through the router for Carol, with a code.
// tx 4: Dave's deposit inside a bundle; the code sits mid-input.
const logs = [
  depositLog(RMUSDC, ALICE, 100_000_000, 1, 1001, 2, ROUTER),
  depositLog(RMPROTO, ALICE, 50_000_000, 1, 1001, 5, ROUTER),
  depositLog(RMUSDC, BOB, 50_000_000, 2, 1002, 0),
  depositLog(RMUSDC, CAROL, 1_000_000, 3, 1003, 1, ROUTER),
  depositLog(RMUSDC, DAVE, 50_000_000, 4, 1004, 3),
];
const inputs: Record<string, string> = {
  [txHash(1)]: ROUTER_DEPOSIT + SUFFIX,
  [txHash(2)]: VAULT_DEPOSIT(BOB),
  [txHash(3)]: "0xbfde0706" + "00".repeat(12) + CAROL.slice(2) + hex(1_000_000) + SUFFIX,
  [txHash(4)]: "0x765e827f" + "00".repeat(64) + VAULT_DEPOSIT(DAVE).slice(2) + SUFFIX + "00".repeat(30) + "00".repeat(64),
};
const receipts: Record<string, EthLog[]> = {
  [txHash(1)]: [transferLog(ALICE, ROUTER, 150_000_000), transferLog(ROUTER, RMUSDC, 100_000_000), transferLog(ROUTER, RMPROTO, 50_000_000)],
  [txHash(2)]: [transferLog(BOB, RMUSDC, 50_000_000)],
  [txHash(3)]: [transferLog(MALLORY, ROUTER, 1_000_000), transferLog(ROUTER, RMUSDC, 1_000_000)],
  [txHash(4)]: [transferLog(DAVE, RMUSDC, 50_000_000)],
};

function fakeReader() {
  const receiptReads: string[] = [];
  const reader: ReferralChainReader = {
    headBlock: async () => HEAD,
    depositLogs: async (_addresses, from, to) =>
      logs.filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to),
    transactionInput: async (tx) => inputs[tx] ?? null,
    receiptLogs: async (tx) => {
      receiptReads.push(tx);
      return receipts[tx] ?? null;
    },
    blockTime: async (block) => T0 + (block - LAUNCH_BLOCK) * 2,
    position: async (vault, wallet) =>
      wallet === ALICE && vault === RMUSDC
        ? { shares: 100n * 10n ** 24n, assets: 101_000_000n }
        : wallet === ALICE && vault === RMPROTO
          ? { shares: 50n * 10n ** 24n, assets: 49_000_000n }
          : wallet === DAVE && vault === RMUSDC
            ? { shares: 50n * 10n ** 24n, assets: 50_000_000n }
            : { shares: 0n, assets: 0n },
  };
  return { reader, receiptReads };
}

const build = () =>
  buildReferralReport({
    reader: fakeReader().reader,
    contracts,
    codes,
    manualCredits: [],
    fromBlock: LAUNCH_BLOCK,
    launchBlock: LAUNCH_BLOCK,
  });

describe("collectDeposits", () => {
  test("reads every deposit, with its codes and who paid", async () => {
    const { reader, receiptReads } = fakeReader();
    const deposits = await collectDeposits(reader, contracts, LAUNCH_BLOCK, HEAD);
    expect(deposits.map((d) => [d.wallet, d.vault, d.payer, d.codes])).toEqual([
      [ALICE, RMUSDC, ALICE, ["rm_acme"]],
      [ALICE, RMPROTO, ALICE, ["rm_acme"]],
      [BOB, RMUSDC, null, []],
      [CAROL, RMUSDC, MALLORY, ["rm_acme"]],
      [DAVE, RMUSDC, DAVE, ["rm_acme"]],
    ]);
    expect(deposits[0]).toMatchObject({ assets: "100000000", blockNumber: 1001, logIndex: 2, blockTime: T0 + 2 });
    // Bob's uncoded deposit never needed its receipt.
    expect(receiptReads).toEqual([txHash(1), txHash(3), txHash(4)]);
  });

  test("a transaction the node does not know carries no code", async () => {
    const { reader } = fakeReader();
    const deposits = await collectDeposits(
      { ...reader, transactionInput: async () => null },
      contracts,
      LAUNCH_BLOCK,
      HEAD,
    );
    expect(deposits.every((d) => d.codes.length === 0 && d.payer === null)).toBe(true);
  });
});

describe("buildReferralReport", () => {
  test("credits the wallets that paid for their own coded deposits, with what they hold now", async () => {
    const report = await build();
    expect(report.toBlock).toBe(HEAD - REPORT_CONFIRMATIONS);
    expect(report.launchTime).toBe(T0);
    expect(report.credits.map((c) => [c.wallet, c.code, c.totalAssets])).toEqual([
      [ALICE, "rm_acme", "150000000"],
      [DAVE, "rm_acme", "50000000"],
    ]);
    expect(report.credits[0]?.positions).toHaveLength(2);
    expect(report.attributions.map((a) => [a.wallet, a.status])).toEqual([
      [ALICE, "bound"],
      [ALICE, "bound"],
      [CAROL, "review"],
      [DAVE, "bound"],
    ]);
  });

  test("refuses a range that ends before it starts", async () => {
    await expect(
      buildReferralReport({
        reader: fakeReader().reader,
        contracts,
        codes,
        manualCredits: [],
        fromBlock: HEAD,
        launchBlock: LAUNCH_BLOCK,
      }),
    ).rejects.toThrow("nothing to read");
  });
});

describe("answers and exports", () => {
  test("--wallet says why a wallet is or is not credited", async () => {
    const report = await build();
    expect(explainWallet(report, ALICE)[0]).toContain("is credited to rm_acme since 2026-10-20");
    expect(explainWallet(report, CAROL).join("\n")).toContain(`review. Paid by ${MALLORY}`);
    expect(explainWallet(report, BOB)[0]).toContain("carried a referral code");
  });

  test("--tx says what happened to a transaction's code", async () => {
    const report = await build();
    expect(explainTransaction(report, txHash(3))[0]).toContain("review");
    expect(explainTransaction(report, txHash(2))[0]).toContain("has no deposit into the vaults that carried a referral code");
  });

  test("the CSVs carry a header and one row per credit or coded deposit, quoting commas", async () => {
    const report = await build();
    const credits = creditsCsv(report).trimEnd().split("\n");
    expect(credits[0]).toBe("wallet,code,member_id,channel,source,tx_hash,block_number,bound_at,total_assets");
    expect(credits).toHaveLength(3);
    const attributions = attributionsCsv(report).trimEnd().split("\n");
    expect(attributions).toHaveLength(5);
    expect(attributions[3]).toContain(`"paid by ${MALLORY}, but the shares went to ${CAROL}"`);
  });
});
