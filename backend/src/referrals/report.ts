// The referral attribution report: payload, digests, exports and explain modes
// (issue 1371, docs/technical/referrals-spec.md §7).
//
// REPRODUCIBLE BY CONSTRUCTION. The payload is a pure function of the pinned
// cutoff, the manifest, the evidence, the registry, the correction log and the
// rules revision. Every array is sorted into a deterministic order before
// serializing, and the payload digest is sha256 over canonicalStringify
// (analytics/run-ledger.ts, the repository's one canonical-JSON helper). Run
// time and diagnostics live OUTSIDE the payload, so a rerun at the same
// cutoff/hash with the same revisions produces the same bytes and the same
// digest, whatever happened on chain after the cutoff.
//
// COMPLETENESS IS NOT ONE BIT. Attribution completeness (every manifest range
// scanned, every transaction's evidence read, manifest and carrier confirmed,
// pinned block unchanged) and valuation completeness (every holdings read) are
// recorded separately, and only both make a combined complete report. Rows
// that are fully proven stay visible in an incomplete report, with their
// binding status saying provisional.
import { canonicalStringify, sha256Hex } from "../analytics/run-ledger.ts";
import { attribute, type AttributionRow } from "./attribution.ts";
import { checkCorrectionLog, type CorrectionLog } from "./corrections.ts";
import type { CollectedEvidence, Holdings } from "./collect.ts";
import { decodeTransactionEvidence, type DepositAuthorization, type UnknownObservation } from "./evidence.ts";
import { manifestCoverageGaps, type ReferralManifest } from "./manifest.ts";
import type { ReferralRegistry } from "./registry.ts";
import { CARRIER_CONFORMANCE } from "./carrier.ts";

export const REPORT_SCHEMA = "robotmoney.referral-attribution-report/1";

export interface ReportInputs {
  evidence: CollectedEvidence;
  registry: ReferralRegistry;
  corrections: CorrectionLog;
  manifest: ReferralManifest;
  /** Git revisions pinned by the operator: the rules (code) and the accepted config tag. */
  revisions: { rules: string; config: string; configAccepted: boolean };
  /** Problems from the EIP-1271 reads at the pinned block, per correction id. */
  contractSignatureProblems?: ReadonlyMap<string, string[]>;
  holdings?: Holdings | null;
}

export interface ReportPayload {
  schema: string;
  chainId: number;
  cutoff: { number: number; hash: string; timestamp: number } | null;
  launchBlock: number | null;
  carrier: string;
  revisions: { rules: string; config: string; configAccepted: boolean };
  digests: { manifest: string; registry: string; corrections: string; evidence: string };
  coverage: { entryId: string; fromBlock: number; toBlock: number; status: string; logCount: number }[];
  manifestGaps: string[];
  completeness: { attribution: boolean; valuation: boolean | null; combined: boolean };
  /** True only for a complete report over an accepted config revision: the one kind that may be exported as final attribution. */
  final: boolean;
  invalidated: string | null;
  errors: string[];
  authorizations: DepositAuthorization[];
  unknowns: UnknownObservation[];
  rows: AttributionRow[];
  holdings: Holdings | null;
}

export interface Report {
  payload: ReportPayload;
  payloadDigest: string;
  /**
   * Excluded from the digest, like run time: the finalized head the cutoff was
   * checked against moves on between runs, while the pinned cutoff does not.
   */
  finalizedHead: { number: number; hash: string } | null;
  /** Excluded from the digest. */
  diagnostics: { runAt: string; rpcCalls: number; elapsedMs: number; peakRssBytes: number; resumedRanges: number; stoppedByBudget: boolean };
}

const digest = (v: unknown) => sha256Hex(canonicalStringify(v));

