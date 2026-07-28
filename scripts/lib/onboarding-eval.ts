// Real-inference onboarding eval harness (docs/architecture.md §11 R8, Stage 5
// of docs/plans/onboarding-ic-workflow.md). Launches ONE vanilla member-agent
// container (docker-compose.demo.yml's `member-agent` service,
// scripts/lib/member-agent/Dockerfile) per admission, injects the canonical
// copy-paste prompt (contract's ONBOARDING_PROMPT) with a generated identity,
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
// ── Local-network substitution for the unprovisioned staging committee host
// ONBOARDING_PROMPT is injected with its <display name>/<email> placeholders
// filled in (exactly as the prompt's own text says a human would do by hand
// before pasting). Nothing else about the prompt text is changed. Because the
// prompt's doc link is a production URL this ephemeral demo stack cannot serve,
// the injected prompt carries a harness note with the committee REST API base
// URL reachable over this run's compose network — the ONE piece of information
// a real applicant's own agent would already have (a human, per the real docs,
// would apply against committee.robotmoney.net). Discovering WHAT to do —
// installing the committee-onboarding skill, installing rmpc, generating keys,
// signing, submitting the signed apply over REST, waiting, claiming — is still
// 100% the agent's own real inference; nothing carries onboarding-specific
// knowledge (D21: the MCP transport is retired; the agent uses plain HTTP).
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
import { ONBOARDING_PROMPT, path as routePath, ROUTES } from "@robotmoney/contract";
import { classifyOutcome, shouldRetry } from "../agent/classify-outcome.ts";
import { runMemberAgent } from "../agent/member-agent.ts";
import { finalAssistantText } from "../agent/transcript.ts";
import { AGENT_MODEL_ENV, DEFAULT_AGENT_MODEL, isKeylessModel, resolveAgentModel } from "./model-registry.ts";
import { ZEN_KEY_ENV, zenApiKey } from "./opencode-key.ts";

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
// Live-verified via a real GitHub Actions e2e run: a vanilla agent doing
// genuine reasoning (fetching docs, downloading rmpc, generating a key, and
// — when the linked skill's payload description wasn't quite enough —
// cloning the whole robotmoney-core repo to find the canonical serializer)
// was still productively working past 11 minutes, nowhere near stuck. The
// original 8-minute bound was arbitrary and too short for how much real
// work a prompt-only agent legitimately needs on the free/slower keyless
// tier; 20 minutes gives it realistic room without being unbounded.
export const DEFAULT_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_AUTO_APPROVE_DELAY_MS = 10_000; // §11 R7

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

// Fill the prompt's literal <display name>/<email> placeholders — exactly the
// substitution the prompt's own text describes a human doing by hand before
// pasting. Throws if either placeholder is missing so a future edit to
// ONBOARDING_PROMPT can never silently strand a real name/contact string out
// of the injected prompt.
export function fillPromptIdentity(prompt: string, identity: OnboardingIdentity): string {
  if (!prompt.includes("<display name>") || !prompt.includes("<email>")) {
    throw new Error("ONBOARDING_PROMPT no longer contains the <display name>/<email> placeholders this harness fills in");
  }
  return prompt.replace("<display name>", identity.name).replace("<email>", identity.contact);
}

function demoNetworkNote(apiBaseUrl: string): string {
  return (
    "\n\n---\n" +
    "Demo harness note (environment info, not part of your task): the Robot " +
    `Money committee REST API for this run is reachable at ${apiBaseUrl} over ` +
    "this local demo network. Apply against that base URL instead of the " +
    "production host in the docs (which this ephemeral demo stack does not " +
    "serve) — everything else above is unchanged."
  );
}

