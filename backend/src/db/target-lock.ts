// The target-lock protocol — smoke-production-spec.md §2, in full.
//
// STUB (issue #1026, W1 step 1 / plan row W1.7). Signatures and types are real;
// every body throws. Nothing imports this module yet, and nothing may import it
// until the implementation lands — it is additive and behaviour-neutral by
// construction.
//
// ── The invariant, quoted verbatim from spec §2 ─────────────────────────────
//
//   **Invariant.** Loss of the coordinating lock never lets a competing tool
//   overlap a mutation still executing. A cancellation request is not evidence
//   the mutation stopped.
//
// Both sentences are load-bearing and the second is the one that gets designed
// away. When a tool's lock connection dies, or an operator presses Ctrl-C, or a
// `statement_timeout` fires, the tool learns that it ASKED for something to
// stop. It does not learn that the something stopped. A `pg_cancel_backend`
// returns true when the signal was delivered, not when the query ended. A
// dropped TCP connection tells the client nothing about the transaction on the
// other side, which may still be committing. Every design that treats
// "I lost the lock" as "my mutation is over" is wrong, and it is wrong in the
// single worst way available: two migration runs applying DDL to one database
// at the same time.
//
// ── Why one protocol for every tool ─────────────────────────────────────────
//
// §2's first line names the callers: "`bun smoke`, `bun run migrate`,
// `bun run schedules:enable`, `--spoof-keys`, and the production-initialization
// commands (§9)." They are separate programs, started by different people from
// different machines, and nothing on the host serializes them. The database is
// the only thing all of them touch, so the database is the only place a lock
// can live. A file lock on the deploy host does not protect a database that a
// second operator can reach from a second host — and `scripts/lib/smoke-state.ts`'s
// deployment lock is exactly that file lock, deliberately a different lock for
// a different question ("two runs of one instance") than this one ("two tools
// on one database").
//
// ── The two locks, and why one is not enough ────────────────────────────────
//
// SESSION LOCK (`pg_advisory_lock`) — the COORDINATION layer. Taken on a
// dedicated connection and held for the whole run: "Smoke holds it from
// acquisition through preflight, replacement, and readiness, so a standalone
// migration cannot land between preflight and the new containers starting."
// That sentence is the reason the lock spans phases rather than wrapping each
// one. Preflight verifies a database; the containers then boot against it; if a
// migration slips into the gap, preflight verified something that no longer
// exists and the guarantee it produced is worthless.
//
// A session lock has one weakness: it dies with its session. When the
// coordinator's connection drops, Postgres releases it, and a competitor can
// acquire it immediately — while the coordinator's OTHER connection may still
// be inside an uncommitted mutation. That is the invariant's failure mode.
//
// XACT FENCE (`pg_advisory_xact_lock`) — the SAFETY layer, and the answer to
// it. "Every mutation (migration, grant reconciliation, seed, key rebind,
// schedule write) runs in a transaction that first takes
// `pg_advisory_xact_lock` on the same key, ON THE CONNECTION PERFORMING IT. A
// competitor that wins the session lock after the coordinator's connection died
// still blocks on the xact lock until the in-flight mutation commits or
// aborts."
//
// The fence is held by the transaction itself, so it cannot outlive the
// mutation and cannot be lost while the mutation runs: Postgres releases it at
// commit or abort, and at no other moment. The session lock keeps tools from
// starting; the fence keeps them from overlapping. Neither alone satisfies the
// invariant, and the emphasis on "on the connection performing it" is not
// decoration — a fence taken on the coordinating connection instead of the
// mutating one is released when the coordinating connection dies, which is the
// exact scenario it exists for.
//
// ── Keyed on the database, not the project ─────────────────────────────────
//
// §2: "keyed on the database identity (not the compose project)". Two compose
// projects — a CI job and a standing stage, or two operators' instances — can
// legitimately point at one database, and a project-keyed lock would let them
// mutate it simultaneously while each believed it held the lock. The key must
// be derived from what the DATABASE is, and it must be derived identically by
// every tool in §2's list, or the whole protocol degrades to several private
// mutexes that never contend.
//
// ── Governing spec sections ─────────────────────────────────────────────────
//
//   §2    the entire protocol: coordination, fencing, acquisition point,
//         revalidation, contention, connection loss.
//   §1.2  smoke holds the target lock alongside the deployment lock for the
//         whole run.
//   §8.3  the migrate run is "fence (§2) → apply pending migrations … → grant
//         reconciliation → publish the manifest".
//   §6.4  the spoofed-key rebind is "one fenced transaction".
//   §6.3  `schedules:enable` writes under the protocol.
//   §9.1  the production-initialization commands are in the caller list.
//
// Acceptance gates served (spec §10, W1):
//   - "Two instances preparing the same remote database serialize on the target
//      lock."
//   - "Kill the lock connection mid-migration, start a second mutation tool: no
//      overlap."
//   - "Standalone `bun run migrate` and `bun smoke` contend on the target lock,
//      including connection loss mid-phase."

