// Swarm-member take authorship via a REAL language-model call. This module
// shells out to
//
//   opencode run "<persona + regime/subject brief>" \
//     --model <resolved> --format json --auto
//
// parses the NDJSON transcript for the final assistant message text, and returns
// REGIME / ALLOCATION / SUBJECT prose ending in a parseable
// "STANCE: <...> | CONFIDENCE: <0-1>" control line (stripped from the stored body
// by `parseStanceFromBody`). Mirrors the reference authoring path in
// robotmoney-site scripts/swarm/generate-session.js.
//
// MODEL + CREDENTIAL: the model comes from AGENT_MODEL resolved against
// ../model-registry.ts (default `opencode/deepseek-v4-flash`); the credential is
// OPENCODE_API_KEY. The member-agent launcher injects both explicitly into the
// member container, and this module passes only its documented allowlist to
// the spawned CLI. No compose-service or host ambient credential fallback
// exists. See ../opencode-key.ts.
//
// MODEL CHOICE IS NOT NEUTRAL HERE. This prompt asks the model to hold an
// investment-swarm persona, and Zen's Claude family carries an OpenCode
// coding-assistant framing that fights it: `claude/haiku-4-5` refused the task
// outright ("I'm OpenCode, a coding assistant… not an investment analysis
// tool") and `claude/sonnet-5` went off-format. deepseek, kimi, and gpt all
// authored well-formed takes. Prefer those; see MODEL_FAMILIES notes.
//
// LOUD-SKIP CONTRACT: swarm authorship depends on the opencode CLI + a
// reachable model (external resources). When either is unavailable, this module
// THROWS — it NEVER falls back to a templated body.
import { STANCES } from "@robotmoney/contract";
import type { Stance } from "@robotmoney/contract";
import { describeTranscriptError, extractAssistantText, transcriptErrors } from "../../agent/transcript.ts";
import {
  classifyInferenceFailure,
  InferenceFailure,
  inferenceFailureAction,
  providerOf,
  renderInferenceDiagnostic,
} from "../../agent/inference-failure.ts";
import { DEFAULT_AGENT_MODEL, resolveAgentModel } from "../model-registry.ts";
import { ZEN_KEY_ENV, zenApiKey } from "../opencode-key.ts";
// Regime inputs passed to each live author. This used to live beside the retired
// deterministic memo template; it belongs with the only remaining authoring
// path so a future fallback cannot accidentally reappear through that module.
export interface RegimeContext {
  composite: number;
  compositePercentile?: number | null;
  regime?: string | null;
  macroRegime?: string | null;
  onchainRegime?: string | null;
  factorRegime?: string | null;
  macroPercentile?: number | null;
  onchainPercentile?: number | null;
  factorPercentile?: number | null;
}

export const DEFAULT_INFERENCE_MODEL = DEFAULT_AGENT_MODEL;
// Resolved at call time (not module load) so an env override / test toggle
// takes effect.
const inferenceModel = () => resolveAgentModel();
// The opencode binary name/path. Resolved at call time so a unit test can point
// it at a nonexistent path to prove the loud-throw contract without a live call.
const opencodeBin = () => process.env.OPENCODE_BIN ?? "opencode";
// Hard ceiling on a single opencode-zen call (default 120s). A model can hang
// indefinitely; without a bound, one stalled member call would block the whole
// swarm session forever. Resolved at call time (not
// module load) so the nightly job / an operator / a unit test can override via
// OPENCODE_TIMEOUT_MS without a code change. On expiry we kill the subprocess and
// throw loudly — still NO template fallback.
const timeoutMs = () => Number(process.env.OPENCODE_TIMEOUT_MS ?? 120000);

// Prompt-facing stance vocabulary (most bullish first), DERIVED from the
// canonical contract tuple (finding 027) — never re-declared locally.
export const STANCE_VALUES: readonly Stance[] = [...STANCES].reverse();
export type { Stance };

export interface Persona {
  memberId: string;
  name: string;
  lens: string;
  // Directional disposition in [-1, 1]; wired from the demo roster's `bias`.
  bias: number;
}

export interface ParsedTake {
  stance: string;
  confidence: number;
  // Body with the trailing STANCE/CONFIDENCE control line removed.
  body: string;
}

