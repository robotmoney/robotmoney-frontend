// The PER-TAKE one-shot runner (smoke-production-spec.md §6.2, issue #1026
// W3.2). The types and the idempotency argument below are the design; the
// bodies implement it.
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
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import type { ParticipantConfig, PendingWork } from "./main.ts";

/**
 * The one-shot's argv, injected like everything else this container receives
 * (spec §6.2: a container inherits nothing). Compose injects the judge's shim
 * — `bun scripts/agent/participant/judge-runner.ts` — for a judge entry and the
 * authoring CLI for an agent entry. A participant with none reports a failed
 * take rather than guessing a binary to run as the member.
 */
export const TAKE_COMMAND_ENV = "RM_TAKE_COMMAND";

/** The single stdout tag the one-shot prints its authored draft on. */
export const TAKE_DRAFT_TAG = "RM_TAKE_DRAFT";

/** Output is a label, not a payload: enough to read, bounded against a flood. */
const OUTPUT_MAX = 64 * 1024;

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
  // An unwritable root throws: authoring into an unknown directory is worse
  // than failing the take, and the error names the root that was configured.
  mkdirSync(root, { recursive: true });
  // `mkdtemp` is what makes two attempts at the SAME (session, member) two
  // directories: a retry never inherits the previous attempt's residue.
  const path = mkdtempSync(join(root, `take-${sessionId}-${memberId}-`));
  return {
    path,
    dispose(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
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
  const started = Date.now();
  const [command, ...args] = argv;
  if (!command) {
    return { status: "crashed", exitCode: null, stdout: "", stderr: "no command given", durationMs: 0 };
  }
  return new Promise<OneShotResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let status: OneShotStatus = "ok";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, args, {
      cwd: workspace.path,
      // A child inherits ONLY what is passed: no ambient credential, no
      // DOCKER_HOST, nothing from the container's own environment.
      env,
      // Its OWN process group, so the timeout can kill the group rather than
      // leaving grandchildren holding the workspace and the model credential.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Both pipes are drained throughout: a child that fills a pipe buffer
    // while nobody reads it blocks forever.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_MAX) stdout += redact(chunk.toString(), env);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_MAX) stderr += redact(chunk.toString(), env);
    });

    const timer = setTimeout(() => {
      status = "timeout";
      killGroup(child.pid, "SIGTERM");
      // A grace period, then the group dies for certain.
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 2_000);
    }, timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // The group is killed on every exit path, not only on timeout: a child
      // that exits while a grandchild lives would leak one per take.
      killGroup(child.pid, "SIGKILL");
      resolve({ status, exitCode, stdout, stderr, durationMs: Date.now() - started });
    };

    child.on("error", (err: Error) => {
      // A failure is a returned STATUS, never a throw: the caller must always
      // reach its `finally` and dispose the workspace.
      stderr += err.message;
      if (status === "ok") status = "crashed";
      finish(null);
    });
    child.on("close", (code: number | null) => {
      if (status === "ok" && code !== 0) status = "crashed";
      finish(code);
    });
  });
}

/** Signal the whole process GROUP, tolerating a group that is already gone. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already dead: nothing to clean up.
    }
  }
}

/** Keep an injected credential out of the captured output. */
function redact(text: string, env: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|JWK/i.test(key)) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
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
  // FETCHED, never reconstructed: a locally rebuilt payload that drifts by a
  // byte produces a valid signature over the wrong message. A transport error
  // here throws, and the next poll retries under the same idempotent key.
  const payloadRes = await fetch(`${config.apiUrl}${ROUTES.swarm.signingPayload}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify(draft),
  });
  const payloadBody = (await readJson(payloadRes)) as { canonical?: unknown } | null;
  const canonical = typeof payloadBody?.canonical === "string" ? payloadBody.canonical : "";
  if (!payloadRes.ok || canonical === "") {
    return {
      status: "refused",
      takeId: null,
      verified: false,
      reason: `${ROUTES.swarm.signingPayload} returned HTTP ${payloadRes.status} without canonical bytes`,
    };
  }

  const signature = await signCanonical(canonical, config);
  const submitRes = await fetch(`${config.apiUrl}${ROUTES.swarm.submit}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ ...draft, signature }),
  });
  const body = (await readJson(submitRes)) as
    | { ok?: unknown; alreadySubmitted?: unknown; recommendationId?: unknown; verified?: unknown; error?: unknown }
    | null;
  const takeId = typeof body?.recommendationId === "string" ? body.recommendationId : null;

  // The EXISTING record is the authority, not the wire status: a crash after
  // submit, or an old/new container overlap, lands here and is SUCCESS. There
  // is no retry-on-conflict branch and no second authoring.
  if (body?.alreadySubmitted === true) {
    return { status: "already_submitted", takeId, verified: body.verified === true };
  }
  if (submitRes.ok && body?.ok === true) {
    return { status: "submitted", takeId, verified: body.verified === true };
  }
  return {
    status: "refused",
    takeId,
    verified: false,
    reason: typeof body?.error === "string" ? body.error.slice(0, 400) : `HTTP ${submitRes.status}`,
  };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Sign the canonical bytes with THIS participant's own key.
 *
 * A key this container cannot import is never replaced with an invented one:
 * the submission goes out with an empty signature, the server's verification
 * refuses it, and the operator reads the refusal. That is the same property
 * that makes a superseded spoof-keys generation harmless (spec §6.4) — a key
 * that is not the member's current one simply never verifies.
 */