import type { DbHandle } from "./client.ts";

/**
 * The advisory-lock key, derived from database identity.
 *
 * Postgres advisory locks are a global 64-bit namespace shared by every user of
 * the cluster, so the key is branded here to make "some number I had lying
 * around" untypeable at every call site. Everything in §2's caller list must
 * derive it through {@link targetLockKey} and nothing may construct one
 * directly — a second derivation is a second namespace, and two tools in two
 * namespaces never contend, which looks exactly like a working system until the
 * day it matters.
 */
export type TargetLockKey = bigint & { readonly __brand: "TargetLockKey" };

/**
 * Derive the lock key from the identity of the database being mutated.
 *
 * Input: the facts that identify the DATABASE — not the compose project, not
 * the instance, not the connection string (which varies by role, by host
 * spelling, by whether a pooler is in the path, and by whether `sslmode` was
 * appended, all while naming one database).
 *
 * The derivation must be stable across tools, hosts, roles and releases: a key
 * that changes when `migrate.ts` connects as `rm_owner` and smoke connects as
 * `rm_app` would put the two in different namespaces at the moment they most
 * need to contend. Prefer facts the SERVER reports (`current_database()` and
 * the cluster's system identifier) over anything the client typed.
 *
 * Refusal cases:
 *  - any identifying component missing or empty: a key derived from partial
 *    identity silently collides with every other partial derivation.
 *  - a caller supplying a raw number: there is no such overload, by design.
 *
 * Serves spec §10 W1: "Two instances preparing the same remote database
 * serialize on the target lock" — which is only true if both instances compute
 * this same value.
 */
export function targetLockKey(identity: {
  readonly systemIdentifier: string;
  readonly databaseName: string;
}): TargetLockKey {
  void identity;
  throw new Error("NOT IMPLEMENTED: derive the target-lock key from database identity — spec §2, issue #1026 W1.7");
}

