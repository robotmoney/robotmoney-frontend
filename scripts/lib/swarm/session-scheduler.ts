// The host swarm driver's scheduling LOOP — the I/O half of the scheduler whose
// decision is the pure subjectsToStart / nextSchedulerWakeAt in
// scripts/lib/smoke-schedule.ts.
//
// ONE loop for every profile. It used to be a sequential `for (;;)` inside
// smoke-main.ts that picked the earliest-due subject and AWAITED its whole
// session, window included, before choosing again — so a four-subject twin
// with a six-minute window spent ~38 minutes per round, most of it one subject
// idling while another's window ran out. Now it starts every subject that
// subjectsToStart says is due WITHOUT awaiting it, and sleeps until the next
// subject is due or a running session ends, whichever comes first. With a cap
// of one (production, SmokeCadence.maxConcurrentSessions) that is the old loop
// exactly: the replay test in scripts/tests/unit/smoke-schedule.test.ts proves
// the order and timing match, and scripts/tests/unit/swarm-session-scheduler
// .test.ts executes this loop itself.
//
// It lives outside smoke-main.ts because smoke-main boots a stack on import and
// cannot be loaded by a test.
import { nextSchedulerWakeAt, subjectsToStart } from "../smoke-schedule.ts";

export interface SessionSchedulerOptions {
  /**
   * The subjects, as LIVE objects: `runOne` reschedules a subject by writing
   * its `nextAt` before it resolves, and the loop re-reads it every turn.
   */
  subjects: readonly { nextAt: number }[];
  /** cadence.maxConcurrentSessions. */
  maxConcurrent: number;
  /**
   * Run one session for subject `index`, reschedule it, and resolve. It must
   * NOT reject — a failed session is logged and rescheduled by the caller, and
   * the stack keeps running ("swarm session failed (stack still running)").
   * A rejection is caught here anyway, so one bug cannot stop every subject.
   */
  runOne: (index: number) => Promise<void>;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Checked every turn; the standing driver never stops, tests do. */
  shouldStop?: () => boolean;
  onError?: (index: number, err: unknown) => void;
}

const MAX_TIMER_MS = 2_147_483_647;
const defaultSleep =(ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSessionScheduler(opts: SessionSchedulerOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const inFlight = new Map<number, Promise<void>>();
  const view = () => opts.subjects.map((s, i) => ({ nextAt: s.nextAt, running: inFlight.has(i) }));
  while (!opts.shouldStop?.()) {
    for (const i of subjectsToStart(view(), now(), opts.maxConcurrent)) {
      const run = (async () => opts.runOne(i))()
        .catch((err) => opts.onError?.(i, err))
        .finally(() => inFlight.delete(i));
      inFlight.set(i, run);
    }
    const wakeAt = nextSchedulerWakeAt(view(), opts.maxConcurrent);
    const waits: Promise<unknown>[] = [...inFlight.values()];
    // Capped at the largest delay a timer honours: past 2^31-1 ms a runtime
    // fires it at once, which would turn a far-future slot into a busy loop.
    if (Number.isFinite(wakeAt)) waits.push(sleep(Math.min(Math.max(0, wakeAt - now()), MAX_TIMER_MS)));
    // Nothing running and nothing ever due cannot happen with at least one
    // subject, but an empty race would hang silently — fail loudly instead.
    if (waits.length === 0) throw new Error("session scheduler has no subject to run and none running");
    await Promise.race(waits);
  }
  await Promise.all(inFlight.values());
}
