// `RM_ENV=stage bun smoke --local dump=<dir>` in a REAL process, against a
// real gpg-encrypted backup — issue #1026 criteria 13 (the stage × `--local
// dump` row of §4.3) and 76 (a dump restore leaves deployment_identity
// `rehearsal`, and no runtime role can write it), smoke-production-spec.md §4.2,
// §4.3, §5, §7.
//
// THE BACKUP is built by ../support/make-encrypted-backup.ts the way §5.1/§5.2
// and `bun smoke:capture` build one — pg_dump --format=custom --no-owner
// --no-privileges, pg_dumpall --globals-only, gpg --symmetric with a generated
// passphrase file, `.last-stamp` — from a disposable Postgres of the test's
// own, into a temp directory. Nothing secret is committed.
//
// THE ORDER smoke-main.ts implements for a dump, and that §7 names ("database
// create/restore (local) → target lock (§2) → identity matrix (§4.3) →
// authorized preparation → preflight"):
//
//   plan → prepare:instance (the four role passwords)
//        → prepare:restore  (gpg → pg_restore into the smoke-twin container, then
//                            dumpOwnershipSql by the restore superuser: the four
//                            roles, every object to rm_owner)
//        → prepare:lock     (acquire as rm_readonly, re-read, the §4.3 matrix)
//        → prepare:enroll   (rm_owner overwrites the enrollment with `rehearsal`)
//        → prepare:migrate  (`--migrate`, as rm_owner, under the lock)
//        → assemble, site, images, preflight, services
//
// WHERE EACH BOOT IS STOPPED. At the boundary after `prepare:migrate`. Past it
// the boot builds images and runs preflight, and preflight refuses a restored
// copy today: the backup carries no default privileges (capture's
// `--no-privileges`), and the migrate run's roles-and-grants reconciliation
// (backend/schema/grants.sql) does not restore the ones the manifest declares
// (backend/schema/snapshot.sql's `ALTER DEFAULT PRIVILEGES` for rm_worker on
// tables and all three runtime roles on sequences), so check schema_integrity
// refuses. That is reported, not asserted here; readiness itself is
// w4-stack-readiness's.
//
// THE TWO SOURCES:
//   production-identity  a branch-schema database enrolled `production`, as
//                        §9.1 leaves one. The row allows it (the matrix does not
//                        consult a local dump's row) and smoke re-enrolls it
//                        `rehearsal` through rm_owner before anything else runs.
//   v0.5.0               the release production runs (D55 (8)). It predates
//                        0063, so it has no deployment_identity table and smoke
//                        has nothing to write `rehearsal` into. The boot REFUSES
//                        at enroll, before `--migrate` and before any service —
//                        fail-closed, because §4.2 requires the copy to say
//                        `rehearsal` before any stage tool connects, and
//                        D55 (5)'s no-row exception is `bun run migrate` on
//                        production alone. Reported as a gap: no path boots a
//                        v0.5.0 dump on stage today.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BOOT_TIMEOUT_MS, harness, journalNow, spawnBoot, teardown, waitFor, type BootHarness, type RunningBoot } from "./smoke-boot-harness.ts";
import { makeEncryptedBackup, MARKER_PAGE, type EncryptedBackup } from "../support/make-encrypted-backup.ts";
import { readRolePasswords, readStackState } from "../../lib/smoke-state.ts";
import { roleUrl, type HostTarget } from "../../lib/smoke-database.ts";
import { smokeTwinUrlFromContainer } from "../../lib/smoke-twin.ts";

let productionDump: EncryptedBackup;
let releaseDump: EncryptedBackup;
beforeAll(async () => {
  productionDump = await makeEncryptedBackup("production-identity");
  releaseDump = await makeEncryptedBackup("v0.5.0");
}, 300_000);
afterAll(() => {
  productionDump?.close();
  releaseDump?.close();
});

/** The restored copy this instance's boot recorded: its superuser URL and the host target. */
function restoredCopy(h: BootHarness): { superuserUrl: string; target: HostTarget } {
  const container = readStackState(h.paths)?.smokeTwinContainer;
  if (!container) throw new Error("the boot recorded no smoke-twin container");
  const superuserUrl = smokeTwinUrlFromContainer(container);
  if (!superuserUrl) throw new Error(`the smoke-twin container ${container} is not answering`);
  const url = new URL(superuserUrl);
  return {
    superuserUrl,
    target: { host: url.hostname, port: Number(url.port), database: decodeURIComponent(url.pathname.slice(1)), sslmode: "disable" },
  };
}

/** One statement over the host's psql; `ok` false carries psql's verbose error (with its SQLSTATE). */
function psql(url: string, sql: string): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", url, "-c", sql], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

function steps(h: BootHarness): string[] {
  return (journalNow(h)?.phases ?? []).map((p) => `${p.phase}:${p.step ?? ""}:${p.status}`);
}

/** Stop `boot` at the boundary after its `step` preparation commits. */
async function stopAfter(h: BootHarness, boot: RunningBoot, step: string): Promise<number> {
  await waitFor(
    () => (journalNow(h)?.phases ?? []).some((r) => r.phase === "prepare" && r.step === step && r.status === "committed"),
    BOOT_TIMEOUT_MS,
    `the boot to commit its ${step} preparation`,
    boot,
  );
  boot.proc.kill("SIGINT");
  return await boot.exited;
}

