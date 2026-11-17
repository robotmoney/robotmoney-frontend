import { describe, expect, test } from "bun:test";
import type { ImageReceipt } from "../../lib/website-release.ts";
import { streamSwapProblems } from "../../release/version-checks/v0.9.1/_swap.ts";

const stop = Date.parse("2026-11-17T01:00:00Z");
const receipt: ImageReceipt = {
  schema: 2, mode: "image", instance: "stage", host: "stage", action: "deploy", outcome: "swapped",
  release: null, apiVersion: null, oldContainer: null, newContainer: null, publicPort: 8080, copyPort: 8081,
  checks: ["docker-version", "cold-start", "copy", "gap", "public", "live"].map((name) => ({ name, ok: true, detail: "ok" })),
  gap: { startedAt: new Date(stop).toISOString(), endedAt: new Date(stop + 1000).toISOString(), ms: 1000 },
  revertGap: null, precheck: { coldStartMs: 500, retireBoundMs: 1000, gapLimitMs: 3000 }, dockerVersion: "29.1.3",
  currentImage: null, previousImage: null, error: null, startedAt: new Date(stop - 10000).toISOString(), finishedAt: new Date(stop + 1000).toISOString(),
};
const segments = [{ openedAt: stop - 1000, closedAt: stop + 500 }, { openedAt: stop + 6000, closedAt: null }];

describe("v0.9.1 stream rehearsal grading", () => {
  test("accepts a held stream, bounded gap and timely reconnect", () => {
    expect(streamSwapProblems(receipt, { segments, failures: [] }, "deploy").problems).toEqual([]);
  });
  test("rejects a stream that was not held, outlived the bound or failed to reconnect", () => {
    for (const broken of [
      [{ openedAt: stop + 10, closedAt: null }],
      [{ openedAt: stop - 1000, closedAt: stop + 2100 }, segments[1]!],
      [{ openedAt: stop - 1000, closedAt: stop + 500 }],
      [segments[0]!, { openedAt: stop + 10001, closedAt: null }],
    ]) expect(streamSwapProblems(receipt, { segments: broken, failures: [] }, "deploy").problems.length).toBeGreaterThan(0);
  });
  test("rejects failures outside the gap, a missed precheck and an excessive gap", () => {
    expect(streamSwapProblems(receipt, { segments, failures: [{ at: stop - 1, what: "unavailable" }] }, "deploy").problems.length).toBeGreaterThan(0);
    expect(streamSwapProblems({ ...receipt, precheck: null }, { segments, failures: [] }, "deploy").problems.length).toBeGreaterThan(0);
    expect(streamSwapProblems({ ...receipt, gap: { ...receipt.gap!, ms: 3001 } }, { segments, failures: [] }, "deploy").problems.length).toBeGreaterThan(0);
  });
});
