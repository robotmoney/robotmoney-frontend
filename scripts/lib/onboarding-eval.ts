// Real-inference onboarding eval harness (docs/architecture.md §11 R8, Stage 5
// of docs/plans/onboarding-ic-workflow.md). Launches ONE vanilla member-agent
// container (docker-compose.demo.yml's `member-agent` service,
// scripts/lib/member-agent/Dockerfile) per admission, injects the canonical
// copy-paste prompt (contract's ONBOARDING_PROMPT) with a generated identity,
// then OBSERVES ONLY: this module never applies, signs, claims, or connects on
// the member's behalf. Everything from "install rmpc" onward is the
// containerized agent's own real inference, working out §11.2 from the prompt
// + the MCP `apply-how-to` tool + the linked skill — exactly what a real
// prospective member's own agent would have to do.
//
// Real inference is the DEFAULT mode here, never an optional extra: a missing
// model configuration is a loud, immediate configuration-error throw
// (resolveModelConfig), not a silent fallback to a keyless/scripted path (see
// docker-compose.demo.yml's member-agent comment for the contrast with the
// deliberately keyless `opencode/big-pickle` tier mcp/src/inference.ts uses
// elsewhere).
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
// ── Local-network substitution for the unprovisioned staging `mcp.` subdomain
// ONBOARDING_PROMPT is injected with its <display name>/<email> placeholders
// filled in (exactly as the prompt's own text says a human would do by hand
// before pasting — docs/plans/onboarding-ic-workflow.md's standing decision:
// "the eval uses the local demo MCP container ... instead" of the
// unprovisioned staging subdomain, robotmoney/robotmoney-core#1170 being the
// out-of-scope skill-side half). Nothing else about the prompt text is
// changed. Because the prompt's doc link is a production URL this ephemeral
// demo stack cannot serve, the container's opencode.json (generated per run,
// mounted read-only, never baked into the image) is pre-wired with network
// access to this run's own `mcp` service — the ONE piece of information a
// real applicant's own agent would already have by the time it starts
// reasoning about the rest of the flow (a human, per the real docs, would
// have already pointed their agent's MCP client at mcp.robotmoney.net before
// the agent starts reasoning). Discovering WHAT to do with that access —
// calling apply-how-to, installing rmpc, generating keys, signing, submitting,
// waiting, claiming — is still 100% the agent's own real inference; the
// config carries no onboarding-specific knowledge at all.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ONBOARDING_PROMPT, path as routePath, ROUTES } from "@robotmoney/contract";

export const DEFAULT_COMPOSE_FILES = ["docker-compose.yml", "docker-compose.demo.yml"];
export const DEFAULT_MCP_URL_INTERNAL = "http://mcp:8788/mcp";
export const DEFAULT_TIMEOUT_MS = 8 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_AUTO_APPROVE_DELAY_MS = 10_000; // §11 R7

export function composeArgs(project: string, files: string[] = DEFAULT_COMPOSE_FILES): string[] {
  return ["compose", "-p", project, ...files.flatMap((f) => ["-f", f])];
}

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

const DEMO_NETWORK_NOTE =
  "\n\n---\n" +
  "Demo harness note (environment info, not part of your task): your MCP " +
  "client is already configured with network access to the Robot Money MCP " +
  "server for this run. This substitutes for the staging `mcp.` subdomain, " +
  "which is not provisioned on this local demo network — everything else " +
  "above is unchanged.";

// The exact text injected into the container — ONBOARDING_PROMPT with its
// identity placeholders filled, plus the harness's local-network note (kept
// clearly delimited and separate, per the module doc comment above).
export function buildAgentPrompt(identity: OnboardingIdentity): string {
  return `${fillPromptIdentity(ONBOARDING_PROMPT, identity)}${DEMO_NETWORK_NOTE}`;
}

// ── Model configuration (real inference is the default, not opt-in) ─────────
export const MODEL_API_KEY_ENV_CANDIDATES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

export interface ModelConfig {
  model: string;
  apiKeyEnv: (typeof MODEL_API_KEY_ENV_CANDIDATES)[number];
  apiKey: string;
}

// THROWS (never falls back to a keyless/scripted path) when OPENCODE_MODEL or
// a recognized provider key is absent — a missing model configuration is a
// configuration error the harness surfaces loudly (docs/architecture.md §11
// R8), never a trigger to quietly downgrade the eval.
export function resolveModelConfig(env: Record<string, string | undefined> = process.env): ModelConfig {
  const model = env.OPENCODE_MODEL?.trim();
  if (!model) {
    throw new Error(
      "OPENCODE_MODEL is not set — the onboarding eval's real-inference default requires a model to be " +
        "configured (docs/architecture.md §11 R8: real inference is the normal case, not an opt-in extra). " +
        "Refusing to fall back to a keyless/scripted path.",
    );
  }
  const apiKeyEnv = MODEL_API_KEY_ENV_CANDIDATES.find((name) => env[name]?.trim());
  if (!apiKeyEnv) {
    throw new Error(
      `no model API key is configured (checked ${MODEL_API_KEY_ENV_CANDIDATES.join(", ")}) — the onboarding ` +
        "eval's real-inference default requires one (docs/architecture.md §11 R8). This is a configuration " +
        "error to fix, not a signal to silently degrade to a keyless model.",
    );
  }
  return { model, apiKeyEnv, apiKey: env[apiKeyEnv]!.trim() };
}

