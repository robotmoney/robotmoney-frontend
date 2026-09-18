// The two shared conformance vectors added in run 20260914T-run2: the
// unknown-field refusal vector (R27 / decision D11) and the read-time envelope
// (T24). Both files were authored in robotmoney-core and copied here
// byte-identically; contract/src/__fixtures__/CONSENSUS-RECEIPT-SHARED-FIXTURES.md
// is the shared prose, and scripts/fusion/check-cross-repo-fixture-drift.ts is
// what keeps the bytes identical.
//
// WHY THESE LIVE IN THEIR OWN FILE rather than inside
// consensus-receipt-fixture.test.ts. That file pins the CANONICALIZATION — one
// receipt in, one byte string out. These two vectors pin the two boundaries
// either side of it: what a consumer must REFUSE on the way in, and what the
// read-time route must EMIT on the way out. Mixing them would bury the point.
//
// The rule both vectors serve is the same one: a consumer must never quietly
// reshape an artifact that has already been signed and anchored. Dropping an
// unknown field and accepting the rest, or inventing its own envelope shape,
// are the same failure wearing different clothes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeReceipt, validateReceipt, receiptSemanticErrors } from "../../src/consensus-receipt.js";

const FIXTURES = join(import.meta.dir, "../../src/__fixtures__");
const readJson = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const readText = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const spec = readJson("consensus-receipt.canonicalization.json");
const schema = readJson("consensus-receipt.schema.json");
const valid = readJson("consensus-receipt.valid.json");
const golden = readText("consensus-receipt.valid.canonical.txt");

/**
 * The unwrap rule, as CONSENSUS-RECEIPT-SHARED-FIXTURES.md states it, written
 * once. Top level wins, then `.receipt`, otherwise refuse — never null, never
 * pass the envelope on as if it were a receipt.
 */
function unwrapReceipt(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && "schema_version" in (body as any)) return body as Record<string, unknown>;
  const inner = (body as any)?.receipt;
  if (inner && typeof inner === "object" && "schema_version" in inner) return inner as Record<string, unknown>;
  throw new Error("neither a consensus receipt nor an envelope carrying one");
}

