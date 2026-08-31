// The Project Fusion consensus receipt: reference canonicalizer, schema
// validator, and semantic recomputation (issue #775).
//
// WHY THIS IS SHIPPED CODE AND NOT A TEST HELPER. The receipt is the signed,
// publicly-anchored artifact — `robotmoney-core` anchors keccak256 over the
// bytes this file produces, and issue #754 assembles the payload that feeds it.
// A cross-repo pin whose only executable form lives inside one repo's test file
// cannot be imported by the assembler that has to reproduce it, so the
// canonicalizer lives here, beside `canonicalizeSubmission`, and the fixture
// test holds the published spec JSON to it rather than re-implementing it.
//
// THREE FUNCTIONS, IN THE ORDER AN ASSEMBLER CALLS THEM:
//   1. `validateReceipt`  — structural: the receipt matches schema 1.0.
//   2. `receiptSemanticErrors` — arithmetic the schema cannot express.
//   3. `canonicalizeReceipt` — the bytes, and only once the first two pass.
// That order is normative, not stylistic: `canonicalizeReceipt` throws on any
// undefined required field rather than emitting bytes with the key missing, so
// an assembler that canonicalizes first gets a refusal instead of a digest over
// a payload that would have failed validation.
//
// ZERO RUNTIME DEPENDENCIES, like every other module in this package.

// THE PIN, AS IMPORTABLE CONSTANTS. Every constant below is also published in
// consensus-receipt.canonicalization.json, and the fixture test asserts the two
// agree one by one — so these are a second SPELLING of the pin, never a second
// authority. Four of the five (domain separator, schema version, trailing
// newline, canonical bucket order) are exactly the spec fields the functions
// here dereference; RECEIPT_STANCE_KEYS is the fixed key set the stance
// recomputation reads, and it is pinned to the spec the same way.
//
// THEY ARE THE DEFAULT WHOLE, NEVER A PER-KEY FALLBACK. See PINNED_SPEC below:
// omitting the spec entirely selects these constants as one object; supplying a
// spec makes the CALLER the authority for every field. Filling a supplied
// spec's gaps from these constants would mix the two authorities — bytes from
// our pin, semantics from theirs — which is exactly the drift the pin exists to
// catch, so a supplied spec missing a field is refused instead.

/** The one domain prefix schema 1.0 hashes under. */
export const RECEIPT_DOMAIN_SEPARATOR = "robotmoney:consensus-receipt:v1\n";

/** The one schema version these rules implement — see the version check below. */
export const RECEIPT_SCHEMA_VERSION = "1.0";

/** The canonical bytes end with a newline. */
export const RECEIPT_TRAILING_NEWLINE = true;

/** The five stance keys `stances` always carries, in canonical order. */
export const RECEIPT_STANCE_KEYS = Object.freeze([
  "bearish", "cautious", "neutral", "constructive", "bullish",
]);

/** The four PRD vaults, in the order `weights` must be emitted. */
export const RECEIPT_CANONICAL_BUCKET_ORDER = Object.freeze([
  "agent_tokens", "conservative_defi_yield", "protocol_tokens", "real_world_assets",
]);

// THE SPEC THIS MODULE USES WHEN THE CALLER SUPPLIES NONE — the five constants
// above, assembled once, under the same key names consensus-receipt.canonicalization.json
// uses, so it is a strict subset of the published document rather than a
// parallel shape. It is deliberately NOT exported: it is a default, not a
// second authority to vendor. A consumer that wants these values imports the
// constants, or the published JSON through `@robotmoney/contract/fixtures/…`.
const PINNED_SPEC = Object.freeze({
  schema_version: RECEIPT_SCHEMA_VERSION,
  domain_separator: RECEIPT_DOMAIN_SEPARATOR,
  trailing_newline: RECEIPT_TRAILING_NEWLINE,
  canonical_bucket_order: RECEIPT_CANONICAL_BUCKET_ORDER,
  nested_field_order: Object.freeze({ stances: RECEIPT_STANCE_KEYS }),
});

/**
 * Ascending by Unicode code point — which is byte-for-byte the order UTF-8
 * encoding produces, and is NOT what JavaScript's default `Array.prototype.sort`
 * gives: that compares UTF-16 code units, and the two disagree for every
 * non-BMP code point (U+FFFD sorts before U+10000 by code point, after it by
 * code unit). `member_id` is pattern-constrained to `[a-z0-9_-]` in schema 1.0,
 * so for every id the schema admits all three orders coincide — this comparator
 * exists so an implementation reading the rule literally still agrees when they
 * would not.
 */
export function compareCodePoints(a, b) {
  const left = [...String(a)];
  const right = [...String(b)];
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const delta = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

class ReceiptCanonicalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReceiptCanonicalizationError";
  }
}

function required(container, key, path) {
  const value = container === null || typeof container !== "object" ? undefined : container[key];
  if (value === undefined) {
    throw new ReceiptCanonicalizationError(
      `canonicalizeReceipt: required field "${path}" is undefined — validate the receipt before canonicalizing it`,
    );
  }
  return value;
}

