// THE WIRING BETWEEN THE STREAM AND THE CLOCK — issue #1026 W4, part 3.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3.1, §3.2, §6.3, §9 and
// §10.
//
//   §3.1: "The clock's copy of the world is current if and only if: its stream
//    connection is live, and it has applied every event with a sequence number
//    above its full read's cursor, in order, with no gap. When both hold, it
//    acts. When either fails, it stops acting, performs a full read, rebuilds
//    every timer, and resumes."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A MODULE AND NOT THE BODY OF main()
// ─────────────────────────────────────────────────────────────────────────────
//
// Every §3.1 failure is a property of the WIRING, not of either half: the
// consumer can know the copy is stale while the clock's boundary timer fires
// anyway; the socket can close while nothing tells the consumer; a rebuild can
// re-read the world and leave the dead socket open. Each of those is invisible
// to a test of the consumer alone or the clock alone, and each was a real
// defect while this wiring lived inline in `scripts/system-scheduler.ts`, where
// no test could reach it.
//
// So the wiring is here, parameterized on a transport and a timer host, and
// `main()` is left with the things that are genuinely the process's: reading
// the token file, serving the health port, the startup check's exit decision,
// and the signals. `system-scheduler-stream.test.ts` drives THIS class on fake
// timers; the integration test drives it over real sockets.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR RULES IT ENFORCES
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. The clock's timers ask the consumer before they act (`isCurrent`). A
//      boundary that falls during a stall, a backoff or a rebuild is dropped,
//      and the rebuild that ends the interval fires it once (§3.2).
//   2. A closed socket makes the copy stale BEFORE anything else happens:
//      `connectionDropped()` first, then the reconnect.
//   3. Every rebuild re-opens the socket, because `subscribe(cursor)` on the
//      transport REPLACES the connection. A stalled socket is therefore read
//      past once, not once per keepalive budget for ever.
//   4. The keepalive watchdog is the one periodic thing, and it compares two
//      numbers. It is a self-re-arming timer on the injected host rather than a
//      `setInterval`, so a test can hold it on a fake clock like every other
//      timer the process owns.
import type { StreamHandlers } from "./api-client.ts";
import { SchedulerClock } from "./clock.ts";
import type { StartupCheck } from "./health.ts";
import { SchedulerStreamConsumer, type ConsumerApi, type StreamFrame } from "./stream-consumer.ts";
import type { SchedulerFullRead, TimerHandle, TimerHost, TransitionApi } from "./types.ts";

/** What the runtime needs from the API: the transitions, the read, and a socket it can replace. */
export interface SchedulerTransport extends TransitionApi, ConsumerApi {
  attachStream(handlers: StreamHandlers): void;
  closeStream(): void;
}

export interface RuntimeOptions {
  timers: TimerHost;
  /**
   * Is the API there, and does it accept the token? Asked only after a
   * reconnect's full read has failed, to tell the health surface WHICH failure
   * it was. Failure-triggered and behind the reconnect backoff, so not a poll.
   */
  probe: () => Promise<StartupCheck>;
  /** §6.3: how long the connection may go without a keepalive before it counts as dropped. */
  keepaliveBudgetMs?: number;
  /** How often the watchdog compares the two numbers. Not an API call. */
  watchdogMs?: number;
  /** Reconnection backoff, last step repeating. */
  reconnectBackoffMs?: readonly number[];
  /** §4.6's retry budget and backoff, passed through to the clock. */
  maxAttempts?: number;
  retryBackoffMs?: readonly number[];
  log?: (msg: string) => void;
}

/** A sleep that waits on the injected timer host, so a fake clock governs it too. */
export function timerSleep(timers: TimerHost): (ms: number) => Promise<void> {
  return (ms) => new Promise<void>((resolve) => void timers.set(timers.now() + ms, resolve));
}

export class SchedulerRuntime {
  readonly clock: SchedulerClock;
  readonly consumer: SchedulerStreamConsumer;

  #transport: SchedulerTransport;
  #timers: TimerHost;
  #probe: () => Promise<StartupCheck>;
  #watchdogMs: number;
  #sleep: (ms: number) => Promise<void>;
  #log: (msg: string) => void;

  #watchdog: TimerHandle | null = null;
  #checking = false;
  #reconnecting: Promise<void> | null = null;
  #stopped = false;