describe("`RM_ENV=stage bun smoke --local dump --migrate` against a real encrypted backup", () => {
  test("a production-enrolled dump: restore → ownership → lock → enroll → migrate, in that order, and the copy says rehearsal, written by rm_owner", async () => {
    expect(productionDump.identity).toBe("production");
    const h = harness("dumpprod");
    let boot: RunningBoot | undefined;
    try {
      boot = spawnBoot(h, [], { local: `dump=${productionDump.dir}`, env: { RM_ENV: "stage" } });
      const code = await stopAfter(h, boot, "migrate");
      // Stopped by the test at a phase boundary, never refused.
      expect(code).toBe(130);
      const out = boot.output();
      expect(out).toContain(`restoring backup ${productionDump.stamp}`);
      expect(out).toContain("RM_ENV=stage, deployment_identity rehearsal");
      expect(out).toContain("target lock held");
      expect(out).not.toContain("startup failed");

      // The order, from the journal the boot wrote.
      expect(steps(h).slice(0, 6)).toEqual([
        "plan::committed",
        "prepare:instance:committed",
        "prepare:restore:committed",
        "prepare:lock:committed",
        "prepare:enroll:committed",
        "prepare:migrate:committed",
      ]);

      const copy = restoredCopy(h);
      // The restore carried data, not only a schema.
      expect(psql(copy.superuserUrl, `SELECT count(*) FROM comments WHERE page = '${MARKER_PAGE}'`).out).toBe("1");
      // dumpOwnershipSql handed every application table to rm_owner.
      expect(
        psql(copy.superuserUrl, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND pg_get_userbyid(c.relowner) <> 'rm_owner'`).out,
      ).toBe("0");

      // Criterion 76: the dump restore left ONE row, `rehearsal`, written by
      // rm_owner — the production row the dump carried was overwritten (§4.2).
      expect(psql(copy.superuserUrl, "SELECT count(*) || ':' || kind || ':' || written_by FROM deployment_identity GROUP BY kind, written_by").out).toBe("1:rehearsal:rm_owner");
      expect(psql(copy.superuserUrl, "SELECT note FROM deployment_identity").out).toContain(productionDump.stamp);

      // Criterion 76: each runtime LOGIN is refused a write to it BY GRANT
      // (42501 insufficient_privilege), with the password smoke generated for
      // it — the credential a container of this boot would hold.
      const passwords = readRolePasswords(h.paths);
      for (const role of ["rm_app", "rm_worker", "rm_readonly"] as const) {
        const url = roleUrl(copy.target, role, passwords[role]);
        expect(psql(url, "SELECT current_user").out).toBe(role);
        for (const write of [
          "UPDATE deployment_identity SET kind = 'production'",
          "INSERT INTO deployment_identity (id, kind) VALUES (true, 'production') ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind",
          "DELETE FROM deployment_identity",
          "TRUNCATE deployment_identity",
        ]) {
          const r = psql(url, write);
          expect({ role, write, ok: r.ok }).toEqual({ role, write, ok: false });
          expect(r.out).toContain("42501");
          expect(r.out).toContain("permission denied for table deployment_identity");
        }
      }
      // And the row is unchanged after all twelve attempts.
      expect(psql(copy.superuserUrl, "SELECT kind FROM deployment_identity").out).toBe("rehearsal");
    } finally {
      teardown(h, boot);
    }
  }, BOOT_TIMEOUT_MS);

  test("a v0.5.0 dump (predates 0063): the boot refuses at enroll, fail-closed — nothing migrated, nothing started, the copy never reads as enrolled", async () => {
    expect(releaseDump.identity).toBeNull();
    expect(releaseDump.ledger).toHaveLength(72);
    const h = harness("dumprel");
    let boot: RunningBoot | undefined;
    try {
      boot = spawnBoot(h, [], { local: `dump=${releaseDump.dir}`, env: { RM_ENV: "stage" } });
      const code = await boot.exited;
      expect(code).not.toBe(0);
      const out = boot.output();
      // Restored and locked like any dump; the matrix does not consult a local dump's row.
      expect(out).toContain("target lock held");
      // Then smoke has nowhere to write `rehearsal`.
      expect(out).toContain('enroll: relation "deployment_identity" does not exist');
      expect(steps(h)).toEqual([
        "plan::committed",
        "prepare:instance:committed",
        "prepare:restore:committed",
        "prepare:lock:committed",
        "prepare:enroll:failed",
      ]);
      // Nothing after the refusal ran: no migrate, no image, no service.
      expect(out).not.toContain("phase: prepare (migrate)");
      expect(out).not.toContain("phase: prepare (assemble)");

      const copy = restoredCopy(h);
      expect(psql(copy.superuserUrl, "SELECT to_regclass('public.deployment_identity') IS NULL").out).toBe("t");
      expect(psql(copy.superuserUrl, "SELECT count(*) FROM schema_migrations").out).toBe(String(releaseDump.ledger.length));
      expect(psql(copy.superuserUrl, `SELECT count(*) FROM comments WHERE page = '${MARKER_PAGE}'`).out).toBe("1");
    } finally {
      teardown(h, boot);
    }
  }, BOOT_TIMEOUT_MS);
});
