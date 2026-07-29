// Real-inference onboarding eval harness (docs/architecture.md §11 R8, Stage 5
// of docs/plans/onboarding-ic-workflow.md). Launches ONE vanilla member-agent
// container (docker-compose.demo.yml's `member-agent` service,
// scripts/lib/member-agent/Dockerfile) per admission, injects the canonical
// copy-paste prompt (contract's ONBOARDING_PROMPT text, with only its skill URL
// pointed at this checkout's static asset) with a generated identity,
// then OBSERVES ONLY: this module never applies, signs, claims, or connects on
// the member's behalf. Everything from "install the skill" onward is the
// containerized agent's own real inference, working out §11.2 from the prompt
// + the installed committee-onboarding skill — exactly what a real prospective
// member's own agent would have to do (D21: over the committee REST API).
//
// Real inference is the DEFAULT mode here, never an optional extra. The model
// is whatever AGENT_MODEL resolves to against ./model-registry.ts — by default
// `opencode/deepseek-v4-flash`, a funded model billed to the environment's own
// OPENCODE_API_KEY (D22 as amended 2026-07-28).
//
// This used to pin the free, no-credential `opencode/big-pickle`. That pin is
// gone because the model is gone in practice: it is saturated upstream (429 on
// every probe from CI's host while sibling free models answered 200 at the same
// instant) and, having zero cost across every field with no paid sibling in
// Zen's catalogue, there is no funded tier to escape to. A keyless default that
// returns 429 is not a keyless default; it is an outage with a rationale. The
// `free` family in the registry remains available for genuinely unfunded runs.
//
// resolveModelConfig() throws loudly when a paid model is selected with no
// funded key — it never silently substitutes a different model behind the
// operator's back.
//
// ── Observe-only design, and its known coarseness ───────────────────────────
// The only two things this harness watches from OUTSIDE the container are:
//   (a) GET /api/committee/admin/members (admin) — to find the member row the
//       SERVER minted for this run's generated identity, matched by the
//       contact email this module generated and injected (the server mints
//       the id, never this harness — §11 R2); and
//   (b) GET /api/committee/apply/:id + GET /api/committee/members (public) —
//       once the id is known, to track applied → approved → claimed → on the
//       active roster.
// Nothing observable distinguishes "connect" from "discover" from "toolchain"
// before a member row exists — there is deliberately no telemetry hook into
// the agent's own reasoning (that would defeat the point of a black-box,
// external eval). Those three steps are therefore reported together as "done"
// the instant a member row appears (apply is gated on all three succeeding
// first, per §11 R6) and "pending" as one unit before that. This is a known,
// intentional limit of the observe-only design, not a bug — documented here
// rather than faked with invented per-step signals.
//
// ── What the harness supplies, and what it refuses to supply (§11.3 E7) ─────
// ONBOARDING_PROMPT's canonical text is injected with only the skill URL
// parameter changed to this stack's local static asset. Everything the harness
// adds rides in one clearly delimited note appended after it, and every line of
// that note is the OWNER's side of onboarding — the half a real applicant's
// human would have handled before their agent ever started:
//
//   - the display name and contact to apply under. The prompt tells the agent
//     to ASK its owner for these (it carries no fill-in-the-blank placeholders,
//     because operators paste it verbatim and "<display name>" then reaches the
//     server as a real application), and a headless container has no owner to
//     ask, so the note answers the question the prompt raised;
//   - the committee REST API base URL for this run (the prompt's doc link is a
//     production host this ephemeral demo stack cannot serve; a real human, per
//     the real docs, would be applying against committee.robotmoney.net);
//   - the keystore passphrase, exported into the container's environment
//     (KEYSTORE_PASSPHRASE_ENV) — the repo-owned committee-onboarding skill
//     tells the agent to ask its owner for exactly this and to WAIT for them,
//     which is unanswerable in a headless container;
//   - a vanilla, non-hostile permission set and the real auto-approve flag
//     (scripts/agent/member-agent.ts), so the eval measures our instructions
//     rather than our own sandbox refusing the agent's tool calls.
//
// Discovering WHAT to do — installing the committee-onboarding skill,
// installing rmpc, generating keys, signing, submitting the signed apply over
// REST, waiting, claiming — is still 100% the agent's own real inference. No
// harness-supplied string names a tool, an endpoint, a payload shape or a step
// (D21: the MCP transport is retired; the agent uses plain HTTP).
//
// ── Where the machinery lives now ─────────────────────────────────────
// The container mechanics (tmpdir + mounted opencode.json, deterministic
// container name, the `docker compose run` argv, both pipe drains, the launch
// watcher, guaranteed removal) live in the SHARED primitive
// scripts/agent/member-agent.ts, and the outcome vocabulary in
// scripts/agent/classify-outcome.ts (D22 "shared components", §11.3 E4/E5).
// This file is the layer-4 OBSERVER that rides that primitive: it resolves the
// model, supplies the prompt, and runs the poll loop — it never touches the
// container itself. Every moved symbol is re-exported below, so this module's
// public API is unchanged.
//
// MODEL SELECTION STAYS HERE, AND ONLY HERE. resolveModelConfig() below is the
// single place an AGENT_MODEL selector becomes a model id and a credential; the
// primitive takes that record and invents nothing.
import { buildOnboardingPrompt, path as routePath, ROUTES } from "@robotmoney/contract";
import { classifyOutcome, shouldRetry } from "../agent/classify-outcome.ts";
import { runMemberAgent } from "../agent/member-agent.ts";
import { finalAssistantText } from "../agent/transcript.ts";
import { AGENT_MODEL_ENV, DEFAULT_AGENT_MODEL, isKeylessModel, resolveAgentModel } from "./model-registry.ts";
import { ZEN_KEY_ENV, zenApiKey } from "./opencode-key.ts";
import {
  createOnboardingTelemetry,
  redactTelemetryText,
  type OnboardingEventSink,
  type OnboardingTelemetry,
} from "./onboarding-telemetry.ts";