export function buildReport(inputs: ReportInputs, runAt: Date = new Date()): Report {
  const { evidence, manifest, registry, corrections } = inputs;
  const authorizations: DepositAuthorization[] = [];
  const unknowns: UnknownObservation[] = [];
  for (const tx of evidence.transactions) {
    const d = decodeTransactionEvidence(tx, manifest);
    authorizations.push(...d.authorizations);
    unknowns.push(...d.unknowns);
  }
  // A failed or unscanned range hides wallets nobody can name.
  for (const r of evidence.ranges) {
    if (r.status !== "complete") unknowns.push({ transactionHash: null, blockNumber: r.fromBlock, blockTimestamp: null, wallets: null, reason: `range ${r.entryId}:${r.fromBlock}-${r.toBlock} ${r.status}${r.error ? `: ${r.error}` : ""}` });
  }
  authorizations.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.keyLogIndex - b.keyLogIndex);
  unknowns.sort((a, b) => (a.blockNumber ?? -1) - (b.blockNumber ?? -1) || String(a.transactionHash).localeCompare(String(b.transactionHash)) || a.reason.localeCompare(b.reason));

  const gaps = manifestCoverageGaps(manifest);
  const checks = checkCorrectionLog(corrections, registry);
  const correctionProblems = new Map<string, string[]>();
  for (const c of checks.entries) {
    const extra = inputs.contractSignatureProblems?.get(c.id) ?? (c.needsContractSignatureCheck ? ["EIP-1271 signature not checked at the pinned block"] : []);
    correctionProblems.set(c.id, [...c.problems, ...extra]);
  }

  const attributionComplete =
    evidence.cutoff !== null &&
    evidence.errors.length === 0 &&
    !evidence.stoppedByBudget &&
    evidence.invalidated === null &&
    gaps.length === 0 &&
    unknowns.length === 0 &&
    evidence.ranges.every((r) => r.status === "complete");

  const rows = evidence.cutoff
    ? attribute({
        cutoff: { number: evidence.cutoff.number, timestamp: evidence.cutoff.timestamp },
        registry,
        corrections,
        correctionProblems,
        authorizations,
        unknowns,
        coverageComplete: attributionComplete,
      })
    : [];

  const holdings = inputs.holdings ?? null;
  const valuation = holdings ? holdings.complete : null;
  const errors = [...evidence.errors, ...checks.logErrors, ...(holdings?.errors ?? [])].sort();
  const payload: ReportPayload = {
    schema: REPORT_SCHEMA,
    chainId: manifest.chainId,
    cutoff: evidence.cutoff,
    launchBlock: registry.launch.blockNumber,
    carrier: CARRIER_CONFORMANCE,
    revisions: inputs.revisions,
    digests: {
      manifest: digest(manifest),
      registry: digest(registry),
      corrections: digest(corrections),
      evidence: digest({ ranges: evidence.ranges, transactions: evidence.transactions }),
    },
    coverage: evidence.ranges.map((r) => ({ entryId: r.entryId, fromBlock: r.fromBlock, toBlock: r.toBlock, status: r.status, logCount: r.logCount })),
    manifestGaps: gaps,
    completeness: { attribution: attributionComplete, valuation, combined: attributionComplete && valuation !== false },
    final: attributionComplete && valuation !== false && inputs.revisions.configAccepted,
    invalidated: evidence.invalidated,
    errors,
    authorizations,
    unknowns,
    rows,
    holdings,
  };
  return {
    payload,
    payloadDigest: digest(payload),
    finalizedHead: evidence.finalizedHead,
    diagnostics: {
      runAt: runAt.toISOString(),
      rpcCalls: evidence.stats.rpcCalls,
      elapsedMs: evidence.stats.elapsedMs,
      peakRssBytes: evidence.stats.peakRssBytes,
      resumedRanges: evidence.stats.resumedRanges,
      stoppedByBudget: evidence.stoppedByBudget,
    },
  };
}

/** The payload digest recomputed from a report file: how a rerun proves it reproduced the original. */
export function payloadDigestOf(payload: ReportPayload): string {
  return digest(payload);
}

const CSV_COLUMNS = [
  "manifest_digest",
  "cutoff_block",
  "cutoff_hash",
  "wallet",
  "binding_status",
  "code",
  "beneficiary_kind",
  "beneficiary_id",
  "source",
  "correction_kind",
  "correction_id",
  "event_transaction",
  "event_log_index",
  "effective_at",
  "first_deposit_transaction",
  "first_deposit_time",
  "window_ends_at",
] as const;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV export: one row per wallet. Every line carries the manifest digest and
 * the pinned block, and the CSV is only ever written beside its JSON
 * provenance file (provenanceOf).
 */