// ── THE SPEC IS ALL-OR-NOTHING ──────────────────────────────────────────────
// assembler_obligations.order says "VALIDATE, THEN CANONICALIZE, ALWAYS…
// throws on any undefined required field rather than emitting bytes with the
// key missing". `required()` applies that rule to the RECEIPT; these two apply
// the same rule to the SPEC, which used to be the one input that was quietly
// completed instead of refused.
//
// WHAT A PER-KEY FALLBACK COST. A caller passing a spec whose
// `domain_separator` had been renamed by a major bump, alongside a five-bucket
// `canonical_bucket_order`, got bytes byte-identical to THIS repo's golden
// while `receiptSemanticErrors` judged bucket order by THEIRS: two authorities
// in one call, and no signal. A supplied spec can differ from the fallback only
// when the caller's authority has diverged from ours — precisely the drift the
// pin exists to catch — so the gap is now a named refusal.
//
// A COMPLETE-BUT-WRONG SPEC IS STILL HONOURED VERBATIM, deliberately: the
// caller has then stated its whole authority, and reproducing what it asked for
// is how a verifier holding a different version's spec finds out the bytes
// disagree. Only a HALF-stated authority is refused.
function resolveSpec(spec, fn) {
  if (spec === undefined) return PINNED_SPEC;
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new ReceiptCanonicalizationError(
      `${fn}: spec must be an object — omit it entirely to canonicalize under the pinned spec`,
    );
  }
  return spec;
}

function requiredSpecField(spec, key, fn) {
  const value = spec[key];
  if (value === undefined || value === null) {
    throw new ReceiptCanonicalizationError(
      `${fn}: spec is missing "${key}" — pass the complete published canonicalization spec, or omit the spec entirely to use the pin; a partial spec is not completed from it`,
    );
  }
  return value;
}

// Every number in schema 1.0 is an integer, so the canonical bytes never carry
// a decimal point or an exponent. A float reaching here (a raw `participation`
// ratio in place of `participation_bps`, say) would serialize to bytes no other
// implementation is obliged to reproduce, so it is refused rather than emitted.
function assertIntegers(node, path) {
  if (typeof node === "number") {
    if (!Number.isSafeInteger(node)) {
      throw new ReceiptCanonicalizationError(
        `canonicalizeReceipt: "${path}" is ${node} — every number in schema 1.0 is a safe integer`,
      );
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => assertIntegers(child, `${path}/${index}`));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) assertIntegers(child, `${path}/${key}`);
  }
}

/**
 * The canonical bytes: domain prefix, then RFC 8259 compact JSON in the pinned
 * order, then the trailing newline. Field order is written out LITERALLY here
 * rather than derived from the spec file, because this is the definition; the
 * fixture test then holds `consensus-receipt.canonicalization.json` to it, so
 * the two can never drift apart unnoticed.
 *
 * Throws `ReceiptCanonicalizationError` on any undefined required field, on a
 * receipt declaring a schema version these rules do not implement, and on a
 * spec that is supplied but incomplete. Omit `spec` to use the pin.
 */