// One definition of the compose file list and the compose argv prefix in the
// repo (scripts/stack/config.ts); re-exported here so every existing importer
// stays byte-compatible.
export { composeArgs, DEFAULT_COMPOSE_FILES } from "../stack/config.ts";
import { DEFAULT_COMPOSE_FILES } from "../stack/config.ts";
export {
  buildAgentOpencodeConfig,
  buildMemberAgentArgv,
  containerExists,
  drain,
  memberAgentContainerName,
  memberAgentSpawnEnv,
  redactSecrets,
  runMemberAgent,
  type MemberAgentModel,
} from "../agent/member-agent.ts";
// One outcome classifier for every member-agent run (§11.3 E4/E5) — the retry
// predicate below, the demo's onboarding driver, and the layer-4 scorecard all
// read the SAME definition. Re-exported so importers of this module keep
// working unchanged.
export {
  classifyOutcome,
  explainOutcome,
  formatOutcomeEvidence,
  livenessOf,
  looksRateLimited,
  looksRefusal,
  shouldRetry,
} from "../agent/classify-outcome.ts";
export type { ClassifiableRun, OnboardingOutcome, OutcomeExplanation } from "../agent/classify-outcome.ts";
export { assistantTextParts, extractAssistantText, finalAssistantText } from "../agent/transcript.ts";
// The committee REST API the member-agent container reaches over the compose
// network — the `api` service on its internal port. D21 retired the `mcp`
// service; the agent applies over this REST surface (POST /api/committee/apply)
// directly, following the committee-onboarding skill.
export const DEFAULT_API_URL_INTERNAL = "http://api:8787";
export const LOCAL_COMMITTEE_ONBOARDING_SKILL_PATH = "/skills/committee-onboarding/SKILL.md";
// Live-verified via a real GitHub Actions e2e run: a vanilla agent doing
// genuine reasoning (fetching docs, downloading rmpc, generating a key, and
// — when the linked skill's payload description wasn't quite enough —
// cloning the whole robotmoney-core repo to find the canonical serializer)
// was still productively working past 11 minutes, nowhere near stuck. The
// original 8-minute bound was arbitrary and too short for how much real
// work a prompt-only agent legitimately needs on the free/slower keyless
// tier; 20 minutes gave it realistic room without being unbounded.
//
// Raised again, 20 → 30 minutes, on measurement rather than feel. Four local
// admissions against the fixed harness (2026-07-28, opencode/deepseek-v4-flash,
// `bun run onboarding-eval`) took 148s, 331s, 347s and **1183s**. The tail is
// not a stuck agent: the slow sample was productively signing, submitting,
// reading the rejection and re-signing right up to the end, and it landed with
// 17 seconds to spare. A bound that a real success clears by 1.4% is a
// coin-flip gate, and a false "timed out" is the most expensive result this
// eval can produce — it reads as "our instructions failed" when they did not.
// This costs nothing on a fast run; it only stops truncating a slow one.
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_AUTO_APPROVE_DELAY_MS = 10_000; // §11 R7
// The env var `rmpc` reads its keystore passphrase from — the ONE secret the
// repo-owned committee-onboarding skill tells the agent to have its human owner
// export before launching it. The harness plays the owner here (see
// demoHarnessNote); it is not a hint about what the agent should do with it.
// Same name scripts/rmpc-release-e2e.ts and the rails check already use.
export const KEYSTORE_PASSPHRASE_ENV = "RMPC_COMMITTEE_IDENTITY_PASSPHRASE";

// ── Identity generation (R1/R4: the harness stands in for "the human owner") ─
export interface OnboardingIdentity {
  runId: string;
  name: string;
  contact: string;
}

export function generateIdentity(runId: string = crypto.randomUUID().slice(0, 8)): OnboardingIdentity {
  return {
    runId,
    name: `Onboarding Eval ${runId}`,
    contact: `onboarding-eval-${runId}@example.test`,
  };
}

