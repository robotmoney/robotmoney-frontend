// The Project Fusion consensus receipt: assemble it, publish it once, and
// re-verify it on every read (issue #754).
//
// WHAT THIS FILE OWNS, AND WHAT IT DELIBERATELY DOES NOT.
//
// It owns the ASSEMBLY — turning one judged session into the exact payload
// schema 1.0 describes — plus its persistence and its read-time verification.
// It owns NO rule about what the bytes look like. Every canonicalization,
// validation and arithmetic rule is imported from
// `@robotmoney/contract/consensus-receipt`, which is shipped contract code
// precisely so the assembler and a cross-repo verifier cannot hold two copies
// of the same rule. A second canonicalizer in this file is the exact failure
// that module was promoted out of a test file to prevent.
//
// THE ORDER IS NORMATIVE: validate, recompute, then canonicalize.
// `canonicalizeReceipt()` THROWS on an undefined required field rather than
// emitting bytes with the key missing (a plain `JSON.stringify` would drop it
// silently), so canonicalizing first would produce a digest over a payload that
// would have failed validation. See
// consensus-receipt.canonicalization.json#assembler_obligations.
//
// EVERY REFUSAL IS OPERATOR-VISIBLE. `ConsensusReceiptRefusal` carries a stable
// `reason` code and a human sentence, and the admin route returns both. The
// alternative — quietly omitting a field the payload could not carry — publishes
// a signed artifact that contradicts what `GET /api/swarm/sessions/:id` serves
// for the same session, which is the one outcome this whole phase exists to
// make impossible.
import {
  RECEIPT_CANONICAL_BUCKET_ORDER,
  RECEIPT_SCHEMA_VERSION,
  RECEIPT_STANCE_KEYS,
  canonicalizeReceipt,
  canonicalizeSubmission,
  compareCodePoints,
  participationBps,
  receiptSemanticErrors,
  validateReceipt,
} from "@robotmoney/contract";
// The published spec and schema, reached THROUGH THE PACKAGE rather than by a
// relative path into contract/src/__fixtures__. Vendoring either one is what
// #776 removed the possibility of: the assembler must break when the pin moves,
// not silently keep reproducing an older document's bytes.
import spec from "@robotmoney/contract/fixtures/consensus-receipt.canonicalization.json" with { type: "json" };
import schema from "@robotmoney/contract/fixtures/consensus-receipt.schema.json" with { type: "json" };
import { sql } from "../db/client.ts";
import { verifyDetachedSignature } from "../lib/signing.ts";
import { loadFrozenTakeSet } from "./domain.ts";
import type { JudgeOpinion } from "./judge.ts";

/** One contributing analyst, as the assembler needs them. */
export interface ConsensusReceiptAnalystInput {
  member_id: string;
  /** The signed submission payload, exactly as `swarm_recommendations.payload` stores it. */
  payload: Record<string, unknown>;
  signature: string;
  /**
   * The key that ACTUALLY SIGNED this take — not the member's current roster
   * key. See resolveSigningKey() below on why the difference is the whole of
   * scope item 3.6.
   */
  public_key: string;
  /** The take row's `nonce` column, cross-checked against the signed payload's. */
  nonce: string;
}

/**
 * Everything the pure assembler reads. No database handle, no clock, no
 * ambient configuration: given this object the bytes are a pure function of it,
 * which is what makes the committed conformance vector reproducible by anyone
 * (including robotmoney-core) rather than only by this process.
 */
export interface ConsensusReceiptAssemblyInput {
  session_id: string;
  subject_id: string;
  /** Any ISO instant; normalized to the one permitted serialization here. */
  created_at: string;
  /** Bare lowercase sha256 hex from judge.ts, or already 0x-prefixed. */
  prompt_hash: string;
  inputs_digest: string;
  source: "model" | "fallback";
  opinion: JudgeOpinion;
  /** Size of the session's frozen roster — quorum.active. */
  active_members: number;
  /** The SPARSE stance rollup as aggregateSession() wrote it. Zero-filled here. */
  stances: Record<string, number>;
  /** `swarm_recommendation.weights` — the vector meanTakeWeights() authored, or absent. */
  weights?: { bucket: string; weight: number }[] | null;
  analysts: ConsensusReceiptAnalystInput[];
}

