#!/usr/bin/env bun
// The STANDING PARTICIPANT container's entrypoint
// (smoke-production-spec.md §6.2, issue #1026 W3.2). The types and the
// contract in these comments are the design; the bodies implement it.
//
// ── WHAT THIS PROCESS IS ────────────────────────────────────────────────────
// One long-lived process, one per credential-file roster entry (§6.1), running
// under `restart: unless-stopped`. It behaves exactly like a third party's
// deployment would. This loop is the AGENT's side of §6.2 — "Agents poll": it
// polls the API over HTTP for `collecting` sessions this participant has not
// yet taken, runs each take as a one-shot process in a fresh workspace
// (take-runner.ts), submits, and sleeps. A judge does not poll: "Judges
// subscribe" (§6.2), and its standing loop is the subscription in
// judge-client.ts. Routing a judge entry to that loop is not done here yet.
//
// ── THIS PROCESS HOLDS NO DATABASE CREDENTIAL AND NO DOCKER SOCKET ──────────
// State that plainly, because both have been true of predecessors and both are
// now forbidden:
//
//   - NO DATABASE CREDENTIAL. Spec §7.2 splits preflight's callers in three:
//     smoke runs the full preflight; database-holding containers (`api` and
//     the pipeline `worker`) run checks 1–3 against their own credential;
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
//     handing that code the host. The compose tests assert no service mounts
//     it; `assertNoDockerSocket` below is the runtime half, and refuses a
//     socket that reached this process by ANY route — an env var, a value
//     naming one, or a socket file on disk. A take is a PROCESS here, not a
//     container — see take-runner.ts.
//
// ── WHAT BREAKS WITHOUT THIS ────────────────────────────────────────────────
// Today the in-process driver (scripts/lib/swarm/session.ts) orchestrates
// members from the smoke host: it knows the roster, it launches each member,
// and it waits for the session. That makes the harness a participant in its
// own session, which is why `bun smoke` cannot exit at readiness (spec §1) and
// why a session dies when the invoking terminal does (§10 W1: "Sessions and
// participants survive the invoking terminal's exit"). Standing containers cut
// that tie: `system-scheduler` opens and closes each subject's sessions on its
// epoch grid whether or not this host runs any participant at all (§6.3) —
// sessions have no schedule rows and nothing to enable.
//
// ── GOVERNING SPEC SECTIONS ─────────────────────────────────────────────────
// §6.2 (standing containers, one take in flight, idempotent submission), §6.1
// (the roster entry this container was started from), §6.3 (sessions are
// independent of participants), §7.2 (HTTP-only startup diagnostic), §1
// (containers stay up under Docker; `smoke:down` is the only stop), §10 W3.
import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { resendPendingSubmissions, runTake, TAKE_COMMAND_ENV } from "./take-runner.ts";
import type { ParticipantKind, PersonaIdentity } from "../../lib/swarm/credential-file.ts";
import { isDbCredentialKey, looksLikeConnectionString } from "../../lib/db-credential-keys.ts";

/**
 * The work queue this participant polls (spec §6.2). Session coordinates only:
 * the participant fetches its own context over REST afterwards, exactly the way
 * an outside member's deployment does.
 *
 * IT IS THE CONTRACT'S PATH NOW, not a literal declared here — issue #1026 W4.
 * A client-side constant is never compared against the server's route table, so
 * a participant whose path did not exist polled a 404 for ever and read it as
 * "no work": silent, indefinite, and invisible to every test on either side.
 * `pollForWork` now treats a 404 as the defect it is. Re-exported under the old
 * name so importers keep working.
 *
 * The response shape this client accepts is `{ pending: PendingWork[] }` — a
 * list, empty when there is nothing to do. The server answers with that shape.
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
 * Key names a participant refuses beyond the shared credential list. The shared
 * list (db-credential-keys.ts) leaves out `POSTGRES_PASSWORD` because the
 * database server owns it; a participant owns nothing that names Postgres.
 */
const PARTICIPANT_DB_KEY_PATTERN = /DATABASE_URL|POSTGRES|PG_?(URL|CONN)/i;

