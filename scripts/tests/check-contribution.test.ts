// Unit coverage for the pure helpers of the contribution governance gate
// (scripts/check-contribution.ts). These assert the owner-parsing and
// creation-allowlist logic directly, with no git/network — genuine executed
// coverage under the test-coverage policy.
import { expect, test } from "bun:test";
import { isAllowedCreation, isGovernedDoc, parseOwners } from "../check-contribution";

test("parseOwners harvests @logins from path rules only, lowercased, skipping comments", () => {
  const sample = [
    "# CODEOWNERS — governs who may create files.",
    "# comment @notanowner should be ignored",
    "/docs/ @LextotheX @cmatthewbell",
    "/contract/ @lucky-tensor",
  ].join("\n");

  const owners = parseOwners(sample);

  expect(owners.has("lextotheX".toLowerCase())).toBe(true);
  expect(owners.has("cmatthewbell")).toBe(true);
  expect(owners.has("lucky-tensor")).toBe(true);
  expect(owners.has("notanowner")).toBe(false);
});

test("isAllowedCreation allows test files and tests/ segments, rejects everything else", () => {
  // allowed
  expect(isAllowedCreation("scripts/tests/foo.test.ts")).toBe(true);
  expect(isAllowedCreation("backend/queue/x.test.ts")).toBe(true);
  expect(isAllowedCreation("frontend/test/browser/a.spec.ts")).toBe(true);
  expect(isAllowedCreation("mcp/tests/b.ts")).toBe(true);

  // rejected
  expect(isAllowedCreation("docs/foo.md")).toBe(false);
  expect(isAllowedCreation("newthing.md")).toBe(false);
  expect(isAllowedCreation("frontend/public/views/x.html")).toBe(false);
  expect(isAllowedCreation("scripts/foo.ts")).toBe(false);
});

test("isGovernedDoc: docs markdown yes, code-review and non-docs no", () => {
  expect(isGovernedDoc("docs/architecture.md")).toBe(true);
  expect(isGovernedDoc("docs/nested/plan.md")).toBe(true);
  expect(isGovernedDoc("docs/code-review/20260714-x.md")).toBe(false);
  expect(isGovernedDoc("README.md")).toBe(false);
  expect(isGovernedDoc("docs/notes.txt")).toBe(false);
});