export interface AssembledConsensusReceipt {
  receipt: Record<string, unknown>;
  canonicalBytes: string;
}

export type ConsensusReceiptRefusalReason =
  | "no_session"
  | "not_judged"
  | "no_takes"
  | "created_at_unparseable"
  | "digest_malformed"
  | "signing_key_unresolved"
  | "take_not_bound_to_session"
  | "nonce_replayed"
  | "weights_not_canonical_four"
  | "weights_bps_out_of_range"
  | "schema_invalid"
  | "semantics_invalid"
  | "canonicalization_failed";

/**
 * A refusal to assemble. NEVER a silently incomplete receipt — see the file
 * header, and weights_cardinality in the published spec.
 */
export class ConsensusReceiptRefusal extends Error {
  readonly reason: ConsensusReceiptRefusalReason;
  readonly details: string[];
  constructor(reason: ConsensusReceiptRefusalReason, message: string, details: string[] = []) {
    super(message);
    this.name = "ConsensusReceiptRefusal";
    this.reason = reason;
    this.details = details;
  }
}

/**
 * The one permitted `created_at` serialization: seconds-precision UTC with a
 * literal trailing Z. TRUNCATED, never rounded — rounding would move a receipt
 * up to half a second away from the instant it was published, and the driver
 * path (pg timestamptz -> JS Date -> toISOString()) emits milliseconds, so
 * passing the obvious string through is a hard validation failure.
 */
function secondsUtc(value: string | Date): string {
  const at = value instanceof Date ? value : new Date(value);
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    throw new ConsensusReceiptRefusal("created_at_unparseable", `created_at "${String(value)}" is not a parseable instant`);
  }
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * `judge.ts` emits `promptHash`/`inputsDigest` as BARE lowercase sha256 hex;
 * schema 1.0's pattern is `^0x[0-9a-f]{64}$`. The prefix is the assembler's
 * job, and forgetting it is a hard validation failure rather than silent
 * corruption. Uppercase hex denotes the same digest and different bytes, so
 * exactly one spelling is admitted: lowercase here, before validation.
 */
function hash32(value: string, field: string): string {
  const bare = String(value ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw new ConsensusReceiptRefusal("digest_malformed", `${field} is not a 32-byte sha256 hex digest: "${value}"`);
  }
  return `0x${bare}`;
}

/**
 * bps conversion, exactly as consensus-receipt.canonicalization.json#bps_conversion
 * states it: round every bucket but the last half-up, then set the last to
 * 10000 minus the prefix sum so the vector closes on exactly 10000.
 *
 * THIS AUTHORS NO WEIGHT. The input is the vector `meanTakeWeights()` already
 * derived and `swarm_recommendation.weights` already published; this is a
 * change of REPRESENTATION (a float in 0..1 to an integer in 0..10000) forced
 * by the rule that every number in the canonical bytes is a bare integer,
 * because `1250.0` and `1.25e3` are different bytes for the same receipt.
 * Nothing here re-averages, re-normalizes or re-orders anything.
 */
