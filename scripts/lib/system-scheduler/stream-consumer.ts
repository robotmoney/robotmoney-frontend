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
// resync notice — are hard to produce against a real connection and trivial to
// produce against an injected one. `system-scheduler` (W4's third part)
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

/**
 * Every frame the stream carries. There is no job frame, and that is §6.3 as
 * amended on 2026-09-24 (D52): "The stream carries change events only. Every
 * piece of work the scheduler does follows from an event or a timer; there is
 * no ad-hoc job kind for the API to push, ack or redeliver." A frame of any
 * other type is dropped by the transport before it reaches `receive()`.
 */
export type StreamFrame = StreamEventFrame | KeepaliveFrame | ResyncFrame;

/**
 * Everything this module asks of the API. Two calls, and they are the ONLY
 * calls it makes — which is what lets a test count them and assert §10's
 * "between instants, with a live stream and no events, `system-scheduler` makes
 * no API call".
 *
 * `subscribe(cursor)` REPLACES the connection: it closes whatever socket was
 * open and opens a new one from `cursor`. It is not a notification. A rebuild
 * triggered from inside the stream — a gap, a head-sequence mismatch, a missed
 * keepalive — must leave the scheduler on a socket that starts at the new
 * snapshot's cursor, and a stalled socket is exactly the one that never
 * delivers anything again, so keeping it would re-read on every keepalive
 * budget for ever (§3.1, §9).
 */
export interface ConsumerApi {
  fullRead(): Promise<FullReadSnapshot>;
  subscribe(cursor: number): Promise<void> | void;
}

export interface ConsumerHooks {
  /** Apply one event to the clock's copy. Called only for an in-order event above the cursor. */
  applyEvent?(event: StreamEventFrame): void | Promise<void>;
  /** Rebuild every timer from a fresh snapshot. Called after each full read. */
  onRebuild?(snapshot: FullReadSnapshot, trigger: RebuildTrigger): void | Promise<void>;
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
  #backoffStep = 0;
  /**
   * Bumped by every rebuild and every drop. A rebuild only declares the copy
   * current if nothing has happened since it started: a socket that died while
   * the full read was in flight must not be followed by `current = true`.
   */
  #generation = 0;
  /** Rebuilds in flight. While any is, frames are held rather than applied or lost. */
  #rebuilding = 0;
  /** Frames that arrived while a rebuild was in flight, in arrival order. */
  #held: StreamFrame[] = [];

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
    this.#generation += 1;
  }

  /**
   * The connection went away. §6.3: reconnect with backoff, then a full read.
   *
   * Synchronous in effect: `current` is false before this returns, so a timer
   * callback that runs next already sees a stopped clock. A rebuild that was
   * in flight when the drop happened will not flip `current` back on.
   */
  async connectionDropped(): Promise<void> {
    this.#current = false;
    this.#generation += 1;
    this.#held = [];
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
    // A rebuild is in flight. The frame may come from the NEW socket, opened
    // inside the rebuild before `current` is set — the API sends what it
    // committed above the cursor straight away (§6.3's handoff) — so it is
    // neither applied nor dropped. It waits, and is handled in order once the
    // rebuild has either declared the copy current or failed.
    if (this.#rebuilding > 0) {
      this.#held.push(frame);
      return;
    }
    switch (frame.type) {
      case "event":
        return this.#receiveEvent(frame);
      case "keepalive":
        return this.#receiveKeepalive(frame);
      case "resync":
        return this.#rebuild("resync", { reason: frame.reason });
      default:
        // Not a frame §6.3 defines. Ignored, not a reason to rebuild.
        return;
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

  /**
   * Stop acting, read the whole world, subscribe from the cursor that read
   * returned, resume.
   *
   * `current` is cleared BEFORE the read and set after the subscription, so the
   * entire window in which the copy is unprovable is a window in which the
   * clock refuses to act. Every trigger reaches this one function, which is why
   * a gap, a resync, a stall and a restart cannot drift apart in behaviour.
   *
   * AN OVERTAKEN REBUILD DOES NOTHING. A drop, a `markStale` or a newer
   * rebuild since this one started bumps the generation, and whoever bumped it
   * owns the recovery. So the generation is checked after every await, and a
   * rebuild that finds itself overtaken returns before its next side effect:
   * it does not subscribe (which would replace the socket a newer rebuild
   * declared current on), it does not rebuild the clock's timers from its
   * older snapshot, it does not record itself, and it does not throw. A throw
   * would reach the runtime as a dropped connection and invalidate the newer
   * rebuild that superseded this one — which is exactly how an overtaken
   * rebuild's subscribe fails, because the newer subscribe aborts it.
   */
  async #rebuild(trigger: RebuildTrigger, extra: Partial<RebuildRecord> = {}): Promise<void> {
    const lastApplied = this.#lastApplied;
    this.#current = false;
    const generation = ++this.#generation;
    const overtaken = (): boolean => generation !== this.#generation;
    this.#rebuilding += 1;
    let declared = false;
    try {
      let snapshot: FullReadSnapshot;
      try {
        snapshot = await this.#api.fullRead();
      } catch (err) {
        if (overtaken()) return;
        throw err;
      }
      if (overtaken()) return;
      this.#cursor = snapshot.cursor;
      this.#lastApplied = snapshot.cursor;
      // Replaces the socket. Anything the old one still had in flight is gone
      // with it, which is the point: §6.3 rebuilds, it never replays.
      try {
        await this.#api.subscribe(snapshot.cursor);
      } catch (err) {
        if (overtaken()) return;
        throw err;
      }
      if (overtaken()) return;
      this.#lastKeepaliveAt = this.#now();
      await this.#hooks.onRebuild?.(snapshot, trigger);
      this.rebuilds.push({ trigger, cursor: snapshot.cursor, lastApplied, ...extra });
      // `onRebuild` awaits too. A drop during it still means this snapshot is
      // not the one the clock may act on.
      if (!overtaken()) {
        this.#current = true;
        declared = true;
      }
    } finally {
      this.#rebuilding -= 1;
      // A rebuild that failed or was overtaken hands its held frames to
      // nobody: they belong to a socket whose copy was never declared current.
      if (!declared && this.#rebuilding === 0) this.#held = [];
    }
    if (!declared) return;
    // Frames that arrived during the rebuild, in order. An event at or below
    // the new cursor is a duplicate, the next one is applied, and anything
    // further is a gap — the ordinary rules, applied now that they can be.
    // If one of them forces another rebuild, the rest came from the socket
    // that rebuild replaced and are dropped with it.
    const held = this.#held.splice(0);
    for (const frame of held) {
      if (generation !== this.#generation) break;
      await this.receive(frame);
    }
  }
}
