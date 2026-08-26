// Unit tests for the pure decisions in backend/scripts/smoke-twin-capture.ts.
//
// The dump itself needs a real replica and cannot run here; what CAN be pinned
// is every guard that decides WHETHER to dump, because each one exists to stop a
// specific expensive mistake:
//   - writing a copy of production plus its passphrase into the git checkout;
//   - dumping from the PRIMARY instead of the read-only replica;
//   - starting a long dump with a client too old to finish it.
import { describe, expect, test } from "bun:test";
import { assertOutsideRepo, clientVersionComplaint, majorOf, parseArgs } from "../scripts/smoke-twin-capture.ts";

describe("parseArgs", () => {
  test("defaults to the same backup dir resolveBackupFiles() defaults to", () => {
    const a = parseArgs([]);
    expect("error" in a).toBe(false);
    if ("error" in a) return;
    expect(a.out).toMatch(/rm-backup-v022$/);
    expect(a.envFile).toMatch(/\.env\.readonly$/);
    expect(a.allowPrimary).toBe(false);
  });

  test("--out and --env-file override, --allow-primary is a switch", () => {
    const a = parseArgs(["--out", "/srv/b", "--env-file", "/srv/e", "--allow-primary"]);
    if ("error" in a) throw new Error(a.error);
    expect(a.out).toBe("/srv/b");
    expect(a.envFile).toBe("/srv/e");
    expect(a.allowPrimary).toBe(true);
  });

  test("a flag missing its value is an error, not a silent default", () => {
    expect(parseArgs(["--out"])).toEqual({ error: "--out requires a value." });
  });

  test("an unknown flag is rejected", () => {
    expect(parseArgs(["--dump-everything"])).toEqual({ error: 'unknown flag "--dump-everything".' });
  });
});

describe("assertOutsideRepo — the backup must never land in the checkout", () => {
  test("refuses the repo root itself", () => {
    expect(() => assertOutsideRepo("/repo", "/repo")).toThrow(/inside the checkout/);
  });

  test("refuses a subdirectory of the checkout", () => {
    expect(() => assertOutsideRepo("/repo/backups", "/repo")).toThrow(/inside the checkout/);
  });

  test("refuses it with a trailing slash too", () => {
    expect(() => assertOutsideRepo("/repo/", "/repo")).toThrow(/inside the checkout/);
  });

  test("allows a sibling whose name merely starts the same way", () => {
    // /repo-backups is NOT inside /repo — a naive startsWith would say it was.
    expect(() => assertOutsideRepo("/repo-backups", "/repo")).not.toThrow();
  });

  test("allows the ordinary home-directory default", () => {
    expect(() => assertOutsideRepo("/root/rm-backup-v022", "/repo")).not.toThrow();
  });
});

describe("client/server version rule", () => {
  test("majorOf reads the major out of the strings psql and pg_dump print", () => {
    expect(majorOf("18.6 (Ubuntu 18.6-1.pgdg24.04+2)")).toBe(18);
    expect(majorOf("16.4")).toBe(16);
    expect(majorOf("nonsense")).toBeNull();
  });

  test("an OLDER client is refused — pg_dump cannot dump from a newer server", () => {
    // The real pairing: Ubuntu 24.04 ships client 16, this repo runs server 18.
    const c = clientVersionComplaint(16, 18);
    expect(c).toBeDefined();
    expect(c).toMatch(/postgresql-client-18/);
  });

  test("equal or newer client is fine", () => {
    expect(clientVersionComplaint(18, 18)).toBeUndefined();
    expect(clientVersionComplaint(19, 18)).toBeUndefined();
  });

  test("unknown versions do not block the dump — the guard refuses to guess", () => {
    expect(clientVersionComplaint(null, 18)).toBeUndefined();
    expect(clientVersionComplaint(18, null)).toBeUndefined();
  });
});
