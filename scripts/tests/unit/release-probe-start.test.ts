// Issue 1612: `probe.ts start` on a retried run. A probe.json left by an earlier attempt (dead pid, or
// already graded) is stale: start moves it aside and begins a fresh window. A live probe is left alone.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeReceipt } from "../../lib/rollout-probe.ts";
import type { ImageReceipt } from "../../lib/website-release.ts";
import { gradeRun, moveStaleProbeAside, probeDir, probeLoop, probeStatus, readSwapJournal, swapGaps } from "../../release/probe.ts";
import { parseProbeReceipts } from "../../lib/rollout-probe.ts";
import { cutoverSummary } from "../../release/run.ts";
import type { RunJournal } from "../../release/journal.ts";

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

// Issue 1703: ticks start on the 2 s schedule and ask the paths concurrently, so a slow answer delays nothing.
describe("the probe loop keeps its schedule (issue 1703)", () => {
  test("with '/' stalled 5 s, ticks still start every 2 s and /version.json keeps a 2 s start spacing", async () => {
    let t = 1_000;
    const timers: Array<{ at: number; fire: () => void }> = [];
    const later = (ms: number) => new Promise<void>((fire) => { timers.push({ at: t + ms, fire }); });
    const fetchImpl = (async (url: string) => {
      if (new URL(url).pathname === "/") await later(5_000);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const lines: Array<{ at: number; latencyMs: number; path: string }> = [];
    let finished = false;
    void probeLoop("http://x", (l) => lines.push(JSON.parse(l)), { fetchImpl, now: () => t, sleep: later }, 2_000, 6).then(() => { finished = true; });
    for (let guard = 0; !finished && guard < 10_000; guard++) {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (next === undefined) continue;
      t = Math.max(t, next.at);
      next.fire();
    }
    expect(finished).toBe(true);
    const starts = (path: string) => lines.filter((l) => l.path === path).map((l) => l.at).sort((a, b) => a - b);
    expect(starts("/version.json")).toEqual([1_000, 3_000, 5_000, 7_000, 9_000, 11_000]);
    expect(starts("/")).toEqual([1_000, 3_000, 5_000, 7_000, 9_000, 11_000]);
    expect(starts("/api/status/maintenance")).toHaveLength(6);
    expect(lines.filter((l) => l.path === "/").every((l) => l.latencyMs === 5_000)).toBe(true);
  });
});

// The receipts of stage QA run 20261119T221608Z (Q25-probe-grade), replayed onto the concurrent 2 s schedule with the
// latencies that run recorded (each sequential ask lasted until the next one started) and its two maintenance-route 503s.
describe("replay of the 20261119T221608Z probe (issue 1703)", () => {
  test("no gap, a latency finding, and a failure only on the two maintenance-route answers", () => {
    const receipts = parseProbeReceipts(readFileSync(join(import.meta.dir, "..", "fixtures", "probe-1703", "20261119T221608Z.probe.jsonl"), "utf8"));
    const g = gradeRun(receipts, { start: 1795134938394, end: 1795135148707 }, {}, "stage", 2_000, 3_000);
    expect(g.gaps).toEqual([]);
    expect(g.nonOk).toEqual([]);
    expect(g.maintenanceFailures.map((r) => r.status)).toEqual([503, 503]);
    expect(g.ok).toBe(false);
    expect(g.problems).toEqual(["2 answer(s) of the maintenance status route were not 200 outside a declared maintenance window"]);
    expect(g.latency.map((f) => f.path)).toEqual(["/", "/api/status/maintenance", "/version.json"]);
    expect(Math.max(...g.latency.map((f) => f.latencyMs))).toBeGreaterThan(3_000);
  });

  test("a latency finding names the step running then", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const steps = { "Q23-ready": { id: "Q23-ready", status: "ok", startedAt: iso(T0), endedAt: iso(T0 + 10_000) } } as unknown as RunJournal["steps"];
    const receipts: ProbeReceipt[] = Array.from({ length: 10 }, (_, i) => ({ at: T0 + i * 2_000, status: 200, endedAt: T0 + i * 2_000 + (i === 2 ? 4_000 : 100), latencyMs: i === 2 ? 4_000 : 100, path: "/" }));
    expect(gradeRun(receipts, WINDOW, steps, "stage", 2_000, 3_000).latency).toEqual([{ path: "/", latencyMs: 4_000, at: T0 + 4_000, step: "Q23-ready" }]);
  });
});

describe("the cutover summary reads the probe grade (issue 1703)", () => {
  const steps = (status: string) => ({ "Q25-probe-grade": { id: "Q25-probe-grade", status } }) as unknown as RunJournal["steps"];
  test("it says the website stayed up only when the probe grade step passed", () => {
    expect(cutoverSummary({ steps: steps("ok"), cutoverSeconds: 42 }, "stage")).toContain("the website stayed up (Q25-probe-grade)");
    for (const status of ["failed", "accepted", "skipped"]) {
      const line = cutoverSummary({ steps: steps(status), cutoverSeconds: 42 }, "stage")!;
      expect(line).not.toContain("the website stayed up (");
      expect(line).toContain(`did not pass (${status})`);
    }
    expect(cutoverSummary({ steps: {}, cutoverSeconds: 42 }, "stage")).toContain("did not pass (not run)");
    expect(cutoverSummary({ steps: steps("ok") }, "stage")).toBeUndefined();
  });
});

// Owner decision 2026-11-25 (v0.11.0, amending issue 1703): the maintenance status route's non-200 answers from the
// release being replaced, before READY starts, are reported and fail nothing; from READY on they are graded.
describe("the maintenance route before READY is the previous release's (v0.11.0)", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const READY_AT = T0 + 60_000;
  const steps = (status = "ok") => ({ "Q23-ready": { id: "Q23-ready", status, startedAt: iso(READY_AT), endedAt: iso(READY_AT + 5_000) } }) as unknown as RunJournal["steps"];
  const site: ProbeReceipt[] = Array.from({ length: 60 }, (_, i) => ({ at: T0 + i * 2_000, status: 200, path: "/" }));
  const win = { start: T0, end: T0 + 118_000 };
  test("a pre-swap maintenance 503 passes and is reported", () => {
    const pre = { at: READY_AT - 30_000, status: 503, maintenance: false };
    const g = gradeRun([...site, pre], win, steps(), "stage", 2_000, 3_000);
    expect(g).toMatchObject({ ok: true, maintenanceFailures: [], maintenancePreviousRelease: [pre] });
  });
  test("red control: a maintenance 503 at or after READY still fails", () => {
    const post = { at: READY_AT + 2_000, status: 503, maintenance: false };
    const g = gradeRun([...site, post], win, steps(), "stage", 2_000, 3_000);
    expect(g.ok).toBe(false);
    expect(g.maintenanceFailures).toEqual([post]);
    expect(g.maintenancePreviousRelease).toBeUndefined();
  });
  test("red control: without a started READY nothing is excused, and a site 503 before READY still fails", () => {
    const pre = { at: READY_AT - 30_000, status: 503, maintenance: false };
    expect(gradeRun([...site, pre], win, {}, "stage", 2_000, 3_000).maintenanceFailures).toEqual([pre]);
    const siteFail = site.map((r, i) => (i === 5 ? { ...r, status: 503 } : r));
    expect(gradeRun(siteFail, win, steps(), "stage", 2_000, 3_000).ok).toBe(false);
  });
});
