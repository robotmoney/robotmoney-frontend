// scripts/tests/unit/release-supervise.test.ts — `bun run release:supervise`
// (scripts/release/supervise.ts, issue 1555): auto-resume at pausedUntil and
// died detection, on a fake clock with a fake child. No process is spawned and
// gh is never called.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStamp, writeJournal, type RunJournal, type StopReason } from "../../release/journal.ts";
import type { StopEvent } from "../../release/notify.ts";
import { diedReason, staleHeartbeat, supervise, type ChildExit, type SuperviseDeps } from "../../release/supervise.ts";

const START = Date.parse("2026-11-04T12:00:00Z");
const RUN = runStamp(new Date(START));

function journal(runTs: string, patch: Partial<RunJournal> = {}): RunJournal {
  return {
    version: 1, target: "stage", rmEnv: "stage", release: "v0.0.1", commit: "a".repeat(40), stepListHash: "h", stepIds: ["Q23-ready", "Q32-soak-gate"],
    goSha256: "g", runTs, startedAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(), status: "running", steps: {}, ...patch,
  };
}

/** A fake world: a clock, a sleep that advances it, a poll the test fires, and children scripted by the test. */
function world(children: ((ctx: { args: readonly string[]; now: () => Date; poll: () => void; runDir: (ts: string) => string }) => ChildExit)[]) {
  const root = mkdtempSync(join(tmpdir(), "release-supervise-"));
  let clock = START;
  const childArgs: (readonly string[])[] = [];
  const childStarts: number[] = [];
  const sleeps: number[] = [];
  const notified: StopEvent[] = [];
  const logs: string[] = [];
  let poll: () => void = () => {};
  const deps: SuperviseDeps = {
    async runChild(args) {
      childArgs.push(args);
      childStarts.push(clock);
      const script = children.shift();
      if (!script) throw new Error("no more children scripted");
      return script({ args, now: () => new Date(clock), poll: () => poll(), runDir: (ts) => join(root, "stage", ts) });
    },
    now: () => new Date(clock),
    async sleep(ms) { sleeps.push(ms); clock += ms; },
    every(ms, fn) { expect(ms).toBe(60_000); poll = fn; return () => { poll = () => {}; }; },
    async notify(e) { notified.push(e); return { notified: true, issue: 1 }; },
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
    home: "/nonexistent",
  };
  return { root, deps, childArgs, childStarts, sleeps, notified, logs, advance: (ms: number) => { clock += ms; } };
}

const stop = (kind: StopReason["kind"], at: Date, step?: string): StopReason => ({ kind, ...(step ? { step } : {}), detail: kind, resume: "x", at: at.toISOString() });

