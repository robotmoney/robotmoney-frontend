// `csvb verify` over the legacy layout (issue 1477): a committed SYNTHETIC chain of snapshot-time backups
// (tests/fixtures/legacy, written by csvb before the day cut, from the SDK's synthetic archive fixture rows; never
// production data). The backups robotmoney/csv-backups already holds are of this shape and stay byte for byte as
// they are, so the tool must keep verifying them. Run as a process, the way an operator runs it.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_ID_RE, DAY_CUT_ID_RE } from "@robotmoney/analyst-sdk/src/archive/format1.ts";

const PKG = join(import.meta.dir, "..");
const LEGACY = join(import.meta.dir, "fixtures", "legacy");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true }); // the directories this test made, never a parent
});

function verify(repo: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", "run", "src/cli.ts", "verify", "--repo", repo], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

describe("csvb verify over the legacy snapshot-time layout", () => {
  test("the fixture is a chain of snapshot-time backups, not day cuts", () => {
    const ids = readdirSync(join(LEGACY, "csv")).sort();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      expect(BACKUP_ID_RE.test(id)).toBe(true);
      expect(DAY_CUT_ID_RE.test(id)).toBe(false);
    }
    expect(readdirSync(join(LEGACY, "csv", ids[0]!)).sort()).toEqual(["backup.json", "data", "revisions"]);
  });

  test("verify exits 0 over the committed chain", () => {
    const r = verify(LEGACY);
    expect(r.out).toContain("matches its backup record");
    expect(r.code).toBe(0);
  });

  test("verify exits non-zero after a flipped byte in a copy (planted-violation control)", () => {
    const d = mkdtempSync(join(tmpdir(), "csvb-legacy-"));
    made.push(d);
    const repo = join(d, "repo");
    cpSync(LEGACY, repo, { recursive: true });
    const id = readdirSync(join(repo, "csv")).sort()[0]!;
    const file = join(repo, "csv", id, "data", readdirSync(join(repo, "csv", id, "data")).find((f) => f.startsWith("source_value_versions."))!);
    const b = readFileSync(file);
    b[Math.floor(b.length / 2)] ^= 0x01;
    writeFileSync(file, b);
    const r = verify(repo);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("problem(s)");
  });
});