// The exact text injected into the container — ONBOARDING_PROMPT with its
// identity placeholders filled, plus the harness's local-network note (kept
// clearly delimited and separate, per the module doc comment above).
export function buildAgentPrompt(identity: OnboardingIdentity, apiBaseUrl: string = DEFAULT_API_URL_INTERNAL): string {
  return `${fillPromptIdentity(ONBOARDING_PROMPT, identity)}${demoNetworkNote(apiBaseUrl)}`;
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

// See the module doc comment ("observe-only design, and its known
// coarseness") for why connect/discover/toolchain are reported as ONE unit.
function observedRank(observed: ObservedApplication): number {
  if (observed.onActiveRoster) return ONBOARDING_STEPS.indexOf("session");
  if (observed.applyState === "claimed") return ONBOARDING_STEPS.indexOf("claim");
  if (observed.applyState === "approved") return ONBOARDING_STEPS.indexOf("approve");
  if (observed.memberId) return ONBOARDING_STEPS.indexOf("apply"); // member row exists ⇒ apply landed
  return -1; // no observable signal yet
}

export function deriveSteps(observed: ObservedApplication): StepState[] {
  const rank = observedRank(observed);
  return ONBOARDING_STEPS.map((step, i) => ({ step, status: i <= rank ? "done" : "pending" }) as StepState);
}

// ── External observation (public status route + admin roster) ───────────────
async function findMemberIdByContact(backendUrl: string, adminToken: string, contact: string): Promise<string | null> {
  const res = await fetch(`${backendUrl}${ROUTES.committee.admin.members}`, { headers: { "X-Admin-Token": adminToken } });
  if (!res.ok) throw new Error(`GET ${ROUTES.committee.admin.members} -> ${res.status}`);
  const body = (await res.json()) as { members: Array<{ id: string; contactEmail: string | null }> };
  return body.members.find((m) => m.contactEmail === contact)?.id ?? null;
}

async function fetchApplyState(backendUrl: string, memberId: string): Promise<ApplyState> {
  const p = routePath(ROUTES.committee.applyStatus, { id: memberId });
  const res = await fetch(`${backendUrl}${p}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { state: ApplyState };
  return body.state;
}

async function isOnActiveRoster(backendUrl: string, memberId: string): Promise<boolean> {
  const res = await fetch(`${backendUrl}${ROUTES.committee.members}`);
  if (!res.ok) throw new Error(`GET ${ROUTES.committee.members} -> ${res.status}`);
  const body = (await res.json()) as { members: Array<{ id: string }> };
  return body.members.some((m) => m.id === memberId);
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
}

export interface OnboardingEvalResult {
  identity: OnboardingIdentity;
  memberId: string | null;
  steps: StepState[];
  admitted: boolean;
  timedOut: boolean;
  containerExitCode: number | null;
  // Was the container ever observed to exist? See MemberAgentResult. `null`
  // means the launch watcher could not tell, which is deliberately NOT
  // treated as evidence of anything.
  containerLaunched: boolean | null;
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
  transcript?: string;
}

/**
 * Launch one member-agent container, inject the canonical prompt (R4,
 * verbatim aside from the identity placeholders — see module doc comment),
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
  const log = opts.onEvent ?? (() => {});

  const prompt = buildAgentPrompt(identity, apiUrlInternal);

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
  let onActiveRoster = false;
  let admitted = false;
  let timedOut = false;

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
    title: `onboarding-eval-${identity.runId}`,
    onEvent: log,
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

      for (;;) {
        if (handle.exitCode !== null && containerExitedAt === null) {
          containerExitedAt = Date.now();
          log(`member-agent container exited (code ${handle.exitCode})`);
        }

        if (!memberId) {
          memberId = await findMemberIdByContact(opts.backendUrl, opts.adminToken, identity.contact).catch(() => null);
          if (memberId) log(`observed server-minted memberId=${memberId} for ${identity.contact} (§11 R2)`);
        }
        if (memberId) {
          applyState = await fetchApplyState(opts.backendUrl, memberId).catch(() => applyState);
          if (applyState === "applied" && approveScheduledForMemberId !== memberId) {
            approveScheduledForMemberId = memberId;
            log(`application ${memberId} applied — auto-approving in ${autoApproveDelayMs}ms (§11 R7)`);
            scheduleAutoApprove(opts.backendUrl, opts.adminToken, memberId, autoApproveDelayMs, log);
          }
          onActiveRoster = await isOnActiveRoster(opts.backendUrl, memberId).catch(() => onActiveRoster);
        }

        if (onActiveRoster) break; // admitted
        if (Date.now() >= deadline) break; // overall timeout
        if (containerExitedAt !== null && Date.now() - containerExitedAt >= postExitGraceMs) break; // nothing left to advance it

        await Bun.sleep(pollIntervalMs);
      }

      // Computed BEFORE the primitive kills anything, exactly as before.
      admitted = onActiveRoster;
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
    timedOut,
    containerExitCode: run.exitCode,
    containerLaunched: run.containerLaunched,
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
//   3. `timed-out` — but ONLY when the resolved model is KEYLESS. Per
//      committee-opencode-nightly.yml's own documented experience with the free
//      tier, "a call can take minutes and occasionally returns nothing", so a
//      timeout there is far more likely to be provider slowness than a stuck
//      agent. Since D22 rule 1 was amended the default model is FUNDED, and a
//      funded model is fast/reliable enough that a timeout keeps meaning what
//      it always meant (a real, non-retried result). Keyed off the resolved
//      model's own billing property (`resolveModelConfig().keyless`), never off
//      equality with whatever the default happens to be.
//
// `harness-error` is deliberately NOT retryable: the harness is broken the same
// way on the next attempt, so a retry costs another twenty minutes and turns
// one loud diagnosis into two quiet ones.
//
// ONE definition of both the classification and the retry decision (§11.3 E5):
// `classifyOutcome` + `shouldRetry` come from scripts/agent/classify-outcome.ts
// and are shared with the demo's onboarding driver and the layer-4 scorecard.
// The only thing added on top of `shouldRetry` here is the TIER gate on case 3,
// which needs a fact `shouldRetry` deliberately does not have (which model tier
// this run used) and which the caller — this file, the one that resolved the
// model — is the only place that knows.
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
  // Resolved ONCE, from the same single selection signal every other path uses.
  // Throws loudly here (before any attempt) on a misconfigured selector.
  const usingKeylessModel = resolveModelConfig(opts.env ?? process.env).keyless;
  let last: OnboardingEvalResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Fresh CONTACT per attempt — reusing one across retries would re-apply
    // with an already-used contact and confuse the "which member row is this"
    // lookup the harness relies on to observe progress. The caller's display
    // name survives (see retryIdentity).
    const identity = retryIdentity(opts.identity, attempt);
    last = await runOnce({ ...opts, identity });
    if (last.admitted) return last;
    const outcome = classifyOutcome(last);
    // shouldRetry is the shared, pure decision over the classified outcome; the
    // tier gate is the one fact it cannot know (see the doc comment above).
    const worthRetrying = shouldRetry(outcome) && (outcome !== "timed-out" || usingKeylessModel);
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
          : "timed out on the keyless tier";
    log(`onboarding eval attempt ${attempt}/${maxAttempts} ${reason} — retrying in ${delayMs}ms (§11 R8)`);
    await Bun.sleep(delayMs);
  }
  return last!;
}