export function canonicalizeReceipt(receipt, spec) {
  // SPEC FIRST, BEFORE THE RECEIPT IS EVEN READ. All three fields are pulled
  // here rather than at their use sites so a partial spec is refused before any
  // byte is shaped, and named by the first key it is missing.
  const s = resolveSpec(spec, "canonicalizeReceipt");
  const pinnedVersion = requiredSpecField(s, "schema_version", "canonicalizeReceipt");
  const domainSeparator = requiredSpecField(s, "domain_separator", "canonicalizeReceipt");
  const trailingNewline = requiredSpecField(s, "trailing_newline", "canonicalizeReceipt");

  // THEN THE VERSION, STILL BEFORE ANY BYTE IS SHAPED. The field order, the zero-fill
  // and the domain prefix below are schema 1.0's rules. `schema_version` is
  // echoed verbatim into the bytes, so without this check a 2.0 receipt
  // canonicalizes under the v1 prefix, declares "2.0", and SILENTLY DROPS every
  // field 1.0 does not name — a well-formed digest over a truncated payload.
  // version_policy#selection says a verifier picks its schema by the receipt's
  // own version and never by "latest"; this is that rule, enforced.
  const schemaVersion = required(receipt, "schema_version", "/schema_version");
  if (schemaVersion !== pinnedVersion) {
    throw new ReceiptCanonicalizationError(
      `canonicalizeReceipt: receipt declares schema_version "${schemaVersion}" but these rules implement "${pinnedVersion}" — canonicalize it with the reference for its own version`,
    );
  }
  const quorum = required(receipt, "quorum", "/quorum");
  const stances = required(receipt, "stances", "/stances");
  const judge = required(receipt, "judge", "/judge");
  const releaseSafety = required(judge, "release_safety", "/judge/release_safety");
  const disagreements = required(judge, "disagreements", "/judge/disagreements");
  const signatures = required(receipt, "analyst_signatures", "/analyst_signatures");

  const ordered = {
    schema_version: schemaVersion,
    session_id: required(receipt, "session_id", "/session_id"),
    subject_id: required(receipt, "subject_id", "/subject_id"),
    created_at: required(receipt, "created_at", "/created_at"),
    prompt_hash: required(receipt, "prompt_hash", "/prompt_hash"),
    inputs_digest: required(receipt, "inputs_digest", "/inputs_digest"),
    quorum: {
      active: required(quorum, "active", "/quorum/active"),
      submitted: required(quorum, "submitted", "/quorum/submitted"),
      absent: required(quorum, "absent", "/quorum/absent"),
      participation_bps: required(quorum, "participation_bps", "/quorum/participation_bps"),
    },
    // FIXED FIVE KEYS, EXPLICITLY ZERO-FILLED. `aggregateSession()` builds its
    // stance rollup sparsely — only the stances that actually appear get a key —
    // so a session with two neutral takes and nothing else yields a ONE-key
    // object. Reading those keys through `required()` would refuse a perfectly
    // ordinary session; reading them through `JSON.stringify` would silently
    // drop them from the bytes. The assembler zero-fills, and the zero-fill is
    // written here so it cannot be forgotten upstream.
    stances: {
      bearish: stances.bearish ?? 0,
      cautious: stances.cautious ?? 0,
      neutral: stances.neutral ?? 0,
      constructive: stances.constructive ?? 0,
      bullish: stances.bullish ?? 0,
    },
    // Exactly JudgeOpinion (backend/src/swarm/judge.ts) plus `source` from the
    // JudgeOutcome envelope: rationale, disagreements, release_safety, source.
    // The 1.0 draft's `consensus` is gone — no judge produces it — and
    // release_safety carries the shipped shape whole rather than a
    // {safe_to_release, opinion} reduction. See
    // consensus-receipt.canonicalization.json#judge_block_source.
    judge: {
      rationale: required(judge, "rationale", "/judge/rationale"),
      disagreements: disagreements.map((item, i) => ({
        topic: required(item, "topic", `/judge/disagreements/${i}/topic`),
        positions: required(item, "positions", `/judge/disagreements/${i}/positions`).map((position, j) => ({
          member_id: required(position, "member_id", `/judge/disagreements/${i}/positions/${j}/member_id`),
          view: required(position, "view", `/judge/disagreements/${i}/positions/${j}/view`),
        })),
        what_settles: required(item, "what_settles", `/judge/disagreements/${i}/what_settles`),
      })),
      release_safety: {
        release: required(releaseSafety, "release", "/judge/release_safety/release"),
        thinly_supported: required(releaseSafety, "thinly_supported", "/judge/release_safety/thinly_supported"),
        take_count: required(releaseSafety, "take_count", "/judge/release_safety/take_count"),
        min_takes: required(releaseSafety, "min_takes", "/judge/release_safety/min_takes"),
        concerns: [...required(releaseSafety, "concerns", "/judge/release_safety/concerns")],
      },
      source: required(judge, "source", "/judge/source"),
      // THE MODE THE OPINION WAS FORMED UNDER, INSIDE THE SIGNED BYTES.
      // `swarm_session_judgements.mode` records whether the judge was running
      // in `shadow` (record the opinion, leave the session alone) or `enforce`
      // (record it AND write it onto the session). Without this field the
      // receipt cannot distinguish an opinion the session adopted from one it
      // withheld — and shadow is the documented rollout mode, so the first
      // receipts ever published would have carried prose the session never
      // showed. See judge_mode_disclosure in the canonicalization spec, and
      // the recomputable invariant below that refuses anything but `enforce`.
      mode: required(judge, "mode", "/judge/mode"),
    },
    analyst_signatures: signatures.map((item, i) => ({
      member_id: required(item, "member_id", `/analyst_signatures/${i}/member_id`),
      public_key: required(item, "public_key", `/analyst_signatures/${i}/public_key`),
      canonical_submission: required(item, "canonical_submission", `/analyst_signatures/${i}/canonical_submission`),
      signature: required(item, "signature", `/analyst_signatures/${i}/signature`),
      // WHICH REVISION THIS IS. Takes are amendable (migration 0028), so
      // "member X's take" is not a unique object; the receipt states which one
      // it carries so a reader can line the receipt up against the take store
      // rather than assume the two describe the same revision.
      revision: required(item, "revision", `/analyst_signatures/${i}/revision`),
    })),
  };
  if (receipt.weights != null) {
    ordered.weights = receipt.weights.map((item, i) => ({
      bucket: required(item, "bucket", `/weights/${i}/bucket`),
      weight_bps: required(item, "weight_bps", `/weights/${i}/weight_bps`),
    }));
  }
  assertIntegers(ordered, "");
  // JSON.stringify's escaping IS the normative rule, stated independently of it
  // in consensus-receipt.canonicalization.json#string_escaping: only U+0022,
  // U+005C and the C0 control range are escaped; every other code point,
  // including U+2028/U+2029 and every astral-plane character, is emitted as raw
  // UTF-8. An implementation whose serializer escapes non-ASCII (Python's
  // `ensure_ascii=True`) or the HTML-sensitive trio (Go's `encoding/json`)
  // produces different bytes and a different digest for the same receipt.
  return `${domainSeparator}${JSON.stringify(ordered)}${trailingNewline ? "\n" : ""}`;
}

// ── A JSON Schema (draft-07) subset validator ───────────────────────────────
// Supports precisely the keywords consensus-receipt.schema.json uses. An
// unrecognised keyword is a hard error rather than a silent pass, so the day
// someone adds `oneOf` to the schema this validator refuses to pretend.
const SUPPORTED_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "definitions",
  "type", "required", "additionalProperties", "properties",
  "const", "enum", "pattern",
  "minimum", "maximum", "minLength", "minItems", "maxItems", "items", "$ref",
]);

/**
 * Validate `value` against `schema`. Returns an array of `"<pointer>: <reason>"`
 * strings — empty means valid. Throws on a schema keyword it does not implement.
 */
export function validateReceipt(value, schema, root = schema, path = "", errors = []) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported schema keyword "${keyword}" at ${path || "/"}`);
    }
  }
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((acc, key) => (acc == null ? acc : acc[key]), root);
    if (!target) throw new Error(`unresolvable $ref ${schema.$ref}`);
    return validateReceipt(value, target, root, path, errors);
  }
  const fail = (reason) => errors.push(`${path || "/"}: ${reason}`);

  if (schema.type) {
    const ok =
      schema.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : schema.type === "array" ? Array.isArray(value)
      : schema.type === "integer" ? Number.isInteger(value)
      : schema.type === "string" ? typeof value === "string"
      : schema.type === "boolean" ? typeof value === "boolean"
      : (() => { throw new Error(`unsupported type "${schema.type}"`); })();
    if (!ok) { fail(`type must be ${schema.type}`); return errors; }
  }
  if (schema.const !== undefined && value !== schema.const) fail(`must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail("pattern");
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`minLength ${schema.minLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((item, i) => validateReceipt(item, schema.items, root, `${path}/${i}`, errors));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) fail(`missing required "${key}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!schema.properties?.[key]) fail(`additional property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) validateReceipt(value[key], sub, root, `${path}/${key}`, errors);
    }
  }
  return errors;
}

