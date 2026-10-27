// The release check's field list equals the backend's (issue 1484). scripts/release/replay-row.ts
// compares the SDK's as-of row to the published one field by field; backend/tests/support/published-replay.ts
// does the same in CI. A field one side adds or drops would make the two comparisons disagree.
import { expect, test } from "bun:test";
import { COMPARED_FIELDS as releaseFields, canonicalStringify as releaseCanonical } from "../../release/replay-row.ts";
import { COMPARED_FIELDS as backendFields } from "../../../backend/tests/support/published-replay.ts";
import { canonicalStringify as backendCanonical } from "../../../backend/src/analytics/run-ledger.ts";

test("the compared field lists are equal, in the same order", () => {
  expect([...releaseFields]).toEqual([...backendFields]);
  expect(releaseFields.length).toBeGreaterThan(0);
});

test("red control: a list with a field added or dropped is not equal", () => {
  expect([...releaseFields, "extra"]).not.toEqual([...backendFields]);
  expect(releaseFields.slice(1)).not.toEqual([...backendFields]);
});

test("canonical stringify writes the same bytes as the backend's for the same value", () => {
  const value = { b: [3, { z: 1, a: null }], a: "x", n: 1.5, t: true, nested: { y: [], x: {} } };
  expect(releaseCanonical(value)).toBe(backendCanonical(value));
  expect(releaseCanonical({ b: 1, a: 2 })).toBe(releaseCanonical({ a: 2, b: 1 }));
});
