// The clock's side of the stream contract — issue #1026 W4.4.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §3.1, §3.2 and §6.3.
//
//   §3.1: "The clock's copy of the world is current if and only if: its stream
//    connection is live, and it has applied every event with a sequence number
//    above its full read's cursor, in order, with no gap. When both hold, it
//    acts. When either fails, it stops acting, performs a full read, rebuilds
//    every timer, and resumes. There is no third state."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
//
// The whole of §3.1's "if and only if", and nothing else. It holds the cursor,
// the last applied sequence and the currency flag; it decides when the copy has
// stopped being provable and performs the rebuild. It does NOT open a socket,
// hold a timer, or know what a subject is.
//
// That separation is deliberate and is what makes the contract testable. The
// failures this logic exists to survive — a dropped frame, a stalled socket, a
// redelivered job — are hard to produce against a real connection and trivial
// to produce against an injected one. `system-scheduler` (W4's third part)
// supplies the transport, the timers and the domain reaction; this supplies the
// rule about when any of that is allowed to run.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE RULE EVERY BRANCH BELOW SERVES
// ─────────────────────────────────────────────────────────────────────────────
//
// `current` is false from the instant a doubt appears until a full read has
// replaced the copy. Every caller of this module asks `current` before acting,
// so a gap detected halfway through a batch of frames stops the clock before
// the next one is applied rather than after. There is no "probably fine" path,
// because §3.1 says there is no third state.

/** The snapshot a full read returns. Only the cursor is this module's business. */
export interface FullReadSnapshot {
  cursor: number;
  [key: string]: unknown;
}

export interface StreamEventFrame {
  type: "event";
  seq: number;
  kind: string;
  subjectId?: string | null;
  sessionId?: string | null;
  payload?: Record<string, unknown>;
}

export interface KeepaliveFrame {
  type: "keepalive";
  /** §6.3: the sequence of the last event the API committed. */
  head: number;
}

export interface ResyncFrame {
  type: "resync";
  reason: string;
}

export interface JobFrame {
  type: "job";
  kind: string;
  target: string;
  idempotencyKey: string;
}

export type StreamFrame = StreamEventFrame | KeepaliveFrame | ResyncFrame | JobFrame;

/**
 * Everything this module asks of the API. Three calls, and they are the ONLY
 * calls it makes — which is what lets a test count them and assert §10's
 * "between instants, with a live stream and no events, `system-scheduler` makes
 * no API call".
 */
export interface ConsumerApi {
  fullRead(): Promise<FullReadSnapshot>;
  subscribe(cursor: number): Promise<void> | void;
  ackJob(idempotencyKey: string): Promise<void> | void;
}

export interface ConsumerHooks {
  /** Apply one event to the clock's copy. Called only for an in-order event above the cursor. */
  applyEvent?(event: StreamEventFrame): void | Promise<void>;
  /** Rebuild every timer from a fresh snapshot. Called after each full read. */
  onRebuild?(snapshot: FullReadSnapshot, trigger: RebuildTrigger): void | Promise<void>;
  /** Do a pushed job's work. Throwing leaves the job unacked and unremembered. */
  runJob?(job: JobFrame): void | Promise<void>;
}

/**
 * Why the copy stopped being provably current.
 *
 * Recorded per rebuild, not merely counted, because §10 asks for the TRIGGER by
 * name: "The test asserts the trigger was the head-sequence mismatch, not a
 * manually induced rebuild." A rebuild counter alone cannot tell those two
 * apart, and the difference is the entire final-event-loss gate.
 */
export type RebuildTrigger =
  | "start"
  | "gap"
  | "resync"
  | "head_sequence"
  | "missed_keepalive"
  | "dropped_connection";

export interface RebuildRecord {
  trigger: RebuildTrigger;
  /** The cursor the rebuild landed on. */
  cursor: number;
  /** What the consumer had applied when the doubt appeared. */
  lastApplied: number;
  /** The head a keepalive reported, when that is what triggered the rebuild. */
  observedHead?: number;
  /** The API's stated reason, when a resync notice triggered the rebuild. */
  reason?: string;
}

