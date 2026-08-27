// The pinned Project Fusion consensus receipt (issue #775).
//
// WHAT THIS FILE IS. The receipt is the signed, publicly-anchored artifact
// robotmoney-core anchors and issue #754 assembles. Its one real property is
// that anyone holding the payload can recompute the bytes and the digest, so
// this file is the reference canonicalizer AND the pin: the golden
// `consensus-receipt.valid.canonical.txt` is the cross-repo target, and every
// assertion below exists so that changing field order, the domain prefix, or
// number formatting turns this file red instead of silently reshaping an
// artifact that has already been signed.
//
// ZERO DEPENDENCIES, ON PURPOSE. contract/ has no runtime deps and CI runs it
// with nothing but a root `bun install`. The JSON Schema validator here is a
// deliberately small subset covering exactly the keywords the receipt schema
// uses — pulling ajv in to validate one schema would add a dependency to the
// package whose whole selling point is not having any.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "../../src/__fixtures__");

function readJson(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

// ── The reference canonicalizer ─────────────────────────────────────────────
// Field order is written out literally rather than derived from the spec file,
// because THIS is the definition; the field-order test below then holds the
// spec JSON to it, so the two can never drift apart unnoticed.
function canonicalizeReceipt(receipt: any, spec: any): string {
  const ordered: Record<string, unknown> = {
    schema_version: receipt.schema_version,
    session_id: receipt.session_id,
    subject_id: receipt.subject_id,
    created_at: receipt.created_at,
    prompt_hash: receipt.prompt_hash,
    inputs_digest: receipt.inputs_digest,
    quorum: {
      active: receipt.quorum.active,
      submitted: receipt.quorum.submitted,
      absent: receipt.quorum.absent,
      participation_bps: receipt.quorum.participation_bps,
    },
    stances: {
      bearish: receipt.stances.bearish,
      cautious: receipt.stances.cautious,
      neutral: receipt.stances.neutral,
      constructive: receipt.stances.constructive,
      bullish: receipt.stances.bullish,
    },
    // Exactly JudgeOpinion (backend/src/swarm/judge.ts): rationale,
    // disagreements, release_safety. The 1.0 draft's `consensus` is gone — no
    // judge produces it — and release_safety carries the shipped shape whole
    // rather than a {safe_to_release, opinion} reduction. See
    // consensus-receipt.canonicalization.json#judge_block_source.
    judge: {
      rationale: receipt.judge.rationale,
      disagreements: receipt.judge.disagreements.map((item: any) => ({
        topic: item.topic,
        positions: item.positions.map((position: any) => ({
          member_id: position.member_id,
          view: position.view,
        })),
        what_settles: item.what_settles,
      })),
      release_safety: {
        release: receipt.judge.release_safety.release,
        thinly_supported: receipt.judge.release_safety.thinly_supported,
        take_count: receipt.judge.release_safety.take_count,
        min_takes: receipt.judge.release_safety.min_takes,
        concerns: [...receipt.judge.release_safety.concerns],
      },
    },
    analyst_signatures: receipt.analyst_signatures.map((item: any) => ({
      member_id: item.member_id,
      public_key: item.public_key,
      canonical_submission: item.canonical_submission,
      signature: item.signature,
    })),
  };
  if (receipt.weights != null) {
    ordered.weights = receipt.weights.map((item: any) => ({
      bucket: item.bucket,
      weight_bps: item.weight_bps,
    }));
  }
  return `${spec.domain_separator}${JSON.stringify(ordered)}${spec.trailing_newline ? "\n" : ""}`;
}

// ── A JSON Schema (draft-07) subset validator ───────────────────────────────
// Supports precisely the keywords consensus-receipt.schema.json uses. An
// unrecognised keyword is a hard error rather than a silent pass, so the day
// someone adds `oneOf` to the schema this validator refuses to pretend.
const SUPPORTED = new Set([
  "$schema", "$id", "title", "description", "definitions",
  "type", "required", "additionalProperties", "properties",
  "const", "enum", "pattern", "format",
  "minimum", "maximum", "minLength", "minItems", "maxItems", "items", "$ref",
]);

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validate(value: unknown, schema: any, root: any, path = "", errors: string[] = []): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`unsupported schema keyword "${keyword}" at ${path || "/"}`);
  }
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((acc: any, k: string) => acc?.[k], root);
    if (!target) throw new Error(`unresolvable $ref ${schema.$ref}`);
    return validate(value, target, root, path, errors);
  }
  const fail = (reason: string) => errors.push(`${path || "/"}: ${reason}`);

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
  if (schema.enum && !schema.enum.includes(value as never)) fail(`must be one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail("pattern");
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`minLength ${schema.minLength}`);
    if (schema.format === "date-time" && !DATE_TIME.test(value)) fail("format date-time");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, root, `${path}/${i}`, errors));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) fail(`missing required "${key}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!schema.properties?.[key]) fail(`additional property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) validate(obj[key], sub, root, `${path}/${key}`, errors);
    }
  }
  return errors;
}

