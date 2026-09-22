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
import { externalMigrationCredential, refuseIfSchemaBehind } from "../../lib/smoke-external-migrate.ts";

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

describe("refuseIfSchemaBehind — the absent-flag side of the same decision", () => {
  test("a current schema (exit 0) does not throw, and logs the check's own output", () => {
    const logged: string[] = [];
    const compose = () => ({ exitCode: 0, stdout: "[schema-current] up to date.\n", stderr: "" });
    expect(() => refuseIfSchemaBehind(compose, (m) => logged.push(m))).not.toThrow();
    expect(logged.join("\n")).toContain("up to date");
  });

  test("pending migrations (exit 1) refuse the boot, naming --migrate", () => {
    const compose = () => ({
      exitCode: 1,
      stdout: "",
      stderr: "[schema-current] 1 migration(s) pending, not yet applied:\n[schema-current]   0063_new.sql\n",
    });
    expect(() => refuseIfSchemaBehind(compose, () => {})).toThrow(/--migrate/);
  });

  test("a never-migrated database (exit 2) refuses the boot too", () => {
    const compose = () => ({ exitCode: 2, stdout: "", stderr: "[schema-current] schema_migrations does not exist\n" });
    expect(() => refuseIfSchemaBehind(compose, () => {})).toThrow(/schema-current exit 2/);
  });

  test("the refusal message logs the check's output before throwing", () => {
    const logged: string[] = [];
    const compose = () => ({ exitCode: 1, stdout: "", stderr: "[schema-current]   0063_new.sql\n" });
    expect(() => refuseIfSchemaBehind(compose, (m) => logged.push(m))).toThrow();
    expect(logged.join("\n")).toContain("0063_new.sql");
  });
});
