import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "../../src/__fixtures__");

function readJson(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

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
    judge: {
      rationale: receipt.judge.rationale,
      consensus: receipt.judge.consensus,
      disagreements: receipt.judge.disagreements.map((item: any) => ({
        topic: item.topic,
        positions: item.positions.map((position: any) => ({
          member_id: position.member_id,
          view: position.view,
        })),
        what_settles: item.what_settles,
      })),
      release_safety: {
        safe_to_release: receipt.judge.release_safety.safe_to_release,
        opinion: receipt.judge.release_safety.opinion,
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
  const mapping = readJson("consensus-receipt.bucket-vault-map.json");
  const schema = readJson("consensus-receipt.schema.json");

  test("fixed-order JavaScript bytes match the cross-repo golden", () => {
    const golden = readFileSync(join(FIXTURES, "consensus-receipt.valid.canonical.txt"), "utf8");
    expect(canonicalizeReceipt(valid, spec)).toBe(golden);
    expect(canonicalizeReceipt(Object.fromEntries(Object.entries(valid).reverse()), spec)).toBe(golden);
  });

  test("weights is the last v1 field and omission preserves the old byte shape", () => {
    expect(spec.field_order.at(-1)).toBe("weights");
    expect(spec.optional_append_only_fields).toEqual(["weights"]);
    const withoutWeights = canonicalizeReceipt(validNoWeights, spec);
    expect(withoutWeights).not.toContain('"weights":');
  });

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
});
