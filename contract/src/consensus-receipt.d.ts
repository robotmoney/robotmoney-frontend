/** One bucket's share of the deterministic mean, bps-native. */
export interface ConsensusReceiptBucketWeight {
  bucket: "agent_tokens" | "conservative_defi_yield" | "protocol_tokens" | "real_world_assets";
  weight_bps: number;
}

export interface ConsensusReceiptDisagreementPosition {
  member_id: string;
  /** The attributed member's own take body, verbatim — never the model's text. */
  view: string;
}

export interface ConsensusReceiptDisagreement {
  topic: string;
  positions: ConsensusReceiptDisagreementPosition[];
  what_settles: string;
}

export interface ConsensusReceiptReleaseSafety {
  release: "safe" | "hold";
  thinly_supported: boolean;
  take_count: number;
  min_takes: number;
  concerns: string[];
}

export interface ConsensusReceiptJudge {
  rationale: string;
  disagreements: ConsensusReceiptDisagreement[];
  release_safety: ConsensusReceiptReleaseSafety;
  /** JudgeOutcome.source: whether a model wrote this prose or a template did. */
  source: "model" | "fallback";
}

export interface ConsensusReceiptAnalystSignature {
  member_id: string;
  public_key: string;
  canonical_submission: string;
  signature: string;
}

export interface ConsensusReceipt {
  schema_version: "1.0";
  session_id: string;
  subject_id: string;
  created_at: string;
  prompt_hash: string;
  inputs_digest: string;
  quorum: { active: number; submitted: number; absent: number; participation_bps: number };
  stances: { bearish: number; cautious: number; neutral: number; constructive: number; bullish: number };
  judge: ConsensusReceiptJudge;
  analyst_signatures: ConsensusReceiptAnalystSignature[];
  weights?: ConsensusReceiptBucketWeight[];
}

/** The published canonicalization spec (consensus-receipt.canonicalization.json). */
export interface ConsensusReceiptCanonicalizationSpec {
  domain_separator: string;
  trailing_newline: boolean;
  canonical_bucket_order: string[];
  [key: string]: unknown;
}

export const RECEIPT_DOMAIN_SEPARATOR: string;
export const RECEIPT_STANCE_KEYS: readonly string[];

export function compareCodePoints(a: string, b: string): number;
export function participationBps(submitted: number, active: number): number;
export function canonicalizeReceipt(
  receipt: ConsensusReceipt,
  spec: ConsensusReceiptCanonicalizationSpec,
): string;
export function validateReceipt(
  value: unknown,
  schema: unknown,
  root?: unknown,
  path?: string,
  errors?: string[],
): string[];
export function receiptSemanticErrors(
  receipt: ConsensusReceipt,
  spec: ConsensusReceiptCanonicalizationSpec,
): string[];
