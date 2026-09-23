#!/usr/bin/env bun
// `bun smoke:tui` — the standalone TUI observer.
//
// STUB (issue #1026, W1 step 1). Signatures and types are real; every body
// throws, and this file is not yet wired into `package.json`, so running it
// does nothing today. It is additive and behaviour-neutral by construction.
//
// ── Why the TUI had to be split out ─────────────────────────────────────────
//
// Spec §1, first paragraph: "`bun smoke --static-port` brings up the production
// cluster and **exits**. Containers stay up under Docker (`restart:
// unless-stopped`). `bun smoke:down` is the only way to stop them.
// `bun smoke:status` and `bun smoke:tui` observe a running stack from another
// terminal; **`bun smoke` never draws a TUI**."
//
// Today it is the other way round: `scripts/lib/smoke-main.ts` draws the TUI
// itself and stays in the foreground, so the invoking terminal is the thing
// holding the deployment up. That couples two entirely unrelated lifetimes —
// the operator's SSH session and the production cluster's — and the coupling
// fails in both directions:
//
//  - The session ends (a laptop sleeps, a VPN drops, a `tmux` is killed) and
//    the deployment goes with it, or is left in whatever half-replaced state
//    the signal found. §1.4's interruption semantics exist precisely because
//    this state is reachable; §1's exit-at-readiness rule exists so it is
//    reachable far less often.
//  - Watching requires OWNING. Two people cannot look at the same deployment,
//    and looking at one from a second terminal means starting a second run —
//    which the deployment lock (§1.2) now correctly refuses. Without a separate
//    observer command, that refusal would leave an operator with no way to see
//    what is happening at all.
//
// So the observer is a distinct, read-only program. It attaches to a RUNNING
// stack, renders it, and detaches. Nothing it does can change the deployment:
// it does not take the deployment lock, it does not take the target lock (§2),
// it does not write the journal, and it does not stop anything —
// "`bun smoke:down` is the only way to stop them."
//
// ── What it observes ────────────────────────────────────────────────────────
//
// Per §1.4, an observer reads "the receipt when present, the journal when not".
// A completed deployment has a receipt and is a static picture; a running or
// interrupted one has only a journal and is a live one. Both are legitimate and
// the TUI must render both, clearly labelled — an operator must never have to
// guess whether the phase on screen is happening now or happened on Tuesday.
//
// ── Relationship to `smoke:status` ──────────────────────────────────────────
//
// `smoke:status` prints once and exits: it is what a script, a runbook step or
// an `ssh host bun smoke:status` uses. This is the interactive one: it
// redraws. They must read the SAME journal and receipt through the same
// functions (`scripts/lib/smoke-journal.ts`), so that a discrepancy between
// what a human saw and what a runbook captured is impossible.
//
// ── Governing spec sections ─────────────────────────────────────────────────
//
//   §1    `bun smoke` exits; `smoke:tui` is its own command and never draws
//         inside a deploying run.
//   §1.1  the instance is what an observer selects by.
//   §1.3  the phase journal is what it renders while a run is in progress.
//   §1.4  receipt-when-present, journal-when-not; and, after replacement began,
//         "`smoke:status` reports the phase and which services are new versus
//         old".
//   §6.2  participants are standing containers with their own lifetime; the
//         observer reports them without touching them.
//
// Acceptance gates served (spec §10, W1): "Sessions and participants survive
// the invoking terminal's exit" — this command is how that is observed without
// re-acquiring the deployment; and "Receipt read by `smoke:status`", whose
// reading path this shares.

import type { InstancePaths } from "./lib/smoke-state.ts";

/**
 * Parsed argv for the observer. Read-only by construction: there is no field
 * here that could start, stop or mutate anything, and none may be added — a
 * `--down` or `--restart` on the observer would recreate the ownership coupling
 * this command exists to break.
 */
export interface TuiOptions {
  /**
   * Which instance to watch (§1.1). When absent, the observer resolves the
   * single instance with state on this host, and refuses when there are
   * several — see {@link resolveObservedInstance}.
   */
  readonly instance: string | undefined;
  /** Redraw interval, milliseconds. */
  readonly intervalMs: number;
  /**
   * Render one frame and exit, for a non-interactive terminal or a CI log. Not
   * the same thing as `smoke:status`: this is the TUI's own layout, captured
   * once.
   */
  readonly once: boolean;
}

/**
 * Parse argv.
 *
 * Refusal cases:
 *  - any unknown flag refuses, naming it. Spec §1 retires a list of spellings
 *    "with no alias" (`SMOKE_PROJECT`, `--no-tui`, `--agents`, `--smoke`,
 *    `--db`, `--pg-data`, `--twin`); an observer that silently ignored one
 *    would let an operator believe a retired option still meant something.
 *  - `--no-tui` in particular refuses with a pointer to `smoke:status`, since
 *    that is what the flag used to mean and the operator's intent is knowable.
 *  - a non-numeric or sub-second `--interval`: a redraw faster than the docker
 *    queries behind it turns an observer into a load source on the host it is
 *    observing.
 */