// Everything this run needs that the canonical prompt deliberately does not
// carry, in one clearly delimited block appended AFTER the canonical prompt
// whose only eval-specific parameter is its locally served skill URL. It is
// exactly what a real applicant's own owner
// would have already told their agent, and nothing more (§11.3 E7):
//
//  1. the display name and contact to apply under (R1). The prompt used to
//     embed literal `<display name>`/`<email>` placeholders that this harness
//     substituted in place; those placeholders are GONE, because real operators
//     paste the prompt verbatim and the literal string "<display name>" reached
//     the server as an actual application. The prompt now *asks* its owner for
//     identity, so the harness answers that question here instead of rewriting
//     the canonical text — which is what keeps this an eval of the real prompt
//     rather than of a harness-only variant;
//  2. the committee API base URL — the ephemeral demo stack cannot serve the
//     production host the docs name;
//  3. that the owner has already put the secrets they'd otherwise be asked to
//     type into the session's environment.
//
// (3) is not a convenience. The repo-owned committee-onboarding skill tells the
// agent, in as many words, to ask its owner to export the keystore passphrase
// and to *wait* for them ("Tell me once it's set"), and forbids accepting the
// value in conversation. A headless eval container has no owner to answer, so
// an agent that follows the skill correctly stops there — which is exactly the
// observed failure: 2026-07-28 run 30395466780, `deepseek-v4-flash` ended its
// session cleanly (exit 0) with every onboarding step still pending. The fix is
// to make the harness do the owner's half of that exchange, the same way it
// answers the identity question in (1) — NOT to tell the agent what to do with
// it. The note deliberately names no tool, no env var, no endpoint and no step:
// discovering all of that is still 100% the agent's own inference from the
// prompt + the skill.
function demoHarnessNote(identity: OnboardingIdentity, apiBaseUrl: string): string {
  return (
    "\n\n---\n" +
    "Demo harness note (environment info, not part of your task):\n" +
    `- Apply as "${identity.name}" with contact email ${identity.contact}. The ` +
    "instructions above tell you to ask for these; this run is unattended, so " +
    "take them from here rather than waiting for a reply.\n" +
    `- The Robot Money committee REST API for this run is reachable at ${apiBaseUrl} ` +
    "over this local demo network. Apply against that base URL instead of the " +
    "production host in the docs, which this ephemeral demo stack does not serve.\n" +
    "- Your owner is not at the keyboard for this session and cannot answer " +
    "anything else, but has already exported into this environment every secret " +
    "you would otherwise have had to ask them to type — so proceed on your own " +
    "rather than waiting on them.\n" +
    "Everything above this note is unchanged."
  );
}

// The canonical prompt used by the eval. Production keeps the published GitHub
// URL in ONBOARDING_PROMPT; the eval changes only that URL so the agent fetches
// the repo-owned skill from the same API container it is already evaluating.
export function buildEvalOnboardingPrompt(apiBaseUrl: string = DEFAULT_API_URL_INTERNAL): string {
  const localSkillUrl = `${apiBaseUrl.replace(/\/+$/, "")}${LOCAL_COMMITTEE_ONBOARDING_SKILL_PATH}`;
  return buildOnboardingPrompt(localSkillUrl);
}

// The exact text injected into the container: the URL-parameterized canonical
// prompt as the prefix, plus the harness note (kept clearly delimited and
// separate, per the module doc comment above).
export function buildAgentPrompt(identity: OnboardingIdentity, apiBaseUrl: string = DEFAULT_API_URL_INTERNAL): string {
  return `${buildEvalOnboardingPrompt(apiBaseUrl)}${demoHarnessNote(identity, apiBaseUrl)}`;
}

// ── Model configuration ─────────────────────────────────────────────────────
// The model is selected by ONE signal, AGENT_MODEL, resolved against the
// versioned registry in ./model-registry.ts (`deepseek`, `kimi/k2.6`, …). The
// credential is the single OpenCode Zen key, OPENCODE_API_KEY, whose value
// differs per environment (CI secret vs Stage .env) — see ./opencode-key.ts.
//
// A container inherits no ambient environment, so BOTH have to be resolved here
// and passed in explicitly: the model on argv, the key via `-e`.
export const DEFAULT_INFERENCE_MODEL = DEFAULT_AGENT_MODEL;

export interface ModelConfig {
  model: string;
  apiKeyEnv: typeof ZEN_KEY_ENV | null;
  apiKey: string | null;
  /** True when the resolved model needs no credit (the `free` family). */
  keyless: boolean;
}

