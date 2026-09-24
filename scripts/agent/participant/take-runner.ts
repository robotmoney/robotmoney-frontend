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
// per take, removed once the take is settled, makes both impossible by
// construction rather than by a cleanup routine somebody has to remember.
//
// ── WHY A PROCESS GROUP ─────────────────────────────────────────────────────
// The authoring CLI spawns children. Killing the direct child on timeout
// leaves its grandchildren holding the workspace and the model credential. The
// one-shot therefore runs in its own process group and the timeout kills the
// GROUP. Without that, a hung take leaks a process per occurrence into a
// container that never restarts, until the container runs out of memory hours
// later and the restart looks unrelated to the take that caused it.
//
// ── A RETRY IS IDENTIFIED BY ITS SIGNED NONCE (§6.2, D51, D52) ──────────────
// A take's identity is its signed `nonce`. The rules, in the spec's order:
//
//   1. The participant writes its SIGNED submission — the exact request bytes,
//      nonce included — into its workspace BEFORE sending it.
//   2. A crash-restart RESENDS those bytes. It never authors the take again
//      and never mints a new nonce for it.
//   3. The server answers a nonce it has already recorded for this member and
//      session with the EXISTING record (`alreadySubmitted: true`), and the
//      participant treats that as success.
//   4. A NEW nonce is an intentional amendment, allowed while the window is
//      open: its own signed row, marked final, unsetting the member's previous
//      one (D51). A partial unique index on `(session, member) WHERE final`
//      makes two final takes impossible.
//
// What that closes:
//
//   - CRASH AFTER SUBMIT. The container dies between the server committing the
//     submission and the participant learning that it did. The workspace
//     still holds the signed bytes, so the restarted container resends them;
//     the server returns the row it already has. ONE row.
//   - OLD/NEW CONTAINER OVERLAP DURING A ROSTER CHANGE. Both may author, each
//     with its own nonce. That is an amendment, never a second FINAL take.
//
// So the workspace is disposed only when the take is SETTLED: the server
// confirmed it (`submitted` or `alreadySubmitted: true`), refused it with a
// definitive 4xx (resending the same bytes would be refused the same way), or
// it never produced a signed submission at all (a timeout, a crash, a draft
// that did not parse). A transport failure or a 5xx after the bytes were
// written leaves the workspace in place, and the loop resends it.
//
// ── GOVERNING SPEC SECTIONS ─────────────────────────────────────────────────
// §6.2 (one-shot per take, fresh workspace, timeout, process-group cleanup,
// idempotent submission, one take in flight), §10 W3 ("Participant crash after
// submit: one take"; "Roster change with overlapping containers: one take"),
// D51 (amendments, newest final), D52 (a retry is identified by its nonce).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import type { ParticipantConfig, PendingWork } from "./main.ts";

/**
 * The environment name the one-shot's argv is injected under (spec §6.2: a
 * container inherits nothing). `readParticipantConfig` reads it into
 * `ParticipantConfig.takeCommand`; an agent entry without one refuses at boot
 * rather than guessing a binary to run as the member.
 */
export const TAKE_COMMAND_ENV = "RM_TAKE_COMMAND";

/** The single stdout tag the one-shot prints its authored draft on. */
export const TAKE_DRAFT_TAG = "RM_TAKE_DRAFT";

/**
 * The file, inside a take's workspace, that holds its signed submission. It is
 * written BEFORE the submission is sent, and its presence is what makes a
 * workspace a pending submission rather than residue.
 */
export const SIGNED_SUBMISSION_FILE = "signed-submission.json";

/** Output is a label, not a payload: enough to read, bounded against a flood. */
const OUTPUT_MAX = 64 * 1024;

/** `mkdtemp` appends exactly six characters to its prefix. */
const MKDTEMP_SUFFIX_LENGTH = 6;

/**
 * A take's working directory. `dispose()` removes it and everything in it; the
 * runner calls it once the take is settled (see the header).
 */
export interface TakeWorkspace {
  /** Absolute path, unique to this (session, member) attempt. */
  path: string;
  dispose(): void;
}

