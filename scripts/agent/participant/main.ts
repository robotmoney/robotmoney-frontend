#!/usr/bin/env bun
// The STANDING PARTICIPANT container's entrypoint
// (smoke-production-spec.md §6.2, issue #1026 W3.2). STEP 1 STUB: every
// function throws NOT IMPLEMENTED; the types and the contract in these
// comments are the deliverable of this step.
//
// ── WHAT THIS PROCESS IS ────────────────────────────────────────────────────
// One long-lived process, one per credential-file roster entry (§6.1), running
// under `restart: unless-stopped`. It behaves exactly like a third party's
// deployment would: it polls the API over HTTP for sessions that need THIS
// participant, runs each take as a one-shot process in a fresh workspace
// (take-runner.ts), reports, and sleeps. A judge entry runs the same loop with
// judge-runner.ts as its one-shot (§6.2: "The judge is a participant exactly
// like an agent").
//
// ── THIS PROCESS HOLDS NO DATABASE CREDENTIAL AND NO DOCKER SOCKET ──────────
// State that plainly, because both have been true of predecessors and both are
// now forbidden:
//
//   - NO DATABASE CREDENTIAL. Spec §7.2 splits preflight's callers in three:
//     smoke runs the full preflight; database-holding containers (`api`,
//     `worker`, `worker-swarm`) run checks 1–3 against their own credential;
//     participants hold no credential at all and their startup diagnostic is
//     HTTP — API reachable, token valid, identity matches the roster entry.
//     A participant is a client of the API in exactly the sense an outside
//     member is. If it held a database token, the "third parties may supply
//     every participant" property of §6.3 would be a fiction, because our own
//     participants would be running on a rail nobody else can run on.
//
//   - NO DOCKER SOCKET. Issue #1014 mounted `/var/run/docker.sock` into an
//     `agent-launcher` service so a judge could be started as a short-lived
//     container. The spec forbids the socket anywhere (§6.2) and the secret
//     management direction forbids it outright: the socket is root on the
//     host, and handing it to a process that runs model-authored code is
//     handing that code the host. Phase 0 of the deployment-refactor plan
//     reverts that mechanism and pins the reversal with a test asserting ZERO
//     services mount it, in every composition. A take is a PROCESS here, not a
//     container — see take-runner.ts.
//
// ── WHAT BREAKS WITHOUT THIS ────────────────────────────────────────────────
// Today the in-process driver (scripts/lib/swarm/session.ts) orchestrates
// members from the smoke host: it knows the roster, it launches each member,
// and it waits for the session. That makes the harness a participant in its
// own session, which is why `bun smoke` cannot exit at readiness (spec §1) and
// why a session dies when the invoking terminal does (§10 W1: "Sessions and
// participants survive the invoking terminal's exit"). Standing containers cut
// that tie: sessions are scheduled by `worker-swarm` from `job_schedules` rows
// whether or not this host runs any participant at all (§6.3).
//
// ── GOVERNING SPEC SECTIONS ─────────────────────────────────────────────────
// §6.2 (standing containers, one take in flight, idempotent submission), §6.1
// (the roster entry this container was started from), §6.3 (sessions are
// independent of participants), §7.2 (HTTP-only startup diagnostic), §1
// (containers stay up under Docker; `smoke:down` is the only stop), §10 W3.
import type { PersonaIdentity } from "../../lib/swarm/persona-keys.ts";
import type { ParticipantKind } from "../../lib/swarm/credential-file.ts";

/**
 * The container's whole configuration, read once at startup from the
 * environment the compose `participant` profile injects. A container inherits
 * nothing: every value here is an explicit injection, and the only key present
 * is this participant's own (spec §6.1).
 */
export interface ParticipantConfig {
  /** Compose-internal API base, e.g. `http://website-server:8080`. */
  apiUrl: string;
  /** The roster name this container was started for (spec §6.1). */
  name: string;
  kind: ParticipantKind;
  /** Server-minted member id; the identity the diagnostic must confirm. */
  memberId: string;
  /** This participant's bearer. Never another participant's. */
  token: string;
  /** This participant's own key, from its credential-file entry. */
  identity: PersonaIdentity;
  /** Poll cadence for the work loop. */
  pollIntervalMs: number;
  /** Wall-clock ceiling for one take's one-shot process. */
  takeTimeoutMs: number;
  /** Parent directory under which each take gets a FRESH workspace. */
  workspaceRoot: string;
  /** The spoof-keys generation this container holds, when any (spec §6.4). */
  generationId?: string;
}

