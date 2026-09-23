// The PER-TAKE one-shot runner (smoke-production-spec.md §6.2, issue #1026
// W3.2). STEP 1 STUB: every function throws NOT IMPLEMENTED; the types and the
// idempotency argument below are the deliverable of this step.
//
// ── A TAKE IS A PROCESS, NOT A CONTAINER ────────────────────────────────────
// Say it plainly because the predecessor got it wrong. Issue #1014 ran each
// judge in a short-lived CONTAINER started through an `agent-launcher` service
// that mounted `/var/run/docker.sock`. The spec forbids the socket anywhere
// (§6.2). A standing participant container cannot start containers, and does
// not need to: the isolation a take needs is a fresh working directory, a
// wall-clock timeout, and a process group that can be killed as one. All three
// are available to an ordinary child process, and none of them requires root
// on the host.
//
// ── WHY FRESH PER TAKE ──────────────────────────────────────────────────────
// A model-authoring run writes into its working directory — transcripts,
// caches, scratch files. Reusing one directory across takes lets one session's
// residue reach the next session's authoring call, which is both a correctness
// problem (a take influenced by a prior subject) and an unbounded disk growth
// problem in a container that is supposed to run for weeks. A fresh directory
// per take, removed in a `finally`, makes both impossible by construction
// rather than by a cleanup routine somebody has to remember to call.
//
// ── WHY A PROCESS GROUP ─────────────────────────────────────────────────────
// The authoring call is a CLI that itself spawns children. Killing the direct
// child on timeout leaves its grandchildren holding the workspace and the
// model credential. The one-shot therefore runs in its own process group and
// the timeout kills the GROUP. Without that, a hung take leaks a process per
// occurrence into a container that never restarts, until the container runs
// out of memory hours later and the restart looks unrelated to the take that
// caused it.
//
// ── IDEMPOTENT SUBMISSION IS WHAT MAKES ALL OF THIS SAFE (§6.2) ─────────────
// Take identity is `(session, member)`, UNIQUE SERVER-SIDE (W3.3 adds the
// index if one is missing). A resubmission on an existing key returns the
// EXISTING record, and the participant treats that as SUCCESS — not as a
// conflict, not as an error to retry, not as a reason to author a second take.
//
// That single rule closes the two failure modes standing containers otherwise
// have:
//
//   - CRASH AFTER SUBMIT. The container dies between the server committing the
//     submission and the participant recording that it did. `restart:
//     unless-stopped` brings it back, it polls, and the session still lists it
//     as wanted (the API has not yet told it otherwise, or it re-polls before
//     the state propagates). It authors again and submits again. The server
//     returns the record that already exists. Result: ONE take, one redundant
//     request.
//   - OLD/NEW CONTAINER OVERLAP DURING A ROSTER CHANGE. Reconciliation stops
//     the old container and starts the new one; for a moment both may be
//     alive. Both poll, both may submit. Same key, same outcome: ONE take.
//
// The cost is a redundant authoring call. The alternative — client-side
// dedupe, or a "did I already submit?" read before authoring — is a race in
// both directions and cannot survive a crash between the read and the write.
// The server-side unique key can.
//
// ── GOVERNING SPEC SECTIONS ─────────────────────────────────────────────────
// §6.2 (one-shot per take, fresh workspace, timeout, process-group cleanup,
// idempotent submission, one take in flight), §10 W3 ("Participant crash after
// submit: one take"; "Roster change with overlapping containers: one take").
import type { ParticipantConfig, PendingWork } from "./main.ts";

/**
 * A take's disposable working directory. `dispose()` is called in a `finally`
 * regardless of how the take ended, so a crashed, timed-out, or refused take
 * leaves nothing behind.
 */
export interface TakeWorkspace {
  /** Absolute path, unique to this (session, member) attempt. */
  path: string;
  dispose(): void;
}

/**
 * Create the fresh per-take workspace.
 *
 * Inputs: the root directory from the container configuration, and the session
 * and member the workspace belongs to (so a leaked directory can be traced to
 * the take that made it). Output: a `TakeWorkspace`.
 *
 * Refusals: an unwritable root throws — the container is misconfigured, and
 * authoring into an unknown directory is worse than failing the take.
 */
export function createTakeWorkspace(
  root: string,
  sessionId: string,
  memberId: string,
): TakeWorkspace {
  throw new Error(
    "NOT IMPLEMENTED: create the fresh per-take workspace — spec §6.2, issue #1026 W3.2",
  );
}

/**
 * How the one-shot ended. `timeout` and `crashed` are distinct because they
 * call for different operator responses: a timeout means the take budget or
 * the model is too slow, a crash means the shim or its inputs are broken.
 */