export function parseTuiArgs(argv: readonly string[]): TuiOptions {
  void argv;
  throw new Error("NOT IMPLEMENTED: smoke:tui argv parsing — spec §1, issue #1026 W1.8");
}

/**
 * Choose the instance to observe.
 *
 * Inputs: the parsed `--instance` (or `undefined`) and the instances with state
 * on this host. Output: the resolved instance's {@link InstancePaths}.
 *
 * Deliberately NOT the resolver in `scripts/lib/smoke-state.ts`. That one
 * implements §1.1's precedence for a run that is about to ACT, and its last two
 * rules — take the persisted local name, else mint a fresh one and persist it —
 * are exactly wrong here: an observer that minted an instance would create
 * state for a deployment that does not exist, and one that fell through to a
 * persisted name could quietly watch a different deployment than the one the
 * operator meant.
 *
 * Refusal cases:
 *  - no instance has state on this host: refuse, saying nothing has been
 *    deployed from here, rather than drawing an empty screen that reads like a
 *    dead stack.
 *  - `--instance` names an instance with no state directory: refuse and list
 *    the names that do exist.
 *  - `--instance` was omitted and several instances have state: refuse and list
 *    them. Guessing is how an operator ends up watching CI while production
 *    burns.
 */
export function resolveObservedInstance(
  requested: string | undefined,
  available: readonly { readonly name: string; readonly paths: InstancePaths }[],
): InstancePaths {
  void requested;
  void available;
  throw new Error("NOT IMPLEMENTED: observer instance selection — spec §1.1, issue #1026 W1.8");
}

/**
 * One frame of observed state. A value, not a rendering: the same snapshot
 * feeds the interactive redraw and the `--once` capture, so the two can never
 * disagree about what is true.
 */
export interface ObservedStack {
  readonly instance: string;
  /** `receipt` when the run reached readiness, `journal` while it has not (§1.4). */
  readonly source: "receipt" | "journal";
  /** The phase the run is in, or the phase it stopped at. */
  readonly phase: string;
  /** Whether a deployment lock is currently held — i.e. a run is live. */
  readonly runInProgress: boolean;
  /**
   * Application services and, after the replace phase began, whether each is on
   * the new digest or the old one. §1.4 requires this distinction explicitly.
   */
  readonly services: readonly {
    readonly name: string;
    readonly state: string;
    readonly version: "new" | "old" | "unknown";
  }[];
  /** Standing participant containers (§6.2), by roster name. */
  readonly participants: readonly { readonly name: string; readonly kind: "agent" | "judge"; readonly state: string }[];
  /** Non-fatal notes for the footer, e.g. "journal superseded", "lock held by pid N". */
  readonly notes: readonly string[];
}

/**
 * Collect one snapshot.
 *
 * MUST be read-only in every path: no docker command that starts, stops,
 * removes or recreates anything; no database connection that takes a lock; no
 * write anywhere under the instance's state directory. The observer runs
 * concurrently with a live deployment by design, and a write from here would
 * land in the middle of the journal's before/after phase writes (§1.3).
 *
 * Refusal cases:
 *  - a malformed journal or receipt propagates the refusal from
 *    `scripts/lib/smoke-journal.ts` rather than rendering a blank screen: an
 *    unreadable record is a fact the operator needs, not a missing one.
 *  - docker being unreachable is reported IN the frame, as a note, not thrown:
 *    the journal is still readable and still worth showing, and this is exactly
 *    the moment an operator is trying to find out what happened.
 */
export function observe(paths: InstancePaths): Promise<ObservedStack> {
  void paths;
  throw new Error("NOT IMPLEMENTED: read-only stack observation — spec §1.4, issue #1026 W1.8");
}

/**
 * Render one snapshot to a string.
 *
 * Must label the source (`receipt` = finished, `journal` = in progress or
 * interrupted) unmissably. Must redact: the frame is a screenshot an operator
 * pastes into an incident thread, and §1.2's redaction promise does not stop at
 * the plan.
 */
export function renderFrame(stack: ObservedStack, width: number): string {
  void stack;
  void width;
  throw new Error("NOT IMPLEMENTED: TUI frame rendering — spec §1, issue #1026 W1.8");
}

/**
 * The command entry point: parse, resolve, then loop {@link observe} +
 * {@link renderFrame} until the operator quits, or render once under `--once`.
 *
 * Exit codes are about the OBSERVER, not the stack. Quitting a TUI that is
 * watching a failed deployment exits 0: the observation succeeded. A non-zero
 * exit means the observer could not observe — no instance, an ambiguous
 * selection, an unreadable journal. Conflating the two would make
 * `smoke:tui --once` unusable in any script that checks a status.
 *
 * Quitting must leave the stack untouched. Not a note — a requirement: this is
 * the command an operator reaches for when something is wrong, and the reflex
 * that ends it is Ctrl-C.
 */
export function main(argv: readonly string[]): Promise<number> {
  void argv;
  throw new Error("NOT IMPLEMENTED: smoke:tui entry point — spec §1, issue #1026 W1.8");
}
