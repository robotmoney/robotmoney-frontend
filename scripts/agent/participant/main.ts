#!/usr/bin/env bun
// The STANDING PARTICIPANT container's entrypoint
// (smoke-production-spec.md §6.2, issue #1026 W3.2). The types and the
// contract in these comments are the design; the bodies implement it.
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
import { ROUTES } from "@robotmoney/contract";
import { runTake } from "./take-runner.ts";
import type { PersonaIdentity } from "../../lib/swarm/persona-keys.ts";
import type { ParticipantKind } from "../../lib/swarm/credential-file.ts";

/**
 * The work queue this participant polls (spec §6.2). Session coordinates only:
 * the participant fetches its own context over REST afterwards, exactly the way
 * an outside member's deployment does.
 *
 * IT IS THE CONTRACT'S PATH NOW, not a literal declared here — issue #1026 W4.
 * A client-side constant is never compared against the server's route table, so
 * a participant whose path did not exist polled a 404 for ever and read it as
 * "no work": silent, indefinite, and invisible to every test on either side.
 * Re-exported under the old name so importers keep working.
 */
export const PARTICIPANT_PENDING_PATH: string = ROUTES.swarm.participants.pending;

/**
 * Environment names the compose `participant` profile injects. RM_API_URL /
 * RM_MEMBER_ID / RM_MEMBER_TOKEN / RM_MEMBER_NAME / RM_MEMBER_IDENTITY are the
 * names the existing member rail already uses; the participant-only settings
 * extend the same prefix.
 */
const REQUIRED_ENV = [
  "RM_API_URL",
  "RM_MEMBER_NAME",
  "RM_MEMBER_ID",
  "RM_MEMBER_TOKEN",
  "RM_MEMBER_IDENTITY",
] as const;

/**
 * A participant holds NO database credential (spec §7.2). Finding one means
 * the compose profile leaked it, and that refuses rather than being ignored:
 * the leak is the defect, not the use.
 */
function assertNoDatabaseCredential(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    const looksLikeName = /DATABASE_URL|POSTGRES|PG_?(URL|CONN)/i.test(key);
    const looksLikeValue = /^(postgres|postgresql):\/\//i.test((value ?? "").trim());
    if (looksLikeName || looksLikeValue) {
      throw new Error(
        `${key} is present in a participant container's environment; a participant holds no database credential (spec §7.2)`,
      );
    }
  }
}

