// Unit coverage for the pure helpers of the contribution governance gate
// (scripts/check-contribution.ts). These assert the permission-dictionary logic
// directly, with no git/network — genuine executed coverage under the
// test-coverage policy.
import { expect, test } from "bun:test";
import {
  effectiveGlobs,
  isGovernedDoc,
  isPermitted,
  parsePolicy,
  type Policy,
} from "../check-contribution";

const SAMPLE = JSON.stringify({
  "//": "a documentation comment key that must be ignored",
  users: {
    "lucky-tensor": { all: ["**"] },
    "lextothex": { all: ["**"] },
    "cmatthewbell": { all: ["**"] },
    "//note": { all: ["**"] },
    "*": { create: [], edit: [], delete: [] },
  },
});

test("parsePolicy ignores // keys and tolerates empty/invalid input", () => {
  const policy = parsePolicy(SAMPLE);
  expect(Object.keys(policy.users).sort()).toEqual(["*", "cmatthewbell", "lextothex", "lucky-tensor"]);
  expect(policy.users["//note"]).toBeUndefined();

  // Empty / whitespace / invalid JSON / missing users -> empty users map.
  expect(parsePolicy("").users).toEqual({});
  expect(parsePolicy("   ").users).toEqual({});
  expect(parsePolicy("{not json").users).toEqual({});
  expect(parsePolicy("{}").users).toEqual({});
  expect(parsePolicy(JSON.stringify({ users: null })).users).toEqual({});
});

test("admin with all:[**] is permitted every op on nested and top-level paths", () => {
  const policy = parsePolicy(SAMPLE);
  for (const user of ["lucky-tensor", "lextothex", "cmatthewbell"]) {
    for (const op of ["create", "edit", "delete"] as const) {
      expect(isPermitted(policy, user, op, "a/b/c/deep.ts")).toBe(true);
      expect(isPermitted(policy, user, op, "toplevel.md")).toBe(true);
      expect(isPermitted(policy, user, op, "docs/architecture.md")).toBe(true);
    }
  }
});

test("admin match is case-insensitive on the login", () => {
  const policy = parsePolicy(SAMPLE);
  expect(isPermitted(policy, "LextotheX", "create", "anything.ts")).toBe(true);
  expect(isPermitted(policy, "Lucky-Tensor", "delete", "contract/x.ts")).toBe(true);
});

test("unlisted author with empty * is blocked for every op", () => {
  const policy = parsePolicy(SAMPLE);
  for (const op of ["create", "edit", "delete"] as const) {
    expect(isPermitted(policy, "randomperson", op, "frontend/x.ts")).toBe(false);
    expect(isPermitted(policy, "randomperson", op, "a/b.test.ts")).toBe(false);
    expect(isPermitted(policy, "randomperson", op, "toplevel.md")).toBe(false);
  }
});

test("* baseline is unioned into everyone (edit docs but not create)", () => {
  const policy = parsePolicy(
    JSON.stringify({
      users: {
        "lucky-tensor": { all: ["**"] },
        "*": { edit: ["docs/**"] },
      },
    }),
  );
  // An unlisted author inherits the * baseline.
  expect(isPermitted(policy, "casual", "edit", "docs/x.md")).toBe(true);
  expect(isPermitted(policy, "casual", "edit", "docs/a/b.md")).toBe(true);
  // ...but only edit was granted, not create.
  expect(isPermitted(policy, "casual", "create", "docs/x.md")).toBe(false);
  // ...and only under docs/.
  expect(isPermitted(policy, "casual", "edit", "src/x.ts")).toBe(false);
});

test("per-op granularity: create test files only, no edits elsewhere", () => {
  const policy = parsePolicy(
    JSON.stringify({
      users: {
        tester: { create: ["**/*.test.ts", "*.test.ts"] },
      },
    }),
  );
  // May create test files at any depth (incl. top-level).
  expect(isPermitted(policy, "tester", "create", "a/b.test.ts")).toBe(true);
  expect(isPermitted(policy, "tester", "create", "x.test.ts")).toBe(true);
  // May NOT create or edit non-test source.
  expect(isPermitted(policy, "tester", "create", "src/app.ts")).toBe(false);
  expect(isPermitted(policy, "tester", "edit", "src/app.ts")).toBe(false);
  // May NOT edit even the test files (create grant does not imply edit).
  expect(isPermitted(policy, "tester", "edit", "a/b.test.ts")).toBe(false);
  expect(isPermitted(policy, "tester", "delete", "a/b.test.ts")).toBe(false);
});

test("effectiveGlobs unions specific[op], specific.all, *[op], *.all", () => {
  const policy: Policy = parsePolicy(
    JSON.stringify({
      users: {
        alice: { create: ["src/**"], all: ["shared/**"] },
        "*": { create: ["public/**"], all: ["common/**"] },
      },
    }),
  );
  expect(effectiveGlobs(policy, "alice", "create").sort()).toEqual(
    ["common/**", "public/**", "shared/**", "src/**"].sort(),
  );
  // For an op with no specific grant, only specific.all + baseline apply.
  expect(effectiveGlobs(policy, "alice", "delete").sort()).toEqual(
    ["common/**", "shared/**"].sort(),
  );
  // Unlisted user gets only the baseline.
  expect(effectiveGlobs(policy, "nobody", "create").sort()).toEqual(
    ["common/**", "public/**"].sort(),
  );
  expect(effectiveGlobs(policy, "nobody", "edit")).toEqual(["common/**"]);
});

test("isGovernedDoc: docs markdown yes, code-review and non-docs no", () => {
  expect(isGovernedDoc("docs/architecture.md")).toBe(true);
  expect(isGovernedDoc("docs/nested/plan.md")).toBe(true);
  expect(isGovernedDoc("docs/code-review/20260714-x.md")).toBe(false);
  expect(isGovernedDoc("README.md")).toBe(false);
  expect(isGovernedDoc("docs/notes.txt")).toBe(false);
});