export interface ConsumerOptions {
  /**
   * How long the connection may go without a keepalive before it counts as
   * dropped (§6.3: "A missed keepalive is a dropped connection").
   */
  keepaliveBudgetMs?: number;
  /** Injected clock, so the stall test does not have to wait out a real budget. */
  now?: () => number;
  /** Reconnection backoff, in milliseconds, last step repeating. */
  backoffMs?: readonly number[];
}

const DEFAULT_BACKOFF = [250, 500, 1_000, 2_000, 5_000, 15_000] as const;

export class SchedulerStreamConsumer {
  readonly rebuilds: RebuildRecord[] = [];

  #api: ConsumerApi;
  #hooks: ConsumerHooks;
  #now: () => number;
  #keepaliveBudgetMs: number;
  #backoff: readonly number[];

  #cursor = 0;
  #lastApplied = 0;
  #current = false;
  #lastKeepaliveAt = 0;
  #ignoredDuplicates = 0;
  #seenJobKeys = new Set<string>();
  #backoffStep = 0;

  constructor(api: ConsumerApi, hooks: ConsumerHooks = {}, opts: ConsumerOptions = {}) {
    this.#api = api;
    this.#hooks = hooks;
    this.#now = opts.now ?? (() => Date.now());
    this.#keepaliveBudgetMs = opts.keepaliveBudgetMs ?? 30_000;
    this.#backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  }

  /** The cursor the current subscription was opened from. */
  get cursor(): number {
    return this.#cursor;
  }

  /** The highest sequence applied. Equal to the cursor immediately after a rebuild. */
  get lastApplied(): number {
    return this.#lastApplied;
  }

  /** §3.1's "if and only if". False means the clock must not act. */
  get current(): boolean {
    return this.#current;
  }

  get ignoredDuplicates(): number {
    return this.#ignoredDuplicates;
  }

  /** Idempotency keys whose work has completed. Exposed so a test can see a failed job is NOT here. */
  get seenJobKeys(): string[] {
    return [...this.#seenJobKeys];
  }

  /** The first full read and subscription. Identical to any later rebuild, by design. */
  async start(): Promise<void> {
    await this.#rebuild("start");
  }

  /**
   * Stop acting, without rebuilding.
   *
   * Separate from the rebuild so a caller that has detected a problem of its
   * own — a transport error, a failed transition it cannot reason about — can
   * make the copy unusable immediately and rebuild when it is ready to.
   */
  markStale(_reason: RebuildTrigger): void {
    this.#current = false;
  }

  /** The connection went away. §6.3: reconnect with backoff, then a full read. */
  async connectionDropped(): Promise<void> {
    this.#current = false;
  }

  /**
   * Reconnect, then rebuild. Returns the delay it waited.
   *
   * THERE IS NO REPLAY. §6.3: "The scheduler does not replay from its last
   * cursor after a drop; it rebuilds. Rebuilding is cheap and provably correct;
   * replay would have to be proven complete." So this subscribes from the NEW
   * snapshot's cursor and the old one is never presented again.
   *
   * The backoff resets once a connection is established, because an unreset one
   * makes the second outage of a flapping dependency slower than the first for
   * no reason at all.
   */
  async reconnect(opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<number> {
    const delay = this.#backoff[Math.min(this.#backoffStep, this.#backoff.length - 1)];
    this.#backoffStep += 1;
    const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
    await sleep(delay);
    try {
      await this.#rebuild("dropped_connection");
      this.#backoffStep = 0;
    } catch {
      // Still down. The copy stays stale and the next call backs off further.
      this.#current = false;
    }
    return delay;
  }

  /**
   * Has the keepalive budget elapsed? Returns true when this call rebuilt.
   *
   * §6.3: "The connection carries a transport-level keepalive ... A missed
   * keepalive is a dropped connection under §3.1." §10 adds the reason it
   * matters: a stalled connection that is never closed looks healthy to every
   * other check, and a stale timer firing against it is the failure.
   *
   * This is not an API call and not a read of business state — it compares two
   * numbers — so it does not violate §9's no-polling rule.
   */
  async checkKeepalive(): Promise<boolean> {
    if (!this.#current) return false;
    if (this.#now() - this.#lastKeepaliveAt <= this.#keepaliveBudgetMs) return false;
    await this.#rebuild("missed_keepalive");
    return true;
  }

  /** Handle one frame off the connection. */
  async receive(frame: StreamFrame): Promise<void> {
    switch (frame.type) {
      case "event":
        return this.#receiveEvent(frame);
      case "keepalive":
        return this.#receiveKeepalive(frame);
      case "resync":
        return this.#rebuild("resync", { reason: frame.reason });
      case "job":
        return this.#receiveJob(frame);
    }
  }

  async #receiveEvent(frame: StreamEventFrame): Promise<void> {
    // Not current: the copy is already being replaced, and applying anything to
    // it would be reasoning from a world this consumer cannot prove.
    if (!this.#current) return;

    // §6.3: "Duplicates (a sequence number at or below the last applied) are
    // ignored." Ignored means ignored — no rebuild, no timer reset, no call.
    if (frame.seq <= this.#lastApplied) {
      this.#ignoredDuplicates += 1;
      return;
    }

    // §6.3: "A gap — a sequence number that is not the last applied plus one —
    // means the copy is no longer provably current. Stop, full read, rebuild."
    // The arriving event is NOT applied first: it describes a world reached
    // through a change this consumer never saw.
    if (frame.seq !== this.#lastApplied + 1) {
      await this.#rebuild("gap");
      return;
    }

    await this.#hooks.applyEvent?.(frame);
    this.#lastApplied = frame.seq;
  }

  async #receiveKeepalive(frame: KeepaliveFrame): Promise<void> {
    this.#lastKeepaliveAt = this.#now();
    if (!this.#current) return;
    // §6.3: "A scheduler whose last-applied number is below that head has missed
    // an event with no later event to expose the gap; it treats this exactly
    // like a gap." A head BELOW the last applied is an ordinary stale frame in
    // flight and means nothing.
    if (frame.head > this.#lastApplied) {
      await this.#rebuild("head_sequence", { observedHead: frame.head });
    }
  }

  async #receiveJob(frame: JobFrame): Promise<void> {
    // A job is not a stream event: it carries no sequence, moves no cursor and
    // can leave no gap behind. §6.3 keeps the two apart, and so does this.
    if (this.#seenJobKeys.has(frame.idempotencyKey)) {
      // "a seen key produces no second effect" — but it is acked again, because
      // a redelivery means the first ack never landed and silence would leave
      // the job outstanding for ever.
      await this.#api.ackJob(frame.idempotencyKey);
      return;
    }
    try {
      await this.#hooks.runJob?.(frame);
    } catch {
      // Not acked and not remembered: the API's redelivery is the retry, and
      // marking it seen would turn one failure into permanent silent loss.
      return;
    }
    this.#seenJobKeys.add(frame.idempotencyKey);
    await this.#api.ackJob(frame.idempotencyKey);
  }

  /**
   * Stop acting, read the whole world, subscribe from the cursor that read
   * returned, resume.
   *
   * `current` is cleared BEFORE the read and set after the subscription, so the
   * entire window in which the copy is unprovable is a window in which the
   * clock refuses to act. Every trigger reaches this one function, which is why
   * a gap, a resync, a stall and a restart cannot drift apart in behaviour.
   */
  async #rebuild(trigger: RebuildTrigger, extra: Partial<RebuildRecord> = {}): Promise<void> {
    const lastApplied = this.#lastApplied;
    this.#current = false;
    const snapshot = await this.#api.fullRead();
    this.#cursor = snapshot.cursor;
    this.#lastApplied = snapshot.cursor;
    await this.#api.subscribe(snapshot.cursor);
    this.#lastKeepaliveAt = this.#now();
    await this.#hooks.onRebuild?.(snapshot, trigger);
    this.#current = true;
    this.rebuilds.push({ trigger, cursor: snapshot.cursor, lastApplied, ...extra });
  }
}
