// `bun smoke --local dump --reuse` (runbook R3.8, issue 1174): the flag, and the
// choice between adopting the live kept twin and starting it again on its volume.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDataPath, requestsReuse, REUSE_FLAG, validateArgv } from "../../lib/smoke-db-mode.ts";
import { adoptKeptTwin } from "../../lib/smoke-twin.ts";
import type { StackStateRecord } from "../../lib/smoke-state.ts";
import type { restartKeptTwinContainer } from "../../lib/restore-container.ts";

const argv = (...flags: string[]): string[] => ["bun", "scripts/smoke.ts", ...flags];
const envFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), "rm-reuse-"));
  const path = join(dir, ".env");
  writeFileSync(path, "");
  return path;
})();

describe("--reuse is a modifier of --local dump only", () => {
  test("it is a known flag and a bare switch", () => {
    expect(validateArgv(argv("--local", "dump", REUSE_FLAG))).toEqual([]);
    expect(requestsReuse(argv("--local", "dump", REUSE_FLAG))).toBe(true);
    expect(requestsReuse(argv("--local", "dump"))).toBe(false);
  });

  test("with --local dump it parses to the same smoke-twin data path as without it", () => {
    const withReuse = parseDataPath(argv("--local", "dump=/tmp/backup", REUSE_FLAG), { envFilePath: envFile });
    const without = parseDataPath(argv("--local", "dump=/tmp/backup"), { envFilePath: envFile });
    expect(withReuse.dataPath).toEqual(without.dataPath);
    expect(withReuse.dataPath.kind).toBe("smoke-twin");
  });

  test("with any other mode, or none, it refuses before anything starts", () => {
    for (const flags of [["--local", "blank"], ["--local", "volume=somevol"], []]) {
      expect(() => parseDataPath(argv(...flags, REUSE_FLAG), { envFilePath: envFile })).toThrow(/applies only to --local dump/);
    }
  });
});

const STAMP = "20261001T141703Z";
const recorded = (over: Partial<StackStateRecord> = {}): StackStateRecord => ({
  instance: "rehearse", project: "p", apiPort: 1, webPort: 2, pgPort: null, stage: true, envClass: "local", envHash: "h",
  composeFiles: "docker-compose.yml", db: "smoke-twin", externalPg: true, databaseUrl: "postgres://restore_check:***@h:1/d",
  dbUser: "", dbPassword: "", dbName: "", logFile: "/dev/null", createdAt: "now",
  smokeTwinContainer: "rm-restore-live", smokeTwinVolume: "vol_smoke-twin_x", smokeTwinBackupStamp: STAMP, ...over,
});

function deps(over: { live?: boolean; restart?: typeof restartKeptTwinContainer } = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      urlOf: (c: string) => {
        calls.push(`urlOf:${c}`);
        return over.live === false ? null : "postgres://restore_check:pw@172.17.0.1:5000/rm_restore_check";
      },
      restart:
        over.restart ??
        ((async (o: { volume: string }) => {
          calls.push(`restart:${o.volume}`);
          return { container: "rm-restore-new", host: "172.17.0.1", port: 5001, username: "restore_check", password: "pw2", database: "rm_restore_check" };
        }) as unknown as typeof restartKeptTwinContainer),
      gateway: () => "172.17.0.1",
    },
  };
}

describe("adoptKeptTwin", () => {
  test("a live kept twin is adopted as it is: nothing is started", async () => {
    const d = deps();
    const got = await adoptKeptTwin(recorded(), STAMP, "p", () => {}, d.deps);
    expect(got).toEqual({ container: "rm-restore-live", url: "postgres://restore_check:pw@172.17.0.1:5000/rm_restore_check" });
    expect(d.calls.some((c) => c.startsWith("restart:"))).toBe(false);
  });

  test("a gone container with a kept volume is started again on that volume", async () => {
    const d = deps({ live: false });
    const got = await adoptKeptTwin(recorded(), STAMP, "p", () => {}, d.deps);
    expect(d.calls).toContain("restart:vol_smoke-twin_x");
    expect(got).toEqual({ container: "rm-restore-new", url: "postgres://restore_check:pw2@172.17.0.1:5001/rm_restore_check" });
  });

  test("an instance that records no twin refuses and says how to start one", async () => {
    await expect(adoptKeptTwin(null, STAMP, "p", () => {}, deps().deps)).rejects.toThrow(/records no smoke-twin to reuse/);
    await expect(adoptKeptTwin(recorded({ db: "external" as never }), STAMP, "p", () => {}, deps().deps)).rejects.toThrow(/records no smoke-twin/);
  });

  test("a twin restored from another backup refuses, so a different dump is never silently skipped", async () => {
    await expect(adoptKeptTwin(recorded({ smokeTwinBackupStamp: "20260101T000000Z" }), STAMP, "p", () => {}, deps().deps)).rejects.toThrow(/restored backup 20260101T000000Z, not 20261001T141703Z/);
  });

  test("a failed restart tears its half-built container down and refuses", async () => {
    const d = deps({
      live: false,
      restart: (async () => ({ error: "the kept volume vol is gone; drop --reuse to restore the dump fresh" })) as unknown as typeof restartKeptTwinContainer,
    });
    await expect(adoptKeptTwin(recorded(), STAMP, "p", () => {}, d.deps)).rejects.toThrow(/--reuse: the kept volume vol is gone/);
  });
});