function toBps(weights: { bucket: string; weight: number }[]): { bucket: string; weight_bps: number }[] {
  const byBucket = new Map(weights.map((w) => [String(w.bucket), Number(w.weight)]));
  const canonical = RECEIPT_CANONICAL_BUCKET_ORDER;
  const missing = canonical.filter((bucket) => !byBucket.has(bucket));
  const extra = [...byBucket.keys()].filter((bucket) => !canonical.includes(bucket));
  if (missing.length > 0 || extra.length > 0) {
    // REFUSE, NEVER SILENTLY OMIT. `optionalWeights()` (api/validation.ts)
    // accepts any bucket string with no enum and no count, and
    // `meanTakeWeights()` unions whatever appears across the takes — so a
    // session where every member submitted a three-bucket vector produces a
    // valid, PUBLICLY SERVED `swarm_recommendation.weights` this schema cannot
    // carry. Omitting `weights` here would publish a signed artifact saying the
    // session produced no allocation while GET /api/swarm/sessions/:id serves a
    // concrete one for the same session.
    throw new ConsensusReceiptRefusal(
      "weights_not_canonical_four",
      "the session's weight vector is not the four canonical buckets, so schema 1.0 cannot carry it; " +
        "the receipt is refused rather than published without the allocation the session's public API already serves",
      [
        ...missing.map((bucket) => `missing bucket "${bucket}"`),
        ...extra.map((bucket) => `unsupported bucket "${bucket}"`),
      ],
    );
  }
  const out: { bucket: string; weight_bps: number }[] = [];
  let prefix = 0;
  for (let i = 0; i < canonical.length - 1; i++) {
    const bucket = canonical[i]!;
    const bps = Math.floor(byBucket.get(bucket)! * 10_000 + 0.5);
    prefix += bps;
    out.push({ bucket, weight_bps: bps });
  }
  const final = 10_000 - prefix;
  if (!Number.isSafeInteger(final) || final < 0 || final > 10_000) {
    throw new ConsensusReceiptRefusal(
      "weights_bps_out_of_range",
      `bps conversion left the final bucket at ${final}, outside 0..10000 — the vector did not sum to 1`,
    );
  }
  out.push({ bucket: canonical[canonical.length - 1]!, weight_bps: final });
  return out;
}

/**
 * Assemble one receipt. PURE — same input, same bytes, forever. That is what
 * makes the committed conformance vector
 * (contract/src/__fixtures__/consensus-receipt.assembler-input.json ->
 * consensus-receipt.valid.canonical.txt) reproducible rather than merely
 * asserted, and it is what robotmoney-core#1280 verifies against.
 */
