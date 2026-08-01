// The HARNESS side of committee-member session participation on the
// member-agent CONTAINER rail (issue #361 Phase 2/3; docs/decisions.md D25,
// docs/architecture.md §9.7). This module launches — and only launches — one
// container per member per session via the shared runMemberAgent() primitive
// (scripts/agent/member-agent.ts, the SAME rail the §11.3 onboarding eval
// rides). Everything member-scoped — fetching the brief/regime, authoring the
// take with a real in-container opencode call, holding the ed25519 key,
// signing, posting the memo, submitting — happens INSIDE the container, in
// scripts/agent/member-session-client.ts. The harness plays only the operator
// (E7): it opens/closes the session window (session.ts), registers a roster
// member's PUBLIC key at enrollment, and observes.
//
// This replaces the retired host-run driver that lived in this file, which
// authored the prompt, held every member's private key, signed, and submitted
// from the single orchestrator process while its opencode subprocesses
// inherited the harness's whole credential set. None of that survives: the
// harness now holds NO member private key, and a member-container failure of
// any kind renders that member ABSENT (#122 semantics — session.ts settles
// per-member rejections into no-shows).
//
// IDENTITY CONTINUITY (Phase 3): each member's HOME is a persistent, labeled
// named volume (memberHomeVolumeName), so the key that enrolled — or, for a
// real-onboarded member, the rmpc keystore its own vanilla agent created
// during admission — is the key that signs every subsequent take. Enrollment
// for the FIXED demo roster is the one remaining privileged-register use: the
// harness, playing the RM operator seeding a demo committee, registers the
// container-generated public key ONCE per identity; ongoing participation
// never re-registers and never mints a "demo-only simulation key" (that path
// is retired). A real-onboarded member is never registered from here at all —
// its admission already bound its key, and a broken stored credential renders
// it absent rather than re-keyed.
import { ROUTES } from "@robotmoney/contract";
import { personaIdentityEnv } from "./persona-keys.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureMemberVolume,
  memberHomeVolumeName,
  runMemberAgent,
  type MemberAgentMount,
  type MemberAgentModel,
} from "../../agent/member-agent.ts";
import { DEFAULT_API_URL_INTERNAL, resolveModelConfig } from "../onboarding-eval.ts";
import { DEFAULT_COMPOSE_FILES } from "../../stack/config.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(scriptDir, "..", "..", "..");
// Where the member's own client software lives inside the container. The host
// builds one self-contained artifact into a per-run OS temp directory and
// mounts ONLY that file read-only. The repository/worktree is never mounted:
// read-only access would still disclose .env, .agents, and unrelated source or
// credentials to a model-driven member process.
export const CLIENT_ENTRY = "/opt/robotmoney/member-session-client.js";

export interface MemberSessionRuntime {
  artifactPath: string;
  dispose(): void;
}