// Resolves the model + credential the member-agent container will run with.
//
// A paid model with no funded key THROWS here rather than at the far end of a
// container boot: the failure is a configuration mistake, and it costs ~20
// minutes of stack bring-up to discover it any later. Selecting a `free/…`
// model is the supported way to run with no key at all.
export function resolveModelConfig(env: Record<string, string | undefined> = process.env): ModelConfig {
  const model = resolveAgentModel(env); // throws loudly on an unknown family/model
  const keyless = isKeylessModel(model);
  const apiKey = zenApiKey(env);

  if (keyless) return { model, apiKeyEnv: null, apiKey: null, keyless };

  if (!apiKey) {
    throw new Error(
      `${AGENT_MODEL_ENV} resolved to ${model}, which is a paid OpenCode Zen model, but ${ZEN_KEY_ENV} is not set. ` +
        `Set ${ZEN_KEY_ENV} (CI: repository secret; Stage/local: .env), or select a keyless model ` +
        `(${AGENT_MODEL_ENV}=free, or free/<model>). Refusing to silently substitute a different model.`,
    );
  }
  return { model, apiKeyEnv: ZEN_KEY_ENV, apiKey, keyless };
}

// `buildAgentOpencodeConfig(model)` moved to the shared primitive
// (scripts/agent/member-agent.ts) with the rest of the container mechanics, and
// is re-exported at the top of this file — its signature is unchanged: the
// model is a parameter, resolved by resolveModelConfig() above.

// ── Step-state derivation (pure; testable without Docker) ───────────────────
export const ONBOARDING_STEPS = ["connect", "discover", "toolchain", "apply", "approve", "claim", "session"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export interface StepState {
  step: OnboardingStep;
  status: "pending" | "done";
}

export type ApplyState = "applied" | "approved" | "claimed" | "rejected" | "inactive" | null;

export interface ObservedApplication {
  memberId: string | null;
  applyState: ApplyState;
  onActiveRoster: boolean;
}

export function deriveSteps(observed: ObservedApplication): StepState[] {
  // Approval activates the member row before the agent proves possession and
  // claims its token. The states are therefore not a simple roster-derived
  // rank: active-roster membership can complete approve, but never claim.
  const applied = observed.memberId !== null;
  const approved = observed.applyState === "approved" || observed.applyState === "claimed" || observed.onActiveRoster;
  const claimed = observed.applyState === "claimed";
  const sessionReady = claimed && observed.onActiveRoster;
  const done = new Set<OnboardingStep>([
    ...(applied ? (["connect", "discover", "toolchain", "apply"] as OnboardingStep[]) : []),
    ...(approved ? (["approve"] as OnboardingStep[]) : []),
    ...(claimed ? (["claim"] as OnboardingStep[]) : []),
    ...(sessionReady ? (["session"] as OnboardingStep[]) : []),
  ]);
  return ONBOARDING_STEPS.map((step) => ({ step, status: done.has(step) ? "done" : "pending" }));
}

export function isFullyOnboarded(observed: ObservedApplication & { claimedAt: string | null }): boolean {
  return observed.applyState === "claimed" && observed.claimedAt !== null && observed.onActiveRoster;
}

// ── External observation (public status route + admin roster) ───────────────
async function findMemberIdByContact(backendUrl: string, adminToken: string, contact: string): Promise<string | null> {
  const res = await fetch(`${backendUrl}${ROUTES.committee.admin.members}`, { headers: { "X-Admin-Token": adminToken } });
  if (!res.ok) throw new Error(`GET ${ROUTES.committee.admin.members} -> ${res.status}`);
  const body = (await res.json()) as { members: Array<{ id: string; contactEmail: string | null }> };
  return body.members.find((m) => m.contactEmail === contact)?.id ?? null;
}

interface ApplyStatusObservation {
  state: ApplyState;
  claimedAt: string | null;
}

async function fetchApplyStatus(backendUrl: string, memberId: string): Promise<ApplyStatusObservation | null> {
  const p = routePath(ROUTES.committee.applyStatus, { id: memberId });
  const res = await fetch(`${backendUrl}${p}`);
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  const body = (await res.json()) as { state: ApplyState; claimedAt?: string | null };
  return { state: body.state, claimedAt: body.claimedAt ?? null };
}

async function isOnActiveRoster(backendUrl: string, memberId: string): Promise<boolean> {
  const res = await fetch(`${backendUrl}${ROUTES.committee.members}`);
  if (!res.ok) throw new Error(`GET ${ROUTES.committee.members} -> ${res.status}`);
  const body = (await res.json()) as { members: Array<{ id: string }> };
  return body.members.some((m) => m.id === memberId);
}

export interface ObserverPollTracker {
  poll<T>(endpoint: string, read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }>;
  persistentError(): string | null;
}

/**
 * Track failures per observer endpoint, logging only state transitions. A
 * recovered read remains useful evidence in the merged timeline; a failure
 * still active when observation ends makes the whole run a harness error.
 */
export function createObserverPollTracker(log: (message: string) => void): ObserverPollTracker {
  const failures = new Map<string, string>();
  return {
    async poll<T>(endpoint: string, read: () => Promise<T>) {
      try {
        const value = await read();
        if (failures.delete(endpoint)) log(`observer.poll.recovered endpoint=${endpoint}`);
        return { ok: true as const, value };
      } catch (error) {
        const message = redactTelemetryText(error instanceof Error ? error.message : String(error));
        if (failures.get(endpoint) !== message) {
          log(`observer.poll.failed endpoint=${endpoint} error=${message}`);
        }
        failures.set(endpoint, message);
        return { ok: false as const };
      }
    },
    persistentError() {
      if (failures.size === 0) return null;
      return [...failures]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([endpoint, message]) => `${endpoint}: ${message}`)
        .join("; ");
    },
  };
}