/**
 * A participant holds NO database credential (spec §7.2). Finding one means
 * the compose profile leaked it, and that refuses rather than being ignored:
 * the leak is the defect, not the use.
 *
 * Every key AND every value is scanned. A key refuses when it is one of the
 * shared credential names (`PGPASSWORD`, `PGUSER`, `PGPASSFILE`, each
 * `RM_*_PASSWORD`, the `*DATABASE_URL`s) or names Postgres at all. A value
 * refuses when it is a connection string under any name — a `postgres://` URL
 * or a libpq keyword DSN. The refusal names the KEY, never the value.
 */
function assertNoDatabaseCredential(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isDbCredentialKey(key) || PARTICIPANT_DB_KEY_PATTERN.test(key) || looksLikeConnectionString(value)) {
      throw new Error(
        `${key} is present in a participant container's environment; a participant holds no database credential (spec §7.2)`,
      );
    }
  }
}

/**
 * Where a Docker daemon socket lives when one is mounted into a container: the
 * two conventional system paths, and the rootless daemon's path under
 * `XDG_RUNTIME_DIR` when that is set. Probed by `assertNoDockerSocket`.
 */
export function defaultDockerSocketProbes(env: Record<string, string | undefined>): string[] {
  const probes: string[] = [];
  const runtimeDir = (env.XDG_RUNTIME_DIR ?? "").trim();
  if (runtimeDir !== "") probes.push(join(runtimeDir, "docker.sock"));
  probes.push("/var/run/docker.sock", "/run/docker.sock");
  return probes;
}

/** A Docker (or Podman) client setting that points at a daemon. */
const DOCKER_KEY_PATTERN = /^(DOCKER_[A-Z0-9_]*(HOST|SOCK|CONTEXT|TLS|CERT)[A-Z0-9_]*|CONTAINER_HOST)$/i;

/** A value naming a daemon socket file, wherever it is. */
const SOCKET_VALUE_PATTERN = /(docker|podman)\.sock/i;

/**
 * A participant holds NO Docker socket (spec §6.2, §3). A socket is root on the
 * host, and this process runs model-authored code in its children.
 *
 * Refuses, naming what it found, when:
 *   - `DOCKER_HOST` (any scheme: `unix://`, `tcp://`, `ssh://`), `CONTAINER_HOST`,
 *     or any `DOCKER_*` host, socket, context or TLS setting is set;
 *   - any environment value names a `docker.sock` / `podman.sock` path;
 *   - a probe path is a socket on disk — checked with `lstat().isSocket()`,
 *     and through a symlink with `stat()`, because a bind-mounted socket is
 *     the route that needs no environment at all.
 *
 * `probePaths` is injectable so the gate can be driven with a real socket in a
 * temp directory; the default is `defaultDockerSocketProbes(env)`. A probe
 * path that does not exist, or cannot be inspected, is not a finding.
 */
export function assertNoDockerSocket(
  env: Record<string, string | undefined>,
  probePaths: readonly string[] = defaultDockerSocketProbes(env),
): void {
  for (const [key, value] of Object.entries(env)) {
    const text = (value ?? "").trim();
    if (text === "") continue;
    if (DOCKER_KEY_PATTERN.test(key)) {
      throw new Error(
        `${key} is set in a participant container's environment; a participant holds no Docker socket (spec §6.2)`,
      );
    }
    if (SOCKET_VALUE_PATTERN.test(text)) {
      throw new Error(
        `${key} names a container daemon socket; a participant holds no Docker socket (spec §6.2)`,
      );
    }
  }
  for (const path of probePaths) {
    if (isSocketFile(path)) {
      throw new Error(
        `${path} is a socket inside this participant container; a participant holds no Docker socket (spec §6.2)`,
      );
    }
  }
}