export function toCsv(report: Report): string {
  const p = report.payload;
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of p.rows) {
    const b = r.binding;
    lines.push(
      [
        p.digests.manifest,
        p.cutoff?.number,
        p.cutoff?.hash,
        r.wallet,
        r.bindingStatus,
        b?.code,
        b?.beneficiary.kind,
        b ? (b.beneficiary.kind === "member" ? b.beneficiary.memberId : b.beneficiary.channel) : null,
        b?.source,
        b?.correctionKind,
        b?.correctionId,
        b?.event?.transactionHash,
        b?.event?.logIndex,
        b?.effectiveAt,
        r.firstQualifyingDeposit?.transactionHash,
        r.firstQualifyingDeposit?.time,
        r.windowEndsAt,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/** The provenance file that accompanies a CSV: everything but the rows and evidence. */
export function provenanceOf(report: Report): Record<string, unknown> {
  const { rows: _rows, authorizations: _a, unknowns: _u, holdings, ...rest } = report.payload;
  return { ...rest, holdingsComplete: holdings ? holdings.complete : null, rowCount: report.payload.rows.length, payloadDigest: report.payloadDigest, finalizedHead: report.finalizedHead, diagnostics: report.diagnostics };
}

function describeRow(r: AttributionRow): string[] {
  const out: string[] = [];
  const b = r.binding;
  out.push(`wallet ${r.wallet}: ${r.bindingStatus}${b ? ` to ${b.code} (${b.beneficiary.kind} ${b.beneficiary.kind === "member" ? b.beneficiary.memberId : b.beneficiary.channel}) from ${b.source}${b.correctionKind ? ` ${b.correctionKind} ${b.correctionId}` : ""} at ${b.effectiveAt}` : ""}`);
  out.push(r.firstQualifyingDeposit ? `  first qualifying deposit ${r.firstQualifyingDeposit.transactionHash} at ${r.firstQualifyingDeposit.time}${r.firstQualifyingDeposit.tentative ? " (tentative: earlier evidence is unknown)" : ""}; window ends ${r.windowEndsAt}` : "  no qualifying deposit found");
  for (const c of r.candidates) {
    out.push(`  - ${c.time ?? "time unknown"} ${c.source} ${c.transactionHash ?? ""}${c.logIndex === null ? "" : `#${c.logIndex}`}${c.via ? ` ${c.via}` : ""} code=${JSON.stringify(c.code)}: ${c.reason}${c.detail ? ` (${c.detail})` : ""}`);
  }
  return out;
}

function header(report: Report): string[] {
  const p = report.payload;
  return [
    `report ${report.payloadDigest} at cutoff ${p.cutoff?.number ?? "none"} ${p.cutoff?.hash ?? ""}`,
    `completeness: attribution ${p.completeness.attribution}, valuation ${p.completeness.valuation}, final ${p.final}${p.invalidated ? `; INVALIDATED: ${p.invalidated}` : ""}`,
    ...(p.manifestGaps.length ? [`coverage gaps: ${p.manifestGaps.join("; ")}`] : []),
  ];
}

/** Per-wallet explain mode: how an operator answers a depositor's or member's question. */
export function explainWallet(report: Report, wallet: string): string {
  const w = wallet.toLowerCase();
  const row = report.payload.rows.find((r) => r.wallet === w);
  const holding = report.payload.holdings?.rows.filter((h) => h.wallet === w) ?? [];
  const lines = [...header(report), ...(row ? describeRow(row) : [`wallet ${w}: no deposit or correction in the scanned evidence${report.payload.completeness.attribution ? "" : " (evidence is incomplete: eligibility unknown)"}`])];
  for (const h of holding) lines.push(`  holdings (descriptive, not qualified capital) ${h.entryId}: ${h.shares} shares = ${h.assets} raw asset units (${report.payload.holdings!.assetDecimals} decimals)`);
  return lines.join("\n") + "\n";
}

/** Per-transaction explain mode: every authorization in the transaction and its outcome. */
export function explainTransaction(report: Report, transactionHash: string): string {
  const h = transactionHash.toLowerCase();
  const auths = report.payload.authorizations.filter((a) => a.transactionHash === h);
  const unk = report.payload.unknowns.filter((u) => u.transactionHash === h);
  const lines = header(report);
  if (!auths.length && !unk.length) lines.push(`transaction ${h}: not in the scanned evidence`);
  for (const a of auths) {
    lines.push(`authorization ${a.id}: ${a.via}, payer ${a.payer ?? "unproven"}, receiver ${a.receiver}, assets ${a.assets}, ${a.legs.length} leg(s), status ${a.status}${a.problems.length ? ` (${a.problems.join("; ")})` : ""}`);
    lines.push(`  carrier: ${a.carrier ? `log ${a.carrier.logIndex} code ${JSON.stringify(a.carrier.code)}` : "none (uncoded)"}${a.conflictingCarriers.length ? `; conflicting carriers ${a.conflictingCarriers.map((c) => `${c.logIndex}=${JSON.stringify(c.code)}`).join(", ")}` : ""}`);
    const row = report.payload.rows.find((r) => r.wallet === a.receiver);
    const outcome = row?.candidates.find((c) => c.id === a.id);
    lines.push(`  outcome for ${a.receiver}: ${outcome ? `${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}` : "none"}`);
  }
  for (const u of unk) lines.push(`unknown evidence: ${u.reason}; wallets ${u.wallets?.join(", ") ?? "undetermined"}`);
  return lines.join("\n") + "\n";
}