// Auto-approve watcher (§11 R7): after an application completes ("applied"),
// wait autoApproveDelayMs then approve through the SAME admin API a human
// uses — config only, no separate code path. Exported standalone so Stage 6's
// demo-wide watcher (or a test) can reuse it without going through the full
// per-admission eval.
export function scheduleAutoApprove(
  backendUrl: string,
  adminToken: string,
  memberId: string,
  delayMs: number = DEFAULT_AUTO_APPROVE_DELAY_MS,
  onEvent: (msg: string) => void = () => {},
): void {
  setTimeout(() => {
    fetch(`${backendUrl}${ROUTES.committee.admin.activate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": adminToken },
      body: JSON.stringify({ memberId }),
    })
      .then(async (res) => {
        if (!res.ok) onEvent(`auto-approve activate for ${memberId} failed: ${res.status} ${await res.text()}`);
        else onEvent(`auto-approved ${memberId} (§11 R7)`);
      })
      .catch((e) => onEvent(`auto-approve activate for ${memberId} threw: ${e instanceof Error ? e.message : String(e)}`));
  }, delayMs);
}

// ── Orchestration ────────────────────────────────────────────────────────────
export interface RunOnboardingEvalOptions {
  repoRoot: string;
  composeProject: string; // the ALREADY-RUNNING demo stack's compose project name
  composeFiles?: string[];
  backendUrl: string; // host-published backend URL for THIS harness's own polling
  apiUrlInternal?: string; // the committee REST API base the CONTAINER reaches over the compose network
  adminToken: string;
  env?: Record<string, string | undefined>; // resolveModelConfig source; default process.env
  timeoutMs?: number;
  pollIntervalMs?: number;
  autoApproveDelayMs?: number;
  identity?: OnboardingIdentity;
  onEvent?: (msg: string) => void;
  /** Exact environment returned by createStack; used by Compose child calls. */
  composeSpawnEnv?: Record<string, string>;
  /** Optional structured stream; omitted by existing demo/CI callers. */
  onStructuredEvent?: OnboardingEventSink;
  /** Shared sequencer for callers that also merge service/cleanup logs. */
  telemetry?: OnboardingTelemetry;
  attempt?: number;
}

export interface OnboardingEvalResult {
  identity: OnboardingIdentity;
  memberId: string | null;
  steps: StepState[];
  admitted: boolean;
  /** Public apply state, distinct from active-roster membership. */
  applyState: ApplyState;
  /** Public proof that the one-time bearer claim completed. */
  claimedAt: string | null;
  /** Approval/activation signal; does not by itself mean onboarding succeeded. */
  onActiveRoster: boolean;
  timedOut: boolean;
  containerExitCode: number | null;
  // Was the container ever observed to exist? See MemberAgentResult. `null`
  // means the launch watcher could not tell, which is deliberately NOT
  // treated as evidence of anything.
  containerLaunched: boolean | null;
  /** Active observer failures at the end of the run; classifies as harness-error. */
  observerError: string | null;
  // ALWAYS populated, including for an admitted run (changed 2026-07-27).
  // Withholding it from successes made the successful and the failed runs of
  // one sweep incomparable: when four samples produced nothing, there was no
  // healthy run from the SAME sweep to diff them against, and the first hours
  // of the investigation went into re-deriving what a good run even looks like.
  //
  // NOT a "transcript" in the narrow sense: this is the whole combined
  // stdout+stderr of the `docker compose run` process. The agent's own NDJSON
  // is the stdout portion — and when the container never starts, there is no
  // agent output anywhere, because this stream is the only place the agent
  // ever writes.
  //
  // REDACTED at the source of every secret the harness injected (the model
  // credential and the keystore passphrase) — scripts/agent/member-agent.ts's
  // redactSecrets. This string is printed whole into CI logs and the demo
  // console, and an agent exploring its container runs `env`.
  transcript?: string;
}

/**
 * Launch one member-agent container, inject the canonical prompt (R4, with
 * only its skill URL pointed at this stack — see module doc comment),
 * and observe until the member reaches the active roster ("admitted") or the
 * overall timeout elapses. Never acts on the member's behalf — the only
 * server-side action this function ever takes is the R7 auto-approve, which
 * is the SAME admin action a human operator performs.
 */
export async function runOnboardingEval(opts: RunOnboardingEvalOptions): Promise<OnboardingEvalResult> {
  const env = opts.env ?? process.env;
  const modelConfig = resolveModelConfig(env); // throws loudly — no fallback (see doc comment)
  const identity = opts.identity ?? generateIdentity();
  const apiUrlInternal = opts.apiUrlInternal ?? DEFAULT_API_URL_INTERNAL;
  const composeFiles = opts.composeFiles ?? DEFAULT_COMPOSE_FILES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const autoApproveDelayMs = opts.autoApproveDelayMs ?? DEFAULT_AUTO_APPROVE_DELAY_MS;
  const telemetry =
    opts.telemetry ??
    createOnboardingTelemetry(
      { composeProject: opts.composeProject, runId: identity.runId, attempt: opts.attempt },
      opts.onStructuredEvent,
      [{ value: identity.contact, placeholder: "<contact redacted>" }],
    );
  const log = (message: string) => {
    opts.onEvent?.(message);
    telemetry.emit({
      source: "harness",
      stream: "event",
      // Contact is useful on the interactive console but is local PII and is
      // never persisted in structured telemetry.
      message: redactTelemetryText(message, [{ value: identity.contact, placeholder: "<contact redacted>" }]),
    });
  };

  const prompt = buildAgentPrompt(identity, apiUrlInternal);

  // Fresh per run and never reused: the keystore it protects is created inside
  // a container that is destroyed at the end of this function, and the value is
  // redacted out of the transcript by the primitive that injects it.
  const keystorePassphrase = crypto.randomUUID();

  // Everything the container needs — the mounted opencode.json, the
  // deterministic name, the `docker compose run` argv (including the single
  // `-e` credential injection when the resolved model is funded), both pipe
  // drains, the launch watcher, the kill + `docker rm -f`, the tmpdir removal
  // — belongs to the shared primitive. What stays HERE is the model resolution
  // and the observation: the poll loop below runs as the primitive's `observe`
  // hook, so it owns all timing exactly as it did when it was inlined
  // (deadline, post-exit grace, and the auto-approve watcher), and the
  // primitive's own timeout is deliberately not used.
  let memberId: string | null = null;
  let applyState: ApplyState = null;
  let claimedAt: string | null = null;
  let onActiveRoster = false;
  let admitted = false;
  let timedOut = false;
  let observerError: string | null = null;
  const observer = createObserverPollTracker(log);

  log(
    `launching member-agent container for ${identity.contact} (model=${modelConfig.model}, ` +
      `${modelConfig.apiKeyEnv ? `funded via ${modelConfig.apiKeyEnv}` : "keyless"})`,
  );
  const run = await runMemberAgent({
    repoRoot: opts.repoRoot,
    composeProject: opts.composeProject,
    composeFiles,
    prompt,
    runId: identity.runId,
    modelConfig,
    // The owner's half of onboarding, left in the environment exactly the way a
    // real owner would leave it before launching their agent (see
    // demoHarnessNote's comment). Never logged, never read back by this
    // harness — the keystore it protects lives and dies inside the container.
    ownerEnv: { [KEYSTORE_PASSPHRASE_ENV]: keystorePassphrase },
    redactions: [{ value: identity.contact, placeholder: "<contact redacted>" }],
    composeSpawnEnv: opts.composeSpawnEnv,
    title: `onboarding-eval-${identity.runId}`,
    onEvent: log,
    telemetry,
    attempt: opts.attempt,
    observe: async (handle) => {
      const deadline = Date.now() + timeoutMs;
      // Once the container itself has exited, cap how much longer we keep
      // polling: the R7 auto-approve delay plus margin covers the ONE thing
      // that can still land after the agent's own process ends (the harness's
      // own scheduled activate call); nothing else can advance with no agent
      // left to drive it.
      const postExitGraceMs = autoApproveDelayMs + 20_000;

      let approveScheduledForMemberId: string | null = null;
      let containerExitedAt: number | null = null;
      let lastLoggedApplyState: ApplyState = null;

      for (;;) {
        if (handle.exitCode !== null && containerExitedAt === null) {
          containerExitedAt = Date.now();
          log(`member-agent container exited (code ${handle.exitCode})`);
        }

        if (!memberId) {
          const observedMember = await observer.poll("admin.members", () =>
            findMemberIdByContact(opts.backendUrl, opts.adminToken, identity.contact),
          );
          if (observedMember.ok) memberId = observedMember.value;
          if (observedMember.ok && memberId) {
            telemetry.setMemberId(memberId);
            log(`observed server-minted memberId=${memberId} for ${identity.contact} (§11 R2)`);
          }
        }
        if (memberId) {
          const observedStatus = await observer.poll("application.status", () =>
            fetchApplyStatus(opts.backendUrl, memberId!),
          );
          const status = observedStatus.ok ? observedStatus.value : null;
          if (observedStatus.ok && status) {
            applyState = status.state;
            claimedAt = status.claimedAt;
            if (applyState !== lastLoggedApplyState) {
              lastLoggedApplyState = applyState;
              log(`observed public application state=${applyState} claimedAt=${claimedAt ? "present" : "absent"}`);
            }
          }
          if (applyState === "applied" && approveScheduledForMemberId !== memberId) {
            approveScheduledForMemberId = memberId;
            log(`application ${memberId} applied — auto-approving in ${autoApproveDelayMs}ms (§11 R7)`);
            scheduleAutoApprove(opts.backendUrl, opts.adminToken, memberId, autoApproveDelayMs, log);
          }
          const observedRoster = await observer.poll("committee.members", () =>
            isOnActiveRoster(opts.backendUrl, memberId!),
          );
          if (observedRoster.ok) onActiveRoster = observedRoster.value;
        }

        if (
          observer.persistentError() === null &&
          isFullyOnboarded({ memberId, applyState, claimedAt, onActiveRoster })
        ) break;
        if (Date.now() >= deadline) break; // overall timeout
        if (containerExitedAt !== null && Date.now() - containerExitedAt >= postExitGraceMs) break; // nothing left to advance it

        await Bun.sleep(pollIntervalMs);
      }

      // Computed BEFORE the primitive kills anything, exactly as before.
      observerError = observer.persistentError();
      admitted = observerError === null && isFullyOnboarded({ memberId, applyState, claimedAt, onActiveRoster });
      timedOut = !admitted && Date.now() >= deadline;
    },
  });

  const steps = deriveSteps({ memberId, applyState, onActiveRoster });
  log(`eval finished: admitted=${admitted} timedOut=${timedOut} steps=${JSON.stringify(steps)}`);

  return {
    identity,
    memberId,
    steps,
    admitted,
    applyState,
    claimedAt,
    onActiveRoster,
    timedOut,
    containerExitCode: run.exitCode,
    containerLaunched: run.containerLaunched,
    observerError,
    transcript: run.transcript,
  };
}

// ── CI retry/backoff wrapper (Stage 7, §11 R8) ──────────────────────────────
// Three known-flaky, NON-EVAL failure modes get ONE retry with backoff; any
// OTHER failure (the agent genuinely couldn't navigate onboarding, a container
// crash, a broken harness) IS a real result and is never retried. This wrapper
// only softens outcomes in which the agent never actually ATTEMPTED onboarding,
// it does not relax the eval itself:
//   1. `rate-limited` — a provider 429/overload that DOMINATES the run (see
//      scripts/agent/classify-outcome.ts: a 429 appearing only inside tool
//      output is NOT this). The self-hosted CI runner shares its IP with the
//      standing rmdemo_* demo stack, which has caused 429 flake on other
//      live-model-call gates before. Checked regardless of which model is
//      configured.
//   2. `refused` — the model declined the prompt outright, so the agent never
//      ATTEMPTED onboarding at all. Identical reasoning to case 1. This is the
//      fix for the 2026-07-25 demo run that admitted zero members: the agent
//      refused, exited 0 in ~15s, nothing retried it, and the finite newcomer
//      roster (scripts/lib/demo-newcomers.ts) permanently lost a seat. See
//      scripts/agent/classify-outcome.ts for the three-conjunct evidence a
//      refusal must show before it earns a retry.
//   3. `timed-out` — on ANY tier. This used to be restricted to the KEYLESS
//      tier, on committee-opencode-nightly.yml's documented experience that a
//      free-tier "call can take minutes and occasionally returns nothing",
//      with the corollary that a FUNDED model is fast/reliable enough for a
//      timeout to keep meaning what it always meant. Measurement retired that
//      corollary: on 2026-07-28 a funded `opencode/deepseek-v4-flash` run
//      generated its key, printed "Key generated! Now I need to build the
//      canonical application payload bytes", and then emitted nothing at all
//      for ~18 minutes until the harness killed it — no tool call, no token,
//      no error. Zen stalls mid-session whoever is paying.
//
//      This is NOT a softened bar, because a timeout is not how a genuine
//      navigation failure presents. The one real navigation failure we have
//      measured (CI run 30395466780) EXITED — cleanly, code 0, every step
//      pending — and a container exit is never retried by this wrapper, on any
//      tier. A timeout means the harness has NO signal either way about
//      whether the instructions were followable, which §11.3 E4 already
//      classifies as its own outcome (`timed-out`), distinct from
//      `navigation-failure`. Reporting "our onboarding docs failed" on the
//      strength of an upstream hang is the more dishonest of the two options.
//
// `harness-error` is deliberately NOT retryable: the harness is broken the same
// way on the next attempt, so a retry costs another twenty minutes and turns
// one loud diagnosis into two quiet ones.
//
// ONE definition of both the classification and the retry decision (§11.3 E5):
// `classifyOutcome` + `shouldRetry` come from scripts/agent/classify-outcome.ts
// and are shared with the demo's onboarding driver and the layer-4 scorecard.
// Nothing is added on top of `shouldRetry` here any more: dropping case 3's
// tier gate removed the one place this wrapper's policy diverged from the
// shared one, so there is now exactly one retry decision in the repo.
//
// LOAD-BEARING BOUNDARY: this wrapper serves the DEMO's onboarding driver and
// the nightly's real-inference admissions. D22 §11.3 E4's layer-4 SAMPLER must
// call the bare runOnboardingEval and classify each sample itself — retrying
// refusals inside the sampler would erase the refusal RATE, which is the metric
// the whole eval exists to report.

export interface RunOnboardingEvalWithRetryOptions extends RunOnboardingEvalOptions {
  maxAttempts?: number; // default 2 (1 retry)
  backoffMsSchedule?: number[]; // delay BEFORE each retry attempt (index 0 = before attempt 2)
  // Injectable for testing the retry/backoff DECISION LOGIC without Docker or
  // a model call — defaults to the real runOnboardingEval. Never mock this in
  // a test that is supposed to prove the real eval path works; that coverage
  // lives in scripts/tests/integration/onboarding-eval-infra.test.ts's Docker-backed
  // block instead (test-coverage-policy #4: don't mock the subject under
  // test).
  runOnce?: (opts: RunOnboardingEvalOptions) => Promise<OnboardingEvalResult>;
}

export const DEFAULT_RETRY_BACKOFF_MS = [45_000];

// Identity for attempt N. Attempt 1 uses the caller's identity exactly as
// before. Later attempts DERIVE from it instead of discarding it: the display
// NAME is preserved (the demo's roster records the planned newcomer's name, and
// a retry that admitted "Onboarding Eval ci-retry-2-…" instead would put a
// different person on the committee than the one the demo announced), while the
// runId and the contact local-part get an -rN suffix so no attempt ever re-uses
// a contact — the key this harness matches the server-minted member row on.
export function retryIdentity(base: OnboardingIdentity | undefined, attempt: number): OnboardingIdentity {
  if (attempt === 1) return base ?? generateIdentity(`ci-retry-1-${crypto.randomUUID().slice(0, 6)}`);
  if (!base) return generateIdentity(`ci-retry-${attempt}-${crypto.randomUUID().slice(0, 6)}`);
  const at = base.contact.indexOf("@");
  const contact = at === -1 ? `${base.contact}-r${attempt}` : `${base.contact.slice(0, at)}-r${attempt}${base.contact.slice(at)}`;
  return { runId: `${base.runId}-r${attempt}`, name: base.name, contact };
}

export async function runOnboardingEvalWithRetry(opts: RunOnboardingEvalWithRetryOptions): Promise<OnboardingEvalResult> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const backoff = opts.backoffMsSchedule ?? DEFAULT_RETRY_BACKOFF_MS;
  const runOnce = opts.runOnce ?? runOnboardingEval;
  const log = opts.onEvent ?? (() => {});
  // Resolved for its SIDE EFFECT of failing loudly on a misconfigured model
  // selector BEFORE any attempt is spent. The retry decision itself no longer
  // depends on the tier (see case 3 in the doc comment above: funded Zen stalls
  // mid-session too), so nothing reads the returned config.
  resolveModelConfig(opts.env ?? process.env);
  let last: OnboardingEvalResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Fresh CONTACT per attempt — reusing one across retries would re-apply
    // with an already-used contact and confuse the "which member row is this"
    // lookup the harness relies on to observe progress. The caller's display
    // name survives (see retryIdentity).
    const identity = retryIdentity(opts.identity, attempt);
    last = await runOnce({ ...opts, identity, attempt });
    if (last.admitted) return last;
    const outcome = classifyOutcome(last);
    // The shared, pure decision over the classified outcome, applied whole. A
    // container EXIT is never retried on any tier — `navigation-failure` is not
    // in shouldRetry's set — and that is how a genuine navigation failure
    // presents.
    const worthRetrying = shouldRetry(outcome);
    // Always logged, retried or not: a misclassification must be diagnosable
    // from CI logs rather than invisible.
    log(
      `onboarding eval attempt ${attempt}/${maxAttempts} did not admit — classified ${outcome}; ` +
        `agent's final message: ${JSON.stringify(finalAssistantText(last.transcript ?? "").slice(0, 200))}`,
    );
    if (attempt === maxAttempts || !worthRetrying) return last;
    const delayMs = backoff[Math.min(attempt - 1, backoff.length - 1)];
    const reason =
      outcome === "rate-limited"
        ? "looked rate-limited"
        : outcome === "refused"
          ? "was refused by the model (the agent never attempted onboarding)"
          : "timed out with no signal either way";
    log(`onboarding eval attempt ${attempt}/${maxAttempts} ${reason} — retrying in ${delayMs}ms (§11 R8)`);
    await Bun.sleep(delayMs);
  }
  return last!;
}
