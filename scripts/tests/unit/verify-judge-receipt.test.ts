// The one field that separates a judged certificate from a dressed-up template.
import { describe, expect, test } from "bun:test";
import { receiptVerdict } from "../../lib/verify/legs/judge-receipt.ts";

describe("receiptVerdict", () => {
  test("a model-authored, adopted judgement is the pass", () => {
    // `mode` is the key a REAL published receipt carries.
    expect(receiptVerdict({ judge: { source: "model", mode: "enforce" } }))
      .toEqual({ ok: true, why: "judge.source='model', judge_mode='enforce'" });
    // …and the interface's spelling is accepted too.
    expect(receiptVerdict({ judge: { source: "model", judge_mode: "enforce" } }).ok).toBe(true);
  });

  test("TEMPLATE PROSE fails, and says what to check", () => {
    // The state this whole leg exists to catch: everything renders, signs and
    // publishes identically — only `source` differs.
    const v = receiptVerdict({ judge: { source: "fallback", mode: "enforce" } });
    expect(v.ok).toBe(false);
    expect(v.why).toContain("TEMPLATE PROSE");
    expect(v.why).toContain("OPENCODE_API_KEY");
  });

  test("a shadow judgement is not an adopted one", () => {
    const v = receiptVerdict({ judge: { source: "model", mode: "shadow" } });
    expect(v.ok).toBe(false);
    expect(v.why).toContain("shadow");
  });

  test("a receipt with no judge block is not a judged receipt", () => {
    expect(receiptVerdict({}).ok).toBe(false);
    expect(receiptVerdict({ judge: {} }).ok).toBe(false);
  });

  test("a model judgement with no mode recorded still passes on source", () => {
    expect(receiptVerdict({ judge: { source: "model" } }).ok).toBe(true);
  });
});

describe("receiptVerdict reads the SERVED envelope, not just a bare receipt", () => {
  // GET /api/swarm/sessions/:id/consensus-receipt returns
  // { sessionId, subjectId, schemaVersion, publishedAt, receipt, canonicalBytes,
  //   verified, signatures, unverifiedReasons } — verified against the live route.
  const served = (over: Record<string, unknown> = {}) => ({
    sessionId: "s1", schemaVersion: "1.0", verified: true,
    receipt: { judge: { source: "model", mode: "enforce" } },
    ...over,
  });

  test("the real envelope passes, and says the signature verified", () => {
    const v = receiptVerdict(served());
    expect(v.ok).toBe(true);
    expect(v.why).toContain("signature verified");
  });

  test("template prose inside the envelope still fails", () => {
    expect(receiptVerdict(served({ receipt: { judge: { source: "fallback", mode: "enforce" } } })).ok).toBe(false);
  });

  test("a certificate that does not verify is not one", () => {
    const v = receiptVerdict(served({ verified: false }));
    expect(v.ok).toBe(false);
    expect(v.why).toContain("verified=false");
  });
});