/** The workspace directory-name prefix for one (session, member). */
function workspacePrefix(sessionId: string, memberId: string): string {
  return `take-${sessionId}-${memberId}-`;
}

/**
 * Whether a directory name is a workspace of EXACTLY this (session, member).
 * The length check keeps member `m-a` from claiming member `m-a-b`'s workspace.
 */
function isWorkspaceOf(dirName: string, sessionId: string, memberId: string): boolean {
  const prefix = workspacePrefix(sessionId, memberId);
  return dirName.startsWith(prefix) && dirName.length === prefix.length + MKDTEMP_SUFFIX_LENGTH;
}

function workspaceAt(path: string): TakeWorkspace {
  return {
    path,
    dispose(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
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
  return workspaceAt(mkdtempSync(join(root, workspacePrefix(sessionId, memberId))));
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
 * caller must always reach its cleanup.
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
      // reach its cleanup.
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
 * The outcome of the submission call.
 *
 * - `submitted`         — the server recorded this nonce as a new row.
 * - `already_submitted` — the server already held this nonce for this member
 *                         and answered with that row: a retry, and SUCCESS.
 * - `refused`           — a definitive refusal (4xx), carrying the reason.
 * - `unconfirmed`       — the signed bytes are in the workspace but the server
 *                         has not confirmed them (transport failure or 5xx).
 *                         They are resent as they are.
 */
export type SubmissionStatus = "submitted" | "already_submitted" | "refused" | "unconfirmed";

export interface SubmissionResult {
  status: SubmissionStatus;
  /** The server's record for this nonce — new or pre-existing. */
  takeId: string | null;
  /** True only when the server verified this submission's signature. */
  verified: boolean;
  /** Present for `refused`: the server's reason, bounded. */
  reason?: string;
}

/**
 * What the workspace holds between signing and confirmation: the exact bytes
 * of the submission request, and the coordinates that identify it. `bytes` is
 * sent verbatim on every attempt, so a retry is byte-identical to the first
 * send and carries the same nonce.
 */
export interface PersistedSubmission {
  sessionId: string;
  memberId: string;
  nonce: string;
  /** The submission request body, exactly as it is POSTed. */
  bytes: string;
}

/**
 * Write the signed submission into its workspace, durably, BEFORE it is sent.
 *
 * Written to a temporary name, flushed to disk, then renamed: a crash leaves
 * either no file (the take was never sent, so re-authoring it is safe) or the
 * whole file (the take may have been sent, so it is resent), never half of one.
 */
export function persistSignedSubmission(workspace: TakeWorkspace, record: PersistedSubmission): void {
  const target = join(workspace.path, SIGNED_SUBMISSION_FILE);
  const temp = `${target}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
}

/** The persisted submission in a workspace, or `null` when there is none. */
function readPersistedSubmission(workspacePath: string): PersistedSubmission | null {
  const file = join(workspacePath, SIGNED_SUBMISSION_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedSubmission>;
    if (
      typeof parsed.sessionId === "string"
      && typeof parsed.memberId === "string"
      && typeof parsed.nonce === "string"
      && typeof parsed.bytes === "string"
      && parsed.bytes !== ""
    ) {
      return parsed as PersistedSubmission;
    }
  } catch {
    // Unreadable: the rename makes a torn file impossible, so this was not
    // written by the runner and is not a submission it can vouch for.
  }
  return null;
}

/**
 * Every workspace under `root` holding a signed, unconfirmed submission for
 * `memberId`, optionally narrowed to one session.
 */
export function findPersistedSubmissions(
  root: string,
  memberId: string,
  sessionId?: string,
): { workspace: TakeWorkspace; record: PersistedSubmission }[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const found: { workspace: TakeWorkspace; record: PersistedSubmission }[] = [];
  for (const name of names.sort()) {
    const path = join(root, name);
    const record = readPersistedSubmission(path);
    if (!record || record.memberId !== memberId) continue;
    if (sessionId !== undefined && record.sessionId !== sessionId) continue;
    if (!isWorkspaceOf(name, record.sessionId, record.memberId)) continue;
    found.push({ workspace: workspaceAt(path), record });
  }
  return found;
}

/**
 * Submit the authored take: mint its nonce, sign the canonical bytes the API
 * returns, PERSIST the signed request into the workspace, then send it.
 *
 * Inputs: the participant configuration (for the bearer and the key), the work
 * coordinates, the authored draft, and the take's workspace. Output: a
 * `SubmissionResult`.
 *
 * The nonce is the draft's own when it carries one, and a fresh UUID when it
 * does not. It is minted ONCE, here, before signing: every later attempt at
 * this take resends the persisted bytes and so carries the same nonce.
 *
 * The canonical bytes are FETCHED from the signing-payload endpoint and signed
 * exactly as returned — never reconstructed locally. A locally reconstructed
 * payload that drifts by a byte produces a valid signature over the wrong
 * message.
 *
 * Refusals: `refused` when the signing-payload endpoint returns no canonical
 * bytes (nothing was persisted or sent, so the next poll may author again). A
 * key this container cannot import THROWS before anything is written. After
 * the bytes are persisted, see `sendSignedSubmission`.
 *
 * Gates (spec §10 W3): "Participant crash after submit: one take"; "Roster
 * change with overlapping containers: one take."
 */
export async function submitTake(
  config: ParticipantConfig,
  work: PendingWork,
  draft: Record<string, unknown>,
  workspace: TakeWorkspace,
): Promise<SubmissionResult> {
  const nonce = typeof draft.nonce === "string" && draft.nonce.trim() !== "" ? draft.nonce : randomUUID();
  const unsigned = { ...draft, nonce };
  // FETCHED, never reconstructed: a locally rebuilt payload that drifts by a
  // byte produces a valid signature over the wrong message. A transport error
  // here throws before anything is persisted, so the next poll authors again.
  const payloadRes = await fetch(`${config.apiUrl}${ROUTES.swarm.signingPayload}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify(unsigned),
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
  const bytes = JSON.stringify({ ...unsigned, signature });
  // ON DISK BEFORE ON THE WIRE (D52): from here on this take is resent, never
  // re-authored, until the server settles it.
  persistSignedSubmission(workspace, { sessionId: work.sessionId, memberId: config.memberId, nonce, bytes });
  return sendSignedSubmission(config, bytes);
}

/**
 * POST a signed submission's exact bytes and read the server's answer.
 *
 * Input: the configuration and the persisted request body. Output: a
 * `SubmissionResult` — `submitted`, `already_submitted` (the server holds this
 * nonce already and returns that row: SUCCESS, with no retry and no second
 * authoring), or `refused` for a definitive 4xx, which is exactly what a
 * superseded spoof-keys generation produces (spec §6.4).
 *
 * The existing record is the authority, not the wire status: a body carrying
 * `alreadySubmitted: true` is success whatever the status code.
 *
 * Refusals: a transport error or a 5xx THROWS. The bytes stay in the workspace
 * and are resent as they are, so the outcome is bounded to one row per nonce.
 */
export async function sendSignedSubmission(
  config: ParticipantConfig,
  bytes: string,
): Promise<SubmissionResult> {
  const submitRes = await fetch(`${config.apiUrl}${ROUTES.swarm.submit}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: bytes,
  });
  const body = (await readJson(submitRes)) as
    | { ok?: unknown; alreadySubmitted?: unknown; recommendationId?: unknown; verified?: unknown; error?: unknown }
    | null;
  const takeId = typeof body?.recommendationId === "string" ? body.recommendationId : null;

  // The EXISTING record is the authority, not the wire status: a crash after
  // submit lands here and is SUCCESS.
  if (body?.alreadySubmitted === true) {
    return { status: "already_submitted", takeId, verified: body.verified === true };
  }
  if (submitRes.ok && body?.ok === true) {
    return { status: "submitted", takeId, verified: body.verified === true };
  }
  if (submitRes.status >= 500) {
    // The server did not answer the question. The bytes are resent.
    throw new Error(`${ROUTES.swarm.submit} answered HTTP ${submitRes.status}; the signed submission is resent as it is`);
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
 * Sign the canonical bytes with THIS participant's own key, or THROW.
 *
 * A KEY THIS CONTAINER CANNOT IMPORT IS A REFUSAL, NOT AN EMPTY SIGNATURE.
 *
 * An earlier version of this function returned `""` on an unusable key and let
 * the submission go out unsigned, on the reasoning that the server's
 * verification would refuse it anyway. That reasoning is wrong in the same way
 * the judge's removed fallback was wrong. Nothing bad reached the database
 * either way — but the participant reported the take as `submitted`, which
 * claims an authorship it could not produce. `a42d6c5a` settled this one layer
 * up ("a judgement is a model's opinion or it does not exist"); the same rule
 * holds here: A TAKE IS SIGNED BY ITS MEMBER, OR IT DOES NOT EXIST.
 *
 * So an unusable key fails the attempt BEFORE the POST, with a reason naming
 * the key rather than a server-side signature complaint the operator would have
 * to work backwards from. The distinct case this must not be confused with is a
 * key that imports fine and simply is not the member's current one — a
 * superseded --spoof-keys generation (spec §6.4). That one DOES go out, the
 * server refuses it, and `refused` is the honest outcome, because the
 * participant really did sign what it sent.
 */
async function signCanonical(canonical: string, config: ParticipantConfig): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      config.identity.privateJwk as JsonWebKey,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch (err) {
    throw new Error(
      `participant ${config.kind} "${config.name}" cannot import its own signing key from credential.json — ` +
        `a take is signed by its member or it is not submitted at all: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(canonical));
  return Buffer.from(new Uint8Array(signature)).toString("base64");
}

/** What one take attempt reports back to the poll loop. */
export interface TakeOutcome {
  sessionId: string;
  memberId: string;
  /** How the one-shot ended, or `null` when none ran (a persisted take was resent). */
  oneShot: OneShotStatus | null;
  submission: SubmissionStatus | null;
  /** The nonce the submission carried, once one was signed. */
  nonce?: string;
  durationMs: number;
  /** Bounded operator-facing reason when the take did not submit. */
  reason?: string;
}

/** A settled submission: the workspace can go. `unconfirmed` keeps it. */
function isSettled(status: SubmissionStatus): boolean {
  return status !== "unconfirmed";
}

/**
 * Resend one persisted submission and settle its workspace.
 *
 * The workspace is disposed when the server settles the take (confirmed, or
 * refused with a 4xx) and kept, for the next resend, when it does not answer.
 */
async function resendPersisted(
  config: ParticipantConfig,
  pending: { workspace: TakeWorkspace; record: PersistedSubmission },
): Promise<TakeOutcome> {
  const started = Date.now();
  const base = {
    sessionId: pending.record.sessionId,
    memberId: pending.record.memberId,
    oneShot: null,
    nonce: pending.record.nonce,
  };
  let result: SubmissionResult;
  try {
    result = await sendSignedSubmission(config, pending.record.bytes);
  } catch (err) {
    return { ...base, submission: "unconfirmed", durationMs: Date.now() - started, reason: errorText(err).slice(0, 400) };
  }
  if (isSettled(result.status)) disposeQuietly(pending.workspace);
  return {
    ...base,
    submission: result.status,
    durationMs: Date.now() - started,
    ...(result.reason === undefined ? {} : { reason: result.reason.slice(0, 400) }),
  };
}

/**
 * Resend EVERY signed submission this participant persisted and the server has
 * not confirmed, whatever session it belongs to.
 *
 * Input: the configuration. Output: one outcome per persisted submission.
 *
 * The poll loop calls this before each poll. It is what makes a crash-restart
 * safe when the server DID record the take before the crash: that session is no
 * longer offered as pending work, so only this sweep ever resends it, and the
 * server's `alreadySubmitted` answer is what lets the workspace go.
 *
 * Refusals: none propagate; a failed resend is an `unconfirmed` outcome.
 */
export async function resendPendingSubmissions(config: ParticipantConfig): Promise<TakeOutcome[]> {
  const outcomes: TakeOutcome[] = [];
  for (const pending of findPersistedSubmissions(config.workspaceRoot, config.memberId)) {
    outcomes.push(await resendPersisted(config, pending));
  }
  return outcomes;
}

/**
 * Remove this (session, member)'s workspaces that hold no signed submission:
 * the residue of an attempt that died while authoring. Nothing in them was
 * sent, so nothing in them is owed to the server.
 */
function disposeAuthoringResidue(root: string, sessionId: string, memberId: string): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isWorkspaceOf(name, sessionId, memberId)) continue;
    const path = join(root, name);
    if (readPersistedSubmission(path) === null) disposeQuietly(workspaceAt(path));
  }
}

