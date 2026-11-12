// Issue 1612: `probe.ts start` on a retried run. A probe.json left by an earlier attempt (dead pid, or
// already graded) is stale: start moves it aside and begins a fresh window. A live probe is left alone.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveStaleProbeAside, probeDir, probeStatus } from "../../release/probe.ts";

const PROBE = join(import.meta.dir, "..", "..", "release", "probe.ts");
const RUN = "20261112T003753Z";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function runDir(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "probe-start-"));
  roots.push(root);
  const dir = probeDir("stage", RUN, root);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}
const seed = (dir: string, pid: number, startMs = Date.now() - 60_000) => {
  writeFileSync(join(dir, "probe.json"), JSON.stringify({ pid, startMs, origin: "http://x", everyMs: 2000 }));
  writeFileSync(join(dir, "probe.jsonl"), `${JSON.stringify({ at: startMs + 1, status: 200, path: "/" })}\n`);
};
const at = (file: string, ms: number) => utimesSync(file, ms / 1000, ms / 1000);

describe("probeStatus (issue 1612)", () => {
  test("no probe.json is none", () => {
    expect(probeStatus(runDir().dir)).toBe("none");
  });

  test("a running pid with no newer grade.json is live", () => {
    const { dir } = runDir();
    seed(dir, process.pid);
    expect(probeStatus(dir)).toBe("live");
    writeFileSync(join(dir, "grade.json"), "{}");
    at(join(dir, "grade.json"), Date.now() - 120_000); // an older grade does not stop it
    expect(probeStatus(dir)).toBe("live");
  });

  test("a dead pid is stale", () => {
    const { dir } = runDir();
    seed(dir, 1);
    expect(probeStatus(dir, () => false)).toBe("stale");
  });

  test("a grade.json newer than probe.json is stale even when the pid answers", () => {
    const { dir } = runDir();
    seed(dir, process.pid);
    at(join(dir, "probe.json"), Date.now() - 60_000);
    writeFileSync(join(dir, "grade.json"), "{}");
    expect(probeStatus(dir)).toBe("stale");
  });

  test("an unreadable probe.json is stale", () => {
    const { dir } = runDir();
    writeFileSync(join(dir, "probe.json"), "not json");
    expect(probeStatus(dir)).toBe("stale");
  });

  test("moveStaleProbeAside renames the three files and leaves no probe.json", () => {
    const { dir } = runDir();
    seed(dir, 1);
    writeFileSync(join(dir, "grade.json"), "{}");
    const moved = moveStaleProbeAside(dir, 42);
    expect(moved).toEqual(["probe.json.42.old", "probe.jsonl.42.old", "grade.json.42.old"]);
    expect(readdirSync(dir).sort()).toEqual([...moved].sort());
  });
});

// The real script against a local site: start, grade, start (the retry), grade.
async function probe(args: string[], root: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", PROBE, ...args, "--target", "stage", "--run", RUN, "--journal-root", root], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}

describe("probe.ts start, as a subprocess (issue 1612)", () => {
  test("a live probe prints already running and starts nothing; a retry-shaped start, grade, start, grade passes the second grade", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
    const origin = `http://127.0.0.1:${server.port}`;
    const { root, dir } = runDir();
    try {
      const first = await probe(["start", "--origin", origin], root);
      expect(first.code).toBe(0);
      expect(first.out).toContain("probing");
      const pid1 = JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")).pid;
      // live: a second start changes nothing
      const again = await probe(["start", "--origin", origin], root);
      expect(again.out).toContain("already running");
      expect(JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")).pid).toBe(pid1);
      await Bun.sleep(2_500);
      expect((await probe(["grade"], root)).code).toBe(0);
      expect(existsSync(join(dir, "grade.json"))).toBe(true);
      await Bun.sleep(50);
      // the retry: the first attempt's grade stopped its probe, so start begins a fresh window
      const retry = await probe(["start", "--origin", origin], root);
      expect(retry.out).toContain("stale");
      expect(retry.out).not.toContain("already running");
      const state2 = JSON.parse(readFileSync(join(dir, "probe.json"), "utf8"));
      expect(state2.pid).not.toBe(pid1);
      expect(readdirSync(dir).filter((f) => f.endsWith(".old")).length).toBe(3);
      await Bun.sleep(2_500);
      const second = await probe(["grade"], root);
      expect(second.code).toBe(0);
      const grade = JSON.parse(readFileSync(join(dir, "grade.json"), "utf8"));
      expect(grade.startMs).toBe(state2.startMs);
      expect(grade.ok).toBe(true);
    } finally {
      server.stop(true);
      try { process.kill(JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")).pid); } catch { /* gone */ }
    }
  }, 30_000);
});