// Parse a trailing "STANCE: <...> | CONFIDENCE: <0-1>" line from a model take
// into { stance, confidence } and return the stored body with that control line
// stripped. A missing or malformed control line THROWS — it renders the member
// ABSENT, loudly (session.ts settles per-member failures into a no-show), and
// NEVER degrades to a fabricated neutral/0.5 stance. The silent default this
// function used to carry was a template remnant from the retired hermetic mode
// (#301/#319): a fabricated stance is a fabricated signed vote, which is worse
// than an honest absence. The happy-path parse still mirrors the reference
// parser (generate-session.js parseStanceFromBody) so submitted and API takes
// render identically.
export function parseStanceFromBody(body: string): ParsedTake {
  const trimmed = body.trim();
  const lines = trimmed.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = last.match(/STANCE:\s*(\w+)\s*\|\s*CONFIDENCE:\s*([\d.]+)/i);
  if (!m) {
    throw new Error(
      `model take is missing its trailing "STANCE: <${STANCE_VALUES.join("|")}> | CONFIDENCE: <0-1>" control line — ` +
        `the member is rendered ABSENT, never defaulted to a fabricated neutral/0.5 stance. ` +
        `Last line of the take was: ${JSON.stringify(last.slice(0, 160))}`,
    );
  }
  const stance = m[1].toLowerCase();
  if (!(STANCES as readonly string[]).includes(stance)) {
    throw new Error(
      `model take's control line names stance '${stance}', which is outside {${[...STANCES].join(",")}} — ` +
        `the member is rendered ABSENT, never coerced onto the stance vocabulary.`,
    );
  }
  const confidence = parseFloat(m[2]);
  if (!Number.isFinite(confidence)) {
    throw new Error(
      `model take's control line carries unparseable confidence ${JSON.stringify(m[2])} — ` +
        `the member is rendered ABSENT, never defaulted.`,
    );
  }
  return {
    stance,
    confidence: Math.max(0, Math.min(1, confidence)),
    body: lines.slice(0, -1).join("\n").trim(),
  };
}

// The `opencode run --format json` NDJSON parser now lives in
// scripts/agent/transcript.ts — one definition, shared with the member-agent
// outcome classifier (scripts/agent/classify-outcome.ts), which reads the same
// stream for the agent's FINAL message. Behaviour here is unchanged (the
// join-and-trim of every finalized assistant text part, "" for an empty/failed
// run so the caller can throw loudly), and it is pinned by
// scripts/tests/unit/member-agent-classify.test.ts. Re-exported so this file's
// own call site below and every external importer are untouched.
export { describeTranscriptError, extractAssistantText, transcriptErrors };
// The failure vocabulary the swarm boundary throws with (issue #527), re-exported
// so a consumer of this module never has to reach past it for the kind.
export {
  classifyInferenceFailure,
  InferenceFailure,
  type InferenceFailureKind,
  inferenceFailureAction,
} from "../../agent/inference-failure.ts";

function dispositionLabel(bias: number): string {
  if (bias >= 0.1) return "leans constructive; you look for reasons the position works before you fault it";
  if (bias <= -0.1) return "leans cautious; you price the bear case first and demand the position earn its risk";
  return "runs balanced; you weight the panel spread over the composite label and resist tilting off the mandate";
}

function pct(fraction: number | null | undefined, fallback: number): string {
  const f = typeof fraction === "number" ? fraction : fallback;
  return `${Math.round(Math.max(0, Math.min(1, f)) * 100)}th`;
}