describe("consensus-receipt.unknown-fields-refused.json (R27 / D11)", () => {
  const unknown = readJson("consensus-receipt.unknown-fields-refused.json");

  test("the vector is NOT VACUOUS: it is the valid fixture plus exactly two unknown fields", () => {
    // A conformance vector that differs from the base in some other way would
    // be refused for some other reason, and would prove nothing about unknown
    // fields. This test is what stops that from going unnoticed.
    expect(unknown).toHaveProperty("experimental_confidence");
    expect(unknown.judge).toHaveProperty("fallback_reason");
    const stripped = structuredClone(unknown);
    delete stripped.experimental_confidence;
    delete stripped.judge.fallback_reason;
    expect(stripped).toEqual(valid);
    // One TOP-LEVEL and one NESTED, on purpose: a validator that only checks
    // the root object passes the first and fails the second.
    expect(Object.keys(unknown).filter((k) => !(k in valid))).toEqual(["experimental_confidence"]);
    expect(Object.keys(unknown.judge).filter((k) => !(k in valid.judge))).toEqual(["fallback_reason"]);
  });

  test("the base fixture it is derived from validates CLEAN", () => {
    expect(validateReceipt(valid, schema)).toEqual([]);
    expect(receiptSemanticErrors(valid, spec)).toEqual([]);
  });

  test("REFUSED — both unknown fields, top-level and nested, are named", () => {
    // Decision D11 / R27: the outcome is REFUSE. Accepting the receipt with the
    // unknown keys dropped is the rc.3 failure (course correction C-16) and
    // must be red here.
    const errors = validateReceipt(unknown, schema);
    expect(errors).not.toEqual([]);
    expect(errors.some((e) => e.includes("experimental_confidence"))).toBe(true);
    expect(errors.some((e) => e.includes("fallback_reason"))).toBe(true);
    expect(errors.some((e) => e.startsWith("/:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("/judge:"))).toBe(true);
  });

  test("the refusal is STRUCTURAL, so it cannot be switched off by relaxing one keyword", () => {
    // additionalProperties:false is set on every object in the schema, not only
    // the root. If a future edit loosens one of them this test says which.
    const objects = ["", "quorum", "stances", "judge", "judge.release_safety"];
    for (const path of objects) {
      let node: any = schema;
      for (const step of path.split(".").filter(Boolean)) node = node.properties[step];
      expect({ path, additionalProperties: node.additionalProperties }).toEqual({ path, additionalProperties: false });
    }
  });

  test("CANONICALIZATION SILENTLY DROPS UNKNOWN FIELDS — which is exactly why validation is mandatory and FIRST", () => {
    // This is a recorded property, not an endorsement. canonicalizeReceipt()
    // emits the published field order and nothing else, so an unknown field
    // simply disappears from the bytes: the digest of the refused vector equals
    // the digest of the valid receipt. A consumer that canonicalizes without
    // validating would therefore anchor a digest for a payload it never
    // checked, and the unknown fields would live on only in the served JSON.
    // consensus-receipt.canonicalization.json#assembler_obligations states the
    // order (validate, recompute, canonicalize) for this reason; the test below
    // is the reason the order is normative rather than stylistic.
    const bytes = canonicalizeReceipt(unknown, spec);
    expect(bytes).not.toContain("experimental_confidence");
    expect(bytes).not.toContain("fallback_reason");
    expect(bytes).toBe(golden);
  });
});

describe("consensus-receipt.envelope.json (T24)", () => {
  const envelope = readJson("consensus-receipt.envelope.json");

  test("the envelope's key set and ORDER are the pin", () => {
    // Order matters as much as membership: this fixture is what every consumer
    // compares against, and a route that reorders its response object is a
    // route whose output no longer equals the fixture byte for byte.
    expect(Object.keys(envelope)).toEqual([
      "sessionId",
      "subjectId",
      "schemaVersion",
      "publishedAt",
      "receipt",
      "canonicalBytes",
      "verified",
      "signatures",
      "unverifiedReasons",
    ]);
  });

  test("it wraps consensus-receipt.valid.json, unmodified", () => {
    expect(envelope.receipt).toEqual(valid);
    expect(envelope.sessionId).toBe(valid.session_id);
    expect(envelope.subjectId).toBe(valid.subject_id);
    expect(envelope.schemaVersion).toBe(valid.schema_version);
  });

  test("canonicalBytes is the GOLDEN text, not a re-serialization the envelope invented", () => {
    expect(envelope.canonicalBytes).toBe(golden);
    expect(canonicalizeReceipt(envelope.receipt, spec)).toBe(golden);
  });

  test("a verified envelope states an empty reason list and one verdict per signature", () => {
    expect(envelope.verified).toBe(true);
    expect(envelope.unverifiedReasons).toEqual([]);
    expect(envelope.signatures).toHaveLength(valid.analyst_signatures.length);
    expect(envelope.signatures.map((s: any) => s.memberId)).toEqual(
      valid.analyst_signatures.map((s: any) => s.member_id),
    );
    for (const s of envelope.signatures) expect(s).toEqual({ memberId: s.memberId, verified: true });
  });

  test("the unwrap rule: top level wins, then .receipt, otherwise REFUSE", () => {
    expect(unwrapReceipt(envelope)).toEqual(valid);
    expect(unwrapReceipt(valid)).toEqual(valid);
    // A top level that is itself a receipt wins even when it also carries a
    // `receipt` key, so the wrong object can never be picked silently.
    expect(unwrapReceipt({ ...valid, receipt: { schema_version: "1.0", decoy: true } })).toEqual({
      ...valid,
      receipt: { schema_version: "1.0", decoy: true },
    });
    // Refuse — never null, never the envelope passed on as a receipt.
    expect(() => unwrapReceipt({ sessionId: "x", receipt: null })).toThrow(/neither a consensus receipt nor an envelope/);
    expect(() => unwrapReceipt({ receipt: { no_schema_version: true } })).toThrow();
    expect(() => unwrapReceipt(null)).toThrow();
  });

  test("unwrapping cannot move the digest: envelope and bare receipt canonicalize identically", () => {
    expect(canonicalizeReceipt(unwrapReceipt(envelope), spec)).toBe(canonicalizeReceipt(unwrapReceipt(valid), spec));
  });
});
