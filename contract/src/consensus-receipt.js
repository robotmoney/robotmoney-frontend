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
    },
    analyst_signatures: signatures.map((item, i) => ({
      member_id: required(item, "member_id", `/analyst_signatures/${i}/member_id`),
      public_key: required(item, "public_key", `/analyst_signatures/${i}/public_key`),
      canonical_submission: required(item, "canonical_submission", `/analyst_signatures/${i}/canonical_submission`),
      signature: required(item, "signature", `/analyst_signatures/${i}/signature`),
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

  if (receipt.weights != null) {
    const buckets = receipt.weights.map((w) => w.bucket);
    if (buckets.join(",") !== bucketOrder.join(",")) errors.push("weights: not in canonical bucket order");
    const sum = receipt.weights.reduce((acc, w) => acc + w.weight_bps, 0);
    if (sum !== 10_000) errors.push(`weights: bps sum is ${sum}, not 10000`);
  }
  return errors;
}
