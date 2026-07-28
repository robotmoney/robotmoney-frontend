// Honesty guard for the scripts/update-goldens.ts header.
// After the preview refactor (issue #233):
// - The drift gate is now WIRED into CI (via scripts/tests/unit/goldens-drift.test.ts)
// - docs/architecture.md (not docs/preview-server-spec.md) is the canonical home
// - The wrapper (not a preview server) consumes the goldens
//
// This test pins the updated wording and fails if old false claims reappear.
//
// Runs in the required integration.yml root job via `bun test scripts/tests`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const header = readFileSync(
  join(import.meta.dir, "../../update-goldens.ts"),
  "utf8",
);

describe("scripts/update-goldens.ts header is honest about the goldens drift gate", () => {
  test("no longer references docs/preview-server-spec.md (retired)", () => {
    const flat = header.replace(/\n\/\/ ?/g, " ");
    expect(flat).not.toContain("preview-server-spec.md");
  });

  test("states the gate is wired into CI and references docs/architecture.md", () => {
    const flat = header.replace(/\n\/\/ ?/g, " ");
    // Should state that the gate is wired
    expect(flat).toContain("wired");
    // Should reference docs/architecture.md
    expect(flat).toContain("architecture.md");
  });

  test("describes the wrapper (not a preview server) as the goldens consumer", () => {
    const flat = header.replace(/\n\/\/ ?/g, " ");
    expect(flat).toContain("wrapper");
    // Should not say "server replays" (server-side replay is deprecated)
    expect(flat).not.toMatch(/server[^-]*replays/i);
  });

  test("no longer contains stale 'NOT yet wired' language", () => {
    const flat = header.replace(/\n\/\/ ?/g, " ");
    expect(flat).not.toContain("NOT yet wired");
  });
});