export function assembleConsensusReceipt(input: ConsensusReceiptAssemblyInput): AssembledConsensusReceipt {
  if (input.analysts.length === 0) {
    // `analyst_signatures` has minItems 1: a session nobody submitted to cannot
    // produce a receipt at all.
    throw new ConsensusReceiptRefusal("no_takes", "the session has no submitted takes, so there is nothing to sign over");
  }

  // ── 3.1 REPLAY AND BINDING, BEFORE ANYTHING IS SHAPED ────────────────────
  // Each analyst's SIGNED payload must bind to this session's subject and to
  // its own take row, and no nonce may appear twice. A nonce is a member's
  // one-time marker for one take; carrying the same signed take into a second
  // receipt would let one signature stand for participation in a session its
  // author never saw.
  const seenNonce = new Set<string>();
  for (const analyst of input.analysts) {
    const payload = analyst.payload ?? {};
    const nonce = String((payload as { nonce?: unknown }).nonce ?? "");
    if ((payload as { memberId?: unknown }).memberId !== analyst.member_id) {
      throw new ConsensusReceiptRefusal(
        "take_not_bound_to_session",
        `take attributed to "${analyst.member_id}" was signed as "${String((payload as { memberId?: unknown }).memberId)}"`,
      );
    }
    if ((payload as { subjectId?: unknown }).subjectId !== input.subject_id) {
      throw new ConsensusReceiptRefusal(
        "take_not_bound_to_session",
        `take from "${analyst.member_id}" was signed over subject "${String((payload as { subjectId?: unknown }).subjectId)}", not "${input.subject_id}"`,
      );
    }
    if (nonce === "" || nonce !== analyst.nonce) {
      throw new ConsensusReceiptRefusal(
        "nonce_replayed",
        `take from "${analyst.member_id}" carries nonce "${analyst.nonce}" but was signed over "${nonce}"`,
      );
    }
    if (seenNonce.has(nonce)) {
      throw new ConsensusReceiptRefusal("nonce_replayed", `nonce "${nonce}" appears twice in one receipt`);
    }
    seenNonce.add(nonce);
  }

  const submitted = input.analysts.length;
  const active = input.active_members;

  const receipt: Record<string, unknown> = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    // Lowercased before validation: a UUID's uppercase form is the same
    // identifier and different canonical bytes.
    session_id: String(input.session_id).toLowerCase(),
    subject_id: String(input.subject_id),
    created_at: secondsUtc(input.created_at),
    prompt_hash: hash32(input.prompt_hash, "prompt_hash"),
    inputs_digest: hash32(input.inputs_digest, "inputs_digest"),
    quorum: {
      active,
      submitted,
      absent: active - submitted,
      // Round HALF-UP over the two integers — not half-even, and not derived
      // from the stored `participation` float, which is a different number at
      // every exact .5 boundary.
      participation_bps: active > 0 ? participationBps(submitted, active) : 0,
    },
    // ZERO-FILLED FROM THE SPARSE ROLLUP. aggregateSession() starts from {} and
    // only sets a key for a stance that actually appears, so a session of two
    // neutral takes hands us a ONE-key object; the schema requires all five.
    // canonicalizeReceipt() zero-fills too, but doing it here is what lets the
    // payload we validate and the payload we canonicalize be the same object.
    stances: Object.fromEntries(RECEIPT_STANCE_KEYS.map((key) => [key, input.stances?.[key] ?? 0])),
    // EXACTLY JudgeOpinion, field for field, plus `source` from the JudgeOutcome
    // envelope. Nothing is reshaped, summarized or padded on the way in — in
    // particular `disagreements[].positions[].view` is the attributed member's
    // own take body verbatim, filled by parseJudgeResponse() from the frozen
    // take set and carried through untouched.
    judge: {
      rationale: input.opinion.rationale,
      disagreements: input.opinion.disagreements,
      release_safety: input.opinion.release_safety,
      source: input.source,
    },
    // 3.5 — ANALYST IDENTITY IS A FIRST-CLASS FIELD. member_id, the ed25519
    // public key that signed, the exact signed bytes, and the signature: four
    // named fields rather than an opaque blob, so adding a per-analyst EOA
    // signature later appends a field instead of reshaping the object.
    // Sorted by member_id ascending BY UNICODE CODE POINT — compareCodePoints,
    // not Array.prototype.sort, which compares UTF-16 code units and disagrees
    // above U+FFFF.
    analyst_signatures: [...input.analysts]
      .sort((a, b) => compareCodePoints(a.member_id, b.member_id))
      .map((analyst) => ({
        member_id: analyst.member_id,
        public_key: analyst.public_key,
        // The EXACT bytes the member signed. Recomputed from the stored payload
        // by the same canonicalizer the member signed under, then carried as a
        // string and never re-parsed again — including by the read-time
        // verification below.
        canonical_submission: canonicalizeSubmission(analyst.payload as Parameters<typeof canonicalizeSubmission>[0]),
        signature: analyst.signature,
      })),
  };
  // OMITTED ENTIRELY when absent — a judged-but-unweighted receipt is legal and
  // byte-stable, and `weights` is the only optional field in 1.0.
  if (input.weights != null) receipt.weights = toBps(input.weights);

  // ── VALIDATE, RECOMPUTE, THEN CANONICALIZE ───────────────────────────────
  // The spec is passed WHOLE (it is the published document, not a hand-built
  // object): a partial spec is refused by design, because completing one from
  // this repo's pin would mix two authorities in one artifact.
  const structural = validateReceipt(receipt, schema);
  if (structural.length > 0) {
    throw new ConsensusReceiptRefusal("schema_invalid", "the assembled receipt does not validate against schema 1.0", structural);
  }
  const semantic = receiptSemanticErrors(receipt as never, spec as never);
  if (semantic.length > 0) {
    throw new ConsensusReceiptRefusal("semantics_invalid", "the assembled receipt fails a recomputable invariant", semantic);
  }
  let canonicalBytes: string;
  try {
    canonicalBytes = canonicalizeReceipt(receipt as never, spec as never);
  } catch (e) {
    throw new ConsensusReceiptRefusal("canonicalization_failed", e instanceof Error ? e.message : String(e));
  }
  return { receipt, canonicalBytes };
}

// ── The database seam ───────────────────────────────────────────────────────