// ── Semantic invariants the schema cannot express ───────────────────────────
// Everything here is a RECOMPUTATION. A verifier holding the receipt derives
// each of these itself; none of them is a flag it has to take on trust. That is
// the reason the reconciled `release_safety` carries take_count and min_takes
// rather than a boolean: `release: "hold"` is member-steerable (a single
// model-authored concern forces it — issue #767), so a verifier has to be able
// to separate the arithmetic half from the steerable half.

/** `participation_bps`: round-half-up over the exact submitted/active ratio. */
export function participationBps(submitted, active) {
  if (!Number.isSafeInteger(submitted) || !Number.isSafeInteger(active) || active <= 0) {
    throw new Error(`participationBps: submitted/active must be integers with active > 0, got ${submitted}/${active}`);
  }
  return Math.floor((submitted / active) * 10_000 + 0.5);
}

// ── bps_conversion: shares in 0..1 to integer bps ───────────────────────────

/** A whole allocation is exactly this many basis points. */
export const BPS_DENOMINATOR = 10_000;

// How far the shares may sum from 1 and still be a share vector. 1e-6 is a
// hundredth of a basis point — far wider than the float dust a mean over eight
// analysts leaves behind (~1e-16), far narrower than any real mis-normalization.
const SHARE_SUM_TOLERANCE = 1e-6;

/**
 * bps_conversion, AND THE ONLY IMPLEMENTATION OF IT: LARGEST REMAINDER
 * (Hare quota). Floor every bucket's `share * BPS_DENOMINATOR`, then hand the
 * leftover bps out one at a time to the largest fractional remainders, TIES
 * BROKEN BY CANONICAL BUCKET ORDER.
 *
 * WHY IT IS EXPORTED. Three places need this rule — the producer (`toBps()` in
 * backend/src/swarm/consensus-receipt.ts), a verifier's weights recomputation,
 * and the published spec's `bps_conversion` prose — and a rule spelled three
 * times is three rules.
 *
 * WHAT REPLACED WHAT, AND WHY (issue #798, robotmoney-core#1290). The rule used
 * to round the first three canonical buckets to the nearest bps and SETTLE THE
 * POSITIONALLY LAST one to `10000 - prefix`, refusing when that fell outside
 * 0..10000. When the last canonical bucket (`real_world_assets`) is exactly
 * zero the three prefix buckets carry the whole distribution, three independent
 * nearest-integer roundings overshoot by +1 bps about ONE TIME IN EIGHT, the
 * settled entry becomes -1, and the vector had no representation at all — no
 * receipt could be assembled for that session. A zero `real_world_assets` is
 * four of the six real archived allocations, so this was the committee's own
 * commonest shape. Largest remainder sums to exactly BPS_DENOMINATOR by
 * construction, for every share vector, whatever sits in the last bucket.
 *
 * THE OTHER CANDIDATE core#1290 OFFERED — settle onto the largest-weight bucket
 * rather than the last — IS REJECTED THERE, in its own words: it "only moves
 * the failure: it still refuses when the largest bucket is itself near zero."
 *
 * THE TIE-BREAK IS PART OF THE RULE, NOT AN ARTEFACT OF `Array.prototype.sort`.
 * Two buckets can hold the identical share and therefore the identical
 * remainder (a three-way mean of thirds does it), and which of them takes the
 * leftover bps CHANGES THE CANONICAL BYTES and so the anchored digest. It is
 * therefore stated: canonical bucket order — the earlier bucket in
 * `canonical_bucket_order` wins — and the comparator below is total, so no
 * implementation has to know whether its sort is stable.
 *
 * THE ARITHMETIC DOMAIN IS PART OF THE RULE TOO, and for the same reason the
 * tie-break is. Everything below is IEEE-754 BINARY64 on the `mean_weight`
 * double: `raw` is a SINGLE binary64 multiply by BPS_DENOMINATOR, and
 * `remainder` is `raw - Math.floor(raw)` in binary64 — exact by Sterbenz, and
 * therefore bit-identical in every conforming implementation. Recomputing the
 * same prose in decimal, rational or fixed-point arithmetic is FORBIDDEN, not
 * merely discouraged: a decimal implementation over the 8-decimal shares the
 * producer emits disagrees with this one on real vectors. The worked case is in
 * `bps_conversion.divergent_example` — {0.05649855, 0.91716132, 0.01047881,
 * 0.01586132} converts to [565, 9171, 105, 159] here and to [565, 9172, 105,
 * 158] in decimal, because two remainders that are an exact tie in decimal
 * differ by one ULP in binary64 and the tie-break therefore never fires. One
 * such divergence is a verification failure against an anchored digest.
 *
 * `shares` is a Map (or a plain object) from bucket to a share in 0..1, read in
 * `bucketOrder`. THIS AUTHORS NO WEIGHT: it neither re-averages nor
 * re-normalizes. A vector that is not a share vector — a missing bucket, a
 * share above 1 or more than SHARE_SUM_TOLERANCE below 0, or a total more than
 * 1e-6 away from 1 — is REFUSED by name rather than converted into a
 * plausible-looking wrong answer. That refusal is about the INPUT, and no
 * longer about where a bucket sits: the positional refusal this function used
 * to carry is gone. The ONE input it silently repairs is the producer's own
 * negative settle dust, floored to 0 — see the comment at the clamp, and
 * `bps_conversion.negative_dust_clamp`. The sum check reads the CLAMPED shares,
 * because those are the numbers actually converted.
 *
 * @throws {ReceiptCanonicalizationError}
 */
