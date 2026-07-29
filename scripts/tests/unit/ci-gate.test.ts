import { describe, expect, test } from "bun:test";
import { evaluateGate, type GateInput } from "../../checks/ci-gate.ts";

const pass = (overrides: Partial<GateInput> = {}): GateInput => ({
  changed: { scripts: true }, docsOnly: false, draft: false,
  outcomes: { unit: "success", "repo-guards": "success", integration: "success", e2e: "success" }, ...overrides,
});

describe("ci gate", () => {
  test("passes when every needed assurance succeeds", () => expect(evaluateGate(pass())).toEqual([]));
  test("rejects failed and cancelled needed jobs", () => {
    expect(evaluateGate(pass({ outcomes: { unit: "failure", "repo-guards": "success", integration: "success", e2e: "success" } }))).not.toEqual([]);
    expect(evaluateGate(pass({ outcomes: { unit: "success", "repo-guards": "cancelled", integration: "success", e2e: "success" } }))).not.toEqual([]);
  });
  test("permits docs-only and draft-deferred system correctness", () => {
    expect(evaluateGate(pass({ changed: {}, docsOnly: true, outcomes: { "repo-guards": "success" } }))).toEqual([]);
    expect(evaluateGate(pass({ draft: true, outcomes: { unit: "success", "repo-guards": "success" } }))).toEqual([]);
  });
  test("rejects matching-domain skips and code changes without tests", () => {
    expect(evaluateGate(pass({ outcomes: { unit: "success", "repo-guards": "success", integration: "skipped", e2e: "success" } }))).not.toEqual([]);
    expect(evaluateGate(pass({ outcomes: { unit: "skipped", "repo-guards": "success", integration: "skipped", e2e: "skipped" } }))).toContain("invariant-2: code changed but no test-executing job ran");
  });
});
