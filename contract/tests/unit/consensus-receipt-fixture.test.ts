// The pinned Project Fusion consensus receipt (issue #775).
//
// WHAT THIS FILE IS. The receipt is the signed, publicly-anchored artifact
// robotmoney-core anchors and issue #754 assembles. Its one real property is
// that anyone holding the payload can recompute the bytes and the digest, so
// this file is the PIN: the golden `consensus-receipt.valid.canonical.txt` is
// the cross-repo target, and every assertion below exists so that changing
// field order, the domain prefix, number formatting, string escaping, or the
// timestamp form turns this file red instead of silently reshaping an artifact
// that has already been signed.
//
// THE REFERENCE ITSELF LIVES IN `contract/src/consensus-receipt.js`, not here.
// A cross-repo pin whose only executable form is inside a test file cannot be
// imported by the assembler that has to reproduce it. This file holds the
// published spec JSON to that module, so the two can never drift apart.
//
// ZERO DEPENDENCIES, ON PURPOSE. contract/ has no runtime deps and CI runs it
// with nothing but a root `bun install`. The JSON Schema validator is a
// deliberately small subset covering exactly the keywords the receipt schema
// uses — pulling ajv in to validate one schema would add a dependency to the
// package whose whole selling point is not having any.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECEIPT_CANONICAL_BUCKET_ORDER,
  RECEIPT_DOMAIN_SEPARATOR,
  RECEIPT_SCHEMA_VERSION,
  RECEIPT_STANCE_KEYS,
  RECEIPT_TRAILING_NEWLINE,
  canonicalizeReceipt,
  compareCodePoints,
  participationBps,
  receiptSemanticErrors,
  validateReceipt,
} from "../../src/consensus-receipt.js";

const FIXTURES = join(import.meta.dir, "../../src/__fixtures__");

function readJson(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}
function readText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/** Key order of the object at JSON path `pointer` inside `canonicalJson`. */
function keyOrderAt(canonicalJson: string, pointer: string[]): string[] {
  let node: any = JSON.parse(canonicalJson);
  for (const step of pointer) node = Array.isArray(node) ? node[Number(step)] : node[step];
  return Object.keys(node);
}

/** Apply a refused-variant `patch` ({json pointer: value}, null = delete). */
function applyPatch(receipt: any, patch: Record<string, unknown>): any {
  const next = structuredClone(receipt);
  for (const [pointer, value] of Object.entries(patch)) {
    const steps = pointer.split("/").filter(Boolean);
    const last = steps.pop()!;
    let node: any = next;
    for (const step of steps) node = node[step];
    if (value === null) delete node[last];
    else node[last] = value;
  }
  return next;
}

async function verifiesEd25519(signature: any): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(signature.public_key, "base64"),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    Buffer.from(signature.signature, "base64"),
    new TextEncoder().encode(signature.canonical_submission),
  );
}