function isSocketFile(path: string): boolean {
  try {
    const link = lstatSync(path);
    if (link.isSocket()) return true;
    return link.isSymbolicLink() && statSync(path).isSocket();
  } catch {
    // Absent or uninspectable: nothing is mounted there that this process can use.
    return false;
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
  /**
   * The argv of the one-shot that authors a take (`RM_TAKE_COMMAND`, a JSON
   * array or a whitespace-separated command). Required for an agent; empty for
   * a judge, whose model work is not a take.
   */
  takeCommand: string[];
  /** Poll cadence for the work loop. */
  pollIntervalMs: number;
  /** Wall-clock ceiling for one take's one-shot process. */
  takeTimeoutMs: number;
  /** Parent directory under which each take gets a FRESH workspace. */
  workspaceRoot: string;
  /** The spoof-keys generation this container holds, when any (spec §6.4). */
  generationId?: string;
}

/** Options for `readParticipantConfig`; the gates inject the socket probes. */
export interface ReadParticipantConfigOptions {
  /** Paths probed for a mounted daemon socket. Default: `defaultDockerSocketProbes`. */
  dockerSocketProbePaths?: readonly string[];
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
 * credential anywhere in the environment is ALSO a refusal, and so is a Docker
 * socket reached by any route: this process must hold neither, and finding one
 * means the compose profile leaked it (spec §7.2, §6.2).
 *
 * Gate (spec §10 W3): "Judge runs as a participant" — a judge container is
 * configured through this same function with `kind: "judge"`.
 */
export function readParticipantConfig(
  env: Record<string, string | undefined>,
  options: ReadParticipantConfigOptions = {},
): ParticipantConfig {
  assertNoDatabaseCredential(env);
  assertNoDockerSocket(env, options.dockerSocketProbePaths ?? defaultDockerSocketProbes(env));
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

  const takeCommand = parseTakeCommand(env[TAKE_COMMAND_ENV]);
  if (kindValue === "agent" && takeCommand.length === 0) {
    // An agent without a take command polls, is offered work, and can never
    // author it. Refusing at boot names the gap; failing every take hides it.
    throw new Error(`${TAKE_COMMAND_ENV} was not injected into this agent participant container`);
  }

  const generationId = (env.RM_SPOOF_GENERATION_ID ?? "").trim();
  return {
    apiUrl: required(env, "RM_API_URL").replace(/\/+$/, ""),
    name: required(env, "RM_MEMBER_NAME"),
    kind: kindValue,
    memberId: required(env, "RM_MEMBER_ID"),
    token: required(env, "RM_MEMBER_TOKEN"),
    identity: { publicKeyB64: identity.publicKeyB64, privateJwk: identity.privateJwk },
    takeCommand,
    pollIntervalMs: positiveInt(env.RM_POLL_INTERVAL_MS, 5_000),
    takeTimeoutMs: positiveInt(env.RM_TAKE_TIMEOUT_MS, 600_000),
    workspaceRoot: (env.RM_WORKSPACE_ROOT ?? "").trim() || "/var/lib/rm/takes",
    ...(generationId === "" ? {} : { generationId }),
  };
}

/**
 * The injected one-shot argv: a JSON array of strings, or a plain command split
 * on whitespace. A value that starts as a JSON array and does not parse as one
 * REFUSES — guessing a command to run as the member is worse than not starting.
 */
function parseTakeCommand(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (text === "") return [];
  if (!text.startsWith("[")) return text.split(/\s+/);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${TAKE_COMMAND_ENV} is not a JSON array: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((v) => typeof v === "string" && v !== "")) {
    throw new Error(`${TAKE_COMMAND_ENV} must be a non-empty JSON array of non-empty strings`);
  }
  return parsed as string[];
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
  /**
   * The API ANSWERED the token question: a 2xx, or an authentication refusal
   * (401/403). A transport failure, a 5xx or any other status is `false` —
   * a server that cannot answer has said nothing about the token.
   */
  apiReachable: boolean;
  /** The API accepted this bearer. Only meaningful when `apiReachable`. */
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
 * Three facts, kept apart: an unreachable or failing API (`apiReachable:
 * false`) is not an invalid token, and only a 401/403 says the token is
 * invalid. Reporting a 5xx as an invalid token would send an operator to
 * rotate a credential that was fine while the API was the thing that broke.
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
  // Only an authentication refusal says the token is invalid. A 5xx, a 404 or
  // anything else is the API failing to answer, not an answer.
  if (res.status === 401 || res.status === 403) return { ...unreachable, apiReachable: true };
  if (!res.ok) return unreachable;
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
 * The response shape is `{ pending: PendingWork[] }`: a list, empty when there
 * is nothing to do.
 *
 * One at a time, deliberately: spec §6.2 allows one take in flight per
 * participant, so this returns at most one item and the loop does not fetch
 * the next until the current take finished.
 *
 * Refusals, which are what keep a missing route from looking like an idle one:
 *   - a transport error or a 5xx is NOT a refusal — it returns `null`, and the
 *     loop sleeps and retries, because the API restarting during a deploy must
 *     not kill every participant;
 *   - a 401 IS terminal: the token was revoked or the key was rebound (spec
 *     §6.4 step 2), and the container should exit so the supervisor restarts
 *     it against its current configuration;
 *   - a 404 or any other 4xx THROWS: the route is missing or refuses this
 *     participant, and reading that as "no work" is how a participant polled a
 *     missing route for ever in silence;
 *   - a 2xx whose body is not `{ pending: [...] }` THROWS for the same reason:
 *     a contract this client cannot read is a defect, not an empty queue.
 */
export async function pollForWork(config: ParticipantConfig): Promise<PendingWork | null> {
  const url = `${config.apiUrl}${PARTICIPANT_PENDING_PATH}?member=${encodeURIComponent(config.memberId)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${config.token}` } });
  } catch {
    // The API restarting during a deploy must not kill every participant.
    return null;
  }
  if (res.status === 401) {
    // Terminal: the token was revoked or the key was rebound (spec §6.4 step 2).
    throw new Error(`participant poll refused with HTTP 401: this member token is no longer valid`);
  }
  if (res.status >= 500) return null;
  if (!res.ok) {
    // A missing route is a defect to surface, never an idle queue.
    throw new Error(
      `participant poll of ${PARTICIPANT_PENDING_PATH} answered HTTP ${res.status}; `
        + (res.status === 404
          ? "the pending-work route does not exist on this API, which is not the same as no work"
          : "the API refuses this participant's poll"),
    );
  }
  let body: { pending?: unknown } | null = null;
  try {
    body = (await res.json()) as { pending?: unknown };
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.pending)) {
    throw new Error(
      `participant poll of ${PARTICIPANT_PENDING_PATH} returned a body that is not { pending: PendingWork[] }`,
    );
  }
  // AT MOST ONE: spec §6.2 allows one take in flight per participant.
  const first = body.pending[0] as Partial<PendingWork> | undefined;
  if (!first || typeof first.sessionId !== "string" || first.sessionId === "") return null;
  return {
    sessionId: first.sessionId,
    subjectId: typeof first.subjectId === "string" ? first.subjectId : "",
    date: typeof first.date === "string" ? first.date : "",
  };
}

/**
 * The loop: diagnose, then resend → poll → take → report → sleep, forever.
 *
 * Inputs: the configuration and an optional abort signal (SIGTERM from
 * `docker stop`). Output: never returns normally; it runs until aborted.
 *
 * On abort it stops accepting new work and lets the in-flight take finish or
 * time out, then exits zero. A hard kill mid-take is also safe (D52): a take is
 * written to its workspace, signed, BEFORE it is sent, so each iteration first
 * resends any signed submission the server has not confirmed — the same bytes
 * and the same nonce — and never authors it again.
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
    // A signed submission the server never confirmed goes out again first, as
    // the same bytes: a crash-restart resends, it never re-authors.
    for (const outcome of await resendPendingSubmissions(config)) {
      console.log(`[${config.kind}:${config.name}] ${JSON.stringify(outcome)}`);
    }
    const work = await pollForWork(config);
    if (work) {
      // One take at a time: the next poll waits for this take to finish.
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
