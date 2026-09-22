// Unit tests for scripts/lib/smoke-external-migrate.ts.
//
// SCOPE, deliberately narrow: hiddenPrompt() drives raw-mode stdin directly and
// verifyAuthenticates() shells to `psql` — neither is worth a fragile test here
// (see the file's own header). externalMigrationCredential()'s missing-env-file
// refusal, though, is synchronous and happens BEFORE hiddenPrompt() is ever
// called, so it is testable without a TTY or a real Postgres server.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalMigrationCredential } from "../../lib/smoke-external-migrate.ts";

function envFileWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-migrate-cred-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return path;
}

describe("externalMigrationCredential — refused before any prompt or network I/O", () => {
  test("an env file missing host/database throws, never reaching the terminal prompt", async () => {
    const path = envFileWith("port = 25060\n");
    await expect(externalMigrationCredential(path, () => {})).rejects.toThrow(
      /missing the host\/database/,
    );
  });

  test("a missing .env file throws the same way", async () => {
    const path = join(tmpdir(), "rm-migrate-cred-absent", ".env");
    await expect(externalMigrationCredential(path, () => {})).rejects.toThrow(
      /missing the host\/database/,
    );
  });
});