/** Which tool holds (or wants) the lock, recorded so a contention refusal can name the holder. */
export interface LockHolder {
  /** `smoke` | `migrate` | `schedules:enable` | `spoof-keys` | a §9.1 command name. */
  readonly tool: string;
  /** The deployment instance (§1.1), when the tool has one. */
  readonly instance: string | null;
  /** Host and PID, so an operator can go find it. */
  readonly host: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

/**
 * A held session-level target lock, on its own dedicated connection.
 *
 * "The tool opens ONE DEDICATED CONNECTION and takes a session-level
 * `pg_advisory_lock`" (§2). Dedicated is a requirement, not an optimization: a
 * session lock taken on a pooled connection is released the moment the pool
 * hands that connection to someone else or recycles it, so the lock's lifetime
 * would be decided by pool pressure rather than by the run. The pool in
 * `db/client.ts` is therefore never the right place to take this.
 */
export interface TargetLock {
  readonly key: TargetLockKey;
  readonly holder: LockHolder;
  /**
   * The dedicated connection the session lock lives on. Exposed ONLY so
   * {@link assertStillHeld} can interrogate it. Callers must not run mutations
   * here: mutations run on their own connection and take their own fence (§2,
   * "on the connection performing it").
   */
  readonly connection: DbHandle;
  /**
   * Prove the lock is still held, right now, by asking the server — never by
   * consulting a local flag. See {@link assertStillHeld}.
   */
  stillHeld(): Promise<boolean>;
  /**
   * Release explicitly. §2: "It is released explicitly on exit." Explicit
   * because relying on connection teardown makes the release happen at an
   * unspecified time, and a lock that lingers after a tool exits is a
   * contention refusal for the next operator with no holder to name.
   */
  release(): Promise<void>;
}

/** What happened when a tool tried to take the lock. */
export type AcquireResult =
  | { readonly acquired: true; readonly lock: TargetLock }
  /**
   * §2, Contention: "A tool that finds the lock held waits with a timeout, then
   * refuses naming the holder." `holder` may be `null` when the holder's
   * identity could not be read — the refusal still stands; an unidentifiable
   * holder is not an absent one.
   */
  | { readonly acquired: false; readonly holder: LockHolder | null; readonly waitedMs: number; readonly reason: string };

/**
 * Acquire the session-level target lock on a dedicated connection.
 *
 * ACQUISITION POINT, from §2 verbatim: "After any local database is created or
 * restored, before the first read used for a decision."
 *
 * Both halves are exact. After creation/restore, because there is nothing to
 * lock before the database exists, and a `--local dump` restore is itself the
 * thing that puts production-shaped bytes on disk. Before the first read used
 * for a decision, because a decision made on an unlocked read is a decision
 * made on state that can move before it is acted on — and the whole protocol
 * exists to close exactly that window.
 *
 * Inputs: a connection URL for the dedicated connection, the derived key, the
 * holder identity to publish, and a contention timeout. Output:
 * {@link AcquireResult}.
 *
 * Refusal cases:
 *  - the lock is held and stays held past `timeoutMs`: refuse, naming the
 *    holder (tool, instance, host, pid, how long). Do NOT retry forever: an
 *    unbounded wait inside a deployment is indistinguishable from a hang, and
 *    an operator who cannot tell those apart eventually kills the process
 *    holding a fence.
 *  - `pg_try_advisory_lock` succeeds but the revalidation of
 *    {@link revalidateAfterAcquire} fails: release and refuse. Holding a lock
 *    on a database that is not the one the plan was built against is worse than
 *    not holding one, because it blocks the tool that IS right about the
 *    target.
 *  - the dedicated connection cannot be opened, or is a pooled handle.
 *
 * Serves spec §10 W1: "Standalone `bun run migrate` and `bun smoke` contend on
 * the target lock."
 */
export function acquireTargetLock(options: {
  readonly databaseUrl: string;
  readonly key: TargetLockKey;
  readonly holder: Omit<LockHolder, "acquiredAt">;
  readonly timeoutMs: number;
}): Promise<AcquireResult> {
  void options;
  throw new Error("NOT IMPLEMENTED: acquire the session-level target lock — spec §2, issue #1026 W1.7");
}

/**
 * §2, Revalidation: "After acquiring, the tool re-reads `deployment_identity`,
 * the ledger, and the schema manifest and re-runs the plan against them. A
 * mismatch refuses."
 *
 * The reason is a race that is easy to miss: everything the plan was built from
 * was read BEFORE the lock existed, so any of it may have changed while the
 * tool waited to acquire — including the case where the change was made by the
 * very holder this tool was queued behind. Revalidating turns "the plan was
 * true when I wrote it" into "the plan is true now, and nothing can change it
 * while I hold this".
 *
 * All three must be re-read, and a mismatch in any one refuses:
 *  - `deployment_identity` (§4.2): the target was re-enrolled, so every policy
 *    decision in the plan (§4.3) was taken against a different answer.
 *  - the migration ledger: migrations landed while waiting, so the schema the
 *    plan expects is not the schema present.
 *  - the schema manifest (§8.3): the declared schema moved, or the database is
 *    in the in-progress state of §8.3 (ledger ahead of manifest), which "boot
 *    refuses".
 *
 * Refusal cases are exactly those three mismatches plus an unreadable input —
 * a manifest or identity that cannot be read is a mismatch, not a pass.
 */
export function revalidateAfterAcquire(
  lock: TargetLock,
  expected: {
    readonly identity: "production" | "rehearsal";
    readonly ledgerHead: string | null;
    readonly manifestHash: string | null;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  void lock;
  void expected;
  throw new Error("NOT IMPLEMENTED: post-acquisition revalidation — spec §2, issue #1026 W1.7");
}

/**
 * Run one mutation inside the xact fence. THE safety primitive of §2, and the
 * only supported way for any tool in the caller list to write.
 *
 * "Every mutation (migration, grant reconciliation, seed, key rebind, schedule
 * write) runs in a transaction that first takes `pg_advisory_xact_lock` on the
 * same key, on the connection performing it."
 *
 * Implementation requirements that the sentence above makes non-negotiable:
 *  1. BEGIN, then `pg_advisory_xact_lock(key)` as the FIRST statement, then the
 *     mutation. First, because any statement before it runs outside the fence.
 *  2. The fence is taken on the MUTATING connection — the handle passed to
 *     `body` — never on the coordinating lock's connection. A fence on the
 *     coordinating connection dies when that connection dies, which is the one
 *     circumstance it exists to survive.
 *  3. The blocking form, `pg_advisory_xact_lock`, not `pg_try_*`. A competitor
 *     that reached here has already won the session lock, which means the
 *     previous holder's session is gone; it must WAIT for the in-flight
 *     transaction to finish rather than conclude it is finished.
 *  4. No release. The transaction's commit or abort is the release. An explicit
 *     unlock would reopen the window at exactly the wrong moment.
 *
 * Refusal cases:
 *  - `body` opens its own nested transaction or commits internally: the fence's
 *    scope is this transaction, and work that escapes it is unfenced work.
 *  - the fence wait exceeds a caller-supplied bound: report which key and how
 *    long, and do NOT cancel the holder. Per the invariant, "a cancellation
 *    request is not evidence the mutation stopped" — cancelling here would
 *    trade a wait for exactly the overlap this module forbids.
 *
 * Serves spec §10 W1: "Kill the lock connection mid-migration, start a second
 * mutation tool: no overlap."
 */
export function withMutationFence<T>(
  options: { readonly databaseUrl: string; readonly key: TargetLockKey; readonly label: string },
  body: (tx: DbHandle) => Promise<T>,
): Promise<T> {
  void options;
  void body;
  throw new Error("NOT IMPLEMENTED: pg_advisory_xact_lock mutation fence — spec §2, issue #1026 W1.7");
}

/**
 * §2, Connection loss: "Detected at every phase boundary; the tool journals the
 * phase and exits non-zero. No phase proceeds on a lock the tool cannot prove
 * it still holds."
 *
 * Call this at every phase boundary of §1.3 — before `prepare`, before
 * `preflight`, before `replace`, before `participants`, before `readiness`.
 *
 * "PROVE" excludes a cached boolean, a local flag set at acquisition, and the
 * absence of an error event. It means a round trip that asks the server whether
 * this session still holds this key (`pg_locks` filtered to this backend's pid
 * and the key), so that a connection which died silently — a NAT timeout, a
 * failover, a pooler that recycled the backend — is discovered here rather than
 * at the next write.
 *
 * Refusal cases: the lock is not held, the connection is dead, or the question
 * cannot be answered. All three are the same refusal: the tool journals the
 * phase (`endPhase("failed", …)` in `scripts/lib/smoke-journal.ts`) and exits
 * non-zero. It must not re-acquire and continue — between the loss and the
 * re-acquisition another tool may have run, and the journal's expectations
 * (§1.3) are the mechanism for that, not this one.
 *
 * Serves spec §10 W1: "Standalone `bun run migrate` and `bun smoke` contend on
 * the target lock, including connection loss mid-phase."
 */
export function assertStillHeld(lock: TargetLock, phase: string): Promise<void> {
  void lock;
  void phase;
  throw new Error("NOT IMPLEMENTED: phase-boundary lock proof — spec §2, issue #1026 W1.7");
}

/**
 * Read the current holder of the key, for a contention refusal.
 *
 * Output: the holder, or `null` when the key is free or the holder published no
 * identity.
 *
 * `null` must be rendered by the caller as "held by an unidentified tool", not
 * as "free": the caller only asks this question after failing to acquire, so
 * the lock IS held, and printing "not held" there would send an operator to
 * force something.
 */
export function describeHolder(lock: DbHandle, key: TargetLockKey): Promise<LockHolder | null> {
  void lock;
  void key;
  throw new Error("NOT IMPLEMENTED: identify the target-lock holder — spec §2, issue #1026 W1.7");
}
