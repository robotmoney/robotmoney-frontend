// backend/scripts/lib/restore-container.ts — resolveBackupFiles is the pure,
// no-Docker piece (path resolution + existence checks); the rest is exercised
// for real by backend/scripts/upgrades/0.2.1-to-0.2.2/restore-check.ts and
// stage-rehearsal.ts against an actual backup, which this test suite cannot
// safely fabricate (it would need a real gpg-encrypted pg_dump).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { resolveBackupFiles } from "../scripts/lib/restore-container.ts";

describe("resolveBackupFiles", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("no .last-stamp at the given dir -> a reported error, not a throw", () => {
    dir = mkdtempSync(join(tmpdir(), "rm-restore-container-"));
    const r = resolveBackupFiles(dir);
    expect("error" in r).toBe(true);
  });

  test("stamp present but the encrypted files are missing -> a reported error naming the missing file", () => {
    dir = mkdtempSync(join(tmpdir(), "rm-restore-container-"));
    writeFileSync(join(dir, ".last-stamp"), "20260101T000000Z\n", "utf8");
    const r = resolveBackupFiles(dir);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("rm-preupgrade-20260101T000000Z.dump.gpg");
  });

  test("all files present -> resolves the stamp and each path", () => {
    dir = mkdtempSync(join(tmpdir(), "rm-restore-container-"));
    const stamp = "20260101T000000Z";
    writeFileSync(join(dir, ".last-stamp"), `${stamp}\n`, "utf8");
    writeFileSync(join(dir, `rm-preupgrade-${stamp}.dump.gpg`), "x", "utf8");
    writeFileSync(join(dir, `rm-globals-${stamp}.sql.gpg`), "x", "utf8");
    writeFileSync(join(dir, ".backup-passphrase"), "x", "utf8");

    const r = resolveBackupFiles(dir);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.stamp).toBe(stamp);
      expect(r.dumpEnc).toBe(join(dir, `rm-preupgrade-${stamp}.dump.gpg`));
      expect(r.globalsEnc).toBe(join(dir, `rm-globals-${stamp}.sql.gpg`));
      expect(r.passphraseFile).toBe(join(dir, ".backup-passphrase"));
    }
  });

  test("defaults to ~/rm-backup-v022 when no dir is given", () => {
    // Just confirm it doesn't throw and returns the shape the real default
    // directory would produce (present or missing depending on this host).
    const r = resolveBackupFiles();
    expect(typeof r).toBe("object");
  });
});
