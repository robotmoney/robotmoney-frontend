// Issue 1765 (phase 1, acceptance box 3): `bun run replay --archive <copy> --run
// <run_key> --json` as a process, from the package folder. Exit 0 with an empty
// diff for the committed v4 run and a v5 run; exit 1 naming the field for a
// tampered copy (a rewritten table, its backup record updated, so the reader
// accepts the copy and the difference is the row's, not the archive's); exit 2
// for a missing --run or --archive and for a run key that is not in the copy.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveCopy, tamperArtifact } from "./support/archive-tamper.ts";
import { openBackupsDir } from "../bin/backups-dir.ts";
import { REGIME_ARTIFACT_KIND } from "../src/analyze/regime-versions.ts";

const PKG = join(import.meta.dir, "..");
const MODEL_RUNS = join(import.meta.dir, "fixtures/archive/model-runs");
type Fact = { runKey: string; asof: string; label: string };
const FACTS = JSON.parse(readFileSync(join(MODEL_RUNS, "facts.json"), "utf8")) as { v4: Fact; v5: Fact[] };
const V5 = FACTS.v5[2]!;
const TMP = mkdtempSync(join(tmpdir(), "analyst-sdk-replay-cli-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

async function replay(args: string[]): Promise<Out> {
  const p = Bun.spawn(["bun", "run", "replay", ...args], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

const json = (o: Out) => JSON.parse(o.stdout.trim().split("\n").at(-1)!) as Record<string, any>;

/** The published artifact of a run in the committed copy. */
function artifactOf(runKey: string, kind: string): string {
  const copy = openBackupsDir(MODEL_RUNS);
  const run = copy.table("analytics_ledger_runs").find((r) => r.run_key === runKey)!;
  return copy.table("analytics_output_snapshots").find((o) => o.run_id === run.id && o.artifact_kind === kind)!.id!;
}

describe("bun run replay (issue 1765)", () => {
  test("the v4 run and a v5 run exit 0 with an empty diff", async () => {
    for (const f of [FACTS.v4, V5]) {
      const out = await replay(["--archive", MODEL_RUNS, "--run", f.runKey, "--json"]);
      expect({ run: f.runKey, code: out.code, stderr: out.stderr.includes("error") }).toEqual({ run: f.runKey, code: 0, stderr: false });
      const body = json(out);
      expect(body).toMatchObject({ run: f.runKey, asof: f.asof, version: f.label, match: true, differing: [], problems: [] });
      expect(body.publishedSha256).toBe(body.replaySha256);
    }
    // The v5 run reads its kept days and computes its own day.
    const v5 = json(await replay(["--archive", MODEL_RUNS, "--run", V5.runKey, "--json"]));
    expect(v5.line).toBe("beside");
    expect(v5.kept.computedDays).toBe(1);
    expect(v5.kept.artifactIds.length).toBe(2);
  }, 300_000);

  test("a tampered copy exits 1 and stdout names the field", async () => {
    const dir = join(TMP, "tampered");
    const copy = tamperArtifact(new ArchiveCopy(MODEL_RUNS), artifactOf(V5.runKey, REGIME_ARTIFACT_KIND.beside), (rows) => {
      const row = rows.find((r) => r.date === V5.asof)!;
      row.onchainIndex += 0.01;
    });
    copy.writeTo(dir);
    const out = await replay(["--archive", dir, "--run", V5.runKey, "--json"]);
    expect(out.code).toBe(1);
    const body = json(out);
    // The difference is the row's, not an archive error.
    expect(body.problems).toEqual([]);
    expect(body.match).toBe(false);
    expect(body.differing).toEqual(["onchainIndex"]);
    expect(body.firstDiff.field).toBe("onchainIndex");
    // The plain output names it too.
    const plain = await replay(["--archive", dir, "--run", V5.runKey]);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain("differs from the published one in onchainIndex");
  }, 300_000);

  test("a payload that does not match its payload_sha256 exits 1 naming the problem", async () => {
    const dir = join(TMP, "unhashed");
    tamperArtifact(new ArchiveCopy(MODEL_RUNS), artifactOf(V5.runKey, REGIME_ARTIFACT_KIND.beside), (rows) => void (rows[0]!.composite = 0.5), true).writeTo(dir);
    const out = await replay(["--archive", dir, "--run", V5.runKey, "--json"]);
    expect(out.code).toBe(1);
    expect(json(out).problems.join("\n")).toContain("does not match its stored payload_sha256");
  }, 300_000);

  test("usage: a missing --run or --archive, a bad option or an unknown run key exits 2", async () => {
    const noRun = await replay(["--archive", MODEL_RUNS, "--json"]);
    expect(noRun.code).toBe(2);
    expect(noRun.stderr).toContain("--run is required");
    const noArchive = await replay(["--run", V5.runKey]);
    expect(noArchive.code).toBe(2);
    expect(noArchive.stderr).toContain("--archive is required");
    const unknown = await replay(["--archive", MODEL_RUNS, "--run", "00000000-0000-0000-0000-000000000000", "--json"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("is not in the local copy's run ledger");
    const badPanels = await replay(["--archive", MODEL_RUNS, "--run", V5.runKey, "--included", "macro,nope"]);
    expect(badPanels.code).toBe(2);
    const badVersion = await replay(["--archive", MODEL_RUNS, "--run", V5.runKey, "--version", "v99"]);
    expect(badVersion.code).toBe(2);
    expect(badVersion.stderr).toContain("--version is one of v3, v4, v5");
  }, 120_000);

  test("--print-row prints the SDK's as-of row and exits 0", async () => {
    const out = await replay(["--archive", MODEL_RUNS, "--run", V5.runKey, "--print-row"]);
    expect(out.code).toBe(0);
    const row = json(out);
    expect(row.date).toBe(V5.asof);
    expect(row.version).toBe("v5");
  }, 120_000);
});