export type OneShotStatus = "ok" | "timeout" | "crashed";

/** The result of running the one-shot process for a single take. */
export interface OneShotResult {
  status: OneShotStatus;
  exitCode: number | null;
  /** Bounded, redacted stdout — the model credential never appears in it. */
  stdout: string;
  /** Bounded, redacted stderr. */
  stderr: string;
  durationMs: number;
}

/**
 * Run the one-shot process for one take, in its own process group, under a
 * wall-clock timeout.
 *
 * Inputs: the workspace, the argv to run, the environment to inject (a child
 * inherits only what is passed), and the timeout in milliseconds. Output: a
 * `OneShotResult`.
 *
 * On timeout the whole process GROUP is killed — SIGTERM, then SIGKILL after a
 * grace period — and the status is `timeout`. Both pipes are drained
 * throughout: a child that fills a pipe buffer while nobody reads it blocks
 * forever and turns every timeout into the maximum timeout.
 *
 * Refusals: none; a failure is a returned status, not a throw, because the
 * caller must always reach its `finally` and dispose the workspace.
 */
export async function runOneShot(
  workspace: TakeWorkspace,
  argv: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<OneShotResult> {
  throw new Error(
    "NOT IMPLEMENTED: run the per-take one-shot in its own process group — spec §6.2, issue #1026 W3.2",
  );
}

/**
 * The outcome of the submission call. `already_submitted` is a SUCCESS value,
 * not an error: it is the server reporting that this `(session, member)` key
 * already holds a record, which is exactly what a crash-after-submit or a
 * container overlap produces.
 */
export type SubmissionStatus = "submitted" | "already_submitted" | "refused";

export interface SubmissionResult {
  status: SubmissionStatus;
  /** The server's record for `(session, member)` — new or pre-existing. */
  takeId: string | null;
  /** True only when the server verified this submission's signature. */
  verified: boolean;
  /** Present for `refused`: the server's reason, bounded. */
  reason?: string;
}

/**
 * Submit the authored take, signing the canonical bytes the API returns.
 *
 * Inputs: the participant configuration (for the bearer and the key), the work
 * coordinates, and the authored draft. Output: a `SubmissionResult`.
 *
 * The canonical bytes are FETCHED from the signing-payload endpoint and signed
 * exactly as returned — never reconstructed locally. The server's response is
 * the protocol authority, and a locally reconstructed payload that drifts by a
 * byte produces a valid signature over the wrong message.
 *
 * Idempotency: a resubmission on an existing `(session, member)` key returns
 * `already_submitted` with the existing record, and the caller treats it as
 * success. There is no retry-on-conflict branch and no second authoring.
 *
 * Refusals: `refused` for a signature the server rejects — which is exactly
 * what a superseded spoof-keys generation produces (spec §6.4), and the reason
 * that tolerated window is harmless. A transport error throws, and the take is
 * retried on the next poll, where idempotency bounds the outcome to one take.
 *
 * Gates (spec §10 W3): "Participant crash after submit: one take"; "Roster
 * change with overlapping containers: one take."
 */
export async function submitTake(
  config: ParticipantConfig,
  work: PendingWork,
  draft: Record<string, unknown>,
): Promise<SubmissionResult> {
  throw new Error(
    "NOT IMPLEMENTED: sign and submit the take idempotently on (session, member) — spec §6.2, issue #1026 W3.2/W3.3",
  );
}

/** What one take attempt reports back to the poll loop. */
export interface TakeOutcome {
  sessionId: string;
  memberId: string;
  oneShot: OneShotStatus;
  submission: SubmissionStatus | null;
  durationMs: number;
  /** Bounded operator-facing reason when the take did not submit. */
  reason?: string;
}

/**
 * Run one complete take: fresh workspace → one-shot → submit → dispose.
 *
 * Inputs: the participant configuration and the work item. Output: a
 * `TakeOutcome` the loop logs.
 *
 * The workspace is disposed in a `finally`, on every path including timeout
 * and crash. Disposal never masks the take's own failure.
 *
 * Refusals: none propagate — a take that fails is a reported outcome, because
 * one bad session must not take down a container that has weeks of later
 * sessions to serve. The one exception is an authentication failure, which the
 * loop treats as terminal (see main.ts `pollForWork`).
 */
export async function runTake(
  config: ParticipantConfig,
  work: PendingWork,
): Promise<TakeOutcome> {
  throw new Error(
    "NOT IMPLEMENTED: run one take end to end — spec §6.2, issue #1026 W3.2",
  );
}
