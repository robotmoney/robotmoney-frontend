import { describe, expect, test } from "bun:test";
import { evaluateGate, type GateInput, type Domain } from "../../checks/ci-gate.ts";

/** A passing fixture: scripts changed, all needed domains succeed. */
const pass = (overrides: Partial<GateInput> = {}): GateInput => ({
  changed: { scripts: true },
  docsOnly: false,
  draft: false,
  outcomes: {
    unit: "success",
    "repo-guards": "success",
    integration: "success",
    e2e: "success",
  },
  ...overrides,
});

/** A full-scope passing fixture: every domain changed and succeeds. */
const fullPass = (overrides: Partial<GateInput> = {}): GateInput => ({
  changed: { backend: true, contract: true, frontend: true, scripts: true },
  docsOnly: false,
  draft: false,
  outcomes: {
    unit: "success",
    "repo-guards": "success",
    backend: "success",
    integration: "success",
    contract: "success",
    frontend: "success",
    e2e: "success",
  },
  ...overrides,
});

describe("ci gate", () => {
  // ── positive: all-needed-success passes ──────────────────────────────────
  test("passes when every needed assurance succeeds (scripts-only change)", () =>
    expect(evaluateGate(pass())).toEqual([]));

  test("passes when every needed assurance succeeds (full-scope change)", () =>
    expect(evaluateGate(fullPass())).toEqual([]));

  // ── negative: failed or cancelled needed jobs ────────────────────────────
  test("rejects a failed needed job", () => {
    expect(
      evaluateGate(
        pass({
          outcomes: {
            unit: "failure",
            "repo-guards": "success",
            integration: "success",
            e2e: "success",
          },
        }),
      ),
    ).not.toEqual([]);
  });

  test("rejects a cancelled needed job", () => {
    expect(
      evaluateGate(
        pass({
          outcomes: {
            unit: "success",
            "repo-guards": "cancelled",
            integration: "success",
            e2e: "success",
          },
        }),
      ),
    ).not.toEqual([]);
  });

  // ── docs-only: only repo-guards needed ───────────────────────────────────
  test("docs-only PR passes with only repo-guards succeeding", () =>
    expect(
      evaluateGate(
        pass({
          changed: {},
          docsOnly: true,
          outcomes: { "repo-guards": "success" },
        }),
      ),
    ).toEqual([]));

  // ── draft-deferred system correctness ────────────────────────────────────
  test("draft PR passes with unit + repo-guards only (system-correctness deferred)", () =>
    expect(
      evaluateGate(
        pass({
          draft: true,
          outcomes: { unit: "success", "repo-guards": "success" },
        }),
      ),
    ).toEqual([]));

  test("ready PR with scripts changed FAILS when system-correctness domains are missing", () => {
    const errors = evaluateGate(
      pass({
        draft: false,
        outcomes: { unit: "success", "repo-guards": "success" },
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  // ── path-skip with matching changed files (invariant 4 per domain) ──────
  test("rejects backend path-skip when backend files changed", () => {
    expect(
      evaluateGate(
        fullPass({
          outcomes: {
            unit: "success",
            "repo-guards": "success",
            backend: "skipped",
            integration: "success",
            contract: "success",
            frontend: "success",
            e2e: "success",
          },
        }),
      ),
    ).not.toEqual([]);
  });

  test("rejects contract path-skip when contract files changed", () => {
    expect(
      evaluateGate(
        fullPass({
          outcomes: {
            unit: "success",
            "repo-guards": "success",
            backend: "success",
            integration: "success",
            contract: "skipped",
            frontend: "success",
            e2e: "success",
          },
        }),
      ),
    ).not.toEqual([]);
  });

  test("rejects frontend path-skip when frontend files changed", () => {
    expect(
      evaluateGate(
        fullPass({
          outcomes: {
            unit: "success",
            "repo-guards": "success",
            backend: "success",
            integration: "success",
            contract: "success",
            frontend: "skipped",
            e2e: "success",
          },
        }),
      ),
    ).not.toEqual([]);
  });

  test("rejects integration (scripts) path-skip when scripts files changed", () => {
    expect(
      evaluateGate(
        pass({
          outcomes: {
            unit: "success",
            "repo-guards": "success",
            integration: "skipped",
            e2e: "success",
          },
        }),
      ),
    ).not.toEqual([]);
  });

  test("rejects e2e path-skip when e2e-relevant files changed", () => {
    expect(
      evaluateGate(
        pass({
          outcomes: {
            unit: "success",
            "repo-guards": "success",
            integration: "success",
            e2e: "skipped",
          },
        }),
      ),
    ).not.toEqual([]);
  });

  // ── path-skip with NO matching changed files passes ──────────────────────
  test("permits backend skip when no backend files changed", () =>
    expect(
      evaluateGate(
        pass({
          changed: { scripts: true },
          outcomes: {
            unit: "success",
            "repo-guards": "success",
            integration: "success",
            e2e: "success",
            backend: "skipped",
          },
        }),
      ),
    ).toEqual([]));

  // ── invariant 2: code change with zero test-executing jobs ───────────────
  test("rejects code change with zero test-executing jobs (invariant 2)", () => {
    const errors = evaluateGate(
      pass({
        outcomes: {
          unit: "skipped",
          "repo-guards": "success",
          integration: "skipped",
          e2e: "skipped",
        },
      }),
    );
    expect(errors).toContain(
      "invariant-2: code changed but no test-executing job ran",
    );
  });

  test("does not fire invariant-2 on docs-only (no code changed)", () =>
    expect(
      evaluateGate(
        pass({
          changed: {},
          docsOnly: true,
          outcomes: { "repo-guards": "success" },
        }),
      ),
    ).toEqual([]));
});