export function bucketSharesToBps(shares, bucketOrder) {
  if (!Array.isArray(bucketOrder) || bucketOrder.length === 0) {
    throw new ReceiptCanonicalizationError(
      "bucketSharesToBps: bucketOrder must be a non-empty array of bucket names",
    );
  }
  const read = (bucket) =>
    shares instanceof Map
      ? shares.get(bucket)
      : shares !== null && typeof shares === "object" ? shares[bucket] : undefined;

  let total = 0;
  const entries = bucketOrder.map((bucket, index) => {
    const supplied = read(bucket);
    if (
      typeof supplied !== "number" ||
      !Number.isFinite(supplied) ||
      supplied < -SHARE_SUM_TOLERANCE ||
      supplied > 1
    ) {
      throw new ReceiptCanonicalizationError(
        `bucketSharesToBps: bucket "${bucket}" holds ${JSON.stringify(supplied) ?? "undefined"} — every bucket in canonical_bucket_order must hold a finite share in 0..1 (a share in -${SHARE_SUM_TOLERANCE}..0 is producer settle dust and is floored to 0; anything more negative is refused by name)`,
      );
    }
    // NEGATIVE SETTLE DUST IS ABSORBED, NOT AUTHORED. The producer runs its own
    // settle-the-last one layer up: meanTakeWeights() (backend/src/swarm/
    // domain.ts:1733-1751) rounds every averaged entry to 8 decimal places and
    // then OVERWRITES the positionally last one with round(1 - prefixTotal, 8).
    // localeCompare order over the four canonical buckets equals
    // canonical_bucket_order, so that last entry IS real_world_assets — and
    // when every member zeroes it, the three prefix roundings can sum just
    // above 1 and the settled entry lands on exactly -1e-8. That is about ONE
    // VECTOR IN EIGHT of the committee's commonest shape (12.39% measured over
    // 200000 producer-shaped zero-RWA sessions), so refusing it would
    // reintroduce, unchanged, the very defect this function was rewritten to
    // remove — and as a bare ReceiptCanonicalizationError rather than a named
    // refusal, i.e. an unnamed 500.
    //
    // Flooring it to 0 is a REPRESENTATION change of the same kind the whole
    // function performs: -1e-8 of a vault is not an allocation, it is the
    // residue of an 8-decimal subtraction, and 0 is the only integer bps it can
    // mean. It authors no weight — the value moves by less than one
    // ten-thousandth of a basis point, and every OTHER bucket is untouched. The
    // bound is SHARE_SUM_TOLERANCE, the same 1e-6 the sum check already allows
    // the vector to miss 1 by; a share more negative than that is a real
    // negative allocation and is still refused by name, above. The bound is NOT
    // widened for this: 1e-8 dust sits two orders of magnitude inside it.
    //
    // THE COMPARISON IS `> 0`, NOT `< 0`, AND THAT IS LOAD-BEARING. The same
    // settle also emits NEGATIVE ZERO — round(1 - prefixTotal, 8) is
    // Math.round(-1.1e-16 * 1e8) / 1e8, and Math.round of a small negative is
    // -0. IEEE-754 says `-0 < 0` is FALSE, so a `< 0` clamp lets -0 straight
    // through, `Math.floor(-0 * 10000)` is -0, and the returned weight_bps is
    // an integer -0. JSON.stringify serializes that as "0" so the canonical
    // bytes survive, but a receipt whose weights carry -0 in memory is one
    // Object.is() away from a spurious mismatch in any verifier, and nothing
    // should depend on a stringifier to launder it.
    const share = supplied > 0 ? supplied : 0;
    total += share;
    const raw = share * BPS_DENOMINATOR;
    const floored = Math.floor(raw);
    return { bucket, index, weight_bps: floored, remainder: raw - floored };
  });
  if (Math.abs(total - 1) > SHARE_SUM_TOLERANCE) {
    throw new ReceiptCanonicalizationError(
      `bucketSharesToBps: the shares sum to ${total}, not 1 — normalize the vector before converting it; this function changes representation and never authors a weight`,
    );
  }

  // The leftover is what flooring threw away, and it is at most one bp per
  // bucket: every remainder is < 1, so their sum is < bucketOrder.length, and
  // the floors are integers no greater than BPS_DENOMINATOR once the total is
  // within tolerance of 1. Handing it out one at a time is therefore always
  // possible, and the result sums to exactly BPS_DENOMINATOR by construction.
  let leftover = BPS_DENOMINATOR - entries.reduce((sum, entry) => sum + entry.weight_bps, 0);
  const byRemainder = [...entries].sort(
    (a, b) => (b.remainder - a.remainder) || (a.index - b.index),
  );
  for (const entry of byRemainder) {
    if (leftover <= 0) break;
    entry.weight_bps += 1;
    leftover -= 1;
  }
  // THE HEADLINE INVARIANT, ASSERTED RATHER THAN ARGUED. The paragraph above is
  // a proof, and a proof is exactly the kind of thing that stops holding when
  // someone widens SHARE_SUM_TOLERANCE. A vector that does not close on
  // BPS_DENOMINATOR must never leave this function: a receipt carrying one
  // would be signed and anchored, and `receiptSemanticErrors` would only find
  // it after the fact.
  if (leftover !== 0) {
    throw new ReceiptCanonicalizationError(
      `bucketSharesToBps: ${leftover} basis point(s) could not be apportioned across ${bucketOrder.length} buckets — the shares summed to ${total}, which is not a share vector`,
    );
  }
  return entries.map(({ bucket, weight_bps }) => ({ bucket, weight_bps }));
}

