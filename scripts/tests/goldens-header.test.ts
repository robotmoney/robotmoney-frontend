// Honesty guard for the scripts/update-goldens.ts header (review finding 033).
// The header used to claim "a CI drift gate blocks a PR whose goldens no longer
// match the code" — no such gate exists. The drift gate is SPECIFIED in
// docs/preview-server-spec.md §5 but not yet wired into CI, so goldens
// freshness is entirely the changing agent's responsibility; a comment telling
// readers the gap is closed actively invites stale goldens (the Playwright
// suite stubs routes FROM the goldens, so it keeps passing against an old
// shape). This test fails if the false claim ever reappears, and pins the
// corrected specified-but-unwired wording.
//
// Runs in the required integration.yml root job via `bun test scripts/tests`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const header = readFileSync(
  join(import.meta.dir, "../update-goldens.ts"),
  "utf8",
);

describe("scripts/update-goldens.ts header is honest about the goldens drift gate", () => {
  test("no longer claims an active CI drift gate blocks a PR", () => {
    // The old false claim, in any spacing/wrapping.
    expect(header.replace(/\n\/\/ ?/g, " ")).not.toMatch(/drift\s+gate\s+blocks\s+a\s+PR/i);
  });

  test("states the gate is specified in the preview-server spec but NOT yet wired into CI", () => {
    const flat = header.replace(/\n\/\/ ?/g, " ");
    expect(flat).toContain(
      "a CI drift gate is specified in docs/preview-server-spec.md but NOT yet wired into CI",
    );
    // And the responsibility that follows from the gap stays spelled out.
    expect(flat).toContain("responsibility");
  });
});
