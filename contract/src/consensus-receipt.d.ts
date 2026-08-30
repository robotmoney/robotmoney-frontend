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
  /**
   * swarm_session_judgements.mode: whether the session ADOPTED this opinion
   * (`enforce`) or merely recorded it (`shadow`). Only `enforce` is
   * publishable — `receiptSemanticErrors` refuses anything else — and the
   * union admits `shadow` so that refusal is expressible.
   */
  mode: "shadow" | "enforce";
}

export interface ConsensusReceiptAnalystSignature {
  member_id: string;
  public_key: string;
  canonical_submission: string;
  signature: string;
  /** swarm_recommendations.revision of the take this entry carries. */
  revision: number;
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

/**
 * The published canonicalization spec (consensus-receipt.canonicalization.json).
 *
 * ALL-OR-NOTHING. Every field below is required, because supplying a spec makes
 * the caller the authority for all of them: the runtime refuses a spec missing
 * any one of them with a `ReceiptCanonicalizationError` rather than completing
 * it from this repo's pin. The type used to be accepted as
 * `Partial<…>`, which advertised a half-built spec as supported input.
 * To canonicalize under the pin, omit the argument entirely.
 */
export interface ConsensusReceiptCanonicalizationSpec {
  schema_version: string;
  domain_separator: string;
  trailing_newline: boolean;
  canonical_bucket_order: readonly string[];
  [key: string]: unknown;
}

export const RECEIPT_DOMAIN_SEPARATOR: string;
export const RECEIPT_SCHEMA_VERSION: string;
export const RECEIPT_TRAILING_NEWLINE: boolean;
export const RECEIPT_STANCE_KEYS: readonly string[];
export const RECEIPT_CANONICAL_BUCKET_ORDER: readonly string[];
/** A whole allocation is exactly this many basis points. */
export const BPS_DENOMINATOR: number;

export function compareCodePoints(a: string, b: string): number;
export function participationBps(submitted: number, active: number): number;
/**
 * consensus-receipt.canonicalization.json#bps_conversion, and the only
 * implementation of it: LARGEST REMAINDER (Hare quota), ties broken by
 * canonical bucket order. Returns one entry per bucket, in `bucketOrder`,
 * summing to exactly `BPS_DENOMINATOR`.
 *
 * ALL ARITHMETIC IS IEEE-754 BINARY64 — a single multiply by
 * `BPS_DENOMINATOR`, `raw - Math.floor(raw)` for the remainder, and a
 * tie-break that fires only on bitwise-equal remainders. A decimal or
 * fixed-point recomputation of the same rule produces different bytes; see
 * `bps_conversion.arithmetic_domain` and its worked `divergent_example`.
 *
 * Refuses (`ReceiptCanonicalizationError`) a vector that is not a share
 * vector — a missing bucket, a share above 1 or more than 1e-6 below 0, or a
 * total more than 1e-6 from 1. It never refuses because of where a bucket sits
 * in the order. The one input it repairs is the producer's own negative settle
 * dust: a share in -1e-6..0, and negative zero, floor to positive zero.
 */
export function bucketSharesToBps(
  shares: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  bucketOrder: readonly string[],
): ConsensusReceiptBucketWeight[];
/** Omit `spec` for the pin; a supplied spec must be complete or it is refused. */
export function canonicalizeReceipt(
  receipt: ConsensusReceipt,
  spec?: ConsensusReceiptCanonicalizationSpec,
): string;
export function validateReceipt(
  value: unknown,
  schema: unknown,
  root?: unknown,
  path?: string,
  errors?: string[],
): string[];
/** Omit `spec` for the pin; a supplied spec must be complete or it is refused. */
export function receiptSemanticErrors(
  receipt: ConsensusReceipt,
  spec?: ConsensusReceiptCanonicalizationSpec,
): string[];

/** One embedded signature's read-time verdict. */
export interface ConsensusReceiptSignatureVerdict {
  memberId: string;
  verified: boolean;
}

/**
 * The body served by `GET ROUTES.swarm.sessionConsensusReceipt` (issue #754).
 *
 * `verified` is RECOMPUTED on every request — it is not a stored column. A
 * receipt with one bad embedded signature, one failed invariant, or a payload
 * that no longer canonicalizes to `canonicalBytes` is served with
 * `verified: false` and the reasons stated, never withheld and never passed off
 * as valid.
 */
export interface SwarmConsensusReceiptResponse {
  sessionId: string;
  subjectId: string;
  schemaVersion: string;
  publishedAt: string;
  receipt: ConsensusReceipt;
  /** The exact canonical bytes an on-chain digest commits to, domain prefix and trailing newline included. */
  canonicalBytes: string;
  verified: boolean;
  signatures: ConsensusReceiptSignatureVerdict[];
  /** Empty iff `verified`. */
  unverifiedReasons: string[];
}