// ── Recomputing the rollup from the embedded submissions ────────────────────
// `stances` and `weights` are written by the AGGREGATOR at aggregation time,
// while `analyst_signatures` is derived at PUBLISH time from the frozen take
// set. Nothing used to hold the two together beyond cardinality — the stance
// total and the signature count — so any change that preserved the member count
// while changing content passed silently, which is exactly how an amended take
// produced a receipt asserting an allocation the session no longer served.
//
// Every ingredient is already inside the receipt: each `canonical_submission`
// carries its author's own stance and weight vector. So this is a
// RECOMPUTATION a stranger holding nothing but the receipt can perform, and
// therefore it belongs here in the shipped verifier rather than in the
// assembler's private write-time assertions.

// ── The embedded analyst key must not be a low-order point ──────────────────
// THIS IS PART OF THE PUBLISHED PIN, NOT A BACKEND DETAIL, and it is here
// because `receiptSemanticErrors` is the one verifier function a cross-repo
// consumer imports. The producing repo has rejected low-order keys at decode
// time since issue #789 — but that gate lives in
// backend/src/lib/signing.ts, which robotmoney-core cannot import and does not
// run. A verifier written to the published `verifier_invariants` with a stock
// ed25519 library would therefore accept an entry whose `public_key` is one of
// these encodings, and for those the single constant signature
// `0x01 || 0x00*63` verifies over ANY message — so every other invariant in
// this file could pass over a submission nobody signed. That is issue #789
// re-opened at the repository boundary, which is exactly the boundary this
// receipt exists to cross.
//
// SEVEN Y-VALUES, FOURTEEN ENCODINGS. Byte 31's high bit is the x-sign, and
// both settings of it decode to a low-order point for every entry, so the bit
// is masked before comparing and each row below stands for two accepted
// encodings. The list is the small-order subgroup plus the three non-canonical
// y >= p spellings; it is the same set libsodium's
// `crypto_core_ed25519_is_valid_point` / `ge25519_has_small_order` screen.
//
// NO HONEST KEY CAN COLLIDE. A keypair's public half is [k]B in the
// prime-order subgroup, so reaching one of these would mean hitting 8 points
// out of ~2^252.
export const LOW_ORDER_ED25519_POINT_ENCODINGS = Object.freeze([
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
]);

const B64_STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Standard padded base64 to bytes, or null. Hand-rolled rather than `atob` so
 * this module keeps its zero-dependency, zero-ambient-API discipline and so
 * malformed input is a null rather than a throw inside a verifier.
 */
function standardBase64ToBytes(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  let pad = 0;
  while (pad < 2 && value[value.length - 1 - pad] === "=") pad += 1;
  let acc = 0;
  let bits = 0;
  let written = 0;
  const out = new Uint8Array((value.length / 4) * 3 - pad);
  for (let i = 0; i < value.length - pad; i++) {
    const digit = B64_STANDARD.indexOf(value[i]);
    if (digit < 0) return null;
    acc = (acc << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (acc >> bits) & 0xff;
      written += 1;
    }
  }
  return written === out.length ? out : null;
}

/**
 * True when `bytes` is one of the fourteen low-order Ed25519 point encodings.
 *
 * ANSWERS ONLY THAT ONE QUESTION. A non-32-byte input is `false` — "not one of
 * the fourteen" — and NOT a statement that the key is usable. Shape validation
 * is the caller's separate obligation, and both callers do it first:
 * `receiptSemanticErrors` below checks the schema's base64 shape before asking,
 * and the producer's `canonicalPublicKeyBytes` (backend/src/lib/signing.ts)
 * decodes to exactly 32 bytes before asking. Ordering it the other way would
 * let a malformed key answer "not low order" and be waved through.
 */
export function isLowOrderEd25519PublicKeyBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return false;
  let hex = "";
  for (let i = 0; i < 32; i++) {
    const byte = i === 31 ? bytes[31] & 0x7f : bytes[i];
    hex += byte.toString(16).padStart(2, "0");
  }
  return LOW_ORDER_ED25519_POINT_ENCODINGS.includes(hex);
}

/**
 * The same predicate over a receipt's `public_key` as carried: standard padded
 * base64 of a raw 32-byte key. Malformed base64 is `false` for the reason given
 * above — it is not low-order, it is not a key at all, and that is a different
 * error the caller reports separately.
 */
export function isLowOrderEd25519PublicKey(publicKeyB64) {
  return isLowOrderEd25519PublicKeyBytes(standardBase64ToBytes(publicKeyB64));
}

const round8 = (value) => Math.round(value * 1e8) / 1e8;

/**
 * One analyst's weight vector, normalized to sum 1 — the reference for
 * `normalizedTakeWeights()` in backend/src/swarm/domain.ts. Returns null for a
 * take that carries no usable vector, which is a legal take rather than an
 * error: `weights` is optional on a submission.
 */
function normalizedSubmissionWeights(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set();
  const entries = [];
  let total = 0;
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const { bucket, weight } = candidate;
    if (typeof bucket !== "string" || bucket.trim() === "" || seen.has(bucket) ||
        typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) return null;
    seen.add(bucket);
    entries.push({ bucket, weight });
    total += weight;
  }
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return entries.map(({ bucket, weight }) => ({ bucket, weight: weight / total }));
}