describe("Project Fusion consensus-receipt shared fixture", () => {
  const spec = readJson("consensus-receipt.canonicalization.json");
  const valid = readJson("consensus-receipt.valid.json");
  const validNoWeights = readJson("consensus-receipt.valid-no-weights.json");
  const invalid = readJson("consensus-receipt.invalid.json");
  const escaping = readJson("consensus-receipt.escaping.json");
  const refused = readJson("consensus-receipt.refused-variants.json");
  const mapping = readJson("consensus-receipt.bucket-vault-map.json");
  const schema = readJson("consensus-receipt.schema.json");
  const golden = readText("consensus-receipt.valid.canonical.txt");
  const escapingGolden = readText("consensus-receipt.escaping.canonical.txt");

  // ── the byte pin ──────────────────────────────────────────────────────────

  test("fixed-order JavaScript bytes match the cross-repo golden", () => {
    expect(canonicalizeReceipt(valid, spec)).toBe(golden);
    expect(canonicalizeReceipt(Object.fromEntries(Object.entries(valid).reverse()) as any, spec)).toBe(golden);
  });

  test("the domain prefix is pinned, and it is the first thing hashed", () => {
    expect(spec.domain_separator).toBe("robotmoney:consensus-receipt:v1\n");
    expect(golden.startsWith("robotmoney:consensus-receipt:v1\n")).toBe(true);
    // A receipt without the prefix must not be mistakable for one with it.
    expect(golden.slice(spec.domain_separator.length).startsWith("{")).toBe(true);
    expect(golden.endsWith("}\n")).toBe(true);
  });

  test("the canonicalizer's field order is exactly what the spec file publishes", () => {
    const body = golden.slice(spec.domain_separator.length);
    expect(keyOrderAt(body, [])).toEqual(spec.field_order);
    for (const [pointer, expected] of Object.entries(spec.nested_field_order as Record<string, string[]>)) {
      // "judge.disagreements[].positions[]" -> ["judge","disagreements","0","positions","0"]
      const path = pointer.replace(/\[\]/g, ".0").split(".").filter(Boolean);
      expect(keyOrderAt(body, path)).toEqual(expected);
    }
  });

  test("every number in the canonical bytes is a bare integer", () => {
    // Cross-repo number formatting: an assembler emitting 1250.0 or 1.25e3
    // produces different bytes for the same receipt. Every v1 number is an
    // integer, so the pin is that no number literal ever carries a decimal
    // point, an exponent, or a leading zero.
    for (const text of [golden, escapingGolden]) {
      const body = text.slice(spec.domain_separator.length);
      const withoutStrings = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const numbers = withoutStrings.match(/-?\d[\d.eE+-]*/g) ?? [];
      expect(numbers.length).toBeGreaterThan(0);
      for (const literal of numbers) expect(literal).toMatch(/^(0|-?[1-9]\d*)$/);
    }
  });

  test("weights is the last v1 field and omission preserves the old byte shape", () => {
    expect(spec.field_order.at(-1)).toBe("weights");
    expect(spec.optional_append_only_fields).toEqual(["weights"]);
    const withoutWeights = canonicalizeReceipt(validNoWeights, spec);
    expect(withoutWeights).not.toContain('"weights":');
    expect(withoutWeights.startsWith(spec.domain_separator)).toBe(true);
    // A judged-but-unweighted receipt is legal, and it is still a full receipt.
    expect(validNoWeights.judge.release_safety.release).toBe("hold");
    expect(validateReceipt(validNoWeights, schema)).toEqual([]);
    expect(receiptSemanticErrors(validNoWeights, spec)).toEqual([]);
  });

  // ── the exported constants are the same pin, not a second authority ───────

  test("every exported constant equals the published spec, and drives the bytes when the spec omits it", () => {
    // WHY THIS TEST EXISTS. The pin was spelled twice — once as these
    // constants, exported for #754 and robotmoney-core to import, and once in
    // consensus-receipt.canonicalization.json, which is what canonicalizeReceipt
    // actually read. NOTHING read the constants, so changing
    // RECEIPT_DOMAIN_SEPARATOR to a wrong prefix left every test in this repo
    // green while a consumer that built its spec from the constant anchored
    // keccak256 over a differently-prefixed payload. Each assertion below binds
    // one constant to the published document AND to the golden bytes.
    expect(RECEIPT_DOMAIN_SEPARATOR).toBe(spec.domain_separator);
    expect(golden.startsWith(RECEIPT_DOMAIN_SEPARATOR)).toBe(true);
    expect(escapingGolden.startsWith(RECEIPT_DOMAIN_SEPARATOR)).toBe(true);

    expect(RECEIPT_SCHEMA_VERSION).toBe(spec.schema_version);
    expect(RECEIPT_SCHEMA_VERSION).toBe(schema.properties.schema_version.const);
    expect(golden).toContain(`"schema_version":"${RECEIPT_SCHEMA_VERSION}"`);

    expect(RECEIPT_TRAILING_NEWLINE).toBe(spec.trailing_newline);
    expect(golden.endsWith("\n")).toBe(RECEIPT_TRAILING_NEWLINE);

    // The stance keys: milder — a wrong list is a spurious refusal rather than
    // a wrong digest — but every fixture carries all five at some count, so
    // dropping one from the list alone changed nothing before this line.
    expect([...RECEIPT_STANCE_KEYS]).toEqual(spec.nested_field_order.stances);
    expect(keyOrderAt(golden.slice(spec.domain_separator.length), ["stances"])).toEqual([...RECEIPT_STANCE_KEYS]);

    expect([...RECEIPT_CANONICAL_BUCKET_ORDER]).toEqual(spec.canonical_bucket_order);
    expect([...RECEIPT_CANONICAL_BUCKET_ORDER]).toEqual(mapping.canonical_bucket_order);

    // AND THEY ARE ON THE LIVE PATH. A caller that hand-builds a spec object —
    // rather than importing the published JSON — used to get `"undefined{...}"`
    // bytes, or bytes with no trailing newline, for every field it forgot. With
    // NO spec at all the constants alone must reproduce the golden exactly.
    expect(canonicalizeReceipt(valid)).toBe(golden);
    expect(canonicalizeReceipt(valid, {})).toBe(golden);
    expect(canonicalizeReceipt(escaping, {})).toBe(escapingGolden);
    expect(receiptSemanticErrors(valid, {})).toEqual([]);
    const misordered = structuredClone(valid);
    misordered.weights.reverse();
    expect(receiptSemanticErrors(misordered, {})).toContain("weights: not in canonical bucket order");
  });

  test("the package's exports map resolves the canonicalizer AND the data it takes", async () => {
    // THE PROMOTION INTO contract/src IS ONLY HALF A FIX WITHOUT THIS. All three
    // functions take their data as arguments — canonicalizeReceipt reads
    // spec.domain_separator and spec.trailing_newline, receiptSemanticErrors
    // reads spec.canonical_bucket_order, validateReceipt needs the schema
    // document — so an exports map naming only "." and "./routes" left a
    // consumer able to import the code and forced to VENDOR the JSON, with
    // nothing holding the vendored copy to this repo's. Every specifier below
    // failed with ERR_PACKAGE_PATH_NOT_EXPORTED before the map grew
    // "./consensus-receipt" and "./fixtures/*".
    const throughPackage = (specifier: string): string =>
      readFileSync(fileURLToPath(import.meta.resolve(specifier)), "utf8");

    for (const name of [
      "consensus-receipt.canonicalization.json",
      "consensus-receipt.schema.json",
      "consensus-receipt.valid.json",
      "consensus-receipt.valid.canonical.txt",
    ]) {
      expect(throughPackage(`@robotmoney/contract/fixtures/${name}`)).toBe(readText(name));
    }

    // The module subpath resolves to the same module, and it canonicalizes the
    // spec resolved through the package to the golden resolved through the
    // package — the whole cross-repo round trip, using no path this repo knows.
    const viaPackage = await import("@robotmoney/contract/consensus-receipt");
    expect(viaPackage.RECEIPT_DOMAIN_SEPARATOR).toBe(RECEIPT_DOMAIN_SEPARATOR);
    expect(
      viaPackage.canonicalizeReceipt(
        JSON.parse(throughPackage("@robotmoney/contract/fixtures/consensus-receipt.valid.json")),
        JSON.parse(throughPackage("@robotmoney/contract/fixtures/consensus-receipt.canonicalization.json")),
      ),
    ).toBe(throughPackage("@robotmoney/contract/fixtures/consensus-receipt.valid.canonical.txt"));
  });

  // ── string escaping, exercised rather than asserted ───────────────────────

  test("the escaping golden reproduces byte-for-byte, and it carries every dialect-splitting character", () => {
    // A GOLDEN OF ALL-ASCII TEXT CANNOT DISCRIMINATE. Go's encoding/json
    // escapes < > & U+2028 U+2029 by default; Python's json.dumps escapes
    // every non-ASCII code point by default. Both reproduce an ASCII golden
    // exactly and then diverge on the first real receipt — and every text
    // field in this payload is model- or member-authored free text.
    expect(canonicalizeReceipt(escaping, spec)).toBe(escapingGolden);
    expect(validateReceipt(escaping, schema)).toEqual([]);
    expect(receiptSemanticErrors(escaping, spec)).toEqual([]);

    // Raw, never escaped: every one of these is a byte a defaulting
    // implementation would have written as \uXXXX.
    for (const raw of ["—", "保守的な運用", "через", "&", "<", ">", " ", "\u{1F680}", " ", "é"]) {
      expect(escapingGolden).toContain(raw);
    }
    // Escaped, and only these: quote, backslash, and the C0 short forms.
    expect(escapingGolden).toContain('\\"');
    expect(escapingGolden).toContain("\\\\");
    expect(escapingGolden).toContain("\\n");
    expect(escapingGolden).toContain("\\t");
    // THE WHOLE RULE IN ONE ASSERTION: no \uXXXX form appears anywhere. Every
    // escaping dialect that reaches for one — for non-ASCII, for the HTML
    // trio, for the line separators, or for an astral-plane surrogate pair —
    // fails here rather than in production.
    expect(escapingGolden).not.toContain("\\u");
    // The astral-plane character is 4 bytes of UTF-8, not a surrogate pair.
    expect(Buffer.from(escapingGolden, "utf8").includes(Buffer.from("\u{1F680}", "utf8"))).toBe(true);

    // And the rule is published normatively, not by naming a JS function.
    expect(spec.string_escaping.escaped).toContain("U+0022");
    expect(spec.string_escaping.escaped).toContain("U+005C");
    expect(spec.string_escaping.escaped).toContain("U+0000-U+001F");
    expect(spec.string_escaping.raw).toContain("raw UTF-8");
    expect(spec.string_escaping.raw).toContain("U+2028");
    expect(spec.json_serialization).not.toContain("JSON.stringify");
  });

  // ── canonical bytes are a function of the session ─────────────────────────

  test("every near-miss representation of the same session is refused, each by a named error", () => {
    // Loud-skip-never: the case list is data, so it is asserted non-empty and
    // every case must both fail and fail for the reason it names.
    expect(refused.base).toBe("consensus-receipt.valid.json");
    expect(refused.cases.length).toBeGreaterThanOrEqual(9);
    for (const testCase of refused.cases) {
      const mutated = applyPatch(valid, testCase.patch);
      const errors = validateReceipt(mutated, schema);
      expect({ name: testCase.name, errors }).toEqual({ name: testCase.name, errors: [testCase.expect_schema_error] });
    }
  });

  test("the timestamp form is pinned to one spelling, and the spec says which", () => {
    const pattern = new RegExp(schema.properties.created_at.pattern);
    expect(pattern.test("2026-08-26T16:00:00Z")).toBe(true);
    for (const rejected of [
      "2026-08-26T16:00:00.000Z", "2026-08-26T16:00:00.123456Z",
      "2026-08-26T18:00:00+02:00", "2026-08-26T16:00:00z",
      "2026-08-26 16:00:00Z", "2026-08-26T16:00:00",
    ]) {
      expect(pattern.test(rejected)).toBe(false);
    }
    // `format: date-time` would have accepted all six; it is deliberately gone.
    expect(schema.properties.created_at.format).toBeUndefined();
    expect(spec.timestamp_serialization.field).toBe("created_at");
    expect(spec.timestamp_serialization.form).toContain(schema.properties.created_at.pattern);
    expect(spec.timestamp_serialization.producer_note).toContain("toISOString");
    for (const receipt of [valid, validNoWeights, escaping]) {
      expect(receipt.created_at).toMatch(pattern);
    }
  });

  test("hex is lowercase everywhere, so one session has one digest", () => {
    expect(schema.definitions.hash32.pattern).toBe("^0x[0-9a-f]{64}$");
    expect(schema.properties.session_id.pattern).not.toContain("A-F");
    // subject_id was already case-pinned; the document is no longer
    // inconsistent with itself about it.
    expect(schema.properties.subject_id.pattern).toBe("^[a-z0-9][a-z0-9_-]{0,127}$");
    expect(spec.assembler_obligations.case_normalization).toContain("lowercased");
  });

  // ── the judge block, reconciled against the shipped judge ─────────────────

  test("the judge block is JudgeOpinion plus source — no invented consensus field", () => {
    // backend/src/swarm/judge.ts: `JudgeOpinion { rationale, disagreements,
    // release_safety }`. The 1.0 draft also carried `judge.consensus`, which no
    // judge produces; its only producer is buildConsensus() in
    // backend/src/swarm/domain.ts, and that restates quorum/stances in English.
    const order = ["rationale", "disagreements", "release_safety", "source"];
    expect(schema.properties.judge.required).toEqual(order);
    expect(Object.keys(schema.properties.judge.properties)).toEqual(order);
    expect(schema.properties.judge.additionalProperties).toBe(false);
    for (const receipt of [valid, validNoWeights, escaping]) {
      expect(Object.keys(receipt.judge)).toEqual(order);
    }
    expect(spec.nested_field_order.judge).toEqual(order);
    expect(golden).not.toContain('"consensus"');
  });

  test("source is carried, so a receipt is attributable to what produced it", () => {
    // runJudge() spreads one `base` — same promptHash, same inputsDigest — into
    // both the model return and the template-fallback return, and
    // templateOpinion() calls the same prose builders the aggregator uses. So
    // WITHOUT this field nothing in a published receipt separates "a model read
    // the takes" from "the model timed out". prompt_hash does not: its
    // description no longer claims otherwise.
    expect(schema.properties.judge.properties.source.enum).toEqual(["model", "fallback"]);
    expect(valid.judge.source).toBe("model");
    expect(validNoWeights.judge.source).toBe("fallback");
    expect(golden).toContain('"source":"model"');
    expect(canonicalizeReceipt(validNoWeights, spec)).toContain('"source":"fallback"');
    expect(schema.properties.prompt_hash.description).toContain("DOES NOT ESTABLISH AUTHORSHIP");
    expect(schema.properties.prompt_hash.description).not.toContain("WHICH judge wrote");
    // fallbackReason and model stay out, and the reason is recorded.
    expect(spec.judge_block_source).toContain("fallbackReason");
  });

  test("positions matches the producer verbatim: one position is enough", () => {
    // parseJudgeResponse() refuses only an EMPTY positions array, so a model
    // answer naming a single member is routine and lands in the append-only
    // swarm_session_judgements.opinion. A schema demanding two would make that
    // row un-anchorable forever. The round trip through the real parser is
    // pinned in backend/tests/consensus-receipt-judge-roundtrip.test.ts.
    expect(schema.definitions.disagreement.properties.positions.minItems).toBe(1);
    const onePosition = structuredClone(valid);
    onePosition.judge.disagreements[0].positions = [valid.judge.disagreements[0].positions[0]];
    expect(validateReceipt(onePosition, schema)).toEqual([]);
    expect(receiptSemanticErrors(onePosition, spec)).toEqual([]);
    // Empty is still refused, exactly as the producer refuses it.
    const noPositions = structuredClone(valid);
    noPositions.judge.disagreements[0].positions = [];
    expect(validateReceipt(noPositions, schema)).toContain("/judge/disagreements/0/positions: minItems 1");
  });

  test("release_safety carries the shipped shape whole, so a verifier recomputes rather than trusts", () => {
    const rs = schema.properties.judge.properties.release_safety;
    expect(rs.required).toEqual(["release", "thinly_supported", "take_count", "min_takes", "concerns"]);
    expect(rs.properties.release.enum).toEqual(["safe", "hold"]);
    // The two fields that make the flags checkable rather than assertable.
    expect(rs.properties.take_count.type).toBe("integer");
    expect(rs.properties.min_takes.minimum).toBe(1);
    // And they really are enough: recompute both flags on the good fixtures.
    for (const receipt of [valid, validNoWeights, escaping]) {
      const r = receipt.judge.release_safety;
      expect(r.thinly_supported).toBe(r.take_count < r.min_takes);
      expect(r.release).toBe(r.thinly_supported || r.concerns.length > 0 ? "hold" : "safe");
      expect(r.take_count).toBe(receipt.quorum.submitted);
    }
  });

  // ── the canonicalizer refuses rather than emits ───────────────────────────

  test("canonicalizeReceipt throws on a missing required field instead of dropping it", () => {
    // JSON.stringify omits an undefined key SILENTLY. Combined with a sparse
    // rollup upstream, an assembler that canonicalized before validating would
    // anchor a digest over bytes that would have failed validation.
    for (const pointer of [
      "/created_at", "/quorum/participation_bps", "/judge/rationale",
      "/judge/release_safety/concerns", "/judge/source",
      "/judge/disagreements/0/what_settles", "/analyst_signatures/0/signature",
    ]) {
      const broken = applyPatch(valid, { [pointer]: null });
      expect(() => canonicalizeReceipt(broken, spec)).toThrow(
        new RegExp(`required field "${pointer.replace(/[/]/g, "\\/")}" is undefined`),
      );
    }
    // A number that is not an integer never becomes bytes either.
    const floaty = applyPatch(valid, { "/quorum/participation_bps": 6666.667 });
    expect(() => canonicalizeReceipt(floaty, spec)).toThrow(/safe integer/);
    expect(spec.assembler_obligations.order).toContain("VALIDATE, THEN CANONICALIZE");
  });

  test("a receipt declaring another schema version is refused, never canonicalized under 1.0 rules", () => {
    // version_policy#selection: "A verifier picks the schema by the receipt's
    // own schema_version, never by 'latest'." The canonicalizer used to do the
    // opposite — it read schema_version through required() and echoed it
    // verbatim without ever comparing it. A 2.0 receipt therefore produced
    // well-formed bytes under the v1 prefix that DECLARED "2.0" and silently
    // dropped every 2.0 field, which is a valid-looking digest over a truncated
    // payload: exactly the mixed-version case retroactivity anticipates.
    const future = structuredClone(valid);
    future.schema_version = "2.0";
    future.some_2_0_field = "a field only 2.0 names";
    expect(() => canonicalizeReceipt(future, spec)).toThrow(/schema_version "2\.0"/);
    expect(() => canonicalizeReceipt(future)).toThrow(/schema_version "2\.0"/);
    // Not a wrapped-in-try nicety: the bytes must not exist at all.
    let emitted: string | null = null;
    try { emitted = canonicalizeReceipt(future, spec); } catch { /* expected */ }
    expect(emitted).toBeNull();
    // The rule is the published one, and it is version-agnostic: a spec for a
    // later version canonicalizes that version's receipt and refuses this one.
    expect(spec.version_policy.selection).toContain("never by");
    // And the check is version-agnostic rather than a hardcoded "1.0": the same
    // function driven by a 2.0 spec refuses the 1.0 fixture. The 2.0 rules
    // themselves do not exist yet — that is the point of refusing.
    expect(() => canonicalizeReceipt(valid, { ...spec, schema_version: "2.0" })).toThrow(/schema_version "1\.0"/);
  });

  test("stances is a fixed five-key set, explicitly zero-filled from the sparse rollup", () => {
    // aggregateSession() starts from {} and only sets stances that appear, so a
    // two-neutral session hands the assembler a ONE-key object.
    const sparse = structuredClone(valid);
    sparse.stances = { neutral: 1, constructive: 1 };
    const body = canonicalizeReceipt(sparse, spec).slice(spec.domain_separator.length);
    expect(keyOrderAt(body, ["stances"])).toEqual(spec.nested_field_order.stances);
    expect(canonicalizeReceipt(sparse, spec)).toBe(golden);
    expect(spec.assembler_obligations.stances_zero_fill).toContain("FIXED FIVE-KEY");
  });

  // ── the two obligations #754 is handed ───────────────────────────────────

  test("participation_bps is round-half-up over the exact ratio, and the rule is published", () => {
    expect(participationBps(2, 3)).toBe(6667);
    expect(participationBps(1, 3)).toBe(3333);
    expect(participationBps(1, 8)).toBe(1250); // an exact .5 boundary at the 4th digit
    expect(participationBps(1, 16)).toBe(625);
    expect(participationBps(3, 8)).toBe(3750);
    expect(participationBps(2, 2)).toBe(10_000);
    // Half-UP, not half-even: 0.00005 * 10000 boundaries round away from zero.
    expect(participationBps(1, 20_000)).toBe(1);
    expect(() => participationBps(1, 0)).toThrow(/active > 0/);
    expect(spec.assembler_obligations.participation_bps_rounding).toContain("ROUND HALF UP");
    for (const receipt of [valid, validNoWeights, escaping]) {
      expect(receipt.quorum.participation_bps).toBe(participationBps(receipt.quorum.submitted, receipt.quorum.active));
    }
  });

  test("the weights cardinality obligation is stated, not left to the assembler", () => {
    expect(schema.required).not.toContain("weights");
    expect(schema.properties.weights.minItems).toBe(4);
    expect(schema.properties.weights.maxItems).toBe(4);
    expect(spec.assembler_obligations.weights_cardinality).toContain("REFUSE TO ASSEMBLE");
    expect(spec.assembler_obligations.weights_cardinality).toContain("meanTakeWeights() returned undefined");
  });

  // ── ordering ─────────────────────────────────────────────────────────────

  test("analyst_signature_order is code-point order, and the reference sorts that way", () => {
    // The stated rule and the reference used to disagree: "UTF-8 byte order" in
    // the spec, JavaScript's default `.sort()` (UTF-16 code units) in the code.
    // They differ for every code point above U+FFFF.
    const astral = "\u{10000}";
    const fullwidth = "０";
    expect([fullwidth, astral].sort().join("")).toBe(astral + fullwidth); // UTF-16
    expect([fullwidth, astral].sort(compareCodePoints).join("")).toBe(fullwidth + astral); // code point
    expect(compareCodePoints("a", "ab")).toBeLessThan(0);
    expect(compareCodePoints("ab", "ab")).toBe(0);
    expect(spec.analyst_signature_order).toContain("UNICODE CODE POINT");
    expect(spec.analyst_signature_order).toContain("UTF-8 byte order");
    // ...and member_id is pattern-constrained so the three orders coincide.
    const pattern = "^[a-z0-9][a-z0-9_-]{0,127}$";
    expect(schema.definitions.analyst_signature.properties.member_id.pattern).toBe(pattern);
    expect(schema.definitions.disagreement.properties.positions.items.properties.member_id.pattern).toBe(pattern);
    // An out-of-order pair is caught rather than quietly canonicalized.
    const swapped = structuredClone(valid);
    swapped.analyst_signatures.reverse();
    expect(receiptSemanticErrors(swapped, spec)).toContain("analyst_signatures: not sorted by member_id ascending");

    // AND THE RECOMPUTATION ITSELF USES CODE-POINT ORDER, not just the exported
    // comparator. Every real member_id is ASCII, where all three orders agree,
    // so a reference that quietly reverted to `.sort()` would stay green on the
    // fixtures forever. These two ids are in ascending CODE POINT order and in
    // descending UTF-16 code-unit order, so they separate the two.
    const nonBmp = structuredClone(valid);
    nonBmp.judge.disagreements = [];
    nonBmp.analyst_signatures[0].member_id = fullwidth;
    nonBmp.analyst_signatures[1].member_id = astral;
    expect([fullwidth, astral]).toEqual([fullwidth, astral].sort(compareCodePoints));
    expect(receiptSemanticErrors(nonBmp, spec)).not.toContain(
      "analyst_signatures: not sorted by member_id ascending",
    );
    nonBmp.analyst_signatures.reverse();
    expect(receiptSemanticErrors(nonBmp, spec)).toContain("analyst_signatures: not sorted by member_id ascending");
  });

  // ── validation ────────────────────────────────────────────────────────────

  test("the valid fixtures pass schema and semantic validation", () => {
    expect(validateReceipt(valid, schema)).toEqual([]);
    expect(validateReceipt(validNoWeights, schema)).toEqual([]);
    expect(validateReceipt(escaping, schema)).toEqual([]);
    expect(receiptSemanticErrors(valid, spec)).toEqual([]);
  });

  test("the invalid fixture is rejected, with each reason named", () => {
    const schemaErrors = validateReceipt(invalid, schema);
    expect(schemaErrors).toContain("/session_id: pattern");
    expect(schemaErrors).toContain("/prompt_hash: pattern");
    expect(schemaErrors).toContain("/quorum/participation_bps: maximum 10000");
    expect(schemaErrors).toContain("/judge/rationale: minLength 1");
    expect(schemaErrors).toContain('/judge/release_safety/release: must be one of ["safe","hold"]');
    expect(schemaErrors).toContain('/judge/source: must be one of ["model","fallback"]');
    expect(schemaErrors).toContain("/analyst_signatures: minItems 1");

    const semantic = receiptSemanticErrors(invalid, spec);
    expect(semantic).toContain("quorum: active !== submitted + absent");
    expect(semantic).toContain("analyst_signatures: count !== quorum.submitted");
    expect(semantic).toContain("release_safety: take_count !== quorum.submitted");
    expect(semantic).toContain("release_safety: thinly_supported !== (take_count < min_takes)");
    expect(semantic).toContain("weights: not in canonical bucket order");
    expect(semantic).toContain("weights: bps sum is 9999, not 10000");
  });

  test("the subset validator refuses a schema keyword it does not implement", () => {
    // Loud-skip-never: a keyword this validator silently ignored would be a
    // hole in the only thing asserting the invalid fixture is invalid.
    expect(() => validateReceipt({}, { oneOf: [] })).toThrow(/unsupported schema keyword "oneOf"/);
    // `format` is one of them now: the draft's `format: date-time` accepted
    // four spellings of one instant, and it is gone from both sides.
    expect(() => validateReceipt("x", { type: "string", format: "date-time" })).toThrow(
      /unsupported schema keyword "format"/,
    );
  });

  // ── the rest of the pinned surface ────────────────────────────────────────

  test("the schema and data mapping cover exactly the four PRD vaults", () => {
    const buckets = ["agent_tokens", "conservative_defi_yield", "protocol_tokens", "real_world_assets"];
    expect(mapping.canonical_bucket_order).toEqual(buckets);
    expect(mapping.buckets.map((row: any) => row.bucket)).toEqual(buckets);
    expect(mapping.buckets.map((row: any) => row.vault_symbol)).toEqual([
      "rmAGENT",
      "rmUSDC",
      "rmPROTO",
      "rmRWA",
    ]);
  });

  test("the golden's embedded analyst signatures verify over exact canonicalSubmission bytes", async () => {
    const all = [...valid.analyst_signatures, ...validNoWeights.analyst_signatures, ...escaping.analyst_signatures];
    expect(all.length).toBeGreaterThan(0);
    for (const signature of all) {
      expect(await verifiesEd25519(signature)).toBe(true);
      const parsed = JSON.parse(signature.canonical_submission);
      expect(parsed.memberId).toBe(signature.member_id);
    }
  });

  test("the bps vector is canonical and exact", () => {
    expect(valid.weights.map((entry: any) => entry.bucket)).toEqual(spec.canonical_bucket_order);
    expect(valid.weights.reduce((sum: number, entry: any) => sum + entry.weight_bps, 0)).toBe(10_000);
    expect(valid.analyst_signatures).toHaveLength(valid.quorum.submitted);
  });

  // ── the version policy ────────────────────────────────────────────────────

  test("schema_version, $id and the version policy agree", () => {
    expect(schema.$id).toBe("https://robotmoney.net/schemas/consensus-receipt/1.0");
    expect(schema.properties.schema_version.const).toBe("1.0");
    // schema_version is the trailing segment of $id — the rule a verifier uses
    // to pick a schema by the receipt's own version rather than by "latest".
    expect(schema.$id.split("/").at(-1)).toBe(schema.properties.schema_version.const);
    expect(spec.version_policy.schema_id).toBe(schema.$id);
    expect(spec.schema_version).toBe(schema.properties.schema_version.const);
    for (const receipt of [valid, validNoWeights, invalid, escaping]) expect(receipt.schema_version).toBe("1.0");
    // The draft shipped an unasserted keccak256 constant that the judge
    // reconciliation silently invalidated. This repo pins bytes, not digests —
    // and says so, including whose obligation the digest assertion then is.
    expect(spec.valid_fixture_digest).toBeUndefined();
    expect(spec.digest_algorithm).toBe("keccak256");
    expect(spec.digest_note).toContain("CONSUMER OBLIGATION");
  });
});
