// The one field that separates a judged certificate from a dressed-up template,
// read off the VERIFIED envelope (M4/X7: the bare /consensus-receipt route
// serves the anchored bytes and carries no verdict).
import { describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { receiptVerdict } from "../../lib/verify/legs/judge-receipt.ts";

// GET /api/swarm/sessions/:id/consensus-receipt/verified returns
// { sessionId, subjectId, schemaVersion, publishedAt, receipt, canonicalBytes,
//   verified, signatures, unverifiedReasons }.
const served = (over: Record<string, unknown> = {}, judge: Record<string, unknown> = { source: "model", mode: "enforce" }) => ({
  sessionId: "s1", schemaVersion: "1.0", verified: true,
  receipt: { judge },
  ...over,
});

describe("receiptVerdict", () => {
  test("a model-authored, adopted, verified judgement is the pass", () => {
    // `mode` is the key a REAL published receipt carries.
    expect(receiptVerdict(served()))
      .toEqual({ ok: true, why: "judge.source='model', judge_mode='enforce', signature verified" });
    // …and the interface's spelling is accepted too.
    expect(receiptVerdict(served({}, { source: "model", judge_mode: "enforce" })).ok).toBe(true);
  });

  test("TEMPLATE PROSE fails, and says what to check", () => {
    const v = receiptVerdict(served({}, { source: "fallback", mode: "enforce" }));
    expect(v.ok).toBe(false);
    expect(v.why).toContain("TEMPLATE PROSE");
    expect(v.why).toContain("OPENCODE_API_KEY");
  });

  test("a shadow judgement is not an adopted one", () => {
    const v = receiptVerdict(served({}, { source: "model", mode: "shadow" }));
    expect(v.ok).toBe(false);
    expect(v.why).toContain("shadow");
  });

  test("a receipt with no judge block is not a judged receipt", () => {
    expect(receiptVerdict(served({ receipt: {} })).ok).toBe(false);
    expect(receiptVerdict(served({}, {})).ok).toBe(false);
  });

  test("a model judgement with no mode recorded still passes on source", () => {
    expect(receiptVerdict(served({}, { source: "model" })).ok).toBe(true);
  });
});

describe("the verdict is the route's, and its absence FAILS", () => {
  test("a certificate that does not verify is not one", () => {
    const v = receiptVerdict(served({ verified: false }));
    expect(v.ok).toBe(false);
    expect(v.why).toContain("verified=false");
  });

  test("an envelope with NO `verified` field fails instead of silently passing", () => {
    const { verified: _omit, ...noVerdict } = served();
    const v = receiptVerdict(noVerdict);
    expect(v.ok).toBe(false);
    expect(v.why).toContain("without a `verified` verdict");
  });

  test("a BARE receipt (the anchored /consensus-receipt shape) fails and names the route to read", () => {
    const bare = { schema_version: "1.0", judge: { source: "model", mode: "enforce" } };
    const v = receiptVerdict(bare as never);
    expect(v.ok).toBe(false);
    expect(v.why).toContain("/consensus-receipt/verified");
  });

  test("the leg requests the verified route, not the bare one", () => {
    expect(ROUTES.swarm.sessionConsensusReceiptVerified).toBe("/api/swarm/sessions/:id/consensus-receipt/verified");
    const src = readFileSync(join(import.meta.dir, "../../lib/verify/legs/judge-receipt.ts"), "utf8");
    expect(src).toContain("ROUTES.swarm.sessionConsensusReceiptVerified");
    expect(src).not.toMatch(/ROUTES\.swarm\.sessionConsensusReceipt\b(?!Verified)/);
  });
});