/**
 * THE KEY THAT SIGNED IT, NOT THE MEMBER'S CURRENT KEY (scope item 3.6).
 *
 * Every other read path in this repo resolves a take's public key as
 * `WHERE k.member_id = … AND k.active` — the member's CURRENTLY ACTIVE key —
 * which is not necessarily the key that signed the take. Issue #697 is that
 * defect at the per-take level and it is still open; the aggregate must not
 * inherit it, because a receipt is anchored on chain and re-verified by
 * strangers who have no way to ask what the roster looked like at the time.
 *
 * So the receipt is a SNAPSHOT of the verifying key, taken at assembly time and
 * embedded in the signed payload: every one of the member's registered keys is
 * tried against the take's own signature, and the one that verifies is the one
 * carried. After that the roster is irrelevant — read-time verification
 * (verifyAssembledReceipt) uses the embedded key and never re-resolves it — so
 * a member may rotate, re-register or be deactivated and the receipt keeps
 * verifying exactly as it did on the day it was published.
 *
 * A member whose signing key is no longer registered AT ALL cannot be
 * snapshotted, and that is a refusal rather than a receipt with an unverifiable
 * signature in it.
 */
async function resolveSigningKey(memberId: string, canonicalSubmission: string, signature: string): Promise<string | null> {
  const rows = (await sql`
    SELECT public_key FROM swarm_member_keys
    WHERE member_id = ${memberId}
    ORDER BY active DESC, created_at DESC`) as unknown as { public_key: string }[];
  for (const row of rows) {
    if (await verifyDetachedSignature(canonicalSubmission, signature, row.public_key)) return row.public_key;
  }
  return null;
}

/** Build the assembly input for one session out of stored state. */
async function loadAssemblyInput(sessionId: string, createdAt: Date): Promise<ConsensusReceiptAssemblyInput & { judgementId: string }> {
  const frozen = await loadFrozenTakeSet(sessionId);
  if (!frozen) throw new ConsensusReceiptRefusal("no_session", `no such session ${sessionId}`);
  // THE SAME FROZEN SET THE JUDGE READ. `loadFrozenTakeSet()` is the one query
  // (latest revision per member, filtered to the frozen roster) the aggregator
  // and the judge both go through, so `inputs_digest` on the judgement is a
  // claim about exactly the takes this receipt attests to. Re-querying here
  // would make the receipt attest to a take set nobody judged.
  const session = frozen.session;
  const judgement = (await sql`
    SELECT id, source, prompt_hash, inputs_digest, opinion
    FROM swarm_session_judgements WHERE session_id = ${sessionId}
    ORDER BY id DESC LIMIT 1`)[0] as
    | { id: string | number; source: string; prompt_hash: string; inputs_digest: string; opinion: JudgeOpinion }
    | undefined;
  if (!judgement) {
    throw new ConsensusReceiptRefusal(
      "not_judged",
      `session ${sessionId} has no judgement on file — a receipt carries the judge's opinion, its prompt_hash and its inputs_digest, so there is nothing to assemble until the session has been judged`,
    );
  }
  const rec = (session.swarm_recommendation ?? {}) as Record<string, unknown>;

  const analysts: ConsensusReceiptAnalystInput[] = [];
  for (const take of frozen.takes) {
    const payload = (take.payload ?? {}) as Record<string, unknown>;
    const signature = String(take.signature ?? "");
    const canonical = canonicalizeSubmission(payload as Parameters<typeof canonicalizeSubmission>[0]);
    const publicKey = await resolveSigningKey(String(take.member_id), canonical, signature);
    if (!publicKey) {
      throw new ConsensusReceiptRefusal(
        "signing_key_unresolved",
        `no registered key of member "${take.member_id}" verifies that member's take, so the key that signed it cannot be embedded in the receipt`,
      );
    }
    analysts.push({
      member_id: String(take.member_id),
      payload,
      signature,
      public_key: publicKey,
      nonce: String(take.nonce ?? (payload as { nonce?: unknown }).nonce ?? ""),
    });
  }

  // CROSS-SESSION REPLAY. `UNIQUE (member_id, nonce)` on swarm_recommendations
  // already makes a member's nonce single-use, so this can only fire if that
  // constraint were relaxed — which is exactly why it is asserted here rather
  // than assumed: the receipt is the artifact a stranger checks, and "a
  // database constraint held" is not a fact it carries.
  if (analysts.length > 0) {
    const pairs = analysts.map((a) => ({ member_id: a.member_id, nonce: a.nonce }));
    const foreign = (await sql`
      SELECT r.member_id, r.nonce FROM swarm_recommendations r
      JOIN jsonb_to_recordset(${sql.json(pairs as never)}::jsonb) AS p(member_id text, nonce text)
        ON r.member_id = p.member_id AND r.nonce = p.nonce
      WHERE r.session_id <> ${sessionId}
      LIMIT 1`) as unknown as { member_id: string; nonce: string }[];
    if (foreign.length > 0) {
      throw new ConsensusReceiptRefusal(
        "nonce_replayed",
        `nonce "${foreign[0]!.nonce}" of member "${foreign[0]!.member_id}" is already filed against a different session — a previously signed take cannot be replayed into this receipt`,
      );
    }
  }

  return {
    judgementId: String(judgement.id),
    session_id: sessionId,
    subject_id: String(session.subject_id),
    created_at: createdAt.toISOString(),
    prompt_hash: String(judgement.prompt_hash),
    inputs_digest: String(judgement.inputs_digest),
    source: judgement.source === "model" ? "model" : "fallback",
    opinion: judgement.opinion,
    active_members: frozen.activeMembers.length,
    stances: (rec.stances as Record<string, number>) ?? {},
    // READ, NEVER RE-DERIVED. `meanTakeWeights()` is the only thing allowed to
    // author a bucket weight and it has exactly one caller, its own aggregator;
    // this is the vector it already produced and `GET /api/swarm/sessions/:id`
    // already serves, so the receipt and the public API can never disagree
    // about the same session. Absent here means absent there.
    weights: (rec.weights as { bucket: string; weight: number }[] | undefined) ?? null,
    analysts,
  };
}