/**
 * The deterministic mean of already-normalized vectors, in bps — the reference
 * for `meanTakeWeights()` (backend/src/swarm/domain.ts) composed with the
 * bps_conversion rule. Returns null when the union of buckets across the
 * vectors is not exactly `bucketOrder`, which is the one case schema 1.0
 * cannot carry and the assembler is obliged to refuse. It composes with
 * LARGEST REMAINDER, so the returned vector sums to exactly BPS_DENOMINATOR;
 * it can also RAISE, because `bucketSharesToBps` refuses a mean that is not a
 * share vector — the caller in `receiptSemanticErrors` turns that into a
 * reported error rather than letting it escape the verifier.
 *
 * THE VECTORS ARRIVE IN THE RECEIPT'S OWN ORDER (member_id ascending), which
 * is not necessarily the order the producer summed them in (received_at). Float
 * addition is not associative, so the two can differ by an ulp before
 * `round8`; that only reaches the bps output for a mean sitting exactly on a
 * 5e-9 boundary, and the consequence would be a refusal at assembly rather than
 * a bad artifact. Stated so an implementer knows the order is normative.
 */
function meanWeightsBps(vectors, bucketOrder) {
  const totals = new Map();
  for (const vector of vectors) {
    for (const { bucket, weight } of vector) totals.set(bucket, (totals.get(bucket) ?? 0) + weight);
  }
  if (totals.size !== bucketOrder.length || bucketOrder.some((bucket) => !totals.has(bucket))) return null;
  const averaged = bucketOrder.map((bucket) => ({ bucket, weight: totals.get(bucket) / vectors.length }));
  const averageTotal = averaged.reduce((sum, entry) => sum + entry.weight, 0);
  const result = averaged.map(({ bucket, weight }) => ({ bucket, weight: round8(weight / averageTotal) }));
  const finalIndex = result.length - 1;
  const prefixTotal = result.slice(0, finalIndex).reduce((sum, entry) => sum + entry.weight, 0);
  result[finalIndex].weight = round8(1 - prefixTotal);
  return bucketSharesToBps(new Map(result.map((entry) => [entry.bucket, entry.weight])), bucketOrder);
}