// ── Semantic invariants the schema cannot express ───────────────────────────
// Everything here is a RECOMPUTATION. A verifier holding the receipt derives
// each of these itself; none of them is a flag it has to take on trust. That
// is the reason the reconciled `release_safety` carries take_count and
// min_takes rather than a boolean: `release: "hold"` is member-steerable (a
// single model-authored concern forces it — issue #767), so a verifier has to
// be able to separate the arithmetic half from the steerable half.
function semanticErrors(receipt: any, spec: any): string[] {
  const errors: string[] = [];
  const q = receipt.quorum;
  if (q.active !== q.submitted + q.absent) errors.push("quorum: active !== submitted + absent");
  if (q.participation_bps !== Math.floor((q.submitted / q.active) * 10_000 + 0.5)) {
    errors.push("quorum: participation_bps is not round-half-up(submitted / active)");
  }
  const stanceTotal = Object.values(receipt.stances as Record<string, number>).reduce((a, b) => a + b, 0);
  if (stanceTotal !== q.submitted) errors.push("stances: counts do not sum to quorum.submitted");

  const memberIds = receipt.analyst_signatures.map((s: any) => s.member_id);
  if (memberIds.length !== q.submitted) errors.push("analyst_signatures: count !== quorum.submitted");
  if (new Set(memberIds).size !== memberIds.length) errors.push("analyst_signatures: duplicate member_id");
  if ([...memberIds].sort().join(" ") !== memberIds.join(" ")) {
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
    const buckets = receipt.weights.map((w: any) => w.bucket);
    if (buckets.join(",") !== spec.canonical_bucket_order.join(",")) errors.push("weights: not in canonical bucket order");
    const sum = receipt.weights.reduce((acc: number, w: any) => acc + w.weight_bps, 0);
    if (sum !== 10_000) errors.push(`weights: bps sum is ${sum}, not 10000`);
  }
  return errors;
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

/** Key order of the object at JSON path `pointer` inside `canonicalJson`. */
function keyOrderAt(canonicalJson: string, pointer: string[]): string[] {
  let node: any = JSON.parse(canonicalJson);
  for (const step of pointer) node = Array.isArray(node) ? node[Number(step)] : node[step];
  return Object.keys(node);
}

describe("Project Fusion consensus-receipt shared fixture", () => {
  const spec = readJson("consensus-receipt.canonicalization.json");
  const valid = readJson("consensus-receipt.valid.json");
  const validNoWeights = readJson("consensus-receipt.valid-no-weights.json");
  const invalid = readJson("consensus-receipt.invalid.json");
  const mapping = readJson("consensus-receipt.bucket-vault-map.json");
  const schema = readJson("consensus-receipt.schema.json");
  const golden = readFileSync(join(FIXTURES, "consensus-receipt.valid.canonical.txt"), "utf8");

  // ── the byte pin ──────────────────────────────────────────────────────────

  test("fixed-order JavaScript bytes match the cross-repo golden", () => {
    expect(canonicalizeReceipt(valid, spec)).toBe(golden);
    expect(canonicalizeReceipt(Object.fromEntries(Object.entries(valid).reverse()), spec)).toBe(golden);
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
    const body = golden.slice(spec.domain_separator.length);
    const withoutStrings = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const numbers = withoutStrings.match(/-?\d[\d.eE+-]*/g) ?? [];
    expect(numbers.length).toBeGreaterThan(0);
    for (const literal of numbers) expect(literal).toMatch(/^(0|-?[1-9]\d*)$/);
  });

  test("weights is the last v1 field and omission preserves the old byte shape", () => {
    expect(spec.field_order.at(-1)).toBe("weights");
    expect(spec.optional_append_only_fields).toEqual(["weights"]);
    const withoutWeights = canonicalizeReceipt(validNoWeights, spec);
    expect(withoutWeights).not.toContain('"weights":');
    expect(withoutWeights.startsWith(spec.domain_separator)).toBe(true);
    // A judged-but-unweighted receipt is legal, and it is still a full receipt.
    expect(validNoWeights.judge.release_safety.release).toBe("hold");
    expect(validate(validNoWeights, schema, schema)).toEqual([]);
    expect(semanticErrors(validNoWeights, spec)).toEqual([]);
  });

  // ── the judge block, reconciled against the shipped judge ─────────────────

  test("the judge block is exactly JudgeOpinion — no invented consensus field", () => {
    // backend/src/swarm/judge.ts: `JudgeOpinion { rationale, disagreements,
    // release_safety }`. The 1.0 draft also carried `judge.consensus`, which no
    // judge produces; its only producer is buildConsensus() in
    // backend/src/swarm/domain.ts, and that restates quorum/stances in English.
    expect(schema.properties.judge.required).toEqual(["rationale", "disagreements", "release_safety"]);
    expect(Object.keys(schema.properties.judge.properties)).toEqual(["rationale", "disagreements", "release_safety"]);
    expect(schema.properties.judge.additionalProperties).toBe(false);
    for (const receipt of [valid, validNoWeights]) {
      expect(Object.keys(receipt.judge)).toEqual(["rationale", "disagreements", "release_safety"]);
    }
    expect(spec.nested_field_order.judge).toEqual(["rationale", "disagreements", "release_safety"]);
    expect(golden).not.toContain('"consensus"');
  });

  test("release_safety carries the shipped shape whole, so a verifier recomputes rather than trusts", () => {
    const rs = schema.properties.judge.properties.release_safety;
    expect(rs.required).toEqual(["release", "thinly_supported", "take_count", "min_takes", "concerns"]);
    expect(rs.properties.release.enum).toEqual(["safe", "hold"]);
    // The two fields that make the flags checkable rather than assertable.
    expect(rs.properties.take_count.type).toBe("integer");
    expect(rs.properties.min_takes.minimum).toBe(1);
    // And they really are enough: recompute both flags on the good fixtures.
    for (const receipt of [valid, validNoWeights]) {
      const r = receipt.judge.release_safety;
      expect(r.thinly_supported).toBe(r.take_count < r.min_takes);
      expect(r.release).toBe(r.thinly_supported || r.concerns.length > 0 ? "hold" : "safe");
      expect(r.take_count).toBe(receipt.quorum.submitted);
    }
  });

  // ── validation ────────────────────────────────────────────────────────────

  test("the valid fixtures pass schema and semantic validation", () => {
    expect(validate(valid, schema, schema)).toEqual([]);
    expect(validate(validNoWeights, schema, schema)).toEqual([]);
    expect(semanticErrors(valid, spec)).toEqual([]);
  });

  test("the invalid fixture is rejected, with each reason named", () => {
    const schemaErrors = validate(invalid, schema, schema);
    expect(schemaErrors).toContain("/session_id: pattern");
    expect(schemaErrors).toContain("/prompt_hash: pattern");
    expect(schemaErrors).toContain("/quorum/participation_bps: maximum 10000");
    expect(schemaErrors).toContain("/judge/rationale: minLength 1");
    expect(schemaErrors).toContain('/judge/release_safety/release: must be one of ["safe","hold"]');
    expect(schemaErrors).toContain("/analyst_signatures: minItems 1");

    const semantic = semanticErrors(invalid, spec);
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
    expect(() => validate({}, { oneOf: [] }, {})).toThrow(/unsupported schema keyword "oneOf"/);
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
    expect(schema.required).not.toContain("weights");
    expect(schema.properties.weights.minItems).toBe(4);
    expect(schema.properties.weights.maxItems).toBe(4);
  });

  test("the golden's embedded analyst signatures verify over exact canonicalSubmission bytes", async () => {
    for (const signature of [...valid.analyst_signatures, ...validNoWeights.analyst_signatures]) {
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
    for (const receipt of [valid, validNoWeights, invalid]) expect(receipt.schema_version).toBe("1.0");
    // The draft shipped an unasserted keccak256 constant that the judge
    // reconciliation silently invalidated. This repo pins bytes, not digests.
    expect(spec.valid_fixture_digest).toBeUndefined();
    expect(spec.digest_algorithm).toBe("keccak256");
  });
});
