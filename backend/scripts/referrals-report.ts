#!/usr/bin/env bun
// The referral credit report (Linear RM-174): who each wallet is credited to,
// and why a coded deposit did or did not count.
//
//   bun run referrals:report --out <dir>             credits.csv, attributions.csv and report.json
//   bun run referrals:report --wallet 0x…             why this wallet is or isn't credited
//   bun run referrals:report --tx 0x…                 what happened to this transaction's code
//
// Optional: --launch-block <n> (required until REFERRAL_LAUNCH_BLOCK is set in
// config), --to-block <n> (default: 32 blocks behind the head).
//
// IT WRITES NOTHING to the database and never connects to it. It reads the
// chain through BASE_RPC_URL (the public Base RPC by default) and the codes from
// backend/src/config.ts, so the same chain and the same config always give the
// same report. backend/src/config.ts insists on DATABASE_URL at import; when it
// is unset, this script sets a placeholder that is never dialled.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

process.env.DATABASE_URL ??= "postgres://referrals-report@127.0.0.1:1/unused";

const {
  config,
  REFERRAL_CODES,
  REFERRAL_DEPOSIT_CONTRACTS,
  REFERRAL_LAUNCH_BLOCK,
  REFERRAL_MANUAL_CREDITS,
} = await import("../src/config.ts");
const { validateReferralConfig } = await import("../src/referrals/codes.ts");
const { attributionsCsv, buildReferralReport, creditsCsv, explainTransaction, explainWallet, rpcReferralChainReader } =
  await import("../src/referrals/report.ts");

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    wallet: { type: "string" },
    tx: { type: "string" },
    "launch-block": { type: "string" },
    "to-block": { type: "string" },
  },
});

function blockArg(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a block number`);
  return Number(raw);
}

const configErrors = validateReferralConfig(REFERRAL_CODES, REFERRAL_MANUAL_CREDITS);
if (configErrors.length > 0) {
  console.error(["The referral config is not valid:", ...configErrors].join("\n  "));
  process.exit(1);
}

const launchBlock = blockArg("launch-block", values["launch-block"]) ?? REFERRAL_LAUNCH_BLOCK;
if (launchBlock === null) {
  console.error("Referrals have no launch block yet. Pass --launch-block <n>, or set REFERRAL_LAUNCH_BLOCK in backend/src/config.ts.");
  process.exit(1);
}
if (!values.out && !values.wallet && !values.tx) {
  console.error("Say what you want: --out <dir>, --wallet <address> or --tx <hash>.");
  process.exit(1);
}

const report = await buildReferralReport({
  reader: rpcReferralChainReader(config.baseRpcUrl),
  contracts: { ...REFERRAL_DEPOSIT_CONTRACTS, usdc: config.vault.usdc },
  codes: REFERRAL_CODES,
  manualCredits: REFERRAL_MANUAL_CREDITS,
  fromBlock: REFERRAL_DEPOSIT_CONTRACTS.fromBlock,
  launchBlock,
  toBlock: blockArg("to-block", values["to-block"]),
});

console.log(
  `Blocks ${report.fromBlock} to ${report.toBlock}, referrals from block ${report.launchBlock}: ` +
    `${report.credits.length} credited wallet(s), ${report.attributions.length} coded deposit(s).`,
);

if (values.wallet) console.log(explainWallet(report, values.wallet).join("\n"));
if (values.tx) console.log(explainTransaction(report, values.tx).join("\n"));

if (values.out) {
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "credits.csv"), creditsCsv(report));
  writeFileSync(join(values.out, "attributions.csv"), attributionsCsv(report));
  writeFileSync(join(values.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote credits.csv, attributions.csv and report.json to ${values.out}`);
}