export function receiptSemanticErrors(receipt, spec) {
  // Same all-or-nothing rule as canonicalizeReceipt, and read up front for the
  // same reason: `canonical_bucket_order` is only consulted for a receipt that
  // carries `weights`, so reading it at its use site would let a partial spec
  // pass unnoticed for every receipt that omits them.
  const s = resolveSpec(spec, "receiptSemanticErrors");
  const bucketOrder = requiredSpecField(s, "canonical_bucket_order", "receiptSemanticErrors");
  const errors = [];
  const q = receipt.quorum;
  if (q.active !== q.submitted + q.absent) errors.push("quorum: active !== submitted + absent");
  if (q.participation_bps !== participationBps(q.submitted, q.active)) {
    errors.push("quorum: participation_bps is not round-half-up(submitted / active)");
  }
  const stanceTotal = RECEIPT_STANCE_KEYS.reduce((sum, key) => sum + (receipt.stances[key] ?? 0), 0);
  if (stanceTotal !== q.submitted) errors.push("stances: counts do not sum to quorum.submitted");

  const memberIds = receipt.analyst_signatures.map((s) => s.member_id);
  if (memberIds.length !== q.submitted) errors.push("analyst_signatures: count !== quorum.submitted");
  if (new Set(memberIds).size !== memberIds.length) errors.push("analyst_signatures: duplicate member_id");
  if ([...memberIds].sort(compareCodePoints).join(" ") !== memberIds.join(" ")) {
    errors.push("analyst_signatures: not sorted by member_id ascending");
  }

  const rs = receipt.judge.release_safety;
  if (rs.take_count !== q.submitted) errors.push("release_safety: take_count !== quorum.submitted");
  const thin = rs.take_count < rs.min_takes;
  if (rs.thinly_supported !== thin) errors.push("release_safety: thinly_supported !== (take_count < min_takes)");
  const release = thin || rs.concerns.length > 0 ? "hold" : "safe";
  if (rs.release !== release) errors.push("release_safety: release is not recomputable from thin support and concerns");

  for (const d of receipt.judge.disagreements) {
    for (const p of d.positions) {
      if (!memberIds.includes(p.member_id)) errors.push(`judge.disagreements: unknown member "${p.member_id}"`);
    }
  }

  // ── The judge block is the one the session ADOPTED ────────────────────────
  // `shadow` is the documented rollout mode: the opinion is recorded and the
  // session keeps its aggregator-authored prose. A receipt carrying a shadow
  // opinion would state, in signed and anchored bytes, a rationale the session
  // never showed. The assembler refuses to build one; this is the same refusal
  // stated as a fact a stranger holding only the receipt can check.
  if (receipt.judge.mode !== "enforce") {
    errors.push(`judge: mode is "${receipt.judge.mode}", not "enforce" — the opinion was recorded but never adopted by the session`);
  }

  // ── The embedded key is a usable Ed25519 key, not a low-order point ───────
  // WITHOUT THIS, EVERY OTHER INVARIANT IN THIS FUNCTION IS BYPASSABLE. For any
  // of the fourteen encodings the single constant signature `0x01 || 0x00*63`
  // verifies over ANY message, so an entry carrying one has a signature that
  // "verifies" over a `canonical_submission` its named member never wrote —
  // and the submission-binding, stance and weight recomputations below all pass
  // over it, because they read the carried string rather than asking who signed
  // it. The producing repo has refused these keys at decode time since #789,
  // but that gate is backend-only; this is the same rule stated where a
  // cross-repo verifier actually runs. See verifier_invariants in
  // consensus-receipt.canonicalization.json.
  //
  // SHAPE FIRST, THEN THE POINT. `isLowOrderEd25519PublicKey` answers only "is
  // it one of the fourteen", so a malformed key would otherwise come back
  // "false" and be waved through as fine.
  receipt.analyst_signatures.forEach((entry, i) => {
    if (typeof entry.public_key !== "string" || !/^[A-Za-z0-9+\/]{43}=$/.test(entry.public_key)) {
      errors.push(
        `analyst_signatures/${i}: public_key is not standard padded base64 of a raw 32-byte Ed25519 key`,
      );
      return;
    }
    if (isLowOrderEd25519PublicKey(entry.public_key)) {
      errors.push(
        `analyst_signatures/${i}: public_key is a LOW-ORDER Ed25519 point — one constant signature verifies over any message for these, so this entry proves nothing about its member`,
      );
    }
  });

  // ── Each carried submission belongs to the entry it sits in ───────────────
  // assembleConsensusReceipt asserts this at WRITE time; nothing asserted it on
  // the read side, so a receipt filing member B's genuinely-signed submission
  // under member A's entry (with B's key) verified clean. The signature check
  // cannot catch it: it verifies the carried string and never looks inside.
  //
  // PARSING HERE IS SAFE AND IS NOT A SUBSTITUTE FOR THE SIGNATURE CHECK. The
  // signature must still be verified over the raw carried string, never over a
  // re-serialization — whether `0.15` survives a JSON round trip is a property
  // of one serializer rather than of the signed bytes.
  const submissions = [];
  receipt.analyst_signatures.forEach((entry, i) => {
    let payload;
    try {
      payload = JSON.parse(entry.canonical_submission);
    } catch {
      errors.push(`analyst_signatures/${i}: canonical_submission is not parseable JSON`);
      submissions.push(null);
      return;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      errors.push(`analyst_signatures/${i}: canonical_submission is not a JSON object`);
      submissions.push(null);
      return;
    }
    if (payload.memberId !== entry.member_id) {
      errors.push(
        `analyst_signatures/${i}: canonical_submission was signed as "${String(payload.memberId)}" but is filed under "${entry.member_id}"`,
      );
    }
    if (payload.subjectId !== receipt.subject_id) {
      errors.push(
        `analyst_signatures/${i}: canonical_submission concerns subject "${String(payload.subjectId)}", not "${receipt.subject_id}"`,
      );
    }
    submissions.push(payload);
  });
  const allParsed = submissions.length > 0 && submissions.every((payload) => payload !== null);

  // ── stances, RECOMPUTED rather than counted ───────────────────────────────
  if (allParsed) {
    const recomputed = Object.fromEntries(RECEIPT_STANCE_KEYS.map((key) => [key, 0]));
    let unknownStance = false;
    for (const payload of submissions) {
      if (!RECEIPT_STANCE_KEYS.includes(payload.stance)) {
        errors.push(`stances: submission of "${String(payload.memberId)}" carries stance "${String(payload.stance)}", which is not one of the five`);
        unknownStance = true;
        continue;
      }
      recomputed[payload.stance] += 1;
    }
    if (!unknownStance) {
      for (const key of RECEIPT_STANCE_KEYS) {
        const carried = receipt.stances[key] ?? 0;
        if (carried !== recomputed[key]) {
          errors.push(`stances: ${key} is ${carried} but the embedded submissions carry ${recomputed[key]}`);
        }
      }
    }
  }

  if (receipt.weights != null) {
    const buckets = receipt.weights.map((w) => w.bucket);
    if (buckets.join(",") !== bucketOrder.join(",")) errors.push("weights: not in canonical bucket order");
    const sum = receipt.weights.reduce((acc, w) => acc + w.weight_bps, 0);
    if (sum !== 10_000) errors.push(`weights: bps sum is ${sum}, not 10000`);

    // ── weights, RECOMPUTED from the same submissions ───────────────────────
    // OMISSION IS NOT CHECKED, and cannot be: a `position_actions` subject
    // produces no vector however many members submitted one, and the receipt
    // does not carry the subject's recommendation type. Presence, though, is a
    // claim about the takes carried beside it, and that claim is checkable.
    if (allParsed) {
      const vectors = submissions
        .map((payload) => normalizedSubmissionWeights(payload.weights))
        .filter((vector) => vector !== null);
      // THE VERIFIER REPORTS, IT DOES NOT THROW. `bucketSharesToBps` refuses a
      // vector that is not a share vector by raising, and everything on this
      // path is attacker-supplied — a third party running this over a receipt
      // they were handed must get the reason back in `errors`, never an
      // exception out of a function whose whole contract is "returns the list
      // of things wrong with this receipt".
      let expected = null;
      let refusal = null;
      if (vectors.length > 0) {
        try {
          expected = meanWeightsBps(vectors, bucketOrder);
        } catch (e) {
          refusal = e instanceof ReceiptCanonicalizationError ? e.message : String(e);
        }
      }
      if (expected === null) {
        errors.push(
          `weights: cannot be recomputed from the embedded submissions — ${refusal ?? "no carried submission has a vector over exactly the canonical buckets"}`,
        );
      } else {
        for (let i = 0; i < expected.length; i++) {
          const carried = receipt.weights[i];
          if (carried?.bucket !== expected[i].bucket || carried?.weight_bps !== expected[i].weight_bps) {
            errors.push(
              `weights: entry ${i} is ${JSON.stringify(carried ?? null)} but the embedded submissions mean to ${JSON.stringify(expected[i])}`,
            );
          }
        }
      }
    }
  }
  return errors;
}