export interface StoredConsensusReceipt {
  sessionId: string;
  subjectId: string;
  schemaVersion: string;
  receipt: Record<string, unknown>;
  canonicalBytes: string;
  publishedAt: string;
}

/**
 * Publish the receipt for a session. IDEMPOTENT AND IMMUTABLE: the first call
 * assembles and stores it; every later call returns the row already on file
 * WITHOUT re-assembling, so the bytes an on-chain digest commits to can never
 * be replaced by a re-run over changed state. Migration 0042 refuses the UPDATE
 * even if this code were wrong.
 */
export async function publishConsensusReceipt(sessionId: string, now: Date = new Date()): Promise<StoredConsensusReceipt> {
  const existing = await readStoredReceipt(sessionId);
  if (existing) return existing;

  const input = await loadAssemblyInput(sessionId, now);
  const { receipt, canonicalBytes } = assembleConsensusReceipt(input);
  await sql`
    INSERT INTO swarm_consensus_receipts
      (session_id, subject_id, schema_version, judgement_id, receipt, canonical_bytes)
    VALUES (${sessionId}, ${input.subject_id}, ${RECEIPT_SCHEMA_VERSION}, ${input.judgementId},
            ${sql.json(receipt as never)}, ${canonicalBytes})
    ON CONFLICT (session_id) DO NOTHING`;
  const stored = await readStoredReceipt(sessionId);
  if (!stored) throw new ConsensusReceiptRefusal("no_session", `receipt for ${sessionId} vanished immediately after being written`);
  return stored;
}

async function readStoredReceipt(sessionId: string): Promise<StoredConsensusReceipt | null> {
  const row = (await sql`
    SELECT session_id, subject_id, schema_version, receipt, canonical_bytes, published_at
    FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`)[0] as
    | { session_id: string; subject_id: string; schema_version: string; receipt: Record<string, unknown>; canonical_bytes: string; published_at: Date }
    | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id,
    subjectId: row.subject_id,
    schemaVersion: row.schema_version,
    receipt: row.receipt,
    canonicalBytes: row.canonical_bytes,
    publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at),
  };
}

