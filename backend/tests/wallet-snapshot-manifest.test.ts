import { expect, test } from "bun:test";
import {
  canonicalJsonString,
  resolveAumProducerRevision,
  validateExactSet,
} from "../src/ops/wallet-snapshot-manifest.ts";


test("canonical JSON recursively sorts object keys", () => {
  expect(canonicalJsonString({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
});

test("canonical JSON refuses values JSON.stringify would silently corrupt", () => {
  expect(() => canonicalJsonString({ price: Number.NaN })).toThrow(/non-finite/);
  expect(() => canonicalJsonString({ missing: undefined })).toThrow(/undefined/);
  const sparse = new Array(1);
  expect(() => canonicalJsonString(sparse)).toThrow(/sparse array/);
  expect(() => canonicalJsonString({ [Symbol("hidden")]: "lost" })).toThrow(/symbol-keyed/);
});

test("exact-set validation reports missing, unexpected, and duplicate keys", () => {
  expect(validateExactSet(["USDC", "WETH"], ["USDC", "USDC", "BNKR"])).toEqual({
    expected: ["USDC", "WETH"],
    present: ["BNKR", "USDC"],
    missing: ["WETH"],
    unexpected: ["BNKR"],
    duplicateExpected: [],
    duplicatePresent: ["USDC"],
    exact: false,
  });
});

test("producer revision is explicit and absence stays unavailable", () => {
  expect(resolveAumProducerRevision({ AUM_PRODUCER_REVISION: "  abc123  " })).toEqual({
    status: "available",
    revision: "abc123",
    unavailableReason: null,
  });
  expect(resolveAumProducerRevision({})).toEqual({
    status: "unavailable",
    revision: null,
    unavailableReason: "AUM_PRODUCER_REVISION is unset or blank",
  });
});