async function signCanonical(canonical: string, config: ParticipantConfig): Promise<string> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      config.identity.privateJwk as JsonWebKey,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(canonical));
    return Buffer.from(new Uint8Array(signature)).toString("base64");
  } catch {
    return "";
  }
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
  const started = Date.now();
  const base = { sessionId: work.sessionId, memberId: config.memberId };
  const report = (
    oneShot: OneShotStatus,
    submission: SubmissionStatus | null,
    reason?: string,
  ): TakeOutcome => ({
    ...base,
    oneShot,
    submission,
    durationMs: Date.now() - started,
    ...(reason === undefined ? {} : { reason: reason.slice(0, 400) }),
  });

  let workspace: TakeWorkspace;
  try {
    workspace = createTakeWorkspace(config.workspaceRoot, work.sessionId, config.memberId);
  } catch (err) {
    return report("crashed", null, `workspace unusable: ${errorText(err)}`);
  }
  try {
    const argv = oneShotArgv(process.env[TAKE_COMMAND_ENV]);
    if (argv.length === 0) {
      return report("crashed", null, `${TAKE_COMMAND_ENV} was not injected into this participant container`);
    }
    const oneShot = await runOneShot(workspace, argv, oneShotEnv(config, work, workspace), config.takeTimeoutMs);
    if (oneShot.status !== "ok") {
      return report(oneShot.status, null, oneShot.stderr || `one-shot exited ${oneShot.exitCode}`);
    }
    const draft = parseDraftLine(oneShot.stdout);
    if (!draft) return report("ok", null, `the one-shot printed no ${TAKE_DRAFT_TAG} line`);
    const submission = await submitTake(config, work, draft);
    return report("ok", submission.status, submission.reason);
  } catch (err) {
    // A take that fails is a REPORTED OUTCOME: one bad session must not take
    // down a container that has weeks of later sessions to serve.
    return report("crashed", null, errorText(err));
  } finally {
    // On every path, including timeout and crash. Disposal never masks the
    // take's own failure.
    try {
      workspace.dispose();
    } catch {
      // A workspace that will not delete is not a reason to lose the outcome.
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The injected argv, as a JSON array or a single command path. */
function oneShotArgv(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (text === "") return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
    } catch {
      return [];
    }
    return [];
  }
  return text.split(/\s+/);
}

/** Exactly what the one-shot is given: its coordinates, and nothing ambient. */
function oneShotEnv(
  config: ParticipantConfig,
  work: PendingWork,
  workspace: TakeWorkspace,
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workspace.path,
    RM_API_URL: config.apiUrl,
    RM_MEMBER_ID: config.memberId,
    RM_MEMBER_NAME: config.name,
    RM_MEMBER_TOKEN: config.token,
    RM_MEMBER_IDENTITY: JSON.stringify(config.identity),
    RM_SESSION_ID: work.sessionId,
    RM_SUBJECT_ID: work.subjectId,
    RM_SESSION_DATE: work.date,
    RM_WORKSPACE: workspace.path,
  };
}

/**
 * The authored draft, read off the one-shot's LAST tagged line.
 *
 * Last wins, and a torn line is not a draft — the same rule the judge's answer
 * line follows, for the same reason: a container killed mid-flush must not
 * have its half-written output submitted as a take.
 */
export function parseDraftLine(stdout: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(`${TAKE_DRAFT_TAG} `)) continue;
    try {
      const parsed = JSON.parse(line.slice(TAKE_DRAFT_TAG.length + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        found = parsed as Record<string, unknown>;
      }
    } catch {
      // Half a line is not a draft.
    }
  }
  return found;
}