/**
 * Read and validate the configuration from the container environment.
 *
 * Input: the process environment. Output: a `ParticipantConfig`.
 *
 * Refusals: a missing or empty required value throws and the process exits
 * non-zero — under `restart: unless-stopped` that becomes a visible crash
 * loop, which is the correct outcome for a misconfigured participant and far
 * better than a container that starts, polls, and never takes. A database
 * connection string appearing anywhere in the environment is ALSO a refusal:
 * this process must not hold one, and finding one means the compose profile
 * leaked a credential (spec §7.2).
 *
 * Gate (spec §10 W3): "Judge runs as a participant" — a judge container is
 * configured through this same function with `kind: "judge"`.
 */
export function readParticipantConfig(
  env: Record<string, string | undefined>,
): ParticipantConfig {
  throw new Error(
    "NOT IMPLEMENTED: read participant container configuration — spec §6.2, issue #1026 W3.2",
  );
}

/**
 * The HTTP-only startup diagnostic of spec §7.2. Three questions, no database:
 * is the API reachable, is this token valid, and does it authenticate as the
 * member id this container was started for.
 */
export interface StartupDiagnostic {
  apiReachable: boolean;
  tokenValid: boolean;
  /** The member id the SERVER says this token is, or `null` when invalid. */
  serverMemberId: string | null;
  /** `serverMemberId === config.memberId`. */
  identityMatchesRoster: boolean;
}

/**
 * Run the startup diagnostic before entering the poll loop.
 *
 * Input: the configuration. Output: the diagnostic result.
 *
 * It is HTTP only: no `psql`, no connection string, no schema question. A
 * participant is not entitled to know the database exists.
 *
 * Refusals: the CALLER refuses on any false field. The identity mismatch in
 * particular must refuse rather than adopt the server's answer — a container
 * that discovers it is authenticating as somebody else has been handed the
 * wrong key, and continuing would submit one member's take under another's
 * name.
 *
 * Gate (spec §10 W3): "Judge runs as a participant; nothing judges inline."
 */
export async function runStartupDiagnostic(
  config: ParticipantConfig,
): Promise<StartupDiagnostic> {
  throw new Error(
    "NOT IMPLEMENTED: HTTP-only participant startup diagnostic — spec §7.2, issue #1026 W3.2",
  );
}

/**
 * One unit of work the API says this participant is wanted for. Session
 * coordinates only — the participant fetches its own context over REST, the
 * way the member session client already does, because the harness supplies no
 * context to a member.
 */
export interface PendingWork {
  sessionId: string;
  subjectId: string;
  date: string;
}

/**
 * Poll the API for a session that needs THIS participant.
 *
 * Input: the configuration. Output: one `PendingWork`, or `null` when there is
 * nothing to do.
 *
 * One at a time, deliberately: spec §6.2 allows one take in flight per
 * participant, so this returns at most one item and the loop does not fetch
 * the next until the current take finished. Batching would reintroduce the
 * overlap that the idempotent submission key exists to bound.
 *
 * Refusals: a transport error is NOT a refusal — it is logged and the loop
 * sleeps and retries, because the API restarting during a deploy must not kill
 * every participant. A 401 IS terminal: the token was revoked or the key was
 * rebound (spec §6.4 step 2), and the container should exit so the supervisor
 * restarts it against its current configuration.
 */
export async function pollForWork(config: ParticipantConfig): Promise<PendingWork | null> {
  throw new Error(
    "NOT IMPLEMENTED: poll the API for sessions needing this participant — spec §6.2, issue #1026 W3.2",
  );
}

/**
 * The loop: diagnose, then poll → take → report → sleep, forever.
 *
 * Inputs: the configuration and an optional abort signal (SIGTERM from
 * `docker stop`). Output: never returns normally; it runs until aborted.
 *
 * On abort it stops accepting new work and lets the in-flight take finish or
 * time out, then exits zero. A hard kill mid-take is also safe, which is the
 * point of the idempotent submission key (take-runner.ts): the worst outcome
 * of a crash after submitting is a redundant request on the next attempt.
 *
 * Refusals: a failed startup diagnostic exits non-zero before the first poll.
 *
 * Gates (spec §10 W3): "Participant crash after submit: one take"; "Roster
 * change with overlapping containers: one take"; (§10 W1) "Sessions and
 * participants survive the invoking terminal's exit."
 */
export async function runParticipantLoop(
  config: ParticipantConfig,
  signal?: AbortSignal,
): Promise<void> {
  throw new Error(
    "NOT IMPLEMENTED: standing participant poll loop — spec §6.2, issue #1026 W3.2",
  );
}

if (import.meta.main) {
  throw new Error(
    "NOT IMPLEMENTED: participant container entrypoint — spec §6.2, issue #1026 W3.2",
  );
}