// Build the full single-message prompt for opencode `run`. opencode `run` takes
// one positional prompt (no separate system message), so the persona framing,
// session brief, and formatting task are woven into one string.
export function promptFor(p: Persona, regime: RegimeContext, subjectId: string): string {
  const comp = regime.composite;
  return [
    `You are ${p.name}, an autonomous voice on the Robot Money Investment Swarm.`,
    `You read every session through a ${p.lens} lens — that lens, not the headline composite, sets your conviction.`,
    `Your disposition ${dispositionLabel(p.bias)}.`,
    `Write in your own distinct voice, one claim per bullet, no hedging boilerplate; cite specific numbers, panels, and mechanisms, never vibes.`,
    ``,
    `# Session brief`,
    `Subject under review: ${subjectId}`,
    `Composite ${comp.toFixed(3)} (${pct(regime.compositePercentile, comp)} percentile of trailing 3y) -> bucket ${regime.regime ?? "unlabeled"}.`,
    `  Macro panel:    ${pct(regime.macroPercentile, comp + 0.08)} percentile, bucket ${regime.macroRegime ?? "n/a"}`,
    `  On-chain panel: ${pct(regime.onchainPercentile, comp - 0.2)} percentile, bucket ${regime.onchainRegime ?? "n/a"}`,
    `  Equity factor:  ${pct(regime.factorPercentile, comp + 0.15)} percentile, bucket ${regime.factorRegime ?? "n/a"}`,
    `Vault allocation targets are 95/5/0/0 across Conservative DeFi Yield / Agent Tokens / Protocol Tokens / Real-World Assets; the Agent Tokens sleeve routes through rmUSDC vault receipts.`,
    ``,
    `# Your task`,
    `Write a structured take in exactly three bulleted sections, ~180-220 words total. Each section is a bold header line followed by 3 bullets, one claim per bullet. Reply with ONLY the take (no preamble, no tool calls). Format exactly:`,
    ``,
    `**REGIME**`,
    `- One concrete number from the brief and what it means through your lens`,
    `- The macro vs on-chain (or factor) divergence, if the panels disagree`,
    `- The trailing direction you read`,
    ``,
    `**ALLOCATION**`,
    `- What tilt the regime implies for the 95/5/0/0 targets, and why`,
    `- Which sleeve or constituent moves first and the mechanism`,
    `- The one flip trigger that would change the read`,
    ``,
    `**SUBJECT**`,
    `- Where ${subjectId} is over- or under-exposed vs the regime-appropriate allocation`,
    `- The specific concentration or mechanism risk you underwrite`,
    `- The first move you would make, with a trigger`,
    ``,
    `Stay in your voice. Conclude with one line exactly, and nothing after it:`,
    `STANCE: <${STANCE_VALUES.join("|")}> | CONFIDENCE: <0-1>`,
  ].join("\n");
}

// The EXACT environment a spawned `opencode` subprocess receives — an
// allowlist, never an inherit. The member client itself holds its scoped bearer
// token and may hold an owner-supplied keystore passphrase; neither belongs in
// the model subprocess. The external-actor rail's doctrine is one explicitly
// injected model credential and nothing else.
//
//   - PATH/HOME/TERM: what any CLI needs to run at all (binary resolution,
//     its default XDG dirs, terminal handling);
//   - OPENCODE_API_KEY (ZEN_KEY_ENV): the single model credential — the ONLY
//     secret that may reach the model subprocess.
//
// Pure and exported so the unit suite can pin the allowlist hermetically.
export function opencodeSpawnEnv(
  hostEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TERM"]) {
    const v = hostEnv[k];
    if (v !== undefined) out[k] = v;
  }
  const key = hostEnv[ZEN_KEY_ENV];
  if (key) out[ZEN_KEY_ENV] = key;
  return out;
}

// What we actually know about the model credential. This used to print
// "funded" whenever OPENCODE_API_KEY was merely SET — a claim the key cannot
// support and that was flatly false on 2026-08-05, when every swarm member died
// against a Zen workspace whose balance had run out while our own error text
// asserted the account was funded. A present key means a present key.
const keyLabel = () => (zenApiKey() ? `${ZEN_KEY_ENV} set` : `no ${ZEN_KEY_ENV} set`);

// HONEST cause attribution (issue #361 Phase 0, extended by issue #527). PURE
// and exported so the unit suite can pin every branch hermetically, with no
// spawn.
//
// The precedence below is strictly most-specific-first, and each rung is
// EVIDENCE rather than inference:
//
//  1. A structured `type:"error"` event in the JSON stream — the provider (or
//     the CLI) NAMED the failure, with a typed discriminator, an HTTP status
//     and its own retryability verdict. Never guess when this is present. This
//     rung is new: the previous version read only stderr, so the six e2e
//     failures of 2026-08-05 were all reported as a maybe-outage ("unreachable,
//     rate-limited, unfunded, or returned nothing") while stdout carried
//     `CreditsError: Insufficient balance … HTTP 401, NOT retryable` on every
//     one of them. Three autofix reruns were spent on a fault no retry could
//     clear, and nobody topped the workspace up because nothing said to.
//  2. Non-empty stderr — during the 2026-07-30 incident the captured stderr
//     showed the opencode CLI dying LOCALLY on its own SQLite migration before
//     any model call, so this outranks any provider-side speculation.
//  3. Neither — the only case in which the cause is genuinely unknown, and the
//     only one allowed to say so.
//
// The message text is rendered from the classified KIND, so the diagnosis and
// the machine-readable `InferenceFailure.kind` can never drift apart.
export function emptyTranscriptCause(stdout: string, stderr: string): string {
  const errors = transcriptErrors(stdout, [zenApiKey() ?? ""]);
  return renderInferenceDiagnostic(classifyInferenceFailure(errors, stderr), errors, stderr);
}