  constructor(transport: SchedulerTransport, opts: RuntimeOptions) {
    this.#transport = transport;
    this.#timers = opts.timers;
    this.#probe = opts.probe;
    this.#watchdogMs = opts.watchdogMs ?? 5_000;
    this.#sleep = timerSleep(opts.timers);
    this.#log = opts.log ?? (() => {});

    this.clock = new SchedulerClock(transport, {
      timers: opts.timers,
      sleep: this.#sleep,
      log: this.#log,
      maxAttempts: opts.maxAttempts,
      backoffMs: opts.retryBackoffMs,
      // Rule 1. Read at the instant a timer fires, never cached.
      isCurrent: () => this.consumer.current,
    });

    // The consumer owns §3.1. Its hooks are the only place the clock is driven
    // from the stream, and `onRebuild` is the ONE path every kind of downtime
    // converges on (§3.2).
    this.consumer = new SchedulerStreamConsumer(
      transport,
      {
        applyEvent: (event) => this.clock.applyEvent(event),
        onRebuild: async (snapshot, trigger) => {
          // A full read that came back IS proof the token is accepted for
          // reads right now. The clock keeps a rejection it saw on a
          // transition regardless (see SchedulerClock.markTokenRejected).
          this.clock.markAuthenticated(true);
          this.#log(`rebuild (${trigger}) at cursor ${snapshot.cursor}`);
          await this.clock.rebuild(snapshot as unknown as SchedulerFullRead);
        },
      },
      {
        keepaliveBudgetMs: opts.keepaliveBudgetMs,
        now: () => opts.timers.now(),
        backoffMs: opts.reconnectBackoffMs,
      },
    );
  }

  /**
   * The first connect, through the SAME path every later one takes. §3.2
   * treats four kinds of downtime identically, and a boot against an API that
   * is not up yet is the first of them; a separate first-connect path would be
   * a fifth case with its own behaviour.
   */
  async start(): Promise<void> {
    this.#transport.attachStream({
      onFrame: (frame) => this.#onFrame(frame),
      onClosed: (reason) => this.#dropped(reason),
    });
    this.#armWatchdog();
    try {
      await this.consumer.start();
      this.clock.markStreamSynchronized(this.consumer.current);
      this.#log("clock running");
    } catch (err) {
      this.#log(`initial connect failed: ${String((err as Error)?.message ?? err)}`);
      this.clock.markStreamSynchronized(false);
      void this.#reconnect();
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#watchdog) this.#timers.clear(this.#watchdog);
    this.#watchdog = null;
    this.#transport.closeStream();
    this.clock.stop();
  }

  /** Resolves once no reconnect loop is running. Tests only. */
  async settled(): Promise<void> {
    while (this.#reconnecting) await this.#reconnecting;
  }

  async #onFrame(frame: StreamFrame): Promise<void> {
    try {
      await this.consumer.receive(frame);
    } catch (err) {
      // A rebuild the frame forced could not complete — the full read or the
      // new socket failed. The copy is stale and there is no live socket to
      // wait on, which is a dropped connection by any other name.
      this.#dropped(`rebuild failed: ${String((err as Error)?.message ?? err)}`);
      return;
    }
    this.clock.markStreamSynchronized(this.consumer.current);
  }

  /** Rule 2: stale first, then reconnect. */
  #dropped(reason: string): void {
    if (this.#stopped) return;
    this.#log(`stream closed: ${reason}`);
    void this.consumer.connectionDropped();
    this.#transport.closeStream();
    this.clock.markStreamSynchronized(false);
    void this.#reconnect();
  }

  #reconnect(): Promise<void> {
    if (this.#reconnecting || this.#stopped) return this.#reconnecting ?? Promise.resolve();
    this.#reconnecting = (async () => {
      try {
        while (!this.#stopped) {
          // §6.3: "A dropped connection is reconnected with backoff and
          // followed by a full read. The scheduler does not replay from its
          // last cursor after a drop; it rebuilds." `reconnect()` backs off on
          // the injected clock, re-reads, and re-subscribes from the new cursor.
          await this.consumer.reconnect({ sleep: this.#sleep });
          if (this.#stopped) return;
          if (this.consumer.current) {
            this.clock.markStreamSynchronized(true);
            return;
          }
          // `reconnect()` swallows the full read's error to keep backing off,
          // so ask which failure it was. A rejected token is permanent and the
          // health surface must say so rather than report an endless
          // reconnect; an unreachable API is the ordinary case.
          const probe = await this.#probe();
          if (probe.tokenRejected) this.clock.markTokenRejected(probe.error ?? "automation token rejected");
          else this.clock.markAuthenticated(probe.tokenValid, probe.error ?? undefined);
        }
      } finally {
        this.#reconnecting = null;
      }
    })();
    return this.#reconnecting;
  }

  /** Rule 4. */
  #armWatchdog(): void {
    if (this.#stopped) return;
    this.#watchdog = this.#timers.set(this.#timers.now() + this.#watchdogMs, () => {
      this.#armWatchdog();
      if (this.#checking) return;
      this.#checking = true;
      void this.consumer
        .checkKeepalive()
        .then((rebuilt) => {
          if (rebuilt) this.#log("missed keepalive: rebuilt");
          this.clock.markStreamSynchronized(this.consumer.current);
        })
        .catch((err) => this.#dropped(`missed keepalive, rebuild failed: ${String((err as Error)?.message ?? err)}`))
        .finally(() => {
          this.#checking = false;
        });
    });
  }
}
