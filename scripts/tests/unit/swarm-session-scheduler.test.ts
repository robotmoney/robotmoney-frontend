// The swarm driver's scheduling LOOP (scripts/lib/swarm/session-scheduler.ts),
// executed with real timers on a millisecond scale. The pure decision it
// consults is covered in smoke-schedule.test.ts (including the replay against
// the old sequential loop); these tests prove the loop honours it: the cap,
// one session per subject, earliest-due first, and that one failing session
// neither stops the loop nor any other subject.
import { describe, expect, test } from "bun:test";
import { runSessionScheduler } from "../../lib/swarm/session-scheduler.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAR = Number.MAX_SAFE_INTEGER; // "not due again in this test"

/** Drive the real loop; each subject runs `runsEach` sessions of `durMs`, then is parked. */
async function drive(opts: {
  nextAt: number[];
  cap: number;
  durMs: number;
  runsEach: number;
  rescheduleAt?: () => number;
  fail?: (index: number, run: number) => boolean;
}) {
  const subjects = opts.nextAt.map((nextAt) => ({ nextAt, runs: 0 }));
  const running = new Set<number>();
  const perSubjectPeak = new Map<number, number>();
  const starts: { i: number; at: number }[] = [];
  const errors: number[] = [];
  let peak = 0;
  const t0 = Date.now();
  await runSessionScheduler({
    subjects,
    maxConcurrent: opts.cap,
    shouldStop: () => subjects.every((s) => s.runs >= opts.runsEach),
    onError: (i) => errors.push(i),
    runOne: async (i) => {
      const s = subjects[i]!;
      const concurrentForMe = running.has(i) ? 2 : 1;
      perSubjectPeak.set(i, Math.max(perSubjectPeak.get(i) ?? 0, concurrentForMe));
      running.add(i);
      peak = Math.max(peak, running.size);
      starts.push({ i, at: Date.now() - t0 });
      try {
        await wait(opts.durMs);
        if (opts.fail?.(i, s.runs)) throw new Error(`session ${i} failed`);
      } finally {
        running.delete(i);
        s.runs++;
        s.nextAt = s.runs >= opts.runsEach ? FAR : (opts.rescheduleAt?.() ?? Date.now());
      }
    },
  });
  return { starts, peak, perSubjectPeak, errors, subjects };
}

describe("runSessionScheduler — the driver loop", () => {
  test("cap 1 runs one session at a time, earliest-due first (production)", async () => {
    const now = Date.now();
    const r = await drive({ nextAt: [now + 10, now, now + 5], cap: 1, durMs: 15, runsEach: 1 });
    expect(r.peak).toBe(1);
    expect(r.starts.map((s) => s.i)).toEqual([1, 2, 0]);
  });

  test("cap 4 runs every due subject concurrently (fast profile)", async () => {
    const now = Date.now();
    const r = await drive({ nextAt: [now, now, now, now], cap: 4, durMs: 150, runsEach: 1 });
    expect(r.peak).toBe(4);
    // All four started together, not one after another.
    expect(Math.max(...r.starts.map((s) => s.at))).toBeLessThan(140); // before the first could finish
  });

  test("the cap holds when more subjects are due than it allows", async () => {
    const now = Date.now();
    const r = await drive({ nextAt: [now, now, now, now, now], cap: 2, durMs: 15, runsEach: 2 });
    expect(r.peak).toBe(2);
    expect(r.subjects.every((s) => s.runs === 2)).toBe(true);
  });

  test("a subject NEVER runs twice at once, even while it stays due during its own session", async () => {
    // nextAt is left in the past for the whole run (it is only rewritten when
    // the session ends), which is exactly the state that would double-start it
    // if the loop looked at nextAt alone.
    const r = await drive({ nextAt: [0], cap: 4, durMs: 20, runsEach: 3 });
    expect(r.perSubjectPeak.get(0)).toBe(1);
    expect(r.starts.length).toBe(3);
  });

  test("a subject is re-convened the moment its session ends when its next slot has passed", async () => {
    const r = await drive({ nextAt: [0], cap: 4, durMs: 25, runsEach: 3 });
    const gaps = r.starts.slice(1).map((s, k) => s.at - r.starts[k]!.at);
    for (const g of gaps) expect(g).toBeLessThan(25 + 100); // session length + scheduling slack, no idle
  });

  test("a subject not yet due is not started early", async () => {
    const now = Date.now();
    const r = await drive({ nextAt: [now, now + 60], cap: 4, durMs: 5, runsEach: 1 });
    const second = r.starts.find((s) => s.i === 1)!;
    expect(second.at).toBeGreaterThanOrEqual(55);
  });

  test("one failing session is reported and neither stops the loop nor the other subjects", async () => {
    const now = Date.now();
    const r = await drive({
      nextAt: [now, now],
      cap: 2,
      durMs: 10,
      runsEach: 2,
      fail: (i, run) => i === 0 && run === 0,
    });
    expect(r.errors).toEqual([0]);
    expect(r.subjects.map((s) => s.runs)).toEqual([2, 2]);
  });

  test("no subjects at all is a loud error, not a silent hang", async () => {
    await expect(runSessionScheduler({ subjects: [], maxConcurrent: 1, runOne: async () => {} }))
      .rejects.toThrow("no subject to run");
  });
});