describe("release:supervise (issue 1555)", () => {
  test("a child that exits 3 with pausedUntil T: the next child starts at T on the fake clock, not before, with the same --run", async () => {
    const T = new Date(START + 30 * 60_000);
    const w = world([
      ({ now, runDir }) => {
        writeJournal(runDir(RUN), journal(RUN, { status: "incomplete", pausedUntil: T.toISOString(), stopReason: stop("paused", now(), "Q32-soak-gate") }));
        return { code: 3, signal: null };
      },
      ({ now, runDir }) => {
        writeJournal(runDir(RUN), journal(RUN, { status: "passed", stopReason: stop("passed", now()) }));
        return { code: 0, signal: null };
      },
    ]);
    // Started without --run: the supervisor picks the stamp once.
    expect(await supervise({ target: "stage", go: "go.txt", journalRoot: w.root }, w.deps)).toBe(0);
    expect(w.childStarts).toEqual([START, T.getTime()]);
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBe(30 * 60_000);
    expect(w.childArgs).toHaveLength(2);
    for (const args of w.childArgs) {
      expect(args).toEqual(["--target", "stage", "--go", "go.txt", "--run", RUN, "--journal-root", w.root]);
    }
    expect(w.notified).toEqual([]);
  });

  test("red: a pausedUntil already past resumes at once; a supervisor given --run passes that stamp", async () => {
    const ts = "20261101T000000Z";
    const w = world([
      ({ now, runDir }) => {
        writeJournal(runDir(ts), journal(ts, { status: "incomplete", pausedUntil: new Date(START - 1000).toISOString(), stopReason: stop("paused", now()) }));
        return { code: 3, signal: null };
      },
      ({ now, runDir }) => {
        writeJournal(runDir(ts), journal(ts, { status: "failed", stopReason: stop("failed", now(), "Q36-sdk-quickstart") }));
        return { code: 1, signal: null };
      },
    ]);
    expect(await supervise({ target: "stage", go: "go.txt", run: ts, journalRoot: w.root }, w.deps)).toBe(1);
    expect(w.sleeps).toEqual([]);
    expect(w.childArgs.map((a) => a[a.indexOf("--run") + 1])).toEqual([ts, ts]);
    // A failed run recorded its stop: the run's own notification covers it, not a died one.
    expect(w.notified).toEqual([]);
  });

  test("a child killed by a signal with no stopReason: exactly one died notification naming the last step and the resume command", async () => {
    const w = world([
      ({ now, runDir }) => {
        writeJournal(runDir(RUN), journal(RUN, { steps: { "Q36-sdk-quickstart": { id: "Q36-sdk-quickstart", status: "running", exit: null, expectExit: 0, startedAt: now().toISOString(), receipts: [], attempt: 1 } } }));
        return { code: null, signal: "SIGKILL" };
      },
    ]);
    expect(await supervise({ target: "stage", go: "go.txt", journalRoot: w.root }, w.deps)).toBe(1);
    expect(w.notified).toHaveLength(1);
    expect(w.notified[0]).toMatchObject({ kind: "died", runTs: RUN, step: "Q36-sdk-quickstart", target: "stage" });
    expect(w.notified[0]!.detail).toContain("SIGKILL");
    expect(w.notified[0]!.resume).toContain(`--run ${RUN} --from Q36-sdk-quickstart`);
    expect(w.childArgs).toHaveLength(1);
  });

  test("status running with heartbeatAt 11 minutes old: exactly one died notification, however often the poll sees it, and no restart", async () => {
    const w = world([
      ({ now, poll, runDir }) => {
        writeJournal(runDir(RUN), journal(RUN, { heartbeatAt: new Date(now().getTime() - 11 * 60_000).toISOString() }));
        poll();
        poll();
        poll();
        return { code: 1, signal: null };
      },
    ]);
    expect(await supervise({ target: "stage", go: "go.txt", journalRoot: w.root }, w.deps)).toBe(1);
    expect(w.notified).toHaveLength(1);
    expect(w.notified[0]).toMatchObject({ kind: "died", runTs: RUN });
    expect(w.notified[0]!.detail).toContain("heartbeat");
    expect(w.childArgs).toHaveLength(1);
  });

  test("red: a 9-minute-old heartbeat, a stop reason recorded, or a refused-<ts>.json written after the start is no death", async () => {
    const w = world([
      ({ now, poll, runDir }) => {
        writeJournal(runDir(RUN), journal(RUN, { heartbeatAt: new Date(now().getTime() - 9 * 60_000).toISOString() }));
        poll();
        writeJournal(runDir(RUN), journal(RUN, { status: "failed", stopReason: stop("failed", now()) }));
        return { code: 1, signal: null };
      },
    ]);
    expect(await supervise({ target: "stage", go: "go.txt", journalRoot: w.root }, w.deps)).toBe(1);
    expect(w.notified).toEqual([]);

    const r = world([
      ({ now }) => {
        mkdirSync(join(r.root, "stage"), { recursive: true });
        writeFileSync(join(r.root, "stage", `refused-${runStamp(now())}.json`), JSON.stringify(stop("refused", now())));
        return { code: 2, signal: null };
      },
    ]);
    expect(await supervise({ target: "stage", go: "go.txt", journalRoot: r.root }, r.deps)).toBe(2);
    expect(r.notified).toEqual([]);

    // A stop reason older than this child is the last invocation's, not this one's: died.
    const old = world([
      ({ runDir }) => {
        writeJournal(runDir(RUN), journal(RUN, { stopReason: stop("paused", new Date(START - 60_000)) }));
        return { code: 1, signal: null };
      },
    ]);
    expect(await supervise({ target: "stage", go: "go.txt", journalRoot: old.root }, old.deps)).toBe(1);
    expect(old.notified.map((e) => e.kind)).toEqual(["died"]);
  });

  test("the pure rules: staleHeartbeat and diedReason", () => {
    const now = new Date(START);
    expect(staleHeartbeat({ status: "running", heartbeatAt: new Date(START - 11 * 60_000).toISOString() }, now)).toBe(true);
    expect(staleHeartbeat({ status: "running", heartbeatAt: new Date(START - 10 * 60_000).toISOString() }, now)).toBe(false);
    expect(staleHeartbeat({ status: "failed", heartbeatAt: new Date(START - 60 * 60_000).toISOString() }, now)).toBe(false);
    expect(staleHeartbeat({ status: "running" }, now)).toBe(false);
    expect(diedReason({ code: null, signal: "SIGTERM" }, stop("failed", now), now, false)).toContain("SIGTERM");
    expect(diedReason({ code: 1, signal: null }, undefined, now, false)).toContain("without recording a stop reason");
    expect(diedReason({ code: 1, signal: null }, stop("failed", now), now, false)).toBeUndefined();
    expect(diedReason({ code: 2, signal: null }, undefined, now, true)).toBeUndefined();
  });

  test("production is never supervised", async () => {
    const w = world([]);
    expect(await supervise({ target: "prod", go: "go.txt", journalRoot: w.root }, w.deps)).toBe(2);
    expect(w.childArgs).toEqual([]);
    expect(w.logs.join("\n")).toContain("only a stage run is supervised");
  });
});
