// The referral attribution report CLI (issue 1371, docs/technical/referrals-spec.md §7).
//
// A committed script, run by an agent from the control machine (D61), never
// typed by hand on a host. It reads the chain through the shared RPC transport
// and writes private local artifacts; it opens no database and needs no
// DATABASE_URL. Full wallet reports are private operational artifacts: they are
// written 0600 and never belong in a preview, a golden or a public page.
//
//   bun run referrals:report scan --out <dir> (--config-tag vX.Y.Z | --working-tree)
//       [--cutoff-block N] [--range-blocks 2000] [--checkpoint <file>]
//       [--holdings] [--max-rpc-calls N] [--max-seconds N]
//       [--rpc-url URL] [--rules-revision <git sha>]
//   bun run referrals:report explain --report <dir>/report.json (--wallet 0x.. | --tx 0x..)
//   bun run referrals:report verify --report <dir>/report.json
//
// scan writes report.json (payload, digest, diagnostics), report.csv with its
// provenance.json, and receipt.json (the run's arguments, revisions, digests,
// RPC count, elapsed time and peak memory). A run stopped by its budget, or with
// failed ranges, still writes all four, marked incomplete, and its checkpoint
// lets the next run resume without rescanning completed ranges.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectEvidence, collectHoldings } from "../src/referrals/collect.ts";
import { configDigest, loadReferralConfig, validateAcceptedRevisions, validateWorkingConfig } from "../src/referrals/config-files.ts";
import { checkCorrectionLog, verifyContractSignature, type CorrectionEntry } from "../src/referrals/corrections.ts";
import { buildReport, explainTransaction, explainWallet, payloadDigestOf, provenanceOf, toCsv, type Report } from "../src/referrals/report.ts";
import { toBlockTag } from "../src/chain/base-rpc-client.ts";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (args: string[], name: string) => args.includes(name);
const int = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
}

function rulesRevision(explicit: string | undefined): { revision: string; clean: boolean } {
  if (explicit) return { revision: explicit, clean: true };
  const cwd = join(import.meta.dir, "..");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "src/referrals", "scripts/referrals-report.ts", "src/chain/base-rpc-client.ts", "src/analytics/run-ledger.ts"], { encoding: "utf8", cwd }).trim();
  return dirty ? { revision: `${sha}-dirty`, clean: false } : { revision: sha, clean: true };
}