// opencode.json written per-run, mounted read-only into the container (never
// baked into the image). Carries only generic MCP connectivity — no
// onboarding-specific knowledge (see module doc comment).
export function buildAgentOpencodeConfig(model: string, mcpUrl: string): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    autoupdate: false,
    permission: { "*": "deny", bash: "allow", "robotmoney_*": "allow" },
    mcp: {
      robotmoney: { type: "remote", url: mcpUrl, enabled: true },
    },
  };
}

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

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

// ── Orchestration ────────────────────────────────────────────────────────────
export interface RunOnboardingEvalOptions {
  repoRoot: string;
  composeProject: string; // the ALREADY-RUNNING demo stack's compose project name
  composeFiles?: string[];
  backendUrl: string; // host-published backend URL for THIS harness's own polling
  mcpUrlInternal?: string; // what the CONTAINER reaches over the compose network
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
  transcript?: string; // only populated when the eval did NOT admit the member
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
  const mcpUrlInternal = opts.mcpUrlInternal ?? DEFAULT_MCP_URL_INTERNAL;
  const composeFiles = opts.composeFiles ?? DEFAULT_COMPOSE_FILES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const autoApproveDelayMs = opts.autoApproveDelayMs ?? DEFAULT_AUTO_APPROVE_DELAY_MS;
  const log = opts.onEvent ?? (() => {});

  const workDir = mkdtempSync(join(tmpdir(), "onboarding-eval-"));
  const opencodeConfigPath = join(workDir, "opencode.json");
  try {
    writeFileSync(opencodeConfigPath, JSON.stringify(buildAgentOpencodeConfig(modelConfig.model, mcpUrlInternal), null, 2));
    const prompt = buildAgentPrompt(identity);

    log(`launching member-agent container for ${identity.contact} (model=${modelConfig.model})`);
    const containerProc = Bun.spawn(
      [
        "docker",
        ...composeArgs(opts.composeProject, composeFiles),
        "run",
        "--rm",
        "--no-deps",
        "-v",
        `${opencodeConfigPath}:/home/agent/opencode.json:ro`,
        "-e",
        `${modelConfig.apiKeyEnv}=${modelConfig.apiKey}`,
        "member-agent",
        "run",
        "--model",
        modelConfig.model,
        "--format",
        "json",
        "--dangerously-skip-permissions",
        "--title",
        `onboarding-eval-${identity.runId}`,
        "--dir",
        "/home/agent",
        prompt,
      ],
      { cwd: opts.repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    // Actively drain both pipes for the whole run — an un-drained pipe can
    // fill its OS buffer and deadlock the child once its own transcript
    // exceeds a few tens of KB, which a real multi-tool-call session easily
    // does.
    const stdoutPromise = drain(containerProc.stdout as ReadableStream<Uint8Array>);
    const stderrPromise = drain(containerProc.stderr as ReadableStream<Uint8Array>);

    const deadline = Date.now() + timeoutMs;
    // Once the container itself has exited, cap how much longer we keep
    // polling: the R7 auto-approve delay plus margin covers the ONE thing
    // that can still land after the agent's own process ends (the harness's
    // own scheduled activate call); nothing else can advance with no agent
    // left to drive it.
    const postExitGraceMs = autoApproveDelayMs + 20_000;

    let memberId: string | null = null;
    let applyState: ApplyState = null;
    let onActiveRoster = false;
    let approveScheduledForMemberId: string | null = null;
    let containerExitedAt: number | null = null;

    for (;;) {
      if (containerProc.exitCode !== null && containerExitedAt === null) {
        containerExitedAt = Date.now();
        log(`member-agent container exited (code ${containerProc.exitCode})`);
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

    const admitted = onActiveRoster;
    const timedOut = !admitted && Date.now() >= deadline;

    try {
      containerProc.kill();
    } catch {
      /* already exited */
    }
    const [stdout, stderr, containerExitCode] = await Promise.all([stdoutPromise, stderrPromise, containerProc.exited]);

    const steps = deriveSteps({ memberId, applyState, onActiveRoster });
    log(`eval finished: admitted=${admitted} timedOut=${timedOut} steps=${JSON.stringify(steps)}`);

    return {
      identity,
      memberId,
      steps,
      admitted,
      timedOut,
      containerExitCode,
      ...(admitted ? {} : { transcript: `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}` }),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