// The loud throw for a run that produced no assistant text, carrying the kind,
// the provider and the resolved model id alongside the rendered diagnosis.
function emptyTranscriptFailure(stdout: string, stderr: string, model: string, exitCode: number): InferenceFailure {
  const errors = transcriptErrors(stdout, [zenApiKey() ?? ""]);
  const classification = classifyInferenceFailure(errors, stderr);
  return new InferenceFailure(
    `opencode inference produced an empty transcript (exit ${exitCode}) for model '${model}' ` +
      `(${keyLabel()}): no assistant text in the --format json stream; NO template fallback. ` +
      renderInferenceDiagnostic(classification, errors, stderr),
    {
      kind: classification.kind,
      provider: providerOf(model),
      model,
      providerType: classification.error?.providerType ?? "",
      statusCode: classification.error?.statusCode ?? null,
      retryable: classification.retryable,
    },
  );
}

// Run the opencode CLI on a prompt and return the concatenated final
// assistant text. Throws loudly (no template fallback) when the binary cannot be
// spawned (opencode unavailable) or the run yields no assistant text.
async function runOpencode(prompt: string): Promise<string> {
  const bin = opencodeBin();
  const model = inferenceModel();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [bin, "run", prompt, "--model", model, "--format", "json", "--auto"],
      // SCRUBBED environment (issue #361 Phase 0): the subprocess gets the
      // opencodeSpawnEnv allowlist (PATH/HOME/TERM + the single model
      // credential) — never a `process.env` spread, which handed every
      // member-model subprocess the stack's whole admin credential set
      // (ADMIN_TOKEN, ANALYTICS_TOKEN, …). OpenCode state stays in this
      // member container's isolated, persistent HOME.
      { stdout: "pipe", stderr: "pipe", env: opencodeSpawnEnv(process.env) },
    );
  } catch (err) {
    throw new Error(
      `opencode inference unavailable: failed to spawn '${bin}' (${err instanceof Error ? err.message : String(err)}). ` +
        `Swarm takes require a working opencode CLI; there is NO template fallback in this path.`,
    );
  }
  // Bound the call: a hung free-tier zen run would otherwise block forever (and
  // freeze the whole swarm session). We RACE the read work against a timeout
  // that rejects DIRECTLY — so the loud throw fires even if proc.kill() fails to
  // close the stdout/stderr pipes (e.g. a killed opencode leaves a child holding
  // them open). Never a template fallback.
  const ms = timeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { proc.kill(); } catch { /* best-effort */ }
      reject(new InferenceFailure(
        `opencode inference timed out after ${ms}ms for model '${model}' ` +
          `(${keyLabel()}): the zen model did not respond; NO template fallback. ` +
          `cause=timed-out — ${inferenceFailureAction("timed-out")}`,
        { kind: "timed-out", provider: providerOf(model), model },
      ));
    }, ms);
  });
  let stdout: string, stderr: string, exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const text = extractAssistantText(stdout);
  if (!text) {
    throw emptyTranscriptFailure(stdout, stderr, model, exitCode);
  }
  return text;
}

export interface AuthoredTake extends ParsedTake {
  model: string;
}

// Author one swarm member's take with a REAL opencode-zen call.
// Throws (no fallback) when opencode is unavailable or the transcript is empty.
// Returns the stored body (control line stripped) plus the parsed
// stance/confidence.
export async function authorTake(
  p: Persona,
  regime: RegimeContext,
  subjectId: string,
): Promise<AuthoredTake> {
  const text = await runOpencode(promptFor(p, regime, subjectId));
  const parsed = parseStanceFromBody(text);
  return { ...parsed, model: inferenceModel() };
}