export interface ConsensusReceiptVerification {
  verified: boolean;
  /** One entry per embedded signature, in the receipt's own order. */
  signatures: { memberId: string; verified: boolean }[];
  /** Empty iff `verified`. Stable, human-readable reasons. */
  unverifiedReasons: string[];
}

/**
 * READ-TIME VERIFICATION, mirroring what projections.ts does for a single take
 * (`toVerifiedTake` recomputes rather than trusting the stored `verified`
 * column) and extending it to the two things an aggregate adds.
 *
 * THREE INDEPENDENT CHECKS, and all three must pass:
 *
 *  1. EVERY embedded signature verifies, against the public key EMBEDDED IN THE
 *     PAYLOAD — never against the member's current roster key. That is what
 *     makes a receipt survive its authors' key rotations (scope 3.6), and it is
 *     why the roster is not consulted here at all.
 *  2. The payload still canonicalizes to the stored bytes. An analyst signature
 *     covers that analyst's own submission and NOTHING ELSE — the rationale,
 *     the quorum, the weights and every other member's entry are outside all of
 *     them — so signatures alone cannot detect a tampered payload. Re-deriving
 *     the canonical bytes and comparing them to the ones stored (and anchored)
 *     is what closes that gap.
 *  3. The payload still validates and still recomputes. A receipt whose quorum
 *     arithmetic no longer holds is not a valid receipt even if every byte
 *     matches.
 *
 * ONE BAD SIGNATURE MARKS THE WHOLE RECEIPT UNVERIFIED. There is no partial
 * pass: the artifact is the aggregate, and an aggregate carrying one signature
 * that does not check out is not "mostly signed".
 */
export async function verifyAssembledReceipt(
  receipt: Record<string, unknown>,
  canonicalBytes: string,
): Promise<ConsensusReceiptVerification> {
  const reasons: string[] = [];
  const entries = Array.isArray(receipt.analyst_signatures)
    ? (receipt.analyst_signatures as { member_id?: unknown; public_key?: unknown; canonical_submission?: unknown; signature?: unknown }[])
    : [];
  const signatures: { memberId: string; verified: boolean }[] = [];
  for (const entry of entries) {
    // The carried string is verified AS IS. Re-parsing it before verification
    // would put a member's float weights through a JSON round trip, and whether
    // `0.15` survives that is a property of one serializer rather than of the
    // signed bytes.
    const ok = typeof entry.canonical_submission === "string" && typeof entry.signature === "string" &&
      typeof entry.public_key === "string" &&
      await verifyDetachedSignature(entry.canonical_submission, entry.signature, entry.public_key);
    signatures.push({ memberId: String(entry.member_id ?? ""), verified: ok });
    if (!ok) reasons.push(`signature of member "${String(entry.member_id ?? "")}" does not verify against the public key embedded beside it`);
  }
  if (signatures.length === 0) reasons.push("the receipt carries no analyst signatures");

  const structural = validateReceipt(receipt, schema);
  for (const error of structural) reasons.push(`schema: ${error}`);
  if (structural.length === 0) {
    for (const error of receiptSemanticErrors(receipt as never, spec as never)) reasons.push(`invariant: ${error}`);
    let rebuilt: string | null = null;
    try {
      rebuilt = canonicalizeReceipt(receipt as never, spec as never);
    } catch (e) {
      reasons.push(`canonicalization: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (rebuilt !== null && rebuilt !== canonicalBytes) {
      reasons.push("the payload no longer canonicalizes to the bytes published for it — it has been altered since publication");
    }
  }
  return { verified: reasons.length === 0, signatures, unverifiedReasons: reasons };
}

export interface PublicConsensusReceipt extends StoredConsensusReceipt, ConsensusReceiptVerification {}

/** The public read: the stored receipt plus a freshly recomputed verdict. */
export async function getConsensusReceipt(sessionId: string): Promise<PublicConsensusReceipt | null> {
  const stored = await readStoredReceipt(sessionId);
  if (!stored) return null;
  return { ...stored, ...(await verifyAssembledReceipt(stored.receipt, stored.canonicalBytes)) };
}
