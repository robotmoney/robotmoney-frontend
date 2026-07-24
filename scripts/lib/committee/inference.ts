// Keyless committee-member take authorship. This module authors each participating
// member's take with a REAL language-model call — but via OpenCode Zen's free,
// no-credential tier, exactly as robotmoney-core does in
// `.github/workflows/suite-11b-opencode-headless.yml` ("free, no-credential
// opencode zen model … avoids drift to a model that would need an API-key secret
// the repo does not have"). It shells out to
//
//   opencode run "<persona + regime/subject brief>" \
//     --model opencode/big-pickle --format json --dangerously-skip-permissions
//
// parses the NDJSON transcript for the final assistant message text, and returns
// REGIME / ALLOCATION / SUBJECT prose ending in a parseable
// "STANCE: <...> | CONFIDENCE: <0-1>" control line (stripped from the stored body
// by `parseStanceFromBody`). Mirrors the reference authoring path in
// robotmoney-site scripts/committee/generate-session.js.
//
// LOUD-SKIP CONTRACT: the real path depends on the opencode CLI + a reachable
// zero-credential zen model (an external resource). When the binary is
// unavailable or the run produces an empty transcript, this module THROWS — it
// NEVER falls back to a templated body. No API key or secret is used. Because the
// free zen model is slower and more variable than a paid tier, this real path is
// exercised in a NIGHTLY job; the required per-PR e2e keeps the deterministic
// `stanceFor()` + `buildMemo()` (see agent.ts / memo.ts) hermetic default.
import { STANCES } from "@robotmoney/contract";
import type { Stance } from "@robotmoney/contract";
import type { RegimeContext } from "./memo.ts";

export type { RegimeContext };

// Free, no-credential OpenCode Zen model (verified available at opencode 1.16.2).
// Pinned for determinism; overridable via env so the nightly job (or a local
// operator) can retarget a renamed/replacement free zen model without a code
// change. Mirrors robotmoney-core's `opencode/big-pickle` pin. Resolved at call
// time (not module load) so an env override / test toggle takes effect.
export const DEFAULT_INFERENCE_MODEL = "opencode/big-pickle";
const inferenceModel = () => process.env.OPENCODE_MODEL ?? DEFAULT_INFERENCE_MODEL;
// The opencode binary name/path. Resolved at call time so a unit test can point
// it at a nonexistent path to prove the loud-throw contract without a live call.
const opencodeBin = () => process.env.OPENCODE_BIN ?? "opencode";
// Hard ceiling on a single keyless opencode-zen call (default 120s). The free zen
// tier is slow AND can hang indefinitely; without a bound one stalled member call
// would block the whole committee session forever. Resolved at call time (not
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
// stripped. When the control line is absent, degrade to neutral/0.5 and keep the
// body intact. Mirrors the reference parser (generate-session.js
// parseStanceFromBody) so submitted and API takes render identically.
export function parseStanceFromBody(body: string): ParsedTake {
  const trimmed = body.trim();
  const lines = trimmed.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = last.match(/STANCE:\s*(\w+)\s*\|\s*CONFIDENCE:\s*([\d.]+)/i);
  if (m) {
    return {
      stance: m[1].toLowerCase(),
      confidence: Math.max(0, Math.min(1, parseFloat(m[2]))),
      body: lines.slice(0, -1).join("\n").trim(),
    };
  }
  return { stance: "neutral", confidence: 0.5, body: trimmed };
}

// Extract the final assistant message text from an `opencode run --format json`
// NDJSON transcript. opencode 1.16.x emits one JSON object per line; a finalized
// assistant text part is `{"type":"text","part":{"type":"text","text":"…"}}` (the
// CLI only prints a `text` event once the part's `time.end` is set). We
// concatenate every such part in stream order — that is the model's authored
// prose. Non-text events (step_start / step_finish / tool_use / reasoning) and
// unparseable lines are ignored. Returns "" when the transcript carries no
// assistant text (empty/failed run) so the caller can throw loudly.
export function extractAssistantText(transcript: string): string {
  const parts: string[] = [];
  for (const line of transcript.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev?.type === "text") {
      const text = ev?.part?.text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

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
    `You are ${p.name}, an autonomous voice on the Robot Money Investment Committee.`,
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

// Run the keyless opencode CLI on a prompt and return the concatenated final
// assistant text. Throws loudly (no template fallback) when the binary cannot be
// spawned (opencode unavailable) or the run yields no assistant text.
async function runOpencode(prompt: string): Promise<string> {
  const bin = opencodeBin();
  const model = inferenceModel();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [bin, "run", prompt, "--model", model, "--format", "json", "--dangerously-skip-permissions"],
      { stdout: "pipe", stderr: "pipe" },
    );
  } catch (err) {
    throw new Error(
      `opencode inference unavailable: failed to spawn '${bin}' (${err instanceof Error ? err.message : String(err)}). ` +
        `Committee takes require a working keyless opencode CLI; there is NO template fallback in this path.`,
    );
  }
  // Bound the call: a hung free-tier zen run would otherwise block forever (and
  // freeze the whole committee session). We RACE the read work against a timeout
  // that rejects DIRECTLY — so the loud throw fires even if proc.kill() fails to
  // close the stdout/stderr pipes (e.g. a killed opencode leaves a child holding
  // them open). Never a template fallback.
  const ms = timeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { proc.kill(); } catch { /* best-effort */ }
      reject(new Error(
        `opencode inference timed out after ${ms}ms for model '${model}': ` +
          `the keyless zen model did not respond; NO template fallback. ` +
          `Override the bound via OPENCODE_TIMEOUT_MS.`,
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
    throw new Error(
      `opencode inference produced an empty transcript (exit ${exitCode}) for model '${model}': ` +
        `no assistant text in the --format json stream. The keyless zen model is unreachable or returned nothing; ` +
        `NO template fallback. stderr: ${stderr.slice(0, 400)}`,
    );
  }
  return text;
}

export interface AuthoredTake extends ParsedTake {
  model: string;
}

// Author one committee member's take with a REAL, keyless opencode-zen call.
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