async function scan(args: string[]): Promise<number> {
  const out = arg(args, "--out");
  if (!out) throw new Error("scan needs --out <dir>");
  const tag = arg(args, "--config-tag");
  const workingTree = flag(args, "--working-tree");
  if (!!tag === workingTree) throw new Error("scan needs exactly one of --config-tag vX.Y.Z (an accepted revision) or --working-tree (diagnostics only)");

  const files = loadReferralConfig();
  let selected: { registry: typeof files.registry; corrections: typeof files.corrections; manifest: typeof files.manifest; label: string; accepted: boolean };
  if (tag) {
    const errors = validateAcceptedRevisions(files.accepted);
    if (errors.length) throw new Error(`accepted revisions do not validate:\n${errors.join("\n")}`);
    const rev = files.accepted.revisions.find((r) => r.tag === tag);
    if (!rev) throw new Error(`no accepted revision ${tag}; accepted: ${files.accepted.revisions.map((r) => r.tag).join(", ") || "none yet"}`);
    selected = { registry: rev.registry, corrections: rev.corrections, manifest: rev.manifest, label: tag, accepted: true };
  } else {
    const errors = validateWorkingConfig(files, Math.floor(Date.now() / 1000));
    if (errors.length) throw new Error(`working-tree referral config does not validate:\n${errors.join("\n")}`);
    selected = { ...files, label: "working-tree", accepted: false };
  }
  const rules = rulesRevision(arg(args, "--rules-revision"));
  const rpc = { rpcUrl: arg(args, "--rpc-url") ?? process.env.BASE_RPC_URL ?? "https://mainnet.base.org" };
  const checkpointKey = configDigest({ manifest: selected.manifest, registry: selected.registry, corrections: selected.corrections, rules: rules.revision });

  const evidence = await collectEvidence({
    rpc,
    manifest: selected.manifest,
    cutoffBlock: int(arg(args, "--cutoff-block"), "--cutoff-block"),
    rangeBlocks: int(arg(args, "--range-blocks"), "--range-blocks") ?? 2000,
    checkpointPath: arg(args, "--checkpoint"),
    checkpointKey,
    budget: { maxRpcCalls: int(arg(args, "--max-rpc-calls"), "--max-rpc-calls"), maxSeconds: int(arg(args, "--max-seconds"), "--max-seconds") },
  });

  // EIP-1271 corrections are checked at the pinned block.
  const contractProblems = new Map<string, string[]>();
  if (evidence.cutoff) {
    const checks = checkCorrectionLog(selected.corrections, selected.registry);
    for (const c of checks.entries) {
      if (!c.needsContractSignatureCheck) continue;
      const entry = selected.corrections.entries.find((e) => e.id === c.id) as CorrectionEntry;
      const v = await verifyContractSignature(entry, { ...rpc, blockTag: toBlockTag(evidence.cutoff.number) });
      contractProblems.set(c.id, v.status === "accepted" ? [] : [v.problem ?? v.status]);
    }
  }

  let report: Report = buildReport({ evidence, registry: selected.registry, corrections: selected.corrections, manifest: selected.manifest, revisions: { rules: rules.revision, config: selected.label, configAccepted: selected.accepted && rules.clean }, contractSignatureProblems: contractProblems });
  if (flag(args, "--holdings") && evidence.cutoff) {
    const holdings = await collectHoldings(rpc, selected.manifest, report.payload.rows.map((r) => r.wallet), evidence.cutoff);
    report = buildReport({ evidence, registry: selected.registry, corrections: selected.corrections, manifest: selected.manifest, revisions: { rules: rules.revision, config: selected.label, configAccepted: selected.accepted && rules.clean }, contractSignatureProblems: contractProblems, holdings });
  }

  mkdirSync(out, { recursive: true, mode: 0o700 });
  writePrivate(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writePrivate(join(out, "report.csv"), toCsv(report));
  writePrivate(join(out, "provenance.json"), JSON.stringify(provenanceOf(report), null, 2) + "\n");
  const receipt = {
    schema: "robotmoney.referral-report-receipt/1",
    command: ["scan", ...args],
    rulesRevision: rules.revision,
    config: selected.label,
    payloadDigest: report.payloadDigest,
    final: report.payload.final,
    completeness: report.payload.completeness,
    cutoff: report.payload.cutoff,
    diagnostics: report.diagnostics,
    errors: report.payload.errors,
  };
  writePrivate(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ payloadDigest: report.payloadDigest, final: report.payload.final, completeness: report.payload.completeness, rows: report.payload.rows.length, errors: report.payload.errors.length, rpcCalls: report.diagnostics.rpcCalls, elapsedMs: report.diagnostics.elapsedMs }));
  return report.payload.final ? 0 : 3;
}

function readReport(args: string[]): Report {
  const path = arg(args, "--report");
  if (!path) throw new Error("needs --report <report.json>");
  return JSON.parse(readFileSync(path, "utf8")) as Report;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === "scan") return scan(args);
  if (cmd === "explain") {
    const report = readReport(args);
    const wallet = arg(args, "--wallet");
    const tx = arg(args, "--tx");
    if (!!wallet === !!tx) throw new Error("explain needs exactly one of --wallet or --tx");
    process.stdout.write(wallet ? explainWallet(report, wallet) : explainTransaction(report, tx!));
    return 0;
  }
  if (cmd === "verify") {
    const report = readReport(args);
    const recomputed = payloadDigestOf(report.payload);
    console.log(JSON.stringify({ recorded: report.payloadDigest, recomputed, match: recomputed === report.payloadDigest }));
    return recomputed === report.payloadDigest ? 0 : 1;
  }
  console.error("usage: referrals-report.ts scan|explain|verify ... (see the header of backend/scripts/referrals-report.ts)");
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
