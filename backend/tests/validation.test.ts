import { expect, test } from "bun:test";
import { parseApply, parseSigningDraft, parseSubmission, validateSigningDraft, validateSubmission } from "../src/api/validation.ts";

test("committee request parsers reject malformed and out-of-range input", () => {
  // §11 R2/R6: apply carries no client memberId; a signature is mandatory.
  expect(parseApply({ name: "A", contact: "a@example.test", publicKey: "key" })).toBeNull(); // missing signature
  expect(parseApply({ name: "A", publicKey: "key", signature: "sig" })).toBeNull(); // missing contact
  expect(parseSubmission({
    memberId: "a",
    date: "not-a-date",
    subjectId: "s",
    nonce: "n",
    stance: "neutral",
    confidence: 0.5,
    signature: "sig",
  })).toBeNull();
  expect(parseSubmission({
    memberId: "a",
    date: "2026-07-01",
    subjectId: "s",
    nonce: "n",
    stance: "neutral",
    confidence: 2,
    signature: "sig",
  })).toBeNull();
});

test("signing drafts and submissions share normalized fields", () => {
  const draft = {
    memberId: " athena ",
    date: "2026-07-01",
    subjectId: "woon",
    nonce: "nonce",
    stance: "constructive",
    confidence: 0.75,
    body: " analysis ",
    weights: [{ bucket: " agents ", weight: 1 }, { bucket: "cash", weight: 3 }],
  };
  expect(parseSigningDraft(draft)?.memberId).toBe("athena");
  expect(parseSigningDraft(draft)?.weights).toEqual([{ bucket: "agents", weight: 1 }, { bucket: "cash", weight: 3 }]);
  expect(parseSubmission({ ...draft, signature: "signature" })?.body).toBe("analysis");
});

test("weight validation requires distinct buckets, non-negative finite values, and a positive total", () => {
  const draft = {
    memberId: "athena", date: "2026-07-01", subjectId: "woon", nonce: "nonce",
    stance: "constructive", confidence: 0.75,
  };
  expect(parseSigningDraft({ ...draft, weights: [{ bucket: "cash", weight: -1 }] })).toBeNull();
  expect(parseSigningDraft({ ...draft, weights: [{ bucket: "cash", weight: 0 }] })).toBeNull();
  expect(parseSigningDraft({ ...draft, weights: [{ bucket: "cash", weight: 1 }, { bucket: "cash", weight: 2 }] })).toBeNull();
});

test("strict stance string validation accepts valid vocabulary and rejects unknown stances", () => {
  const validDraft = {
    memberId: "cygnus", date: "2026-09-25", subjectId: "woon", nonce: "n1",
    stance: "bullish", confidence: 0.7,
  };
  const validStances = ["bearish", "cautious", "neutral", "constructive", "bullish"];
  for (const stance of validStances) {
    expect(parseSigningDraft({ ...validDraft, stance })).not.toBeNull();
  }

  const invalidRes = validateSigningDraft({ ...validDraft, stance: "wildly-bullish" });
  expect(invalidRes.ok).toBe(false);
  if (!invalidRes.ok) {
    expect(invalidRes.error).toBe("stance must be one of bearish, cautious, neutral, constructive, bullish");
  }

  const invalidSub = validateSubmission({ ...validDraft, signature: "sig", stance: "<script>alert(1)</script>" });
  expect(invalidSub.ok).toBe(false);
  if (!invalidSub.ok) {
    expect(invalidSub.error).toBe("stance must be one of bearish, cautious, neutral, constructive, bullish");
  }
});

test("unknown top-level fields are rejected with clear error message", () => {
  const draft = {
    memberId: "cygnus", date: "2026-09-25", subjectId: "woon", nonce: "n1",
    summary: "my analysis", stance: "bullish", confidence: 0.7,
  };
  const draftRes = validateSigningDraft(draft);
  expect(draftRes.ok).toBe(false);
  if (!draftRes.ok) {
    expect(draftRes.error).toBe("unknown field: summary");
  }

  const subRes = validateSubmission({ ...draft, signature: "sig" });
  expect(subRes.ok).toBe(false);
  if (!subRes.ok) {
    expect(subRes.error).toBe("unknown field: summary");
  }
});