function disposeQuietly(workspace: TakeWorkspace): void {
  try {
    workspace.dispose();
  } catch {
    // A workspace that will not delete is not a reason to lose the outcome.
  }
}

/**
 * Run one complete take: resend a persisted one, or fresh workspace →
 * one-shot → sign → persist → send → dispose.
 *
 * Inputs: the participant configuration and the work item. Output: a
 * `TakeOutcome` the loop logs.
 *
 * A signed submission already persisted for this (session, member) is RESENT
 * and nothing is authored (D52). Otherwise the workspace is disposed once the
 * take is settled: on a timeout, a crash, a draft that did not parse, or a
 * settled submission. It survives only an unconfirmed send, for the resend.
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
  const persisted = findPersistedSubmissions(config.workspaceRoot, config.memberId, work.sessionId);
  if (persisted[0]) return resendPersisted(config, persisted[0]);

  const started = Date.now();
  const base = { sessionId: work.sessionId, memberId: config.memberId };
  const report = (
    oneShot: OneShotStatus | null,
    submission: SubmissionStatus | null,
    extra: { reason?: string; nonce?: string } = {},
  ): TakeOutcome => ({
    ...base,
    oneShot,
    submission,
    ...(extra.nonce === undefined ? {} : { nonce: extra.nonce }),
    durationMs: Date.now() - started,
    ...(extra.reason === undefined ? {} : { reason: extra.reason.slice(0, 400) }),
  });

  if (config.takeCommand.length === 0) {
    return report("crashed", null, { reason: `${TAKE_COMMAND_ENV} was not injected into this participant container` });
  }
  disposeAuthoringResidue(config.workspaceRoot, work.sessionId, config.memberId);
  let workspace: TakeWorkspace;
  try {
    workspace = createTakeWorkspace(config.workspaceRoot, work.sessionId, config.memberId);
  } catch (err) {
    return report("crashed", null, { reason: `workspace unusable: ${errorText(err)}` });
  }
  let oneShotStatus: OneShotStatus = "crashed";
  // Set only when signed bytes are on disk and the server has not settled them.
  let keepForResend = false;
  try {
    const oneShot = await runOneShot(
      workspace,
      config.takeCommand,
      oneShotEnv(config, work, workspace),
      config.takeTimeoutMs,
    );
    oneShotStatus = oneShot.status;
    if (oneShot.status !== "ok") {
      return report(oneShot.status, null, { reason: oneShot.stderr || `one-shot exited ${oneShot.exitCode}` });
    }
    const draft = parseDraftLine(oneShot.stdout);
    if (!draft) return report("ok", null, { reason: `the one-shot printed no ${TAKE_DRAFT_TAG} line` });
    const submission = await submitTake(config, work, draft, workspace);
    const nonce = readPersistedSubmission(workspace.path)?.nonce;
    keepForResend = !isSettled(submission.status);
    return report("ok", submission.status, {
      ...(submission.reason === undefined ? {} : { reason: submission.reason }),
      ...(nonce === undefined ? {} : { nonce }),
    });
  } catch (err) {
    // A take that fails is a REPORTED OUTCOME: one bad session must not take
    // down a container that has weeks of later sessions to serve. When the
    // signed bytes were already persisted, the send is merely unconfirmed.
    const persistedNow = readPersistedSubmission(workspace.path);
    if (persistedNow) {
      keepForResend = true;
      return report(oneShotStatus, "unconfirmed", { reason: errorText(err), nonce: persistedNow.nonce });
    }
    return report(oneShotStatus, null, { reason: errorText(err) });
  } finally {
    // Settled takes leave nothing behind. An unconfirmed signed submission
    // stays, because it is resent as it is.
    if (!keepForResend) disposeQuietly(workspace);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