/** A required value, refusing by NAME so the crash loop is readable. */
function required(env: Record<string, string | undefined>, key: string): string {
  const value = (env[key] ?? "").trim();
  if (value === "") throw new Error(`${key} was not injected into this participant container`);
  return value;
}

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
  assertNoDatabaseCredential(env);
  for (const key of REQUIRED_ENV) required(env, key);

  const kindValue = (env.RM_PARTICIPANT_KIND ?? "agent").trim() || "agent";
  if (kindValue !== "agent" && kindValue !== "judge") {
    throw new Error(
      `RM_PARTICIPANT_KIND=${kindValue} is not a participant kind; there are exactly two namespaces, agent and judge`,
    );
  }

  const identityRaw = required(env, "RM_MEMBER_IDENTITY");
  let identityParsed: unknown;
  try {
    identityParsed = JSON.parse(identityRaw);
  } catch (err) {
    throw new Error(
      `RM_MEMBER_IDENTITY is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const identity = identityParsed as Partial<PersonaIdentity> | null;
  if (!identity || typeof identity !== "object" || typeof identity.publicKeyB64 !== "string" || identity.publicKeyB64 === "") {
    throw new Error("RM_MEMBER_IDENTITY carries no publicKeyB64");
  }
  if (!identity.privateJwk || typeof identity.privateJwk !== "object") {
    // A key it cannot sign with is not a key.
    throw new Error("RM_MEMBER_IDENTITY carries no privateJwk");
  }

  const generationId = (env.RM_SPOOF_GENERATION_ID ?? "").trim();
  return {
    apiUrl: required(env, "RM_API_URL").replace(/\/+$/, ""),
    name: required(env, "RM_MEMBER_NAME"),
    kind: kindValue,
    memberId: required(env, "RM_MEMBER_ID"),
    token: required(env, "RM_MEMBER_TOKEN"),
    identity: { publicKeyB64: identity.publicKeyB64, privateJwk: identity.privateJwk },
    pollIntervalMs: positiveInt(env.RM_POLL_INTERVAL_MS, 5_000),
    takeTimeoutMs: positiveInt(env.RM_TAKE_TIMEOUT_MS, 600_000),
    workspaceRoot: (env.RM_WORKSPACE_ROOT ?? "").trim() || "/var/lib/rm/takes",
    ...(generationId === "" ? {} : { generationId }),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const unreachable: StartupDiagnostic = {
    apiReachable: false,
    tokenValid: false,
    serverMemberId: null,
    identityMatchesRoster: false,
  };
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${ROUTES.swarm.verifyToken}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
  } catch {
    // Unreachable is not the same fact as an invalid token.
    return unreachable;
  }
  if (!res.ok) return { ...unreachable, apiReachable: true };
  let body: { memberId?: unknown } | null = null;
  try {
    body = (await res.json()) as { memberId?: unknown };
  } catch {
    return { ...unreachable, apiReachable: true };
  }
  const serverMemberId = typeof body?.memberId === "string" && body.memberId !== "" ? body.memberId : null;
  return {
    apiReachable: true,
    tokenValid: serverMemberId !== null,
    serverMemberId,
    // Reported, never adopted: a container authenticating as somebody else has
    // been handed the wrong key.
    identityMatchesRoster: serverMemberId === config.memberId,
  };
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
  let res: Response;
  try {
    res = await fetch(
      `${config.apiUrl}${PARTICIPANT_PENDING_PATH}?member=${encodeURIComponent(config.memberId)}`,
      { headers: { Authorization: `Bearer ${config.token}` } },
    );
  } catch {
    // The API restarting during a deploy must not kill every participant.
    return null;
  }
  if (res.status === 401) {
    // Terminal: the token was revoked or the key was rebound (spec §6.4 step 2).
    throw new Error(`participant poll refused with HTTP 401: this member token is no longer valid`);
  }
  if (!res.ok) return null;
  let body: { pending?: unknown } | null = null;
  try {
    body = (await res.json()) as { pending?: unknown };
  } catch {
    return null;
  }
  const pending = Array.isArray(body?.pending) ? body.pending : [];
  // AT MOST ONE: spec §6.2 allows one take in flight per participant, and
  // batching reintroduces the overlap the idempotent key exists to bound.
  const first = pending[0] as Partial<PendingWork> | undefined;
  if (!first || typeof first.sessionId !== "string" || first.sessionId === "") return null;
  return {
    sessionId: first.sessionId,
    subjectId: typeof first.subjectId === "string" ? first.subjectId : "",
    date: typeof first.date === "string" ? first.date : "",
  };
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
  const diagnostic = await runStartupDiagnostic(config);
  if (!diagnostic.apiReachable || !diagnostic.tokenValid || !diagnostic.identityMatchesRoster) {
    throw new Error(
      `participant ${config.kind} ${config.name} refuses to poll: `
      + `apiReachable=${diagnostic.apiReachable} tokenValid=${diagnostic.tokenValid} `
      + `serverMemberId=${diagnostic.serverMemberId ?? "none"} expected=${config.memberId}`,
    );
  }
  while (!signal?.aborted) {
    const work = await pollForWork(config);
    if (work) {
      // One take at a time: the next poll waits for this take to finish, and a
      // hard kill mid-take is bounded by the idempotent submission key.
      const outcome = await runTake(config, work);
      console.log(`[${config.kind}:${config.name}] ${JSON.stringify(outcome)}`);
      continue;
    }
    await sleep(config.pollIntervalMs, signal);
  }
}

/** Sleep, but wake immediately when `docker stop` sends its SIGTERM. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

if (import.meta.main) {
  const controller = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => controller.abort());
  }
  try {
    await runParticipantLoop(readParticipantConfig(process.env), controller.signal);
  } catch (err) {
    // A misconfigured participant crash-loops visibly under
    // `restart: unless-stopped`, which is the correct outcome.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
