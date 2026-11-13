// Issue 1612: `probe.ts start` on a retried run. A probe.json left by an earlier attempt (dead pid, or
// already graded) is stale: start moves it aside and begins a fresh window. A live probe is left alone.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeReceipt } from "../../lib/rollout-probe.ts";
import type { ImageReceipt } from "../../lib/website-release.ts";
import { gradeRun, moveStaleProbeAside, probeDir, probeStatus, readSwapJournal, swapGaps } from "../../release/probe.ts";

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

// Issue 1630: a website-server swap may drop requests for its measured gap (web-serving-architecture.md
// §4.1). The grade excuses a failed site answer asked inside a gap a `bun smoke:web` receipt recorded
// during the window, and nothing else.
const T0 = Date.parse("2026-11-13T00:00:00Z");
const tick = (i: number, status = 200): ProbeReceipt => ({ at: T0 + i * 2_000, status });
const receiptWithGap = (from: number, to: number | null, revert?: [number, number]): ImageReceipt => ({
  schema: 2, mode: "image", instance: "stage_target", host: "h", action: "deploy", outcome: "swapped", release: null, apiVersion: null,
  oldContainer: null, newContainer: null, publicPort: null, copyPort: null, checks: [],
  gap: { startedAt: new Date(from).toISOString(), endedAt: to === null ? null : new Date(to).toISOString(), ms: to === null ? null : to - from },
  revertGap: revert === undefined ? null : { startedAt: new Date(revert[0]).toISOString(), endedAt: new Date(revert[1]).toISOString(), ms: revert[1] - revert[0] },
  currentImage: null, previousImage: null, error: null, startedAt: new Date(from).toISOString(), finishedAt: new Date(to ?? from).toISOString(),
});
const WINDOW = { start: T0, end: T0 + 20_000 };

describe("the probe grade excuses only the swap gaps the receipts recorded (issue 1630)", () => {
  test("swapGaps reads each receipt's gap and revert gap inside the window; an open gap or one outside the window excuses nothing", () => {
    expect(swapGaps([receiptWithGap(T0 + 5_000, T0 + 6_500, [T0 + 9_000, T0 + 9_800])], WINDOW)).toEqual([
      { start: T0 + 5_000, end: T0 + 6_500 }, { start: T0 + 9_000, end: T0 + 9_800 },
    ]);
    expect(swapGaps([receiptWithGap(T0 + 5_000, null)], WINDOW)).toEqual([]);
    expect(swapGaps([receiptWithGap(T0 - 60_000, T0 - 58_000)], WINDOW)).toEqual([]);
  });

  test("a failed answer inside the recorded gap passes; the same answer with no receipt fails", () => {
    const receipts = Array.from({ length: 11 }, (_, i) => tick(i, i === 3 ? 0 : 200));
    const gaps = swapGaps([receiptWithGap(T0 + 5_500, T0 + 6_200)], WINDOW);
    const graded = gradeRun(receipts, WINDOW, {}, "stage", 2_000, 3_000, gaps);
    expect(graded.ok).toBe(true);
    expect(graded.excused?.map((r) => r.at)).toEqual([T0 + 6_000]);
    expect(gradeRun(receipts, WINDOW, {}, "stage", 2_000, 3_000, []).ok).toBe(false);
  });

  test("red: a failed answer outside the gap fails the grade, even beside an excused one", () => {
    const receipts = Array.from({ length: 11 }, (_, i) => tick(i, i === 3 || i === 7 ? 502 : 200));
    const graded = gradeRun(receipts, WINDOW, {}, "prod", 2_000, 3_000, swapGaps([receiptWithGap(T0 + 5_500, T0 + 6_200)], WINDOW));
    expect(graded.ok).toBe(false);
    expect(graded.nonOk.map((r) => r.at)).toEqual([T0 + 14_000]);
    expect(graded.problems.join()).toContain("1 probe answer(s) were not 200 outside the swap gap(s) the receipts recorded");
  });

  test("the grade reads the target's instance journal under the control machine's smoke state root", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-swap-"));
    roots.push(root);
    const dir = join(root, "web-image", "stage_target");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), `${JSON.stringify(receiptWithGap(T0 + 5_500, T0 + 6_200))}\nnot json\n`);
    expect(readSwapJournal("stage", { RM_SMOKE_STATE_ROOT: root }).map((r) => r.gap?.ms)).toEqual([700]);
    expect(readSwapJournal("prod", { RM_SMOKE_STATE_ROOT: root })).toEqual([]);
  });
});

describe("probe.ts grade, as a subprocess, around a swap gap (issue 1630)", () => {
  test("answers that fail inside the receipt's gap pass the grade; without the receipt the same window fails", async () => {
    let down: { from: number; to: number } | undefined;
    const server = Bun.serve({ port: 0, fetch: () => (down !== undefined && Date.now() >= down.from && Date.now() <= down.to ? new Response("", { status: 502 }) : new Response("{}", { status: 200 })) });
    const origin = `http://127.0.0.1:${server.port}`;
    const state = mkdtempSync(join(tmpdir(), "probe-swap-state-"));
    roots.push(state);
    const run = async (args: string[], root: string) => {
      const p = Bun.spawn(["bun", PROBE, ...args, "--target", "stage", "--run", RUN, "--journal-root", root], { stdout: "pipe", stderr: "pipe", env: { ...process.env, RM_SMOKE_STATE_ROOT: state } });
      const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
      return { code: await p.exited, out };
    };
    try {
      for (const withReceipt of [true, false]) {
        const { root } = runDir();
        rmSync(join(state, "web-image"), { recursive: true, force: true });
        expect((await run(["start", "--origin", origin], root)).code).toBe(0);
        await Bun.sleep(1_000);
        down = { from: Date.now(), to: Date.now() + 2_500 };
        await Bun.sleep(4_000);
        if (withReceipt) {
          mkdirSync(join(state, "web-image", "stage_target"), { recursive: true });
          writeFileSync(join(state, "web-image", "stage_target", "journal.jsonl"), `${JSON.stringify(receiptWithGap(down.from - 100, down.to + 100))}\n`);
        }
        const graded = await run(["grade"], root);
        expect([withReceipt, graded.code]).toEqual([withReceipt, withReceipt ? 0 : 1]);
        if (withReceipt) expect(graded.out).toContain("excused");
      }
    } finally {
      server.stop(true);
    }
  }, 40_000);
});
