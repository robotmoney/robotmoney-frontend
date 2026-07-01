import { expect, test } from "bun:test";
import { parseApply, parseSigningDraft, parseSubmission } from "../src/api/validation.ts";

test("committee request parsers reject malformed and out-of-range input", () => {
  expect(parseApply({ memberId: "", name: "A", publicKey: "key" })).toBeNull();
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
  };
  expect(parseSigningDraft(draft)?.memberId).toBe("athena");
  expect(parseSubmission({ ...draft, signature: "signature" })?.body).toBe("analysis");
});