/** Build the minimal member runtime outside the repository/worktree. */
export async function buildMemberSessionRuntime(repoRoot: string): Promise<MemberSessionRuntime> {
  const runtimeDir = mkdtempSync(join(tmpdir(), "robotmoney-member-client-"));
  const artifactPath = join(runtimeDir, "member-session-client.js");
  try {
    const built = await Bun.build({
      entrypoints: [join(repoRoot, "scripts", "agent", "member-session-client.ts")],
      outdir: runtimeDir,
      naming: "member-session-client.js",
      target: "bun",
      format: "esm",
      sourcemap: "none",
    });
    if (!built.success) {
      throw new Error(`member session client bundle failed: ${built.logs.map(String).join("; ")}`);
    }
    return {
      artifactPath,
      dispose: () => rmSync(runtimeDir, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(runtimeDir, { recursive: true, force: true });
    throw err;
  }
}

/** The complete session-member mount set: one sanitized file + durable HOME. */
export function memberSessionMounts(runtimeArtifact: string, homeVolume: string): MemberAgentMount[] {
  return [
    { source: runtimeArtifact, target: CLIENT_ENTRY, readonly: true },
    { source: homeVolume, target: "/home/agent" },
  ];
}

function backendUrl(): string {
  return process.env.BACKEND_URL ?? "http://localhost:8787";
}

// ── Rail configuration ──────────────────────────────────────────────────────
/** A real-onboarded member's persistent machine + owner-held keystore secret. */
export interface OnboardedMemberHome {
  /** Named volume carrying the member's HOME (rmpc keystore, token, tooling). */
  volume: string;
  /** Owner-held rmpc keystore passphrase (E7) — injected per session run. */
  passphrase?: string;
}

export interface SessionRail {
  repoRoot: string;
  composeProject: string;
  composeFiles: string[];
  /** Exact compose interpolation env for the already-running stack. */
  composeSpawnEnv: Record<string, string>;
  /** Model + credential, resolved by the caller (resolveModelConfig). */
  modelConfig: MemberAgentModel;
  /** REST base the CONTAINER reaches over the compose network. */
  apiUrlInternal?: string;
  /** REST base the HARNESS reaches for the one-time public-key registration
   *  (default: BACKEND_URL env, then http://localhost:8787). */
  backendUrl?: string;
  /** Admin token for that registration. The in-process demo driver
   *  (scripts/lib/demo-main.ts) threads its own adminPassword explicitly here
   *  (issue #456); railFromEnv() below is the only legitimate place this
   *  still falls back to reading ADMIN_TOKEN off process.env, for the
   *  standalone session.ts entry point that genuinely runs as its own
   *  child process with ADMIN_TOKEN set on its own environment at spawn
   *  time. */
  adminToken?: string;
  /** Per-member homes for members onboarded through the real §11 flow. */
  onboardedHomes?: Map<string, OnboardedMemberHome>;
}

// Build a rail from the environment — the standalone `bun run
// scripts/lib/committee/session.ts` entry point (CI's demo readiness gate)
// receives the demo's exact compose env as its own process env, so everything
// needed is already there: DEMO_PROJECT names the stack, COMPOSE_FILE lists
// the overlay files, and resolveModelConfig() reads AGENT_MODEL +
// OPENCODE_API_KEY. Throws loudly on a missing piece — a session driver that
// cannot launch member containers must not silently fall back to anything.
export function railFromEnv(env: Record<string, string | undefined> = process.env): SessionRail {
  const composeProject = env.DEMO_PROJECT?.trim();
  if (!composeProject) {
    throw new Error(
      "railFromEnv: DEMO_PROJECT is required — the committee session driver launches member containers " +
        "against the already-running stack's compose project and cannot guess its name.",
    );
  }
  const composeSpawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) composeSpawnEnv[k] = v;
  return {
    repoRoot: REPO_ROOT,
    composeProject,
    composeFiles: env.COMPOSE_FILE ? env.COMPOSE_FILE.split(":") : [...DEFAULT_COMPOSE_FILES],
    composeSpawnEnv,
    modelConfig: resolveModelConfig(env),
    // Issue #461: this is the ONE place agent.ts still reads ADMIN_TOKEN from
    // an environment object rather than taking it as an explicit argument —
    // and it is legitimate env inheritance, not the retired global-mutation
    // antipattern: railFromEnv() is only ever called by (or defaulted for)
    // the standalone session.ts entry point, which runs as its own child
    // process with ADMIN_TOKEN set on its own spawn env. Every other rail
    // (e.g. demo-main.ts's in-process sessionRail) sets adminToken directly.
    adminToken: env.ADMIN_TOKEN,
  };
}

// ── Agent surface (kept vocabulary: the TUI's stable stage names) ───────────
export interface AgentOpts {
  memberId: string; name: string; lens: string; bias: number;
  date: string; subjectId: string; sessionId: number;
}

export type AgentStage = "connect" | "fetch" | "thinking" | "reporting" | "done";
export type AgentProgress = (stage: AgentStage, info?: { stance?: string; confidence?: number }) => void;

const AGENT_STAGES: ReadonlySet<string> = new Set(["connect", "fetch", "thinking", "reporting", "done"]);

// Parse one already-line-split client stdout message for the RM_<TAG> protocol.
export function parseClientLine(tag: "RM_STAGE" | "RM_RESULT" | "RM_ENROLL", line: string): any | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${tag} `)) return null;
  try {
    return JSON.parse(trimmed.slice(tag.length + 1));
  } catch {
    return null;
  }
}

function lastClientRecord(tag: "RM_STAGE" | "RM_RESULT" | "RM_ENROLL", stdout: string): any | null {
  let found: any = null;
  for (const line of stdout.split("\n")) {
    const parsed = parseClientLine(tag, line);
    if (parsed !== null) found = parsed;
  }
  return found;
}

// Generous but bounded per-container ceilings. The participate run contains
// one real model call (itself bounded by OPENCODE_TIMEOUT_MS, default 120s in
// scripts/lib/committee/inference.ts) plus container start/stop and a handful
// of REST calls; enroll does no inference at all.
const ENROLL_TIMEOUT_MS = 180_000;
function participateTimeoutMs(): number {
  return Number(process.env.OPENCODE_TIMEOUT_MS ?? 120_000) + 180_000;
}

interface MemberRunOpts {
  mode: "enroll" | "participate";
  runId: string;
  extraEnv: Record<string, string>;
  ownerEnv?: Record<string, string>;
  homeVolume: string;
  timeoutMs: number;
  onStdoutLine?: (line: string) => void;
}

async function runMemberContainer(rail: SessionRail, o: MemberRunOpts) {
  const runtime = await buildMemberSessionRuntime(rail.repoRoot);
  try {
    return await runMemberAgent({
      repoRoot: rail.repoRoot,
      composeProject: rail.composeProject,
      composeFiles: rail.composeFiles,
      runId: o.runId,
      entrypoint: "bun",
      command: [CLIENT_ENTRY, o.mode],
      mounts: memberSessionMounts(runtime.artifactPath, o.homeVolume),
      extraEnv: {
        RM_API_URL: rail.apiUrlInternal ?? DEFAULT_API_URL_INTERNAL,
        AGENT_MODEL: rail.modelConfig.model,
        ...o.extraEnv,
      },
      ownerEnv: o.ownerEnv,
      modelConfig: rail.modelConfig,
      composeSpawnEnv: rail.composeSpawnEnv,
      timeoutMs: o.timeoutMs,
      onStructuredEvent: o.onStdoutLine
        ? (ev) => {
            if (ev.source === "agent" && ev.stream === "stdout") o.onStdoutLine!(ev.message);
          }
        : undefined,
    });
  } finally {
    runtime.dispose();
  }
}

// ── Enrollment (once per identity per harness process) ──────────────────────
// Memoized so a long-running demo enrolls each roster member once per boot;
// the durable state (key + persisted token) lives in the member's own volume.
const enrolledIdentities = new Map<string, Promise<{ freshToken?: string }>>();

export interface EnrollableMember {
  memberId: string;
  name: string;
  lens?: string;
}

export async function ensureMemberIdentity(
  rail: SessionRail,
  m: EnrollableMember,
): Promise<{ freshToken?: string }> {
  const cacheKey = `${rail.composeProject}/${m.memberId}`;
  const cached = enrolledIdentities.get(cacheKey);
  if (cached) return cached;
  const pending = ensureMemberIdentityUncached(rail, m).catch((err) => {
    // A failed enrollment must not poison every later session with the cached
    // rejection — drop it so the next session retries.
    enrolledIdentities.delete(cacheKey);
    throw err;
  });
  enrolledIdentities.set(cacheKey, pending);
  return pending;
}

async function ensureMemberIdentityUncached(
  rail: SessionRail,
  m: EnrollableMember,
): Promise<{ freshToken?: string }> {
  const onboarded = rail.onboardedHomes?.get(m.memberId);
  const homeVolume = onboarded?.volume ?? memberHomeVolumeName(rail.composeProject, m.memberId);
  ensureMemberVolume(homeVolume, rail.composeProject, rail.composeSpawnEnv);

  const run = await runMemberContainer(rail, {
    mode: "enroll",
    runId: `${m.memberId}-enroll-${crypto.randomUUID().slice(0, 6)}`,
    // A committed persona identity (scripts/lib/committee/persona-keys.ts) is
    // passed as OWNER material, not plain extraEnv: it carries a private key, so
    // it belongs on the redacted-from-transcripts channel alongside the token and
    // the rmpc passphrase. It is only ever present for the demo's named
    // characters; anyone else enrolls exactly as before.
    extraEnv: { RM_MEMBER_ID: m.memberId },
    ownerEnv: personaIdentityEnv(m.name)
      ? { ...personaIdentityEnv(m.name), ...(onboarded?.passphrase ? { RMPC_COMMITTEE_IDENTITY_PASSPHRASE: onboarded.passphrase } : {}) }
      : onboarded?.passphrase
      ? { RMPC_COMMITTEE_IDENTITY_PASSPHRASE: onboarded.passphrase }
      : undefined,
    homeVolume,
    timeoutMs: ENROLL_TIMEOUT_MS,
  });
  const enroll = lastClientRecord("RM_ENROLL", run.stdout);
  if (run.exitCode !== 0 || !enroll) {
    throw new Error(
      `member ${m.memberId}: enroll container failed (exit ${run.exitCode}) — ` +
        `no RM_ENROLL record. transcript tail: ${run.transcript.slice(-400)}`,
    );
  }

  if (enroll.keystoreKind === "rmpc") {
    // Real-onboarded identity: its key was bound at admission; there is
    // nothing the harness may legitimately re-register. A dead stored token
    // is an honest absence, not a re-key.
    if (!enroll.tokenValid) {
      throw new Error(
        `member ${m.memberId}: onboarded rmpc identity has no working bearer token — ` +
          "rendering the member absent rather than re-enrolling it under a new key (issue #361 Phase 3).",
      );
    }
    return {};
  }

  if (enroll.tokenValid) return {};
  if (!enroll.publicKey) {
    throw new Error(`member ${m.memberId}: enroll reported no stored token and no public key — cannot register`);
  }

  // The ONE privileged step, performed by the harness AS the RM operator
  // seeding the demo roster: register the container-generated PUBLIC key.
  // The private key never left the member's volume. rail.adminToken is the
  // only source (issue #461) — no local env-reading fallback lives here;
  // the legitimate standalone-entry-point fallback already happened once,
  // at railFromEnv() construction time, above.
  const adminHeaders: Record<string, string> = rail.adminToken
    ? { "X-Admin-Token": rail.adminToken }
    : {};
  const res = await fetch(`${rail.backendUrl ?? backendUrl()}${ROUTES.committee.register}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: m.memberId, name: m.name, lens: m.lens, publicKey: enroll.publicKey }),
  });
  const body = (await res.json()) as { token?: string; error?: string };
  if (!body.token) {
    throw new Error(`member ${m.memberId}: register returned no token (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  // Handed to the member's NEXT container run exactly once (ownerEnv, so it is
  // redacted from transcripts); the client persists it in its own keystore.
  return { freshToken: body.token };
}

// ── Session participation ───────────────────────────────────────────────────
// One container per present member per session. Throws on ANY failure — the
// caller (session.ts) settles rejections into an honest ABSENT.
export async function runAgent(rail: SessionRail, o: AgentOpts, onProgress?: AgentProgress) {
  const { freshToken } = await ensureMemberIdentity(rail, o);
  const onboarded = rail.onboardedHomes?.get(o.memberId);
  const homeVolume = onboarded?.volume ?? memberHomeVolumeName(rail.composeProject, o.memberId);

  const run = await runMemberContainer(rail, {
    mode: "participate",
    runId: `${o.memberId}-s${o.sessionId}-${crypto.randomUUID().slice(0, 6)}`,
    extraEnv: {
      RM_MEMBER_ID: o.memberId,
      RM_MEMBER_NAME: o.name,
      RM_MEMBER_LENS: o.lens,
      RM_MEMBER_BIAS: String(o.bias),
      RM_SESSION_DATE: o.date,
      RM_SUBJECT_ID: o.subjectId,
      RM_SESSION_ID: String(o.sessionId),
    },
    ownerEnv: {
      ...(freshToken ? { RM_MEMBER_TOKEN: freshToken } : {}),
      ...(onboarded?.passphrase ? { RMPC_COMMITTEE_IDENTITY_PASSPHRASE: onboarded.passphrase } : {}),
      // Same committed identity the enroll run seeded, so a participate run on a
      // FRESH volume (every restart draws a new project hash, hence a new
      // volume) still signs as this persona rather than as a stranger.
      ...(personaIdentityEnv(o.name) ?? {}),
    },
    homeVolume,
    timeoutMs: participateTimeoutMs(),
    onStdoutLine: onProgress
      ? (line) => {
          const ev = parseClientLine("RM_STAGE", line);
          if (ev && AGENT_STAGES.has(String(ev.stage))) {
            onProgress(ev.stage as AgentStage, { stance: ev.stance, confidence: ev.confidence });
          }
        }
      : undefined,
  });

  const result = lastClientRecord("RM_RESULT", run.stdout);
  if (run.timedOut || run.exitCode !== 0 || !result?.verified) {
    throw new Error(
      `member ${o.memberId}: session container ${run.timedOut ? "timed out" : `exited ${run.exitCode}`} ` +
        `without a verified submission. transcript tail: ${run.transcript.slice(-600)}`,
    );
  }
  return {
    memberId: o.memberId,
    stance: String(result.stance),
    confidence: Number(result.confidence),
    memoUrl: typeof result.memoUrl === "string" ? result.memoUrl : undefined,
    result: { verified: true },
  };
}

// Put a deliberate no-show on the roster WITHOUT participating, so absence is
// recorded at aggregation. Same identity rail (persistent volume, container-
// held key, one-time register) — the harness never generates a key for it.
export async function enroll(rail: SessionRail, m: EnrollableMember): Promise<void> {
  await ensureMemberIdentity(rail, m);
}
